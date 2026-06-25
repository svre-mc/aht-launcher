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
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: 'A Hard Time',
    version: '9.9.9-resourcepack-test',
    author: 'AHT',
    files: [],
    overrides: 'overrides'
  }, null, 2)));
  zip.addFile('overrides/mods/override-resourcepack.zip', await fs.readFile(overrideResourcePack));
  zip.addFile('overrides/mods/override-mod.zip', await fs.readFile(overrideMod));
  zip.writeZip(filePath);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-resourcepack-placement-'));
const sourceInstance = path.join(temp, 'source-instance');
const outDir = path.join(temp, 'release');
const installDir = path.join(temp, 'install');
await fs.mkdir(path.join(sourceInstance, 'mods'), { recursive: true });
await fs.mkdir(path.join(sourceInstance, 'resourcepacks'), { recursive: true });

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

const packZip = path.join(temp, 'aht-pack.zip');
await writePackZip(packZip, overrideResourcePack, overrideMod);

await buildRelease({
  packZip,
  outDir,
  baseUrl: '',
  cacheModsDir: path.join(sourceInstance, 'mods')
});

const cacheManifest = await readJsonFile(path.join(outDir, 'cache', 'mod-cache.json'));
const extraByName = new Map((cacheManifest.extraFiles || []).map((entry) => [entry.fileName, entry]));
assert(extraByName.get('cache-resourcepack.zip')?.installPath === 'resourcepacks/cache-resourcepack.zip', 'cache resourcepack from mods was not marked for resourcepacks.');
assert(extraByName.get('direct-resourcepack.zip')?.installPath === 'resourcepacks/direct-resourcepack.zip', 'source resourcepacks folder was not included as a resourcepack extra.');
assert(!extraByName.get('cache-mod.zip')?.installPath, 'real mod ZIP should not be marked as a resourcepack.');

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
  'mods/override-resourcepack.zip'
];
for (const relPath of forbiddenFiles) {
  assert(!(await pathExists(path.join(installDir, relPath))), `resourcepack was installed in the wrong folder: ${relPath}`);
}

const managedFiles = await readJsonFile(path.join(installDir, '.aht-launcher', 'managed-files.json'));
const managedPaths = new Set(managedFiles.map((entry) => entry.relativePath));
for (const relPath of expectedFiles) {
  assert(managedPaths.has(relPath), `managed-files.json missing ${relPath}`);
}

console.log(JSON.stringify({ ok: true, outDir, installDir, managedCount: managedFiles.length }, null, 2));