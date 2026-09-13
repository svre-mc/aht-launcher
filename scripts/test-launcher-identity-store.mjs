import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFile } from '../src/utils.js';
import { createLauncherIdentityStore } from '../src/launcherIdentityStore.js';

async function fixture(t, initial) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-identity-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'identity.json');
  if (initial !== undefined) await fs.writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
  if (process.env.AHT_IDENTITY_BASELINE === '1') {
    const main = (await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    const code = main.slice(main.indexOf('let identityLoadInFlight ='), main.indexOf('function developerClientBypassAllowed()'));
    const context = vm.createContext({ path, crypto: { randomUUID }, identityPath: () => file,
      pathExists: candidate => fs.stat(candidate).then(() => true, () => false),
      samePath: (a, b) => a === b, readJsonFile, writeJsonFile,
      isDeveloperMode: () => false, app: { getPath: () => root }, normalizeMinecraftUsername: value => value || '' });
    vm.runInContext(code, context);
    return { root, file, store: { read: () => context.loadIdentity() } };
  }
  const { createLauncherIdentityStore } = await import('../src/launcherIdentityStore.js');
  return { root, file, store: createLauncherIdentityStore({ file: () => file, legacyFiles: () => [],
    readJson: readJsonFile, writeJson: writeJsonFile, createId: randomUUID }) };
}

test('a corrupt existing identity is preserved and never silently replaced by a new install ID', async t => {
  const original = '{"installId":"existing-but-truncated"';
  const f = await fixture(t, original);
  await assert.rejects(f.store.read(), { code: 'AHT_IDENTITY_UNREADABLE' });
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
});

test('a structurally invalid existing identity is not silently reset', async t => {
  for (const initial of ['null', '[]', '{"installId":""}']) {
    const f = await fixture(t, initial);
    await assert.rejects(f.store.read(), { code: 'AHT_IDENTITY_UNREADABLE' });
    assert.equal(await fs.readFile(f.file, 'utf8'), initial);
  }
});

test('concurrent readers receive independent snapshots of one installation', async t => {
  const f = await fixture(t);
  const values = await Promise.all(Array.from({ length: 30 }, () => f.store.read()));
  assert.equal(new Set(values.map(value => value.installId)).size, 1);
  values[0].minecraftUsername = 'UncommittedChange';
  assert.equal(values[1].minecraftUsername, undefined, 'A caller must not mutate another caller’s identity snapshot');
  assert.equal((await f.store.read()).minecraftUsername, undefined);
});

test('serialized field mutations preserve unrelated updates and reject stale installation writes', async t => {
  if (process.env.AHT_IDENTITY_BASELINE === '1') return t.skip('New mutation API; baseline read bugs are exercised above.');
  const f = await fixture(t, { installId: 'fixture', minecraftUsername: 'FixturePlayer', count: 0 });
  await Promise.all(Array.from({ length: 20 }, () => f.store.mutate(value => ({ ...value, count: value.count + 1 }))));
  const value = await f.store.read();
  assert.equal(value.count, 20);
  assert.equal(value.minecraftUsername, 'FixturePlayer');
  await assert.rejects(f.store.mutate(current => ({ ...current, count: 99 }), { expectedInstallId: 'stale' }), { code: 'AHT_ACCOUNT_CHANGED' });
  await assert.rejects(f.store.mutate(current => ({ ...current, installId: 'replacement' })), { code: 'AHT_IDENTITY_REPLACEMENT_DENIED' });
  assert.equal((await f.store.read()).count, 20);
  await f.store.mutate(current => ({ ...current, count: 21 }));
  assert.equal((await f.store.read()).count, 21, 'Failure must not poison the write queue');
});

test('reads submitted after a queued mutation cannot reuse a pre-mutation snapshot', async () => {
  let value = { installId: 'fixture', minecraftUsername: 'Before' };
  let releaseRead;
  let first = true;
  const store = createLauncherIdentityStore({ file: () => 'fixture', readJson: async () => {
    const snapshot = { ...value };
    if (first) { first = false; await new Promise(resolve => { releaseRead = resolve; }); }
    return snapshot;
  }, writeJson: async (_file, next) => { value = { ...next }; } });
  const before = store.read();
  await Promise.resolve();
  const changed = store.mutate(current => ({ ...current, minecraftUsername: 'After' }));
  const after = store.read();
  releaseRead();
  assert.equal((await before).minecraftUsername, 'Before');
  await changed;
  assert.equal((await after).minecraftUsername, 'After');
});
