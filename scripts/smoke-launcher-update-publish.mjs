import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10460);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-launcher-publish-'));
const userData = path.join(root, 'userData');
const fakeBin = path.join(root, 'bin');
const fakeR2Root = path.join(root, 'r2');
const uploadLog = path.join(root, 'upload-log.jsonl');
const bucket = 'ahtlauncher';
const installer = path.join(root, 'AHT-Launcher-Windows-10-11-9.9.10.exe');
const macosArmZip = path.join(root, 'AHT-Launcher-macOS-arm64-9.9.10.zip');
const macosX64Zip = path.join(root, 'AHT-Launcher-macOS-x64-9.9.10.zip');
const macosArmDmg = path.join(root, 'AHT-Launcher-macOS-arm64-9.9.10.dmg');
const macosX64Dmg = path.join(root, 'AHT-Launcher-macOS-x64-9.9.10.dmg');
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
  if (file.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (file.endsWith('.zip')) return 'application/zip';
  if (file.endsWith('.dmg')) return 'application/x-apple-diskimage';
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

async function waitFor(client, expression, label, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await fsp.mkdir(fakeBin, { recursive: true });
await fsp.mkdir(path.join(fakeR2Root, bucket), { recursive: true });
await fsp.writeFile(installer, 'fake windows launcher installer\n', 'utf8');
await fsp.writeFile(macosArmZip, 'fake macos arm64 update zip\n', 'utf8');
await fsp.writeFile(macosX64Zip, 'fake macos x64 update zip\n', 'utf8');
await fsp.writeFile(macosArmDmg, 'fake macos arm64 dmg\n', 'utf8');
await fsp.writeFile(macosX64Dmg, 'fake macos x64 dmg\n', 'utf8');

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
const createIndex = args.indexOf('create');
if (args.includes('bucket') && createIndex !== -1) {
  console.log('Created bucket ' + args[createIndex + 1]);
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

await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir: path.join(root, 'instance'),
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: workerEndpoint, playerLabel: 'SmokeUser' },
  developer: { adminBaseUrl: workerEndpoint, defaultOutDir: path.join(root, 'release'), defaultCacheModsDir: '', r2Bucket: bucket },
  launcherUpdate: { enabled: true, latestUrl: `${workerEndpoint}/launcher/latest.json` },
  minecraftLauncher: { enabled: false, rootDir: path.join(root, 'minecraft'), profileId: 'a-hard-time', profileName: 'A Hard Time', memoryMb: 4096 },
  playCommand: { command: '', args: [], cwd: path.join(root, 'instance') }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'smoke-install',
  minecraftUsername: 'SmokeUser'
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/' || url.pathname === '/launcher/') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (key === 'latest.json') {
    const body = JSON.stringify({ packId: 'a-hard-time-dregora', name: 'A Hard Time', version: '1.0.0', required: false, zip: { url: 'packs/a-hard-time-1.0.0.zip' } });
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
    return;
  }
  const file = path.join(fakeR2Root, bucket, ...key.split('/'));
  try {
    const stat = await fsp.stat(file);
    response.writeHead(200, { 'Content-Type': contentTypeFor(file), 'Content-Length': String(stat.size) });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'application/json' });
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
    AHT_TEST_ALLOW_INSECURE_LAUNCHER_UPDATE: '1',
    AHT_DEVELOPER_USERNAME: 'admin',
    AHT_DEVELOPER_PASSWORD: 'test-dev-password',
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    FAKE_R2_ROOT: fakeR2Root,
    FAKE_UPLOAD_LOG: uploadLog,
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
  await waitFor(client, "document.body.classList.contains('dev-locked') === false", 'developer unlock');
  const result = await evaluate(client, `window.aht.devSyncLauncherUpdate({
    version: '9.9.10',
    windowsPath: ${JSON.stringify(installer)},
    macosArmZipPath: ${JSON.stringify(macosArmZip)},
    macosX64ZipPath: ${JSON.stringify(macosX64Zip)},
    macosArmDmgPath: ${JSON.stringify(macosArmDmg)},
    macosX64DmgPath: ${JSON.stringify(macosX64Dmg)},
    bucket: ${JSON.stringify(bucket)},
    publicLatestUrl: ${JSON.stringify(`${workerEndpoint}/latest.json`)}
  })`);
  const uploaded = result.uploaded.map((item) => item.path);
  if (uploaded.at(-1) !== 'launcher/latest.json') {
    throw new Error(`launcher/latest.json was not uploaded last: ${JSON.stringify(uploaded)}`);
  }
  if (result.verification?.latest?.version !== '9.9.10') {
    throw new Error(`Launcher update verification failed: ${JSON.stringify(result.verification)}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(fakeR2Root, bucket, 'launcher', 'latest.json'), 'utf8'));
  if (!manifest.platforms?.win32?.url || !manifest.platforms?.['win32-x64']?.sha256) {
    throw new Error(`Published launcher manifest missing Windows artifact aliases: ${JSON.stringify(manifest)}`);
  }
  if (manifest.platforms?.['darwin-arm64']?.kind !== 'zip' || manifest.platforms?.['darwin-x64']?.kind !== 'zip') {
    throw new Error(`Published launcher manifest must use macOS ZIP artifacts for self-update: ${JSON.stringify(manifest.platforms)}`);
  }
  if (manifest.downloads?.['macos-arm64']?.kind !== 'dmg' || manifest.downloads?.['macos-x64']?.kind !== 'dmg') {
    throw new Error(`Published launcher manifest must use macOS DMG artifacts for manual downloads: ${JSON.stringify(manifest.downloads)}`);
  }
  if (!manifest.downloads?.['windows-x64'] || !manifest.downloads?.['macos-arm64'] || !manifest.downloads?.['macos-x64']) {
    throw new Error(`Published launcher manifest missing website download entries: ${JSON.stringify(manifest.downloads)}`);
  }
  const uploadOrder = fs.readFileSync(uploadLog, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line).key);
  console.log(JSON.stringify({
    ok: true,
    root,
    version: manifest.version,
    uploaded,
    uploadOrderLast: uploadOrder.at(-1),
    artifact: manifest.platforms['win32-x64']
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
