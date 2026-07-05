import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 9870);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-friends-panel-'));
const userData = path.join(root, 'userData');
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();
const minecraftRoot = path.join(root, '.minecraft');
const defaultsPath = path.join(root, 'app.defaults.json');
const socialActions = [];
const socialState = {
  username: 'SocialUser_1',
  updatedAt: '2026-07-01T12:00:00.000Z',
  friends: [
    { username: 'FriendOnline', online: true },
    { username: 'FriendOffline', online: false }
  ],
  blockedPlayers: ['BlockedOne']
};

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
  await sleep(400);
}

async function fillAndClick(client, inputSelector, value, buttonSelector) {
  await evaluate(client, `
    (() => {
      const input = document.querySelector(${JSON.stringify(inputSelector)});
      if (input) {
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector(${JSON.stringify(buttonSelector)})?.click();
      return true;
    })()
  `);
  await sleep(500);
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time Dregora',
  version: '9.9.9',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { path: 'packs/a-hard-time-9.9.9.zip', size: 123, sha256: '0'.repeat(64) },
  social: {
    enabled: true,
    feedUrl: 'social/{username}.json',
    actionUrl: 'api/social/{action}/{target}'
  }
};

await fsp.rm(userData, { recursive: true, force: true });
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'friends-panel-install',
  createdAt: new Date().toISOString(),
  minecraftUsername: 'SocialUser_1',
  usernameRegisteredAt: new Date().toISOString(),
  usernameRegistrationMode: 'friends-panel-smoke'
});
await fsp.mkdir(minecraftRoot, { recursive: true });
await writeJson(defaultsPath, {
  packId: 'a-hard-time-dregora',
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: true, sendLocalChanges: true, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  social: { enabled: true },
  minecraftLauncher: { enabled: true, rootDir: minecraftRoot, profileId: 'a-hard-time', profileName: 'A Hard Time', memoryMb: 4096 }
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(latest));
    return;
  }
  if (url.pathname.startsWith('/social/') && url.pathname.endsWith('.json')) {
    socialState.username = decodeURIComponent(path.basename(url.pathname, '.json')) || socialState.username;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(socialState));
    return;
  }
  if (url.pathname.startsWith('/api/social/') && request.method === 'POST') {
    const [, , , rawAction, rawTarget] = url.pathname.split('/');
    const action = decodeURIComponent(rawAction || '');
    const target = decodeURIComponent(rawTarget || '');
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const payload = JSON.parse(body || '{}');
      socialActions.push({ action, target, payload });
      if (action === 'add_friend' && target) {
        socialState.friends = [
          ...socialState.friends.filter((friend) => friend.username.toLowerCase() !== target.toLowerCase()),
          { username: target, online: true }
        ];
      }
      if (action === 'remove_friend') socialState.friends = socialState.friends.filter((friend) => friend.username.toLowerCase() !== target.toLowerCase());
      if (action === 'unblock_player') socialState.blockedPlayers = socialState.blockedPlayers.filter((name) => name.toLowerCase() !== target.toLowerCase());
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ social: socialState }));
    });
    return;
  }
  response.statusCode = 404;
  response.end('not found');
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0', AHT_APP_DEFAULTS: defaultsPath },
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
      return button && !button.hidden && document.querySelector('#playerLabelView')?.textContent === 'SocialUser_1';
    })()
  `, 'profile friends button visible with username');
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
        blockedText: document.querySelector('#blockedList')?.innerText || '',
        hasBlockButton: Boolean(document.querySelector('#blockPlayerButton')),
        hasAdd: Boolean(document.querySelector('#addFriendButton')),
        hasRemove: Boolean(document.querySelector('#removeFriendButton')),
        hasUnblock: Boolean(document.querySelector('#unblockPlayerButton')),
        actionsDisabled: [...document.querySelectorAll('#addFriendButton, #removeFriendButton, #unblockPlayerButton')].some((button) => button.disabled),
        text
      };
    })()
  `, 'friends panel data');
  if (panel.friends !== '2' || panel.online !== '1' || panel.blocked !== '1') throw new Error(`Friends panel counts were wrong: ${JSON.stringify(panel)}`);
  if (!panel.friendRows.some((line) => line.includes('FriendOnline') && line.includes('Online')) || !panel.friendRows.some((line) => line.includes('FriendOffline') && line.includes('Offline'))) throw new Error(`Friends panel did not show online/offline state: ${JSON.stringify(panel)}`);
  if (!panel.blockedText.includes('BlockedOne') || panel.hasBlockButton || !panel.hasAdd || !panel.hasRemove || !panel.hasUnblock || panel.actionsDisabled) throw new Error(`Friends panel controls were not launcher-safe: ${JSON.stringify(panel)}`);
  await fillAndClick(client, '#addFriendInput', 'NewFriend_1', '#addFriendButton');
  await waitFor(client, "document.querySelector('#friendsList')?.innerText.includes('NewFriend_1')", 'add friend action');
  await fillAndClick(client, '#removeFriendInput', 'FriendOffline', '#removeFriendButton');
  await waitFor(client, "!document.querySelector('#friendsList')?.innerText.includes('FriendOffline')", 'remove friend action');
  await fillAndClick(client, '#unblockPlayerInput', 'BlockedOne', '#unblockPlayerButton');
  await waitFor(client, "!document.querySelector('#blockedList')?.innerText.includes('BlockedOne')", 'unblock player action');
  if (socialActions.map((entry) => entry.action).join(',') !== 'add_friend,remove_friend,unblock_player') throw new Error(`Unexpected social actions: ${JSON.stringify(socialActions)}`);
  if (socialActions.some((entry) => entry.payload.username !== 'SocialUser_1' || !entry.payload.installId)) throw new Error(`Social actions did not include identity payload: ${JSON.stringify(socialActions)}`);
  console.log(JSON.stringify({
    ok: true,
    root,
    packaged: Boolean(smokeExe),
    counts: { friends: panel.friends, online: panel.online, blocked: panel.blocked },
    actions: socialActions.map((entry) => ({ action: entry.action, target: entry.target, username: entry.payload.username }))
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
