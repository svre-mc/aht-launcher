import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10160);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-update-logs-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
const updateLogRequests = [];
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

const logs = [
  {
    id: 'log-4',
    title: 'Fourth newest',
    text: 'Newest update log from developer launcher.',
    version: '2.8.4',
    publishedAt: '2026-06-24T12:04:00.000Z',
    author: 'admin'
  },
  {
    id: 'log-3',
    title: 'Third newest',
    text: 'Second visible update log.',
    version: '2.8.3',
    publishedAt: '2026-06-24T12:03:00.000Z',
    author: 'admin'
  },
  {
    id: 'log-2',
    title: 'Second newest',
    text: 'Third visible update log.',
    version: '2.8.2',
    publishedAt: '2026-06-24T12:02:00.000Z',
    author: 'admin'
  },
  {
    id: 'log-1',
    title: 'Old hidden',
    text: 'This older log must not render on the player home screen.',
    version: '2.8.1',
    publishedAt: '2026-06-24T12:01:00.000Z',
    author: 'admin'
  }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: true, sendLocalChanges: true, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  developer: { adminBaseUrl: `${workerEndpoint}/`, defaultOutDir: path.join(root, 'release'), defaultCacheModsDir: '', r2Bucket: 'ahtlauncher' },
  minecraftLauncher: { enabled: false, rootDir: mcRoot, profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 4096 },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'smoke-install',
  minecraftUsername: 'SmokeUser'
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ packId: 'a-hard-time-dregora', name: 'A Hard Time', version: '2.8.4', required: true, zip: { url: 'packs/a-hard-time-2.8.4.zip' } }));
    return;
  }
  if (url.pathname === '/api/update-logs') {
    updateLogRequests.push(url.search);
    const limit = Math.max(0, Math.min(Number(url.searchParams.get('limit') || '3'), 50));
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ logs: logs.slice(0, limit) }));
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
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
  await waitFor(client, "document.querySelectorAll('#updateLogGrid .feature-card').length === 3", 'three update-log cards');
  const proof = await evaluate(client, `
    (() => {
      const cards = [...document.querySelectorAll('#updateLogGrid .feature-card')].map((card) => ({
        title: card.querySelector('strong')?.textContent || '',
        meta: card.querySelector('span')?.textContent || '',
        body: card.querySelector('p')?.textContent || '',
        large: card.classList.contains('large')
      }));
      return {
        hidden: document.querySelector('#updateLogGrid').hidden,
        count: cards.length,
        cards,
        fullText: document.querySelector('#updateLogGrid').textContent
      };
    })()
  `);
  const titles = proof.cards.map((card) => card.title);
  if (proof.hidden || proof.count !== 3) {
    throw new Error(`Expected exactly three visible update-log cards: ${JSON.stringify(proof)}`);
  }
  if (titles.join('|') !== 'Fourth newest|Third newest|Second newest') {
    throw new Error(`Player update logs are not the latest three in order: ${JSON.stringify(proof)}`);
  }
  if (proof.fullText.includes('Old hidden') || proof.fullText.includes('This older log must not render')) {
    throw new Error(`Old fourth log rendered unexpectedly: ${JSON.stringify(proof)}`);
  }
  if (!proof.cards[0].large || proof.cards.slice(1).some((card) => card.large)) {
    throw new Error(`Only the newest update log should be the large card: ${JSON.stringify(proof)}`);
  }
  if (!updateLogRequests.some((query) => query.includes('limit=3'))) {
    throw new Error(`Player did not request update logs with limit=3: ${JSON.stringify(updateLogRequests)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    requestQueries: updateLogRequests,
    titles,
    cardCount: proof.count,
    hidden: proof.hidden
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
