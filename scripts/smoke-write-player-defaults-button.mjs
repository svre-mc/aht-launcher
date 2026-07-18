import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10600);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-defaults-button-'));
const userData = path.join(root, 'userData');
const defaultsDir = path.join(root, 'defaults');
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? ['--developer', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', '--developer', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitFor(client, expression, label, attempts = 180) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (url.pathname === '/latest.json') {
    response.end(JSON.stringify({
      packId: 'a-hard-time-dregora',
      name: 'A Hard Time',
      version: '9.9.9',
      required: true,
      zip: {
        path: 'packs/a-hard-time-9.9.9.zip',
        size: 123,
        sha256: '0'.repeat(64)
      }
    }));
    return;
  }
  if (url.pathname === '/api/update-logs') {
    response.end(JSON.stringify({ logs: [] }));
    return;
  }
  response.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_ALLOW_DEVELOPER: '1',
    AHT_LAUNCHER_SOURCE_ROOT: process.cwd(),
    AHT_DEVELOPER_USERNAME: 'admin',
    AHT_DEVELOPER_PASSWORD: 'test-dev-password',
    AHT_SKIP_REMOTE_DEVELOPER_LOGIN: '1',
    AHT_PLAYER_DEFAULTS_DIR: defaultsDir,
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
  await waitFor(client, "document.readyState === 'complete' && document.querySelector('#developerLoginForm')", 'developer login DOM');
  await evaluate(client, `
    (() => {
      document.querySelector('#adminUserInput').value = 'admin';
      document.querySelector('#adminPasswordInput').value = 'test-dev-password';
      document.querySelector('#developerLoginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()
  `);
  await waitFor(client, "document.body.classList.contains('dev-locked') === false && !document.querySelector('#developerConsole').hidden", 'developer unlock');
  await evaluate(client, `
    (() => {
      document.querySelector('#playerFeedUrlInput').value = ${JSON.stringify(`${workerEndpoint}/latest.json`)};
      document.querySelector('#bucketInput').value = 'ahtlauncher';
      for (const selector of ['#playerFeedUrlInput', '#bucketInput']) {
        document.querySelector(selector).dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()
  `);
  await waitFor(client, "document.querySelector('#writeDefaultsButton').getAttribute('aria-disabled') !== 'true'", 'write defaults enabled');
  await evaluate(client, "document.querySelector('#writeDefaultsButton').click()");
  await waitFor(client, "document.querySelector('#releaseCheckState').textContent === 'Defaults written'", 'defaults written');

  const defaultsPath = path.join(defaultsDir, 'app.defaults.json');
  const defaults = JSON.parse(await fsp.readFile(defaultsPath, 'utf8'));
  if (defaults.latestUrl !== `${workerEndpoint}/latest.json`) {
    throw new Error(`Defaults did not use entered player feed: ${JSON.stringify(defaults)}`);
  }
  if (
    defaults.packs?.ptb?.packId !== 'a-hard-time-ptb'
    || defaults.packs?.ptb?.name !== 'A Hard Time PTB'
    || defaults.packs?.ptb?.latestUrl !== `${workerEndpoint}/ptb/latest.json`
    || defaults.packs?.ptb?.instanceDir
  ) {
    throw new Error(`Defaults did not write a platform-neutral isolated PTB feed: ${JSON.stringify(defaults.packs)}`);
  }
  if (defaults.instanceDir || defaults.minecraftLauncher?.rootDir) {
    throw new Error(`Defaults should stay platform-neutral: ${JSON.stringify(defaults)}`);
  }
  if (defaults.minecraftLauncher?.memoryMb !== 4096) {
    throw new Error(`Defaults should keep 4 GB baseline RAM: ${JSON.stringify(defaults.minecraftLauncher)}`);
  }
  if (defaults.launcherProof?.enabled !== true || defaults.launcherProof?.required !== true || defaults.launcherProof?.baseUrl !== `${workerEndpoint}/` || defaults.launcherProof?.keyId !== 'aht-launcher-proof-v1') {
    throw new Error(`Defaults must require launcher proof through the Worker: ${JSON.stringify(defaults.launcherProof)}`);
  }
  if (Object.prototype.hasOwnProperty.call(defaults, 'developer')) {
    throw new Error(`Player defaults must not include developer config: ${JSON.stringify(defaults.developer)}`);
  }
  const uiProof = await evaluate(client, `
    ({
      state: document.querySelector('#releaseCheckState').textContent,
      title: document.querySelector('#releaseCheckTitle').textContent,
      detail: document.querySelector('#releaseCheckDetail').textContent,
      buttonText: document.querySelector('#writeDefaultsButton').textContent.trim()
    })
  `);

  console.log(JSON.stringify({
    ok: true,
    root,
    defaultsPath,
    uiProof,
    defaults: {
      latestUrl: defaults.latestUrl,
      ptbLatestUrl: defaults.packs?.ptb?.latestUrl,
      proxyBaseUrl: defaults.curseforge?.proxyBaseUrl,
      baseUrl: defaults.sync?.baseUrl,
      developerDefaults: Object.prototype.hasOwnProperty.call(defaults, 'developer'),
      memoryMb: defaults.minecraftLauncher?.memoryMb,
      launcherProofRequired: defaults.launcherProof?.required,
      launcherProofBaseUrl: defaults.launcherProof?.baseUrl,
      platformNeutral: !defaults.instanceDir && !defaults.minecraftLauncher?.rootDir
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
