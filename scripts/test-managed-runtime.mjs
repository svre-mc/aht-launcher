import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { ensureBundledJava8, WINDOWS_TEMURIN8, bundledJava8ArchivePath } from '../src/bundledJava8.js';
import { repairMinecraftAssetObjects } from '../src/minecraftAssets.js';
import { prepareRuntimeOnlyRepair, verifyRepairedJava } from '../src/runtimeRepair.js';
import { cleanJavaEnvironment } from '../src/javaEnvironment.js';
import { renameRuntimeDirectory } from '../src/runtimeFileOps.js';
import { ensureMinecraftLauncherAssets, inspectMinecraftLauncherRuntime } from '../src/minecraftLauncherProfile.js';
import { findInstalledForgeVersion, inspectJavaRuntime, friendlyForgeJavaErrorMessage } from '../src/forgeInstaller.js';
import { writeForgeInstallationFixture } from './helpers/forge-fixture.mjs';
import { writeMinecraftBaseFixture } from './helpers/minecraft-base-fixture.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-managed-runtime-'));
const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
try {
  const zip = new AdmZip();
  zip.addFile('jre8/bin/java.exe', Buffer.from('java-fixture'));
  zip.addFile('jre8/bin/server/jvm.dll', Buffer.from('jvm-fixture'));
  zip.addFile('jre8/lib/rt.jar', Buffer.from('runtime-fixture'));
  zip.addFile('jre8/LICENSE', Buffer.from('license-fixture'));
  const archive = path.join(root, 'java.zip');
  const bytes = zip.toBuffer();
  await fs.writeFile(archive, bytes);
  const descriptor = { version: 'test', size: bytes.length, sha256: hash(bytes), sourceUrl: 'https://example.test/source' };
  const options = {
    cacheDir: path.join(root, 'java'), archivePath: archive, descriptor, allowDownload: false,
    probe: async (javaPath) => {
      assert(!javaPath.includes('.temurin8-stage-'), 'Never execute Java in a directory that still needs to be moved.');
      return { usable: (await fs.readFile(javaPath, 'utf8')) === 'java-fixture', javaPath };
    }
  };
  const [first, simultaneous] = await Promise.all([ensureBundledJava8(options), ensureBundledJava8(options)]);
  assert.equal(first.javaPath, simultaneous.javaPath);
  await fs.rm(first.javaPath);
  assert.equal((await ensureBundledJava8(options)).usable, true, 'a cached success must not hide a subsequently missing Java executable');
  assert.equal(await fs.readFile(first.javaPath, 'utf8'), 'java-fixture');
  await assert.rejects(verifyRepairedJava({
    runtime: { usable: false, reason: 'Java executable was not found.' },
    profile: { javaRuntime: { usable: true } },
    probe: async () => { throw new Error('must not override failed runtime detection'); }
  }), /Repair could not verify Java 8/);
  await assert.rejects(verifyRepairedJava({
    runtime: { usable: true, path: first.javaPath }, profile: { javaRuntime: { usable: true } },
    probe: async (_file, _memory, settings) => {
      assert.equal(settings.reuseCachedProbe, false);
      throw new Error('Java executable disappeared after repair');
    }
  }), /disappeared after repair/);
  const checkedJava = await verifyRepairedJava({
    runtime: { usable: true, path: first.javaPath, bundled: true },
    profile: { javaPath: first.javaPath }, memoryMb: 4096,
    probe: async (file, memory, settings) => {
      assert.equal(settings.reuseCachedProbe, false);
      assert.equal(memory, 4096);
      return { javaPath: file, usable: true, heapReady: true };
    }
  });
  assert(checkedJava.bundled && checkedJava.heapReady);
  const runtimeJar = path.join(path.dirname(first.javaPath), '../lib/rt.jar');
  const originalTime = (await fs.stat(runtimeJar)).mtimeMs;
  await ensureBundledJava8({ ...options, refresh: true });
  assert.equal((await fs.stat(runtimeJar)).mtimeMs, originalTime, 'valid Java must not be extracted again');
  await fs.writeFile(runtimeJar, 'corrupt-fixture');
  await ensureBundledJava8({ ...options, refresh: true });
  assert.equal(await fs.readFile(runtimeJar, 'utf8'), 'runtime-fixture', 'repair restores corrupt JVM libraries offline');
  await fs.rm(runtimeJar);
  await ensureBundledJava8({ ...options, refresh: true });
  assert.equal(await fs.readFile(runtimeJar, 'utf8'), 'runtime-fixture');
  await fs.writeFile(archive, 'bad archive');
  await fs.writeFile(runtimeJar, 'corrupt-fixture');
  await assert.rejects(ensureBundledJava8({ ...options, refresh: true }), /archive is missing or damaged/);
  assert.equal(await fs.readFile(runtimeJar, 'utf8'), 'corrupt-fixture', 'failed recovery preserves the existing runtime');
  let renameAttempts = 0;
  const waited = [];
  await renameRuntimeDirectory('staging', 'installed', {
    platform: 'win32', wait: async (ms) => waited.push(ms),
    rename: async () => { if (++renameAttempts < 4) throw Object.assign(new Error('locked'), { code: 'EPERM' }); }
  });
  assert.equal(renameAttempts, 4);
  assert.deepEqual(waited, [100, 200, 400]);
  renameAttempts = 0;
  await assert.rejects(renameRuntimeDirectory('staging', 'installed', {
    platform: 'win32', wait: async () => {},
    rename: async () => { renameAttempts++; throw Object.assign(new Error('still locked'), { code: 'EPERM' }); }
  }), /still locked/);
  assert.equal(renameAttempts, 8, 'persistent permission failures stop after a bounded retry');
  renameAttempts = 0;
  await assert.rejects(renameRuntimeDirectory('staging', 'installed', {
    platform: 'win32', wait: async () => {},
    rename: async () => { renameAttempts++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
  }), /missing/);
  assert.equal(renameAttempts, 1);

  const contents = [Buffer.from('healthy'), Buffer.from('missing'), Buffer.from('corrupt')];
  const entries = contents.map((bytes) => ({ hash: hash(bytes, 'sha1'), size: bytes.length }));
  const index = { objects: Object.fromEntries(entries.map((entry, i) => [`asset-${i}`, entry])) };
  const objectFile = (entry) => path.join(root, 'assets/objects', entry.hash.slice(0, 2), entry.hash);
  for (const [i, bytes] of contents.entries()) {
    if (i === 1) continue;
    await fs.mkdir(path.dirname(objectFile(entries[i])), { recursive: true });
    await fs.writeFile(objectFile(entries[i]), i === 2 ? Buffer.alloc(bytes.length) : bytes);
  }
  const healthyTime = (await fs.stat(objectFile(entries[0]))).mtimeMs;
  const requests = [];
  const download = async (url, file) => {
    requests.push(url);
    const i = entries.findIndex((entry) => url.endsWith(entry.hash));
    assert.notEqual(i, -1);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents[i]);
  };
  const result = await repairMinecraftAssetObjects({ rootDir: root, index, download });
  assert.equal(result.downloaded, 2);
  assert.equal((await fs.stat(objectFile(entries[0]))).mtimeMs, healthyTime);
  assert.equal((await repairMinecraftAssetObjects({ rootDir: root, index, download })).downloaded, 0);
  assert.equal(requests.length, 2, 'unchanged assets are never downloaded again');
  await assert.rejects(repairMinecraftAssetObjects({ rootDir: root, index: { objects: { bad: { hash: '../escape', size: 1 } } }, download }), /invalid file hash/);
  await fs.writeFile(objectFile(entries[2]), Buffer.alloc(contents[2].length));
  await assert.rejects(repairMinecraftAssetObjects({ rootDir: root, index,
    download: async (_url, file) => fs.writeFile(file, 'bad') }), /checksum/);
  assert.equal((await fs.readFile(objectFile(entries[2]))).length, contents[2].length, 'failed download leaves previous asset intact');

  const instanceDir = path.join(root, 'instance');
  await fs.mkdir(path.join(instanceDir, '.aht-launcher'), { recursive: true });
  const latest = { packId: 'aht', version: '2.8.62', minecraft: { version: '1.12.2' } };
  await fs.writeFile(path.join(instanceDir, '.aht-launcher/installed.json'), JSON.stringify(latest));
  const scan = async () => ({ valid: true, counts: { managed: 3, corrupted: 0 } });
  assert.equal((await prepareRuntimeOnlyRepair({ instanceDir, latest, scan })).runtimeOnly, true);
  await assert.rejects(prepareRuntimeOnlyRepair({ instanceDir, latest: { ...latest, version: '2.8.63' }, scan }), /Update/);
  await assert.rejects(prepareRuntimeOnlyRepair({ instanceDir, latest, scan: async () => ({ valid: false }) }), /changed during/);

  const forgeRoot = path.join(root, 'minecraft');
  const forge = await writeForgeInstallationFixture(forgeRoot);
  const versionFile = path.join(forgeRoot, 'versions/1.12.2-forge-14.23.5.2860/1.12.2-forge-14.23.5.2860.json');
  const oldVersion = JSON.parse(await fs.readFile(versionFile, 'utf8'));
  oldVersion.assets = 'legacy';
  oldVersion.assetIndex = { id: 'legacy', url: 'https://example.test/retired.json' };
  oldVersion.libraries[0].natives = null;
  await fs.writeFile(versionFile, JSON.stringify(oldVersion));
  const plan = { rootDir: forgeRoot, minecraftVersion: '1.12.2', loaderId: 'forge-14.23.5.2860', versionId: oldVersion.id };
  assert.equal((await findInstalledForgeVersion(plan, { repairMetadata: false, backupInvalid: false })).installed, false);
  assert.equal((await findInstalledForgeVersion(plan, { verifyLibraries: true })).installed, true);
  const repaired = JSON.parse(await fs.readFile(versionFile, 'utf8'));
  assert.equal('assets' in repaired, false);
  assert.equal('assetIndex' in repaired, false);
  assert.equal('natives' in repaired.libraries[0], false);

  const fixture = await writeMinecraftBaseFixture(path.join(root, 'base-fixture'));
  fixture.metadata.downloads.client.url = path.join(fixture.fixtureDir, fixture.metadata.downloads.client.url);
  fixture.metadata.assetIndex.url = path.join(fixture.fixtureDir, fixture.metadata.assetIndex.url);
  for (const library of fixture.metadata.libraries) library.downloads.artifact.url = path.join(fixture.fixtureDir, library.downloads.artifact.url);
  const config = { minecraftLauncher: { rootDir: forgeRoot } };
  const profile = { rootDir: forgeRoot };
  assert.equal((await inspectMinecraftLauncherRuntime({ config, latest, profile })).usable, false);
  await ensureMinecraftLauncherAssets({ config, latest, profile, includeObjects: true,
    fetchJsonImpl: async (url) => url.includes('version_manifest')
      ? { versions: [{ id: '1.12.2', url: 'fixture-version' }] } : fixture.metadata });
  assert.equal((await inspectMinecraftLauncherRuntime({ config, latest, profile })).usable, true);
  await fs.writeFile(path.join(forgeRoot, 'versions/1.12.2/1.12.2.jar'), Buffer.alloc(fixture.clientBytes.length));
  assert.equal((await inspectMinecraftLauncherRuntime({ config, latest, profile })).usable, false);
  assert.match(friendlyForgeJavaErrorMessage(new Error('Unable to prepare assets for download')), /Repair in AHT Launcher/);

  assert.deepEqual(cleanJavaEnvironment({ JAVA_TOOL_OPTIONS: 'bad', _JAVA_OPTIONS: 'bad', jdk_java_options: 'bad', CLASSPATH: 'bad', PATH: 'keep', HTTPS_PROXY: 'keep' }), { PATH: 'keep', HTTPS_PROXY: 'keep' });

  if (process.platform === 'win32') {
    await import('./prepare-bundled-java.mjs');
    const previousJavaOptions = process.env._JAVA_OPTIONS;
    process.env._JAVA_OPTIONS = '-XX:AHTInvalidInjectedOption';
    const real = await ensureBundledJava8({ cacheDir: path.join(root, 'real-java'),
      archivePath: bundledJava8ArchivePath(''), allowDownload: false, probe: inspectJavaRuntime });
    if (previousJavaOptions === undefined) delete process.env._JAVA_OPTIONS;
    else process.env._JAVA_OPTIONS = previousJavaOptions;
    assert.equal(real.usable, true);
    assert.equal(real.major, 8);
    assert.equal(real.is64Bit, true);
    assert.match(real.vendor, /Adoptium|Temurin/i);
    assert.match(real.version, /1\.8\.0_504/);
    console.log(`Real bundled JVM passed: ${real.vendor} ${real.version}, ${real.arch}; archive ${(WINDOWS_TEMURIN8.size / 1048576).toFixed(1)} MiB.`);
  }
  console.log('Managed runtime tests passed: offline Java recovery, asset repair/dedup/integrity, clean-pack repair, stale Forge metadata, startup readiness, environment isolation.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
