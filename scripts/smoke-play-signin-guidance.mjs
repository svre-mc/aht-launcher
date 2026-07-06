import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10880);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-play-signin-guidance-'));
const fakeUserProfile = path.join(root, 'home');
const fakeHome = fakeUserProfile;
const fakeAppData = path.join(fakeUserProfile, 'AppData', 'Roaming');
const fakeLocalAppData = path.join(fakeUserProfile, 'AppData', 'Local');
const fakeProgramFiles = path.join(root, 'Program Files');
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'A Hard Time');
const mcRoot = path.join(root, '.minecraft');
const spawnCapturePath = path.join(root, 'spawn-detached.jsonl');
const fakeMinecraftLauncher = path.join(fakeProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe');
const versionId = '1.12.2-forge-14.23.5.2860';
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const text = await fsp.readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
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

async function click(client, selector) {
  const result = await client.call('Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    returnByValue: true
  });
  if (!result.result?.value) throw new Error(`Unable to click ${selector}`);
}

async function waitFor(client, expression, label, attempts = 180) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await evaluate(client, expression);
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '8.8.9',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { url: 'packs/a-hard-time-8.8.9.zip' },
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  }
};
const managedModContent = 'managed mod bytes\n';

await fsp.mkdir(path.join(instanceDir, 'mods'), { recursive: true });
await fsp.mkdir(fakeProgramFiles, { recursive: true });
await fsp.writeFile(path.join(instanceDir, 'mods', 'aht-clean.jar'), managedModContent, 'utf8');
await writeJson(path.join(instanceDir, '.aht-launcher', 'installed.json'), {
  packId: latest.packId,
  name: latest.name,
  version: latest.version,
  minecraft: latest.minecraft,
  manifestFileCount: 0,
  overrideFileCount: 1
});
await writeJson(path.join(instanceDir, '.aht-launcher', 'managed-files.json'), [{
  relativePath: 'mods/aht-clean.jar',
  source: 'full-client-zip',
  sha256: sha256(managedModContent)
}]);
await writeJson(
  path.join(mcRoot, 'versions', versionId, `${versionId}.json`),
  { id: versionId, type: 'release' }
);
await writeJson(
  path.join(mcRoot, 'versions', '1.12.2', '1.12.2.json'),
  { id: '1.12.2', assetIndex: { id: '1.12', url: `${workerEndpoint}/assets/1.12.json` } }
);
await writeJson(path.join(mcRoot, 'assets', 'indexes', '1.12.json'), { objects: {} });
await fsp.mkdir(mcRoot, { recursive: true });
await fsp.mkdir(path.dirname(fakeMinecraftLauncher), { recursive: true });
await fsp.writeFile(fakeMinecraftLauncher, 'official Minecraft Launcher placeholder\n', 'utf8');

await writeJson(defaultsPath, {
  packId: latest.packId,
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  launcherUpdate: { enabled: false, latestUrl: '' },
  minecraftLauncher: {
    enabled: true,
    rootDir: mcRoot,
    profileId: 'a-hard-time',
    profileName: 'A Hard Time',
    memoryMb: 4096,
    syncDefaultRoots: false,
    autoImportAccount: false
  },
  playCommand: { command: '', args: [], cwd: instanceDir }
});

const registeredUsers = new Map();
const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(latest));
    return;
  }
  if (url.pathname === '/api/users/register') {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const username = String(payload.username || '').trim();
      const installId = String(payload.installId || '').trim();
      registeredUsers.set(username.toLowerCase(), installId);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true, username, installId }));
    });
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
        token: 'signin-guidance-proof-token',
        payload,
        signature: { alg: 'HS256', kid: 'smoke', value: 'smoke-signature' }
      }));
    });
    return;
  }
  if (url.pathname === '/api/update-logs') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ logs: [] }));
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_APP_DEFAULTS: defaultsPath,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_SPAWN_DETACHED_CAPTURE_PATH: spawnCapturePath,
    AHT_TEST_FORGE_INSTALLER_SUCCESS: '1',
    AHT_DISABLE_COMMON_MINECRAFT_LAUNCHER_DRIVES: '1',
    ELECTRON_ENABLE_LOGGING: '0',
    LOCALAPPDATA: fakeLocalAppData,
    APPDATA: fakeAppData,
    USERPROFILE: fakeUserProfile,
    HOME: fakeHome,
    ProgramFiles: fakeProgramFiles,
    'ProgramFiles(x86)': fakeProgramFiles,
    ProgramW6432: fakeProgramFiles
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
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'player DOM');
  const registration = await evaluate(client, `
    window.aht.accountRegister('SigninGuide')
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  if (!registration.ok || !registration.result?.ok) {
    throw new Error(`Player registration failed: ${JSON.stringify(registration)}`);
  }
  const before = await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '8.8.9' ? status : false)
  `, 'ready status before sign-in guidance Play');
  if (!before.launchReady || before.launchBlockedReason || before.integrity?.counts?.corrupted) {
    throw new Error(`Smoke setup should be launch-ready before Play: ${JSON.stringify(before)}`);
  }
  if (before.minecraftProfile?.accountReuseAvailable || before.minecraftProfile?.accountProfileKnown || before.minecraftProfile?.accountCredentialOnly) {
    throw new Error(`Smoke setup should start with no Minecraft account evidence: ${JSON.stringify(before.minecraftProfile)}`);
  }

  await click(client, '#playButton');
  const signInToast = await waitFor(client, `
    (() => {
      const toast = [...document.querySelectorAll('.toast')].find((item) => item.innerText.includes('Minecraft Launcher opened'));
      if (!toast) return false;
      return { text: toast.innerText.replace(/\\s+/g, ' ').trim(), className: toast.className };
    })()
  `, 'Play success toast with required sign-in guidance');
  if (!/Sign in with Microsoft inside Minecraft Launcher/i.test(signInToast.text) || /finish Microsoft sign-in/i.test(signInToast.text)) {
    throw new Error(`Play toast did not use no-account sign-in guidance: ${JSON.stringify(signInToast)}`);
  }
  let spawnCaptures = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    spawnCaptures = await readJsonLines(spawnCapturePath);
    if (spawnCaptures.length) break;
    await sleep(250);
  }
  if (!spawnCaptures.length) {
    throw new Error('Play returned success, but the Minecraft Launcher command was not spawned for no-account guidance.');
  }
  const firstLauncherMarker = spawnCaptures.at(-1);
  if (path.resolve(firstLauncherMarker.cwd) !== path.resolve(mcRoot)) {
    throw new Error(`Minecraft Launcher opened with the wrong cwd for no-account guidance: ${JSON.stringify(firstLauncherMarker)}`);
  }

  await fsp.rm(spawnCapturePath, { force: true });
  await fsp.writeFile(path.join(mcRoot, 'launcher_msa_credentials.bin'), 'credential-cache-only', 'utf8');
  await evaluate(client, `document.querySelectorAll('.toast').forEach((toast) => toast.remove()); true`);
  const credentialOnly = await waitFor(client, `
    window.aht.getStatus().then((status) => status.minecraftProfile?.accountReuseAvailable === true && status.minecraftProfile?.accountCredentialOnly === true && status.minecraftProfile?.accountProfileKnown === false ? status : false)
  `, 'credential-only Minecraft auth status');

  await click(client, '#playButton');
  const credentialToast = await waitFor(client, `
    (() => {
      const toast = [...document.querySelectorAll('.toast')].find((item) => item.innerText.includes('Minecraft Launcher opened'));
      if (!toast) return false;
      return { text: toast.innerText.replace(/\\s+/g, ' ').trim(), className: toast.className };
    })()
  `, 'Play success toast with credential-only sign-in guidance');
  if (!/finish Microsoft sign-in/i.test(credentialToast.text) || /Sign in with Microsoft inside/i.test(credentialToast.text)) {
    throw new Error(`Play toast did not use credential-only sign-in guidance: ${JSON.stringify(credentialToast)}`);
  }
  spawnCaptures = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    spawnCaptures = await readJsonLines(spawnCapturePath);
    if (spawnCaptures.length) break;
    await sleep(250);
  }
  if (!spawnCaptures.length) {
    throw new Error('Play returned success, but the Minecraft Launcher command was not spawned for credential-only guidance.');
  }
  const launcherMarker = spawnCaptures.at(-1);
  if (path.resolve(launcherMarker.cwd) !== path.resolve(mcRoot)) {
    throw new Error(`Minecraft Launcher opened with the wrong cwd: ${JSON.stringify(launcherMarker)}`);
  }
  const proof = JSON.parse(fs.readFileSync(path.join(instanceDir, '.aht-launcher', 'launcher-proof.json'), 'utf8'));
  if (!proof.trusted || proof.source !== 'worker') {
    throw new Error(`Play did not write trusted proof before launcher handoff: ${JSON.stringify(proof)}`);
  }
  const profile = JSON.parse(fs.readFileSync(path.join(mcRoot, 'launcher_profiles.json'), 'utf8')).profiles?.['a-hard-time'];
  if (!profile || profile.lastVersionId !== versionId || path.resolve(profile.gameDir) !== path.resolve(instanceDir)) {
    throw new Error(`Play did not prepare the Minecraft profile: ${JSON.stringify(profile)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    packaged: Boolean(smokeExe),
    noAccountToast: signInToast.text,
    credentialOnlyToast: credentialToast.text,
    credentialOnlyAccount: credentialOnly.minecraftProfile,
    proofSource: proof.source,
    profile: {
      gameDir: profile.gameDir,
      lastVersionId: profile.lastVersionId
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
