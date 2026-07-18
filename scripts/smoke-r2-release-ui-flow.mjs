import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const port = Number(process.argv[2] || 9480);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-r2-ui-flow-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
const outDir = path.join(root, 'release');
const fakeBin = path.join(root, 'bin');
const fakeR2Root = path.join(root, 'r2');
const defaultsDir = path.join(root, 'defaults');
const bucket = 'ahtlauncher';
const uploadLog = path.join(root, 'upload-log.jsonl');
const packZip = path.join(root, 'A Hard Time-2.8.3-client.zip');
const ptbClientDir = path.join(root, 'ptb-client-source');
const ptbInstanceDir = path.join(root, 'ptb-instance');
const githubCalls = [];
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
  for (let attempt = 0; attempt < 180; attempt += 1) {
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
            }, 45000);
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

async function waitFor(client, expression, label, attempts = 180) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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

const minecraft = {
  version: '1.12.2',
  modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
};
const clientMetadata = {
  schemaVersion: 1,
  format: 'aht-full-client-zip',
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '2.8.3',
  minecraft,
  includedRoots: ['config', 'mods', 'resourcepacks', 'scripts'],
  missingRoots: [],
  settingsFiles: [],
  fileCount: 3
};
const zip = new AdmZip();
zip.addFile('aht-client-pack.json', Buffer.from(JSON.stringify(clientMetadata, null, 2)));
zip.addFile('config/aht-ui-test.cfg', Buffer.from(`ui=${crypto.randomUUID()}\n`));
zip.addFile('resourcepacks/aht-ui-test.zip', Buffer.from('fake-resourcepack\n'));
zip.addFile('scripts/aht-ui.zs', Buffer.from('print("aht ui smoke");\n'));
zip.writeZip(packZip);

await fsp.mkdir(path.join(ptbClientDir, 'config'), { recursive: true });
await fsp.mkdir(path.join(ptbClientDir, 'mods'), { recursive: true });
await fsp.writeFile(path.join(ptbClientDir, 'config', 'aht-ptb-ui-test.cfg'), `ptb=${crypto.randomUUID()}\n`, 'utf8');
await fsp.writeFile(path.join(ptbClientDir, 'mods', 'aht-ptb-ui-test.jar'), 'fake ptb jar\n', 'utf8');

await writeJson(path.join(instanceDir, '.aht-launcher', 'installed.json'), {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '2.8.2',
  minecraft
});
await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  packs: {
    ptb: {
      packId: 'a-hard-time-ptb',
      name: 'A Hard Time PTB',
      latestUrl: `${workerEndpoint}/ptb/latest.json`,
      instanceDir: ptbInstanceDir
    }
  },
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: workerEndpoint, playerLabel: 'SmokeUser' },
  developer: {
    adminBaseUrl: workerEndpoint,
    defaultOutDir: outDir,
    defaultCacheModsDir: '',
    clientModpackDir: ptbClientDir,
    ptbClientModpackDir: ptbClientDir,
    r2Bucket: bucket
  },
  minecraftLauncher: { enabled: false, rootDir: mcRoot, profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 4096 },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), { installId: 'smoke-install', minecraftUsername: 'SmokeUser' });

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname.startsWith('/github-api/') || url.pathname.startsWith('/github-uploads/')) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    githubCalls.push({ method: request.method, path: url.pathname, search: url.search, body: body.toString('utf8') });
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.method === 'GET' && url.pathname.includes('/releases/tags/')) {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: 'Not Found' }));
      return;
    }
    if (request.method === 'POST' && url.pathname.endsWith('/releases')) {
      response.statusCode = 201;
      response.end(JSON.stringify({ id: 303, assets: [], html_url: 'https://github.test/releases/303' }));
      return;
    }
    if (request.method === 'POST' && url.pathname.includes('/releases/303/assets')) {
      response.statusCode = 201;
      response.end(JSON.stringify({ id: 400 + githubCalls.length, name: url.searchParams.get('name') }));
      return;
    }
    if (request.method === 'PATCH' && url.pathname.endsWith('/releases/303')) {
      response.statusCode = 200;
      response.end(JSON.stringify({ id: 303, html_url: 'https://github.test/releases/303' }));
      return;
    }
    response.statusCode = 500;
    response.end(JSON.stringify({ message: `Unexpected GitHub smoke request ${request.method} ${url.pathname}` }));
    return;
  }
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
    AHT_PLAYER_DEFAULTS_DIR: defaultsDir,
    AHT_DEVELOPER_USERNAME: 'admin',
    AHT_DEVELOPER_PASSWORD: 'test-dev-password',
    AHT_TEST_HOOKS: '1',
    AHT_TEST_GITHUB_API_BASE: `${workerEndpoint}/github-api`,
    AHT_TEST_GITHUB_UPLOADS_BASE: `${workerEndpoint}/github-uploads`,

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
  await waitFor(client, "document.readyState === 'complete' && document.querySelector('#developerLoginForm')", 'developer login DOM');
  await evaluate(client, `
    (() => {
      document.querySelector('#adminPasswordInput').value = 'test-dev-password';
      document.querySelector('#developerLoginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()
  `);
  await waitFor(client, "document.body.classList.contains('dev-locked') === false && !document.querySelector('#developerConsole').hidden", 'developer unlock');
  await waitFor(client, "document.querySelector('#setupCloudButton').getAttribute('aria-disabled') === 'true'", 'setup cloud locked without CurseForge key');
  await evaluate(client, `
    (() => {
      document.querySelector('#packZipInput').value = ${JSON.stringify(packZip)};
      document.querySelector('#playerFeedUrlInput').value = '';
      document.querySelector('#curseforgeApiKeyInput').value = 'fake-cf-key';
      document.querySelector('#launcherProofSecretInput').value = 'proof-secret';
      document.querySelector('#cacheModsInput').value = '';
      document.querySelector('#bucketInput').value = ${JSON.stringify(bucket)};
      document.querySelector('#githubTokenInput').value = 'test-token';
      for (const selector of ['#packZipInput', '#playerFeedUrlInput', '#curseforgeApiKeyInput', '#launcherProofSecretInput', '#cacheModsInput', '#bucketInput', '#githubTokenInput']) {
        document.querySelector(selector).dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()
  `);
  await waitFor(client, "document.querySelector('#setupCloudButton').getAttribute('aria-disabled') !== 'true'", 'setup cloud enabled with CurseForge key and proof secret');
  await waitFor(client, "document.querySelector('#publishReleaseButton').getAttribute('aria-disabled') !== 'true'", 'publish enabled');
  await evaluate(client, "document.querySelector('#publishReleaseButton').click()");
  await waitFor(client, `(() => {
    const state = document.querySelector('#releaseCheckState')?.textContent || '';
    return ['Upload complete', 'Upload failed', 'Publish failed', 'Upload blocked', 'Release blocked', 'Cache-only blocked'].includes(state);
  })()`, 'release publish terminal state', 360);
  const uiProof = await evaluate(client, `
    ({
      state: document.querySelector('#releaseCheckState').textContent,
      title: document.querySelector('#releaseCheckTitle').textContent,
      detail: document.querySelector('#releaseCheckDetail').textContent,
      log: document.querySelector('#devLog').textContent
    })
  `);
  if (uiProof.state !== 'Upload complete') {
    throw new Error(`Release UI publish did not complete: ${JSON.stringify(uiProof)}`);
  }
  const statusBeforeUpdate = await evaluate(client, "window.aht.getStatus()");
  const updateVisible = statusBeforeUpdate.updateRequired
    || (statusBeforeUpdate.developerClientBypass && statusBeforeUpdate.latest?.version !== statusBeforeUpdate.installed?.version);
  if (!updateVisible || statusBeforeUpdate.latest?.version !== '2.8.3') {
    throw new Error(`Player launcher did not detect UI-published update: ${JSON.stringify(statusBeforeUpdate)}`);
  }
  const updateResult = await evaluate(client, "window.aht.startUpdate(false)");
  if (updateResult.installed?.version !== '2.8.3') {
    throw new Error(`Player update failed after UI publish: ${JSON.stringify(updateResult)}`);
  }
  for (const requiredPath of [
    path.join(instanceDir, 'mods', 'aht-version-lock-1.0.0.jar'),
    path.join(instanceDir, 'config', 'aht-ui-test.cfg'),
    path.join(instanceDir, 'resourcepacks', 'aht-ui-test.zip'),
    path.join(instanceDir, 'scripts', 'aht-ui.zs')
  ]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Exact client ZIP install misplaced or missed ${requiredPath}`);
    }
  }
  const stableUploadOrder = fs.readFileSync(uploadLog, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line).key);
  if (stableUploadOrder.at(-1) !== 'latest.json') {
    throw new Error(`Stable latest.json was not uploaded last: ${JSON.stringify(stableUploadOrder)}`);
  }
  const stableRemoteLatestPath = path.join(fakeR2Root, bucket, 'latest.json');
  const stableRemoteLatestBeforePtb = await fsp.readFile(stableRemoteLatestPath);

  await evaluate(client, `(() => {
    document.querySelector('[data-dev-target="ptbModpackTools"]').click();
    document.querySelector('#ptbClientModpackDirInput').value = ${JSON.stringify(ptbClientDir)};
    document.querySelector('#ptbClientZipVersionInput').value = '2.9.0-ptb.10';
    document.querySelector('#ptbClientModpackDirInput').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ptbClientZipVersionInput').dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(client, "document.querySelector('#ptbModpackTools').hidden === false && document.querySelector('#buildPtbClientZipButton').getAttribute('aria-disabled') !== 'true'", 'PTB create and upload enabled');
  await evaluate(client, "document.querySelector('#buildPtbClientZipButton').click()");
  await waitFor(client, `(() => {
    const state = document.querySelector('#ptbReleaseCheckState')?.textContent || '';
    return ['PTB published', 'GitHub mirror failed', 'Publish failed', 'Upload blocked', 'Release blocked', 'Cache-only blocked'].includes(state);
  })()`, 'PTB publish terminal state', 360);
  const ptbUiProof = await evaluate(client, `({
    state: document.querySelector('#ptbReleaseCheckState').textContent,
    title: document.querySelector('#ptbReleaseCheckTitle').textContent,
    detail: document.querySelector('#ptbReleaseCheckDetail').textContent,
    stableZip: document.querySelector('#packZipInput').value,
    ptbZip: document.querySelector('#ptbPackZipInput').value,
    ptbZipInputType: document.querySelector('#ptbPackZipInput').type,
    actionButtonIds: [...document.querySelectorAll('#ptbModpackTools .dev-actions button')].map((button) => button.id),
    sourceValue: document.querySelector('#ptbClientModpackDirInput').value,
    versionValue: document.querySelector('#ptbClientZipVersionInput').value,
    extraFeedPresent: Boolean(document.querySelector('#ptbPlayerFeedUrlInput'))
  })`);
  if (
    ptbUiProof.state !== 'PTB published'
    || ptbUiProof.stableZip !== packZip
    || !ptbUiProof.ptbZip
    || ptbUiProof.ptbZipInputType !== 'hidden'
    || JSON.stringify(ptbUiProof.actionButtonIds) !== JSON.stringify(['buildPtbClientZipButton'])
    || path.resolve(ptbUiProof.sourceValue) !== path.resolve(ptbClientDir)
    || ptbUiProof.versionValue !== '2.9.0-ptb.10'
    || ptbUiProof.extraFeedPresent
  ) {
    throw new Error(`PTB UI publication did not complete independently: ${JSON.stringify(ptbUiProof)}`);
  }
  const generatedPtbZip = new AdmZip(ptbUiProof.ptbZip);
  const generatedPtbMetadata = JSON.parse(generatedPtbZip.getEntry('aht-client-pack.json').getData().toString('utf8'));
  if (generatedPtbMetadata.version !== '2.9.0-ptb.10' || !generatedPtbZip.getEntry('mods/aht-ptb-ui-test.jar')) {
    throw new Error(`PTB one-click flow used the wrong version or source folder: ${JSON.stringify(generatedPtbMetadata)}`);
  }
  const stableRemoteLatestAfterPtb = await fsp.readFile(stableRemoteLatestPath);
  if (!stableRemoteLatestBeforePtb.equals(stableRemoteLatestAfterPtb)) {
    throw new Error('PTB UI publication changed remote stable latest.json.');
  }
  const ptbRemoteLatest = JSON.parse(await fsp.readFile(path.join(fakeR2Root, bucket, 'ptb', 'latest.json'), 'utf8'));
  if (ptbRemoteLatest.packId !== 'a-hard-time-ptb' || ptbRemoteLatest.channel !== 'ptb' || ptbRemoteLatest.version !== '2.9.0-ptb.10') {
    throw new Error(`PTB UI publication wrote an invalid remote feed: ${JSON.stringify(ptbRemoteLatest)}`);
  }
  const ptbStatus = await evaluate(client, "window.aht.getStatus('ptb')");
  if (ptbStatus.latest?.version !== '2.9.0-ptb.10' || ptbStatus.config?.latestUrl !== `${workerEndpoint}/ptb/latest.json` || path.resolve(ptbStatus.config?.instanceDir || '') !== path.resolve(ptbInstanceDir)) {
    throw new Error(`Player PTB status did not read the isolated published feed: ${JSON.stringify(ptbStatus)}`);
  }
  const uploadOrder = fs.readFileSync(uploadLog, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line).key);
  if (uploadOrder.at(-1) !== 'ptb/latest.json') {
    throw new Error(`PTB latest.json was not uploaded last: ${JSON.stringify(uploadOrder)}`);
  }
  const githubReleaseBodies = githubCalls
    .filter((call) => call.method === 'POST' && call.path.endsWith('/releases'))
    .map((call) => JSON.parse(call.body || '{}'));
  const githubTags = githubReleaseBodies.map((body) => body.tag_name);
  if (!githubTags.includes('modpack-stable-v2.8.3') || !githubTags.includes('modpack-ptb-v2.9.0-ptb.10')) {
    throw new Error(`UI publication did not create separate stable/PTB GitHub releases: ${JSON.stringify(githubReleaseBodies)}`);
  }
  const githubAssetNames = githubCalls
    .filter((call) => call.method === 'POST' && call.path.includes('/assets'))
    .map((call) => new URLSearchParams(call.search).get('name'));
  if (!githubAssetNames.some((name) => name?.startsWith('a-hard-time-stable-')) || !githubAssetNames.some((name) => name?.startsWith('a-hard-time-ptb-'))) {
    throw new Error(`UI publication did not upload separate stable/PTB GitHub assets: ${JSON.stringify(githubAssetNames)}`);
  }
  const defaults = JSON.parse(fs.readFileSync(path.join(defaultsDir, 'app.defaults.json'), 'utf8'));
  if (defaults.latestUrl !== `${workerEndpoint}/latest.json`) {
    throw new Error(`player defaults did not capture Worker feed: ${JSON.stringify(defaults)}`);
  }
  if (defaults.instanceDir || defaults.minecraftLauncher?.rootDir) {
    throw new Error(`player defaults should stay platform-neutral: ${JSON.stringify(defaults)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    root,
    uiProof,
    ptbUiProof,
    uploadOrderLast: uploadOrder.at(-1),
    githubTags,
    githubAssetNames,
    stableRemoteManifestUnchangedAfterPtb: stableRemoteLatestBeforePtb.equals(stableRemoteLatestAfterPtb),
    playerDefaults: {
      latestUrl: defaults.latestUrl,
      platformNeutral: !defaults.instanceDir && !defaults.minecraftLauncher?.rootDir
    },
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
