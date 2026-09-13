import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { proveMinecraftAccountOwnership } from '../src/minecraftAccountRecovery.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-recovery-budget-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'launcher_accounts.json'), JSON.stringify({ accounts: {
    fixture: { remoteId: 'fixture', minecraftProfile: { name: 'FixturePlayer', id: 'a'.repeat(32) } }
  } }));
  return { roots: [root], username: 'FixturePlayer', minecraftUuid: 'a'.repeat(32), serverId: 'b'.repeat(40) };
}
async function bounded(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => resolve('stalled'), 500); })]); }
  finally { clearTimeout(timer); }
}

test('a stalled protected cache cannot prevent explicit fresh-session recovery', async t => {
  const options = await fixture(t);
  const result = await bounded(proveMinecraftAccountOwnership({ ...options, cacheTimeoutMs: 80,
    readWindowsSession: () => new Promise(() => {}), interactiveRecovery: async () => ({ verified: true, interactive: true }) }));
  assert.deepEqual(result, { verified: true, interactive: true });
});

test('cancellation during cached recovery stops without opening an interactive prompt', async t => {
  const options = await fixture(t);
  const controller = new AbortController();
  let opened = false;
  const operation = proveMinecraftAccountOwnership({ ...options, signal: controller.signal,
    readWindowsSession: () => { controller.abort(); return new Promise(() => {}); },
    interactiveRecovery: async () => { opened = true; return { verified: true }; } });
  const result = await bounded(operation.catch(error => error.code));
  assert.equal(result, 'AHT_ACCOUNT_RECOVERY_CANCELLED'); assert.equal(opened, false);
});

test('cache timeout without explicit recovery remains a verification failure', async t => {
  const options = await fixture(t);
  const result = await bounded(proveMinecraftAccountOwnership({ ...options, cacheTimeoutMs: 80,
    readWindowsSession: () => new Promise(() => {}) }).catch(error => error.code));
  assert.equal(result, 'MINECRAFT_OWNERSHIP_UNAVAILABLE');
});
