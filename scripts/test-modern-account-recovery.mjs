import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import worker from '../cloudflare/curseforge-proxy-worker.js';
import { createDeviceCredential, createDeviceAssertion } from '../src/deviceIdentity.js';
import { recoverMinecraftAccount } from '../cloudflare/minecraft-account-recovery.js';

const username = 'RecoveryFixture';
const minecraftUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const key = 'accounts/usernames/recoveryfixture.json';
const secret = 'new_fixture_recovery_secret_1234567890123456';
const digest = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const priorDevice = createDeviceCredential(), nextDevice = createDeviceCredential();
  const original = { schemaVersion: 3, username, minecraftUuid, installId: 'prior-install',
    deviceId: priorDevice.deviceId, devicePublicKey: priorDevice.publicKey,
    accountRecoveryVerifier: digest('prior_fixture_secret'), createdAt: '2026-01-01T00:00:00Z' };
  const objects = new Map([[key, JSON.stringify(original)]]);
  const env = { AHT_REQUIRE_DEVICE_ATTESTATION: 'true', AHT_BLOCK_LIKELY_VPN: 'false', AHT_DATA: {
    get: async name => objects.has(name) ? { etag: digest(objects.get(name)), json: async () => JSON.parse(objects.get(name)) } : null,
    put: async (name, value, options = {}) => {
      if (options.onlyIf?.etagMatches && (!objects.has(name) || digest(objects.get(name)) !== options.onlyIf.etagMatches)) return null;
      if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(name)) return null;
      objects.set(name, value); return { etag: digest(value) };
    },
    delete: async name => objects.delete(name),
    list: async ({ prefix = '' } = {}) => ({ objects: [...objects.keys()].filter(name => name.startsWith(prefix)).map(key => ({ key })), truncated: false })
  } };
  async function register(extra = {}, recoverySecret = secret) {
    const body = { username, minecraftUuid, installId: 'next-install', deviceId: nextDevice.deviceId,
      devicePublicKey: nextDevice.publicKey, recoverExistingUsername: true,
      minecraftAccountMatched: true, supportsMinecraftSessionRecovery: true, ...extra };
    body.deviceAssertion = createDeviceAssertion(nextDevice, { purpose: 'account-registration', binding: {
      username: username.toLowerCase(), minecraftUuid: body.minecraftUuid, installId: body.installId, deviceId: body.deviceId
    } });
    const result = await worker.fetch(new Request('https://fixture.invalid/api/users/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AHT-Launcher-Recovery': recoverySecret }, body: JSON.stringify(body)
    }), env, {});
    return { status: result.status, body: await result.json() };
  }
  return { register, original, objects, env, nextDevice };
}

test('a modern account with a lost recovery key can independently prove Minecraft ownership', async () => {
  const f = fixture(); const originalFetch = globalThis.fetch;
  try {
    const challenge = await f.register();
    assert.equal(challenge.body.code, 'MINECRAFT_OWNERSHIP_REQUIRED');
    assert.deepEqual(JSON.parse(f.objects.get(key)), f.original, 'a challenge must not change the account');
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).origin, 'https://sessionserver.mojang.com');
      assert.equal(options.redirect, 'manual');
      return Response.json({ name: username, id: minecraftUuid.replaceAll('-', '') });
    };
    const done = await f.register({ minecraftSessionChallenge: challenge.body.minecraftSessionChallenge });
    assert.equal(done.status, 200); assert.equal(done.body.recovered, true);
    const record = JSON.parse(f.objects.get(key));
    assert.equal(record.installId, 'next-install'); assert.equal(record.deviceId, f.nextDevice.deviceId);
    assert.equal(record.createdAt, f.original.createdAt); assert.equal(record.minecraftUuid, minecraftUuid);
    assert.equal(record.accountRecoveryVerifier, digest(secret));
    assert.equal((await f.register({ installId: 'third-install', minecraftSessionChallenge: challenge.body.minecraftSessionChallenge },
      'different_fixture_recovery_secret_1234567890123456')).status, 409);
  } finally { globalThis.fetch = originalFetch; }
});

test('lost device credentials on the same installation require fresh ownership instead of a dead end', async () => {
  const f = fixture();
  const challenge = await f.register({ installId: 'prior-install' });
  assert.equal(challenge.body.code, 'MINECRAFT_OWNERSHIP_REQUIRED');
  assert.deepEqual(JSON.parse(f.objects.get(key)), f.original);
});

test('a legacy install ID alone cannot bind a new device or claim Minecraft ownership', async () => {
  const f = fixture();
  const legacy = { username, installId: 'prior-install', createdAt: f.original.createdAt };
  f.objects.set(key, JSON.stringify(legacy));
  const unverified = await f.register({ installId: 'prior-install', recoverExistingUsername: false });
  assert.equal(unverified.status, 409);
  assert.equal(unverified.body.code, 'ACCOUNT_RECOVERY_REQUIRED');
  assert.deepEqual(JSON.parse(f.objects.get(key)), legacy, 'An install ID is not ownership authority');
  const issued = await f.register({ installId: 'prior-install' });
  assert.equal(issued.body.code, 'MINECRAFT_OWNERSHIP_REQUIRED');
  assert.deepEqual(JSON.parse(f.objects.get(key)), legacy);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ name: username, id: minecraftUuid });
    const verified = await f.register({ installId: 'prior-install', minecraftSessionChallenge: issued.body.minecraftSessionChallenge });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.recovered, true);
    assert.equal(JSON.parse(f.objects.get(key)).createdAt, legacy.createdAt);
  } finally { globalThis.fetch = originalFetch; }
});

test('different UUID cannot recover a registered account or obtain a challenge', async () => {
  const f = fixture();
  assert.equal((await f.register({ minecraftUuid: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' })).status, 409);
  assert.equal(f.objects.size, 1); assert.deepEqual(JSON.parse(f.objects.get(key)), f.original);
});

test('an account change during Mojang verification cannot be overwritten by the old request', async () => {
  const f = fixture(); const priorFetch = globalThis.fetch;
  try {
    const issued = await f.register();
    const newer = { ...f.original, installId: 'another-verified-install', updatedAt: '2026-09-13T00:00:00Z' };
    globalThis.fetch = async () => {
      f.objects.set(key, JSON.stringify(newer));
      return Response.json({ name: username, id: minecraftUuid });
    };
    const result = await f.register({ minecraftSessionChallenge: issued.body.minecraftSessionChallenge });
    assert.equal(result.status, 409); assert.equal(result.body.code, 'ACCOUNT_REGISTRATION_CHANGED');
    assert.deepEqual(JSON.parse(f.objects.get(key)), newer);
  } finally { globalThis.fetch = priorFetch; }
});

test('fresh ownership cannot erase restrictions on the existing account or device', async () => {
  for (const scope of ['account', 'device', 'minecraft_uuid']) {
    const f = fixture(); const priorFetch = globalThis.fetch;
    const value = scope === 'account' ? username.toLowerCase() : scope === 'device' ? f.original.deviceId : minecraftUuid;
    const decisionKey = `access/decisions/${scope}/${digest(`${scope}\0${value}`)}.json`;
    try {
      const issued = await f.register();
      f.objects.set(decisionKey, JSON.stringify({ active: true, effect: 'deny', scope, value, decisionId: 'fixture-ban' }));
      globalThis.fetch = async () => Response.json({ name: username, id: minecraftUuid });
      const result = await f.register({ minecraftSessionChallenge: issued.body.minecraftSessionChallenge });
      assert.equal(result.status, 403, scope); assert.equal(result.body.code, 'ACCESS_DENIED');
      assert.deepEqual(JSON.parse(f.objects.get(key)), f.original); assert(f.objects.has(decisionKey));
    } finally { globalThis.fetch = priorFetch; }
  }
});

test('Mojang identity mismatch and changed credential state cannot reuse a challenge', async () => {
  const f = fixture(); const priorFetch = globalThis.fetch;
  try {
    const issued = await f.register();
    const body = { minecraftSessionChallenge: issued.body.minecraftSessionChallenge };
    globalThis.fetch = async () => Response.json({ name: 'WrongPlayer', id: minecraftUuid });
    assert.equal((await f.register(body)).status, 409);
    globalThis.fetch = async () => Response.json({ name: username, id: 'b'.repeat(32) });
    assert.equal((await f.register(body)).status, 409);
    const newer = { ...f.original, accountRecoveryVerifier: digest('newer-credential') };
    f.objects.set(key, JSON.stringify(newer));
    globalThis.fetch = async () => { throw new Error('Stale proof must not reach Mojang'); };
    assert.equal((await f.register(body)).status, 409);
    assert.deepEqual(JSON.parse(f.objects.get(key)), newer);
  } finally { globalThis.fetch = priorFetch; }
});

test('Mojang response size and total deadline are bounded; an outage never accepts ownership', async () => {
  const f = fixture(); const issued = await f.register();
  const options = { env: f.env, record: f.original, body: { minecraftSessionChallenge: issued.body.minecraftSessionChallenge },
    username, minecraftUuid, deviceId: f.nextDevice.deviceId, installId: 'next-install', timeoutMs: 25 };
  const stalled = await recoverMinecraftAccount({ ...options, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
  assert.equal(stalled.verified, false); assert.equal(stalled.status, 503);
  const oversized = await recoverMinecraftAccount({ ...options, fetchImpl: async () => new Response('x', { headers: { 'Content-Length': '99999999' } }) });
  assert.equal(oversized.verified, false);
  assert.deepEqual(JSON.parse(f.objects.get(key)), f.original);
});

test('ownership that finishes after the challenge expires is not accepted', async () => {
  const f = fixture(); const issued = await f.register();
  const result = await recoverMinecraftAccount({ env: f.env, record: f.original,
    body: { minecraftSessionChallenge: issued.body.minecraftSessionChallenge }, username, minecraftUuid,
    deviceId: f.nextDevice.deviceId, installId: 'next-install',
    currentTime: () => issued.body.expiresAt + 1,
    fetchImpl: async () => Response.json({ name: username, id: minecraftUuid }) });
  assert.equal(result.verified, false);
  assert.equal(result.status, 409);
  assert.deepEqual(JSON.parse(f.objects.get(key)), f.original);
});
