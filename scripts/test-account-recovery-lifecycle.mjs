import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMinecraftInteractiveRecovery } from '../src/minecraftInteractiveRecovery.js';

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-recovery-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mc = path.join(root, 'minecraft');
  await fs.mkdir(mc);
  const original = { version: 3, profiles: { game: {
    name: 'A Hard Time', lastVersionId: 'forge', gameDir: path.join(root, 'pack'),
    javaDir: path.join(root, 'java', 'bin', 'java')
  }, unrelated: { name: 'Keep this profile' } } };
  const file = path.join(mc, 'launcher_profiles.json');
  await fs.writeFile(file, JSON.stringify(original));
  const options = { config: { instanceDir: path.join(root, 'pack'), minecraftLauncher: {
    rootDir: mc, profileId: 'game', syncRoots: [], ...extra
  } }, username: 'FixturePlayer', minecraftUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  serverId: 'a'.repeat(40), journalPath: path.join(root, 'pending.json'), timeoutMs: 2000 };
  return { root, mc, file, original, options, async callback() {
    const profiles = JSON.parse(await fs.readFile(file, 'utf8'));
    const id = Object.keys(profiles.profiles).find(key => key.startsWith('aht-account-recovery-'));
    const version = JSON.parse(await fs.readFile(path.join(mc, 'versions', id, `${id}.json`), 'utf8'));
    return version.minecraftArguments.split(' ').at(-1);
  }, async assertClean() {
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
    assert.equal(await fs.stat(options.journalPath).then(() => true, () => false), false);
  } };
}

test('immediate cancellation never dispatches Minecraft Launcher and cleans its own temporary state', async t => {
  const f = await fixture(t);
  let opened = 0;
  const recovery = createMinecraftInteractiveRecovery();
  const running = recovery.run({ ...f.options, openLauncher: async () => { opened++; } });
  recovery.cancel();
  await assert.rejects(running, { code: 'AHT_ACCOUNT_RECOVERY_CANCELLED' });
  assert.equal(opened, 0, 'Cancel must not open a launcher after cancellation');
  assert.equal(recovery.state().running, false);
  await f.assertClean();
});

test('stale missing secondary launcher roots do not strand a valid primary recovery', async t => {
  const f = await fixture(t);
  f.options.config.minecraftLauncher.syncRoots = [path.join(f.root, 'removed-curseforge')];
  const recovery = createMinecraftInteractiveRecovery();
  let opened = 0;
  const result = await recovery.run({ ...f.options, openLauncher: async () => {
    opened++;
    const response = await fetch(await f.callback(), { method: 'POST', body: '{"result":"verified"}' });
    assert.equal(response.status, 204);
  } });
  assert.equal(result.verified, true);
  assert.equal(opened, 1);
  await f.assertClean();
});

test('a stuck launcher handoff cannot hold recovery open after cancellation', async t => {
  const f = await fixture(t);
  const recovery = createMinecraftInteractiveRecovery();
  let entered;
  const opened = new Promise(resolve => { entered = resolve; });
  let release;
  const handoff = new Promise(resolve => { release = resolve; });
  const running = recovery.run({ ...f.options, openLauncher: () => { entered(); return handoff; } });
  const result = running.then(() => 'resolved', error => error.code);
  await opened;
  recovery.cancel();
  let timer;
  // Include real profile/journal cleanup on loaded CI filesystems. The handoff
  // stays unresolved until after this assertion's observation, so a wait on that
  // handoff still fails; this is a cancellation bound, not a 150 ms disk SLA.
  const observed = await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve('stuck'), 1000); })]);
  clearTimeout(timer);
  release();
  await result;
  assert.equal(observed, 'AHT_ACCOUNT_RECOVERY_CANCELLED');
  await f.assertClean();
});
