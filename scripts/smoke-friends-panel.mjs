import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 9870);
const debuggerEndpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-friends-panel-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const minecraftRoot = path.join(root, '.minecraft');
const defaultsPath = path.join(root, 'app.defaults.json');
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();
const socialActions = [];
const socialState = {
  username: 'SocialUser_1',
  updatedAt: '2026-07-14T12:00:00.000Z',
  counts: { friends: 2, online: 1, blocked: 1 },
  friends: [
    { username: 'FriendOnline', online: true },
    { username: 'FriendOffline', online: false }
  ],
  blockedPlayers: [{ username: 'BlockedOne' }],
  requests: []
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function updateCounts() {
  socialState.counts = {
    friends: socialState.friends.length,
    online: socialState.friends.filter((friend) => friend.online).length,
    blocked: socialState.blockedPlayers.length
  };
  socialState.updatedAt = new Date().toISOString();
}

async function waitForTarget() {
  let lastError;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`${debuggerEndpoint}/json/list`);
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
    if (message.error) reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
    else resolve(message.result || {});
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
  const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
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

async function click(client, selector) {
  await evaluate(client, `document.querySelector(${JSON.stringify(selector)})?.click(); true`);
  await sleep(300);
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body || '{}');
}

function json(response, body, status = 200) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '9.9.9',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { url: `${workerEndpoint}/packs/a-hard-time-9.9.9.zip`, size: 123, sha256: '0'.repeat(64) },
  social: {
    enabled: true,
    baseUrl: `${workerEndpoint}/`,
    stateUrl: 'api/social',
    actionUrl: 'api/social/actions'
  }
};

await fsp.rm(userData, { recursive: true, force: true });
await fsp.mkdir(instanceDir, { recursive: true });
await fsp.mkdir(minecraftRoot, { recursive: true });
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'friends-panel-install',
  createdAt: new Date().toISOString(),
  minecraftUsername: 'SocialUser_1',
  usernameRegisteredAt: new Date().toISOString(),
  usernameRegistrationMode: 'friends-panel-smoke'
});
await writeJson(defaultsPath, {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: true, sendLocalChanges: false, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  social: { enabled: true, baseUrl: `${workerEndpoint}/`, stateUrl: 'api/social', actionUrl: 'api/social/actions' },
  minecraftLauncher: { enabled: true, rootDir: minecraftRoot, profileId: 'a-hard-time', profileName: 'A Hard Time', memoryMb: 4096, autoImportAccount: false }
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') return json(response, latest);
  if (url.pathname === '/api/users/register' && request.method === 'POST') {
    const body = await readBody(request);
    return json(response, { ok: true, username: body.username });
  }
  if (url.pathname === '/api/launcher-proof' && request.method === 'POST') {
    const payload = await readBody(request);
    return json(response, {
      token: 'header.payload.signature',
      payload,
      signature: { alg: 'HS256', kid: 'friends-smoke', value: 'signature' }
    });
  }
  if (url.pathname === '/api/social' && request.method === 'GET') {
    if (!String(request.headers.authorization || '').startsWith('Bearer ')) return json(response, { error: 'unauthorized' }, 401);
    return json(response, { social: socialState });
  }
  if (url.pathname === '/api/social/actions' && request.method === 'POST') {
    if (!String(request.headers.authorization || '').startsWith('Bearer ')) return json(response, { error: 'unauthorized' }, 401);
    const body = await readBody(request);
    socialActions.push(body);
    if (body.action === 'add_friend') {
      socialState.friends.push({ username: body.target, online: false });
    } else if (body.action === 'remove_friend') {
      socialState.friends = socialState.friends.filter((friend) => friend.username.toLowerCase() !== String(body.target).toLowerCase());
    } else if (body.action === 'unblock_player') {
      socialState.blockedPlayers = socialState.blockedPlayers.filter((player) => player.username.toLowerCase() !== String(body.target).toLowerCase());
    }
    updateCounts();
    return json(response, { queued: true, message: 'Server action queued.', social: socialState });
  }
  response.statusCode = 404;
  response.end('not found');
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '0',
    AHT_APP_DEFAULTS: defaultsPath,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_USER_DATA: userData
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
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'friends DOM');
  await waitFor(client, `
    (async () => {
      const status = await window.aht.getStatus();
      if (typeof renderStatus === 'function') renderStatus(status);
      const button = document.querySelector('#profileFriendsButton');
      return button?.tagName === 'BUTTON' && !button.hidden && document.querySelector('#playerLabelView')?.textContent === 'SocialUser_1';
    })()
  `, 'clickable profile with username');
  await click(client, '#profileFriendsButton');
  const panel = await waitFor(client, `
    (() => {
      const overlay = document.querySelector('#friendsOverlay');
      const text = overlay?.innerText || '';
      if (!overlay || overlay.hidden || !text.includes('FriendOnline') || !text.includes('FriendOffline') || !text.includes('BlockedOne')) return false;
      return {
        friends: document.querySelector('#friendsCount')?.textContent?.trim(),
        online: document.querySelector('#friendsOnlineCount')?.textContent?.trim(),
        blocked: document.querySelector('#blockedCount')?.textContent?.trim(),
        friendRows: [...document.querySelectorAll('#friendsList .friend-row')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim()),
        blockedRows: [...document.querySelectorAll('#blockedList .friend-row')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim()),
        actionLabels: [...document.querySelectorAll('[data-social-action]')].map((button) => button.textContent.trim()),
        actionValues: [...document.querySelectorAll('[data-social-action]')].map((button) => button.dataset.socialAction),
        hasAdd: Boolean(document.querySelector('#addFriendButton')),
        disabled: [...document.querySelectorAll('#addFriendButton, [data-social-action]')].some((button) => button.disabled)
      };
    })()
  `, 'friends panel data');
  if (panel.friends !== '2' || panel.online !== '1' || panel.blocked !== '1') throw new Error(`Friends panel counts were wrong: ${JSON.stringify(panel)}`);
  if (!panel.friendRows.some((line) => line.includes('FriendOnline') && line.includes('Online')) || !panel.friendRows.some((line) => line.includes('FriendOffline') && line.includes('Offline'))) throw new Error(`Friends panel did not show presence: ${JSON.stringify(panel)}`);
  if (!panel.blockedRows.some((line) => line.includes('BlockedOne') && line.includes('Unblock'))) throw new Error(`Blocked player row was wrong: ${JSON.stringify(panel)}`);
  if (!panel.hasAdd || panel.disabled || panel.actionLabels.includes('Block') || panel.actionValues.some((action) => !['remove_friend', 'unblock_player'].includes(action))) throw new Error(`Friends panel exposed unsafe controls: ${JSON.stringify(panel)}`);

  await evaluate(client, `(() => { const input = document.querySelector('#addFriendInput'); input.value = 'NewFriend_1'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#addFriendButton').click(); return true; })()`);
  await waitFor(client, "document.querySelector('#friendsList')?.innerText.includes('NewFriend_1')", 'add friend action');
  await evaluate(client, `(() => { const row = [...document.querySelectorAll('#friendsList .friend-row')].find((item) => item.innerText.includes('FriendOffline')); row?.querySelector('[data-social-action="remove_friend"]')?.click(); return true; })()`);
  await waitFor(client, "!document.querySelector('#friendsList')?.innerText.includes('FriendOffline')", 'unadd friend action');
  await evaluate(client, `document.querySelector('#blockedList [data-social-action="unblock_player"]')?.click(); true`);
  await waitFor(client, "!document.querySelector('#blockedList')?.innerText.includes('BlockedOne')", 'unblock player action');

  const actionNames = socialActions.map((entry) => entry.action).join(',');
  if (actionNames !== 'add_friend,remove_friend,unblock_player') throw new Error(`Unexpected social actions: ${JSON.stringify(socialActions)}`);
  if (socialActions.some((entry) => Object.keys(entry).sort().join(',') !== 'action,target' || entry.username || entry.installId)) {
    throw new Error(`Renderer identity leaked into social action body: ${JSON.stringify(socialActions)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    root,
    packaged: Boolean(smokeExe),
    counts: { friends: panel.friends, online: panel.online, blocked: panel.blocked },
    actions: socialActions
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
