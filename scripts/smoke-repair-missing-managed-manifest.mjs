import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const port = Number(process.argv[2] || 10064);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-repair-missing-managed-'));
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'instance');
const detectedInstanceDir = path.join(root, 'detected-instance');
const mcRoot = path.join(root, 'minecraft');
const packZipPath = path.join(root, 'packs', 'a-hard-time-2.8.99-client.zip');
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

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function makeClientZip(file) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const zip = new AdmZip();
  const metadata = {
    schemaVersion: 1,
    format: 'aht-full-client-zip',
    packId: 'a-hard-time-dregora',
    name: 'A Hard Time',
    version: '2.8.99',
    minecraft: {
      version: '1.12.2',
      modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
    },
    includedRoots: ['mods', 'config'],
    missingRoots: [],
    settingsFiles: ['options.txt', 'optionsof.txt']
  };
  zip.addFile('aht-client-pack.json', Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
  zip.addFile('mods/aht-required.jar', Buffer.from('required mod bytes\n'));
  zip.addFile('config/aht-client.cfg', Buffer.from('clientConfig=true\n'));
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

async function waitForUpdateTerminal(client) {
  let last;
  for (let attempt = 0; attempt < 220; attempt += 1) {
    last = await evaluate(client, 'window.aht.getUpdateState()');
    if (last && !last.running && (last.lastResult || last.error)) {
      return last;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Repair to finish: ${JSON.stringify(last)}`);
}

const packBuffer = await makeClientZip(packZipPath);
await fsp.mkdir(path.join(detectedInstanceDir, 'mods'), { recursive: true });
await fsp.writeFile(path.join(detectedInstanceDir, 'mods', 'detected-aht-pack.jar'), 'detected pack\n', 'utf8');
const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '2.8.99',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: {
    fileName: path.basename(packZipPath),
    url: `${workerEndpoint}/packs/${path.basename(packZipPath)}`,
    sha256: sha256(packBuffer),
    size: packBuffer.length
  },
  curseforge: { disabled: true, fileCount: 0 },
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  }
};

await writeJson(defaultsPath, {
  packId: 'a-hard-time-dregora',
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  launcherProof: { enabled: false, required: false, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  launcherUpdate: { enabled: false, latestUrl: '' }
});
await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: `${workerEndpoint}/`, playerLabel: 'SmokeUser' },
  developer: { adminBaseUrl: `${workerEndpoint}/`, defaultOutDir: path.join(root, 'release'), defaultCacheModsDir: '', r2Bucket: 'ahtlauncher' },
  launcherProof: { enabled: false, required: false, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  launcherUpdate: { enabled: false, latestUrl: '' },
  minecraftLauncher: {
    enabled: false,
    rootDir: mcRoot,
    profileId: 'a-hard-time',
    profileName: 'A Hard Time',
    memoryMb: 4096,
    syncDefaultRoots: false
  },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'smoke-install',
  minecraftUsername: 'SmokeUser',
  usernameRegisteredAt: new Date().toISOString(),
  usernameRegistrationMode: 'smoke'
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.end(JSON.stringify(latest));
    return;
  }
  if (url.pathname.startsWith('/packs/')) {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/zip');
    response.end(packBuffer);
    return;
  }
  if (url.pathname === '/api/update-logs') {
    response.statusCode = 200;
    response.end(JSON.stringify({ logs: [] }));
    return;
  }
  response.statusCode = 200;
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
    AHT_TEST_LOCAL_INSTANCE_DIR: detectedInstanceDir
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
  await waitFor(client, "window.aht.getStatus().then((status) => status.latest?.version === '2.8.99' ? status : false)", 'release feed');

  const emptyScan = await evaluate(client, 'window.aht.scanFiles()');
  if (emptyScan.counts?.managed !== 0 || emptyScan.installDetected || !emptyScan.repairable || !emptyScan.repairInstallFromLatest || !emptyScan.installFolderMismatch || emptyScan.detectedInstanceDir !== detectedInstanceDir) {
    throw new Error(`Empty install folder with a valid latest release should be repairable even when another install is detected: ${JSON.stringify(emptyScan)}`);
  }
  await evaluate(client, `
    document.querySelector('#repairPromptOverlay').hidden = true;
    document.querySelector('#scanButton').click();
    true
  `);
  const emptyGuidance = await waitFor(client, `
    (() => {
      const overlay = document.querySelector('#repairPromptOverlay');
      const summary = document.querySelector('#repairPromptSummary')?.textContent || '';
      const list = document.querySelector('#repairPromptList')?.textContent || '';
      const progress = document.querySelector('#sidebarProgressLabel')?.textContent || '';
      const log = document.querySelector('#log')?.textContent || '';
      const toasts = [...document.querySelectorAll('.toast')].map((toast) => toast.textContent || '').join('\\n');
      if (!overlay || overlay.hidden || !/clean copy of the latest pack/i.test(summary) || !/selected modpack folder/i.test(list)) return false;
      return { overlayHidden: overlay?.hidden, summary, list, progress, log, toasts };
    })()
  `, 'empty install clean repair prompt');
  if (emptyGuidance.overlayHidden || /Install the pack before repairing|Repair unavailable/i.test(`${emptyGuidance.progress}\n${emptyGuidance.log}\n${emptyGuidance.toasts}`)) {
    throw new Error(`Empty install clean repair prompt regressed to unavailable/install-first wording: ${JSON.stringify(emptyGuidance)}`);
  }
  await evaluate(client, `document.querySelector('#repairPromptOverlay').hidden = true; true`);

  await fsp.rm(detectedInstanceDir, { recursive: true, force: true });
  const cleanInstallScan = await evaluate(client, 'window.aht.scanFiles()');
  if (cleanInstallScan.counts?.managed !== 0 || cleanInstallScan.installDetected || !cleanInstallScan.repairable || !cleanInstallScan.repairInstallFromLatest) {
    throw new Error(`Empty configured folder with a valid latest release should allow a clean repair install: ${JSON.stringify(cleanInstallScan)}`);
  }
  await evaluate(client, `
    document.querySelector('#repairPromptOverlay').hidden = true;
    document.querySelectorAll('.toast').forEach((toast) => toast.remove());
    document.querySelector('#scanButton').click();
    true
  `);
  const cleanInstallPrompt = await waitFor(client, `
    (() => {
      const overlay = document.querySelector('#repairPromptOverlay');
      const summary = document.querySelector('#repairPromptSummary')?.textContent || '';
      const list = document.querySelector('#repairPromptList')?.textContent || '';
      const progress = document.querySelector('#sidebarProgressLabel')?.textContent || '';
      const toasts = [...document.querySelectorAll('.toast')].map((toast) => toast.textContent || '').join('\\n');
      if (!overlay || overlay.hidden || !/clean copy of the latest pack/i.test(summary) || !/selected modpack folder/i.test(list)) return false;
      return { summary, list, progress, toasts };
    })()
  `, 'clean repair prompt for empty install with latest release');
  if (/Install the pack before repairing/i.test(`${cleanInstallPrompt.progress}\n${cleanInstallPrompt.toasts}`)) {
    throw new Error(`Clean repair prompt still told an installed/latest-ready pack to install first: ${JSON.stringify(cleanInstallPrompt)}`);
  }
  await evaluate(client, `document.querySelector('#repairPromptOverlay').hidden = true; true`);

  const damagedManagedManifestPath = path.join(instanceDir, '.aht-launcher', 'managed-files.json');
  await fsp.mkdir(path.dirname(damagedManagedManifestPath), { recursive: true });
  await fsp.writeFile(damagedManagedManifestPath, '[', 'utf8');
  const damagedManifestScan = await evaluate(client, 'window.aht.scanFiles()');
  if (damagedManifestScan.counts?.managed !== 0 || !damagedManifestScan.installDetected || !damagedManifestScan.repairable || !/damaged|Unexpected end of JSON/i.test(damagedManifestScan.managedManifestError || '')) {
    throw new Error(`Damaged managed manifest should still report a repairable installed pack: ${JSON.stringify(damagedManifestScan)}`);
  }
  await evaluate(client, `
    document.querySelector('#repairPromptOverlay').hidden = true;
    document.querySelectorAll('.toast').forEach((toast) => toast.remove());
    document.querySelector('#scanButton').click();
    true
  `);
  const damagedPrompt = await waitFor(client, `
    (() => {
      const overlay = document.querySelector('#repairPromptOverlay');
      const summary = document.querySelector('#repairPromptSummary')?.textContent || '';
      const progress = document.querySelector('#sidebarProgressLabel')?.textContent || '';
      const toasts = [...document.querySelectorAll('.toast')].map((toast) => toast.textContent || '').join('\\n');
      if (!overlay || overlay.hidden || !/damaged|rebuild/i.test(summary)) return false;
      return { summary, progress, toasts };
    })()
  `, 'repair prompt for damaged managed manifest');
  if (/Install the pack before repairing|Repair unavailable|Unexpected end of JSON/i.test(`${damagedPrompt.progress}\n${damagedPrompt.toasts}`)) {
    throw new Error(`Damaged managed manifest prompt regressed to unavailable/raw-error wording: ${JSON.stringify(damagedPrompt)}`);
  }
  await fsp.rm(damagedManagedManifestPath, { force: true });
  await evaluate(client, `document.querySelector('#repairPromptOverlay').hidden = true; true`);

  await fsp.mkdir(path.join(instanceDir, 'mods', 'OpenTerrainGenerator'), { recursive: true });
  await fsp.mkdir(path.join(instanceDir, 'config'), { recursive: true });
  await fsp.mkdir(path.join(instanceDir, 'resourcepacks'), { recursive: true });
  await fsp.writeFile(path.join(instanceDir, 'mods', 'OpenTerrainGenerator', 'runtime-cache.dat'), 'generated runtime cache\n', 'utf8');
  await fsp.writeFile(path.join(instanceDir, 'config', 'stale-client.cfg'), 'stale=true\n', 'utf8');
  await fsp.writeFile(path.join(instanceDir, 'resourcepacks', 'stale-pack.zip'), 'stale resourcepack\n', 'utf8');
  await fsp.writeFile(path.join(instanceDir, 'options.txt'), 'gamma:1.0\n', 'utf8');

  const directScan = await evaluate(client, 'window.aht.scanFiles()');
  if (directScan.counts?.managed !== 0 || !directScan.installDetected || !directScan.repairable) {
    throw new Error(`Missing managed manifest scan did not report a repairable installed pack: ${JSON.stringify(directScan)}`);
  }

  await evaluate(client, `
    document.querySelector('#repairPromptOverlay').hidden = true;
    document.querySelectorAll('.toast').forEach((toast) => toast.remove());
    document.querySelector('#scanButton').click();
    true
  `);
  const prompt = await waitFor(client, `
    (() => {
      const overlay = document.querySelector('#repairPromptOverlay');
      const summary = document.querySelector('#repairPromptSummary')?.textContent || '';
      const progress = document.querySelector('#sidebarProgressLabel')?.textContent || '';
      const toasts = [...document.querySelectorAll('.toast')].map((toast) => toast.textContent || '').join('\\n');
      if (!overlay || overlay.hidden || !/manifest/i.test(summary)) return false;
      return { summary, progress, toasts };
    })()
  `, 'repair prompt for missing managed manifest');

  if (/Install the pack before repairing/i.test(`${prompt.progress}\n${prompt.toasts}`)) {
    throw new Error(`Repair UI still told an installed pack to install first: ${JSON.stringify(prompt)}`);
  }

  const status = await evaluate(client, 'window.aht.getStatus()');
  if (status.integrity?.counts?.managed !== 0 || !status.integrity?.repairable || !status.integrity?.installDetected) {
    throw new Error(`Status did not persist the repairable missing-manifest scan: ${JSON.stringify({ installed: status.installed, integrity: status.integrity })}`);
  }

  await evaluate(client, `
    document.querySelector('#repairPromptRepairButton').click();
    true
  `);
  const repairState = await waitForUpdateTerminal(client);
  if (repairState.error || repairState.lastResult?.installed?.version !== latest.version) {
    throw new Error(`Repair did not complete through the UI button: ${JSON.stringify(repairState)}`);
  }
  const managedPath = path.join(instanceDir, '.aht-launcher', 'managed-files.json');
  const installedPath = path.join(instanceDir, '.aht-launcher', 'installed.json');
  const managedFiles = JSON.parse(fs.readFileSync(managedPath, 'utf8'));
  const managedRelPaths = new Set(managedFiles.map((item) => item.relativePath));
  if (!managedRelPaths.has('mods/aht-required.jar') || !managedRelPaths.has('config/aht-client.cfg')) {
    throw new Error(`Repair did not write the expected managed file manifest: ${JSON.stringify(managedFiles)}`);
  }
  if (fs.existsSync(path.join(instanceDir, 'config', 'stale-client.cfg')) || fs.existsSync(path.join(instanceDir, 'resourcepacks', 'stale-pack.zip'))) {
    throw new Error('Repair left stale pack files from the pre-manifest install.');
  }
  if (!fs.existsSync(path.join(instanceDir, 'mods', 'aht-required.jar')) || !fs.existsSync(path.join(instanceDir, 'config', 'aht-client.cfg'))) {
    throw new Error('Repair did not install the required full-client ZIP files.');
  }
  const installedManifest = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  if (installedManifest.version !== latest.version || installedManifest.installMode !== 'full-client-zip') {
    throw new Error(`Repair wrote the wrong installed manifest: ${JSON.stringify(installedManifest)}`);
  }
  const repairedStatus = await evaluate(client, 'window.aht.getStatus()');
  if (repairedStatus.integrity?.counts?.corrupted !== 0 || repairedStatus.integrity?.counts?.managed < 1) {
    throw new Error(`Repair finished but status still reports corrupted managed files: ${JSON.stringify(repairedStatus.integrity)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    installed: repairedStatus.installed.version,
    repairableBeforeRepair: status.integrity.repairable,
    installDetectedBeforeRepair: status.integrity.installDetected,
    installDetectionBeforeRepair: status.integrity.installDetection,
    detectedMismatchBeforeInstall: emptyScan.detectedInstanceDir,
    managedAfterRepair: managedFiles.length,
    prompt,
    repairProgress: repairState.progress
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
