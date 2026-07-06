import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const port = Number(process.argv[2] || 10130);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-player-update-play-'));
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'A Hard Time');
const mcRoot = path.join(root, '.minecraft');
const syncedMcRoot = path.join(root, '.minecraft-synced');
const packZipPath = path.join(root, 'packs', 'a-hard-time-7.7.7-client.zip');
const spawnCapturePath = path.join(root, 'spawn-detached.jsonl');
const fakeProgramFiles = path.join(root, 'program-files');
const fakeLocalAppData = path.join(root, 'localappdata');
const fakeAppData = path.join(root, 'appdata');
const fakeUserProfile = path.join(root, 'profile');
const fakeMinecraftLauncher = path.join(fakeProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe');
const startupProbePath = path.join(root, 'startup-probe.jsonl');
const forgeInstallerUrl = `${workerEndpoint}/forge/forge-1.12.2-14.23.5.2860-installer.jar`;
const versionId = '1.12.2-forge-14.23.5.2860';
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? [`--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function makeResourcePackBuffer() {
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 3, description: 'AHT smoke resource pack' } }, null, 2)));
  zip.addFile('assets/aht/lang/en_us.lang', Buffer.from('aht.smoke=Installed\n'));
  return zip.toBuffer();
}

async function makeClientZip(file) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const zip = new AdmZip();
  const metadata = {
    schemaVersion: 1,
    format: 'aht-full-client-zip',
    packId: 'a-hard-time',
    name: 'A Hard Time',
    version: '7.7.7',
    minecraft: {
      version: '1.12.2',
      modLoaders: [{ id: 'forge-14.23.5.2860', primary: true, installerUrl: forgeInstallerUrl }]
    },
    includedRoots: ['mods', 'resourcepacks', 'config', 'options.txt'],
    missingRoots: [],
    settingsFiles: ['options.txt', 'optionsof.txt']
  };
  zip.addFile('aht-client-pack.json', Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
  zip.addFile('mods/aht-required.jar', Buffer.from('required mod bytes\n'));
  zip.addFile('mods/aht-version-lock-7.7.7.jar', Buffer.from('version lock bytes\n'));
  zip.addFile('resourcepacks/aht-smoke-resourcepack.zip', makeResourcePackBuffer());
  zip.addFile('config/aht-client.cfg', Buffer.from('clientConfig=true\n'));
  zip.addFile('options.txt', Buffer.from('pack-options\n'));
  zip.writeZip(file);
  return await fsp.readFile(file);
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

async function waitForCleanScanUiReset(client, attempts = 60) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await evaluate(client, `
      (() => {
        const badge = document.querySelector('#statusBadge')?.textContent || '';
        const diff = document.querySelector('#diffSummary')?.textContent || '';
        const progressWrap = document.querySelector('#progressWrap');
        const sidebarProgress = document.querySelector('#sidebarProgress');
        const progressHidden = (progressWrap ? progressWrap.hidden === true : true) && sidebarProgress?.hidden === true;
        const progressLabel = document.querySelector('#progressLabel')?.textContent || document.querySelector('#sidebarProgressLabel')?.textContent || '';
        const progressCount = document.querySelector('#progressCount')?.textContent || document.querySelector('#sidebarProgressCount')?.textContent || '';
        const scanDisabled = document.querySelector('#scanButton')?.getAttribute('aria-disabled') === 'true';
        const playDisabled = document.querySelector('#playButton')?.getAttribute('aria-disabled') === 'true';
        return { badge, diff, progressHidden, progressLabel, progressCount, scanDisabled, playDisabled };
      })()
    `);
    if (last.badge === 'Ready' && last.diff === 'Clean' && last.progressHidden && !last.scanDisabled && !last.playDisabled) {
      return last;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for clean scan UI reset after update: ${JSON.stringify(last)}`);
}

const packBuffer = await makeClientZip(packZipPath);
const fullClientLatest = {
  schemaVersion: 1,
  packId: 'a-hard-time',
  name: 'A Hard Time',
  version: '7.7.7',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true, installerUrl: forgeInstallerUrl }]
  },
  zip: {
    fileName: path.basename(packZipPath),
    url: `${workerEndpoint}/packs/${path.basename(packZipPath)}`,
    sha256: sha256(packBuffer),
    size: packBuffer.length
  },
  curseforge: { disabled: true, fileCount: 0 }
};
const legacyLatest = {
  ...fullClientLatest,
  installMode: 'curseforge',
  zipFormat: '',
  curseforge: { disabled: false, fileCount: 2 },
  cacheManifest: { url: `${workerEndpoint}/cache/legacy-cache.json` },
  zip: {
    ...fullClientLatest.zip,
    fileName: 'legacy-curseforge-export.zip',
    url: `${workerEndpoint}/packs/legacy-curseforge-export.zip`
  }
};
let latest = legacyLatest;
const packRequests = [];
const registrationRequests = [];
const proofRequests = [];

await fsp.mkdir(path.dirname(fakeMinecraftLauncher), { recursive: true });
await fsp.writeFile(fakeMinecraftLauncher, 'official Minecraft Launcher placeholder\n', 'utf8');
await writeJson(defaultsPath, {
  packId: 'a-hard-time',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: '', apiKeyEnv: 'CURSEFORGE_API_KEY' },
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
    syncRoots: [syncedMcRoot],
    autoImportAccount: false
  },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
for (const rootDir of [mcRoot, syncedMcRoot]) {
  await writeJson(
    path.join(rootDir, 'versions', '1.12.2', '1.12.2.json'),
    { id: '1.12.2', assetIndex: { id: '1.12', url: `${workerEndpoint}/assets/1.12.json` } }
  );
  await writeJson(
    path.join(rootDir, 'assets', 'indexes', '1.12.json'),
    { objects: {} }
  );
}

const registeredUsers = new Map();
const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(latest));
    return;
  }
  if (url.pathname.startsWith('/packs/')) {
    packRequests.push(url.pathname);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/zip');
    response.end(packBuffer);
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
        response.end(JSON.stringify({ error: 'Invalid username registration.' }));
        return;
      }
      registrationRequests.push({ username, installId });
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
      proofRequests.push(payload);
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
        token: 'player-update-play-proof-token',
        payload,
        signature: { alg: 'HS256', kid: 'smoke', value: 'smoke-signature' }
      }));
    });
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/octet-stream');
  response.end(Buffer.from('fake forge installer'));
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_APP_DEFAULTS: defaultsPath,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_REMOTE_DEBUG_PORT: String(port),
    AHT_TEST_STARTUP_PROBE_PATH: startupProbePath,
    AHT_TEST_SPAWN_DETACHED_CAPTURE_PATH: spawnCapturePath,
    AHT_TEST_FORGE_INSTALLER_SUCCESS: '1',
    AHT_TEST_EXPECT_FORGE_INSTALLER_URL: forgeInstallerUrl,
    AHT_DISABLE_COMMON_MINECRAFT_LAUNCHER_DRIVES: '1',
    ProgramFiles: fakeProgramFiles,
    'ProgramFiles(x86)': fakeProgramFiles,
    ProgramW6432: fakeProgramFiles,
    LOCALAPPDATA: fakeLocalAppData,
    APPDATA: fakeAppData,
    USERPROFILE: fakeUserProfile,
    HOME: fakeUserProfile,
    ELECTRON_ENABLE_LOGGING: '0'
  },
  stdio: 'ignore',
  windowsHide: true
});

let client;
try {
  const target = await waitForTarget().catch((error) => {
    if (fs.existsSync(startupProbePath)) {
      error.message = `${error.message}; startup probe: ${fs.readFileSync(startupProbePath, 'utf8').trim()}`;
    }
    throw error;
  });
  client = await connect(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'player DOM');
  const registration = await evaluate(client, `
    window.aht.accountRegister('FreshPlayer')
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  if (!registration.ok || !registration.result?.ok) {
    throw new Error(`Player registration failed: ${JSON.stringify(registration)}`);
  }
  const blocked = await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '7.7.7' ? status : false)
  `, 'legacy feed blocked status');
  if (!blocked.updateBlockedReason || blocked.updateRequired || blocked.launchReady || !/Update package is not ready/i.test(blocked.launchBlockedReason || '')) {
    throw new Error(`Legacy feed should be blocked before player install: ${JSON.stringify(blocked)}`);
  }
  if (
    /server owner/i.test(`${blocked.updateBlockedReason}\n${blocked.launchBlockedReason}`)
    || !/verified AHT client package/i.test(`${blocked.updateBlockedReason}\n${blocked.launchBlockedReason}`)
  ) {
    throw new Error(`Legacy feed block must use clean verified-package wording: ${JSON.stringify(blocked)}`);
  }
  await waitFor(client, `
    (() => {
      const text = document.querySelector('#statusBadge')?.textContent || '';
      return text === 'Update unavailable' ? text : false;
    })()
  `, 'blocked feed badge');
  const blockedUpdate = await evaluate(client, `
    window.aht.startUpdate({ forceRepair: false, replaceGameSettings: false })
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  if (blockedUpdate.ok || !/Update package is not ready/i.test(blockedUpdate.message || '')) {
    throw new Error(`Legacy feed update should fail with a safe player message: ${JSON.stringify(blockedUpdate)}`);
  }
  if (/server owner/i.test(blockedUpdate.message || '') || !/verified AHT client package/i.test(blockedUpdate.message || '')) {
    throw new Error(`Legacy feed update error must use clean verified-package wording: ${JSON.stringify(blockedUpdate)}`);
  }
  if (packRequests.length) {
    throw new Error(`Legacy feed started downloading pack files before being blocked: ${JSON.stringify(packRequests)}`);
  }

  latest = fullClientLatest;
  registeredUsers.clear();
  const before = await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '7.7.7' && !status.updateBlockedReason ? status : false)
  `, 'fresh player exact ZIP status');
  if (before.installed || !before.updateRequired) {
    throw new Error(`Fresh player should need install before update: ${JSON.stringify(before)}`);
  }

  const updateResult = await evaluate(client, `
    window.aht.startUpdate({ forceRepair: false, replaceGameSettings: false })
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  if (!updateResult.ok || updateResult.result?.installed?.version !== '7.7.7') {
    throw new Error(`Fresh player update failed: ${JSON.stringify(updateResult)}`);
  }
  if (registrationRequests.filter((item) => item.username === 'FreshPlayer').length < 2 || proofRequests.length < 2) {
    throw new Error(`Update did not refresh stale launcher proof registration after Worker rejection: ${JSON.stringify({ registrationRequests, proofRequests: proofRequests.map((item) => ({ username: item.minecraftUsername, installId: item.installId })) })}`);
  }
  const installedFiles = [
    'mods/aht-required.jar',
    'mods/aht-version-lock-7.7.7.jar',
    'resourcepacks/aht-smoke-resourcepack.zip',
    'config/aht-client.cfg'
  ];
  for (const relPath of installedFiles) {
    if (!fs.existsSync(path.join(instanceDir, relPath))) {
      throw new Error(`Expected installed file missing after update: ${relPath}`);
    }
  }
  const forgeVersionJson = path.join(mcRoot, 'versions', versionId, `${versionId}.json`);
  if (!fs.existsSync(forgeVersionJson)) {
    throw new Error(`Forge version JSON missing after update: ${forgeVersionJson}`);
  }
  const syncedForgeVersionJson = path.join(syncedMcRoot, 'versions', versionId, `${versionId}.json`);
  if (!fs.existsSync(syncedForgeVersionJson)) {
    throw new Error(`Forge version JSON missing in synced Minecraft root after update: ${syncedForgeVersionJson}`);
  }
  const forgeVersion = JSON.parse(fs.readFileSync(forgeVersionJson, 'utf8'));
  if (!forgeVersion.ahtTestForgeInstaller) {
    throw new Error(`Forge install hook did not write expected version metadata: ${JSON.stringify(forgeVersion)}`);
  }
  const profiles = JSON.parse(fs.readFileSync(path.join(mcRoot, 'launcher_profiles.json'), 'utf8'));
  const profile = profiles.profiles?.['a-hard-time'];
  if (!profile || profile.lastVersionId !== versionId || path.resolve(profile.gameDir) !== path.resolve(instanceDir)) {
    throw new Error(`Minecraft Launcher profile was not written for the installed instance: ${JSON.stringify(profile)}`);
  }
  if (!profile.javaArgs.includes('-Xmx4096m') || !profile.javaArgs.includes('-Daht.launcher.proofFile=') || !profile.javaArgs.includes('-Dminecraft.applet.TargetDirectory=')) {
    throw new Error(`Minecraft Launcher profile is missing required Java args: ${profile.javaArgs}`);
  }
  const syncedProfiles = JSON.parse(fs.readFileSync(path.join(syncedMcRoot, 'launcher_profiles.json'), 'utf8'));
  const syncedProfile = syncedProfiles.profiles?.['a-hard-time'];
  if (!syncedProfile || syncedProfile.lastVersionId !== versionId || path.resolve(syncedProfile.gameDir) !== path.resolve(instanceDir)) {
    throw new Error(`Synced Minecraft Launcher profile was not written for the installed instance: ${JSON.stringify(syncedProfile)}`);
  }

  const afterUpdate = await evaluate(client, 'window.aht.getStatus()');
  if (!afterUpdate.launchReady || afterUpdate.launchBlockedReason || afterUpdate.integrity?.counts?.corrupted !== 0) {
    throw new Error(`Player stayed launch-locked after clean update: ${JSON.stringify(afterUpdate)}`);
  }

  await evaluate(client, `document.querySelector('#scanButton')?.click(); true`);
  const cleanScanUi = await waitForCleanScanUiReset(client, 60);

  const playResult = await evaluate(client, `
    window.aht.play()
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  if (!playResult.ok || !playResult.result?.ok) {
    throw new Error(`Clean player Play failed: ${JSON.stringify(playResult)}`);
  }
  let spawnCaptures = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    spawnCaptures = await readJsonLines(spawnCapturePath);
    if (spawnCaptures.length) break;
    await sleep(250);
  }
  if (!spawnCaptures.length) {
    throw new Error('Play returned success, but the Minecraft Launcher command was not spawned.');
  }
  const launcherMarker = spawnCaptures.at(-1);
  if (path.resolve(launcherMarker.cwd) !== path.resolve(mcRoot)) {
    throw new Error(`Minecraft Launcher opened with the wrong cwd: ${JSON.stringify(launcherMarker)}`);
  }
  if ((launcherMarker.env?.DISABLE_RTSS_LAYER || launcherMarker.disableRtss) !== '1' || (launcherMarker.env?.DISABLE_VULKAN_OBS_CAPTURE || launcherMarker.disableObs) !== '1') {
    throw new Error(`Minecraft Launcher environment hardening was not applied: ${JSON.stringify(launcherMarker)}`);
  }
  const proof = JSON.parse(fs.readFileSync(path.join(instanceDir, '.aht-launcher', 'launcher-proof.json'), 'utf8'));
  if (!proof.trusted || proof.source !== 'worker' || !Array.isArray(proof.javaProperties) || !proof.javaProperties.some((arg) => arg.startsWith('-Daht.launcher.proofFile='))) {
    throw new Error(`Clean Play did not write trusted launcher proof Java properties: ${JSON.stringify(proof)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    installedVersion: updateResult.result.installed.version,
    forgeInstallerUrl,
    profile: {
      id: 'a-hard-time',
      lastVersionId: profile.lastVersionId,
      gameDir: profile.gameDir,
      syncedRoot: syncedMcRoot
    },
    cleanScanUi,
    launchCommand: playResult.result.command,
    proofSource: proof.source
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
