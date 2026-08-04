import crypto from 'node:crypto';
import worker from '../cloudflare/curseforge-proxy-worker.js';

const objects = new Map();
const env = {
  LAUNCHER_PROOF_SECRET: 'proof-secret',
  ADMIN_TOKEN_SECRET: 'admin-secret',
  AHT_DATA: {
    async put(key, value) {
      objects.set(key, String(value));
    },
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : {
        async json() { return JSON.parse(value); }
      };
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .slice(0, limit)
          .map((key) => ({ key }))
      };
    },
    async delete(key) {
      objects.delete(key);
    }
  }
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  return worker.fetch(new Request(`https://worker.test${path}`, options), env, {});
}

async function jsonRequest(path, options = {}, expectedStatus = 200) {
  const response = await request(path, options);
  const body = await response.json();
  assert(response.status === expectedStatus,
    `${path} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function serverSignature(method, target, timestamp, body) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return crypto.createHmac('sha256', env.LAUNCHER_PROOF_SECRET)
    .update(`${method}\n${target}\n${timestamp}\n${bodyHash}`)
    .digest('base64url');
}

async function serverSync(payload, expectedStatus = 200, signed = true) {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const headers = { 'Content-Type': 'application/json' };
  if (signed) {
    headers['X-AHT-Server-Timestamp'] = timestamp;
    headers['X-AHT-Server-Signature'] = serverSignature(
      'POST', '/server/social/sync', timestamp, body);
  }
  return jsonRequest('/server/social/sync', { method: 'POST', headers, body }, expectedStatus);
}

await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'SocialUser',
    installId: 'social-install',
    packId: 'a-hard-time-dregora'
  })
});

const proof = await jsonRequest('/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    protocol: 'aht-launcher-proof-v1',
    minecraftUsername: 'SocialUser',
    installId: 'social-install',
    packId: 'a-hard-time-dregora',
    installedVersion: '2.8.60'
  })
});
assert(proof.trusted && proof.token, 'Launcher proof was not issued.');

const unsigned = await serverSync({ snapshots: [], acknowledgements: [] }, 401, false);
assert(/authentication/i.test(unsigned.error), 'Unsigned server sync was not rejected.');

const rejectedWindowsSync = await serverSync({
  schemaVersion: 1,
  serverId: 'aht-main',
  snapshots: [],
  acknowledgements: []
}, 403);
assert(/Linux AHT server/i.test(rejectedWindowsSync.error), 'Windows social sync identity was accepted.');

await serverSync({
  schemaVersion: 1,
  serverId: 'aht-linux',
  snapshots: [{
    username: 'SocialUser',
    updatedAt: new Date().toISOString(),
    friends: [
      { username: 'OnlineFriend', online: true },
      { username: 'OfflineFriend', online: false }
    ],
    requests: []
  }],
  acknowledgements: []
});

const authorization = { Authorization: `Bearer ${proof.token}` };
const initial = await jsonRequest('/api/social', { headers: authorization });
assert(initial.counts.friends === 2 && initial.counts.online === 1 && !('blocked' in initial.counts),
  `Social counts were wrong: ${JSON.stringify(initial.counts)}`);
assert(initial.friends[0].username === 'OnlineFriend' && initial.friends[0].online,
  'Online friend state was not preserved.');

const blockedAction = await jsonRequest('/api/social/actions', {
  method: 'POST',
  headers: { ...authorization, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'block_player', target: 'TargetUser' })
}, 400);
assert(/unavailable/i.test(blockedAction.error), 'Launcher-side block action was accepted.');

const queued = await jsonRequest('/api/social/actions', {
  method: 'POST',
  headers: { ...authorization, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'accept_friend', target: 'tArGeTuSeR' })
}, 202);
assert(queued.queued && queued.actionId, 'Accept request action was not queued.');

const declined = await jsonRequest('/api/social/actions', {
  method: 'POST',
  headers: { ...authorization, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'decline_friend', target: 'DeclineUser' })
}, 202);
assert(declined.queued && declined.actionId, 'Decline request action was not queued.');

const pulled = await serverSync({ serverId: 'aht-linux', snapshots: [], acknowledgements: [] });
assert(pulled.actions.length === 2, `Server did not receive two request actions: ${JSON.stringify(pulled)}`);
assert(pulled.actions.some((action) => action.actor === 'SocialUser'
  && action.action === 'accept_friend' && action.target === 'tArGeTuSeR')
  && pulled.actions.some((action) => action.actor === 'SocialUser'
  && action.action === 'decline_friend' && action.target === 'DeclineUser'),
  `Server actions were not bound to proof identity: ${JSON.stringify(pulled.actions)}`);

const acknowledged = await serverSync({
  serverId: 'aht-linux',
  snapshots: [{
    username: 'SocialUser',
    updatedAt: new Date().toISOString(),
    friends: [{ username: 'TargetUser', online: true }],
    requests: []
  }],
  acknowledgements: [
    { id: queued.actionId, success: true, message: 'Friend request accepted.' },
    { id: declined.actionId, success: true, message: 'Friend request declined.' }
  ]
});
assert(acknowledged.acknowledged === 2 && acknowledged.actions.length === 0,
  `Acknowledged action remained queued: ${JSON.stringify(acknowledged)}`);

const updated = await jsonRequest('/api/social', { headers: authorization });
assert(updated.friends.length === 1 && updated.friends[0].username === 'TargetUser',
  `Updated server snapshot was not returned: ${JSON.stringify(updated)}`);

const tamperedToken = `${proof.token.slice(0, -1)}${proof.token.endsWith('a') ? 'b' : 'a'}`;
const tampered = await jsonRequest('/api/social', {
  headers: { Authorization: `Bearer ${tamperedToken}` }
}, 401);
assert(/valid AHT Launcher session/i.test(tampered.error), 'Tampered launcher proof was accepted.');

console.log('worker social bridge tests passed');
