import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { workerLauncherProofFixture } from './helpers/launcher-proof-fixture.mjs';

const port = Number(process.argv[2] || 10190);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-account-switch-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
const registrations = [];
const launcherUpdateEvents = [];
let rejectFirstLauncherUpdate = true;
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

await writeJson(path.join(mcRoot, 'launcher_accounts.json'), {
  activeAccountLocalId: 'active',
  accounts: {
    old: { type: 'Xbox', minecraftProfile: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'OldAHTUser' } },
    active: { type: 'Xbox', minecraftProfile: { id: '0123456789abcdef0123456789abcdef', name: 'StunningWolf22' } }
  }
});
await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: true, sendLocalChanges: true, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-attestation-v2' },
  developer: { adminBaseUrl: `${workerEndpoint}/`, r2Bucket: 'ahtlauncher' },
  minecraftLauncher: { enabled: false, rootDir: mcRoot, profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 6144 },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'same-install',
  minecraftUsername: 'OldAHTUser',
  usernameRegistrationMode: 'worker',
  usernameRegisteredAt: '2026-06-24T00:00:00.000Z'
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ packId: 'a-hard-time-dregora', name: 'A Hard Time', version: '2.8.4', required: true, zip: { url: 'packs/a-hard-time-2.8.4.zip' } }));
    return;
  }
  if (url.pathname === '/api/launcher-proof' && request.method === 'POST') {
    const body = JSON.parse(await new Promise((resolve) => {
      let text = '';
      request.on('data', (chunk) => { text += chunk; });
      request.on('end', () => resolve(text || '{}'));
    }));
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(workerLauncherProofFixture(body)));
    return;
  }
  if (url.pathname === '/api/users/register') {
    const body = JSON.parse(await new Promise((resolve) => {
      let text = '';
      request.on('data', (chunk) => { text += chunk; });
      request.on('end', () => resolve(text || '{}'));
    }));
    registrations.push(body);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: true, username: body.username, minecraftUuid: body.minecraftUuid, key: `accounts/usernames/${String(body.username).toLowerCase()}.json` }));
    return;
  }
  if (url.pathname === '/api/events' && request.method === 'POST') {
    const body = JSON.parse(await new Promise((resolve) => {
      let text = '';
      request.on('data', (chunk) => { text += chunk; });
      request.on('end', () => resolve(text || '{}'));
    }));
    launcherUpdateEvents.push(body);
    if (rejectFirstLauncherUpdate) {
      rejectFirstLauncherUpdate = false;
      response.statusCode = 503;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Temporary launcher update telemetry failure' }));
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: true, launcherUpdateKey: `launcher-updates/${body.appVersion}.json`, accountRefreshed: true }));
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
    AHT_APP_DEFAULTS: path.join(userData, 'launcher.config.json'),
    AHT_TEST_USER_DATA: userData,
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
  await waitFor(client, "document.querySelector('#playerLabelView').textContent === 'StunningWolf22'", 'active launcher account imported');
  const proof = await evaluate(client, `
    (async () => {
      const status = await window.aht.getStatus();
      return {
        playerLabel: document.querySelector('#playerLabelView').textContent,
        minecraftUsername: status.identity.minecraftUsername,
        minecraftUuid: status.identity.minecraftUuid,
        mode: status.identity.usernameRegistrationMode,
        detected: status.identity.minecraftLauncherDetectedUsername,
        warning: status.identity.minecraftUsernameSyncWarning || '',
        accountHidden: document.querySelector('#accountOverlay').hidden
      };
    })()
  `);
  if (
    proof.minecraftUsername !== 'StunningWolf22'
    || proof.minecraftUuid !== '01234567-89ab-cdef-0123-456789abcdef'
    || proof.mode !== 'minecraft-launcher'
    || proof.warning
  ) {
    throw new Error(`Active Minecraft Launcher account did not replace old AHT username: ${JSON.stringify(proof)}`);
  }
  if (
    registrations.length !== 1
    || registrations[0].username !== 'StunningWolf22'
    || registrations[0].installId !== 'same-install'
    || registrations[0].minecraftUuid !== '01234567-89ab-cdef-0123-456789abcdef'
  ) {
    throw new Error(`Expected one account-import registration for StunningWolf22: ${JSON.stringify(registrations)}`);
  }

  for (let attempt = 0; attempt < 80 && launcherUpdateEvents.length < 1; attempt += 1) {
    await sleep(100);
  }
  await sleep(200);
  await evaluate(client, 'Promise.all([window.aht.getStatus(), window.aht.getStatus()])');
  for (let attempt = 0; attempt < 80 && launcherUpdateEvents.length < 2; attempt += 1) {
    await sleep(100);
  }
  const reportedIdentity = JSON.parse(fs.readFileSync(path.join(userData, 'identity.json'), 'utf8'));
  const updateEvent = launcherUpdateEvents[1];
  if (
    launcherUpdateEvents.length !== 2
    || updateEvent?.event?.type !== 'launcher_update_completed'
    || updateEvent?.minecraftUsername !== 'StunningWolf22'
    || updateEvent?.minecraftUuid !== '01234567-89ab-cdef-0123-456789abcdef'
    || !Array.isArray(reportedIdentity.reportedLauncherVersions)
    || !reportedIdentity.reportedLauncherVersions.includes(updateEvent.appVersion)
    || reportedIdentity.lastReportedLauncherVersion !== updateEvent.appVersion
  ) {
    throw new Error(`Launcher update history did not retry once and persist after a transient failure: ${JSON.stringify({ launcherUpdateEvents, reportedIdentity })}`);
  }

  // Simulate an identity written by an older launcher before the Worker
  // registration API was available. A later status refresh must re-register
  // the same player once, without changing the install ID or username.
  await writeJson(path.join(userData, 'identity.json'), {
    ...reportedIdentity,
    remoteRegistrationAttemptedAt: '2020-01-01T00:00:00.000Z',
    remoteRegistrationConfirmedAt: '',
    remoteRegistrationWorkerBaseUrl: ''
  });
  const registrationCountBeforeRefresh = registrations.length;
  await evaluate(client, 'window.aht.getStatus()');
  for (let attempt = 0; attempt < 80 && registrations.length <= registrationCountBeforeRefresh; attempt += 1) {
    await sleep(100);
  }
  const refreshedIdentity = JSON.parse(fs.readFileSync(path.join(userData, 'identity.json'), 'utf8'));
  const refreshRegistration = registrations[registrations.length - 1];
  if (
    registrations.length !== registrationCountBeforeRefresh + 1
    || refreshRegistration?.username !== 'StunningWolf22'
    || refreshRegistration?.installId !== 'same-install'
    || refreshedIdentity.minecraftUsername !== 'StunningWolf22'
    || !refreshedIdentity.remoteRegistrationConfirmedAt
    || refreshedIdentity.minecraftUsernameSyncWarning
  ) {
    throw new Error(`Stale launcher identity did not recover its Worker player-data registration: ${JSON.stringify({ refreshRegistration, refreshedIdentity, registrations })}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    proof,
    registrations,
    refreshRegistration,
    launcherUpdateEvent: updateEvent,
    reportedLauncherVersions: reportedIdentity.reportedLauncherVersions
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
