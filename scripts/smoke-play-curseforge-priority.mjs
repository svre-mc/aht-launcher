import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const expectFallback = process.argv.includes('--fallback');
const expectCurseForgeAppFallback = process.argv.includes('--curseforge-app-fallback');
const useDesktopMinecraftLauncher = !process.argv.includes('--no-desktop');
const portArg = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
const port = Number(portArg || (expectFallback ? 10976 : 10876));
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-play-curseforge-priority-'));
const fakeUserProfile = path.join(root, 'home');
const fakeHome = fakeUserProfile;
const fakeAppData = path.join(fakeUserProfile, 'AppData', 'Roaming');
const fakeLocalAppData = path.join(fakeUserProfile, 'AppData', 'Local');
const fakeProgramFiles = path.join(root, 'Program Files');
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'A Hard Time');
const configuredMcRoot = path.join(fakeAppData, '.minecraft');
const storePackageFamily = 'Microsoft.4297127D64EC6_8wekyb3d8bbwe';
const storePackageDir = path.join(fakeLocalAppData, 'Packages', storePackageFamily);
const storeMcRoot = path.join(storePackageDir, 'LocalCache', 'Roaming', '.minecraft');
const curseForgeRoot = path.join(fakeUserProfile, 'curseforge', 'minecraft', 'Install');
const desktopMinecraftLauncher = path.join(fakeProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe');
const curseForgeApp = path.join(fakeLocalAppData, 'Programs', 'CurseForge', 'CurseForge.exe');
const spawnCapturePath = path.join(root, 'spawn-detached.jsonl');
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

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

async function waitFor(client, expression, label, attempts = 160) {
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

async function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const text = await fsp.readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function writeReadyMinecraftRoot(rootDir, options = {}) {
  await writeJson(path.join(rootDir, 'versions', versionId, `${versionId}.json`), { id: versionId, type: 'release' });
  await writeJson(
    path.join(rootDir, 'versions', '1.12.2', '1.12.2.json'),
    { id: '1.12.2', assetIndex: { id: '1.12', url: `${workerEndpoint}/assets/1.12.json` } }
  );
  if (options.launcherExe) {
    await fsp.mkdir(rootDir, { recursive: true });
    await fsp.writeFile(path.join(rootDir, process.platform === 'win32' ? 'minecraft.exe' : 'minecraft-launcher'), 'test launcher placeholder\n', 'utf8');
  }
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '8.9.3',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { url: 'packs/a-hard-time-8.9.3.zip' },
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  }
};
const managedModContent = 'managed mod bytes\n';
const assetBytes = Buffer.from('curseforge-first repaired asset\n');
const assetHash = sha1(assetBytes);
const assetRequests = [];

await fsp.mkdir(fakeProgramFiles, { recursive: true });
if (useDesktopMinecraftLauncher) {
  await fsp.mkdir(path.dirname(desktopMinecraftLauncher), { recursive: true });
  await fsp.writeFile(desktopMinecraftLauncher, 'desktop launcher placeholder\n', 'utf8');
}
if (expectCurseForgeAppFallback) {
  await fsp.mkdir(path.dirname(curseForgeApp), { recursive: true });
  await fsp.writeFile(curseForgeApp, 'curseforge app placeholder\n', 'utf8');
}
await fsp.mkdir(path.join(instanceDir, 'mods'), { recursive: true });
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
await writeReadyMinecraftRoot(configuredMcRoot);
await writeReadyMinecraftRoot(curseForgeRoot);
await fsp.mkdir(path.join(storePackageDir, 'LocalState'), { recursive: true });
await writeReadyMinecraftRoot(storeMcRoot);
await fsp.mkdir(path.join(configuredMcRoot, 'assets', 'indexes'), { recursive: true });
await fsp.writeFile(path.join(configuredMcRoot, 'assets', 'indexes', '1.12.json'), '', 'utf8');
await fsp.mkdir(path.join(curseForgeRoot, 'assets', 'indexes'), { recursive: true });
await fsp.writeFile(path.join(curseForgeRoot, 'assets', 'indexes', '1.12.json'), '', 'utf8');
await fsp.mkdir(path.join(storeMcRoot, 'assets', 'indexes'), { recursive: true });
await fsp.writeFile(path.join(storeMcRoot, 'assets', 'indexes', '1.12.json'), '', 'utf8');

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
    rootDir: configuredMcRoot,
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
  if (url.pathname === '/assets/1.12.json') {
    assetRequests.push(url.pathname);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ objects: { 'minecraft/lang/en_us.lang': { hash: assetHash, size: assetBytes.length } } }));
    return;
  }
  if (url.pathname === `/asset-objects/${assetHash.slice(0, 2)}/${assetHash}`) {
    assetRequests.push(url.pathname);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', String(assetBytes.length));
    response.end(assetBytes);
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
        token: 'curseforge-priority-proof-token',
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
    AHT_TEST_MINECRAFT_ASSET_BASE_URL: `${workerEndpoint}/asset-objects/`,
    AHT_TEST_SPAWN_DETACHED_CAPTURE_PATH: spawnCapturePath,
    AHT_TEST_SPAWN_DETACHED_FAIL_KINDS: expectFallback ? 'curseforge' : '',
    ELECTRON_ENABLE_LOGGING: '0',
    LOCALAPPDATA: fakeLocalAppData,
    APPDATA: fakeAppData,
    USERPROFILE: fakeUserProfile,
    HOME: fakeHome,
    ProgramFiles: fakeProgramFiles,
    'ProgramFiles(x86)': fakeProgramFiles
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
    window.aht.accountRegister('CFFirstUser')
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  if (!registration.ok || !registration.result?.ok) {
    throw new Error(`Player registration failed: ${JSON.stringify(registration)}`);
  }
  const before = await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '8.9.3' ? status : false)
  `, 'ready status before CurseForge-first Play');
  if (!before.launchReady || before.launchBlockedReason || before.integrity?.counts?.corrupted) {
    throw new Error(`Smoke setup should be launch-ready before CurseForge-first Play: ${JSON.stringify(before)}`);
  }
  const expectedOpenState = 'preferred';
  if (before.setup?.minecraftLauncherOpenState !== expectedOpenState) {
    throw new Error(`Setup did not report the expected first Minecraft route ${expectedOpenState}: ${JSON.stringify(before.setup)}`);
  }
  if (!Array.isArray(before.setup?.minecraftLauncherRouteKinds) || before.setup.minecraftLauncherRouteKinds[0] !== expectedOpenState) {
    throw new Error(`Setup did not expose the expected safe route summary: ${JSON.stringify(before.setup)}`);
  }
  if (!before.setup.minecraftLauncherHasCurseForgeRoute || before.setup.minecraftLauncherRouteCount < 1) {
    throw new Error(`Setup did not report CurseForge route availability: ${JSON.stringify(before.setup)}`);
  }
  if (expectCurseForgeAppFallback && !before.setup.minecraftLauncherRouteDegraded) {
    throw new Error(`CurseForge app fallback should be marked as a degraded route before Store: ${JSON.stringify(before.setup)}`);
  }

  await evaluate(client, `document.querySelector('#playButton')?.click(); true`);
  const toast = await waitFor(client, `
    (() => {
      const nodes = [...document.querySelectorAll('.toast')];
      const toast = nodes.find((item) => /Minecraft Launcher opened/i.test(item.querySelector('strong')?.textContent || ''));
      if (!toast) return false;
      return {
        title: toast.querySelector('strong')?.textContent || '',
        detail: toast.querySelector('span')?.textContent || '',
        log: document.querySelector('#log')?.textContent || ''
      };
    })()
  `, 'Play success toast after CurseForge root prep');
  if (/REQUEST_FAILED|Unable to prepare assets|Unexpected end of JSON|Launch failed|Error invoking remote method/i.test(`${toast.title}\n${toast.detail}\n${toast.log}`)) {
    throw new Error(`CurseForge-first Play leaked a launcher asset failure: ${JSON.stringify(toast)}`);
  }
  const spawnCaptures = await readJsonLines(spawnCapturePath);
  const spawnCapture = spawnCaptures.at(-1);
  if (expectCurseForgeAppFallback) {
    if (!spawnCapture || spawnCapture.kind !== 'curseforge-app' || path.resolve(spawnCapture.command) !== path.resolve(curseForgeApp)) {
      throw new Error(`Play did not open CurseForge before the Store fallback when no desktop Minecraft Launcher exists: ${JSON.stringify(spawnCaptures)}`);
    }
    if (JSON.stringify(spawnCapture.args) !== JSON.stringify([])) {
      throw new Error(`CurseForge app fallback should not receive Minecraft Launcher args it cannot honor: ${JSON.stringify(spawnCapture)}`);
    }
    if (path.resolve(spawnCapture.cwd) !== path.resolve(curseForgeRoot)) {
      throw new Error(`CurseForge app fallback did not launch from the CurseForge Minecraft root cwd: ${JSON.stringify(spawnCapture)}`);
    }
  } else if (expectFallback) {
    const firstCapture = spawnCaptures[0];
    if (!firstCapture || firstCapture.kind !== 'curseforge' || firstCapture.outcome !== 'forced-failure') {
      throw new Error(`Fallback smoke did not try CurseForge first and record the forced failure: ${JSON.stringify(spawnCaptures)}`);
    }
    if (!spawnCapture || spawnCapture.kind !== 'desktop' || path.resolve(spawnCapture.command) !== path.resolve(desktopMinecraftLauncher)) {
      throw new Error(`Fallback smoke did not open the normal Minecraft Launcher after the CurseForge-root route failed: ${JSON.stringify(spawnCaptures)}`);
    }
    if (JSON.stringify(spawnCapture.args) !== JSON.stringify(['--workDir', configuredMcRoot])) {
      throw new Error(`Fallback smoke did not retry the desktop launcher with the configured Minecraft root: ${JSON.stringify(spawnCapture)}`);
    }
    if (path.resolve(spawnCapture.cwd) !== path.resolve(configuredMcRoot)) {
      throw new Error(`Fallback smoke did not launch the normal Minecraft route from the configured root cwd: ${JSON.stringify(spawnCapture)}`);
    }
  } else {
    if (!spawnCapture || spawnCapture.kind !== 'curseforge' || path.resolve(spawnCapture.command) !== path.resolve(desktopMinecraftLauncher)) {
      throw new Error(`Play did not open the Minecraft Launcher with the CurseForge root first: ${JSON.stringify(spawnCaptures)}`);
    }
    if (JSON.stringify(spawnCapture.args) !== JSON.stringify(['--workDir', curseForgeRoot])) {
      throw new Error(`Play did not pass the CurseForge Minecraft root as --workDir: ${JSON.stringify(spawnCapture)}`);
    }
    if (path.resolve(spawnCapture.cwd) !== path.resolve(curseForgeRoot)) {
      throw new Error(`Play did not launch the CurseForge-root route from the CurseForge cwd: ${JSON.stringify(spawnCapture)}`);
    }
  }

  for (const rootDir of [configuredMcRoot, curseForgeRoot, storeMcRoot]) {
    const profile = JSON.parse(await fsp.readFile(path.join(rootDir, 'launcher_profiles.json'), 'utf8')).profiles?.['a-hard-time'];
    if (!profile || profile.lastVersionId !== versionId || path.resolve(profile.gameDir) !== path.resolve(instanceDir)) {
      throw new Error(`AHT profile was not prepared in ${rootDir}: ${JSON.stringify(profile)}`);
    }
    const assetIndex = JSON.parse(await fsp.readFile(path.join(rootDir, 'assets', 'indexes', '1.12.json'), 'utf8'));
    const legacyIndex = JSON.parse(await fsp.readFile(path.join(rootDir, 'assets', 'indexes', 'legacy.json'), 'utf8'));
    if (assetIndex.objects?.['minecraft/lang/en_us.lang']?.hash !== assetHash || legacyIndex.objects?.['minecraft/lang/en_us.lang']?.hash !== assetHash) {
      throw new Error(`Asset indexes were not repaired in ${rootDir}: ${JSON.stringify({ assetIndex, legacyIndex })}`);
    }
    const assetObject = path.join(rootDir, 'assets', 'objects', assetHash.slice(0, 2), assetHash);
    if (sha1(await fsp.readFile(assetObject)) !== assetHash) {
      throw new Error(`Asset object was not repaired in ${rootDir}.`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    packaged: Boolean(smokeExe),
    configuredMcRoot,
    curseForgeRoot,
    storeMcRoot,
    expectFallback,
    expectCurseForgeAppFallback,
    requests: assetRequests,
    spawnCapture
  }, null, 2));
} finally {
  try {
    client?.close?.();
  } catch {}
  server.close();
  if (!child.killed) {
    child.kill();
  }
}
