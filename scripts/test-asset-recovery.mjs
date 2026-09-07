import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { ensureMinecraftLauncherAssets, inspectMinecraftLauncherRuntime } from '../src/minecraftLauncherProfile.js';
import { repairMinecraftAssetObjects } from '../src/minecraftAssets.js';
import { findInstalledForgeVersion } from '../src/forgeInstaller.js';
import { writeMinecraftBaseFixture } from './helpers/minecraft-base-fixture.mjs';
import { writeForgeInstallationFixture } from './helpers/forge-fixture.mjs';
import { createLaunchAttempt, setLaunchRequirement } from '../src/launchDiagnostics.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-asset-recovery-'));
const hash = bytes => createHash('sha1').update(bytes).digest('hex');
const originalFetch = globalThis.fetch;
try {
  const fixture = await writeMinecraftBaseFixture(path.join(root, 'fixture'));
  const contents = [Buffer.from('sound-one'), Buffer.from('sound-two')];
  const index = { objects: Object.fromEntries(contents.map((bytes, i) => [`sound-${i}`, { hash: hash(bytes), size: bytes.length }])) };
  const indexBytes = Buffer.from(JSON.stringify(index));
  await fs.writeFile(path.join(fixture.fixtureDir, 'asset-index.json'), indexBytes);
  fixture.metadata.assetIndex = { id: '1.12', url: path.join(fixture.fixtureDir, 'asset-index.json'), sha1: hash(indexBytes), size: indexBytes.length };
  fixture.metadata.downloads.client.url = path.join(fixture.fixtureDir, 'client.jar');
  fixture.metadata.libraries[0].downloads.artifact.url = path.join(fixture.fixtureDir, 'base-library.jar');
  let requests = 0;
  globalThis.fetch = async url => {
    assert.match(String(url), /^https:\/\/resources\.download\.minecraft\.net\/[a-f0-9]{2}\/[a-f0-9]{40}$/);
    const bytes = contents.find(bytes => String(url).endsWith(hash(bytes)));
    assert(bytes);
    requests++;
    return new Response(bytes);
  };
  const gameRoot = path.join(root, 'minecraft');
  const config = { minecraftLauncher: { rootDir: gameRoot } };
  const latest = { minecraft: { version: '1.12.2' } };
  const options = { config, latest, profile: { rootDir: gameRoot }, fetchJsonImpl: async url =>
    String(url).includes('version_manifest') ? { versions: [{ id: '1.12.2', url: 'fixture-version' }] } : fixture.metadata };
  await ensureMinecraftLauncherAssets(options);
  assert.equal(requests, 2, 'Repair must download actual asset objects by default');
  assert.equal((await inspectMinecraftLauncherRuntime(options)).usable, true);
  const objectFile = path.join(gameRoot, 'assets/objects', hash(contents[0]).slice(0, 2), hash(contents[0]));
  await fs.writeFile(objectFile, Buffer.alloc(contents[0].length));
  await fs.utimes(objectFile, new Date(), new Date(Date.now() + 2000));
  assert.equal((await inspectMinecraftLauncherRuntime(options)).usable, false, 'same-size corruption invalidates startup readiness');
  await ensureMinecraftLauncherAssets(options);
  assert.equal(requests, 3);
  await ensureMinecraftLauncherAssets(options);
  assert.equal(requests, 3, 'verified assets are not downloaded again');
  await fs.writeFile(objectFile, Buffer.alloc(contents[0].length));
  await assert.rejects(repairMinecraftAssetObjects({ rootDir: gameRoot, index,
    download: async (_url, dest) => fs.writeFile(dest, 'bad') }), /checksum/);
  assert.equal((await fs.readFile(objectFile)).length, contents[0].length);
  assert.equal(await fs.stat(`${objectFile}.aht-repair`).catch(() => null), null);
  const versionFile = path.join(gameRoot, 'versions/1.12.2/1.12.2.json');
  for (const legacy of [{ assets: 'legacy' }, { assetIndex: { ...fixture.metadata.assetIndex, id: 'legacy' } }]) {
    await fs.writeFile(versionFile, JSON.stringify({ ...fixture.metadata, ...legacy }));
    assert.equal((await inspectMinecraftLauncherRuntime(options)).usable, false);
    await ensureMinecraftLauncherAssets(options);
    assert.equal((await inspectMinecraftLauncherRuntime(options)).usable, true);
    assert.equal(JSON.parse(await fs.readFile(versionFile)).assetIndex.id, '1.12');
  }
  const forge = await writeForgeInstallationFixture(gameRoot);
  await fs.writeFile(forge.versionJson, JSON.stringify({ ...forge.metadata, assets: 'legacy', assetIndex: { id: 'legacy' } }));
  const plan = { rootDir: gameRoot, minecraftVersion: '1.12.2', loaderId: 'forge-14.23.5.2860', versionId: forge.metadata.id };
  assert.equal((await findInstalledForgeVersion(plan, { repairMetadata: false, backupInvalid: false })).installed, false);
  assert.equal((await findInstalledForgeVersion(plan, { verifyLibraries: true })).installed, true);
  const fixed = JSON.parse(await fs.readFile(forge.versionJson));
  assert.equal('assets' in fixed, false);
  assert.equal('assetIndex' in fixed, false);

  const source = (await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const startup = source.slice(source.indexOf('async function prepareStartupPrerequisiteEntry('), source.indexOf('async function hydrateLaunchPreparationFromSnapshot('));
  const policy = source.match(/const STARTUP_PREREQUISITE_POLICY = '([^']+)'/)[1];
  for (const fail of [false, true]) {
    let repairs = 0;
    const installed = { version: 'fixture', packId: 'aht' };
    const profile = { profileId: 'aht', versionId: plan.versionId, profileExists: true, loaderInstalled: true };
    const context = {
      process: { platform: 'win32' }, Date, STARTUP_PREREQUISITE_POLICY: policy,
      createLaunchDiagnosticAttempt: createLaunchAttempt, launcherLegalStatus: async () => ({ required: false }),
      installedPackMatchesReleaseTarget: () => true, launchPreparationConfigSignature: () => 'config',
      samePath: (a, b) => a === b, launcherConfigFromPreparedPaths: () => config,
      preparedLauncherRouteForSnapshot: route => route, preparedLauncherRouteAvailable: async () => true,
      useBundledJava8: () => false, preparedJava8RuntimeAvailable: async () => true,
      minecraftJavaExecutable: async value => value, preparedProfileForSnapshot: value => value,
      inspectMinecraftLauncherProfile: async () => profile,
      inspectMinecraftLauncherRuntime: async () => ({ usable: false }),
      repairMinecraftRuntime: async () => { repairs++; if (fail) throw new Error('asset checksum failed'); return { profile, minecraftAssets: { repaired: true } }; },
      preparedIntegritySummaryForSnapshot: () => null, setLaunchRequirement,
      launchPreparationCache: new Map(), persistPreparedLaunchEntry: async () => {},
      markFailedLaunchRequirement: () => {}, completeLaunchAttempt: () => {},
      blockedLaunchPreparation: (_target, error) => ({ state: 'blocked', error: error.message })
    };
    vm.createContext(context);
    vm.runInContext(`${startup}\nglobalThis.prepare = prepareStartupPrerequisiteEntry;`, context);
    const result = await context.prepare({ target: { id: 'stable', name: 'AHT' }, config, installed }, {
      targetId: 'stable', prerequisitePolicy: policy, configSignature: 'config', installed, latest: installed,
      launcherRoute: { executablePath: 'MinecraftLauncher.exe' }, minecraftProfile: profile,
      java8Runtime: { usable: true, path: 'java.exe' }, identity: { installId: 'fixture' }
    });
    assert.equal(repairs, 1, 'Windows must check cached readiness even without bundled Java');
    assert.equal(result.state, fail ? 'blocked' : 'ready');
    if (!fail) assert.equal(result.launcherProof, null, 'asset recovery cannot bypass account authorization');
  }
  console.log('Asset recovery passed: default downloads, corrupt/missing files, checksum failures, stale indexes, Forge inheritance and cached Windows startup.');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(root, { recursive: true, force: true });
}
