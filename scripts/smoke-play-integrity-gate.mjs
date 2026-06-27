import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10010);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-play-gate-'));
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
const fakeLauncherMarker = path.join(root, 'fake-minecraft-launcher.json');
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

async function waitFor(client, expression, label, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '2.8.2',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { url: 'packs/a-hard-time-2.8.2.zip' },
  cacheManifest: { url: 'cache-manifest.json' },
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  }
};

const expectedContent = 'managed=true\n';
const corruptContent = 'managed=false\n';
const fakeLauncherScript = 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), disableRtss: process.env.DISABLE_RTSS_LAYER || "", disableObs: process.env.DISABLE_VULKAN_OBS_CAPTURE || "" }, null, 2))';
await writeJson(defaultsPath, {
  packId: 'a-hard-time-dregora',
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  launcherUpdate: { enabled: false, latestUrl: '' }
});
await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: `${workerEndpoint}/`, playerLabel: 'SmokeUser' },
  developer: { adminBaseUrl: `${workerEndpoint}/`, defaultOutDir: path.join(root, 'release'), defaultCacheModsDir: '', r2Bucket: 'ahtlauncher' },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  minecraftLauncher: {
    enabled: true,
    rootDir: mcRoot,
    profileId: 'a-hard-time-dregora',
    profileName: 'A Hard Time',
    memoryMb: 4096,
    openCommand: process.execPath,
    openArgs: ['-e', fakeLauncherScript, fakeLauncherMarker]
  },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), { installId: 'smoke-install' });
await writeJson(path.join(instanceDir, '.aht-launcher', 'installed.json'), {
  packId: latest.packId,
  name: latest.name,
  version: latest.version,
  minecraft: latest.minecraft,
  manifestFileCount: 0,
  overrideFileCount: 1
});
await writeJson(path.join(instanceDir, '.aht-launcher', 'managed-files.json'), [{
  relativePath: 'config/aht-integrity-test.cfg',
  source: 'overrides',
  sha256: sha256(expectedContent)
}, {
  relativePath: 'mods/aht-integrity-test.jar',
  source: 'curseforge',
  sha256: sha256(expectedContent)
}]);
await fsp.mkdir(path.join(instanceDir, 'config'), { recursive: true });
await fsp.writeFile(path.join(instanceDir, 'config', 'aht-integrity-test.cfg'), corruptContent, 'utf8');
await fsp.mkdir(path.join(instanceDir, 'mods'), { recursive: true });
await fsp.writeFile(path.join(instanceDir, 'mods', 'aht-integrity-test.jar'), corruptContent, 'utf8');
await writeJson(
  path.join(mcRoot, 'versions', '1.12.2-forge-14.23.5.2860', '1.12.2-forge-14.23.5.2860.json'),
  { id: '1.12.2-forge-14.23.5.2860', type: 'release' }
);

const registeredUsers = new Map();
const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(latest));
    return;
  }
  if (url.pathname === '/cache-manifest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({
      extraFiles: [{
        fileName: 'legacy-cache-extra.jar',
        installPath: 'mods/legacy-cache-extra.jar',
        sha256: sha256('old legacy cache bytes')
      }]
    }));
    return;
  }
  if (url.pathname === '/api/users/register') {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const username = String(payload.username || '').trim();
      const installId = String(payload.installId || '').trim();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(username) || !installId) {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Invalid username registration.' }));
        return;
      }
      registeredUsers.set(username.toLowerCase(), installId);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true, username, installId }));
    });
    return;
  }
  if (url.pathname === '/api/update-logs') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ logs: [] }));
    return;
  }
  if (url.pathname === '/api/launcher-proof') {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const username = String(payload.minecraftUsername || '').trim().toLowerCase();
      const installId = String(payload.installId || '').trim();
      if (!username || registeredUsers.get(username) !== installId) {
        response.statusCode = 403;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Minecraft username is not registered to this launcher install.' }));
        return;
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({
        token: 'smoke-launcher-proof-token',
        payload,
        signature: { alg: 'HS256', kid: 'smoke', value: 'smoke-signature' }
      }));
    });
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0', AHT_APP_DEFAULTS: defaultsPath },
  stdio: 'ignore',
  windowsHide: true
});

let client;
try {
  const target = await waitForTarget();
  client = await connect(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'player DOM');
  const registration = await evaluate(client, `
    window.aht.accountRegister('SmokeUser')
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || "") }))
  `);
  if (!registration.ok || !registration.result?.ok) {
    throw new Error(`Smoke player account registration failed: ${JSON.stringify(registration)}`);
  }
  const before = await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '2.8.2' ? status : false)
  `, 'release feed');
  if (!before.launchReady) {
    throw new Error(`Pre-play status should be launch-ready before the forced integrity scan: ${JSON.stringify(before)}`);
  }

  const playResult = await evaluate(client, `
    window.aht.play()
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || "") }))
  `);
  if (playResult.ok || !/Repair required.*mod file issue/i.test(playResult.message || '')) {
    throw new Error(`Play IPC failure path did not surface the corrupted mod file: ${JSON.stringify(playResult)}`);
  }
  const after = await evaluate(client, 'window.aht.getStatus()');
  if (after.launchReady || !/Repair required.*mod file issue/i.test(after.launchBlockedReason || '')) {
    throw new Error(`Status did not stay blocked after play integrity scan: ${JSON.stringify(after)}`);
  }
  if (after.integrity?.counts?.corrupted !== 1 || after.integrity?.changed?.[0]?.path !== 'mods/aht-integrity-test.jar') {
    throw new Error(`Integrity state did not record the corrupted file: ${JSON.stringify(after.integrity)}`);
  }

  const persistedIntegrity = JSON.parse(fs.readFileSync(path.join(instanceDir, '.aht-launcher', 'integrity.json'), 'utf8'));
  if (persistedIntegrity.source !== 'play-check' || persistedIntegrity.counts?.corrupted !== 1) {
    throw new Error(`Play check integrity state was not persisted: ${JSON.stringify(persistedIntegrity)}`);
  }

  await fsp.writeFile(path.join(instanceDir, 'mods', 'aht-integrity-test.jar'), expectedContent, 'utf8');
  await fsp.rm(fakeLauncherMarker, { force: true });
  const cleanPlayResult = await evaluate(client, `
    window.aht.play()
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || "") }))
  `);
  if (!cleanPlayResult.ok || !cleanPlayResult.result?.ok) {
    throw new Error(`Clean install did not open Minecraft Launcher: ${JSON.stringify(cleanPlayResult)}`);
  }
  for (let attempt = 0; attempt < 40 && !fs.existsSync(fakeLauncherMarker); attempt += 1) {
    await sleep(250);
  }
  if (!fs.existsSync(fakeLauncherMarker)) {
    throw new Error('Clean Play returned success, but the Minecraft Launcher command was not spawned.');
  }
  const launcherMarker = JSON.parse(fs.readFileSync(fakeLauncherMarker, 'utf8'));
  if (path.resolve(launcherMarker.cwd) !== path.resolve(mcRoot)) {
    throw new Error(`Minecraft Launcher opened with the wrong cwd: ${JSON.stringify(launcherMarker)}`);
  }
  if (launcherMarker.disableRtss !== '1' || launcherMarker.disableObs !== '1') {
    throw new Error(`Minecraft Launcher environment hardening was not applied: ${JSON.stringify(launcherMarker)}`);
  }
  const cleanStatus = await evaluate(client, 'window.aht.getStatus()');
  if (!cleanStatus.launchReady || cleanStatus.launchBlockedReason) {
    throw new Error(`Clean install stayed launch-locked after Play: ${JSON.stringify(cleanStatus)}`);
  }
  if (cleanStatus.integrity?.counts?.corrupted !== 0) {
    throw new Error(`Clean install still reported corrupted files: ${JSON.stringify(cleanStatus.integrity)}`);
  }
  const proof = JSON.parse(fs.readFileSync(path.join(instanceDir, '.aht-launcher', 'launcher-proof.json'), 'utf8'));
  if (!proof.trusted || proof.source !== 'worker' || !Array.isArray(proof.javaProperties) || !proof.javaProperties.some((arg) => arg.startsWith('-Daht.launcher.proofFile='))) {
    throw new Error(`Clean Play did not write trusted launcher proof Java properties: ${JSON.stringify(proof)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    blockedPlayResult: playResult,
    cleanPlayResult,
    blockedReason: after.launchBlockedReason,
    cleanLaunchCommand: cleanPlayResult.result.command,
    proofSource: proof.source,
    integrity: {
      source: persistedIntegrity.source,
      corrupted: persistedIntegrity.counts.corrupted,
      changedPath: persistedIntegrity.changed[0]?.path,
      cleanCorrupted: cleanStatus.integrity.counts.corrupted
    }
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
