import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10210);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-dev-log-auth-'));
const userData = path.join(root, 'userData');
const loginCalls = [];
const updateLogAuthHeaders = [];
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

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJsonBody(request) {
  const text = await new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
  return text ? JSON.parse(text) : {};
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
  instanceDir: path.join(root, 'instance'),
  latestUrl: `${workerEndpoint}/latest.json`,
  sync: { enabled: false, sendLocalChanges: false, baseUrl: `${workerEndpoint}/`, playerLabel: 'DevSmoke' },
  developer: { adminBaseUrl: `${workerEndpoint}/`, r2Bucket: 'ahtlauncher' },
  minecraftLauncher: { enabled: false, rootDir: path.join(root, 'minecraft'), profileName: 'A Hard Time', memoryMb: 4096 }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'dev-smoke-install',
  minecraftUsername: 'DevSmoke'
});

const logs = [
  { id: 'log-1', title: 'Auth Refresh Works', subtitle: 'Developer list keeps media metadata.', text: 'Unauthorized retry recovered.', version: '2.8.5', publishedAt: '2026-06-25T12:00:00.000Z', image: { type: 'image', url: 'https://packs.example.com/update-media/auth.webp' }, media: { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }
];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ packId: 'a-hard-time-dregora', name: 'A Hard Time', version: '2.8.5', required: true, zip: { url: 'packs/a-hard-time-2.8.5.zip' } }));
    return;
  }
  if (url.pathname === '/admin/login') {
    const body = await readJsonBody(request);
    loginCalls.push(body);
    response.statusCode = body.username === 'admin' && body.password === 'test-dev-password' ? 200 : 401;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(response.statusCode === 200
      ? { token: loginCalls.length === 1 ? 'stale-token' : 'fresh-token', expiresAt: new Date(Date.now() + 3600000).toISOString() }
      : { error: 'Invalid username or password' }));
    return;
  }
  if (url.pathname === '/admin/update-logs') {
    const auth = request.headers.authorization || '';
    updateLogAuthHeaders.push(auth);
    if (auth !== 'Bearer fresh-token') {
      response.statusCode = 401;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ logs }));
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
    AHT_ALLOW_DEVELOPER: '1',
    AHT_LAUNCHER_SOURCE_ROOT: process.cwd(),
    AHT_DEVELOPER_USERNAME: 'admin',
    AHT_DEVELOPER_PASSWORD: 'test-dev-password',
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
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'renderer');
  const proof = await evaluate(client, `
    (async () => {
      await window.aht.devLogin({ username: 'admin', password: 'test-dev-password' });
      return await window.aht.devUpdateLogs(20);
    })()
  `);
  if (proof.logs?.[0]?.title !== 'Auth Refresh Works' || proof.logs?.[0]?.image?.url !== 'https://packs.example.com/update-media/auth.webp' || proof.logs?.[0]?.media?.type !== 'youtube') {
    throw new Error(`Developer update logs were not returned after auth refresh: ${JSON.stringify(proof)}`);
  }
  if (loginCalls.length !== 2) {
    throw new Error(`Expected stale-token login then refresh login, got ${JSON.stringify(loginCalls)}`);
  }
  if (updateLogAuthHeaders.join('|') !== 'Bearer stale-token|Bearer fresh-token') {
    throw new Error(`Expected update-log retry with fresh token, got ${JSON.stringify(updateLogAuthHeaders)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    loginCalls: loginCalls.length,
    updateLogAuthHeaders,
    title: proof.logs[0].title,
    media: proof.logs[0].media?.type || '',
    image: proof.logs[0].image?.url || ''
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
