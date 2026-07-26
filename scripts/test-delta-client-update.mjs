import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createClientModpackZip } from '../src/clientModpackZip.js';
import {
  CLIENT_DELTA_METADATA_ENTRY,
  CLIENT_DELTA_FORMAT,
  CLIENT_MANIFEST_FORMAT
} from '../src/clientPackFormat.js';
import { installPack } from '../src/installer.js';
import { scanManagedIntegrity } from '../src/localChanges.js';
import { buildRelease } from '../src/releaseBuilder.js';
import { pathExists, readJsonFile } from '../src/utils.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function writeFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function removeFile(root, relativePath) {
  await fs.rm(path.join(root, ...relativePath.split('/')), { force: true });
}

async function fileText(root, relativePath) {
  return fs.readFile(path.join(root, ...relativePath.split('/')), 'utf8');
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-delta-client-update-'));
const sourceDir = path.join(root, 'client');
const outDir = path.join(root, 'release');
const clientZipDir = path.join(root, 'client-zips');
const instanceDir = path.join(root, 'instance');
const packId = 'a-hard-time-dregora';

try {
  await writeFile(sourceDir, 'mods/keep.jar', 'keep-v1');
  await writeFile(sourceDir, 'mods/change.jar', 'change-v1');
  await writeFile(sourceDir, 'mods/delete.jar', 'delete-v1');
  await writeFile(sourceDir, 'mods/aht-version-lock-1.0.0.jar', 'version-lock');
  await writeFile(sourceDir, 'config/update.cfg', 'update=v1\n');
  await writeFile(sourceDir, 'config/delete.cfg', 'delete=true\n');
  await writeFile(sourceDir, 'config/player-editable.cfg', 'pack-default=true\n');
  await writeFile(sourceDir, 'config/jei/bookmarks.ini', 'pack-bookmarks\n');
  await writeFile(sourceDir, 'scripts/change.zs', 'print("v1");\n');
  await writeFile(sourceDir, 'scripts/delete.zs', 'print("delete");\n');
  await writeFile(sourceDir, 'resourcepacks/change.zip', 'resourcepack-v1');
  await writeFile(sourceDir, 'resources/unchanged.bin', Buffer.alloc(2 * 1024 * 1024, 0x5a));
  await writeFile(sourceDir, 'options.txt', 'pack-options\n');
  await writeFile(sourceDir, 'optionsof.txt', 'pack-optionsof\n');
  await writeFile(sourceDir, 'minecraftinstance.json', JSON.stringify({
    gameVersion: '1.12.2',
    baseModLoader: { forgeVersion: '14.23.5.2860' }
  }, null, 2));

  const zipV1 = await createClientModpackZip({
    sourceDir,
    outDir: clientZipDir,
    version: '2.8.100',
    name: 'A Hard Time',
    packId
  });
  const releaseV1 = await buildRelease({
    packZip: zipV1.zipPath,
    outDir,
    baseUrl: '',
    channel: 'stable'
  });
  assert(releaseV1.latest.clientManifest?.format === CLIENT_MANIFEST_FORMAT, 'version 1 did not publish a client manifest');
  assert(releaseV1.latest.delta === null, 'first manifest-aware release should not invent a delta baseline');

  const installV1 = await installPack({
    latestSource: path.join(outDir, 'latest.json'),
    instanceDir,
    logger: { log() {} }
  });
  assert(installV1.cleanInstall === true, 'version 1 should use a full clean install');
  const legacyLatest = structuredClone(releaseV1.latest);
  delete legacyLatest.clientManifest;
  delete legacyLatest.delta;
  await fs.writeFile(path.join(outDir, 'latest.json'), `${JSON.stringify(legacyLatest, null, 2)}\n`, 'utf8');
  await fs.rm(path.join(outDir, releaseV1.latest.clientManifest.path), { force: true });

  await writeFile(instanceDir, 'options.txt', 'player-options\n');
  await writeFile(instanceDir, 'optionsof.txt', 'player-optionsof\n');
  await writeFile(instanceDir, 'config/jei/bookmarks.ini', 'player-bookmarks\n');
  await writeFile(instanceDir, 'config/player-editable.cfg', 'player-custom-config-with-another-size\n');
  await writeFile(instanceDir, 'mods/unapproved-extra.jar', 'remove me');
  await writeFile(instanceDir, 'mods/OpenTerrainGenerator/runtime/generated.dat', 'runtime data');
  await writeFile(instanceDir, 'saves/Player World/level.dat', 'world data');

  await writeFile(sourceDir, 'mods/change.jar', 'change-v2');
  await writeFile(sourceDir, 'mods/add.jar', 'add-v2');
  await removeFile(sourceDir, 'mods/delete.jar');
  await writeFile(sourceDir, 'config/update.cfg', 'update=v2\n');
  await writeFile(sourceDir, 'config/add.cfg', 'added=true\n');
  await removeFile(sourceDir, 'config/delete.cfg');
  await writeFile(sourceDir, 'scripts/change.zs', 'print("v2");\n');
  await writeFile(sourceDir, 'scripts/add.zs', 'print("added");\n');
  await removeFile(sourceDir, 'scripts/delete.zs');
  await writeFile(sourceDir, 'resourcepacks/change.zip', 'resourcepack-v2');

  const zipV2 = await createClientModpackZip({
    sourceDir,
    outDir: clientZipDir,
    version: '2.8.101',
    name: 'A Hard Time',
    packId
  });
  const releaseV2 = await buildRelease({
    packZip: zipV2.zipPath,
    outDir,
    baseUrl: '',
    channel: 'stable'
  });
  assert(releaseV2.latest.delta?.format === CLIENT_DELTA_FORMAT, 'version 2 did not publish a delta');
  assert(releaseV2.report.deltaSummary.available === true, 'version 2 did not reconstruct the legacy local baseline');
  assert(releaseV2.latest.delta.fromVersion === '2.8.100', 'delta baseline version is wrong');
  assert(releaseV2.latest.delta.toVersion === '2.8.101', 'delta target version is wrong');
  assert(releaseV2.latest.delta.size < releaseV2.latest.zip.size, 'delta is not smaller than the full package');

  const deltaPath = path.join(outDir, releaseV2.latest.delta.path);
  const deltaZip = new AdmZip(deltaPath);
  const deltaMetadata = JSON.parse(deltaZip.readAsText(CLIENT_DELTA_METADATA_ENTRY));
  const deltaEntries = new Set(deltaZip.getEntries().filter((entry) => !entry.isDirectory).map((entry) => entry.entryName));
  for (const deletedPath of ['mods/delete.jar', 'config/delete.cfg', 'scripts/delete.zs']) {
    assert(deltaMetadata.deleted.includes(deletedPath), `delta did not declare deleted path ${deletedPath}`);
    assert(!deltaEntries.has(deletedPath), `deleted path ${deletedPath} should not be carried as payload data`);
  }
  assert(!deltaEntries.has('resources/unchanged.bin'), 'unchanged large resource should not be transferred');
  assert(deltaEntries.has('options.txt') && deltaEntries.has('optionsof.txt'), 'game settings must be available when the player opts to replace them');

  const progress = [];
  const logs = [];
  const installV2 = await installPack({
    latestSource: path.join(outDir, 'latest.json'),
    instanceDir,
    replaceGameSettings: false,
    onProgress: (event) => progress.push(event),
    logger: { log(line) { logs.push(String(line)); } }
  });
  assert(installV2.deltaApplied === true, `version 2 did not use its eligible delta: ${JSON.stringify({ installV2, logs })}`);
  assert(progress.some((event) => event.phase === 'Downloading changed files'), 'delta download progress was not reported');
  assert(progress.some((event) => event.phase === 'Removing retired files'), 'delta deletion progress was not reported');
  assert(progress.some((event) => event.phase === 'Applying changed files'), 'delta application progress was not reported');
  assert(!progress.some((event) => event.phase === 'Downloading pack'), 'eligible delta update downloaded the full pack');
  for (let index = 1; index < progress.length; index += 1) {
    assert(progress[index].percent >= progress[index - 1].percent, `delta progress moved backward at event ${index}`);
  }

  assert(await fileText(instanceDir, 'mods/change.jar') === 'change-v2', 'changed mod was not updated');
  assert(await fileText(instanceDir, 'mods/add.jar') === 'add-v2', 'added mod was not installed');
  assert(!(await pathExists(path.join(instanceDir, 'mods', 'delete.jar'))), 'deleted mod survived the delta');
  assert(!(await pathExists(path.join(instanceDir, 'mods', 'unapproved-extra.jar'))), 'unapproved extra mod survived the clean delta staging');
  assert(await fileText(instanceDir, 'config/update.cfg') === 'update=v2\n', 'changed config was not updated');
  assert(await fileText(instanceDir, 'config/add.cfg') === 'added=true\n', 'added config was not installed');
  assert(!(await pathExists(path.join(instanceDir, 'config', 'delete.cfg'))), 'deleted config survived the delta');
  assert(await fileText(instanceDir, 'scripts/change.zs') === 'print("v2");\n', 'changed script was not updated');
  assert(await fileText(instanceDir, 'scripts/add.zs') === 'print("added");\n', 'added script was not installed');
  assert(!(await pathExists(path.join(instanceDir, 'scripts', 'delete.zs'))), 'deleted script survived the delta');
  assert(await fileText(instanceDir, 'resourcepacks/change.zip') === 'resourcepack-v2', 'changed resource pack was not updated');
  assert(await fileText(instanceDir, 'config/player-editable.cfg') === 'player-custom-config-with-another-size\n', 'unchanged player-edited config was overwritten');
  assert(await fileText(instanceDir, 'options.txt') === 'player-options\n', 'player options were overwritten without consent');
  assert(await fileText(instanceDir, 'optionsof.txt') === 'player-optionsof\n', 'player OptiFine options were overwritten without consent');
  assert(await fileText(instanceDir, 'config/jei/bookmarks.ini') === 'player-bookmarks\n', 'JEI bookmarks were overwritten');
  assert(await fileText(instanceDir, 'mods/OpenTerrainGenerator/runtime/generated.dat') === 'runtime data', 'OpenTerrainGenerator runtime data was not preserved');
  assert(await fileText(instanceDir, 'saves/Player World/level.dat') === 'world data', 'player save was not preserved');

  const installed = await readJsonFile(path.join(instanceDir, '.aht-launcher', 'installed.json'));
  assert(installed.version === '2.8.101' && installed.updateMode === 'delta', 'installed state did not record the delta target');
  const managed = await readJsonFile(path.join(instanceDir, '.aht-launcher', 'managed-files.json'));
  assert(managed.some((file) => file.relativePath === 'mods/add.jar'), 'added mod is missing from managed state');
  assert(!managed.some((file) => file.relativePath === 'mods/delete.jar'), 'deleted mod remains in managed state');
  assert(!managed.some((file) => file.relativePath === 'config/jei/bookmarks.ini'), 'JEI bookmarks must remain player-owned');
  const integrity = await scanManagedIntegrity(instanceDir);
  assert(integrity.counts.corrupted === 0, `delta install is not clean: ${JSON.stringify(integrity)}`);

  const repair = await installPack({
    latestSource: path.join(outDir, 'latest.json'),
    instanceDir,
    forceRepair: true,
    replaceGameSettings: true,
    logger: { log() {} }
  });
  assert(repair.cleanInstall === true && repair.deltaApplied !== true, 'repair must use the full verified package');
  assert(await fileText(instanceDir, 'options.txt') === 'pack-options\n', 'repair with settings replacement did not restore pack options');

  const fallbackLatestPath = path.join(outDir, 'latest-fallback.json');
  await fs.writeFile(fallbackLatestPath, `${JSON.stringify({
    ...releaseV2.latest,
    delta: {
      ...releaseV2.latest.delta,
      fromVersion: releaseV2.latest.version
    }
  }, null, 2)}\n`, 'utf8');
  const fallbackLogs = [];
  const fallbackInstall = await installPack({
    latestSource: fallbackLatestPath,
    instanceDir,
    logger: { log(line) { fallbackLogs.push(String(line)); } }
  });
  assert(fallbackInstall.cleanInstall === true && fallbackInstall.deltaApplied !== true, 'mismatched delta did not fall back to a full clean install');
  assert(fallbackLogs.some((line) => line.includes('falling back to the full verified package')), 'delta fallback reason was not logged');

  console.log(JSON.stringify({
    ok: true,
    fullBytes: releaseV2.latest.zip.size,
    deltaBytes: releaseV2.latest.delta.size,
    changedFiles: releaseV2.latest.delta.changedFileCount,
    deletedFiles: releaseV2.latest.delta.deletedFileCount
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
