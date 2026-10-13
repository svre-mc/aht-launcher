import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { normalizeIncident, correlateIncidents } from '../src/gameIncidentContract.js';
import { createGameIncidentMonitor, createIncrementalReader, diagnosticSymbols, startGameIncidentWorker } from '../src/gameIncidentMonitor.js';
import { storeIncident } from '../cloudflare/game-incidents.js';
import worker from '../cloudflare/curseforge-proxy-worker.js';
import { TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI, workerLauncherProofFixture } from './helpers/launcher-proof-fixture.mjs';

const playerUuid = '9ecd4430-e81c-4845-963c-934302789ddb';
const event = (overrides = {}) => ({ id: crypto.randomUUID(), launchId: crypto.randomUUID(), connectionId: crypto.randomUUID(),
  kind: 'disconnected', reasonCode: 'remote_closed', occurredAt: new Date().toISOString(), ...overrides });
function bucket() {
  const map = new Map(); let version = 0;
  return { map, async get(key) { const item = map.get(key); return item ? { etag: item.etag, json: async () => JSON.parse(item.value) } : null; },
    async put(key, value, options = {}) { const old = map.get(key);
      if (options.onlyIf?.etagMatches && old?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.etagDoesNotMatch === '*' && old) return null;
      const etag = String(++version); map.set(key, { value, etag }); return { etag }; },
    async list({ prefix, limit = 1000, cursor = '0' }) { const keys = [...map.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = Number(cursor); const page = keys.slice(start, start + limit); const next = start + page.length;
      return { objects: page.map(key => ({ key })), truncated: next < keys.length, cursor: String(next) }; } };
}

test('generic socket closure stays unresolved; distinct launches cannot merge', () => {
  const a = event(); const b = event({ launchId: a.launchId });
  const report = correlateIncidents([{ source: 'backend', events: [a] }, { source: 'proxy', events: [b] }]);
  assert.equal(report.incidents.length, 1); assert.equal(report.incidents[0].diagnosis.code, 'unresolved');
  assert.deepEqual(report.incidents[0].missingSources, ['client']);
  b.launchId = crypto.randomUUID();
  assert.equal(correlateIncidents([{ source: 'backend', events: [a] }, { source: 'client', events: [b] }]).incidents.length, 2);
});
test('ordinary client quitting is distinguished from an unexplained remote close', () => {
  const a = event({ reasonCode: 'local_quit' }); const b = event({ launchId: a.launchId });
  const result = correlateIncidents([{ source: 'client', events: [a] }, { source: 'backend', events: [b] }]);
  assert.equal(result.incidents[0].diagnosis.code, 'local_quit');
});

test('allowlist drops raw text, secrets, paths, unknown fields and invalid numeric data', () => {
  const clean = normalizeIncident(event({ reason: 'secret', token: 'secret', exceptionClasses: ['java.io.IOException', 'Bearer secret'],
    stackFrames: ['com.example.Client#read:12', 'C:/Users/private'], metrics: { heapUsedBytes: 100, password: 123, queuedBytes: Infinity } }));
  assert(!JSON.stringify(clean).includes('secret')); assert(!JSON.stringify(clean).includes('private'));
  assert.deepEqual(clean.metrics, { heapUsedBytes: 100 });
  assert.throws(() => normalizeIncident(event({ occurredAt: '2000-01-01T00:00:00Z' })));
  assert.deepEqual(diagnosticSymbols('[12:00:00] [Client thread/INFO]: <Player> password java.lang.OutOfMemoryError').exceptionClasses, []);
});

test('incremental reader skips historical errors, joins partial lines and detects rotation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-incident-reader-'));
  try {
    const file = path.join(root, 'latest.log'); await fs.writeFile(file, 'historical\n');
    const read = await createIncrementalReader(root, 'latest.log');
    await fs.appendFile(file, 'current'); assert.deepEqual(await read(), []);
    await fs.appendFile(file, '\n'); assert.deepEqual(await read(), ['current']);
    await fs.rename(file, path.join(root, 'previous.log')); await fs.writeFile(file, 'rotated\n');
    assert.deepEqual(await read(), ['rotated']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('monitor captures the exact client exception, retries outages and saves only safe fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-game-incidents-')); const launchId = crypto.randomUUID();
  let clock = Date.now(), fail = true; const sent = [];
  try {
    await fs.mkdir(path.join(root, 'logs'), { recursive: true });
    await fs.writeFile(path.join(root, 'logs/latest.log'), '[12:00:00] [Client thread/ERROR]: OLD java.lang.OutOfMemoryError\n');
    const monitor = await createGameIncidentMonitor({ instanceDir: root, launchId, gamePid: 123 },
      { now: () => clock, alive: () => true, send: async body => { if (fail) throw Object.assign(new Error('secret URL'), { status: 503 }); sent.push(body); } });
    const observed = event({ launchId, reasonCode: 'protocol_error', occurredAt: new Date(clock).toISOString(),
      exceptionClasses: ['io.netty.handler.codec.DecoderException'], stackFrames: ['com.example.Packet#read:54'], token: 'secret' });
    await fs.appendFile(path.join(root, 'logs/aht-diagnostics/client-events.jsonl'), JSON.stringify(observed) + '\n');
    const first = await monitor.tick(); assert.equal(first.pending, 1); assert.equal(monitor.history.length, 1);
    const report = JSON.parse(await fs.readFile(path.join(root, 'logs/aht-diagnostics/latest-client-report.json')));
    assert.equal(report.delivery, 'pending'); assert.equal(report.lastError, 'HTTP_503'); assert(!JSON.stringify(report).includes('secret'));
    clock += 10000; fail = false; await monitor.tick(); assert.equal(sent.length, 1);
    assert.equal(sent[0].reasonCode, 'protocol_error'); assert.equal(sent[0].exceptionClasses[0], 'io.netty.handler.codec.DecoderException');
    assert(!sent[0].exceptionClasses.includes('java.lang.OutOfMemoryError'), 'historical startup failure leaked into current incident');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('worker bootstrap keeps credentials off arguments and has a hidden detached lifecycle', () => {
  let spawned, input = '';
  startGameIncidentWorker({ launchId: crypto.randomUUID(), instanceDir: 'fixture', token: 'private-fixture-token',
    endpoint: 'https://worker.test/api/diagnostics/incidents' }, { script: 'fixture.mjs', spawnImpl: (exe, args, options) => {
      spawned = { exe, args, options }; return { once() {}, unref() {}, stdin: { on() {}, end(value) { input = value; } } }; } });
  assert(!JSON.stringify(spawned.args).includes('private-fixture-token')); assert(input.includes('private-fixture-token'));
  assert.equal(spawned.options.windowsHide, true); assert.equal(spawned.options.detached, true);
});

test('storage is bounded, idempotent and preserves concurrent same-session events', async () => {
  const data = bucket(); const identity = { minecraftUuid: playerUuid }; const launchId = crypto.randomUUID();
  const a = event({ launchId }); const b = event({ launchId });
  await Promise.all([storeIncident(data, identity, 'client', a), storeIncident(data, identity, 'client', b)]);
  await storeIncident(data, identity, 'client', a);
  assert.equal(JSON.parse([...data.map.values()][0].value).events.length, 2);
  for (let i = 0; i < 40; i++) await storeIncident(data, identity, 'client', event({ launchId }));
  assert.equal(JSON.parse([...data.map.values()][0].value).events.length, 32);
  for (let i = 0; i < 100; i++) await storeIncident(data, identity, 'client', event());
  assert(data.map.size <= 32);
});

test('actual Worker routes enforce proof identity, server authority and private reads', async () => {
  const data = bucket(); const releases = bucket(); const serverToken = 'fixture-only-server-token-aaaaaaaaaaaaaaaaaaaa';
  await releases.put('launcher/latest.json', JSON.stringify({ schemaVersion: 1, product: 'aht-launcher', version: '0.2.34', channel: 'stable', required: true }));
  await data.put('accounts/usernames/shdwz3124.json', JSON.stringify({ username: 'Shdwz3124', minecraftUuid: playerUuid, installId: 'fixture-install' }));
  const proof = workerLauncherProofFixture({ minecraftUsername: 'Shdwz3124', minecraftUuid: playerUuid, installId: 'fixture-install',
    appVersion: '0.2.34', launcherVersion: '0.2.34', launcherChannel: 'player', accessGranted: true });
  const env = { AHT_DATA: data, AHT_RELEASES: releases, AHT_LAUNCHER_STATE_SERVER_TOKEN: serverToken,
    LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI: TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI };
  const call = (route, token, body) => worker.fetch(new Request('https://worker.test' + route, { method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, {});
  const current = event({ launchId: proof.payload.launchId, minecraftUuid: 'forged', source: 'backend' });
  assert.equal((await call('/api/diagnostics/incidents', 'forged', current)).status, 401);
  assert.equal((await call('/api/diagnostics/incidents', proof.token, { ...current, launchId: crypto.randomUUID() })).status, 400);
  const accepted = await call('/api/diagnostics/incidents', proof.token, current);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const record = [...data.map.entries()].find(([key]) => key.startsWith('diagnostics/'));
  assert(record[0].includes(playerUuid.replaceAll('-', ''))); assert.equal(JSON.parse(record[1].value).source, 'client');
  assert.equal((await call('/server/diagnostics/incidents', proof.token, { ...current, minecraftUuid: playerUuid })).status, 401);
  assert.equal((await call('/admin/diagnostics/incidents?uuid=' + playerUuid, proof.token)).status, 401);
  const report = await call('/server/diagnostics/incidents?uuid=' + playerUuid, serverToken);
  assert.equal(report.status, 200); assert.match(report.headers.get('Cache-Control'), /no-store/);
  assert.equal((await report.json()).incidents[0].diagnosis.code, 'unresolved');
});
