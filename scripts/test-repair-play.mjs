import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { installPack } from '../src/installer.js';
import { createClientModpackZip } from '../src/clientModpackZip.js';
import { buildRelease } from '../src/releaseBuilder.js';
import { scanManagedIntegrity, verifyManagedIntegritySnapshot } from '../src/localChanges.js';
import { prepareRuntimeOnlyRepair, repairPhoenixInstallation } from '../src/runtimeRepair.js';
import { contentTweakerBlockstates } from '../src/contentTweakerResources.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['bronze_block', 'glowing_ingot_block'];
const script = '#loader contenttweaker\nimport mods.contenttweaker.VanillaFactory;\n'
  + names.map(name => `val ${name} = VanillaFactory.createBlock("${name}", <blockmaterial:iron>);\n${name}.register();`).join('\n');
const resource = name => `resources/contenttweaker/blockstates/${name}.json`;
const blockstate = name => JSON.stringify({ forge_marker: 1, defaults: {
  textures: { texture: `contenttweaker:blocks/${name}`, particle: `contenttweaker:blocks/${name}` },
  model: 'base:storage', uvlock: true, transform: 'forge:default-block'
}, variants: { normal: [{}], inventory: [{}] } });
const logger = { log() {} };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-repair-play-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, bytes) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  const source = path.join(root, 'source');
  const instance = path.join(root, 'instance');
  await write(path.join(source, 'scripts/blocks.zs'), script);
  await write(path.join(source, 'mods/approved.jar'), 'approved bytes');
  return { root, write, source, instance };
}

test('reproduces both recurring extras; complete pack survives repeated Repair and protected verification', async t => {
  const f = await fixture(t);
  const zip = new AdmZip();
  zip.addFile('aht-client-pack.json', Buffer.from(JSON.stringify({ format: 'aht-full-client-zip' })));
  zip.addFile('scripts/blocks.zs', Buffer.from(script));
  zip.addFile('mods/approved.jar', Buffer.from('approved bytes'));
  const zipPath = path.join(f.root, 'legacy.zip');
  const legacy = zip.toBuffer();
  await f.write(zipPath, legacy);
  const latestSource = path.join(f.root, 'latest.json');
  const latest = { packId: 'fixture', version: '1', installMode: 'full-client-zip', zip: { path: zipPath, sha256: hash(legacy) } };
  await f.write(latestSource, JSON.stringify(latest));
  for (let attempt = 0; attempt < 2; attempt++) {
    await installPack({ latestSource, instanceDir: f.instance, forceRepair: true, logger });
    for (const name of names) await f.write(path.join(f.instance, resource(name)), blockstate(name));
    const scan = await scanManagedIntegrity(f.instance);
    assert.equal(scan.counts.corrupted, 2);
    assert.deepEqual(scan.added.map(file => file.path).sort(), names.map(resource).sort());
    assert.equal((await verifyManagedIntegritySnapshot(f.instance)).valid, false);
  }
  await assert.rejects(createClientModpackZip({ sourceDir: f.source, outDir: path.join(f.root, 'build'), version: '2' }), /missing ContentTweaker blockstates/);
  await assert.rejects(buildRelease({ packZip: zipPath, outDir: path.join(f.root, 'release') }), /missing ContentTweaker blockstates/);
  for (const name of names) await f.write(path.join(f.source, resource(name)), blockstate(name));
  const complete = await createClientModpackZip({ sourceDir: f.source, outDir: path.join(f.root, 'build'), version: '2' });
  const managedFiles = complete.metadata.files.map(row => ({ relativePath: row.path, sha256: row.sha256, size: row.size }));
  const bytes = await fs.readFile(complete.zipPath);
  await f.write(latestSource, JSON.stringify({ ...latest, version: '2', zip: { path: complete.zipPath, sha256: hash(bytes) } }));
  const preferences = 'volume=0.25';
  await f.write(path.join(f.instance, 'options.txt'), preferences);
  await f.write(path.join(f.instance, 'saves/world/level.dat'), 'player world');
  for (let attempt = 0; attempt < 2; attempt++) {
    await installPack({ latestSource, instanceDir: f.instance, forceRepair: true, logger });
    for (const name of names) assert.equal(await fs.readFile(path.join(f.instance, resource(name)), 'utf8'), blockstate(name));
    const options = { managedFiles, ignoreLocalManaged: true };
    assert.equal((await scanManagedIntegrity(f.instance, options)).valid, true);
    assert.equal((await verifyManagedIntegritySnapshot(f.instance, options)).valid, true);
    assert.equal(await fs.readFile(path.join(f.instance, 'options.txt'), 'utf8'), preferences);
    assert.equal(await fs.readFile(path.join(f.instance, 'saves/world/level.dat'), 'utf8'), 'player world');
  }
  await f.write(path.join(f.instance, resource(names[0])), '{"model":"unapproved"}');
  assert.equal((await verifyManagedIntegritySnapshot(f.instance, { managedFiles, ignoreLocalManaged: true })).valid, false);
});

test('runtime-only Repair escalates once for file damage, release changes or missing metadata', async t => {
  const f = await fixture(t);
  const latest = { packId: 'fixture', version: '1' };
  let repairs = 0;
  const repair = async () => { repairs++; return { installed: latest }; };
  const scan = async () => ({ valid: false, counts: { managed: 2, corrupted: 1 } });
  for (const metadata of [null, '{invalid', JSON.stringify({ ...latest, version: '0' }), JSON.stringify(latest)]) {
    if (metadata !== null) await f.write(path.join(f.instance, '.aht-launcher/installed.json'), metadata);
    const result = await prepareRuntimeOnlyRepair({ instanceDir: f.instance, latest, scan, repair });
    assert.equal(result.installed, latest);
  }
  assert.equal(repairs, 4);
  const result = await prepareRuntimeOnlyRepair({ instanceDir: f.instance, latest, repair,
    scan: async () => ({ valid: true, counts: { managed: 2, corrupted: 0 } }) });
  assert.equal(result.runtimeOnly, true);
  assert.equal(repairs, 4, 'healthy pack must reuse its files');
  await assert.rejects(prepareRuntimeOnlyRepair({ instanceDir: f.instance, latest, repair,
    scan: async () => { throw new Error('read permission denied'); } }), /permission denied/);
  assert.equal(repairs, 4, 'unknown scan failure must not authorize replacement');
});

test('Phoenix Repair honors consent, rechecks bytes and never retries indefinitely', async () => {
  let installs = 0;
  const install = async () => { installs++; };
  await assert.rejects(repairPhoenixInstallation({ getStatus: async () => ({ required: true, valid: false, consented: false }), install }), /Accept/);
  assert.equal(installs, 0);
  await assert.rejects(repairPhoenixInstallation({ getStatus: async () => ({ required: true, valid: false, consented: true }), install }), /could not be repaired/);
  assert.equal(installs, 1);
  let checks = 0;
  await repairPhoenixInstallation({ getStatus: async () => ({ required: true, valid: ++checks === 2, consented: true }), install });
  assert.equal(checks, 2);
  assert.equal(installs, 2);
  await repairPhoenixInstallation({ getStatus: async () => ({ required: false }), install });
  assert.equal(installs, 2);
});

test('pack validator ignores commented or unregistered blocks', () => {
  assert.deepEqual(contentTweakerBlockstates(`${script}\n// val unused = VanillaFactory.createBlock("unused", <blockmaterial:iron>); unused.register();`), names.map(resource));
  assert.deepEqual(contentTweakerBlockstates('#loader contenttweaker\nval unused = VanillaFactory.createBlock("unused", <blockmaterial:iron>);'), []);
});
