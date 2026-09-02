import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createDeviceCredential } from '../src/deviceIdentity.js';

const port = Number(process.argv[2] || 10060);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-account-ui-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
const requests = [];
const recoverySecrets = new Map([
  ['takenuser_1', 'TakenUser_secure_launcher_credential_000000000001'],
  ['disabledprof', 'DisabledProf_secure_launcher_credential_0000000001']
]);
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
  minecraftLauncher: { enabled: false, rootDir: mcRoot, profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 6144, autoImportAccount: true, syncDefaultRoots: false },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(mcRoot, 'launcher_accounts.json'), {
  activeAccountLocalId: 'taken-account',
  accounts: {
    'taken-account': {
      type: 'Xbox',
      minecraftProfile: { name: 'TakenUser_1' }
    }
  }
});
await writeJson(path.join(userData, 'account-recovery', 'takenuser_1.json'), {
  schemaVersion: 1,
  username: 'TakenUser_1',
  secret: recoverySecrets.get('takenuser_1'),
  createdAt: '2026-08-03T00:00:00.000Z'
});
const fixtureDeviceCredential = createDeviceCredential();
await writeJson(path.join(userData, 'device-identity.json'), {
  schemaVersion: fixtureDeviceCredential.schemaVersion,
  protocol: fixtureDeviceCredential.protocol,
  algorithm: fixtureDeviceCredential.algorithm,
  deviceId: fixtureDeviceCredential.deviceId,
  publicKey: fixtureDeviceCredential.publicKey,
  privateKey: {
    value: Buffer.from(fixtureDeviceCredential.privateKey, 'utf8').toString('base64'),
    encrypted: false
  },
  createdAt: fixtureDeviceCredential.createdAt,
  protectedBy: 'explicit-test-fallback'
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/api/users/register' && request.method === 'POST') {
    const body = await readBody(request);
    const recoveryHeader = String(request.headers['x-aht-launcher-recovery'] || '');
    requests.push({ ...body, recoveryHeader });
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    const duplicateUsernames = new Set(['takenuser_1', 'disabledprof']);
    const normalizedUsername = String(body.username || '').toLowerCase();
    const secureRecovery = Boolean(
      body.recoverExistingUsername
      && body.minecraftAccountMatched
      && recoveryHeader === recoverySecrets.get(normalizedUsername)
    );
    if (duplicateUsernames.has(normalizedUsername) && !secureRecovery) {
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
  env: {
    ...process.env,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_USER_DATA: userData,
    AHT_ALLOW_UNENCRYPTED_DEVICE_KEY: '1',
    ELECTRON_ENABLE_LOGGING: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
let childOutput = '';
const captureChildOutput = (chunk) => {
  childOutput = `${childOutput}${String(chunk)}`.slice(-8000);
};
child.stdout?.on('data', captureChildOutput);
child.stderr?.on('data', captureChildOutput);

let client;
try {
  const target = await Promise.race([
    waitForTarget(),
    new Promise((_, reject) => child.once('exit', (code, signal) => reject(new Error(`Electron exited before the debugger target (code ${code}, signal ${signal || 'none'}). ${childOutput}`))))
  ]);
  client = await connect(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await client.call('Page.bringToFront');
  await client.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'launcher DOM');
  const recovery = await waitFor(client, `
    window.aht.getStatus().then((status) => {
      if (status.identity?.minecraftUsername !== 'TakenUser_1') return false;
      renderStatus(status);
      return ({
          status,
          playerLabel: document.querySelector('#playerLabelView')?.textContent || '',
          usernameSurfaceAbsent: !document.querySelector('#accountOverlay')
            && !document.querySelector('#minecraftUsernameInput')
            && !document.querySelector('#playerLabelInput')
            && typeof window.aht.accountRegister === 'undefined'
        });
    })
  `, 'automatic Minecraft Launcher account recovery');
  const recoveredIdentity = JSON.parse(fs.readFileSync(path.join(userData, 'identity.json'), 'utf8'));
  const storedConfig = JSON.parse(fs.readFileSync(path.join(userData, 'launcher.config.json'), 'utf8'));
  const takenRequests = requests.filter((item) => item.username === 'TakenUser_1');
  if (
    !recovery?.usernameSurfaceAbsent
    || recovery.playerLabel !== 'TakenUser_1'
    || recovery.status?.config?.minecraftLauncher?.enabled !== true
    || storedConfig.minecraftLauncher?.enabled !== true
    || recoveredIdentity.minecraftUsername !== 'TakenUser_1'
    || recoveredIdentity.usernameRegistrationMode !== 'minecraft-launcher'
  ) {
    throw new Error(`Minecraft Launcher username recovery did not persist: ${JSON.stringify({ recovery, recoveredIdentity })}`);
  }
  if (takenRequests.length !== 2 || takenRequests[1].minecraftAccountMatched !== true || takenRequests[1].recoverExistingUsername !== true) {
    throw new Error(`Recovery did not retry with a Minecraft Launcher account match: ${JSON.stringify(requests)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    usernameSurfaceAbsent: recovery.usernameSurfaceAbsent,
    profileForcedEnabled: storedConfig.minecraftLauncher.enabled,
    registeredUsername: recoveredIdentity.minecraftUsername,
    recoveryMode: recoveredIdentity.usernameRegistrationMode,
    requests: requests.map((item) => ({ username: item.username, installId: item.installId, packId: item.packId, recovered: Boolean(item.recoverExistingUsername && item.minecraftAccountMatched) }))
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
