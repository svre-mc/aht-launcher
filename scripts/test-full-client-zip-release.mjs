import fs from 'node:fs/promises';
import AdmZip from 'adm-zip';
import os from 'node:os';
import path from 'node:path';
import { createClientModpackZip } from '../src/clientModpackZip.js';
import { buildRelease } from '../src/releaseBuilder.js';
import { installPack } from '../src/installer.js';
import { scanManagedIntegrity } from '../src/localChanges.js';
import { hashFile, pathExists, readJsonFile } from '../src/utils.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertMonotonicProgress(events, label) {
  assert(events.length > 0, `${label} did not report progress`);
  for (let index = 1; index < events.length; index += 1) {
    assert(
      events[index].percent >= events[index - 1].percent,
      `${label} progress moved backward at ${index}: ${events[index - 1].percent} -> ${events[index].percent} (${events[index].phase})`
    );
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-full-client-zip-'));
const source = path.join(root, 'client');
const outDir = path.join(root, 'release');
const installDir = path.join(root, 'install');

await fs.mkdir(path.join(source, 'mods'), { recursive: true });
await fs.mkdir(path.join(source, 'mods', 'OpenTerrainGenerator', 'cache'), { recursive: true });
await fs.mkdir(path.join(source, 'config'), { recursive: true });
await fs.mkdir(path.join(source, 'resourcepacks'), { recursive: true });
await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
await fs.writeFile(path.join(source, 'mods', 'aht-custom-patched.jar'), 'patched jar bytes from local client', 'utf8');
await fs.writeFile(path.join(source, 'mods', 'aht-version-lock-1.0.0.jar'), 'version lock bytes', 'utf8');
await fs.writeFile(path.join(source, 'mods', 'OpenTerrainGenerator', 'cache', 'huge-runtime-cache.dat'), 'runtime cache should never be zipped', 'utf8');
await fs.writeFile(path.join(source, 'config', 'aht.cfg'), 'config=true\n', 'utf8');
await fs.writeFile(path.join(source, 'resourcepacks', 'aht-resources.zip'), 'resource bytes', 'utf8');
await fs.writeFile(path.join(source, 'scripts', 'startup.zs'), 'print("aht");\n', 'utf8');
await fs.writeFile(path.join(source, 'options.txt'), 'pack-options\n', 'utf8');
await fs.writeFile(path.join(source, 'optionsof.txt'), 'pack-optionsof\n', 'utf8');
await fs.writeFile(path.join(source, 'minecraftinstance.json'), JSON.stringify({
  gameVersion: '1.12.2',
  baseModLoader: { forgeVersion: '14.23.5.2860' }
}, null, 2), 'utf8');

const zip = await createClientModpackZip({
  sourceDir: source,
  outDir: path.join(outDir, 'client-zips'),
  version: '2.8.77',
  name: 'A Hard Time',
  packId: 'a-hard-time-dregora'
});
assert(await pathExists(zip.zipPath), 'client ZIP was not created');
assert(zip.metadata.format === 'aht-full-client-zip', 'client ZIP metadata format mismatch');
assert(zip.metadata.minecraft?.modLoaders?.[0]?.id === 'forge-14.23.5.2860', `Forge loader was not detected: ${JSON.stringify(zip.metadata.minecraft)}`);
assert(!Array.isArray(zip.files), 'client ZIP builder should not return the full file list to the UI by default');
assert(Array.isArray(zip.fileSamples) && zip.fileSamples.length > 0, 'client ZIP builder should return a small file sample for diagnostics');
const clientZipEntries = new Set(new AdmZip(zip.zipPath).getEntries().map((entry) => entry.entryName.replace(/\\/g, '/')));
assert(![...clientZipEntries].some((entry) => entry.toLowerCase().includes('/openterraingenerator/') || entry.toLowerCase().startsWith('mods/openterraingenerator/')), 'OpenTerrainGenerator runtime folder must not be included in client ZIPs');

const release = await buildRelease({
  packZip: zip.zipPath,
  outDir,
  baseUrl: '',
  channel: 'stable'
});
assert(release.latest.installMode === 'full-client-zip', 'release did not use full-client install mode');
assert(release.latest.curseforge?.disabled === true, 'full-client release should not use CurseForge resolution');
assert(release.latest.clientZip?.modFileCount >= 2, 'full-client release did not count mod archives');
assert(release.latest.serverLock?.clientModPath === 'mods/aht-version-lock-1.0.0.jar', 'full-client release did not record the client version lock mod');

await fs.mkdir(installDir, { recursive: true });
await fs.writeFile(path.join(installDir, 'options.txt'), 'player-options\n', 'utf8');
await fs.writeFile(path.join(installDir, 'optionsof.txt'), 'player-optionsof\n', 'utf8');
const firstProgress = [];
const firstInstall = await installPack({
  latestSource: path.join(outDir, 'latest.json'),
  instanceDir: installDir,
  replaceGameSettings: false,
  onProgress: (progress) => firstProgress.push(progress),
  logger: { log() {} }
});
assert(firstInstall.cleanInstall === true, 'full-client install should use clean staged replacement');
assert(firstProgress.some((progress) => progress.phase === 'Downloading pack' && progress.unit === 'bytes'), 'full-client install did not report byte download progress');
assert(firstProgress.some((progress) => progress.phase === 'Verifying pack' && progress.unit === 'bytes'), 'full-client install did not report byte verification progress');
assert(firstProgress.some((progress) => progress.phase === 'Full client ZIP'), 'full-client install did not report extraction progress');
assert(firstProgress.some((progress) => progress.phase === 'Preserving player data'), 'full-client install did not report player-data preservation progress');
assert(firstProgress.some((progress) => progress.phase === 'Caching pack' && progress.unit === 'bytes'), 'full-client install did not report ZIP cache copy progress');
assert(firstProgress.some((progress) => progress.phase === 'Finalizing' && progress.percent >= 97), 'full-client install did not advance finalizing progress after post-extraction work');
assertMonotonicProgress(firstProgress, 'full-client install');

const installedMod = path.join(installDir, 'mods', 'aht-custom-patched.jar');
assert(await pathExists(installedMod), 'custom local jar was not installed from full client ZIP');
assert(await fs.readFile(installedMod, 'utf8') === 'patched jar bytes from local client', 'installed jar bytes do not match source client jar');
assert(await pathExists(path.join(installDir, 'resourcepacks', 'aht-resources.zip')), 'resourcepack folder was not installed correctly');
assert(await fs.readFile(path.join(installDir, 'options.txt'), 'utf8') === 'player-options\n', 'player options were replaced even though replaceGameSettings=false');
assert(await fs.readFile(path.join(installDir, 'optionsof.txt'), 'utf8') === 'player-optionsof\n', 'player OptiFine options were replaced even though replaceGameSettings=false');

const managed = await readJsonFile(path.join(installDir, '.aht-launcher', 'managed-files.json'));
assert(managed.some((item) => item.relativePath === 'mods/aht-custom-patched.jar'), 'custom jar was not recorded as managed');
assert(!managed.some((item) => item.relativePath === 'options.txt' || item.relativePath === 'optionsof.txt'), 'game settings should not be managed integrity files');
const sourceHash = await hashFile(path.join(source, 'mods', 'aht-custom-patched.jar'), 'sha256');
const installedHash = await hashFile(installedMod, 'sha256');
assert(sourceHash === installedHash, 'managed mod hash mismatch after full-client install');

await fs.writeFile(path.join(installDir, 'mods', 'extra-untracked.jar'), 'extra mod should be blocked', 'utf8');
await fs.mkdir(path.join(installDir, 'mods', 'OpenTerrainGenerator', 'cache'), { recursive: true });
await fs.writeFile(path.join(installDir, 'mods', 'OpenTerrainGenerator', 'cache', 'stale-runtime-cache.dat'), 'stale otg cache', 'utf8');
await fs.mkdir(path.join(installDir, 'mods', 'OpenTerrainGenerator', 'cache', 'nested'), { recursive: true });
await fs.writeFile(path.join(installDir, 'mods', 'OpenTerrainGenerator', 'cache', 'nested', 'another-runtime-cache.dat'), 'another stale otg cache', 'utf8');
await fs.writeFile(path.join(installDir, 'config', 'stale-local.cfg'), 'stale local config\n', 'utf8');
await fs.writeFile(path.join(installDir, 'resourcepacks', 'stale-resourcepack.zip'), 'stale resourcepack\n', 'utf8');
await fs.mkdir(path.join(installDir, 'saves', 'Player World'), { recursive: true });
await fs.writeFile(path.join(installDir, 'saves', 'Player World', 'level.dat'), 'player world data', 'utf8');
await fs.mkdir(path.join(installDir, 'screenshots'), { recursive: true });
await fs.writeFile(path.join(installDir, 'screenshots', 'proof.png'), 'screenshot bytes', 'utf8');
await fs.mkdir(path.join(installDir, 'shaderpacks'), { recursive: true });
await fs.writeFile(path.join(installDir, 'shaderpacks', 'local-shader.zip'), 'player shaderpack', 'utf8');
await fs.mkdir(path.join(installDir, 'journeymap', 'data'), { recursive: true });
await fs.writeFile(path.join(installDir, 'journeymap', 'data', 'map.dat'), 'journeymap data', 'utf8');
await fs.mkdir(path.join(installDir, 'schematics'), { recursive: true });
await fs.writeFile(path.join(installDir, 'schematics', 'base.schematic'), 'schematic data', 'utf8');
await fs.mkdir(path.join(installDir, 'replay_videos'), { recursive: true });
await fs.writeFile(path.join(installDir, 'replay_videos', 'run.mcpr'), 'replay data', 'utf8');
await fs.writeFile(path.join(installDir, 'servers.dat'), 'player server list', 'utf8');
await fs.writeFile(path.join(installDir, 'servers.dat_old'), 'player old server list', 'utf8');
const staleSiblingStaging = path.join(root, '.install.aht-staging-crashed');
const staleSiblingBackup = path.join(root, '.install.aht-backup-crashed');
await fs.mkdir(staleSiblingStaging, { recursive: true });
await fs.writeFile(path.join(staleSiblingStaging, 'partial.tmp'), 'partial staging data', 'utf8');
await fs.mkdir(staleSiblingBackup, { recursive: true });
await fs.writeFile(path.join(staleSiblingBackup, 'old.tmp'), 'old backup data', 'utf8');
const dirtyScan = await scanManagedIntegrity(installDir);
assert(dirtyScan.counts.added === 1, `only extra unmanaged mod files should be detected: ${JSON.stringify(dirtyScan)}`);
assert(dirtyScan.counts.corrupted === 1, `only extra unmanaged mod files should lock launch as corrupted: ${JSON.stringify(dirtyScan)}`);
assert(dirtyScan.added.some((item) => item.path === 'mods/extra-untracked.jar'), `extra jar should be the only added issue: ${JSON.stringify(dirtyScan.added)}`);
assert(!dirtyScan.added.some((item) => /OpenTerrainGenerator/i.test(item.path)), `OpenTerrainGenerator runtime folder should not lock launch: ${JSON.stringify(dirtyScan.added)}`);
const integrityProgress = [];
const progressScan = await scanManagedIntegrity(installDir, { onProgress: (progress) => integrityProgress.push(progress) });
assert(progressScan.counts.corrupted === dirtyScan.counts.corrupted, 'progress-enabled integrity scan changed scan results');
assert(integrityProgress[0]?.phase === 'Verifying installed files', `integrity progress did not start with verification: ${JSON.stringify(integrityProgress)}`);
assert(integrityProgress.some((progress) => progress.currentPath === 'mods/aht-custom-patched.jar' && progress.percent > 0), `integrity progress did not report managed mod progress: ${JSON.stringify(integrityProgress)}`);
assert(integrityProgress.at(-1)?.phase === 'Integrity scan complete', `integrity progress did not report completion: ${JSON.stringify(integrityProgress)}`);
const repairProgress = [];
const repairInstall = await installPack({
  latestSource: path.join(outDir, 'latest.json'),
  instanceDir: installDir,
  replaceGameSettings: true,
  forceRepair: true,
  onProgress: (progress) => repairProgress.push(progress),
  logger: { log() {} }
});
assert(repairInstall.cleanInstall === true, 'full-client repair should use clean staged replacement');
assert(repairProgress.some((progress) => progress.phase === 'Verifying cached pack' && progress.unit === 'bytes'), 'full-client repair did not verify the cached pack before reinstalling');
assert(repairProgress.some((progress) => progress.phase === 'Preserving player data'), 'full-client repair did not report player-data preservation progress');
assert(repairProgress.some((progress) => progress.phase === 'Caching pack' && progress.unit === 'bytes'), 'full-client repair did not report ZIP cache copy progress');
assert(!repairProgress.some((progress) => progress.phase === 'Downloading pack'), 'full-client repair redownloaded the pack instead of reusing the verified cache');
assertMonotonicProgress(repairProgress, 'full-client repair');
assert(await fs.readFile(path.join(installDir, 'options.txt'), 'utf8') === 'pack-options\n', 'replaceGameSettings=true did not replace options.txt');
assert(await fs.readFile(path.join(installDir, 'optionsof.txt'), 'utf8') === 'pack-optionsof\n', 'replaceGameSettings=true did not replace optionsof.txt');
assert(!(await pathExists(path.join(installDir, 'mods', 'extra-untracked.jar'))), 'repair did not remove an untracked extra mod');
assert(await pathExists(path.join(installDir, 'mods', 'OpenTerrainGenerator', 'cache', 'stale-runtime-cache.dat')), 'repair should preserve the OpenTerrainGenerator runtime folder');
assert(await pathExists(path.join(installDir, 'mods', 'OpenTerrainGenerator', 'cache', 'nested', 'another-runtime-cache.dat')), 'repair should preserve nested OpenTerrainGenerator runtime files');
assert(!(await pathExists(path.join(installDir, 'config', 'stale-local.cfg'))), 'clean full-client repair did not remove stale config files');
assert(!(await pathExists(path.join(installDir, 'resourcepacks', 'stale-resourcepack.zip'))), 'clean full-client repair did not remove stale resourcepacks');
assert(await fs.readFile(path.join(installDir, 'saves', 'Player World', 'level.dat'), 'utf8') === 'player world data', 'player saves were not preserved during clean repair');
assert(await fs.readFile(path.join(installDir, 'screenshots', 'proof.png'), 'utf8') === 'screenshot bytes', 'screenshots were not preserved during clean repair');
assert(await fs.readFile(path.join(installDir, 'shaderpacks', 'local-shader.zip'), 'utf8') === 'player shaderpack', 'shaderpacks were not preserved during clean repair');
assert(await fs.readFile(path.join(installDir, 'journeymap', 'data', 'map.dat'), 'utf8') === 'journeymap data', 'journeymap data was not preserved during clean repair');
assert(await fs.readFile(path.join(installDir, 'schematics', 'base.schematic'), 'utf8') === 'schematic data', 'schematics were not preserved during clean repair');
assert(await fs.readFile(path.join(installDir, 'replay_videos', 'run.mcpr'), 'utf8') === 'replay data', 'replay videos were not preserved during clean repair');
assert(await fs.readFile(path.join(installDir, 'servers.dat'), 'utf8') === 'player server list', 'server list was not preserved during clean repair');
assert(await fs.readFile(path.join(installDir, 'servers.dat_old'), 'utf8') === 'player old server list', 'old server list was not preserved during clean repair');
const stateDownloads = await fs.readdir(path.join(installDir, '.aht-launcher', 'downloads'));
assert(stateDownloads.some((name) => name.endsWith('.zip')), 'current pack ZIP cache was not carried into the clean install');
const cachedPackPath = path.join(installDir, '.aht-launcher', 'downloads', stateDownloads.find((name) => name.endsWith('.zip')));
await fs.writeFile(cachedPackPath, 'corrupted partial zip from interrupted download', 'utf8');
const corruptCacheProgress = [];
const corruptCacheRepair = await installPack({
  latestSource: path.join(outDir, 'latest.json'),
  instanceDir: installDir,
  replaceGameSettings: true,
  forceRepair: true,
  onProgress: (progress) => corruptCacheProgress.push(progress),
  logger: { log() {} }
});
assert(corruptCacheRepair.cleanInstall === true, 'corrupt-cache repair should still use clean staged replacement');
assert(corruptCacheProgress.some((progress) => progress.phase === 'Verifying cached pack' && progress.unit === 'bytes'), 'corrupt-cache repair did not verify the stale cached pack');
assert(corruptCacheProgress.some((progress) => progress.phase === 'Downloading pack' && progress.unit === 'bytes'), 'corrupt-cache repair did not redownload after cached pack verification failed');
assert(await hashFile(cachedPackPath, 'sha256') === await hashFile(path.join(outDir, release.latest.zip.path), 'sha256'), 'corrupt cached pack ZIP was not replaced with the release ZIP');
const repairedAgainScan = await scanManagedIntegrity(installDir);
assert(repairedAgainScan.counts.corrupted === 0, `corrupt-cache repair did not return to clean integrity: ${JSON.stringify(repairedAgainScan)}`);
const rootEntriesAfterRepair = await fs.readdir(root);
assert(!rootEntriesAfterRepair.some((entry) => entry.startsWith('.install.aht-staging-') || entry.startsWith('.install.aht-backup-')), `staging or backup folder was left behind: ${rootEntriesAfterRepair.join(', ')}`);
const repairedScan = await scanManagedIntegrity(installDir);
assert(repairedScan.counts.corrupted === 0, `repair did not return to clean integrity: ${JSON.stringify(repairedScan)}`);

process.env.AHT_TEST_HOOKS = '1';
process.env.AHT_TEST_BACKUP_CLEANUP_FAILURE = '1';
const backupCleanupLogs = [];
const backupCleanupInstall = await installPack({
  latestSource: path.join(outDir, 'latest.json'),
  instanceDir: installDir,
  replaceGameSettings: true,
  forceRepair: true,
  logger: { log(line) { backupCleanupLogs.push(String(line)); } }
});
delete process.env.AHT_TEST_BACKUP_CLEANUP_FAILURE;
delete process.env.AHT_TEST_HOOKS;
assert(backupCleanupInstall.cleanInstall === true, 'backup cleanup failure should not fail a completed clean install swap');
assert(backupCleanupInstall.backupRemoved === false, `backup cleanup failure should be reported as a warning: ${JSON.stringify(backupCleanupInstall)}`);
assert(/Simulated backup cleanup failure/.test(backupCleanupInstall.backupCleanupWarning || ''), `backup cleanup warning missing simulated failure: ${JSON.stringify(backupCleanupInstall)}`);
assert(backupCleanupLogs.some((line) => /old install backup cleanup is pending/i.test(line)), `backup cleanup warning was not logged: ${JSON.stringify(backupCleanupLogs)}`);
assert(await pathExists(path.join(installDir, '.aht-launcher', 'installed.json')), 'completed install was not active after backup cleanup failure');
const backupCleanupScan = await scanManagedIntegrity(installDir);
assert(backupCleanupScan.counts.corrupted === 0, `backup cleanup warning left install corrupt: ${JSON.stringify(backupCleanupScan)}`);
const backupCleanupEntries = await fs.readdir(root);
assert(backupCleanupEntries.some((entry) => entry.startsWith('.install.aht-backup-')), `simulated cleanup failure should leave only a recoverable backup sibling: ${backupCleanupEntries.join(', ')}`);
const cleanupRecoveryInstall = await installPack({
  latestSource: path.join(outDir, 'latest.json'),
  instanceDir: installDir,
  replaceGameSettings: true,
  forceRepair: true,
  logger: { log() {} }
});
assert(cleanupRecoveryInstall.cleanInstall === true, 'cleanup recovery repair should still use clean staged replacement');
const cleanupRecoveryEntries = await fs.readdir(root);
assert(!cleanupRecoveryEntries.some((entry) => entry.startsWith('.install.aht-staging-') || entry.startsWith('.install.aht-backup-')), `cleanup recovery left staging or backup folders behind: ${cleanupRecoveryEntries.join(', ')}`);

const recoveryInstallDir = path.join(root, 'recover-install');
const recoveryBackupDir = path.join(root, '.recover-install.aht-backup-2000-crashed');
const recoveryOldBackupDir = path.join(root, '.recover-install.aht-backup-1000-old');
const recoveryStagingDir = path.join(root, '.recover-install.aht-staging-2000-crashed');
await fs.mkdir(recoveryOldBackupDir, { recursive: true });
await fs.writeFile(path.join(recoveryOldBackupDir, 'old.tmp'), 'older backup', 'utf8');
await fs.mkdir(path.join(recoveryBackupDir, 'saves', 'Recovered World'), { recursive: true });
await fs.writeFile(path.join(recoveryBackupDir, 'saves', 'Recovered World', 'level.dat'), 'recovered player save', 'utf8');
await fs.writeFile(path.join(recoveryBackupDir, 'servers.dat'), 'recovered servers', 'utf8');
await fs.mkdir(recoveryStagingDir, { recursive: true });
await fs.writeFile(path.join(recoveryStagingDir, 'partial.tmp'), 'partial staging', 'utf8');
const recoveryInstall = await installPack({
  latestSource: path.join(outDir, 'latest.json'),
  instanceDir: recoveryInstallDir,
  replaceGameSettings: true,
  forceRepair: true,
  logger: { log() {} }
});
assert(recoveryInstall.cleanInstall === true, 'recovery install should still use clean staged replacement');
assert(await fs.readFile(path.join(recoveryInstallDir, 'saves', 'Recovered World', 'level.dat'), 'utf8') === 'recovered player save', 'interrupted install backup was not restored before clean repair');
assert(await fs.readFile(path.join(recoveryInstallDir, 'servers.dat'), 'utf8') === 'recovered servers', 'server list from interrupted install backup was not preserved');
const recoveryRootEntries = await fs.readdir(root);
assert(!recoveryRootEntries.some((entry) => entry.startsWith('.recover-install.aht-staging-') || entry.startsWith('.recover-install.aht-backup-')), `recovered install left staging or backup folders behind: ${recoveryRootEntries.join(', ')}`);

const wrappedZipPath = path.join(root, 'wrapped-client.zip');
const wrapperZip = new AdmZip();
wrapperZip.addFile('A Hard Time Client/aht-client-pack.json', Buffer.from(JSON.stringify(zip.metadata, null, 2), 'utf8'));
wrapperZip.addFile('A Hard Time Client/mods/aht-wrapper.jar', Buffer.from('wrapped mod bytes', 'utf8'));
wrapperZip.addFile('A Hard Time Client/resourcepacks/aht-wrapper-resources.zip', Buffer.from('wrapped resource bytes', 'utf8'));
wrapperZip.addFile('A Hard Time Client/config/aht-wrapper.cfg', Buffer.from('wrappedConfig=true\n', 'utf8'));
wrapperZip.writeZip(wrappedZipPath);
const wrappedOutDir = path.join(root, 'wrapped-release');
const wrappedRelease = await buildRelease({
  packZip: wrappedZipPath,
  outDir: wrappedOutDir,
  baseUrl: '',
  channel: 'stable'
});
assert(wrappedRelease.latest.installMode === 'full-client-zip', 'wrapped full-client ZIP was not recognized as a full-client release');
assert(wrappedRelease.latest.serverLock?.injected === true, 'wrapped full-client ZIP should have the version lock injected during release build');
assert(wrappedRelease.latest.serverLock?.clientModPath === 'mods/aht-version-lock-1.0.0.jar', `wrapped full-client ZIP did not record injected version lock: ${JSON.stringify(wrappedRelease.latest.serverLock)}`);
assert(wrappedRelease.latest.clientZip?.modFileCount === 2, `wrapped full-client ZIP mod count should include injected version lock: ${JSON.stringify(wrappedRelease.latest.clientZip)}`);
const wrappedPublishedZip = new AdmZip(path.join(wrappedOutDir, wrappedRelease.latest.zip.path));
const wrappedPublishedEntries = new Set(wrappedPublishedZip.getEntries().map((entry) => entry.entryName.replace(/\\/g, '/')));
assert(wrappedPublishedEntries.has('A Hard Time Client/mods/aht-version-lock-1.0.0.jar'), 'published wrapped ZIP is missing injected version lock mod');
const wrappedInstallDir = path.join(root, 'wrapped-install');
await installPack({
  latestSource: path.join(wrappedOutDir, 'latest.json'),
  instanceDir: wrappedInstallDir,
  logger: { log() {} }
});
assert(await pathExists(path.join(wrappedInstallDir, 'mods', 'aht-wrapper.jar')), 'wrapped client ZIP installed under the wrapper folder instead of mods/');
assert(await pathExists(path.join(wrappedInstallDir, 'mods', 'aht-version-lock-1.0.0.jar')), 'wrapped client ZIP did not install injected version lock mod');
assert(!(await pathExists(path.join(wrappedInstallDir, 'A Hard Time Client', 'mods', 'aht-wrapper.jar'))), 'wrapped client ZIP left the wrapper folder inside the instance');
assert(await pathExists(path.join(wrappedInstallDir, 'resourcepacks', 'aht-wrapper-resources.zip')), 'wrapped client ZIP did not normalize resourcepacks/');
const wrappedScan = await scanManagedIntegrity(wrappedInstallDir);
assert(wrappedScan.counts.corrupted === 0, `wrapped client ZIP did not scan clean: ${JSON.stringify(wrappedScan)}`);

const largeStackZipPath = path.join(root, 'large-stack-client.zip');
const largeStackZip = new AdmZip();
const largeStackMetadata = {
  format: 'aht-full-client-zip',
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '9.9.1',
  minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }] },
  generatedAt: new Date().toISOString()
};
largeStackZip.addFile('aht-client-pack.json', Buffer.from(`${JSON.stringify(largeStackMetadata, null, 2)}\n`, 'utf8'));
for (let index = 0; index < 6500; index += 1) {
  largeStackZip.addFile(`config/stack-proof/${String(index).padStart(5, '0')}.cfg`, Buffer.from(`stack-proof=${index}\n`, 'utf8'));
}
largeStackZip.writeZip(largeStackZipPath);
const largeStackLatest = {
  schemaVersion: 1,
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '9.9.1',
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  minecraft: largeStackMetadata.minecraft,
  zip: {
    fileName: path.basename(largeStackZipPath),
    path: path.basename(largeStackZipPath),
    sha256: await hashFile(largeStackZipPath, 'sha256'),
    size: (await fs.stat(largeStackZipPath)).size
  }
};
const largeStackLatestPath = path.join(root, 'large-stack-latest.json');
await fs.writeFile(largeStackLatestPath, JSON.stringify(largeStackLatest, null, 2), 'utf8');
const largeStackResult = await installPack({
  latestSource: largeStackLatestPath,
  instanceDir: path.join(root, 'large-stack-install'),
  dryRun: true,
  logger: { log() {} }
});
assert(largeStackResult.installMode === 'full-client-zip', `large ZIP dry run used wrong mode: ${JSON.stringify(largeStackResult)}`);
assert(largeStackResult.overrideFileCount === 6500, `large ZIP dry run did not inspect every entry without stack overflow: ${JSON.stringify(largeStackResult)}`);
const largeStackRelease = await buildRelease({
  packZip: largeStackZipPath,
  outDir: path.join(root, 'large-stack-release'),
  baseUrl: '',
  channel: 'stable'
});
assert(largeStackRelease.latest.installMode === 'full-client-zip', 'large ZIP release build did not stay in full-client mode');
assert(largeStackRelease.latest.clientZip?.fileCount >= 6500, `large ZIP release build did not inspect every entry without stack overflow: ${JSON.stringify(largeStackRelease.latest.clientZip)}`);
assert(largeStackRelease.latest.clientZip?.modFileCount >= 1, `large ZIP release build did not include the injected version-lock mod: ${JSON.stringify(largeStackRelease.latest.clientZip)}`);
console.log(JSON.stringify({
  ok: true,
  root,
  zipPath: zip.zipPath,
  installedHash,
  managedCount: managed.length
}, null, 2));
