import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { workerLauncherProofFixture } from './helpers/launcher-proof-fixture.mjs';

const port = Number(process.argv[2] || 10210);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const alternateWorkerPort = workerPort + 1;
const alternateWorkerEndpoint = `http://127.0.0.1:${alternateWorkerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-dev-log-auth-'));
const userData = path.join(root, 'userData');
const stableInstanceDir = path.join(root, 'AHT', 'A Hard Time Developer');
const ptbInstanceDir = path.join(root, 'AHT', 'A Hard Time PTB');
const playerdataSentinel = path.join(ptbInstanceDir, 'saves', 'SmokeWorld', 'playerdata', 'preserve-me.dat');
const loginCalls = [];
const updateLogAuthHeaders = [];
const launcherProofAuthHeaders = [];
const alternateOriginSummaryAuthHeaders = [];
const usernameRegistrationRequests = [];
const requestPaths = [];
let rootLoginCount = 0;
let loginMode = 'normal';
let rejectAllLauncherProofs = false;
let rejectDeveloperRegistration = false;
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
        const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        const page = pages.find((target) => /(?:^|\/)index\.html(?:[?#]|$)/i.test(String(target.url || '')));
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
  let result;
  try {
    result = await client.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
  } catch (error) {
    error.message = `${error.message}; expression: ${String(expression).replace(/\s+/g, ' ').trim().slice(0, 240)}`;
    throw error;
  }
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

await fsp.mkdir(path.dirname(playerdataSentinel), { recursive: true });
await fsp.writeFile(playerdataSentinel, 'playerdata-preserved', 'utf8');
await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir: ptbInstanceDir,
  latestUrl: `${workerEndpoint}/ptb/latest.json`,
  packs: {
    ptb: {
      packId: 'a-hard-time-ptb',
      name: 'A Hard Time PTB',
      instanceDir: ptbInstanceDir,
      latestUrl: `${workerEndpoint}/ptb/latest.json`
    }
  },
  curseforge: { proxyBaseUrl: `${workerEndpoint}/ptb/cf/` },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: `${workerEndpoint}/`, playerLabel: 'DevSmoke' },
  developer: { adminBaseUrl: `${workerEndpoint}/ptb/`, r2Bucket: 'ahtlauncher' },
  launcherUpdate: { enabled: true, latestUrl: `${workerEndpoint}/ptb/launcher/latest.json` },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/ptb/`, keyId: 'aht-launcher-proof-v1' },
  social: { enabled: true, baseUrl: `${workerEndpoint}/`, stateUrl: 'api/social', actionUrl: 'api/social/actions' },
  minecraftLauncher: {
    enabled: false,
    rootDir: path.join(root, 'minecraft'),
    profileId: 'a-hard-time-developer',
    profileName: 'A Hard Time PTB',
    memoryMb: 6144
  },
  playCommand: { command: '', args: [], cwd: ptbInstanceDir }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'dev-smoke-install',
  minecraftUsername: 'DevSmoke'
});
await writeJson(path.join(stableInstanceDir, '.aht-launcher', 'launcher-proof.json'), {
  protocol: 'aht-launcher-proof-v1',
  schemaVersion: 1,
  trusted: true,
  source: 'worker',
  token: 'existing.player.proof',
  payload: {
    protocol: 'aht-launcher-proof-v1',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    packId: 'a-hard-time-dregora',
    latestVersion: '2.8.5',
    installedVersion: '',
    minecraftUsername: 'DevSmoke',
    installId: 'dev-smoke-install',
    instanceDirHash: crypto.createHash('sha256').update(path.resolve(stableInstanceDir)).digest('hex'),
    launcherChannel: 'player',
    developerClient: false,
    developerClientBypass: false,
    modIntegrityBypass: false
  },
  signature: { alg: 'HS256', kid: 'smoke', value: 'existing-player-signature' }
});

const logs = [
  { id: 'log-1', title: 'Auth Refresh Works', subtitle: 'Developer list keeps media metadata.', text: 'Unauthorized retry recovered.', version: '2.8.5', publishedAt: '2026-06-25T12:00:00.000Z', image: { type: 'image', url: 'https://packs.example.com/update-media/auth.webp' }, media: { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }
];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  requestPaths.push(`${request.method} ${url.pathname}`);
  const sendJson = (status, body) => {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/latest.json') {
    sendJson(200, { packId: 'a-hard-time-dregora', name: 'A Hard Time', version: '2.8.5', required: true, zip: { url: 'packs/a-hard-time-2.8.5.zip' } });
    return;
  }
  if (url.pathname === '/ptb/latest.json') {
    sendJson(200, { packId: 'a-hard-time-ptb', name: 'A Hard Time PTB', channel: 'ptb', version: '2.8.6-ptb.1', required: true, zip: { url: 'ptb/packs/a-hard-time-ptb-2.8.6.zip' } });
    return;
  }
  if (/^\/ptb\/(?:admin|api)\//.test(url.pathname)) {
    sendJson(200, { ok: true, endpoints: ['/admin/login', '/api/launcher-proof'] });
    return;
  }
  if (url.pathname === '/admin/login') {
    const body = await readJsonBody(request);
    loginCalls.push(body);
    const requestLoginMode = loginMode;
    await sleep(requestLoginMode === 'timeout' ? 500 : 75);
    const status = body.username === 'admin' && body.password === 'test-dev-password' ? 200 : 401;
    if (status !== 200) {
      sendJson(status, { error: 'Invalid username or password' });
      return;
    }
    if (requestLoginMode === 'expired') {
      sendJson(200, { token: 'expired-token', expiresAt: new Date(Date.now() - 60_000).toISOString() });
      return;
    }
    if (requestLoginMode === 'missing-expiry') {
      sendJson(200, { token: 'missing-expiry-token' });
      return;
    }
    rootLoginCount += 1;
    sendJson(200, { token: rootLoginCount === 1 ? 'stale-token' : 'fresh-token', expiresAt: new Date(Date.now() + 3600000).toISOString() });
    return;
  }
  if (url.pathname === '/api/launcher-proof') {
    const auth = request.headers.authorization || '';
    launcherProofAuthHeaders.push(auth);
    const payload = await readJsonBody(request);
    if (rejectAllLauncherProofs || auth !== 'Bearer fresh-token') {
      sendJson(401, { error: 'Developer launcher proof requires developer authentication.' });
      return;
    }
    if (rejectDeveloperRegistration) {
      sendJson(403, { error: 'Minecraft username is not registered to this launcher install.' });
      return;
    }
    sendJson(200, workerLauncherProofFixture(payload));
    return;
  }
  if (url.pathname === '/api/users/register') {
    usernameRegistrationRequests.push(await readJsonBody(request));
    sendJson(409, { error: 'That username is not available.' });
    return;
  }
  if (url.pathname === '/api/social') {
    sendJson(200, { username: 'DevSmoke', friends: [], blocked: [], requests: [] });
    return;
  }
  if (url.pathname === '/admin/launcher-downloads') {
    if (request.headers.authorization !== 'Bearer fresh-token') {
      sendJson(401, { error: 'Unauthorized' });
      return;
    }
    sendJson(200, {
      downloads: [
        { id: 'download-2', receivedAt: '2026-08-03T16:15:00.000Z', minecraftUsername: 'PlayerOne', minecraftUuid: '0123456789abcdef0123456789abcdef', ipv4: '', platformKey: 'macos-arm64', platform: 'Mac', launcherVersion: '0.1.83', fileName: 'AHT-Launcher-macOS-arm64-0.1.83.dmg' },
        { id: 'download-1', receivedAt: '2026-08-03T15:15:00.000Z', minecraftUsername: 'PlayerTwo', minecraftUuid: 'fedcba0987654321fedcba0987654321', ipv4: '203.0.113.30', platformKey: 'windows-x64', platform: 'Windows', launcherVersion: '0.1.83', fileName: 'AHT-Launcher-Windows-10-11-0.1.83.exe' }
      ],
      cursor: '',
      hasMore: false,
      appendOnly: true
    });
    return;
  }
  if (url.pathname === '/admin/player-records') {
    if (request.headers.authorization !== 'Bearer fresh-token') {
      sendJson(401, { error: 'Unauthorized' });
      return;
    }
    const cursor = url.searchParams.get('cursor') || '';
    if (!cursor) {
      sendJson(200, {
        players: [{ receivedAt: '2026-08-03T14:15:00.000Z', minecraftUsername: 'PlayerOne', minecraftUuid: '0123456789abcdef0123456789abcdef', ipv4: '203.0.113.10', platform: 'Windows 10/11' }],
        cursor: 'player-page-2',
        hasMore: true,
        currentOnly: true
      });
    } else {
      sendJson(200, {
        players: [{ receivedAt: '2026-08-02T10:30:00.000Z', minecraftUsername: 'PlayerTwo', minecraftUuid: 'fedcba0987654321fedcba0987654321', ipv4: '198.51.100.44', platform: 'macOS Intel' }],
        cursor: '',
        hasMore: false,
        currentOnly: true
      });
    }
    return;
  }
  if (url.pathname === '/admin/launcher-updates') {
    if (request.headers.authorization !== 'Bearer fresh-token') {
      sendJson(401, { error: 'Unauthorized' });
      return;
    }
    sendJson(200, {
      updates: [{ receivedAt: '2026-08-03T15:00:00.000Z', minecraftUsername: 'PlayerOne', minecraftUuid: '01234567-89ab-cdef-0123-456789abcdef', ipv4: '203.0.113.10', platform: 'win32', launcherVersion: '0.1.83' }],
      cursor: '',
      hasMore: false,
      appendOnly: true
    });
    return;
  }
  if (url.pathname === '/admin/access-decisions') {
    if (request.headers.authorization !== 'Bearer fresh-token') {
      sendJson(401, { error: 'Unauthorized' });
      return;
    }
    sendJson(200, { decisions: [], audit: [], currentOnly: true });
    return;
  }
  if (url.pathname === '/admin/player-ipv4-groups') {
    if (request.headers.authorization !== 'Bearer fresh-token') {
      sendJson(401, { error: 'Unauthorized' });
      return;
    }
    sendJson(200, { groups: [], sharedGroups: [], uniqueIpv4: 0, sharedIpv4: 0 });
    return;
  }
  if (url.pathname === '/admin/update-logs') {
    const auth = request.headers.authorization || '';
    updateLogAuthHeaders.push(auth);
    if (auth !== 'Bearer fresh-token') {
      sendJson(401, { error: 'Unauthorized' });
      return;
    }
    sendJson(200, { logs });
    return;
  }
  sendJson(404, { error: 'Not found' });
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));
const alternateServer = http.createServer(async (request, response) => {
  const url = new URL(request.url, alternateWorkerEndpoint);
  const sendJson = (status, body) => {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/admin/login') {
    const body = await readJsonBody(request);
    if (body.username !== 'admin' || body.password !== 'test-dev-password') {
      sendJson(401, { error: 'Invalid username or password' });
      return;
    }
    sendJson(200, { token: 'alternate-origin-token', expiresAt: new Date(Date.now() + 3600000).toISOString() });
    return;
  }
  if (url.pathname === '/admin/summary') {
    const auth = request.headers.authorization || '';
    alternateOriginSummaryAuthHeaders.push(auth);
    if (auth !== 'Bearer alternate-origin-token') {
      sendJson(401, { error: 'Unauthorized' });
      return;
    }
    sendJson(200, { date: '2026-08-03', counts: { installs: 0, repairs: 0, changeReports: 0, failures: 0, uniqueIps: 0 } });
    return;
  }
  sendJson(404, { error: 'Not found' });
});
await new Promise((resolve) => alternateServer.listen(alternateWorkerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_ALLOW_DEVELOPER: '1',
    AHT_LAUNCHER_SOURCE_ROOT: process.cwd(),
    AHT_DEVELOPER_USERNAME: 'admin',
    AHT_DEVELOPER_PASSWORD: 'test-dev-password',
    AHT_TEST_HOOKS: '1',
    AHT_TEST_USER_DATA: userData,
    AHT_TEST_REMOTE_ADMIN_TIMEOUT_MS: '120',
    SystemDrive: root,
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
  await client.call('Page.bringToFront');
  await client.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(client, "document.readyState === 'complete' && window.aht && !document.body.classList.contains('is-booting')", 'revealed renderer');
  const migratedStatus = await waitFor(client, `
    window.aht.getStatus('aht').then((status) => status.config?.latestUrl ? status : false)
  `, 'migrated developer status');
  const migratedConfig = JSON.parse(fs.readFileSync(path.join(userData, 'launcher.config.json'), 'utf8'));
  if (
    migratedConfig.latestUrl !== `${workerEndpoint}/latest.json`
    || path.resolve(migratedConfig.instanceDir) !== path.resolve(stableInstanceDir)
    || path.resolve(migratedConfig.playCommand?.cwd || '') !== path.resolve(stableInstanceDir)
    || migratedConfig.packs?.ptb?.latestUrl !== `${workerEndpoint}/ptb/latest.json`
    || path.resolve(migratedConfig.packs?.ptb?.instanceDir || '') !== path.resolve(ptbInstanceDir)
    || migratedConfig.developer?.adminBaseUrl !== `${workerEndpoint}/`
    || migratedConfig.launcherProof?.baseUrl !== `${workerEndpoint}/`
    || migratedConfig.launcherUpdate?.latestUrl !== `${workerEndpoint}/launcher/latest.json`
    || migratedConfig.curseforge?.proxyBaseUrl !== `${workerEndpoint}/cf/`
    || migratedConfig.minecraftLauncher?.profileName !== 'A Hard Time'
  ) {
    throw new Error(`Poisoned PTB developer config was not migrated safely: ${JSON.stringify(migratedConfig)}`);
  }
  if (path.resolve(migratedStatus.config.instanceDir) !== path.resolve(stableInstanceDir)) {
    throw new Error(`Migrated status still points stable developer Play at PTB: ${migratedStatus.config.instanceDir}`);
  }

  const proof = await evaluate(client, `
    (async () => {
      const login = await window.aht.devLogin({ username: 'admin', password: 'test-dev-password' });
      const social = await window.aht.socialList();
      const launcherDownloads = await window.aht.devLauncherDownloads({ limit: 250 });
      const players = await window.aht.devPlayerRecords({ limit: 250 });
      const launcherUpdates = await window.aht.devLauncherUpdates({ limit: 250 });
      const updateLogs = await window.aht.devUpdateLogs(20);
      return { login, social, launcherDownloads, players, launcherUpdates, updateLogs };
    })()
  `);
  if (!proof.login?.remoteAuthenticated || proof.login?.remotePending) {
    throw new Error(`Developer login returned before Worker authentication was ready: ${JSON.stringify(proof.login)}`);
  }
  if (!proof.social?.available || proof.social?.username !== 'DevSmoke') {
    throw new Error(`Immediate developer proof/social request failed: ${JSON.stringify(proof.social)}`);
  }
  if (proof.launcherDownloads?.downloads?.length !== 2 || proof.launcherDownloads?.downloads?.[0]?.id !== 'download-2') {
    throw new Error(`Developer installer download history did not load append-only data: ${JSON.stringify(proof.launcherDownloads)}`);
  }
  if (proof.players?.players?.[0]?.minecraftUsername !== 'PlayerOne' || proof.players?.currentOnly !== true) {
    throw new Error(`Developer player history did not load canonical read-only data: ${JSON.stringify(proof.players)}`);
  }
  if (proof.launcherUpdates?.updates?.[0]?.launcherVersion !== '0.1.83' || proof.launcherUpdates?.appendOnly !== true) {
    throw new Error(`Developer launcher update history did not load read-only data: ${JSON.stringify(proof.launcherUpdates)}`);
  }
  if (proof.updateLogs?.logs?.[0]?.title !== 'Auth Refresh Works' || proof.updateLogs?.logs?.[0]?.image?.url !== 'https://packs.example.com/update-media/auth.webp' || proof.updateLogs?.logs?.[0]?.media?.type !== 'youtube') {
    throw new Error(`Developer update logs were not returned after auth refresh: ${JSON.stringify(proof)}`);
  }
  if (loginCalls.length !== 2) {
    throw new Error(`Expected stale-token login then refresh login, got ${JSON.stringify(loginCalls)}`);
  }
  const nonEmptyLauncherProofAuthHeaders = launcherProofAuthHeaders.filter(Boolean);
  if (
    nonEmptyLauncherProofAuthHeaders.length < 2
    || nonEmptyLauncherProofAuthHeaders[0] !== 'Bearer stale-token'
    || nonEmptyLauncherProofAuthHeaders.slice(1).some((header) => header !== 'Bearer fresh-token')
  ) {
    throw new Error(`Immediate launcher proof did not replace stale developer auth for every retry: ${JSON.stringify(launcherProofAuthHeaders)}`);
  }
  const developerProofPath = path.join(userData, '.aht-launcher', 'launcher-proof.developer.json');
  const refreshedLauncherProof = JSON.parse(fs.readFileSync(developerProofPath, 'utf8'));
  if (
    refreshedLauncherProof.payload?.launcherChannel !== 'developer'
    || !refreshedLauncherProof.payload?.developerClient
    || !refreshedLauncherProof.payload?.developerClientBypass
    || !refreshedLauncherProof.payload?.modIntegrityBypass
  ) {
    throw new Error(`Developer launcher reused an opposite-channel player proof: ${JSON.stringify(refreshedLauncherProof.payload)}`);
  }
  const preservedPlayerProof = JSON.parse(fs.readFileSync(path.join(stableInstanceDir, '.aht-launcher', 'launcher-proof.json'), 'utf8'));
  if (preservedPlayerProof.token !== 'existing.player.proof' || preservedPlayerProof.payload?.launcherChannel !== 'player') {
    throw new Error(`Developer proof refresh replaced the existing player proof: ${JSON.stringify(preservedPlayerProof)}`);
  }
  if (updateLogAuthHeaders.join('|') !== 'Bearer fresh-token') {
    throw new Error(`Expected update logs to use the refreshed token, got ${JSON.stringify(updateLogAuthHeaders)}`);
  }

  await evaluate(client, 'loadPlayerDownloadHistory()');
  const playerDataUi = await waitFor(client, `
    (() => {
      const downloadRows = [...document.querySelectorAll('#playerDownloadsList .event')];
      const playerRows = [...document.querySelectorAll('#playerRecordsList .event')];
      const updateRows = [...document.querySelectorAll('#playerLauncherUpdatesList .event')];
      if (downloadRows.length !== 2 || playerRows.length !== 2 || updateRows.length !== 1) return false;
      document.querySelector('#playerLauncherUpdatesTab').click();
      const sectionText = document.querySelector('#playerDataTools').textContent;
      return {
        downloadHeaders: [...document.querySelectorAll('#playerDownloadsPanel .event-table-head span')].map((item) => item.textContent.trim()),
        playerHeaders: [...document.querySelectorAll('#playerRecordsPanel .event-table-head span')].map((item) => item.textContent.trim()),
        updateHeaders: [...document.querySelectorAll('#playerLauncherUpdatesPanel .event-table-head span')].map((item) => item.textContent.trim()),
        downloadRows: downloadRows.map((row) => [...row.children].map((item) => item.textContent.trim())),
        playerRows: playerRows.map((row) => [...row.children].map((item) => item.textContent.trim())),
        updateRows: updateRows.map((row) => [...row.children].map((item) => item.textContent.trim())),
        downloadsHidden: document.querySelector('#playerDownloadsPanel').hidden,
        playersHidden: document.querySelector('#playerRecordsPanel').hidden,
        updatesHidden: document.querySelector('#playerLauncherUpdatesPanel').hidden,
        hasSelectedDownload: /Selected Download|Raw data|Shared IPv4|IPv4 source|platform key/i.test(sectionText)
      };
    })()
  `, 'compact paginated Player Data UI');
  const expectedDownloadHeaders = ['Date', 'User', 'IP', 'MC UUID', 'Platform'];
  const expectedPlayerHeaders = ['Date', 'User', 'IP', 'MC UUID', 'Platform'];
  const expectedRegisteredHeaders = ['Last Seen', 'User', 'IP', 'Network', 'Device', 'MC UUID', 'Access', 'Action'];
  if (
    JSON.stringify(playerDataUi.downloadHeaders) !== JSON.stringify(expectedDownloadHeaders)
    || JSON.stringify(playerDataUi.playerHeaders) !== JSON.stringify(expectedRegisteredHeaders)
    || JSON.stringify(playerDataUi.updateHeaders) !== JSON.stringify([...expectedPlayerHeaders, 'Version'])
    || playerDataUi.downloadRows[0]?.[1] !== 'PlayerOne'
    || !playerDataUi.downloadRows[0]?.[2]
    || playerDataUi.downloadRows[0]?.[3] !== '01234567-89ab-cdef-0123-456789abcdef'
    || playerDataUi.downloadRows[0]?.[4] !== 'Mac'
    || playerDataUi.downloadRows[1]?.[1] !== 'PlayerTwo'
    || playerDataUi.downloadRows[1]?.[4] !== 'Windows'
    || playerDataUi.playerRows[0]?.[1] !== 'PlayerOne'
    || playerDataUi.playerRows[0]?.[5] !== '01234567-89ab-cdef-0123-456789abcdef'
    || playerDataUi.playerRows[0]?.[6] !== 'Allowed'
    || playerDataUi.playerRows[0]?.[7] !== 'Manage'
    || playerDataUi.playerRows[1]?.[6] !== 'Allowed'
    || playerDataUi.updateRows[0]?.[5] !== '0.1.83'
    || !playerDataUi.downloadsHidden
    || !playerDataUi.playersHidden
    || playerDataUi.updatesHidden
    || playerDataUi.hasSelectedDownload
  ) {
    throw new Error(`Player Data UI is not compact and professional: ${JSON.stringify(playerDataUi)}`);
  }
  await evaluate(client, `(() => {
    developerAuthenticated = true;
    document.body.classList.remove('dev-locked');
    document.querySelector('#developerLoginScreen').hidden = true;
    document.querySelector('#developerConsole').hidden = false;
    document.querySelector('#developerSessionStatus').textContent = 'Session active';
    document.querySelector('#toastStack').replaceChildren();
    activateTab('developer');
    activateDeveloperSection('playerDataTools');
    document.querySelector('#playerDownloadsTab').click();
    return true;
  })()`);
  const playerDataScreenshotPath = path.join(root, 'player-downloads.png');
  const playerDataScreenshot = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fsp.writeFile(playerDataScreenshotPath, Buffer.from(playerDataScreenshot.data, 'base64'));
  await evaluate(client, "document.querySelector('#playerRecordsTab').click()");
  const playerRecordsScreenshotPath = path.join(root, 'player-records.png');
  const playerRecordsScreenshot = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fsp.writeFile(playerRecordsScreenshotPath, Buffer.from(playerRecordsScreenshot.data, 'base64'));
  const badControlRoutes = requestPaths.filter((item) => /\/ptb\/(?:admin|api)\//.test(item));
  if (badControlRoutes.length) {
    throw new Error(`Developer requests still used PTB-prefixed Worker control routes: ${JSON.stringify(badControlRoutes)}`);
  }

  const alternateOriginProof = await evaluate(client, `
    (async () => {
      await window.aht.saveSettings({
        developer: { adminBaseUrl: '${alternateWorkerEndpoint}/' },
        launcherProof: { baseUrl: '${alternateWorkerEndpoint}/' },
        sync: { baseUrl: '${alternateWorkerEndpoint}/' }
      }, 'aht');
      return window.aht.devSummary();
    })()
  `);
  if (alternateOriginProof?.date !== '2026-08-03' || alternateOriginSummaryAuthHeaders.join('|') !== 'Bearer alternate-origin-token') {
    throw new Error(`Admin token was reused across Worker origins: ${JSON.stringify({ alternateOriginProof, alternateOriginSummaryAuthHeaders })}`);
  }

  await evaluate(client, `window.aht.saveSettings({
    developer: { adminBaseUrl: '${workerEndpoint}/' },
    launcherProof: { baseUrl: '${workerEndpoint}/', required: false },
    sync: { baseUrl: '${workerEndpoint}/' }
  }, 'aht')`);
  rejectAllLauncherProofs = true;
  const doubleRejectedProof = await evaluate(client, `
    window.aht.socialList()
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  rejectAllLauncherProofs = false;
  if (doubleRejectedProof.ok || !/developer authentication|trusted token/i.test(doubleRejectedProof.message || '')) {
    throw new Error(`Developer proof did not fail closed after two auth rejections: ${JSON.stringify(doubleRejectedProof)}`);
  }
  rejectDeveloperRegistration = true;
  const outdatedRegistrationGate = await evaluate(client, `
    window.aht.socialList()
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  rejectDeveloperRegistration = false;
  if (
    outdatedRegistrationGate.ok
    || !/Player identity was not changed/i.test(outdatedRegistrationGate.message || '')
    || usernameRegistrationRequests.length !== 0
  ) {
    throw new Error(`Developer fallback attempted to rewrite player identity: ${JSON.stringify({ outdatedRegistrationGate, usernameRegistrationRequests })}`);
  }

  loginMode = 'expired';
  const expiredContract = await evaluate(client, `window.aht.devLogin({ username: 'admin', password: 'test-dev-password' })`);
  if (expiredContract.remoteAuthenticated || !/valid future expiresAt/i.test(expiredContract.remoteError || '')) {
    throw new Error(`Expired Worker token contract was accepted: ${JSON.stringify(expiredContract)}`);
  }
  loginMode = 'missing-expiry';
  const missingExpiryContract = await evaluate(client, `window.aht.devLogin({ username: 'admin', password: 'test-dev-password' })`);
  if (missingExpiryContract.remoteAuthenticated || !/valid future expiresAt/i.test(missingExpiryContract.remoteError || '')) {
    throw new Error(`Missing Worker token expiry contract was accepted: ${JSON.stringify(missingExpiryContract)}`);
  }
  loginMode = 'timeout';
  const timedLogin = await evaluate(client, `
    (async () => {
      const startedAt = Date.now();
      const result = await window.aht.devLogin({ username: 'admin', password: 'test-dev-password' });
      return { result, durationMs: Date.now() - startedAt };
    })()
  `);
  loginMode = 'normal';
  if (timedLogin.result?.remoteAuthenticated || !/timed out/i.test(timedLogin.result?.remoteError || '') || timedLogin.durationMs >= 2000) {
    throw new Error(`Stalled Worker login did not return a bounded local developer session: ${JSON.stringify(timedLogin)}`);
  }

  await evaluate(client, `(() => {
    document.querySelector('#ptbTileButton').click();
    return true;
  })()`);
  await waitFor(client, `(() => {
    const tile = document.querySelector('#ptbTileButton');
    const feed = document.querySelector('#playerFeedUrlInput');
    return tile.classList.contains('active') && /\\/ptb\\/latest\\.json$/i.test(new URL(feed.value).pathname);
  })()`, 'PTB settings view');
  await evaluate(client, `(() => {
    document.querySelector('#toastStack').replaceChildren();
    document.querySelector('#saveSettingsButton').click();
    return true;
  })()`);
  await waitFor(client, `(() => [...document.querySelectorAll('#toastStack .toast.success')]
    .some((toast) => /Settings saved/i.test(toast.textContent)))()`, 'PTB settings save');
  const savedAfterPtb = JSON.parse(fs.readFileSync(path.join(userData, 'launcher.config.json'), 'utf8'));
  if (
    savedAfterPtb.latestUrl !== `${workerEndpoint}/latest.json`
    || path.resolve(savedAfterPtb.instanceDir) !== path.resolve(stableInstanceDir)
    || savedAfterPtb.packs?.ptb?.latestUrl !== `${workerEndpoint}/ptb/latest.json`
    || path.resolve(savedAfterPtb.packs?.ptb?.instanceDir || '') !== path.resolve(ptbInstanceDir)
    || savedAfterPtb.developer?.adminBaseUrl !== `${workerEndpoint}/`
    || savedAfterPtb.launcherProof?.baseUrl !== `${workerEndpoint}/`
    || savedAfterPtb.launcherUpdate?.latestUrl !== `${workerEndpoint}/launcher/latest.json`
  ) {
    throw new Error(`Saving the PTB view contaminated shared/stable developer settings: ${JSON.stringify(savedAfterPtb)}`);
  }
  if (fs.readFileSync(playerdataSentinel, 'utf8') !== 'playerdata-preserved') {
    throw new Error('PTB playerdata sentinel changed during migration/settings save.');
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    loginCalls: loginCalls.length,
    launcherProofAuthHeaders,
    updateLogAuthHeaders,
    alternateOriginSummaryAuthHeaders,
    doubleRejectedProof: doubleRejectedProof.message,
    outdatedRegistrationGate: outdatedRegistrationGate.message,
    usernameRegistrationRequests: usernameRegistrationRequests.length,
    expiredContractRejected: true,
    missingExpiryContractRejected: true,
    remoteTimeoutMs: timedLogin.durationMs,
    badControlRoutes,
    migratedStableInstanceDir: migratedConfig.instanceDir,
    preservedPtbInstanceDir: migratedConfig.packs.ptb.instanceDir,
    playerdataPreserved: true,
    playerDataUi,
    playerDataScreenshotPath,
    playerRecordsScreenshotPath,
    title: proof.updateLogs.logs[0].title,
    media: proof.updateLogs.logs[0].media?.type || '',
    image: proof.updateLogs.logs[0].image?.url || ''
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => alternateServer.close(resolve));
}
