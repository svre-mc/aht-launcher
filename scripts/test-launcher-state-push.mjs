import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import worker, { LauncherStateHub } from '../cloudflare/curseforge-proxy-worker.js';
import { createDeviceAssertion, createDeviceCredential } from '../src/deviceIdentity.js';
import { launcherProofDeviceBinding } from '../src/launcherProof.js';
import {
  TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8,
  TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI
} from './helpers/launcher-proof-fixture.mjs';

const dataObjects = new Map();
const releaseObjects = new Map();
const storageObjects = new Map();
const socketMessages = [];
const sockets = [];

function jsonObject(value, etag = '') {
  const text = JSON.stringify(value);
  return {
    size: Buffer.byteLength(text),
    httpEtag: etag,
    async json() { return JSON.parse(text); }
  };
}

const dataBucket = {
  async put(key, value) { dataObjects.set(key, JSON.parse(String(value))); },
  async get(key) {
    return dataObjects.has(key) ? jsonObject(dataObjects.get(key)) : null;
  },
  async list({ prefix = '', limit = 1000, cursor = '' } = {}) {
    const keys = [...dataObjects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = Number(cursor || 0);
    const page = keys.slice(start, start + limit);
    const next = start + page.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated: next < keys.length,
      cursor: next < keys.length ? String(next) : ''
    };
  }
};

const releaseBucket = {
  async get(key) {
    const value = releaseObjects.get(key);
    return value ? jsonObject(value.body, value.etag) : null;
  }
};

const context = {
  storage: {
    async get(key) { return storageObjects.get(key); },
    async put(key, value) { storageObjects.set(key, structuredClone(value)); }
  },
  getWebSockets() { return sockets; },
  acceptWebSocket() { throw new Error('WebSocketPair is not used by this unit test'); }
};

const env = {
  LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8: TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8,
  LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI: TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI,
  LAUNCHER_ATTESTATION_KEY_ID: 'aht-launcher-attestation-v2',
  LAUNCHER_PROOF_PACK_ID: 'a-hard-time-dregora',
  AHT_BLOCK_LIKELY_VPN: 'false',
  AHT_DATA: dataBucket,
  AHT_RELEASES: releaseBucket
};

const username = 'DeviceRig';
const minecraftUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const installId = 'device-install-test';
const deviceId = `ahtd_${'a'.repeat(64)}`;
dataObjects.set('accounts/usernames/devicerig.json', {
  schemaVersion: 3,
  username,
  normalizedUsername: username.toLowerCase(),
  minecraftUuid,
  installId,
  deviceId
});
dataObjects.set('access/decisions/device/test.json', {
  schemaVersion: 1,
  scope: 'device',
  value: deviceId,
  effect: 'deny',
  active: true
});
releaseObjects.set('launcher/latest.json', {
  etag: 'etag-0.1.86',
  body: { schemaVersion: 1, product: 'aht-launcher', required: true, version: '0.1.86' }
});

const hub = new LauncherStateHub(context, env);
const stub = {
  async fetch(input, init) {
    return hub.fetch(input instanceof Request ? input : new Request(input, init));
  }
};
env.AHT_LAUNCHER_STATE = {
  idFromName(name) { assert.equal(name, 'production'); return 'production-id'; },
  get(id) { assert.equal(id, 'production-id'); return stub; }
};

function refresh(reason) {
  return hub.fetch(new Request('https://state.test/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AHT-Launcher-State-Internal': '1' },
    body: JSON.stringify({ reason })
  }));
}

function decodeAndVerifyState(state) {
  const parts = state.token.split('.');
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.deepEqual(header, {
    alg: 'RS256',
    typ: 'AHT-SERVER-STATE',
    kid: 'aht-launcher-attestation-v2'
  });
  assert.equal(verifySignature(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    createPublicKey(TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI),
    Buffer.from(parts[2], 'base64url')
  ), true);
  const spki = createPublicKey(TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI).export({ type: 'spki', format: 'der' });
  assert.equal(payload.attestationKeySha256, createHash('sha256').update(spki).digest('hex'));
  assert.equal(payload.revision, state.revision);
  return payload;
}

const firstResponse = await refresh('initial-test');
assert.equal(firstResponse.status, 200);
const firstResult = await firstResponse.json();
assert.equal(firstResult.changed, true);
const firstState = storageObjects.get('signedLauncherServerState');
const firstPayload = decodeAndVerifyState(firstState);
assert.equal(firstPayload.necessaryLauncherVersion, '0.1.86');
assert.equal(firstPayload.accountBindings.length, 1);
assert.equal(firstPayload.accessDenials.length, 1);
assert.equal(firstPayload.accountBindings[0].accountDigest,
  createHash('sha256').update(`account\0${username.toLowerCase()}`).digest('hex'));
assert.equal(firstPayload.accountBindings[0].bindingDigest,
  createHash('sha256').update(`binding-v1\0${username.toLowerCase()}\0${minecraftUuid}\0${installId}\0${deviceId}`).digest('hex'));
assert.equal(firstPayload.accessDenials[0].digest,
  createHash('sha256').update(`device\0${deviceId}`).digest('hex'));
const stateText = JSON.stringify(firstPayload);
assert.equal(stateText.includes(username), false);
assert.equal(stateText.includes(minecraftUuid), false);
assert.equal(stateText.includes(installId), false);
assert.equal(stateText.includes(deviceId), false);

const unchangedResponse = await refresh('duplicate-test');
assert.equal((await unchangedResponse.json()).changed, false);

sockets.push({
  send(message) { socketMessages.push(String(message)); },
  close() { throw new Error('healthy socket should not close'); }
});
releaseObjects.set('launcher/latest.json', {
  etag: 'etag-0.1.87',
  body: { schemaVersion: 1, product: 'aht-launcher', required: true, version: '0.1.87' }
});
let updateAcked = false;
await worker.queue({ messages: [{
  body: { action: 'PutObject', object: { key: 'launcher/latest.json', eTag: 'etag-0.1.87' } },
  ack() { updateAcked = true; }
}] }, env);
assert.equal(updateAcked, true);
assert.equal(socketMessages.length, 1, 'one effective policy push is expected for one manifest revision');
const pushed = JSON.parse(socketMessages[0]);
assert.equal(pushed.type, 'launcher-server-state');
assert.equal(decodeAndVerifyState(storageObjects.get('signedLauncherServerState')).necessaryLauncherVersion, '0.1.87');

let duplicateAcked = false;
await worker.queue({ messages: [{
  body: { action: 'PutObject', object: { key: 'launcher/latest.json', eTag: 'duplicate-delivery' } },
  ack() { duplicateAcked = true; }
}] }, env);
assert.equal(duplicateAcked, true);
assert.equal(socketMessages.length, 1, 'at-least-once queue delivery must be revision-deduplicated');

let unrelatedAcked = false;
await worker.queue({ messages: [{
  body: { action: 'PutObject', object: { key: 'launcher/files/unrelated.exe' } },
  ack() { unrelatedAcked = true; }
}] }, env);
assert.equal(unrelatedAcked, true);
assert.equal(socketMessages.length, 1);

const newUsername = 'NewRig';
const newMinecraftUuid = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const newInstallId = 'new-device-install';
const newRecoverySecret = 'new_rig_recovery_secret_1234567890123456789';
dataObjects.set('accounts/usernames/newrig.json', {
  schemaVersion: 3,
  username: newUsername,
  normalizedUsername: newUsername.toLowerCase(),
  minecraftUuid: newMinecraftUuid,
  installId: newInstallId,
  accountRecoveryVerifier: createHash('sha256').update(newRecoverySecret).digest('hex')
});
const newDevice = createDeviceCredential();
function newRigProofBody() {
  const body = {
    protocol: 'aht-launcher-attestation-v2',
    launchId: randomUUID(),
    minecraftUsername: newUsername,
    minecraftUuid: newMinecraftUuid,
    installId: newInstallId,
    packId: 'a-hard-time-dregora',
    appVersion: '0.1.87',
    launcherVersion: '0.1.87',
    installedVersion: '2.9.0',
    instanceDirHash: 'new-rig-test-instance',
    deviceId: newDevice.deviceId,
    devicePublicKey: newDevice.publicKey
  };
  body.deviceAssertion = createDeviceAssertion(newDevice, {
    purpose: 'launcher-proof',
    binding: launcherProofDeviceBinding(body)
  });
  return body;
}
async function issueNewRigProof() {
  const response = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AHT-Launcher-Recovery': newRecoverySecret
    },
    body: JSON.stringify(newRigProofBody())
  }), env, {});
  return { response, body: await response.json() };
}
const firstNewRigProof = await issueNewRigProof();
assert.equal(firstNewRigProof.response.status, 200);
assert.equal(firstNewRigProof.body.payload.launcherVersionAuthority, 'worker-policy-matched-device-assertion');
assert.equal(socketMessages.length, 2, 'the first device binding must create one policy push');
const boundPayload = decodeAndVerifyState(storageObjects.get('signedLauncherServerState'));
assert.equal(boundPayload.accountBindings.length, 2);
const secondNewRigProof = await issueNewRigProof();
assert.equal(secondNewRigProof.response.status, 200);
assert.equal(socketMessages.length, 2, 'an unchanged device binding must not push policy again');

const publicKeyResponse = await worker.fetch(
  new Request('https://worker.test/api/launcher-proof/public-key'), env, {}
);
const publicKeyBody = await publicKeyResponse.json();
assert.equal(publicKeyResponse.status, 200);
assert.equal(publicKeyBody.sha256, firstPayload.attestationKeySha256);

console.log(JSON.stringify({
  ok: true,
  initialVersion: firstPayload.necessaryLauncherVersion,
  pushedVersion: '0.1.87',
  effectiveVersionPushes: 1,
  firstDeviceBindingPushes: 1,
  unchangedLaunchBindingPushes: 0,
  duplicateQueueDeliveryDeduplicated: true,
  clientVersionTrustedWithoutSignature: false,
  rawPlayerIdentifiersInServerState: false,
  revision: storageObjects.get('signedLauncherServerState').revision
}, null, 2));
