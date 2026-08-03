import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { writeForgeInstallationFixture } from './helpers/forge-fixture.mjs';
import { writeMinecraftBaseFixture } from './helpers/minecraft-base-fixture.mjs';

const port = Number(process.argv[2] || 10010);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-play-gate-'));
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
const minecraftBaseFixtureDir = path.join(root, 'minecraft-base-fixture');
const fakeLauncherMarker = path.join(root, 'fake-minecraft-launcher.json');
const curseForgeRoot = path.join(root, 'curseforge', 'minecraft', 'Install');
const curseForgeSpawnCapture = path.join(root, 'curseforge-spawn.json');
const minecraftHandoffCapture = path.join(root, 'minecraft-handoff.json');
const windowsProcessStatePath = path.join(root, 'windows-process-state.json');
const fakeJavaHome = path.join(root, 'runtime', 'temurin-8-jre');
const fakeJavaPath = path.join(fakeJavaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const fakeMinecraftJavaPath = process.platform === 'win32'
  ? path.join(path.dirname(fakeJavaPath), 'javaw.exe')
  : fakeJavaPath;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();
await writeMinecraftBaseFixture(minecraftBaseFixtureDir);

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
await fsp.mkdir(path.dirname(fakeJavaPath), { recursive: true });
await fsp.writeFile(fakeJavaPath, 'fake Java 8 executable\n', 'utf8');
if (process.platform === 'win32') {
  await fsp.writeFile(fakeMinecraftJavaPath, 'fake windowless Java 8 executable\n', 'utf8');
}
await fsp.writeFile(path.join(fakeJavaHome, 'release'), 'JAVA_VERSION="1.8.0_999"\n', 'utf8');
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
    memoryMb: 6144,
    javaPath: fakeJavaPath,
    syncDefaultRoots: false,
    openCommand: process.execPath,
    openArgs: ['-e', fakeLauncherScript, fakeLauncherMarker]
  },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), { installId: 'smoke-install' });
await writeJson(windowsProcessStatePath, {
  currentSessionId: 7,
  nextPid: 62000,
  packageRoots: [],
  records: [{
    pid: 41001,
    image: 'minecraft.exe',
    path: path.join(curseForgeRoot, 'minecraft.exe'),
    sessionId: 7,
    startTimeUtc: '2026-08-03T12:00:00.000Z',
    mainWindowHandle: 51001,
    mainWindowTitle: 'Minecraft Launcher',
    responding: true,
    windowVisible: true,
    windowMinimized: false,
    foreground: false
  }, {
    pid: 41002,
    image: 'javaw.exe',
    path: path.join(root, 'active-game', 'javaw.exe'),
    sessionId: 7,
    mainWindowHandle: 0,
    mainWindowTitle: '',
    responding: true
  }]
});
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
await writeForgeInstallationFixture(mcRoot, { versionId: '1.12.2-forge-14.23.5.2860' });

const registeredUsers = new Map();
let launcherProofRequests = 0;
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
    launcherProofRequests += 1;
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
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '0',
    AHT_APP_DEFAULTS: defaultsPath,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_ALLOW_MINECRAFT_OPEN_COMMAND: '1',
    AHT_TEST_WINDOWS_PROCESS_STATE_PATH: windowsProcessStatePath,
    AHT_TEST_MINECRAFT_HANDOFF_CAPTURE_PATH: minecraftHandoffCapture,
    AHT_TEST_CURSEFORGE_MINECRAFT_ROOT: curseForgeRoot,
    AHT_TEST_JAVA_RUNTIME_PROBE: 'release-file',
    AHT_TEST_JAVA_ARCH: 'amd64',
    AHT_TEST_MINECRAFT_BASE_FIXTURE_DIR: minecraftBaseFixtureDir,
    AHT_TEST_MINECRAFT_SPAWN_CAPTURE_PATH: curseForgeSpawnCapture
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
  if (!persistedIntegrity.fingerprint?.digest || persistedIntegrity.checkMode !== 'full-hash') {
    throw new Error(`Full Play integrity scan did not establish a fingerprint: ${JSON.stringify(persistedIntegrity)}`);
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
  const cleanProfiles = JSON.parse(fs.readFileSync(path.join(mcRoot, 'launcher_profiles.json'), 'utf8'));
  const cleanProfile = cleanProfiles.profiles?.['a-hard-time-dregora'];
  const detectedJavaPath = cleanStatus.java8Runtime?.path || '';
  const expectedProfileJavaPath = process.platform === 'win32' && path.basename(detectedJavaPath).toLowerCase() === 'java.exe'
    ? path.join(path.dirname(detectedJavaPath), 'javaw.exe')
    : detectedJavaPath;
  if (
    !cleanStatus.java8Runtime?.usable
    || !cleanProfile?.javaArgs?.includes('-Xmx6144m')
    || path.resolve(cleanProfile.javaDir || '') !== path.resolve(expectedProfileJavaPath)
  ) {
    throw new Error(`Clean Play did not write the 6 GB and Java 8 launcher profile: ${JSON.stringify(cleanProfile)}`);
  }
  const proof = JSON.parse(fs.readFileSync(path.join(instanceDir, '.aht-launcher', 'launcher-proof.json'), 'utf8'));
  if (!proof.trusted || proof.source !== 'worker' || !Array.isArray(proof.javaProperties) || !proof.javaProperties.some((arg) => arg.startsWith('-Daht.launcher.proofFile='))) {
    throw new Error(`Clean Play did not write trusted launcher proof Java properties: ${JSON.stringify(proof)}`);
  }

  let curseForgePlayResult = null;
  if (process.platform === 'win32') {
    const routeConfigPath = path.join(userData, 'launcher.config.json');
    const routeConfig = JSON.parse(fs.readFileSync(routeConfigPath, 'utf8'));
    delete routeConfig.minecraftLauncher.openCommand;
    delete routeConfig.minecraftLauncher.openArgs;
    routeConfig.minecraftLauncher.syncDefaultRoots = false;
    await writeJson(routeConfigPath, routeConfig);
    await fsp.cp(mcRoot, curseForgeRoot, { recursive: true });
    await fsp.writeFile(path.join(curseForgeRoot, 'minecraft.exe'), 'test launcher placeholder', 'utf8');
    const competingProfilesPath = path.join(curseForgeRoot, 'launcher_profiles.json');
    const competingProfiles = JSON.parse(fs.readFileSync(competingProfilesPath, 'utf8'));
    competingProfiles.version = 3;
    competingProfiles.selectedProfile = 'random-profile';
    competingProfiles.profiles['random-profile'] = {
      name: 'Random Instance',
      type: 'custom',
      gameDir: path.join(root, 'random-instance'),
      lastUsed: new Date(Date.now() - 60_000).toISOString()
    };
    competingProfiles.profiles['a-hard-time'] = {
      name: 'A Hard Time',
      type: 'custom',
      gameDir: instanceDir,
      lastUsed: '2026-01-01T00:00:00.000Z'
    };
    await writeJson(competingProfilesPath, competingProfiles);
    const launcherUiPreamble = '#$\nMinecraft Launcher internal state\n$#\n';
    await fsp.writeFile(path.join(curseForgeRoot, 'launcher_ui_state.json'), `${launcherUiPreamble}${JSON.stringify({
      data: { UiSettings: JSON.stringify({ lastVisitedPage: 'realms' }) },
      formatVersion: 1
    }, null, 2)}\n`, 'utf8');
    await fsp.rm(curseForgeSpawnCapture, { force: true });

    const curseForgePlayStartedAt = Date.now();
    const immediatePlayUi = await evaluate(client, `(() => {
      const button = document.querySelector('#playButton');
      button.click();
      button.click();
      return {
        text: button.textContent.trim(),
        ariaBusy: button.getAttribute('aria-busy'),
        ariaDisabled: button.getAttribute('aria-disabled'),
        title: button.title
      };
    })()`);
    if (
      immediatePlayUi.text !== 'Preparing...'
      || immediatePlayUi.ariaBusy !== 'true'
      || immediatePlayUi.ariaDisabled !== 'true'
      || !/exact Minecraft Launcher profile/i.test(immediatePlayUi.title || '')
    ) {
      throw new Error(`Play click did not enter the immediate single-flight Preparing state: ${JSON.stringify(immediatePlayUi)}`);
    }
    const completedPlayUi = await waitFor(client, `(() => {
      const button = document.querySelector('#playButton');
      const success = [...document.querySelectorAll('#toastStack .toast.success')]
        .find((toast) => /Minecraft Launcher opened/i.test(toast.textContent) && /A Hard Time is prepared for launch/i.test(toast.textContent));
      return button.getAttribute('aria-busy') === 'false'
        && button.getAttribute('aria-disabled') === 'false'
        && button.textContent.trim() === 'Play'
        && success
        ? {
            text: button.textContent.trim(),
            ariaBusy: button.getAttribute('aria-busy'),
            ariaDisabled: button.getAttribute('aria-disabled'),
            toast: success.textContent.trim()
          }
        : false;
    })()`, 'completed Play click');
    const curseForgePlayDurationMs = Date.now() - curseForgePlayStartedAt;
    if (curseForgePlayDurationMs >= 5000) {
      throw new Error(`Prepared CurseForge Play took too long (${curseForgePlayDurationMs}ms).`);
    }
    if (launcherProofRequests !== 1) {
      throw new Error(`Prepared Play requested another launcher proof instead of reusing the valid proof (${launcherProofRequests} requests).`);
    }
    const spawnCapture = JSON.parse(fs.readFileSync(curseForgeSpawnCapture, 'utf8'));
    curseForgePlayResult = {
      ok: true,
      result: {
        ok: true,
        command: spawnCapture.command,
        kind: 'curseforge',
        activationConfirmed: true,
        launcherHandoff: { restartedExisting: fs.existsSync(minecraftHandoffCapture) }
      },
      ui: completedPlayUi
    };
    if (path.resolve(spawnCapture.command) !== path.resolve(curseForgeRoot, 'minecraft.exe')) {
      throw new Error(`Play launched the wrong Minecraft executable: ${JSON.stringify(spawnCapture)}`);
    }
    if (JSON.stringify(spawnCapture.args) !== JSON.stringify(['--workDir', curseForgeRoot]) || path.resolve(spawnCapture.cwd) !== path.resolve(curseForgeRoot)) {
      throw new Error(`Play did not use the CurseForge storage root: ${JSON.stringify(spawnCapture)}`);
    }
    if (spawnCapture.windowsHide !== false) {
      throw new Error(`Play hid the directly spawned Minecraft Launcher GUI: ${JSON.stringify(spawnCapture)}`);
    }
    if (spawnCapture.captureCount !== 1) {
      throw new Error(`Play spawned the Minecraft Launcher more than once: ${JSON.stringify(spawnCapture)}`);
    }
    const curseForgeProfiles = JSON.parse(fs.readFileSync(path.join(curseForgeRoot, 'launcher_profiles.json'), 'utf8'));
    const curseForgeProfile = curseForgeProfiles.profiles?.['a-hard-time-dregora'];
    if (!curseForgeProfile || path.resolve(curseForgeProfile.gameDir) !== path.resolve(instanceDir)) {
      throw new Error(`AHT profile was not synchronized into CurseForge: ${JSON.stringify(curseForgeProfile)}`);
    }
    if (
      !fs.existsSync(minecraftHandoffCapture)
    ) {
      throw new Error(`Play did not close the existing launcher and confirm the cold handoff: ${JSON.stringify(curseForgePlayResult)}`);
    }
    const profileKeys = Object.keys(curseForgeProfiles.profiles || {});
    if (
      profileKeys.at(-1) !== 'a-hard-time-dregora'
      || curseForgeProfiles.profiles['a-hard-time']
      || curseForgeProfiles.selectedProfile !== 'random-profile'
      || Date.parse(curseForgeProfile.lastUsed) <= Date.parse(curseForgeProfiles.profiles['random-profile'].lastUsed)
    ) {
      throw new Error(`Play did not prepare the exact canonical profile over a competing selection: ${JSON.stringify(curseForgeProfiles)}`);
    }
    const handoff = JSON.parse(fs.readFileSync(minecraftHandoffCapture, 'utf8'));
    const processState = JSON.parse(fs.readFileSync(windowsProcessStatePath, 'utf8'));
    if (
      JSON.stringify(handoff.taskkillArgs) !== JSON.stringify([['/PID', '41001']])
      || JSON.stringify(handoff.terminatedPids) !== JSON.stringify([41001])
      || !processState.records.some((record) => record.pid === 41002 && record.image === 'javaw.exe')
      || processState.records.some((record) => record.pid === 41001)
      || !processState.records.some((record) => record.image === 'minecraft.exe' && record.mainWindowHandle > 0)
    ) {
      throw new Error(`PID-scoped handoff did not preserve the active Java game and confirm a visible launcher: ${JSON.stringify({ handoff, processState })}`);
    }
    const launcherUiStateRaw = fs.readFileSync(path.join(curseForgeRoot, 'launcher_ui_state.json'), 'utf8');
    const launcherUiState = JSON.parse(launcherUiStateRaw.slice(launcherUiStateRaw.indexOf('{')));
    const launcherUiSettings = JSON.parse(launcherUiState.data.UiSettings);
    if (launcherUiSettings.lastVisitedPage !== 'home' || !launcherUiStateRaw.startsWith(launcherUiPreamble)) {
      throw new Error(`Play did not prepare Minecraft Launcher Home safely: ${launcherUiStateRaw}`);
    }
    const fastIntegrity = await evaluate(client, 'window.aht.getStatus().then((status) => status.integrity)');
    if (fastIntegrity?.checkMode !== 'fingerprint' || !fastIntegrity?.quickCheckedAt) {
      throw new Error(`Prepared Play did not use the verified fingerprint path: ${JSON.stringify(fastIntegrity)}`);
    }
    const retryUi = await evaluate(client, `(() => {
      const button = document.querySelector('#playButton');
      button.click();
      return { text: button.textContent.trim(), ariaBusy: button.getAttribute('aria-busy') };
    })()`);
    if (retryUi.text !== 'Preparing...' || retryUi.ariaBusy !== 'true') {
      throw new Error(`A later legitimate Play click did not start after single-flight completion: ${JSON.stringify(retryUi)}`);
    }
    await waitFor(client, `(() => {
      const button = document.querySelector('#playButton');
      return button.getAttribute('aria-busy') === 'false'
        && button.getAttribute('aria-disabled') === 'false'
        && button.textContent.trim() === 'Play';
    })()`, 'completed Play retry');
    const retryCapture = JSON.parse(fs.readFileSync(curseForgeSpawnCapture, 'utf8'));
    if (retryCapture.captureCount !== 2) {
      throw new Error(`A later legitimate Play click did not spawn exactly one more launcher: ${JSON.stringify(retryCapture)}`);
    }
    curseForgePlayResult.durationMs = curseForgePlayDurationMs;
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    blockedPlayResult: playResult,
    cleanPlayResult,
    blockedReason: after.launchBlockedReason,
    cleanLaunchCommand: cleanPlayResult.result.command,
    curseForgeLaunchCommand: curseForgePlayResult?.result?.command || '',
    curseForgeLaunchKind: curseForgePlayResult?.result?.kind || '',
    curseForgePlayDurationMs: curseForgePlayResult?.durationMs || 0,
    launcherProofRequests,
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
