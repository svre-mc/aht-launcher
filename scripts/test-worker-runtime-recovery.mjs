import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as WorkerResponse } from 'miniflare';
import { createDeviceCredential, createDeviceAssertion } from '../src/deviceIdentity.js';
import { TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8, TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI } from './helpers/launcher-proof-fixture.mjs';

// Real workerd + local R2 simulation; all outbound traffic is intercepted.
// This is not a live Mojang ownership test and never uses production bindings.
test('workerd recovers the exact account and atomically rejects a concurrent R2 change', { timeout: 90000 }, async () => {
  let runtime;
  try {
    const bundled = await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/curseforge-proxy-worker.js', import.meta.url))],
      write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
    const username = 'RecoveryFixture', minecraftUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const key = 'accounts/usernames/recoveryfixture.json';
    const digest = value => createHash('sha256').update(value).digest('hex');
    const prior = createDeviceCredential(), next = createDeviceCredential();
    const original = { schemaVersion: 3, username, minecraftUuid, installId: 'prior-install',
      deviceId: prior.deviceId, devicePublicKey: prior.publicKey,
      accountRecoveryVerifier: digest('old_fixture_secret'), createdAt: '2026-01-01T00:00:00Z' };
    let responseMode = 'valid', outboundCount = 0, bucket, decisionKey = '';
    // The locked local workerd supports dates through August 22. A separately
    // verified current engine can test the production date without changing it.
    const compatibilityDate = process.env.AHT_WORKER_TEST_COMPATIBILITY_DATE || '2026-08-22';
    assert.match(compatibilityDate, /^\d{4}-\d{2}-\d{2}$/);
    runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'aht-local-recovery', modules: true,
      script: bundled.outputFiles[0].text, compatibilityDate,
      durableObjects: { AHT_LAUNCHER_STATE: { className: 'LauncherStateHub', useSQLite: true } },
      r2Buckets: ['AHT_DATA', 'AHT_RELEASES'], bindings: {
        AHT_REQUIRE_DEVICE_ATTESTATION: 'true', AHT_BLOCK_LIKELY_VPN: 'false',
        LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8: TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8,
        LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI: TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI,
        LAUNCHER_ATTESTATION_KEY_ID: 'aht-launcher-attestation-v2', LAUNCHER_PROOF_PACK_ID: 'a-hard-time-dregora'
      },
      outboundService: async request => {
        outboundCount++;
        const url = new URL(request.url);
        assert.equal(url.origin, 'https://sessionserver.mojang.com');
        assert.equal(url.pathname, '/session/minecraft/hasJoined');
        assert.equal(request.method, 'GET');
        if (responseMode === 'conflict') await bucket.put(key, JSON.stringify({ ...original, installId: 'newer-verified-install' }));
        if (responseMode.endsWith('-ban')) {
          const scope = responseMode === 'account-ban' ? 'account' : 'device';
          const value = scope === 'account' ? username.toLowerCase() : responseMode === 'old-device-ban' ? prior.deviceId : next.deviceId;
          decisionKey = `access/decisions/${scope}/${digest(`${scope}\0${value}`)}.json`;
          // A restriction arrives while ownership is being checked. Recovery
          // must still see it before committing the replacement credentials.
          await bucket.put(decisionKey, JSON.stringify({ active: true, effect: 'deny', scope, value, decisionId: 'fixture-restriction' }));
        }
        if (responseMode === 'invalid-utf8') return new WorkerResponse(new Uint8Array([0xff, 0xfe]));
        if (responseMode === 'redirect') return new WorkerResponse(null, { status: 307, headers: { Location: 'https://different.invalid/private' } });
        return WorkerResponse.json({ name: responseMode === 'mismatch' ? 'WrongPlayer' : username, id: minecraftUuid.replaceAll('-', '') });
      }
    }] }));
    bucket = await runtime.getR2Bucket('AHT_DATA');
    const releases = await runtime.getR2Bucket('AHT_RELEASES');
    await releases.put('launcher/latest.json', JSON.stringify({ schemaVersion: 1, product: 'aht-launcher', required: true, version: '0.2.26' }));
    const register = async (extra = {}) => {
      const body = { username, minecraftUuid, installId: 'next-install', deviceId: next.deviceId,
        devicePublicKey: next.publicKey, recoverExistingUsername: true, minecraftAccountMatched: true,
        supportsMinecraftSessionRecovery: true, ...extra };
      body.deviceAssertion = createDeviceAssertion(next, { purpose: 'account-registration', binding: {
        username: username.toLowerCase(), minecraftUuid: body.minecraftUuid, installId: body.installId, deviceId: body.deviceId
      } });
      const response = await runtime.dispatchFetch('https://fixture.invalid/api/users/register', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AHT-Launcher-Recovery': 'new_fixture_recovery_secret_1234567890123456' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    for (const mode of ['mismatch', 'invalid-utf8', 'redirect', 'conflict', 'account-ban', 'old-device-ban', 'new-device-ban', 'valid', 'legacy', 'legacy-same-install']) {
      responseMode = mode;
      const seeded = mode.startsWith('legacy') ? { schemaVersion: 1, username, installId: original.installId, createdAt: original.createdAt } : original;
      await bucket.put(key, JSON.stringify(seeded));
      const binding = mode === 'legacy-same-install' ? { installId: original.installId } : {};
      if (mode === 'legacy-same-install') {
        const unverified = await register({ ...binding, recoverExistingUsername: false });
        assert.equal(unverified.status, 409);
        assert.deepEqual(await (await bucket.get(key)).json(), seeded);
      }
      const challenge = await register(binding);
      assert.equal(challenge.status, 409, mode);
      assert.equal(challenge.body.code, 'MINECRAFT_OWNERSHIP_REQUIRED', mode);
      assert.deepEqual(await (await bucket.get(key)).json(), seeded);
      const result = await register({ ...binding, minecraftSessionChallenge: challenge.body.minecraftSessionChallenge });
      const stored = await (await bucket.get(key)).json();
      if (mode === 'valid' || mode.startsWith('legacy')) {
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.body.recovered, true);
        assert.equal(stored.installId, binding.installId || 'next-install');
        assert.equal(stored.minecraftUuid, minecraftUuid);
        assert.equal(stored.createdAt, original.createdAt);
      } else if (mode === 'conflict') {
        assert.equal(result.status, 409, JSON.stringify({ ...result, outboundCount }));
        assert.equal(result.body.code, 'ACCOUNT_REGISTRATION_CHANGED');
        assert.equal(stored.installId, 'newer-verified-install');
      } else if (mode.endsWith('-ban')) {
        assert.equal(result.status, 403, mode);
        assert.equal(result.body.code, 'ACCESS_DENIED');
        assert.deepEqual(stored, original);
        assert.equal((await (await bucket.get(decisionKey)).json()).active, true);
        await bucket.delete(decisionKey);
        decisionKey = '';
      } else {
        assert.notEqual(result.status, 200, mode);
        assert.deepEqual(stored, original, mode);
      }
    }
    assert.equal(outboundCount, 10);
  } finally {
    await runtime?.dispose();
  }
});
