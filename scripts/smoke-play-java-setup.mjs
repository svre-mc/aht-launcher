import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10860);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-play-java-setup-'));
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'A Hard Time');
const mcRoot = path.join(root, '.minecraft');
const spawnCapturePath = path.join(root, 'spawn-detached.jsonl');
const errorReportCapturePath = path.join(root, 'copied-error-report.json');
const missingJavaPath = path.join(root, 'missing-java', process.platform === 'win32' ? 'java.exe' : 'java');
const fakeLocalAppData = path.join(root, 'localappdata');
const fakeAppData = path.join(root, 'appdata');
const fakeProgramFiles = path.join(root, 'program-files');
const fakeMinecraftLauncher = path.join(fakeProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe');
const fakeProgramData = path.join(root, 'program-data');
const fakeUserProfile = path.join(root, 'profile');
const fakeHome = path.join(root, 'home');
const fakePathBin = path.join(root, 'empty-path');
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

async function waitForReport() {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const text = await fsp.readFile(errorReportCapturePath, 'utf8');
      if (text.trim()) return JSON.parse(text);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for captured Java setup report: ${lastError?.message || 'missing report'}`);
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '8.9.0',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { url: 'packs/a-hard-time-8.9.0.zip' },
  minecraft: {
    version: '1.12.2',
    modLoaders: [{
      id: 'forge-14.23.5.2860',
      primary: true,
      installerUrl: `${workerEndpoint}/forge-installer.jar`
    }]
  }
};
const managedModContent = 'managed mod bytes\n';

await fsp.mkdir(path.join(instanceDir, 'mods'), { recursive: true });
await fsp.mkdir(fakeLocalAppData, { recursive: true });
await fsp.mkdir(fakeAppData, { recursive: true });
await fsp.mkdir(fakeProgramFiles, { recursive: true });
await fsp.mkdir(path.dirname(fakeMinecraftLauncher), { recursive: true });
await fsp.writeFile(fakeMinecraftLauncher, 'official Minecraft Launcher placeholder\n', 'utf8');
await fsp.mkdir(fakeProgramData, { recursive: true });
await fsp.mkdir(fakeUserProfile, { recursive: true });
await fsp.mkdir(path.join(fakeUserProfile, 'Documents'), { recursive: true });
await fsp.mkdir(fakeHome, { recursive: true });
await fsp.mkdir(fakePathBin, { recursive: true });
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
  path.join(mcRoot, 'versions', '1.12.2', '1.12.2.json'),
  { id: '1.12.2', assetIndex: { id: '1.12', url: `${workerEndpoint}/assets/1.12.json` } }
);
await writeJson(path.join(mcRoot, 'assets', 'indexes', '1.12.json'), { objects: {} });
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
    javaPath: missingJavaPath,
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
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ objects: {} }));
    return;
  }
  if (url.pathname === '/forge-installer.jar') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/java-archive');
    response.end(Buffer.from('fake forge installer jar bytes'));
    return;
  }
  if (url.pathname === '/java8.zip') {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('managed Java download unavailable in smoke');
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
        token: 'java-setup-proof-token',
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
    AHT_TEST_ERROR_REPORT_CAPTURE_PATH: errorReportCapturePath,
    AHT_TEST_SPAWN_DETACHED_CAPTURE_PATH: spawnCapturePath,
    AHT_DISABLE_COMMON_MINECRAFT_LAUNCHER_DRIVES: '1',
    AHT_JAVA8_DOWNLOAD_URL: `${workerEndpoint}/java8.zip`,
    AHT_JAVA_HOME: '',
    JAVA8_HOME: '',
    JDK8_HOME: '',
    JRE8_HOME: '',
    JDK_HOME: '',
    JAVA_HOME: '',
    JRE_HOME: '',
    LOCALAPPDATA: fakeLocalAppData,
    APPDATA: fakeAppData,
    ProgramFiles: fakeProgramFiles,
    'ProgramFiles(x86)': fakeProgramFiles,
    ProgramW6432: fakeProgramFiles,
    ProgramData: fakeProgramData,
    ChocolateyInstall: path.join(root, 'chocolatey-empty'),
    SCOOP: path.join(root, 'scoop-empty'),
    Path: fakePathBin,
    PATH: fakePathBin,
    USERPROFILE: fakeUserProfile,
    HOME: fakeHome,
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
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'player DOM');
  const registration = await evaluate(client, `
    window.aht.accountRegister('NoJavaUser')
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  if (!registration.ok || !registration.result?.ok) {
    throw new Error(`Player registration failed: ${JSON.stringify(registration)}`);
  }
  const before = await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '8.9.0' ? status : false)
  `, 'ready status before Java setup Play');
  if (!before.launchReady || before.launchBlockedReason || before.integrity?.counts?.corrupted) {
    throw new Error(`Smoke setup should be launch-ready before Forge Java setup failure: ${JSON.stringify(before)}`);
  }

  await evaluate(client, `document.querySelector('#playButton')?.click(); true`);
  const toast = await waitFor(client, `
    (() => {
      const nodes = [...document.querySelectorAll('.toast')];
      const toast = nodes.find((item) => /Setup needed/i.test(item.querySelector('strong')?.textContent || ''));
      if (!toast) return false;
      const copy = toast.querySelector('.toast-copy-action');
      return {
        title: toast.querySelector('strong')?.textContent || '',
        detail: toast.querySelector('span')?.textContent || '',
        copyText: copy?.textContent || '',
        log: document.querySelector('#log')?.textContent || ''
      };
    })()
  `, 'Java setup toast');
  const message = String(toast.detail || '');
  if (toast.title !== 'Setup needed') {
    throw new Error(`Missing Java Play toast had the wrong title: ${JSON.stringify(toast)}`);
  }
  if (!/managed Java 8 runtime|Install Eclipse Temurin JDK 8/i.test(message)) {
    throw new Error(`Missing Java Play did not produce setup-focused wording: ${JSON.stringify(toast)}`);
  }
  if (/click Update again/i.test(message)) {
    throw new Error(`Missing Java Play used update-specific wording after Play was clicked: ${JSON.stringify(toast)}`);
  }
  if (/ENOENT|spawn\s+|Error invoking remote method/i.test(`${message}\n${toast.log}`)) {
    throw new Error(`Missing Java Play leaked low-level spawn text in player-visible UI: ${JSON.stringify(toast)}`);
  }
  if (toast.copyText !== 'Copy full error details') {
    throw new Error(`Missing Java setup toast did not expose clickable diagnostics: ${JSON.stringify(toast)}`);
  }
  await evaluate(client, `document.querySelector('.toast .toast-copy-action')?.click(); true`);
  const report = await waitForReport();
  if (
    report.title !== 'Setup needed'
    || report.rendererError?.context !== 'play-start'
    || !/managed Java 8 runtime|Install Eclipse Temurin JDK 8/i.test(report.rendererError?.message || '')
    || !/managed Java 8 runtime|Install Eclipse Temurin JDK 8/i.test(report.lastMainError?.error?.message || '')
    || /click Update again/i.test(`${report.rendererError?.message || ''}\n${report.lastMainError?.error?.message || ''}`)
  ) {
    throw new Error(`Copied Java setup report did not contain clean renderer text plus detailed main error: ${JSON.stringify(report, null, 2)}`);
  }
  const spawnCaptures = await readJsonLines(spawnCapturePath);
  if (spawnCaptures.length) {
    throw new Error(`Minecraft Launcher was opened even though Forge Java setup failed: ${JSON.stringify(spawnCaptures)}`);
  }
  const after = await evaluate(client, 'window.aht.getStatus()');
  if (!after.launchReady || after.launchBlockedReason || after.integrity?.counts?.corrupted) {
    throw new Error(`Java setup failure should not dirty the installed pack state: ${JSON.stringify(after)}`);
  }
  const profile = JSON.parse(fs.readFileSync(path.join(mcRoot, 'launcher_profiles.json'), 'utf8')).profiles?.['a-hard-time'];
  if (!profile || profile.lastVersionId !== versionId || path.resolve(profile.gameDir) !== path.resolve(instanceDir)) {
    throw new Error(`Play did not prepare the Minecraft profile before Java setup failure: ${JSON.stringify(profile)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    packaged: Boolean(smokeExe),
    message,
    report: {
      title: report.title,
      context: report.rendererError?.context,
      hasMainError: Boolean(report.lastMainError?.error?.message)
    },
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
