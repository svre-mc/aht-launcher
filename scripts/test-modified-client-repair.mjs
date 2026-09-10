import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { verifyManagedIntegritySnapshot } from '../src/localChanges.js';
import { installPack } from '../src/installer.js';
import { inspectPreservedModData, removeUnapprovedPreservedModData } from '../src/preservedModData.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-modified-client-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const instance = path.join(root, 'instance');
  const write = async (rel, bytes) => {
    const target = path.join(instance, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    return target;
  };
  const bytes = 'approved mod bytes';
  await write('mods/approved.jar', bytes);
  const managedFiles = [{ relativePath: 'mods/approved.jar', size: bytes.length, sha256: hash(bytes) }];
  const verify = (options = {}) => verifyManagedIntegritySnapshot(instance, { managedFiles, ignoreLocalManaged: true, ...options });
  return { root, instance, write, bytes, managedFiles, verify };
}

test('added/renamed/modified mods block while ordinary config remains mutable', async (t) => {
  const f = await fixture(t);
  const baseline = await f.verify();
  assert.equal(baseline.valid, true);
  await f.write('config/player.cfg', 'custom=true');
  assert.equal((await f.verify({ previousFileStates: baseline.fileStates })).valid, true);
  for (const rel of ['mods/modhider.jar', 'mods/1.12.2/renamed.bin', 'mods/.aht-launcher/hidden.jar']) {
    await f.write(rel, 'unauthorized');
    assert.equal((await f.verify({ previousFileStates: baseline.fileStates })).valid, false, rel);
    await fs.unlink(path.join(f.instance, rel));
  }
  await f.write('mods/approved.jar', 'altered! mod bytes');
  assert.equal((await f.verify({ previousFileStates: baseline.fileStates })).valid, false);
});

test('legacy worldgen data is not an executable hiding place', async (t) => {
  const f = await fixture(t);
  await f.write('mods/OpenTerrainGenerator/OTG.ini', 'normal=true');
  await f.write('mods/OpenTerrainGenerator/worlds/Dregora/objects/terrain.bo4', 'terrain');
  await f.write('mods/OpenTerrainGenerator/cache/terrain.dat', 'generated cache');
  const baseline = await f.verify();
  assert.equal(baseline.valid, true);
  await f.write('mods/OpenTerrainGenerator/worlds/Dregora/modhider.jar', 'unauthorized');
  assert.equal((await f.verify({ previousFileStates: baseline.fileStates })).valid, false,
    'An executable added under the exempt runtime directory was accepted');
});

test('a linked managed root cannot authorize files outside the instance', async (t) => {
  const f = await fixture(t);
  const external = path.join(f.root, 'external');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'approved.jar'), f.bytes);
  await fs.rename(path.join(f.instance, 'mods'), path.join(f.root, 'original-mods'));
  await fs.symlink(external, path.join(f.instance, 'mods'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.verify()).valid, false, 'Linked mods root was followed as trusted content');
});

test('runtime-data cache catches new deep entries, case variants and links without following them', async (t) => {
  const f = await fixture(t);
  await f.write('mods/openterraingenerator/worlds/nested/good.bo4', 'terrain');
  assert.equal((await f.verify()).valid, true);
  await f.write('mods/openterraingenerator/worlds/nested/extra.zip', 'unauthorized');
  assert.equal((await f.verify()).valid, false);
  await removeUnapprovedPreservedModData(f.instance);
  assert.equal((await f.verify()).valid, true);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.jar'), 'untouched');
  await fs.symlink(outside, path.join(f.instance, 'mods/openterraingenerator/worlds/linked'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await inspectPreservedModData(f.instance)).length, 1);
  await removeUnapprovedPreservedModData(f.instance);
  assert.equal(await fs.readFile(path.join(outside, 'keep.jar'), 'utf8'), 'untouched');
  assert.equal((await f.verify()).valid, true);
});

test('real full Repair removes extras and restores bytes without losing player data', async (t) => {
  const f = await fixture(t);
  const archive = new AdmZip();
  archive.addFile('aht-client-pack.json', Buffer.from(JSON.stringify({ format: 'aht-full-client-zip' })));
  archive.addFile('mods/approved.jar', Buffer.from(f.bytes));
  archive.addFile('config/pack.cfg', Buffer.from('published=true'));
  const zipBytes = archive.toBuffer();
  const zipPath = path.join(f.root, 'pack.zip');
  await fs.writeFile(zipPath, zipBytes);
  const latestSource = path.join(f.root, 'latest.json');
  await fs.writeFile(latestSource, JSON.stringify({ packId: 'repair-fixture', version: '1.0',
    name: 'Fixture', installMode: 'full-client-zip', zip: { path: zipPath, sha256: hash(zipBytes) } }));
  await f.write('mods/approved.jar', 'tampered');
  const extras = ['mods/modhider.jar', 'mods/1.12.2/renamed.bin', 'scripts/unapproved.zs',
    'mods/OpenTerrainGenerator/worlds/hidden.jar'];
  for (const rel of extras) await f.write(rel, 'unauthorized');
  await f.write('saves/world/level.dat', 'save');
  await f.write('screenshots/picture.png', 'picture');
  await f.write('mods/OpenTerrainGenerator/OTG.ini', 'worldgen');
  const outside = path.join(f.root, 'outside-repair');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.jar'), 'outside');
  await fs.symlink(outside, path.join(f.instance, 'mods/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await installPack({ latestSource, instanceDir: f.instance, forceRepair: true, logger: { log() {} } });
  for (const rel of extras) await assert.rejects(fs.lstat(path.join(f.instance, rel)), { code: 'ENOENT' }, rel);
  assert.equal(await fs.readFile(path.join(f.instance, 'mods/approved.jar'), 'utf8'), f.bytes);
  assert.equal(await fs.readFile(path.join(f.instance, 'saves/world/level.dat'), 'utf8'), 'save');
  assert.equal(await fs.readFile(path.join(f.instance, 'screenshots/picture.png'), 'utf8'), 'picture');
  assert.equal(await fs.readFile(path.join(f.instance, 'mods/OpenTerrainGenerator/OTG.ini'), 'utf8'), 'worldgen');
  await assert.rejects(fs.lstat(path.join(f.instance, 'mods/linked')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(outside, 'keep.jar'), 'utf8'), 'outside');
  assert.equal((await f.verify()).valid, true);
});

test('Repair cleanup refuses a linked instance root rather than modifying its target', async (t) => {
  const f = await fixture(t);
  const linked = path.join(f.root, 'linked-instance');
  await f.write('mods/OpenTerrainGenerator/keep.jar', 'outside selected repair root');
  await fs.symlink(f.instance, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeUnapprovedPreservedModData(linked), { code: 'AHT_MANAGED_CLIENT_CHANGED' });
  assert.equal(await fs.readFile(path.join(f.instance, 'mods/OpenTerrainGenerator/keep.jar'), 'utf8'), 'outside selected repair root');
});
