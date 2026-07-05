import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10060);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-account-ui-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
const requests = [];
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

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
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
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: true, sendLocalChanges: true, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  developer: { adminBaseUrl: `${workerEndpoint}/`, defaultOutDir: path.join(root, 'release'), defaultCacheModsDir: '', r2Bucket: 'ahtlauncher' },
  minecraftLauncher: { enabled: false, rootDir: mcRoot, profileId: 'a-hard-time', profileName: 'A Hard Time', memoryMb: 4096, autoImportAccount: false },
  playCommand: { command: '', args: [], cwd: instanceDir }
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/api/users/register' && request.method === 'POST') {
    const body = await readBody(request);
    requests.push(body);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    const duplicateUsernames = new Set(['takenuser_1', 'disabledprof']);
    if (duplicateUsernames.has(String(body.username || '').toLowerCase()) && !(body.recoverExistingUsername && body.minecraftAccountMatched)) {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: 'That username is not available.' }));
      return;
    }
    response.statusCode = 200;
    response.end(JSON.stringify({ ok: true, username: body.username, key: `accounts/usernames/${String(body.username).toLowerCase()}.json`, recovered: Boolean(body.recoverExistingUsername && body.minecraftAccountMatched) }));
    return;
  }
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ packId: 'a-hard-time-dregora', name: 'A Hard Time', version: '2.8.2', required: true, zip: { url: 'packs/a-hard-time-2.8.2.zip' } }));
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
  await waitFor(client, "document.readyState === 'complete' && document.querySelector('#accountOverlay')", 'account DOM');
  await waitFor(client, "document.querySelector('#accountOverlay').hidden === false", 'account overlay visible');

  await evaluate(client, `
    (() => {
      document.querySelector('#minecraftUsernameInput').value = 'TakenUser_1';
      document.querySelector('#accountForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()
  `);
  const duplicateProof = await waitFor(client, `
    (() => {
      const error = document.querySelector('#accountError').textContent.trim();
      return /not available/i.test(error) && document.querySelector('#accountOverlay').hidden === false
        ? { error, overlayHidden: document.querySelector('#accountOverlay').hidden }
        : false;
    })()
  `, 'duplicate username error');
  const duplicateAfterRefresh = await evaluate(client, `
    window.aht.getStatus()
      .then((status) => {
        renderStatus(status);
        return {
          error: document.querySelector('#accountError').textContent.trim(),
          overlayHidden: document.querySelector('#accountOverlay').hidden
        };
      })
  `);
  if (!/not available/i.test(duplicateAfterRefresh.error || '') || duplicateAfterRefresh.overlayHidden) {
    throw new Error(`Duplicate username error was not preserved after status refresh: ${JSON.stringify(duplicateAfterRefresh)}`);
  }

  await evaluate(client, `
    (() => {
      document.querySelector('#minecraftUsernameInput').value = 'FreshUser_1';
      document.querySelector('#accountForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()
  `);
  await waitFor(client, "document.querySelector('#accountOverlay').hidden === true && document.querySelector('#playerLabelView').textContent === 'FreshUser_1'", 'successful username registration');
  const status = await evaluate(client, 'window.aht.getStatus()');
  const identity = JSON.parse(fs.readFileSync(path.join(userData, 'identity.json'), 'utf8'));
  if (status.identity?.minecraftUsername !== 'FreshUser_1' || identity.minecraftUsername !== 'FreshUser_1') {
    throw new Error(`Successful retry did not persist username: ${JSON.stringify({ status: status.identity, identity })}`);
  }
  if (requests.length !== 2 || requests[0].username !== 'TakenUser_1' || requests[1].username !== 'FreshUser_1') {
    throw new Error(`Unexpected username registration requests before recovery: ${JSON.stringify(requests)}`);
  }

  await writeJson(path.join(mcRoot, 'launcher_accounts.json'), {
    activeAccountLocalId: 'taken-account',
    accounts: {
      'taken-account': {
        type: 'Xbox',
        minecraftProfile: { name: 'TakenUser_1' }
      }
    }
  });
  const configPath = path.join(userData, 'launcher.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.minecraftLauncher = {
    ...config.minecraftLauncher,
    enabled: true,
    rootDir: mcRoot,
    autoImportAccount: true
  };
  await writeJson(configPath, config);
  const recovery = await evaluate(client, `window.aht.accountRegister('TakenUser_1')`);
  const recoveredIdentity = JSON.parse(fs.readFileSync(path.join(userData, 'identity.json'), 'utf8'));
  const takenRequests = requests.filter((item) => item.username === 'TakenUser_1');
  if (!recovery?.ok || recoveredIdentity.minecraftUsername !== 'TakenUser_1' || recoveredIdentity.usernameRegistrationMode !== 'minecraft-launcher-recovery') {
    throw new Error(`Minecraft Launcher username recovery did not persist: ${JSON.stringify({ recovery, recoveredIdentity })}`);
  }
  if (requests.length !== 4 || takenRequests.length !== 3 || takenRequests[2].minecraftAccountMatched !== true || takenRequests[2].recoverExistingUsername !== true) {
    throw new Error(`Recovery did not retry with a Minecraft Launcher account match: ${JSON.stringify(requests)}`);
  }

  await writeJson(path.join(mcRoot, 'launcher_accounts.json'), {
    activeAccountLocalId: 'disabled-profile-account',
    accounts: {
      'disabled-profile-account': {
        type: 'Xbox',
        minecraftProfile: { name: 'DisabledProf' }
      }
    }
  });
  config.minecraftLauncher = {
    ...config.minecraftLauncher,
    enabled: false,
    rootDir: mcRoot,
    autoImportAccount: true
  };
  await writeJson(configPath, config);
  const disabledProfileRecovery = await evaluate(client, `window.aht.accountRegister('DisabledProf')`);
  const disabledProfileIdentity = JSON.parse(fs.readFileSync(path.join(userData, 'identity.json'), 'utf8'));
  const disabledProfileRequests = requests.filter((item) => item.username === 'DisabledProf');
  if (
    !disabledProfileRecovery?.ok
    || disabledProfileIdentity.minecraftUsername !== 'DisabledProf'
    || disabledProfileIdentity.usernameRegistrationMode !== 'minecraft-launcher-recovery'
    || disabledProfileRequests.length !== 2
    || disabledProfileRequests[1].minecraftAccountMatched !== true
    || disabledProfileRequests[1].recoverExistingUsername !== true
  ) {
    throw new Error(`Disabled Minecraft profile toggle blocked account recovery: ${JSON.stringify({ disabledProfileRecovery, disabledProfileIdentity, disabledProfileRequests })}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    duplicateProof,
    duplicateAfterRefresh,
    registeredUsername: disabledProfileIdentity.minecraftUsername,
    recoveryMode: disabledProfileIdentity.usernameRegistrationMode,
    requests: requests.map((item) => ({ username: item.username, installId: item.installId, packId: item.packId, recovered: Boolean(item.recoverExistingUsername && item.minecraftAccountMatched) }))
  }, null, 2));} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
