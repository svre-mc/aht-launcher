import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { writeForgeInstallationFixture } from './helpers/forge-fixture.mjs';
import { workerLauncherProofFixture } from './helpers/launcher-proof-fixture.mjs';
import { writeMinecraftBaseFixture } from './helpers/minecraft-base-fixture.mjs';

const port = Number(process.argv[2] || 10010);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-play-gate-'));
const userData = path.join(root, 'userData');
const fakeHome = path.join(root, 'home');
const fakeAppData = process.platform === 'win32'
  ? path.join(fakeHome, 'AppData', 'Roaming')
  : path.join(root, 'appdata');
const fakeLocalAppData = process.platform === 'win32'
  ? path.join(fakeHome, 'AppData', 'Local')
  : path.join(root, 'localappdata');
const fakeProgramFiles = path.join(root, 'program-files');
const fakeProgramFilesX86 = path.join(root, 'program-files-x86');
const curseForgeStorageFile = path.join(fakeAppData, 'CurseForge', 'storage.json');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
const minecraftBaseFixtureDir = path.join(root, 'minecraft-base-fixture');
const fakeLauncherMarker = path.join(root, 'fake-minecraft-launcher.json');
const curseForgeRoot = path.join(root, 'curseforge', 'minecraft', 'Install');
const curseForgeSpawnCapture = path.join(root, 'curseforge-spawn.json');
const desktopLauncherPath = path.join(fakeLocalAppData, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe');
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
await Promise.all([
  fsp.mkdir(path.join(fakeHome, 'Documents'), { recursive: true }),
  fsp.mkdir(fakeAppData, { recursive: true }),
  fsp.mkdir(fakeLocalAppData, { recursive: true }),
  fsp.mkdir(userData, { recursive: true })
]);

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

const integrityStatePath = path.join(
  userData,
  'instance-state',
  sha256(path.resolve(instanceDir)).slice(0, 24),
  'integrity.json'
);
const launcherProofStatePath = path.join(userData, '.aht-launcher', 'launcher-proof.json');

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
const clientManifest = {
  format: 'aht-client-manifest-v1',
  packId: latest.packId,
  version: latest.version,
  files: [{
    relativePath: 'config/aht-integrity-test.cfg',
    size: Buffer.byteLength(expectedContent),
    sha256: sha256(expectedContent)
  }, {
    relativePath: 'mods/aht-integrity-test.jar',
    size: Buffer.byteLength(expectedContent),
    sha256: sha256(expectedContent)
  }]
};
const clientManifestBody = JSON.stringify(clientManifest);
latest.clientManifest = {
  format: 'aht-client-manifest-v1',
  url: 'client-manifest.json',
  size: Buffer.byteLength(clientManifestBody),
  sha256: sha256(clientManifestBody)
};
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
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'smoke-install',
  createdAt: new Date().toISOString(),
  minecraftUsername: 'SmokeUser',
  usernameRegisteredAt: new Date().toISOString(),
  usernameRegistrationMode: 'minecraft-launcher'
});
await writeJson(curseForgeStorageFile, {
  'minecraft-settings': JSON.stringify({
    minecraftRoot: path.dirname(curseForgeRoot)
  })
});
const initialWindowsProcessState = {
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
};
await writeJson(windowsProcessStatePath, initialWindowsProcessState);
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
const launcherProofRequests = [];
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
  if (url.pathname === '/client-manifest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(clientManifestBody);
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
      launcherProofRequests.push(payload);
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
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    APPDATA: fakeAppData,
    LOCALAPPDATA: fakeLocalAppData,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ProgramFiles: fakeProgramFiles,
    'ProgramFiles(x86)': fakeProgramFilesX86,
    ELECTRON_ENABLE_LOGGING: '0',
    AHT_APP_DEFAULTS: defaultsPath,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_USER_DATA: userData,
    AHT_TEST_STATUS_FAILURE_COUNT: '1',
    AHT_TEST_REQUIRE_LEGAL: '1',
    AHT_TEST_CURSEFORGE_STORAGE_FILE: curseForgeStorageFile,
    AHT_TEST_ALLOW_MINECRAFT_OPEN_COMMAND: '1',
    AHT_TEST_WINDOWS_PROCESS_STATE_PATH: windowsProcessStatePath,
    AHT_TEST_MINECRAFT_HANDOFF_CAPTURE_PATH: minecraftHandoffCapture,
    AHT_TEST_FORGE_INSTALLER_SUCCESS: '1',
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
  const initialStatusFailure = await waitFor(client, `(() => {
    const button = document.querySelector('#playButton');
    const copy = [...document.querySelectorAll('#toastStack .toast.error')]
      .find((toast) => /Launcher error/i.test(toast.textContent))
      ?.querySelector('button.toast-copy-action');
    return document.querySelector('#statusBadge')?.textContent.trim() === 'Error'
      && button?.getAttribute('aria-disabled') === 'false'
      && document.querySelector('#legalOverlay')?.hidden === false
      && copy?.textContent.trim() === 'Click here to copy'
      ? { title: button.title, copy: copy.textContent.trim() }
      : false;
  })()`, 'diagnostic Play after initial status failure');
  if (!/create a support report/i.test(initialStatusFailure.title || '')) {
    throw new Error(`Initial status failure did not explain the diagnostic Play action: ${JSON.stringify(initialStatusFailure)}`);
  }
  await evaluate(client, `(() => {
    const checkbox = document.querySelector('#legalAcceptCheckbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#legalAcceptButton').click();
    return true;
  })()`);
  await waitFor(client, `document.querySelector('#legalOverlay')?.hidden === true`, 'legal acceptance after initial status failure');
  await evaluate(client, `document.querySelector('#playButton').click(); true`);
  const initialPlayFailure = await waitFor(client, `(() => {
    const button = document.querySelector('#playButton');
    const toast = [...document.querySelectorAll('#toastStack .toast.error')]
      .find((item) => /Launch failed/i.test(item.textContent));
    const copy = toast?.querySelector('button.toast-copy-action');
    return button?.getAttribute('aria-busy') === 'false'
      && button?.getAttribute('aria-disabled') === 'false'
      && copy?.textContent.trim() === 'Click here to copy'
      ? { toast: toast.textContent.trim(), copy: copy.textContent.trim() }
      : false;
  })()`, 'failed Play report after initial status failure');
  const initialLaunchLogsDir = path.join(instanceDir, 'logs', 'launcher');
  const initialFailureReports = fs.readdirSync(initialLaunchLogsDir)
    .filter((name) => /^AHT-Launch-.*-FAILED-.*\.txt$/i.test(name));
  if (initialFailureReports.length !== 1) {
    throw new Error(`Initial status failure Play did not create exactly one report: ${JSON.stringify({ initialPlayFailure, initialFailureReports })}`);
  }
  await fsp.rm(integrityStatePath, { force: true });
  for (const name of initialFailureReports) {
    await fsp.rm(path.join(initialLaunchLogsDir, name), { force: true });
  }
  await evaluate(client, `document.querySelector('#toastStack').replaceChildren(); true`);
  const usernameSurfaceAbsent = await evaluate(client, `
    !document.querySelector('#accountOverlay')
      && !document.querySelector('#minecraftUsernameInput')
      && !document.querySelector('#playerLabelInput')
      && typeof window.aht.accountRegister === 'undefined'
  `);
  if (!usernameSurfaceAbsent) {
    throw new Error('The Play integrity flow exposed a manual username control or API.');
  }
  await writeJson(integrityStatePath, {
    generatedAt: new Date(Date.now() + 60_000).toISOString(),
    valid: true,
    counts: { managed: 2, checked: 2, ok: 2, changed: 0, missing: 0, added: 0, corrupted: 0 },
    fingerprint: { schemaVersion: 1, digest: '0'.repeat(64), managedCount: 2, pathsValid: true },
    source: 'forged-local-cache'
  });
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
  if (playResult.ok || !/Repair required.*managed file issue/i.test(playResult.message || '')) {
    throw new Error(`Play IPC failure path did not surface the corrupted managed files: ${JSON.stringify(playResult)}`);
  }
  const after = await evaluate(client, 'window.aht.getStatus()');
  if (after.launchReady || !/Repair required.*managed file issue/i.test(after.launchBlockedReason || '')) {
    throw new Error(`Status did not stay blocked after play integrity scan: ${JSON.stringify(after)}`);
  }
  const changedPaths = (after.integrity?.changed || []).map((entry) => entry.path).sort();
  if (after.integrity?.counts?.corrupted !== 2 || JSON.stringify(changedPaths) !== JSON.stringify(['config/aht-integrity-test.cfg', 'mods/aht-integrity-test.jar'])) {
    throw new Error(`Integrity state did not record both corrupted managed files: ${JSON.stringify(after.integrity)}`);
  }
  const blockedPlayUi = await evaluate(client, `(() => {
    renderStatus(${JSON.stringify(after)});
    const button = document.querySelector('#playButton');
    return { disabled: button.getAttribute('aria-disabled') === 'true', title: button.title };
  })()`);
  if (blockedPlayUi.disabled || !/Repair required/i.test(blockedPlayUi.title || '')) {
    throw new Error(`Blocked Play must stay clickable while explaining the preflight problem: ${JSON.stringify(blockedPlayUi)}`);
  }

  const persistedIntegrity = JSON.parse(fs.readFileSync(integrityStatePath, 'utf8'));
  if (persistedIntegrity.source !== 'play-check' || persistedIntegrity.counts?.corrupted !== 2) {
    throw new Error(`Play check integrity state was not persisted: ${JSON.stringify(persistedIntegrity)}`);
  }
  if (!persistedIntegrity.fingerprint?.digest || persistedIntegrity.checkMode !== 'full-hash') {
    throw new Error(`Full Play integrity scan did not establish a fingerprint: ${JSON.stringify(persistedIntegrity)}`);
  }

  const launchLogsDir = path.join(instanceDir, 'logs', 'launcher');
  const firstFailureReports = fs.readdirSync(launchLogsDir).filter((name) => /^AHT-Launch-.*-FAILED-.*\.txt$/i.test(name));
  if (firstFailureReports.length !== 1) {
    throw new Error(`Direct failed Play did not write exactly one timestamped report: ${JSON.stringify(firstFailureReports)}`);
  }
  const firstFailureText = fs.readFileSync(path.join(launchLogsDir, firstFailureReports[0]), 'utf8');
  for (const expected of ['Result: FAILED', 'LIKELY CAUSE', 'LAUNCH PROCESS', 'REQUIREMENTS', 'PC AND RUNTIME', 'Repair required. 2 managed file issues found']) {
    if (!firstFailureText.includes(expected)) {
      throw new Error(`Failed Play report is missing ${expected}: ${firstFailureText.slice(0, 1200)}`);
    }
  }
  if (firstFailureText.trimStart().startsWith('{') || firstFailureText.includes('process.versions')) {
    throw new Error('Failed Play report regressed to a raw diagnostic dump.');
  }
  const copiedFailure = await evaluate(client, `
    window.aht.copyErrorReport({ title: 'Launch failed', context: 'play:start', packKey: 'stable' })
  `);
  if (!copiedFailure?.copied || copiedFailure.chars < 1000 || copiedFailure.fileName !== firstFailureReports[0]) {
    throw new Error(`Failed Play report was not copied from the saved attempt: ${JSON.stringify(copiedFailure)}`);
  }

  const failureClickStarted = await evaluate(client, `(() => {
    const button = document.querySelector('#playButton');
    button.click();
    return { text: button.textContent.trim(), ariaBusy: button.getAttribute('aria-busy') };
  })()`);
  if (failureClickStarted.text !== 'Preparing...' || failureClickStarted.ariaBusy !== 'true') {
    throw new Error(`Failed Play UI did not enter Preparing state: ${JSON.stringify(failureClickStarted)}`);
  }
  const failureUi = await waitFor(client, `(() => {
    const button = document.querySelector('#playButton');
    const reportAction = document.querySelector('#copyLatestLaunchReportButton');
    const toast = [...document.querySelectorAll('#toastStack .toast.error')]
      .find((item) => /Launch failed/i.test(item.textContent));
    const copy = toast?.querySelector('button.toast-copy-action');
    return button.getAttribute('aria-busy') === 'false'
      && button.getAttribute('aria-disabled') === 'false'
      && button.textContent.trim() === 'Play'
      && reportAction?.hidden === false
      && reportAction.textContent.trim() === 'Copy latest launch report'
      && copy?.textContent.trim() === 'Click here to copy'
      ? { toast: toast.textContent.trim(), copyButtons: toast.querySelectorAll('button.toast-copy-action').length }
      : false;
  })()`, 'professional failed Play toast');
  if (failureUi.copyButtons !== 1) {
    throw new Error(`Failed Play toast did not expose exactly one copy action: ${JSON.stringify(failureUi)}`);
  }
  await evaluate(client, `(() => {
    const toast = [...document.querySelectorAll('#toastStack .toast.error')]
      .find((item) => /Launch failed/i.test(item.textContent));
    toast.querySelector('button.toast-copy-action').click();
    return true;
  })()`);
  await waitFor(client, `
    [...document.querySelectorAll('#toastStack .toast.success')]
      .some((toast) => /Launch report copied/i.test(toast.textContent) && /Paste it into your support message/i.test(toast.textContent))
  `, 'copy-success toast');
  const uiFailureReports = fs.readdirSync(launchLogsDir).filter((name) => /^AHT-Launch-.*-FAILED-.*\.txt$/i.test(name));
  if (uiFailureReports.length !== 2) {
    throw new Error(`UI failed Play did not create its own timestamped report: ${JSON.stringify(uiFailureReports)}`);
  }

  await fsp.writeFile(path.join(instanceDir, 'config', 'aht-integrity-test.cfg'), expectedContent, 'utf8');
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
  await evaluate(client, `document.querySelector('#gameTileButton')?.click(); true`);
  await waitFor(client, `document.querySelector('#playButton')?.getAttribute('aria-busy') === 'false'
    && document.querySelector('#playButton')?.getAttribute('aria-disabled') === 'false'`, 'repaired Play button refresh');
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
  const proof = JSON.parse(fs.readFileSync(launcherProofStatePath, 'utf8'));
  if (!proof.trusted || proof.source !== 'worker' || !Array.isArray(proof.javaProperties) || !proof.javaProperties.some((arg) => arg.startsWith('-Daht.launcher.proofFile='))) {
    throw new Error(`Clean Play did not write trusted launcher proof Java properties: ${JSON.stringify(proof)}`);
  }

  let desktopFallbackPlayResult = null;
  let desktopFallbackProof = null;
  let curseForgePlayResult = null;
  if (process.platform === 'win32') {
    const routeConfigPath = path.join(userData, 'launcher.config.json');
    const routeConfig = JSON.parse(fs.readFileSync(routeConfigPath, 'utf8'));
    delete routeConfig.minecraftLauncher.openCommand;
    delete routeConfig.minecraftLauncher.openArgs;
    routeConfig.minecraftLauncher.rootDir = mcRoot;
    routeConfig.minecraftLauncher.syncDefaultRoots = false;
    routeConfig.minecraftLauncher.syncRoots = [];
    await writeJson(routeConfigPath, routeConfig);
    await fsp.mkdir(path.dirname(desktopLauncherPath), { recursive: true });
    await fsp.writeFile(desktopLauncherPath, 'test desktop launcher placeholder', 'utf8');
    await fsp.rm(path.join(mcRoot, 'minecraft.exe'), { force: true });
    await fsp.rm(curseForgeSpawnCapture, { force: true });
    await fsp.rm(minecraftHandoffCapture, { force: true });
    await writeJson(windowsProcessStatePath, {
      ...initialWindowsProcessState,
      records: initialWindowsProcessState.records.filter((record) => record.image === 'javaw.exe')
    });
    if (fs.existsSync(path.join(mcRoot, 'minecraft.exe'))) {
      throw new Error('Desktop fallback smoke requires a configured Minecraft root without a root-local minecraft.exe.');
    }

    desktopFallbackPlayResult = await evaluate(client, `
      window.aht.play()
        .then((result) => ({ ok: true, result }))
        .catch((error) => ({ ok: false, message: String(error?.message || error || "") }))
    `);
    if (
      !desktopFallbackPlayResult.ok
      || !desktopFallbackPlayResult.result?.ok
      || desktopFallbackPlayResult.result?.kind !== 'desktop'
      || !desktopFallbackPlayResult.result?.activationConfirmed
    ) {
      throw new Error(`Configured-root desktop Minecraft Launcher fallback failed: ${JSON.stringify(desktopFallbackPlayResult)}`);
    }
    const desktopSpawnCapture = JSON.parse(fs.readFileSync(curseForgeSpawnCapture, 'utf8'));
    if (path.resolve(desktopSpawnCapture.command || '') !== path.resolve(desktopLauncherPath)) {
      throw new Error(`Configured-root Play did not use the desktop Minecraft Launcher fallback: ${JSON.stringify(desktopSpawnCapture)}`);
    }
    if (
      JSON.stringify(desktopSpawnCapture.args) !== JSON.stringify(['--workDir', mcRoot])
      || path.resolve(desktopSpawnCapture.cwd || '') !== path.resolve(mcRoot)
      || desktopSpawnCapture.windowsHide !== false
      || desktopSpawnCapture.captureCount !== 1
    ) {
      throw new Error(`Desktop Minecraft Launcher fallback did not preserve the configured workDir and visible GUI contract: ${JSON.stringify(desktopSpawnCapture)}`);
    }
    desktopFallbackProof = JSON.parse(fs.readFileSync(launcherProofStatePath, 'utf8'));
    if (!desktopFallbackProof.payload?.launchId || desktopFallbackProof.payload.launchId === proof.payload?.launchId) {
      throw new Error(`Desktop fallback Play reused the prior one-time launchId: ${JSON.stringify({ first: proof.payload?.launchId, desktop: desktopFallbackProof.payload?.launchId })}`);
    }

    await writeJson(windowsProcessStatePath, initialWindowsProcessState);
    await fsp.rm(curseForgeSpawnCapture, { force: true });
    await fsp.rm(minecraftHandoffCapture, { force: true });
    await fsp.cp(mcRoot, curseForgeRoot, { recursive: true });
    await fsp.writeFile(path.join(curseForgeRoot, 'minecraft.exe'), 'test launcher placeholder', 'utf8');
    const competingProfilesPath = path.join(curseForgeRoot, 'launcher_profiles.json');
    const competingProfiles = JSON.parse(fs.readFileSync(competingProfilesPath, 'utf8'));
    competingProfiles.version = 6;
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
    const stalePreLaunchSignal = '[Error] Process crashed with exit code 1 from an older launch';
    const staleInstanceSignal = 'java.lang.NoClassDefFoundError: stale.previous.Attempt';
    await fsp.writeFile(path.join(curseForgeRoot, 'launcher_log.txt'), `${stalePreLaunchSignal}\n`, 'utf8');
    await fsp.mkdir(path.join(instanceDir, 'crash-reports'), { recursive: true });
    await fsp.writeFile(path.join(instanceDir, 'logs', 'latest.log'), `[ERROR] ${staleInstanceSignal}\n`, 'utf8');
    await fsp.writeFile(path.join(instanceDir, 'crash-reports', 'crash-old-client.txt'), `---- Minecraft Crash Report ----\nCaused by: ${staleInstanceSignal}\n`, 'utf8');
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
      const reportAction = document.querySelector('#copyLatestLaunchReportButton');
      return button.getAttribute('aria-busy') === 'false'
        && button.getAttribute('aria-disabled') === 'false'
        && button.textContent.trim() === 'Play'
        && success
        && reportAction?.hidden === false
        && reportAction.textContent.trim() === 'Copy latest launch report'
        ? {
            text: button.textContent.trim(),
            ariaBusy: button.getAttribute('aria-busy'),
            ariaDisabled: button.getAttribute('aria-disabled'),
            toast: success.textContent.trim(),
            reportAction: reportAction.textContent.trim()
          }
        : false;
    })()`, 'completed Play click');
    const curseForgePlayDurationMs = Date.now() - curseForgePlayStartedAt;
    if (curseForgePlayDurationMs >= 5000) {
      throw new Error(`Prepared CurseForge Play took too long (${curseForgePlayDurationMs}ms).`);
    }
    const handoffReportsBeforeCopy = fs.readdirSync(launchLogsDir)
      .filter((name) => /^AHT-Launch-.*-HANDOFF.*\.txt$/i.test(name))
      .sort((left, right) => fs.statSync(path.join(launchLogsDir, left)).mtimeMs - fs.statSync(path.join(launchLogsDir, right)).mtimeMs);
    const latestHandoffReport = handoffReportsBeforeCopy.at(-1);
    if (!latestHandoffReport) {
      throw new Error(`Successful Play did not create a HANDOFF report: ${JSON.stringify(handoffReportsBeforeCopy)}`);
    }
    const initialHandoffText = fs.readFileSync(path.join(launchLogsDir, latestHandoffReport), 'utf8');
    if (!initialHandoffText.includes('Copy latest launch report') || initialHandoffText.includes(stalePreLaunchSignal) || initialHandoffText.includes(staleInstanceSignal)) {
      throw new Error(`Successful HANDOFF report did not explain the post-Minecraft copy action: ${initialHandoffText.slice(0, 1800)}`);
    }
    await fsp.appendFile(path.join(curseForgeRoot, 'launcher_log.txt'), '[Info] Minecraft Launcher window focused\n', 'utf8');
    await evaluate(client, `(() => {
      for (const toast of document.querySelectorAll('#toastStack .toast.success')) toast.remove();
      document.querySelector('#copyLatestLaunchReportButton').click();
      return true;
    })()`);
    await waitFor(client, `
      [...document.querySelectorAll('#toastStack .toast.success')]
        .some((toast) => /Launch report copied/i.test(toast.textContent))
    `, 'stale-signal filtered report copy');
    const benignRefreshText = fs.readFileSync(path.join(launchLogsDir, latestHandoffReport), 'utf8');
    if (benignRefreshText.includes(stalePreLaunchSignal) || benignRefreshText.includes(staleInstanceSignal) || !benignRefreshText.includes('Copy latest launch report')) {
      throw new Error(`An older launcher crash was attributed to the current handoff: ${benignRefreshText.slice(0, 1800)}`);
    }
    const postHandoffSignal = '[Error] Process crashed with exit code 1 after Minecraft Launcher Play';
    const currentInstanceSignal = 'java.lang.NoClassDefFoundError: current.attempt.Signal';
    await fsp.appendFile(path.join(curseForgeRoot, 'launcher_log.txt'), `${postHandoffSignal}\n`, 'utf8');
    await fsp.appendFile(path.join(instanceDir, 'logs', 'latest.log'), `[ERROR] ${currentInstanceSignal}\n`, 'utf8');
    await evaluate(client, `(() => {
      for (const toast of document.querySelectorAll('#toastStack .toast.success')) toast.remove();
      document.querySelector('#copyLatestLaunchReportButton').click();
      return true;
    })()`);
    await waitFor(client, `
      [...document.querySelectorAll('#toastStack .toast.success')]
        .some((toast) => /Launch report copied/i.test(toast.textContent))
    `, 'post-handoff report copy');
    const handoffReportsAfterCopy = fs.readdirSync(launchLogsDir)
      .filter((name) => /^AHT-Launch-.*-HANDOFF.*\.txt$/i.test(name))
      .sort();
    if (JSON.stringify([...handoffReportsBeforeCopy].sort()) !== JSON.stringify(handoffReportsAfterCopy)) {
      throw new Error(`Copy latest launch report created a duplicate HANDOFF report: ${JSON.stringify({ handoffReportsBeforeCopy, handoffReportsAfterCopy })}`);
    }
    const refreshedHandoffText = fs.readFileSync(path.join(launchLogsDir, latestHandoffReport), 'utf8');
    if (!refreshedHandoffText.includes(postHandoffSignal) || !refreshedHandoffText.includes(currentInstanceSignal) || refreshedHandoffText.includes(stalePreLaunchSignal) || refreshedHandoffText.includes(staleInstanceSignal)) {
      throw new Error(`Copy latest launch report did not refresh the HANDOFF report with the new exit signal: ${refreshedHandoffText.slice(-1800)}`);
    }
    const curseForgeProof = JSON.parse(fs.readFileSync(launcherProofStatePath, 'utf8'));
    if (
      !curseForgeProof.payload?.launchId
      || curseForgeProof.payload.launchId === proof.payload?.launchId
      || curseForgeProof.payload.launchId === desktopFallbackProof.payload?.launchId
    ) {
      throw new Error(`CurseForge Play reused an earlier one-time launchId: ${JSON.stringify({ first: proof.payload?.launchId, desktop: desktopFallbackProof.payload?.launchId, curseForge: curseForgeProof.payload?.launchId })}`);
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
    const officialFallbackRoot = path.join(fakeAppData, '.minecraft');
    const officialFallbackProfiles = JSON.parse(fs.readFileSync(path.join(officialFallbackRoot, 'launcher_profiles.json'), 'utf8'));
    const officialFallbackProfile = officialFallbackProfiles.profiles?.['a-hard-time-dregora'];
    if (
      !officialFallbackProfile
      || path.resolve(officialFallbackProfile.gameDir) !== path.resolve(instanceDir)
      || officialFallbackProfile.lastVersionId !== curseForgeProfile.lastVersionId
    ) {
      throw new Error(`Official Minecraft Launcher fallback did not receive the exact selected AHT profile: ${JSON.stringify(officialFallbackProfile)}`);
    }
    const migratedConfig = JSON.parse(fs.readFileSync(routeConfigPath, 'utf8'));
    const migrationBackups = fs.readdirSync(userData)
      .filter((entry) => entry.startsWith('launcher.config.json.aht-before-curseforge-') && entry.endsWith('.bak'));
    if (
      path.resolve(migratedConfig.minecraftLauncher?.rootDir || '') !== path.resolve(curseForgeRoot)
      || migratedConfig.minecraftLauncher?.profileId !== 'a-hard-time-dregora'
      || migratedConfig.sync?.playerLabel !== 'SmokeUser'
      || migrationBackups.length !== 1
    ) {
      throw new Error(`CurseForge root self-heal did not preserve launcher settings with one rollback backup: ${JSON.stringify({ migratedConfig, migrationBackups })}`);
    }
    const migrationBackup = JSON.parse(fs.readFileSync(path.join(userData, migrationBackups[0]), 'utf8'));
    if (
      path.resolve(migrationBackup.minecraftLauncher?.rootDir || '') !== path.resolve(mcRoot)
      || migrationBackup.minecraftLauncher?.profileId !== 'a-hard-time-dregora'
      || migrationBackup.sync?.playerLabel !== 'SmokeUser'
    ) {
      throw new Error(`CurseForge migration backup did not preserve the prior launcher settings: ${JSON.stringify(migrationBackup)}`);
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
      || curseForgeProfiles.selectedProfile !== 'a-hard-time-dregora'
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
    const verifiedIntegrity = await evaluate(client, 'window.aht.getStatus().then((status) => status.integrity)');
    if (verifiedIntegrity?.checkMode !== 'full-hash' || verifiedIntegrity?.source !== 'play-check') {
      throw new Error(`Prepared Play did not perform a fresh authoritative hash scan: ${JSON.stringify(verifiedIntegrity)}`);
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
    const retryMigrationBackups = fs.readdirSync(userData)
      .filter((entry) => entry.startsWith('launcher.config.json.aht-before-curseforge-') && entry.endsWith('.bak'));
    if (retryMigrationBackups.length !== 1) {
      throw new Error(`CurseForge settings self-heal created duplicate backups: ${JSON.stringify(retryMigrationBackups)}`);
    }
    const retryProof = JSON.parse(fs.readFileSync(launcherProofStatePath, 'utf8'));
    const playLaunchIds = [
      proof.payload?.launchId,
      desktopFallbackProof.payload?.launchId,
      curseForgeProof.payload?.launchId,
      retryProof.payload?.launchId
    ];
    const requestedLaunchIds = launcherProofRequests.map((request) => request?.launchId).filter(Boolean);
    const missingOrRepeatedPlayLaunchIds = playLaunchIds.filter((launchId) => (
      !launchId || requestedLaunchIds.filter((requested) => requested === launchId).length !== 1
    ));
    if (
      missingOrRepeatedPlayLaunchIds.length > 0
      || new Set(playLaunchIds).size !== playLaunchIds.length
      || retryProof.payload.launchId === curseForgeProof.payload.launchId
      || retryProof.payload.launchId === desktopFallbackProof.payload?.launchId
      || retryProof.payload.launchId === proof.payload?.launchId
    ) {
      throw new Error(`Each explicit Play did not receive one distinct one-time launchId: ${JSON.stringify({ requestCount: launcherProofRequests.length, requestedLaunchIds, playLaunchIds, missingOrRepeatedPlayLaunchIds })}`);
    }
    curseForgePlayResult.durationMs = curseForgePlayDurationMs;
    curseForgePlayResult.distinctLaunchIds = 4;
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    blockedPlayResult: playResult,
    cleanPlayResult,
    blockedReason: after.launchBlockedReason,
    cleanLaunchCommand: cleanPlayResult.result.command,
    desktopFallbackLaunchCommand: desktopFallbackPlayResult?.result?.command || '',
    desktopFallbackLaunchKind: desktopFallbackPlayResult?.result?.kind || '',
    desktopFallbackRoot: desktopFallbackPlayResult?.ok ? mcRoot : '',
    curseForgeLaunchCommand: curseForgePlayResult?.result?.command || '',
    curseForgeLaunchKind: curseForgePlayResult?.result?.kind || '',
    curseForgePlayDurationMs: curseForgePlayResult?.durationMs || 0,
    launcherProofRequests: launcherProofRequests.length,
    distinctLaunchIds: curseForgePlayResult?.distinctLaunchIds || 1,
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
