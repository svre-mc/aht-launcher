import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { workerLauncherProofFixture } from './helpers/launcher-proof-fixture.mjs';
import { writeMinecraftBaseFixture } from './helpers/minecraft-base-fixture.mjs';

const port = Number(process.argv[2] || 10130);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-player-update-play-'));
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'A Hard Time');
const ptbInstanceDir = path.join(root, 'A Hard Time PTB');
const mcRoot = path.join(root, '.minecraft');
const syncedMcRoot = path.join(root, '.minecraft-synced');
const minecraftBaseFixtureDir = path.join(root, 'minecraft-base-fixture');
const packZipPath = path.join(root, 'packs', 'a-hard-time-7.7.7-client.zip');
const fakeLauncherMarker = path.join(root, 'fake-minecraft-launcher.json');
const startupProbePath = path.join(root, 'startup-probe.jsonl');
const forgeInstallerUrl = `${workerEndpoint}/forge/forge-1.12.2-14.23.5.2860-installer.jar`;
const versionId = '1.12.2-forge-14.23.5.2860';
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
  ? [`--user-data-dir=${userData}`]
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

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function launchReportsFor(instancePath) {
  const directory = path.join(instancePath, 'logs', 'launcher');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^AHT-Launch-.*\.txt$/i.test(name))
    .sort()
    .map((name) => ({
      name,
      text: fs.readFileSync(path.join(directory, name), 'utf8')
    }));
}

async function waitForLaunchReports(instancePath, count, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let reports = [];
  do {
    reports = launchReportsFor(instancePath).filter((report) => report.text.length > 0);
    if (reports.length >= count) return reports;
    await sleep(50);
  } while (Date.now() < deadline);
  return reports;
}

function makeResourcePackBuffer() {
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 3, description: 'AHT smoke resource pack' } }, null, 2)));
  zip.addFile('assets/aht/lang/en_us.lang', Buffer.from('aht.smoke=Installed\n'));
  return zip.toBuffer();
}
const resourcePackBuffer = makeResourcePackBuffer();

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
  zip.addFile('resourcepacks/aht-smoke-resourcepack.zip', resourcePackBuffer);
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
        const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        const page = pages.find((target) => /(?:^|\/)index\.html(?:[?#]|$)/i.test(String(target.url || '')));
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
      (async () => {
        const badge = document.querySelector('#statusBadge')?.textContent || '';
        const diff = document.querySelector('#diffSummary')?.textContent || '';
        const progressWrap = document.querySelector('#progressWrap');
        const sidebarProgress = document.querySelector('#sidebarProgress');
        const progressHidden = (progressWrap ? progressWrap.hidden === true : true) && sidebarProgress?.hidden === true;
        const progressLabel = document.querySelector('#progressLabel')?.textContent || document.querySelector('#sidebarProgressLabel')?.textContent || '';
        const progressCount = document.querySelector('#progressCount')?.textContent || document.querySelector('#sidebarProgressCount')?.textContent || '';
        const scanDisabled = document.querySelector('#scanButton')?.getAttribute('aria-disabled') === 'true';
        const playDisabled = document.querySelector('#playButton')?.getAttribute('aria-disabled') === 'true';
        const status = await window.aht.getStatus();
        return { badge, diff, progressHidden, progressLabel, progressCount, scanDisabled, playDisabled, launchPreparationState: status.launchPreparationState, launchBlockedReason: status.launchBlockedReason };
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
const clientManifest = {
  format: 'aht-client-manifest-v1',
  packId: 'a-hard-time',
  version: '7.7.7',
  files: [{
    relativePath: 'mods/aht-required.jar',
    size: Buffer.byteLength('required mod bytes\n'),
    sha256: sha256('required mod bytes\n')
  }, {
    relativePath: 'mods/aht-version-lock-7.7.7.jar',
    size: Buffer.byteLength('version lock bytes\n'),
    sha256: sha256('version lock bytes\n')
  }, {
    relativePath: 'resourcepacks/aht-smoke-resourcepack.zip',
    size: resourcePackBuffer.length,
    sha256: sha256(resourcePackBuffer)
  }, {
    relativePath: 'config/aht-client.cfg',
    size: Buffer.byteLength('clientConfig=true\n'),
    sha256: sha256('clientConfig=true\n')
  }]
};
const clientManifestBody = JSON.stringify(clientManifest);
const ptbClientManifestBody = JSON.stringify({ ...clientManifest, packId: 'a-hard-time-ptb' });
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
  clientManifest: {
    format: 'aht-client-manifest-v1',
    url: 'client-manifest.json',
    sha256: sha256(clientManifestBody),
    size: Buffer.byteLength(clientManifestBody)
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
const ptbLatest = {
  ...fullClientLatest,
  packId: 'a-hard-time-ptb',
  name: 'A Hard Time PTB',
  channel: 'ptb',
  clientManifest: {
    format: 'aht-client-manifest-v1',
    url: 'client-manifest.json',
    sha256: sha256(ptbClientManifestBody),
    size: Buffer.byteLength(ptbClientManifestBody)
  }
};
let latest = legacyLatest;
const packRequests = [];
const registrationRequests = [];
const proofRequests = [];

const fakeLauncherScript = 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), disableRtss: process.env.DISABLE_RTSS_LAYER || "", disableObs: process.env.DISABLE_VULKAN_OBS_CAPTURE || "" }, null, 2))';
await fsp.mkdir(path.dirname(fakeJavaPath), { recursive: true });
await fsp.writeFile(fakeJavaPath, 'fake Java 8 executable\n', 'utf8');
if (process.platform === 'win32') {
  await fsp.writeFile(fakeMinecraftJavaPath, 'fake windowless Java 8 executable\n', 'utf8');
}
await fsp.writeFile(path.join(fakeJavaHome, 'release'), 'JAVA_VERSION="1.8.0_999"\n', 'utf8');
await writeJson(defaultsPath, {
  packId: 'a-hard-time',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: '', apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-attestation-v2' },
  launcherUpdate: { enabled: false, latestUrl: '' },
  packs: {
    ptb: {
      instanceDir: ptbInstanceDir,
      latestUrl: `${workerEndpoint}/ptb/latest.json`
    }
  },
  minecraftLauncher: {
    enabled: true,
    rootDir: mcRoot,
    profileId: 'a-hard-time',
    profileName: 'A Hard Time',
    memoryMb: 6144,
    javaPath: fakeJavaPath,
    syncRoots: [syncedMcRoot],
    syncDefaultRoots: false,
    autoImportAccount: false,
    openCommand: process.execPath,
    openArgs: ['-e', fakeLauncherScript, fakeLauncherMarker]
  },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'fresh-player-install',
  createdAt: new Date().toISOString(),
  minecraftUsername: 'FreshPlayer',
  usernameRegisteredAt: new Date().toISOString(),
  usernameRegistrationMode: 'minecraft-launcher'
});
await writeJson(path.join(mcRoot, 'versions', versionId, `${versionId}.json`), {});
await writeJson(path.join(syncedMcRoot, 'versions', versionId, `${versionId}.json`), {});

const registeredUsers = new Map();
const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(latest));
    return;
  }
  if (url.pathname === '/ptb/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(ptbLatest));
    return;
  }
  if (url.pathname === '/client-manifest.json' || url.pathname === '/ptb/client-manifest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(url.pathname.startsWith('/ptb/') ? ptbClientManifestBody : clientManifestBody);
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
      response.end(JSON.stringify(workerLauncherProofFixture(payload, { signature: 'smoke-signature' })));
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
    AHT_TEST_USER_DATA: userData,
    AHT_TEST_ALLOW_MINECRAFT_OPEN_COMMAND: '1',
    AHT_TEST_REMOTE_DEBUG_PORT: String(port),
    AHT_TEST_STARTUP_PROBE_PATH: startupProbePath,
    AHT_TEST_FORGE_INSTALLER_SUCCESS: '1',
    AHT_TEST_EXPECT_FORGE_INSTALLER_URL: forgeInstallerUrl,
    AHT_TEST_JAVA_RUNTIME_PROBE: 'release-file',
    AHT_TEST_JAVA_ARCH: 'amd64',
    AHT_TEST_MINECRAFT_BASE_FIXTURE_DIR: minecraftBaseFixtureDir,
    ELECTRON_ENABLE_LOGGING: '0'
  },
  stdio: 'ignore',
  windowsHide: true
});
const childExitPromise = new Promise((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }));
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
  await waitFor(client, "document.readyState === 'complete' && Boolean(window.aht)", 'player DOM');
  const usernameSurfaceAbsent = await evaluate(client, `
    !document.querySelector('#accountOverlay')
      && !document.querySelector('#minecraftUsernameInput')
      && !document.querySelector('#playerLabelInput')
      && typeof window.aht.accountRegister === 'undefined'
  `);
  if (!usernameSurfaceAbsent) {
    throw new Error('The player update/play flow exposed a manual username control or API.');
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

  await evaluate(client, `refresh().then(() => true)`);
  await waitFor(client, `(() => {
    const button = document.querySelector('#playButton');
    return button
      && button.dataset.actionMode === 'install'
      && button.textContent.trim() === 'Install'
      && button.classList.contains('is-install-action')
      && !button.classList.contains('is-update-action')
      && !button.disabled
      && button.getAttribute('aria-disabled') !== 'true';
  })()`, 'fresh player primary Install action');
  const firstInstallPromptProof = await evaluate(client, `(() => {
    const overlay = document.querySelector('#updateOptionsOverlay');
    const button = document.querySelector('#playButton');
    const beforeHidden = overlay?.hidden === true;
    button?.click();
    return {
      beforeHidden,
      afterHidden: overlay?.hidden === true,
      settingsPresent: ${JSON.stringify(Boolean(before.setup?.gameSettingsPresent))}
    };
  })()`);
  if (!firstInstallPromptProof.beforeHidden || !firstInstallPromptProof.afterHidden || firstInstallPromptProof.settingsPresent) {
    throw new Error(`First-ever install incorrectly opened the keep-settings prompt: ${JSON.stringify(firstInstallPromptProof)}`);
  }
  const updateResult = await waitFor(client, `
    Promise.all([window.aht.getUpdateState(), window.aht.getStatus()]).then(([update, status]) =>
      !update.running && update.error
        ? ({ ok: false, error: update.error, result: update.lastResult })
        : (!update.running
          && update.lastResult?.installed?.version === '7.7.7'
          && status.installed?.version === '7.7.7'
          ? ({ ok: true, result: update.lastResult })
          : false))
  `, 'fresh player UI update transaction without settings prompt', 480);
  if (!updateResult.ok || updateResult.result?.installed?.version !== '7.7.7') {
    throw new Error(`Fresh player update failed: ${JSON.stringify(updateResult)}`);
  }
  await waitFor(client, `window.aht.getStatus().then((status) =>
    status.installed?.version === '7.7.7'
      && status.launchPreparationState === 'ready'
      && status.launchReady
      ? status
      : false
  )`, 'post-update startup-equivalent launch preparation');
  if (registrationRequests.filter((item) => item.username === 'FreshPlayer').length < 1 || proofRequests.length < 2) {
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
  const invalidForgeBackups = (await fsp.readdir(path.dirname(forgeVersionJson)))
    .filter((name) => name.includes(`${versionId}.json.aht-invalid-`) && name.endsWith('.bak'));
  if (!invalidForgeBackups.length) {
    throw new Error('Invalid placeholder Forge metadata was not backed up before repair.');
  }
  const profiles = JSON.parse(fs.readFileSync(path.join(mcRoot, 'launcher_profiles.json'), 'utf8'));
  const profile = profiles.profiles?.['a-hard-time-dregora'];
  if (!profile || profile.lastVersionId !== versionId || path.resolve(profile.gameDir) !== path.resolve(instanceDir)) {
    throw new Error(`Minecraft Launcher profile was not written for the installed instance: ${JSON.stringify(profile)}`);
  }
  if (!profile.javaArgs.includes('-Xmx6144m') || !profile.javaArgs.includes('-Daht.launcher.proofFile=') || !profile.javaArgs.includes('-Dminecraft.applet.TargetDirectory=')) {
    throw new Error(`Minecraft Launcher profile is missing required Java args: ${profile.javaArgs}`);
  }
  if (path.resolve(profile.javaDir || '') !== path.resolve(fakeMinecraftJavaPath)) {
    throw new Error(`Minecraft Launcher profile did not pin Java 8: ${JSON.stringify(profile)}`);
  }
  const syncedProfiles = JSON.parse(fs.readFileSync(path.join(syncedMcRoot, 'launcher_profiles.json'), 'utf8'));
  const syncedProfile = syncedProfiles.profiles?.['a-hard-time-dregora'];
  if (!syncedProfile || syncedProfile.lastVersionId !== versionId || path.resolve(syncedProfile.gameDir) !== path.resolve(instanceDir)) {
    throw new Error(`Synced Minecraft Launcher profile was not written for the installed instance: ${JSON.stringify(syncedProfile)}`);
  }
  if (path.resolve(syncedProfile.javaDir || '') !== path.resolve(fakeMinecraftJavaPath)) {
    throw new Error(`Synced Minecraft Launcher profile did not pin Java 8: ${JSON.stringify(syncedProfile)}`);
  }

  const afterUpdate = await evaluate(client, 'window.aht.getStatus()');
  if (!afterUpdate.launchReady || afterUpdate.launchBlockedReason || afterUpdate.integrity?.counts?.corrupted !== 0) {
    throw new Error(`Player stayed launch-locked after clean update: ${JSON.stringify(afterUpdate)}`);
  }
  const instanceStateKey = crypto.createHash('sha256')
    .update(path.resolve(instanceDir))
    .digest('hex')
    .slice(0, 24);
  const instanceStateDir = path.join(userData, 'instance-state', instanceStateKey);
  const externalManagedState = path.join(instanceStateDir, 'managed-files.json');
  const externalIntegrityState = path.join(instanceStateDir, 'integrity.json');
  const legacyManagedState = path.join(instanceDir, '.aht-launcher', 'managed-files.json');
  const legacyIntegrityState = path.join(instanceDir, '.aht-launcher', 'integrity.json');
  if (!fs.existsSync(externalManagedState) || !fs.existsSync(externalIntegrityState)) {
    throw new Error(`Launcher-owned security state was not written outside the game instance: ${JSON.stringify({ externalManagedState, externalIntegrityState })}`);
  }
  if (fs.existsSync(legacyManagedState) || fs.existsSync(legacyIntegrityState)) {
    throw new Error(`Legacy security state remained in the player-visible game instance: ${JSON.stringify({ legacyManagedState, legacyIntegrityState })}`);
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
  for (let attempt = 0; attempt < 40 && !fs.existsSync(fakeLauncherMarker); attempt += 1) {
    await sleep(250);
  }
  if (!fs.existsSync(fakeLauncherMarker)) {
    throw new Error('Play returned success, but the Minecraft Launcher command was not spawned.');
  }
  const launcherMarker = JSON.parse(fs.readFileSync(fakeLauncherMarker, 'utf8'));
  if (path.resolve(launcherMarker.cwd) !== path.resolve(mcRoot)) {
    throw new Error(`Minecraft Launcher opened with the wrong cwd: ${JSON.stringify(launcherMarker)}`);
  }
  if (launcherMarker.disableRtss !== '1' || launcherMarker.disableObs !== '1') {
    throw new Error(`Minecraft Launcher environment hardening was not applied: ${JSON.stringify(launcherMarker)}`);
  }
  const proof = JSON.parse(fs.readFileSync(path.join(userData, '.aht-launcher', 'launcher-proof.json'), 'utf8'));
  if (!proof.trusted || proof.source !== 'worker' || !Array.isArray(proof.javaProperties) || !proof.javaProperties.some((arg) => arg.startsWith('-Daht.launcher.proofFile='))) {
    throw new Error(`Clean Play did not write trusted launcher proof Java properties: ${JSON.stringify(proof)}`);
  }
  if (fs.existsSync(path.join(instanceDir, '.aht-launcher', 'launcher-proof.json'))) {
    throw new Error('A pack-local launcher-proof.json compatibility mirror was written for the player instance.');
  }
  const stableReportsAfterFirstPlay = await waitForLaunchReports(instanceDir, 1);
  if (
    stableReportsAfterFirstPlay.length !== 1
    || !stableReportsAfterFirstPlay[0].text.includes('Result: HANDOFF CONFIRMED')
    || !stableReportsAfterFirstPlay[0].text.includes('Pack: A Hard Time 7.7.7 (stable)')
    || !stableReportsAfterFirstPlay[0].text.includes(`Instance: ${instanceDir}`)
  ) {
    throw new Error(`Stable Play did not write one exact-instance professional launch report: ${JSON.stringify(stableReportsAfterFirstPlay)}`);
  }

  const stableAfterFirstPlay = JSON.parse(fs.readFileSync(path.join(mcRoot, 'launcher_profiles.json'), 'utf8'));
  const stableFirstLastUsed = stableAfterFirstPlay.profiles?.['a-hard-time-dregora']?.lastUsed;
  await fsp.cp(instanceDir, ptbInstanceDir, { recursive: true });
  await fsp.rm(path.join(ptbInstanceDir, 'logs', 'launcher'), { recursive: true, force: true });
  const ptbInstalledPath = path.join(ptbInstanceDir, '.aht-launcher', 'installed.json');
  const ptbInstalled = JSON.parse(fs.readFileSync(ptbInstalledPath, 'utf8'));
  ptbInstalled.packId = 'a-hard-time-ptb';
  ptbInstalled.name = 'A Hard Time PTB';
  await writeJson(ptbInstalledPath, ptbInstalled);
  const seededPtbPreparation = await evaluate(client, `window.aht.preparePlay('ptb', { force: true })`);
  if (!seededPtbPreparation?.launchReady || seededPtbPreparation?.launchPreparationState !== 'ready') {
    throw new Error(`The dynamically seeded PTB fixture could not be prepared before its sidebar click: ${JSON.stringify(seededPtbPreparation)}`);
  }

  await fsp.rm(fakeLauncherMarker, { force: true });
  await evaluate(client, `document.querySelector('#ptbTileButton')?.click(); true`);
  await waitFor(client, `window.aht.getStatus('ptb').then((status) =>
    document.querySelector('#ptbTileButton')?.classList.contains('active')
      && !document.querySelector('.workspace')?.classList.contains('is-sidebar-switching')
      && document.querySelector('#playButton')?.getAttribute('aria-disabled') === 'false'
      && document.querySelector('#playButton')?.dataset.actionMode === 'play'
      && status.launchReady
      && status.launchPreparationState === 'ready'
      && status.config?.minecraftLauncher?.profileId === 'a-hard-time-ptb'
  )`, 'installed PTB tile readiness');
  const ptbClickState = await evaluate(client, `(() => {
    const button = document.querySelector('#playButton');
    button.click();
    return { text: button.textContent.trim(), ariaBusy: button.getAttribute('aria-busy') };
  })()`);
  if (ptbClickState.text !== 'Opening...' || ptbClickState.ariaBusy !== 'true') {
    throw new Error(`Installed PTB tile did not route Play through the busy button path: ${JSON.stringify(ptbClickState)}`);
  }
  for (let attempt = 0; attempt < 80 && !fs.existsSync(fakeLauncherMarker); attempt += 1) {
    await sleep(250);
  }
  if (!fs.existsSync(fakeLauncherMarker)) {
    throw new Error('Installed PTB tile Play did not spawn the configured Minecraft Launcher command.');
  }
  await waitFor(client, `document.querySelector('#playButton')?.getAttribute('aria-busy') === 'false'
    && document.querySelector('#playButton')?.getAttribute('aria-disabled') === 'false'`, 'installed PTB Play completion');
  const afterPtbProfiles = JSON.parse(fs.readFileSync(path.join(mcRoot, 'launcher_profiles.json'), 'utf8'));
  const syncedAfterPtbProfiles = JSON.parse(fs.readFileSync(path.join(syncedMcRoot, 'launcher_profiles.json'), 'utf8'));
  const ptbProfile = afterPtbProfiles.profiles?.['a-hard-time-ptb'];
  const syncedPtbProfile = syncedAfterPtbProfiles.profiles?.['a-hard-time-ptb'];
  if (
    Object.keys(afterPtbProfiles.profiles || {}).at(-1) !== 'a-hard-time-ptb'
    || path.resolve(ptbProfile?.gameDir || '') !== path.resolve(ptbInstanceDir)
    || path.resolve(ptbProfile?.javaDir || '') !== path.resolve(fakeMinecraftJavaPath)
    || Date.parse(ptbProfile?.lastUsed || '') <= Date.parse(stableFirstLastUsed || '')
    || Object.keys(syncedAfterPtbProfiles.profiles || {}).at(-1) !== 'a-hard-time-ptb'
    || path.resolve(syncedPtbProfile?.gameDir || '') !== path.resolve(ptbInstanceDir)
    || path.resolve(syncedPtbProfile?.javaDir || '') !== path.resolve(fakeMinecraftJavaPath)
  ) {
    throw new Error(`Installed PTB Play did not prepare every launcher root with the exact PTB instance and Java: ${JSON.stringify({ afterPtbProfiles, syncedAfterPtbProfiles })}`);
  }
  const ptbReportsAfterPlay = await waitForLaunchReports(ptbInstanceDir, 1);
  if (
    ptbReportsAfterPlay.length !== 1
    || !ptbReportsAfterPlay[0].text.includes('Result: HANDOFF CONFIRMED')
    || !ptbReportsAfterPlay[0].text.includes('Pack: A Hard Time PTB 7.7.7 (ptb)')
    || !ptbReportsAfterPlay[0].text.includes(`Instance: ${ptbInstanceDir}`)
    || launchReportsFor(instanceDir).length !== 1
  ) {
    throw new Error(`PTB Play launch report was not isolated to the exact PTB instance: ${JSON.stringify({ stable: launchReportsFor(instanceDir), ptb: ptbReportsAfterPlay })}`);
  }

  const ptbPreparationBeforeSettings = await evaluate(client, `window.aht.getStatus('ptb', { preferCache: true })`);
  await evaluate(client, `(() => {
    for (const toast of document.querySelectorAll('#toastStack .toast')) toast.remove();
    activateTab('settings');
    const closeInput = document.querySelector('#closeLauncherWhenGameStartsInput');
    closeInput.checked = true;
    closeInput.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#saveSettingsButton').click();
    return true;
  })()`);
  const ptbPreparationAfterSettings = await waitFor(client, `
    window.aht.getStatus('ptb', { preferCache: true }).then((status) => {
      const saved = [...document.querySelectorAll('#toastStack .toast.success')]
        .some((toast) => /Settings saved/i.test(toast.textContent));
      return saved && status.launchReady && status.launchPreparationState === 'ready' ? status : false;
    })
  `, 'PTB non-preparation settings save');
  if (
    !ptbPreparationBeforeSettings.launchPreparedAt
    || ptbPreparationAfterSettings.launchPreparedAt !== ptbPreparationBeforeSettings.launchPreparedAt
  ) {
    throw new Error(`A non-path Game Settings save rebuilt the prepared PTB snapshot: ${JSON.stringify({ before: ptbPreparationBeforeSettings.launchPreparedAt, after: ptbPreparationAfterSettings.launchPreparedAt })}`);
  }

  await fsp.rm(fakeLauncherMarker, { force: true });
  await evaluate(client, `document.querySelector('#ptbTileButton')?.click(); true`);
  await waitFor(client, `!document.querySelector('.workspace')?.classList.contains('is-sidebar-switching')
    && document.querySelector('#player')?.classList.contains('active')
    && document.querySelector('#playButton')?.getAttribute('aria-disabled') === 'false'`, 'return from Game Settings to prepared PTB');
  const secondPtbPlayStartedAt = Date.now();
  await evaluate(client, `document.querySelector('#playButton').click(); true`);
  for (let attempt = 0; attempt < 40 && !fs.existsSync(fakeLauncherMarker); attempt += 1) {
    await sleep(25);
  }
  const secondPtbPlayHandoffMs = Date.now() - secondPtbPlayStartedAt;
  if (!fs.existsSync(fakeLauncherMarker) || secondPtbPlayHandoffMs >= 1000) {
    throw new Error(`Second PTB Play after Game Settings did not open the prepared Minecraft Launcher route within one second: ${secondPtbPlayHandoffMs}ms.`);
  }
  await waitFor(client, `document.querySelector('#playButton')?.getAttribute('aria-busy') === 'false'`, 'second PTB Play completion');
  const ptbPreparationAfterSecondPlay = await evaluate(client, `window.aht.getStatus('ptb', { preferCache: true })`);
  if (!ptbPreparationAfterSecondPlay.launchReady || ptbPreparationAfterSecondPlay.launchPreparedAt !== ptbPreparationBeforeSettings.launchPreparedAt) {
    throw new Error(`Second PTB Play did not reuse the startup-prepared snapshot: ${JSON.stringify(ptbPreparationAfterSecondPlay)}`);
  }

  await fsp.rm(fakeLauncherMarker, { force: true });
  const closePreference = await evaluate(client, `
    window.aht.getStatus().then((status) => window.aht.saveSettings({
      ...status.config,
      minecraftLauncher: {
        ...status.config.minecraftLauncher,
        enabled: false,
        closeLauncherWhenGameStarts: true
      }
    }))
  `);
  if (closePreference.config?.minecraftLauncher?.enabled !== true || closePreference.config?.minecraftLauncher?.closeLauncherWhenGameStarts !== true) {
    throw new Error(`Close-on-game-start preference did not persist with forced profile integration: ${JSON.stringify(closePreference.config?.minecraftLauncher)}`);
  }
  await evaluate(client, `document.querySelector('#gameTileButton')?.click(); true`);
  await waitFor(client, `window.aht.getStatus('stable').then((status) =>
    document.querySelector('#gameTileButton')?.classList.contains('active')
      && !document.querySelector('.workspace')?.classList.contains('is-sidebar-switching')
      && document.querySelector('#playButton')?.getAttribute('aria-disabled') === 'false'
      && document.querySelector('#playButton')?.dataset.actionMode === 'play'
      && status.launchReady
      && status.launchPreparationState === 'ready'
      && status.config?.minecraftLauncher?.profileId === 'a-hard-time-dregora'
  )`, 'installed stable tile readiness');
  const stableClickState = await evaluate(client, `(() => {
    const button = document.querySelector('#playButton');
    button.click();
    return { text: button.textContent.trim(), ariaBusy: button.getAttribute('aria-busy') };
  })()`);
  if (stableClickState.text !== 'Opening...' || stableClickState.ariaBusy !== 'true') {
    throw new Error(`Installed stable tile did not route Play through the busy button path: ${JSON.stringify(stableClickState)}`);
  }
  for (let attempt = 0; attempt < 80 && !fs.existsSync(fakeLauncherMarker); attempt += 1) {
    await sleep(250);
  }
  if (!fs.existsSync(fakeLauncherMarker)) {
    throw new Error('Installed stable tile Play did not spawn the configured Minecraft Launcher command.');
  }
  await waitFor(client, `document.querySelector('#playButton')?.getAttribute('aria-busy') === 'false'
    && document.querySelector('#playButton')?.getAttribute('aria-disabled') === 'false'`, 'installed stable Play completion');
  const finalProfiles = JSON.parse(fs.readFileSync(path.join(mcRoot, 'launcher_profiles.json'), 'utf8'));
  const syncedFinalProfiles = JSON.parse(fs.readFileSync(path.join(syncedMcRoot, 'launcher_profiles.json'), 'utf8'));
  const finalStableProfile = finalProfiles.profiles?.['a-hard-time-dregora'];
  const syncedFinalStableProfile = syncedFinalProfiles.profiles?.['a-hard-time-dregora'];
  if (
    Object.keys(finalProfiles.profiles || {}).at(-1) !== 'a-hard-time-dregora'
    || path.resolve(finalStableProfile?.gameDir || '') !== path.resolve(instanceDir)
    || path.resolve(finalStableProfile?.javaDir || '') !== path.resolve(fakeMinecraftJavaPath)
    || Date.parse(finalStableProfile?.lastUsed || '') <= Date.parse(ptbProfile?.lastUsed || '')
    || Object.keys(syncedFinalProfiles.profiles || {}).at(-1) !== 'a-hard-time-dregora'
    || path.resolve(syncedFinalStableProfile?.gameDir || '') !== path.resolve(instanceDir)
    || path.resolve(syncedFinalStableProfile?.javaDir || '') !== path.resolve(fakeMinecraftJavaPath)
  ) {
    throw new Error(`Installed stable to PTB to stable reversal did not restore every exact stable instance: ${JSON.stringify({ finalProfiles, syncedFinalProfiles })}`);
  }
  const finalStableReports = await waitForLaunchReports(instanceDir, 2);
  const finalPtbReports = await waitForLaunchReports(ptbInstanceDir, 2);
  if (
    finalStableReports.length !== 2
    || finalStableReports.some((report) => !report.text.includes('Pack: A Hard Time 7.7.7 (stable)'))
    || finalPtbReports.length !== 2
    || finalPtbReports.some((report) => !report.text.includes('Pack: A Hard Time PTB 7.7.7 (ptb)'))
  ) {
    throw new Error(`Stable/PTB report isolation changed after switching back to stable: ${JSON.stringify({ stable: finalStableReports, ptb: finalPtbReports })}`);
  }

  await fsp.appendFile(
    path.join(mcRoot, 'launcher_log.txt'),
    `[${new Date().toISOString()}] Starting game in folder ${path.join(root, 'Some Other Minecraft Profile')}\n`,
    'utf8'
  );
  await sleep(500);
  if (child.exitCode !== null) {
    throw new Error('A different Minecraft profile start incorrectly closed AHT Launcher.');
  }
  await fsp.appendFile(
    path.join(mcRoot, 'launcher_log.txt'),
    `[${new Date().toISOString()}] Starting game in folder ${instanceDir}\n`,
    'utf8'
  );
  const closeResult = await Promise.race([
    childExitPromise,
    sleep(5000).then(() => null)
  ]);
  if (!closeResult) {
    throw new Error('A fresh modpack game-start signal did not close AHT Launcher when the saved preference was enabled.');
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    installedVersion: updateResult.result.installed.version,
    forgeInstallerUrl,
    profile: {
      id: 'a-hard-time-dregora',
      lastVersionId: profile.lastVersionId,
      gameDir: profile.gameDir,
      syncedRoot: syncedMcRoot
    },
    cleanScanUi,
    usernameSurfaceAbsent,
    secondPtbPlayAfterSettings: { handoffMs: secondPtbPlayHandoffMs, preparationReused: true },
    closeWhenGameStarts: { enabled: true, exit: closeResult },
    launchCommand: playResult.result.command,
    profileSwitch: {
      stable: 'a-hard-time-dregora',
      ptb: 'a-hard-time-ptb',
      final: Object.keys(finalProfiles.profiles || {}).at(-1),
      stableGameDir: finalStableProfile.gameDir,
      ptbGameDir: ptbProfile.gameDir,
      javaDir: finalStableProfile.javaDir
    },
    launchReports: {
      stable: finalStableReports.map((report) => report.name),
      ptb: finalPtbReports.map((report) => report.name)
    },
    proofSource: proof.source,
    securityState: {
      launcherOwned: true,
      legacyInstanceFilesAbsent: true,
      packLocalProofAbsent: true
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
