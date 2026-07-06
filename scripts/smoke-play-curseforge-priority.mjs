import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const expectFallback = process.argv.includes('--fallback');
const expectStoreFallback = process.argv.includes('--store-fallback');
const expectStoreNoProcess = process.argv.includes('--store-no-process');
const expectStartFallback = process.argv.includes('--desktop-start-retry');
const expectAppAliasIgnored = process.argv.includes('--app-alias-ignored');
const expectCustomFallback = process.argv.includes('--custom-fallback');
const expectCurseForgeAuthImport = process.argv.includes('--curseforge-auth-import');
const expectLocalAppDataLauncher = process.argv.includes('--localappdata-launcher');
const expectShortcutLauncher = process.argv.includes('--shortcut-launcher');
const expectGenericShortcutLauncher = process.argv.includes('--generic-shortcut-launcher');
const useDesktopMinecraftLauncher = !process.argv.includes('--no-desktop');
const portArg = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
const defaultPort = expectFallback ? 10976 : expectStoreFallback ? 11076 : expectCustomFallback ? 11176 : expectStartFallback ? 11276 : expectAppAliasIgnored ? 11376 : expectStoreNoProcess ? 11476 : expectCurseForgeAuthImport ? 11576 : expectLocalAppDataLauncher ? 11676 : expectShortcutLauncher ? 11776 : expectGenericShortcutLauncher ? 11876 : 10876;
const port = Number(portArg || await availablePortPair(defaultPort));
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
const localAppDataMinecraftLauncher = path.join(fakeLocalAppData, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe');
const shortcutMinecraftLauncher = path.join(root, 'Games', 'Minecraft Launcher', 'MinecraftLauncher.exe');
const startMenuShortcut = path.join(
  fakeAppData,
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  expectGenericShortcutLauncher ? 'Launcher.lnk' : 'Minecraft Launcher.lnk'
);
const appAliasMinecraftLauncher = path.join(fakeLocalAppData, 'Microsoft', 'WindowsApps', 'MinecraftLauncher.exe');
const curseForgeApp = path.join(fakeLocalAppData, 'Programs', 'CurseForge', 'CurseForge.exe');
const spawnCapturePath = path.join(root, 'spawn-detached.jsonl');
const externalOpenCapturePath = path.join(root, 'external-open.jsonl');
const versionId = '1.12.2-forge-14.23.5.2860';
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

async function portIsAvailable(portNumber) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(portNumber, '127.0.0.1');
  });
}

async function availablePortPair(preferredPort) {
  const candidates = [
    preferredPort,
    ...Array.from({ length: 80 }, () => 20_000 + Math.floor(Math.random() * 20_000) * 2)
  ];
  for (const candidate of candidates) {
    if (candidate > 0 && candidate < 65_534 && await portIsAvailable(candidate) && await portIsAvailable(candidate + 1)) {
      return candidate;
    }
  }
  throw new Error('Could not find an available local port pair for the Electron smoke test.');
}

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

function psSingleQuoted(value = '') {
  return `'${String(value || '').replaceAll("'", "''")}'`;
}

function createWindowsShortcut(shortcutPath, targetPath) {
  if (process.platform !== 'win32') {
    throw new Error('Windows shortcut discovery smoke can only run on Windows.');
  }
  fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
  const script = [
    '$shell = New-Object -ComObject WScript.Shell',
    `$shortcut = $shell.CreateShortcut(${psSingleQuoted(shortcutPath)})`,
    `$shortcut.TargetPath = ${psSingleQuoted(targetPath)}`,
    `$shortcut.WorkingDirectory = ${psSingleQuoted(path.dirname(targetPath))}`,
    '$shortcut.Save()'
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`Failed to create Windows shortcut: ${result.stderr || result.stdout || result.status}`);
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
if (useDesktopMinecraftLauncher && !expectLocalAppDataLauncher && !expectShortcutLauncher && !expectGenericShortcutLauncher) {
  await fsp.mkdir(path.dirname(desktopMinecraftLauncher), { recursive: true });
  await fsp.writeFile(desktopMinecraftLauncher, 'desktop launcher placeholder\n', 'utf8');
}
if (expectLocalAppDataLauncher) {
  await fsp.mkdir(path.dirname(localAppDataMinecraftLauncher), { recursive: true });
  await fsp.writeFile(localAppDataMinecraftLauncher, 'local appdata launcher placeholder\n', 'utf8');
}
if (expectShortcutLauncher || expectGenericShortcutLauncher) {
  await fsp.mkdir(path.dirname(shortcutMinecraftLauncher), { recursive: true });
  await fsp.writeFile(shortcutMinecraftLauncher, 'shortcut target launcher placeholder\n', 'utf8');
  createWindowsShortcut(startMenuShortcut, shortcutMinecraftLauncher);
}
if (expectAppAliasIgnored) {
  await fsp.mkdir(path.dirname(appAliasMinecraftLauncher), { recursive: true });
  await fsp.writeFile(appAliasMinecraftLauncher, 'app alias launcher placeholder\n', 'utf8');
}
if (expectStoreFallback || expectStoreNoProcess) {
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
if (expectCurseForgeAuthImport) {
  await writeJson(path.join(curseForgeRoot, 'launcher_accounts.json'), {
    activeAccountLocalId: 'curseforge-account',
    accounts: {
      'curseforge-account': {
        type: 'Xbox',
        minecraftProfile: { name: 'CFFirstUser' }
      }
    }
  });
}
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
    autoImportAccount: expectCurseForgeAuthImport,
    ...(expectCustomFallback ? {
      openCommand: path.join(root, 'missing-custom-launcher', 'MinecraftLauncher.exe'),
      openArgs: ['--bad-custom']
    } : {})
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
    AHT_TEST_OPEN_EXTERNAL_CAPTURE_PATH: externalOpenCapturePath,
    AHT_TEST_STORE_PROCESS_STATE: expectStoreNoProcess ? 'missing' : '',
    AHT_TEST_SPAWN_DETACHED_FAIL_KINDS: [
      expectFallback ? 'curseforge' : '',
      expectCustomFallback ? 'custom' : ''
    ].filter(Boolean).join(','),
    AHT_TEST_SPAWN_DETACHED_FAIL_SOURCES: expectStartFallback ? 'program-files-x86' : '',
    ELECTRON_ENABLE_LOGGING: '0',
    LOCALAPPDATA: fakeLocalAppData,
    APPDATA: fakeAppData,
    USERPROFILE: fakeUserProfile,
    HOME: fakeHome,
    ProgramFiles: fakeProgramFiles,
    'ProgramFiles(x86)': fakeProgramFiles,
    AHT_DISABLE_COMMON_MINECRAFT_LAUNCHER_DRIVES: (expectStoreFallback || expectAppAliasIgnored || expectStoreNoProcess || expectShortcutLauncher || expectGenericShortcutLauncher) ? '1' : ''
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
  if (!expectCurseForgeAuthImport) {
    const registration = await evaluate(client, `
      window.aht.accountRegister('CFFirstUser')
        .then((result) => ({ ok: true, result }))
        .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
    `);
    if (!registration.ok || !registration.result?.ok) {
      throw new Error(`Player registration failed: ${JSON.stringify(registration)}`);
    }
  }
  const before = await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '8.9.3' ? status : false)
  `, 'ready status before CurseForge-first Play');
  if (!before.launchReady || before.launchBlockedReason || before.integrity?.counts?.corrupted) {
    throw new Error(`Smoke setup should be launch-ready before CurseForge-first Play: ${JSON.stringify(before)}`);
  }
  const expectedOpenState = (expectStoreFallback || expectAppAliasIgnored || expectStoreNoProcess) ? 'store-fallback' : 'preferred';
  if (before.setup?.minecraftLauncherOpenState !== expectedOpenState) {
    throw new Error(`Setup did not report the expected first Minecraft route ${expectedOpenState}: ${JSON.stringify(before.setup)}`);
  }
  if (!Array.isArray(before.setup?.minecraftLauncherRouteKinds) || before.setup.minecraftLauncherRouteKinds[0] !== expectedOpenState) {
    throw new Error(`Setup did not expose the expected safe route summary: ${JSON.stringify(before.setup)}`);
  }
  if (!expectStoreFallback && !expectAppAliasIgnored && !expectStoreNoProcess && (!before.setup.minecraftLauncherHasCurseForgeRoute || before.setup.minecraftLauncherRouteCount < 1)) {
    throw new Error(`Setup did not report CurseForge route availability: ${JSON.stringify(before.setup)}`);
  }
  if (expectStoreFallback || expectAppAliasIgnored || expectStoreNoProcess) {
    if (!before.setup.minecraftLauncherRouteDegraded || before.setup.minecraftLauncherHasCurseForgeRoute) {
      throw new Error(`Store fallback should be degraded and must not expose a CurseForge app route: ${JSON.stringify(before.setup)}`);
    }
  }

  await evaluate(client, `document.querySelector('#playButton')?.click(); true`);
  if (expectStoreNoProcess) {
    const toast = await waitFor(client, `
      (() => {
        const nodes = [...document.querySelectorAll('.toast')];
        const toast = nodes.find((item) => /Setup needed/i.test(item.querySelector('strong')?.textContent || ''));
        if (!toast) return false;
        return {
          title: toast.querySelector('strong')?.textContent || '',
          detail: toast.querySelector('span')?.textContent || '',
          log: document.querySelector('#log')?.textContent || ''
        };
      })()
    `, 'setup-needed toast after Store route failed to start a launcher process');
    if (!/Windows app execution did not open|official Minecraft Launcher download page|minecraft\.net\/download/i.test(`${toast.detail}\n${toast.log}`)) {
      throw new Error(`Store no-process failure did not give actionable Minecraft Launcher setup guidance: ${JSON.stringify(toast)}`);
    }
    const spawnCaptures = await readJsonLines(spawnCapturePath);
    if (!spawnCaptures.length || !spawnCaptures.every((capture) => capture.kind === 'store')) {
      throw new Error(`Store no-process smoke should only try Store launcher routes: ${JSON.stringify(spawnCaptures)}`);
    }
    const externalCaptures = await readJsonLines(externalOpenCapturePath);
    if (!externalCaptures.some((capture) => /minecraft\.net\/download/i.test(String(capture.url || capture.message || '')))) {
      throw new Error(`Store no-process smoke did not open the official Minecraft Launcher download page: ${JSON.stringify(externalCaptures)}`);
    }
    console.log(JSON.stringify({
      ok: true,
      root,
      packaged: Boolean(smokeExe),
      expectStoreNoProcess,
      spawnCaptures,
      externalCaptures
    }, null, 2));
  } else {
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
  if (expectCurseForgeAuthImport) {
    const identity = JSON.parse(await fsp.readFile(path.join(userData, 'identity.json'), 'utf8'));
    if (identity.minecraftUsername !== 'CFFirstUser' || identity.usernameRegistrationMode !== 'minecraft-launcher') {
      throw new Error(`Play did not import the Minecraft username from the CurseForge launcher root: ${JSON.stringify(identity)}`);
    }
    if (!registeredUsers.has('cffirstuser')) {
      throw new Error(`Play did not register the imported CurseForge-root username before launcher proof: ${JSON.stringify([...registeredUsers.entries()])}`);
    }
  }
  const spawnCaptures = await readJsonLines(spawnCapturePath);
  const spawnCapture = spawnCaptures.at(-1);
  if (expectCustomFallback && spawnCaptures.some((capture) => capture.kind === 'custom' || capture.source === 'custom')) {
    throw new Error(`Play used a custom launcher command before safe Minecraft Launcher routes: ${JSON.stringify(spawnCaptures)}`);
  }
  if (expectStartFallback) {
    if (spawnCaptures.some((capture) => capture.source === 'windows-app-alias' || path.resolve(String(capture.command || '')) === path.resolve(appAliasMinecraftLauncher))) {
      throw new Error(`Windows app aliases must not be spawned as Minecraft Launcher routes: ${JSON.stringify(spawnCaptures)}`);
    }
    if (!spawnCapture || !String(spawnCapture.source || '').endsWith('-start') || !Array.isArray(spawnCapture.args) || !spawnCapture.args.includes('start') || !spawnCapture.args.includes(desktopMinecraftLauncher)) {
      throw new Error(`Play did not retry the desktop Minecraft Launcher through Windows start: ${JSON.stringify(spawnCaptures)}`);
    }
    if (!spawnCapture.args.includes('--workDir') || !spawnCapture.args.includes(curseForgeRoot)) {
      throw new Error(`Windows start retry did not preserve the CurseForge --workDir handoff: ${JSON.stringify(spawnCapture)}`);
    }
    if (path.resolve(spawnCapture.cwd) !== path.resolve(curseForgeRoot)) {
      throw new Error(`Windows start retry did not run from the CurseForge root cwd: ${JSON.stringify(spawnCapture)}`);
    }
  } else if (expectStoreFallback || expectAppAliasIgnored) {
    if (spawnCaptures.some((capture) => path.resolve(String(capture.command || '')) === path.resolve(curseForgeApp) || capture.kind === 'curseforge-app')) {
      throw new Error(`Play opened CurseForge.exe; AHT must only open Minecraft Launcher routes: ${JSON.stringify(spawnCaptures)}`);
    }
    if (spawnCaptures.some((capture) => capture.source === 'windows-app-alias' || path.resolve(String(capture.command || '')) === path.resolve(appAliasMinecraftLauncher))) {
      throw new Error(`Play opened the fragile WindowsApps MinecraftLauncher.exe alias instead of the Store route: ${JSON.stringify(spawnCaptures)}`);
    }
    if (!spawnCapture || spawnCapture.kind !== 'store') {
      throw new Error(`Play did not use the Store Minecraft Launcher fallback when no desktop Minecraft Launcher exists: ${JSON.stringify(spawnCaptures)}`);
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
    const expectedMinecraftLauncher = expectLocalAppDataLauncher
      ? localAppDataMinecraftLauncher
      : (expectShortcutLauncher || expectGenericShortcutLauncher)
        ? shortcutMinecraftLauncher
        : desktopMinecraftLauncher;
    if (!spawnCapture || spawnCapture.kind !== 'curseforge' || path.resolve(spawnCapture.command) !== path.resolve(expectedMinecraftLauncher)) {
      throw new Error(`Play did not open the Minecraft Launcher with the CurseForge root first: ${JSON.stringify(spawnCaptures)}`);
    }
    if ((expectShortcutLauncher || expectGenericShortcutLauncher) && spawnCapture.source !== 'shortcut') {
      throw new Error(`Play did not use the discovered Start Menu shortcut route: ${JSON.stringify(spawnCapture)}`);
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
    const assetObject = path.join(rootDir, 'assets', 'objects', assetHash.slice(0, 2), assetHash);
    if (fs.existsSync(assetObject)) {
      throw new Error(`Play should not block on asset-object repair in ${rootDir}.`);
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
    expectStoreFallback,
    expectCustomFallback,
    expectCurseForgeAuthImport,
    expectLocalAppDataLauncher,
    expectShortcutLauncher,
    expectGenericShortcutLauncher,
    requests: assetRequests,
    spawnCapture
  }, null, 2));
  }
} finally {
  try {
    client?.close?.();
  } catch {}
  server.close();
  if (!child.killed) {
    child.kill();
  }
}
