import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildRelease } from '../src/releaseBuilder.js';
import { installPack } from '../src/installer.js';
import { pathExists, readJsonFile } from '../src/utils.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function writeResourcePackZip(filePath, description) {
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 3, description } }, null, 2)));
  zip.addFile('assets/aht/lang/en_us.lang', Buffer.from('aht.test=Resource Pack\n'));
  zip.writeZip(filePath);
}

async function writeModZip(filePath) {
  const zip = new AdmZip();
  zip.addFile('mcmod.info', Buffer.from('[{"modid":"aht_test_mod","name":"AHT Test Mod"}]'));
  zip.addFile('com/example/Test.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
  zip.writeZip(filePath);
}

async function writePackZip(filePath, overrideResourcePack, overrideMod) {
  const overridesDir = 'overrides\\client';
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: 'A Hard Time',
    version: '9.9.9-resourcepack-test',
    author: 'AHT',
    files: [],
    overrides: overridesDir
  }, null, 2)));
  zip.addFile('overrides\\client\\mods\\override-resourcepack.zip', await fs.readFile(overrideResourcePack));
  zip.addFile('overrides\\client\\mods\\override-mod.zip', await fs.readFile(overrideMod));
  zip.addFile('overrides\\client\\resourcepacks\\override-direct-resourcepack.zip', await fs.readFile(overrideResourcePack));
  zip.addFile('overrides\\client\\config\\aht-client.cfg', Buffer.from('client config=true\n'));
  zip.addFile('overrides\\client\\scripts\\startup.zs', Buffer.from('print("aht");\n'));
  zip.addFile('overrides\\client\\shaderpacks\\aht-shader.zip', Buffer.from('shader bytes\n'));
  zip.writeZip(filePath);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-resourcepack-placement-'));
const sourceInstance = path.join(temp, 'source-instance');
const outDir = path.join(temp, 'release');
const installDir = path.join(temp, 'install');
await fs.mkdir(path.join(sourceInstance, 'mods'), { recursive: true });
await fs.mkdir(path.join(sourceInstance, 'resourcepacks'), { recursive: true });
await fs.mkdir(path.join(sourceInstance, 'mods', '1.12.2'), { recursive: true });
await fs.mkdir(path.join(sourceInstance, 'mods', 'memory_repo'), { recursive: true });

const cacheResourcePack = path.join(sourceInstance, 'mods', 'cache-resourcepack.zip');
const directResourcePack = path.join(sourceInstance, 'resourcepacks', 'direct-resourcepack.zip');
const cacheModZip = path.join(sourceInstance, 'mods', 'cache-mod.zip');
const overrideResourcePack = path.join(temp, 'override-resourcepack.zip');
const overrideMod = path.join(temp, 'override-mod.zip');
await writeResourcePackZip(cacheResourcePack, 'cache resourcepack misplaced in mods');
await writeResourcePackZip(directResourcePack, 'direct resourcepack');
await writeResourcePackZip(overrideResourcePack, 'override resourcepack misplaced in mods');
await writeModZip(cacheModZip);
await writeModZip(overrideMod);
await fs.writeFile(path.join(sourceInstance, 'mods', 'private-mod.jar'), Buffer.from('private jar bytes\n'));
await fs.writeFile(path.join(sourceInstance, 'mods', '1.12.2', 'nested-library.jar'), Buffer.from('nested library should stay out\n'));
await fs.writeFile(path.join(sourceInstance, 'mods', 'memory_repo', 'memory-repo.jar'), Buffer.from('memory repo should stay out\n'));

const packZip = path.join(temp, 'aht-pack.zip');
await writePackZip(packZip, overrideResourcePack, overrideMod);

await buildRelease({
  packZip,
  outDir,
  baseUrl: '',
  cacheModsDir: path.join(sourceInstance, 'mods')
});

const latest = await readJsonFile(path.join(outDir, 'latest.json'));
assert(latest.overrides === 'overrides/client', 'release latest.json did not normalize the overrides path.');

const report = await readJsonFile(path.join(outDir, 'release-report.json'));
assert(report.overrideSummary.groups.config?.count === 1, 'override config files were not counted under config.');
assert(report.overrideSummary.groups.scripts?.count === 1, 'override scripts files were not counted under scripts.');
assert(report.overrideSummary.groups.shaderpacks?.count === 1, 'override shaderpacks files were not counted under shaderpacks.');
assert(report.overrideSummary.groups.resourcepacks?.count === 1, 'override resourcepacks files were not counted under resourcepacks.');

const cacheManifest = await readJsonFile(path.join(outDir, 'cache', 'mod-cache.json'));
const extraByName = new Map((cacheManifest.extraFiles || []).map((entry) => [entry.fileName, entry]));
assert(extraByName.get('cache-resourcepack.zip')?.installPath === 'resourcepacks/cache-resourcepack.zip', 'cache resourcepack from mods was not marked for resourcepacks.');
assert(extraByName.get('direct-resourcepack.zip')?.installPath === 'resourcepacks/direct-resourcepack.zip', 'source resourcepacks folder was not included as a resourcepack extra.');
assert(!extraByName.get('cache-mod.zip')?.installPath, 'real mod ZIP should not be marked as a resourcepack.');
assert(!extraByName.has('nested-library.jar'), 'nested mods/1.12.2 file should not be uploaded as a cache extra.');
assert(!extraByName.has('memory-repo.jar'), 'mods/memory_repo file should not be uploaded as a cache extra.');

await installPack({
  latestSource: path.join(outDir, 'latest.json'),
  instanceDir: installDir,
  forceRepair: false,
  logger: { log() {} }
});

const expectedFiles = [
  'resourcepacks/cache-resourcepack.zip',
  'resourcepacks/direct-resourcepack.zip',
  'resourcepacks/override-resourcepack.zip',
  'resourcepacks/override-direct-resourcepack.zip',
  'config/aht-client.cfg',
  'scripts/startup.zs',
  'shaderpacks/aht-shader.zip',
  'mods/cache-mod.zip',
  'mods/private-mod.jar',
  'mods/override-mod.zip'
];
for (const relPath of expectedFiles) {
  assert(await pathExists(path.join(installDir, relPath)), `missing expected installed file: ${relPath}`);
}

const forbiddenFiles = [
  'mods/cache-resourcepack.zip',
  'mods/direct-resourcepack.zip',
  'mods/override-resourcepack.zip',
  'mods/override-direct-resourcepack.zip',
  'mods/1.12.2/nested-library.jar',
  'mods/memory_repo/memory-repo.jar'
];
for (const relPath of forbiddenFiles) {
  assert(!(await pathExists(path.join(installDir, relPath))), `file was installed in the wrong folder: ${relPath}`);
}

const managedFiles = await readJsonFile(path.join(installDir, '.aht-launcher', 'managed-files.json'));
const managedPaths = new Set(managedFiles.map((entry) => entry.relativePath));
for (const relPath of expectedFiles) {
  assert(managedPaths.has(relPath), `managed-files.json missing ${relPath}`);
}

console.log(JSON.stringify({ ok: true, outDir, installDir, managedCount: managedFiles.length }, null, 2));