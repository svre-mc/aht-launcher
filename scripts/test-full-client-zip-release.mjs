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
await installPack({
  latestSource: path.join(outDir, 'latest.json'),
  instanceDir: installDir,
  replaceGameSettings: false,
  logger: { log() {} }
});

const installedMod = path.join(installDir, 'mods', 'aht-custom-patched.jar');
assert(await pathExists(installedMod), 'custom local jar was not installed from full client ZIP');
assert(await fs.readFile(installedMod, 'utf8') === 'patched jar bytes from local client', 'installed jar bytes do not match source client jar');
assert(await pathExists(path.join(installDir, 'resourcepacks', 'aht-resources.zip')), 'resourcepack folder was not installed correctly');
assert(await fs.readFile(path.join(installDir, 'options.txt'), 'utf8') === 'player-options\n', 'player options were replaced even though replaceGameSettings=false');

const managed = await readJsonFile(path.join(installDir, '.aht-launcher', 'managed-files.json'));
assert(managed.some((item) => item.relativePath === 'mods/aht-custom-patched.jar'), 'custom jar was not recorded as managed');
assert(!managed.some((item) => item.relativePath === 'options.txt' || item.relativePath === 'optionsof.txt'), 'game settings should not be managed integrity files');
const sourceHash = await hashFile(path.join(source, 'mods', 'aht-custom-patched.jar'), 'sha256');
const installedHash = await hashFile(installedMod, 'sha256');
assert(sourceHash === installedHash, 'managed mod hash mismatch after full-client install');

await fs.writeFile(path.join(installDir, 'mods', 'extra-untracked.jar'), 'extra mod should be blocked', 'utf8');
const dirtyScan = await scanManagedIntegrity(installDir);
assert(dirtyScan.counts.added === 1, `extra mod was not detected: ${JSON.stringify(dirtyScan)}`);
assert(dirtyScan.counts.corrupted === 1, `extra mod should lock launch as corrupted: ${JSON.stringify(dirtyScan)}`);
await installPack({
  latestSource: path.join(outDir, 'latest.json'),
  instanceDir: installDir,
  replaceGameSettings: true,
  forceRepair: true,
  logger: { log() {} }
});
assert(await fs.readFile(path.join(installDir, 'options.txt'), 'utf8') === 'pack-options\n', 'replaceGameSettings=true did not replace options.txt');
assert(!(await pathExists(path.join(installDir, 'mods', 'extra-untracked.jar'))), 'repair did not remove an untracked extra mod');
const repairedScan = await scanManagedIntegrity(installDir);
assert(repairedScan.counts.corrupted === 0, `repair did not return to clean integrity: ${JSON.stringify(repairedScan)}`);


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
console.log(JSON.stringify({
  ok: true,
  root,
  zipPath: zip.zipPath,
  installedHash,
  managedCount: managed.length
}, null, 2));
