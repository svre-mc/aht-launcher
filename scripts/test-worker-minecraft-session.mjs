import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createDeviceCredential, createDeviceAssertion } from '../src/deviceIdentity.js';
import { buildLauncherProofPayload, launcherProofDeviceBinding } from '../src/launcherProof.js';
import { TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8, TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI } from './helpers/launcher-proof-fixture.mjs';

test('real Worker: Play is independent of AHT recovery; authenticated linking cannot expose another account', { timeout: 90000 }, async t => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/curseforge-proxy-worker.js', import.meta.url))],
    write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  const serverToken = 'test-only-server-token-aaaaaaaaaaaaaaaaaaaaaaaa';
  const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'session-authority-test', modules: true,
    script: bundled.outputFiles[0].text, compatibilityDate: process.env.AHT_WORKER_TEST_COMPATIBILITY_DATE || '2026-08-22',
    durableObjects: { AHT_LAUNCHER_STATE: { className: 'LauncherStateHub', useSQLite: true } },
    r2Buckets: ['AHT_DATA', 'AHT_RELEASES'], bindings: {
      AHT_REQUIRE_DEVICE_ATTESTATION: 'true', AHT_BLOCK_LIKELY_VPN: 'false', AHT_LAUNCHER_STATE_SERVER_TOKEN: serverToken,
      LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8: TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8,
      LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI: TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI,
      LAUNCHER_ATTESTATION_KEY_ID: 'aht-launcher-attestation-v2', LAUNCHER_PROOF_PACK_ID: 'a-hard-time-dregora'
    }, outboundService: () => { throw new Error('No ownership service or external request is permitted in this flow.'); }
  }] }));
  try {
    const bucket = await runtime.getR2Bucket('AHT_DATA');
    await (await runtime.getR2Bucket('AHT_RELEASES')).put('launcher/latest.json', JSON.stringify({ schemaVersion: 1, product: 'aht-launcher', required: true, version: '0.2.27' }));
    const credential = createDeviceCredential(), oldCredential = createDeviceCredential();
    const username = 'SessionFixture', minecraftUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const key = 'accounts/usernames/sessionfixture.json';
    const original = { username, minecraftUuid, installId: 'old-install', deviceId: oldCredential.deviceId,
      accountRecoveryVerifier: 'unusable-legacy-verifier', createdAt: '2026-01-01', privateMetadata: 'preserve-me' };
    const issue = async (changes = {}, tamper = false) => {
      const payload = { ...buildLauncherProofPayload({ config: { instanceDir: 'C:/test-only-instance' },
        identity: { minecraftUsername: username, minecraftUuid, installId: 'new-install', appVersion: '0.2.27',
          identityAuthority: 'minecraft-online-session', launcherChannel: 'player', deviceId: credential.deviceId, platform: 'win32' },
        installed: { version: '2.8.test' }, latest: { version: '2.8.test' }
      }), devicePublicKey: credential.publicKey, ...changes };
      payload.deviceAssertion = createDeviceAssertion(credential, { purpose: 'launcher-proof', binding: launcherProofDeviceBinding(payload) });
      if (tamper) payload.identityAuthority = '';
      return runtime.dispatchFetch('https://api.ahardtime.net/api/launcher-proof', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.40' }, body: JSON.stringify(payload) });
    };
    let proof;
    await t.test('missing and legacy registrations do not block clean Play or mutate accounts', async () => {
      let response = await issue();
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(await bucket.get(key), null);
      await bucket.put(key, JSON.stringify(original));
      response = await issue();
      assert.equal(response.status, 200, await response.clone().text());
      proof = await response.json();
      assert.equal(proof.payload.accountLinked, false);
      assert.equal(proof.payload.minecraftUuid, minecraftUuid);
      assert.equal(proof.payload.nativeGuardRequired, true);
      assert.equal(proof.payload.modIntegrityBypass, false);
      assert.deepEqual(await (await bucket.get(key)).json(), original);
    });
    const link = (authorization, changes = {}) => runtime.dispatchFetch('https://api.ahardtime.net/server/minecraft-session', {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof: proof.token, username, minecraftUuid, ...changes })
    });
    const social = token => runtime.dispatchFetch('https://api.ahardtime.net/api/social', { headers: { Authorization: `Bearer ${token}` } });
    await t.test('unlinked proofs cannot read social data or self-register', async () => {
      assert.equal((await social(proof.token)).status, 403);
      assert.equal((await link(`Bearer ${proof.token}`)).status, 401);
      assert.equal((await link(`Bearer ${serverToken}`, { username: 'WrongPlayer' })).status, 409);
      assert.deepEqual(await (await bucket.get(key)).json(), original);
    });
    await t.test('authenticated server links the matching account without replacing private data', async () => {
      const response = await link(`Bearer ${serverToken}`);
      assert.equal(response.status, 204, await response.clone().text());
      const record = await (await bucket.get(key)).json();
      assert.equal(record.privateMetadata, original.privateMetadata);
      assert.equal(record.createdAt, original.createdAt);
      assert.equal(record.installId, 'new-install');
      assert.equal(record.deviceId, credential.deviceId);
      assert.equal((await social(proof.token)).status, 200, 'authenticated admission enables this exact session without restarting');
      await bucket.put(key, JSON.stringify({ ...record, deviceId: oldCredential.deviceId }));
      assert.equal((await social(proof.token)).status, 403, 'current server-confirmed device binding is still required');
      await bucket.put(key, JSON.stringify(record));
      const next = await (await issue()).json();
      assert.equal(next.payload.accountLinked, true);
      assert.equal((await social(next.token)).status, 200);
      assert.equal((await link(`Bearer ${serverToken}`)).status, 204, 'link delivery is idempotent');
    });
    await t.test('device signatures, published versions and legacy proof authentication remain enforced', async () => {
      assert.equal((await issue({}, true)).status, 403);
      assert.equal((await issue({ appVersion: '0.1.00', launcherVersion: '0.1.00' })).status, 426);
      assert.equal((await issue({ identityAuthority: '' })).status, 403);
      assert.equal((await issue({ minecraftUuid: '' })).status, 400);
    });
    await t.test('Repair/new key cannot bypass old device, account or UUID restrictions', async () => {
      await bucket.put(key, JSON.stringify(original));
      for (const [scope, value] of [['device', oldCredential.deviceId], ['device', credential.deviceId], ['account', username.toLowerCase()], ['minecraft_uuid', minecraftUuid]]) {
        const denialKey = `access/decisions/${scope}/${createHash('sha256').update(`${scope}\0${value}`).digest('hex')}.json`;
        await bucket.put(denialKey, JSON.stringify({ active: true, effect: 'deny', scope, value, decisionId: 'test-restriction' }));
        assert.equal((await issue()).status, 403, scope);
        assert.equal((await link(`Bearer ${serverToken}`)).status, 403, scope);
        assert.deepEqual(await (await bucket.get(key)).json(), original);
        await bucket.delete(denialKey);
      }
    });
  } finally { await runtime.dispose(); }
});
