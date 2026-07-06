import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const port = Number(process.argv[2] || 10240);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-close-during-update-'));
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'A Hard Time');
const mcRoot = path.join(root, '.minecraft');
const startupProbePath = path.join(root, 'startup-probe.jsonl');
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

function makeClientZipBuffer() {
  const zip = new AdmZip();
  const metadata = {
    schemaVersion: 1,
    format: 'aht-full-client-zip',
    packId: 'a-hard-time',
    name: 'A Hard Time',
    version: '9.8.7',
    minecraft: {
      version: '1.12.2',
      modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
    },
    includedRoots: ['mods', 'resourcepacks', 'config'],
    missingRoots: [],
    settingsFiles: []
  };
  zip.addFile('aht-client-pack.json', Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
  zip.addFile('mods/aht-required.jar', crypto.randomBytes(1024 * 1024));
  zip.addFile('mods/aht-version-lock-9.8.7.jar', crypto.randomBytes(1024 * 1024));
  zip.addFile('resourcepacks/aht-smoke-resourcepack.zip', crypto.randomBytes(512 * 1024));
  zip.addFile('config/aht-client.cfg', Buffer.from('clientConfig=true\n'));
  return zip.toBuffer();
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
  socket.addEventListener('close', () => {
    for (const { reject } of pending.values()) {
      reject(new Error('CDP socket closed'));
    }
    pending.clear();
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve({
        call(method, params = {}, timeoutMs = 45000) {
          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((callResolve, callReject) => {
            pending.set(id, { resolve: callResolve, reject: callReject });
            setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              callReject(new Error(`CDP call timed out: ${method}`));
            }, timeoutMs);
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

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Launcher process ${child.pid} did not exit within ${timeoutMs}ms after window close.`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

const packBuffer = makeClientZipBuffer();
const latest = {
  schemaVersion: 1,
  packId: 'a-hard-time',
  name: 'A Hard Time',
  version: '9.8.7',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  },
  zip: {
    fileName: 'a-hard-time-close-test-9.8.7-client.zip',
    url: `${workerEndpoint}/packs/a-hard-time-close-test-9.8.7-client.zip`,
    sha256: sha256(packBuffer),
    size: packBuffer.length
  },
  curseforge: { disabled: true, fileCount: 0 }
};

await writeJson(defaultsPath, {
  packId: 'a-hard-time',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: '', apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: '', playerLabel: '' },
  launcherProof: { enabled: false, required: false, baseUrl: '', keyId: 'aht-launcher-proof-v1' },
  launcherUpdate: { enabled: false, latestUrl: '' },
  minecraftLauncher: {
    enabled: true,
    rootDir: mcRoot,
    profileId: 'a-hard-time',
    profileName: 'A Hard Time',
    memoryMb: 4096,
    autoImportAccount: false
  },
  playCommand: { command: '', args: [], cwd: instanceDir }
});

const timers = new Set();
let packRequestStarted = false;
let responseClosed = false;
let bytesWritten = 0;

function trackTimeout(fn, ms) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
  return timer;
}

function streamPackSlowly(response) {
  packRequestStarted = true;
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/zip');
  response.setHeader('Content-Length', String(packBuffer.length));
  const chunkSize = 64 * 1024;
  let offset = 0;
  let closed = false;
  response.on('close', () => {
    closed = true;
    responseClosed = true;
  });
  const writeNext = () => {
    if (closed || offset >= packBuffer.length) {
      if (!closed) response.end();
      return;
    }
    const next = Math.min(offset + chunkSize, packBuffer.length);
    response.write(packBuffer.subarray(offset, next));
    bytesWritten = next;
    offset = next;
    trackTimeout(writeNext, 150);
  };
  trackTimeout(writeNext, 250);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(latest));
    return;
  }
  if (url.pathname.startsWith('/packs/')) {
    streamPackSlowly(response);
    return;
  }
  if (url.pathname === '/api/update-logs') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ logs: [] }));
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/octet-stream');
  response.end(Buffer.from('ok'));
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
    AHT_TEST_FORGE_INSTALLER_SUCCESS: '1',
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
  await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '9.8.7' && status.updateRequired ? status : false)
  `, 'update-required status');
  await evaluate(client, `
    (() => {
      window.__ahtCloseDuringUpdate = window.aht.startUpdate({ forceRepair: false, replaceGameSettings: false })
        .then((result) => ({ ok: true, result }))
        .catch((error) => ({ ok: false, message: String(error?.message || error || '') }));
      return true;
    })()
  `);
  await waitFor(client, 'window.aht.getUpdateState().then((state) => state.running ? state : false)', 'running update state');
  for (let attempt = 0; attempt < 80 && !packRequestStarted; attempt += 1) {
    await sleep(100);
  }
  if (!packRequestStarted) {
    throw new Error('Update entered running state but did not request the pack ZIP.');
  }
  for (let attempt = 0; attempt < 80 && bytesWritten === 0; attempt += 1) {
    await sleep(100);
  }
  if (bytesWritten === 0) {
    throw new Error('Pack ZIP request started, but no download bytes were sent before the close test.');
  }
  await client.call('Page.close', {}, 5000).catch((error) => {
    if (!/closed|Target closed/i.test(error.message || '')) throw error;
  });
  const exit = await waitForExit(child, 15000);
  if (child.exitCode === null && !child.killed) {
    throw new Error('Launcher process stayed alive after closing the only player window during update.');
  }
  console.log(JSON.stringify({
    ok: true,
    root,
    pid: child.pid,
    exit,
    packRequestStarted,
    responseClosed,
    bytesWritten,
    packSize: packBuffer.length
  }, null, 2));
} finally {
  if (client) {
    client.close();
  }
  for (const timer of timers) {
    clearTimeout(timer);
  }
  if (child.exitCode === null && !child.killed) {
    child.kill();
  }
  await new Promise((resolve) => server.close(resolve));
}
