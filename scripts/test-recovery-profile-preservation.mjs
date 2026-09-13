import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareRecoveryProfiles, cleanRecoveryTransaction, cleanRecoveryJournal } from '../src/minecraftRecoveryProfile.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-profile-preservation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'launcher_profiles.json');
  await fs.writeFile(file, JSON.stringify({ version: 2, selectedProfile: 'game', profiles: { game: { javaDir: path.join(root, 'java.exe') } } }));
  return { root, file, config: { instanceDir: path.join(root, 'pack'), minecraftLauncher: { rootDir: root, profileId: 'game' } },
    id: 'aht-account-recovery-' + 'a'.repeat(24), journalPath: path.join(root, 'pending.json') };
}

test('recovery preparation preserves another launcher editing profiles while helper files are prepared', async t => {
  const f = await fixture(t); const entries = []; const originalWrite = fs.writeFile; let changed = false;
  try {
    fs.writeFile = async (file, ...args) => {
      if (!changed && String(file).includes(`${path.sep}libraries${path.sep}`)) {
        changed = true;
        const current = JSON.parse(await fs.readFile(f.file, 'utf8'));
        current.profiles.other = { name: 'Created in Minecraft Launcher during recovery' };
        current.selectedProfile = 'other'; current.settings = { keepThis: true };
        await originalWrite(f.file, JSON.stringify(current));
      }
      return originalWrite(file, ...args);
    };
    await prepareRecoveryProfiles({ ...f, roots: [f.root], entries, pin: { version: 1 }, jar: Buffer.from('fixture'), args: [] });
  } finally { fs.writeFile = originalWrite; }
  const prepared = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert(prepared.profiles.other, 'Concurrent unrelated profile was overwritten');
  assert.deepEqual(prepared.settings, { keepThis: true });
  await cleanRecoveryTransaction({ ...f, entries });
  const cleaned = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(cleaned.selectedProfile, 'other'); assert(cleaned.profiles.other); assert(!cleaned.profiles[f.id]);
});

test('cleanup cannot discard journal work for a Minecraft root outside the current configuration', async t => {
  const f = await fixture(t);
  const journal = { id: f.id, roots: [{ root: f.root, previousSelection: 'game' }, { root: path.join(f.root, 'previous-root') }] };
  await fs.writeFile(f.journalPath, JSON.stringify(journal));
  await cleanRecoveryJournal(f);
  assert.equal(await fs.stat(f.journalPath).then(() => true, () => false), true, 'Unprocessed root lost its cleanup journal');
});

test('cleanup for an aborted transaction does not remove another transaction journal', async t => {
  const f = await fixture(t);
  const journal = { id: 'aht-account-recovery-' + 'b'.repeat(24), roots: [{ root: f.root }] };
  await fs.writeFile(f.journalPath, JSON.stringify(journal));
  await cleanRecoveryTransaction({ ...f, entries: [] });
  assert.deepEqual(JSON.parse(await fs.readFile(f.journalPath, 'utf8')), journal);
});

test('a new recovery preserves deferred cleanup until its old root becomes configured again', async t => {
  const f = await fixture(t); const entries = [];
  const oldId = 'aht-account-recovery-' + 'b'.repeat(24);
  const previousRoot = path.join(f.root, 'previous-root');
  await fs.writeFile(f.journalPath, JSON.stringify({ id: oldId, roots: [{ root: previousRoot }] }));
  await prepareRecoveryProfiles({ ...f, roots: [f.root], entries, pin: { version: 1 }, jar: Buffer.from('fixture'), args: [] });
  await cleanRecoveryTransaction({ ...f, entries });
  const pending = JSON.parse(await fs.readFile(f.journalPath, 'utf8'));
  assert.equal(pending.id, oldId); assert.deepEqual(pending.roots, [{ root: previousRoot }]);
  f.config.minecraftLauncher.syncRoots = [previousRoot];
  assert.equal(await cleanRecoveryJournal(f), true);
  await assert.rejects(fs.access(f.journalPath), { code: 'ENOENT' });
});
