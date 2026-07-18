import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10420);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-launcher-self-update-'));
const userData = path.join(root, 'userData');
const pendingUpdatePath = path.join(userData, 'launcher-updates', 'pending-launcher-update.json');
const startupProbePath = path.join(root, 'startup-probe.jsonl');
const artifactName = process.platform === 'win32'
  ? 'AHT-Launcher-Windows-10-11-9.9.9.exe'
  : process.platform === 'darwin'
    ? 'AHT-Launcher-macOS-x64-9.9.9.zip'
    : '';
if (!artifactName) {
  throw new Error(`Launcher self-update smoke only supports Windows and macOS artifacts, got ${process.platform}.`);
}
const artifactBytes = Buffer.from('fake launcher installer\n');
const artifactHash = crypto.createHash('sha256').update(artifactBytes).digest('hex');
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

function waitForExit(childProcess, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!childProcess || childProcess.exitCode !== null || childProcess.signalCode) {
      resolve({ code: childProcess?.exitCode ?? null, signal: childProcess?.signalCode ?? null });
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`process ${childProcess.pid || 'unknown'} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    childProcess.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function contentTypeFor(key) {
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  if (key.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (key.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (key.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

async function waitForTarget() {
  let lastError;
  for (let attempt = 0; attempt < 160; attempt += 1) {
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

async function waitFor(client, expression, label, attempts = 180) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir: path.join(root, 'instance'),
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: workerEndpoint, playerLabel: 'SmokeUser' },
  developer: { adminBaseUrl: workerEndpoint, defaultOutDir: path.join(root, 'release'), defaultCacheModsDir: '', r2Bucket: 'ahtlauncher' },
  launcherUpdate: { enabled: true, latestUrl: `${workerEndpoint}/launcher/latest.json` },
  minecraftLauncher: { enabled: false, rootDir: path.join(root, 'minecraft'), profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 4096 },
  playCommand: { command: '', args: [], cwd: path.join(root, 'instance') }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'smoke-install',
  minecraftUsername: 'SmokeUser'
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    const body = JSON.stringify({ packId: 'a-hard-time-dregora', name: 'A Hard Time', version: '1.0.0', required: false, zip: { url: 'packs/a-hard-time-1.0.0.zip' } });
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
    return;
  }
  if (url.pathname === '/launcher/latest.json') {
    const artifactPath = `launcher/files/${process.platform}-${process.arch}/${artifactName}`;
    const body = JSON.stringify({
      schemaVersion: 1,
      product: 'aht-launcher',
      name: 'A Hard Time Launcher',
      version: '9.9.9',
      required: true,
      platforms: {
        [`${process.platform}-${process.arch}`]: {
          label: 'Smoke platform',
          kind: process.platform === 'win32' ? 'nsis' : 'zip',
          fileName: artifactName,
          path: artifactPath,
          url: `${workerEndpoint}/${artifactPath}`,
          sha256: artifactHash,
          size: artifactBytes.length,
          installArgs: process.platform === 'win32' ? ['/S'] : []
        },
        [process.platform]: {
          label: 'Smoke platform',
          kind: process.platform === 'win32' ? 'nsis' : 'zip',
          fileName: artifactName,
          path: artifactPath,
          url: `${workerEndpoint}/${artifactPath}`,
          sha256: artifactHash,
          size: artifactBytes.length,
          installArgs: process.platform === 'win32' ? ['/S'] : []
        }
      }
    });
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
    return;
  }
  if (url.pathname.endsWith(`/${artifactName}`)) {
    response.writeHead(200, { 'Content-Type': contentTypeFor(artifactName), 'Content-Length': artifactBytes.length });
    response.end(request.method === 'HEAD' ? null : artifactBytes);
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'not found', path: url.pathname }));
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

let child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_ALLOW_INSECURE_LAUNCHER_UPDATE: '1',
    AHT_TEST_STARTUP_PROBE_PATH: startupProbePath,
    AHT_TEST_LAUNCHER_UPDATE_NO_QUIT: '1',
    AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY: '1',
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
  await waitFor(client, "document.readyState === 'complete' && document.querySelector('#launcherUpdateOverlay')", 'launcher update DOM');
  await waitFor(client, "document.querySelector('#launcherUpdateOverlay').hidden === false", 'launcher update overlay visible');
  await waitFor(client, "document.querySelector('#launcherUpdateTitle').textContent.includes('Ready to Install')", 'launcher update staged', 240);
  await waitFor(client, "document.querySelector('#launcherUpdateNowButton').textContent.includes('Install and Restart')", 'install and restart button');
  const stagedProof = await evaluate(client, `(async () => ({
    hidden: document.querySelector('#launcherUpdateOverlay').hidden,
    title: document.querySelector('#launcherUpdateTitle').textContent,
    summary: document.querySelector('#launcherUpdateSummary').textContent,
    progress: document.querySelector('#launcherUpdateProgressCount').textContent,
    button: document.querySelector('#launcherUpdateNowButton').textContent,
    log: document.querySelector('#launcherUpdateLog').textContent,
    status: await window.aht.getStatus(),
    state: await window.aht.getLauncherUpdateState()
  }))()`);
  if (!stagedProof.state.lastResult?.restartRequired || !stagedProof.state.lastResult?.preparedRestart) {
    throw new Error(`Launcher update was not staged for explicit restart: ${JSON.stringify(stagedProof.state)}`);
  }
  if (!fs.existsSync(pendingUpdatePath)) {
    throw new Error(`Launcher update did not write pending handoff state at ${pendingUpdatePath}`);
  }
  const stagedPending = JSON.parse(fs.readFileSync(pendingUpdatePath, 'utf8'));
  if (stagedPending.status !== 'staged' || stagedPending.version !== '9.9.9' || !stagedPending.preparedRestart) {
    throw new Error(`Pending launcher update was not staged correctly: ${JSON.stringify(stagedPending)}`);
  }
  await evaluate(client, `document.querySelector('#launcherUpdateNowButton').click(); true`);
  await sleep(1500);
  const clickProof = await evaluate(client, `(async () => ({
    button: document.querySelector('#launcherUpdateNowButton').textContent,
    label: document.querySelector('#launcherUpdateProgressLabel').textContent,
    log: document.querySelector('#launcherUpdateLog').textContent,
    state: await window.aht.getLauncherUpdateState(),
    hasRestartApi: typeof window.aht.restartLauncherUpdate === 'function'
  }))()`);
  if (!clickProof.log.includes('Installing launcher update.') && !clickProof.log.includes('Test mode verified the restart helper')) {
    throw new Error(`Install and Restart button click did not start install flow: ${JSON.stringify(clickProof)}`);
  }
  const installingPending = JSON.parse(fs.readFileSync(pendingUpdatePath, 'utf8'));
  if (installingPending.status !== 'installing' || installingPending.version !== '9.9.9' || !installingPending.installingStartedAt) {
    throw new Error(`Pending launcher update was not marked installing before quit: ${JSON.stringify(installingPending)}`);
  }
  await waitFor(client, "document.querySelector('#launcherUpdateLog').textContent.includes('Test mode verified the restart helper')", 'launcher restart helper verified', 80);
  const proof = await evaluate(client, `(async () => ({
    hidden: document.querySelector('#launcherUpdateOverlay').hidden,
    title: document.querySelector('#launcherUpdateTitle').textContent,
    summary: document.querySelector('#launcherUpdateSummary').textContent,
    button: document.querySelector('#launcherUpdateNowButton').textContent,
    progress: document.querySelector('#launcherUpdateProgressCount').textContent,
    log: document.querySelector('#launcherUpdateLog').textContent,
    status: await window.aht.getStatus(),
    state: await window.aht.getLauncherUpdateState()
  }))()`);
  if (!proof.status.launcherUpdate?.updateRequired) {
    throw new Error(`Status did not report launcher update required: ${JSON.stringify(proof.status.launcherUpdate)}`);
  }
  if (!proof.state.lastResult?.downloadedPath || !fs.existsSync(proof.state.lastResult.downloadedPath)) {
    throw new Error(`Launcher update artifact was not downloaded: ${JSON.stringify(proof.state)}`);
  }
  if (process.platform === 'win32') {
    const launched = proof.state.lastResult.launched || {};
    const prepared = proof.state.lastResult.preparedRestart || {};
    if (launched.strategy !== 'windows-helper') {
      throw new Error(`Windows launcher update did not use the restart helper: ${JSON.stringify(launched)}`);
    }
    for (const file of [prepared.payloadPath, prepared.scriptPath, launched.logPath]) {
      if (!file || !fs.existsSync(file)) {
        throw new Error(`Windows launcher update helper file was not created: ${JSON.stringify({ prepared, launched })}`);
      }
    }
    const payload = JSON.parse(fs.readFileSync(prepared.payloadPath, 'utf8'));
    if (payload.installerPath !== proof.state.lastResult.downloadedPath) {
      throw new Error(`Helper payload points at the wrong installer: ${JSON.stringify(payload)}`);
    }
    if (payload.expectedVersion !== proof.status.launcherUpdate.latestVersion) {
      throw new Error(`Helper payload has wrong expected version: ${JSON.stringify(payload)}`);
    }
    if (!payload.targetExe || !payload.oldPid || !payload.pendingFailurePath || payload.testStartOnly !== true || !payload.installerArgs?.includes('/S') || !payload.installerArgs?.some((arg) => String(arg).startsWith('/D='))) {
      throw new Error(`Helper payload is missing restart details: ${JSON.stringify(payload)}`);
    }
    const helperLog = fs.readFileSync(launched.logPath, 'utf8');
    if (!helperLog.includes('Test mode helper startup confirmed.')) {
      throw new Error(`Helper did not write startup confirmation: ${helperLog}`);
    }
    const scriptText = fs.readFileSync(prepared.scriptPath, 'utf8');
    for (const required of ['Wait-Process', 'Get-BlockingLauncherProcesses', 'Waiting for launcher processes to close', 'Write-PendingFailure', 'Start-Process -FilePath ([string]$payload.installerPath)', 'Start-Process -FilePath $target']) {
      if (!scriptText.includes(required)) {
        throw new Error(`Helper script is missing ${required}: ${scriptText}`);
      }
    }
  }
  if (process.platform === 'darwin') {
    const launched = proof.state.lastResult.launched || {};
    const prepared = proof.state.lastResult.preparedRestart || {};
    if (launched.strategy !== 'macos-helper') {
      throw new Error(`macOS launcher update did not use the restart helper: ${JSON.stringify(launched)}`);
    }
    for (const file of [prepared.payloadPath, prepared.scriptPath, launched.logPath]) {
      if (!file || !fs.existsSync(file)) {
        throw new Error(`macOS launcher update helper file was not created: ${JSON.stringify({ prepared, launched })}`);
      }
    }
    const payload = JSON.parse(fs.readFileSync(prepared.payloadPath, 'utf8'));
    if (payload.installerPath !== proof.state.lastResult.downloadedPath || !payload.targetApp?.endsWith('.app') || !payload.pendingFailurePath || payload.testStartOnly !== true) {
      throw new Error(`macOS helper payload is missing update details: ${JSON.stringify(payload)}`);
    }
    const helperLog = fs.readFileSync(launched.logPath, 'utf8');
    if (!helperLog.includes('Test mode helper startup confirmed.')) {
      throw new Error(`Helper did not write startup confirmation: ${helperLog}`);
    }
    const scriptText = fs.readFileSync(prepared.scriptPath, 'utf8');
    for (const required of ['/usr/bin/ditto -x -k', '/usr/bin/open "$target_app"', 'pending_failure_path', 'fallback_app', 'AppTranslocation', 'Primary install target failed', 'No .app bundle was found in update ZIP']) {
      if (!scriptText.includes(required)) {
        throw new Error(`macOS helper script is missing ${required}: ${scriptText}`);
      }
    }
  }
  await client.call('Browser.close').catch(() => {});
  client.close();
  client = null;
  child.kill();
  await waitForExit(child, 10000).catch(() => {});
  child = null;

  const guardPort = port + 2;
  const guardArgs = smokeExe
    ? [`--user-data-dir=${userData}`]
    : ['.', `--user-data-dir=${userData}`];
  const guardChild = spawn(electronBin, guardArgs, {
    cwd: electronCwd,
    env: {
      ...process.env,
      AHT_TEST_HOOKS: '1',
      AHT_TEST_REMOTE_DEBUG_PORT: String(guardPort),
      AHT_TEST_STARTUP_PROBE_PATH: startupProbePath,
      ELECTRON_ENABLE_LOGGING: '0'
    },
    stdio: 'ignore',
    windowsHide: true
  });
  const guardExit = await waitForExit(guardChild, 10000).catch((error) => {
    guardChild.kill();
    throw new Error(`reopened old launcher did not exit during pending install: ${error.message}`);
  });
  if (guardExit.code !== 0) {
    throw new Error(`reopened old launcher exited with unexpected status during pending install: ${JSON.stringify(guardExit)}`);
  }
  const probeLines = fs.existsSync(startupProbePath)
    ? fs.readFileSync(startupProbePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  if (!probeLines.some((line) => line.stage === 'launcher-update-install-pending-exit')) {
    throw new Error(`reopened old launcher did not use pending install exit guard: ${JSON.stringify(probeLines)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    proof: {
      title: proof.title,
      summary: proof.summary,
      button: proof.button,
      progress: proof.progress,
      downloadedPath: proof.state.lastResult.downloadedPath,
      latestVersion: proof.status.launcherUpdate.latestVersion,
      launcherStrategy: proof.state.lastResult.launched?.strategy || 'direct',
      pendingInstallReopenExit: guardExit
    }
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  if (child) child.kill();
  await new Promise((resolve) => server.close(resolve));
}
