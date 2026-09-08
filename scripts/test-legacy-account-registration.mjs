import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import worker from '../cloudflare/curseforge-proxy-worker.js';
import { createDeviceAssertion, createDeviceCredential } from '../src/deviceIdentity.js';

const username = 'LegacyRig';
const key = 'accounts/usernames/legacyrig.json';
const minecraftUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const recoverySecret = 'fixture_recovery_secret_1234567890123456';
const device = createDeviceCredential();

function fixture(installId = 'old-install') {
  const records = new Map([[key, {
    username, installId, appVersion: '0.1.75', platform: 'win32', createdAt: '2026-07-14T22:24:20.112Z', previousInstallIds: []
  }]]);
  const env = {
    AHT_REQUIRE_DEVICE_ATTESTATION: 'true', AHT_BLOCK_LIKELY_VPN: 'false',
    AHT_DATA: {
      async get(name) { const value = records.get(name); return value ? { async json() { return structuredClone(value); } } : null; },
      async put(name, value) { records.set(name, JSON.parse(value)); },
      async list({ prefix = '' } = {}) { return { objects: [...records.keys()].filter(name => name.startsWith(prefix)).map(name => ({ key: name })), truncated: false }; }
    }
  };
  return { records, env };
}

async function register(env, installId, { recovery = false, signed = true } = {}) {
  const body = { username, minecraftUuid, installId, appVersion: '0.2.07', platform: 'win32', deviceId: device.deviceId, devicePublicKey: device.publicKey };
  if (signed) body.deviceAssertion = createDeviceAssertion(device, {
    purpose: 'account-registration', binding: { username: username.toLowerCase(), minecraftUuid, installId, deviceId: device.deviceId }
  });
  if (recovery) Object.assign(body, { recoverExistingUsername: true, minecraftAccountMatched: true });
  const response = await worker.fetch(new Request('https://worker.test/api/users/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AHT-Launcher-Recovery': recoverySecret }, body: JSON.stringify(body)
  }), env, {});
  return { response, body: await response.json() };
}

test('a legacy username cannot be reclaimed by an unrelated installation', async () => {
  const { records, env } = fixture();
  assert.equal((await register(env, 'new-install')).response.status, 409);
  const recovery = await register(env, 'new-install', { recovery: true });
  assert.equal(recovery.response.status, 409);
  assert.match(recovery.body.error, /Minecraft ownership verification/);
  assert.equal(records.get(key).installId, 'old-install');
});

test('a legacy record assigned to the verified target install upgrades to secure credentials', async () => {
  const { records, env } = fixture('approved-current-install');
  records.get(key).previousInstallIds = ['old-install'];
  assert.equal((await register(env, 'another-install', { recovery: true })).response.status, 409);
  assert.equal((await register(env, 'approved-current-install', { signed: false })).response.status, 403);
  const result = await register(env, 'approved-current-install');
  assert.equal(result.response.status, 200);
  const record = records.get(key);
  assert.equal(record.minecraftUuid, minecraftUuid);
  assert.equal(record.deviceId, device.deviceId);
  assert.equal(record.accountRecoveryVerifier, createHash('sha256').update(recoverySecret).digest('hex'));
  assert.equal(record.createdAt, '2026-07-14T22:24:20.112Z');
  assert.deepEqual(record.previousInstallIds, ['old-install']);
});
