import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const port = Number(process.argv[2] || 9462);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-r2-flow-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
const outDir = path.join(root, 'release');
const fakeBin = path.join(root, 'bin');
const fakeR2Root = path.join(root, 'r2');
const bucket = 'ahtlauncher';
const uploadLog = path.join(root, 'upload-log.jsonl');
const packZip = path.join(root, 'A Hard Time Dregora-2.8.2.zip');
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? ['--developer', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', '--developer', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function contentTypeFor(file) {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.zip')) return 'application/zip';
  if (file.endsWith('.jar')) return 'application/java-archive';
  if (file.endsWith('.cfg') || file.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function waitForTarget() {
  let lastError;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Electron debugger target: ${lastError?.message || 'no target'}`);
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
    } else {
      resolve(message.result || {});
    }
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve({
        call(method, params = {}) {
          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((callResolve, callReject) => {
            pending.set(id, { resolve: callResolve, reject: callReject });
            setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              callReject(new Error(`CDP call timed out: ${method}`));
            }, 30000);
          });
        },
        close() {
          socket.close();
        }
      });
    }, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Failed to connect to ${wsUrl}`)), { once: true });
  });
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(client, expression, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await fsp.mkdir(fakeBin, { recursive: true });
await fsp.mkdir(path.join(fakeR2Root, bucket), { recursive: true });
await fsp.mkdir(path.join(instanceDir, '.aht-launcher'), { recursive: true });

const fakeWrangler = path.join(fakeBin, 'fake-wrangler.mjs');
await fsp.writeFile(fakeWrangler, `
import fs from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('wrangler 4.0.0-smoke');
  process.exit(0);
}
if (args.includes('whoami')) {
  console.log('smoke@example.com');
  process.exit(0);
}
if (args.includes('login')) {
  console.log('Successfully logged in');
  process.exit(0);
}
const createIndex = args.indexOf('create');
if (args.includes('bucket') && createIndex !== -1) {
  console.log('Created bucket ' + args[createIndex + 1]);
  process.exit(0);
}
if (args.includes('deploy')) {
  console.log('Deployed ' + process.env.FAKE_WORKER_URL);
  process.exit(0);
}
if (args.includes('secret') && args.includes('put')) {
  console.log('Created secret ' + args[args.indexOf('put') + 1]);
  process.exit(0);
}
const putIndex = args.indexOf('put');
if (putIndex === -1) throw new Error('Only r2 object put is supported by this smoke fake');
const target = args[putIndex + 1];
const fileArg = args.find((arg) => arg.startsWith('--file='));
if (!target || !fileArg) throw new Error('Missing target or --file');
const slash = target.indexOf('/');
const bucket = target.slice(0, slash);
const key = target.slice(slash + 1);
const source = fileArg.slice('--file='.length);
const dest = path.join(process.env.FAKE_R2_ROOT, bucket, ...key.split('/'));
await fs.mkdir(path.dirname(dest), { recursive: true });
await fs.copyFile(source, dest);
await fs.appendFile(process.env.FAKE_UPLOAD_LOG, JSON.stringify({ bucket, key }) + '\\n');
console.log('uploaded ' + key);
`, 'utf8');
if (process.platform === 'win32') {
  await fsp.writeFile(path.join(fakeBin, 'npx.cmd'), `@echo off\r\nnode "%~dp0fake-wrangler.mjs" %*\r\n`, 'utf8');
} else {
  const npxPath = path.join(fakeBin, 'npx');
  await fsp.writeFile(npxPath, `#!/usr/bin/env sh\nnode "$(dirname "$0")/fake-wrangler.mjs" "$@"\n`, 'utf8');
  await fsp.chmod(npxPath, 0o755);
}

const manifest = {
  name: 'A Hard Time Dregora',
  version: '2.8.2',
  overrides: 'overrides',
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  },
  files: []
};
const zip = new AdmZip();
zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
zip.addFile('overrides/config/aht-test.cfg', Buffer.from('updated=true\n'));
zip.writeZip(packZip);

await writeJson(path.join(instanceDir, '.aht-launcher', 'installed.json'), {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time Dregora',
  version: '2.8.1',
  minecraft: manifest.minecraft
});
await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: workerEndpoint, playerLabel: 'SmokeUser' },
  developer: { adminBaseUrl: workerEndpoint, defaultOutDir: outDir, defaultCacheModsDir: '', r2Bucket: bucket },
  minecraftLauncher: { enabled: false, rootDir: mcRoot, profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 4096 },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), { installId: 'smoke-install', minecraftUsername: 'SmokeUser' });

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!key) {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  const file = path.join(fakeR2Root, bucket, ...key.split('/'));
  try {
    const stat = await fsp.stat(file);
    response.statusCode = 200;
    response.setHeader('Content-Type', contentTypeFor(file));
    response.setHeader('Content-Length', String(stat.size));
    if (request.method === 'HEAD') {
      response.end();
    } else {
      fs.createReadStream(file).pipe(response);
    }
  } catch {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ error: 'not found', key }));
  }
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_ALLOW_DEVELOPER: '1',
    AHT_LAUNCHER_SOURCE_ROOT: process.cwd(),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    FAKE_R2_ROOT: fakeR2Root,
    FAKE_UPLOAD_LOG: uploadLog,
    FAKE_WORKER_URL: workerEndpoint,
    AHT_DEVELOPER_USERNAME: 'admin',
    AHT_DEVELOPER_PASSWORD: 'test-dev-password',

    ELECTRON_ENABLE_LOGGING: '0'
  },
  stdio: 'ignore',
  windowsHide: true
});

let client;
try {
  const target = await waitForTarget();
  client = await connect(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'developer DOM');
  await evaluate(client, `window.aht.devLogin({ username: 'admin', password: 'test-dev-password' })`);
  const login = await evaluate(client, `window.aht.devCloudLogin()`);
  if (!login.ok) {
    throw new Error(`Cloud login failed: ${JSON.stringify(login)}`);
  }
  if (!login.alreadyAuthenticated) {
    throw new Error(`Expected authenticated Wrangler to skip browser login: ${JSON.stringify(login)}`);
  }
  const buckets = await evaluate(client, `window.aht.devCloudSetupBuckets({ releaseBucket: ${JSON.stringify(bucket)}, dataBucket: ${JSON.stringify(`${bucket}-data`)} })`);
  if (!buckets.ok) {
    throw new Error(`Bucket setup failed: ${JSON.stringify(buckets)}`);
  }
  const secrets = await evaluate(client, `window.aht.devCloudSetupSecrets({
    curseforgeApiKey: 'fake-cf-key',
    launcherProofSecret: 'proof-secret',
    adminUsername: 'admin',
    adminPassword: 'test-dev-password',
    releaseBucket: ${JSON.stringify(bucket)},
    dataBucket: ${JSON.stringify(`${bucket}-data`)}
  })`);
  if (!secrets.ok) {
    throw new Error(`Secret setup failed: ${JSON.stringify(secrets)}`);
  }
  const deploy = await evaluate(client, `window.aht.devCloudDeployWorker({ releaseBucket: ${JSON.stringify(bucket)}, dataBucket: ${JSON.stringify(`${bucket}-data`)} })`);
  if (deploy.latestUrl !== `${workerEndpoint}/latest.json`) {
    throw new Error(`Worker deploy did not return latest URL: ${JSON.stringify(deploy)}`);
  }
  const stagedWranglerToml = await fsp.readFile(path.join(userData, 'wrangler', 'wrangler.toml'), 'utf8');
  if (!stagedWranglerToml.includes(`bucket_name = "${bucket}"`) || !stagedWranglerToml.includes(`bucket_name = "${bucket}-data"`)) {
    throw new Error(`Staged wrangler.toml did not use selected buckets:\n${stagedWranglerToml}`);
  }
  const cloud = await evaluate(client, `window.aht.devCloudPreflight({
    publicLatestUrl: ${JSON.stringify(`${workerEndpoint}/latest.json`)},
    bucket: ${JSON.stringify(bucket)}
  })`);
  if (!cloud.ok) {
    throw new Error(`Cloud preflight failed: ${JSON.stringify(cloud)}`);
  }
  const built = await evaluate(client, `window.aht.devBuildRelease({
    packZip: ${JSON.stringify(packZip)},
    outDir: ${JSON.stringify(outDir)},
    baseUrl: ${JSON.stringify(`${workerEndpoint}/`)},
    channel: 'stable',
    cacheModsDir: '',
    allowLegacyCurseForge: true
  })`);
  if (built.latest.version !== '2.8.2') {
    throw new Error(`Release build used wrong version: ${JSON.stringify(built.latest)}`);
  }
  const latestPath = path.join(outDir, 'latest.json');
  const originalLatest = JSON.parse(await fsp.readFile(latestPath, 'utf8'));
  await writeJson(latestPath, {
    ...originalLatest,
    zip: {
      ...originalLatest.zip,
      url: 'https://example.test/aht/packs/stale.zip'
    },
    cacheManifest: {
      ...originalLatest.cacheManifest,
      url: 'https://example.test/aht/cache/mod-cache.json'
    }
  });
  const staleValidation = await evaluate(client, `window.aht.devValidateRelease({
    outDir: ${JSON.stringify(outDir)},
    publicLatestUrl: ${JSON.stringify(`${workerEndpoint}/latest.json`)},
    allowLegacyCurseForge: true
  })`);
  const staleErrors = (staleValidation.errors || []).map((error) => error.label);
  if (staleValidation.ok || !staleErrors.includes('pack ZIP URL does not match Player Feed URL')) {
    throw new Error(`Stale release URL was not blocked before upload: ${JSON.stringify(staleValidation)}`);
  }
  await writeJson(latestPath, originalLatest);
  const validation = await evaluate(client, `window.aht.devValidateRelease({
    outDir: ${JSON.stringify(outDir)},
    publicLatestUrl: ${JSON.stringify(`${workerEndpoint}/latest.json`)},
    allowLegacyCurseForge: true
  })`);
  if (!validation.ok || validation.latest.version !== '2.8.2') {
    throw new Error(`Release validation failed: ${JSON.stringify(validation)}`);
  }
  const upload = await evaluate(client, `window.aht.devSyncR2({
    outDir: ${JSON.stringify(outDir)},
    bucket: ${JSON.stringify(bucket)},
    publicLatestUrl: ${JSON.stringify(`${workerEndpoint}/latest.json`)},
    allowLegacyCurseForge: true
  })`);
  const uploaded = upload.uploaded.map((item) => item.path);
  if (uploaded.at(-1) !== 'latest.json') {
    throw new Error(`latest.json was not uploaded last: ${JSON.stringify(uploaded)}`);
  }
  if (upload.verification?.latest?.version !== '2.8.2') {
    throw new Error(`Remote verification failed: ${JSON.stringify(upload.verification)}`);
  }
  const statusBeforeUpdate = await evaluate(client, `window.aht.getStatus()`);
  const updateVisible = statusBeforeUpdate.updateRequired
    || (statusBeforeUpdate.developerClientBypass && statusBeforeUpdate.latest?.version !== statusBeforeUpdate.installed?.version);
  if (!updateVisible || statusBeforeUpdate.latest?.version !== '2.8.2') {
    throw new Error(`Player launcher did not detect update: ${JSON.stringify(statusBeforeUpdate)}`);
  }
  const updateResult = await evaluate(client, `window.aht.startUpdate(false)`);
  if (updateResult.installed?.version !== '2.8.2') {
    throw new Error(`Player update failed: ${JSON.stringify(updateResult)}`);
  }
  const installedFile = path.join(instanceDir, 'config', 'aht-test.cfg');
  if (!fs.existsSync(installedFile)) {
    throw new Error(`Updated override file missing: ${installedFile}`);
  }
  const uploadOrder = fs.readFileSync(uploadLog, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line).key);
  console.log(JSON.stringify({
    ok: true,
    root,
    setup: {
      login: login.ok,
      buckets: buckets.ok,
      secrets: secrets.ok,
      deployedLatestUrl: deploy.latestUrl,
      wranglerTomlBuckets: [bucket, `${bucket}-data`]
    },
    cloud: {
      ok: cloud.ok,
      checks: cloud.checks.map((check) => check.label)
    },
    release: validation.latest,
    uploadedLast: uploaded.at(-1),
    uploadOrderLast: uploadOrder.at(-1),
    verification: upload.verification,
    statusBeforeUpdate: {
      updateRequired: statusBeforeUpdate.updateRequired,
      developerClientBypass: statusBeforeUpdate.developerClientBypass,
      updateVisible,
      latest: statusBeforeUpdate.latest?.version,
      installed: statusBeforeUpdate.installed?.version
    },
    installed: updateResult.installed?.version,
    instanceDir
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
