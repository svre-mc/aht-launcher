import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI, workerLauncherProofFixture } from './helpers/launcher-proof-fixture.mjs';
const bundled = await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/curseforge-proxy-worker.js', import.meta.url))],
  write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
const serverToken = 'fixture-only-server-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'game-incident-test', modules: true,
  script: bundled.outputFiles[0].text, compatibilityDate: '2026-08-22', r2Buckets: ['AHT_DATA', 'AHT_RELEASES'],
  bindings: { AHT_LAUNCHER_STATE_SERVER_TOKEN: serverToken,
    LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI: TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI },
  outboundService: () => { throw new Error('External requests forbidden in incident fixture'); }
}] }));
try {
  const data = await runtime.getR2Bucket('AHT_DATA'), releases = await runtime.getR2Bucket('AHT_RELEASES');
  const minecraftUuid = '9ecd4430-e81c-4845-963c-934302789ddb';
  await data.put('accounts/usernames/shdwz3124.json', JSON.stringify({ username: 'Shdwz3124', minecraftUuid, installId: 'fixture-install' }));
  await releases.put('launcher/latest.json', JSON.stringify({ schemaVersion: 1, product: 'aht-launcher', version: '0.2.34', required: true }));
  const proof = workerLauncherProofFixture({ minecraftUsername: 'Shdwz3124', minecraftUuid, installId: 'fixture-install',
    launcherChannel: 'player', launcherVersion: '0.2.34', appVersion: '0.2.34' });
  const event = { id: randomUUID(), connectionId: randomUUID(), launchId: proof.payload.launchId, kind: 'disconnected',
    reasonCode: 'protocol_error', occurredAt: new Date().toISOString(), exceptionClasses: ['io.netty.handler.codec.DecoderException'],
    token: 'must-not-be-stored', metrics: { heapUsedBytes: 1024, password: 123 } };
  const post = (route, token, value) => runtime.dispatchFetch('https://fixture.test' + route, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const response = await post('/api/diagnostics/incidents', proof.token, event);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await post('/api/diagnostics/incidents', proof.token, event)).status, 200, 'idempotent R2 conditional write');
  assert.equal((await post('/server/diagnostics/incidents', serverToken, { ...event, id: randomUUID(),
    minecraftUuid, minecraftUsername: 'Shdwz3124', source: 'backend', reasonCode: 'remote_closed' })).status, 200);
  assert.equal((await runtime.dispatchFetch('https://fixture.test/server/diagnostics/incidents?uuid=' + minecraftUuid)).status, 401);
  const result = await runtime.dispatchFetch('https://fixture.test/server/diagnostics/incidents?player=Shdwz3124',
    { headers: { Authorization: `Bearer ${serverToken}` } });
  assert.equal(result.status, 200); const report = await result.json();
  assert.equal(report.incidents.length, 1); assert.equal(report.incidents[0].diagnosis.confidence, 'client-reported');
  assert(!JSON.stringify(report).includes('must-not-be-stored')); assert(!JSON.stringify(report).includes('password'));
  console.log('PASS: real workerd/R2 accepts authenticated correlated events, deduplicates conditional writes, redacts unlisted fields and denies public report reads.');
} finally { await runtime.dispose(); }
