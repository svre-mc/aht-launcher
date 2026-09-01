import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  defaultMinecraftRoot,
  ensureMinecraftLauncherAssets,
  ensureMinecraftLauncherProfile,
  inspectMinecraftLauncherAuth,
  inspectMinecraftLauncherProfile,
  minecraftRootCandidates,
  loaderVersionId,
  selectPreparedMinecraftLauncherProfile,
  setMinecraftLauncherHomePage
} from '../src/minecraftLauncherProfile.js';
import {
  buildForgeInstallPlan,
  detectJava8Runtime,
  findInstalledForgeVersion,
  forgeInstallerUrl,
  friendlyForgeJavaErrorMessage,
  installForgeLoader,
  javaSetupHelpMessage,
  minecraftJavaExecutable,
  resolveMinecraftProfileJavaPath,
  resolveJavaPath
} from '../src/forgeInstaller.js';
import { writeForgeInstallationFixture } from './helpers/forge-fixture.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-profile-test-'));
process.env.AHT_TEST_HOOKS = '1';
process.env.AHT_TEST_JAVA_RUNTIME_PROBE = 'release-file';
process.env.AHT_TEST_JAVA_ARCH = 'amd64';
const instanceDir = path.join(root, 'instance');
const minecraftRoot = path.join(root, '.minecraft');
const versionId = '1.12.2-forge-14.23.5.2860';
await writeForgeInstallationFixture(minecraftRoot, { versionId });

const platformRoots = {
  win32: defaultMinecraftRoot('win32', {
    APPDATA: 'C:\\Users\\Player\\AppData\\Roaming',
    USERPROFILE: 'C:\\Users\\Player'
  }),
  darwin: defaultMinecraftRoot('darwin', { HOME: '/Users/player' })
};
if (platformRoots.win32 !== 'C:\\Users\\Player\\AppData\\Roaming\\.minecraft') {
  throw new Error(`Unexpected Windows Minecraft root: ${platformRoots.win32}`);
}
if (platformRoots.darwin !== '/Users/player/Library/Application Support/minecraft') {
  throw new Error(`Unexpected macOS Minecraft root: ${platformRoots.darwin}`);
}

const macRootCandidates = minecraftRootCandidates('darwin', { HOME: '/Users/player' });
if (
  macRootCandidates[0] !== '/Users/player/Library/Application Support/minecraft'
  || !macRootCandidates.includes('/Users/player/Library/Application Support/Minecraft')
  || !macRootCandidates.includes('/Users/player/Library/Application Support/com.mojang.minecraftlauncher')
) {
  throw new Error(`Unexpected macOS Minecraft root candidates: ${JSON.stringify(macRootCandidates)}`);
}
const winRootCandidates = minecraftRootCandidates('win32', {
  APPDATA: 'C:\\Users\\Player\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Player\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\Player'
});
const winStoreRoot = 'C:\\Users\\Player\\AppData\\Local\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Roaming\\.minecraft';
if (winRootCandidates[0] !== platformRoots.win32 || !winRootCandidates.includes(winStoreRoot)) {
  throw new Error(`Unexpected Windows Minecraft root candidates: ${JSON.stringify(winRootCandidates)}`);
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true, installerUrl: 'https://example.test/forge-installer.jar' }],
    recommendedRam: 6304
  }
};
const config = {
  packId: 'a-hard-time-dregora',
  instanceDir,
  minecraftLauncher: {
    enabled: true,
    rootDir: minecraftRoot,
    profileId: 'a-hard-time-dregora',
    profileName: 'A Hard Time',
    syncDefaultRoots: false
  }
};
const legacyJavaPath = path.join(root, 'legacy-java', 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java');
const recentCompetingLastUsed = new Date(Date.now() - 60_000).toISOString();

if (loaderVersionId(latest.minecraft) !== versionId) {
  throw new Error('Forge loader id was not mapped to the expected Minecraft Launcher version id.');
}
if (
  loaderVersionId({ version: '../1.12.2', modLoaders: latest.minecraft.modLoaders })
  || loaderVersionId({ version: '1.12.2', modLoaders: [{ id: 'forge-../escape', primary: true }] })
) {
  throw new Error('Unsafe Minecraft or loader identifiers were accepted for launcher paths.');
}

await fs.writeFile(path.join(minecraftRoot, 'launcher_profiles.json'), `${JSON.stringify({
  profiles: {
    'random-profile': {
      name: 'A Random Instance',
      type: 'custom',
      gameDir: path.join(root, 'random-instance'),
      lastUsed: recentCompetingLastUsed
    },
    'a-hard-time': {
      name: 'A Hard Time Dregora',
      type: 'custom',
      gameDir: path.join(root, 'old-aht-instance'),
      javaDir: legacyJavaPath,
      lastUsed: '2026-01-01T00:00:00.000Z'
    }
  },
  selectedProfile: 'random-profile',
  version: 6
}, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(minecraftRoot, 'launcher_accounts.json'), `${JSON.stringify({
  activeAccountLocalId: 'active-account',
  accounts: {
    'active-account': { remoteId: 'active-remote-account' }
  }
}, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(minecraftRoot, 'launcher_quick_play.json'), `${JSON.stringify({
  quickPlayData: {
    'active-remote-account': [{
      epochLastPlayedTimeMs: Date.now() - 60_000,
      id: 'random-profile',
      javaInstance: { configId: 'random-profile' },
      source: 'Java'
    }]
  },
  version: 2
}, null, 2)}\n`, 'utf8');
const created = await ensureMinecraftLauncherProfile({ config, latest, installed: null });
const inspected = await inspectMinecraftLauncherProfile({ config, latest, installed: null });
const profiles = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
const profile = profiles.profiles['a-hard-time-dregora'];

if (!created.profileExists || !inspected.loaderInstalled || !profile) {
  throw new Error('Minecraft Launcher profile was not created or inspected correctly.');
}
if (profile.lastVersionId !== versionId) {
  throw new Error(`Expected ${versionId}, got ${profile.lastVersionId}`);
}
if (profile.gameDir !== path.resolve(instanceDir)) {
  throw new Error(`Expected gameDir ${path.resolve(instanceDir)}, got ${profile.gameDir}`);
}
if (profiles.profiles['a-hard-time'] || profiles.selectedProfile !== 'random-profile') {
  throw new Error(`Legacy AHT state was not migrated without preserving the unrelated selection: ${JSON.stringify(profiles)}`);
}
if (path.resolve(profile.javaDir || '') !== path.resolve(legacyJavaPath)) {
  throw new Error(`Legacy Java was not preserved during stale-path migration: ${JSON.stringify(profile)}`);
}
if (!profile.javaArgs.includes('-Xmx6144m') || !profile.javaArgs.includes('-Daht.launcher.present=true') || !profile.javaArgs.includes('-Daht.launcher.proofFile=')) {
  throw new Error(`Expected RAM and launcher proof args, got ${profile.javaArgs}`);
}
const stableSelection = await ensureMinecraftLauncherProfile({ config, latest, installed: null, selectForPlay: true });
let selectedProfiles = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
let selectedKeys = Object.keys(selectedProfiles.profiles);
if (
  !stableSelection.selectionPrepared
  || !stableSelection.quickPlayPrepared?.changed
  || selectedKeys.at(-1) !== 'a-hard-time-dregora'
  || Date.parse(selectedProfiles.profiles['a-hard-time-dregora'].lastUsed) <= Date.parse(selectedProfiles.profiles['random-profile'].lastUsed)
  || Date.parse(selectedProfiles.profiles['a-hard-time-dregora'].lastUsed) > Date.now() + (5 * 60 * 1000)
  || selectedProfiles.selectedProfile !== 'random-profile'
) {
  throw new Error(`Stable Play did not outrank and reinsert the exact profile while preserving foreign modern selection state: ${JSON.stringify(selectedProfiles)}`);
}
const selectedQuickPlay = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_quick_play.json'), 'utf8'));
const selectedQuickPlayEntries = selectedQuickPlay.quickPlayData['active-remote-account'];
if (
  selectedQuickPlayEntries?.[0]?.javaInstance?.configId !== 'a-hard-time-dregora'
  || selectedQuickPlayEntries.filter((entry) => entry?.javaInstance?.configId === 'a-hard-time-dregora').length !== 1
  || selectedQuickPlayEntries.some((entry, index) => index > 0 && entry?.javaInstance?.configId === 'a-hard-time-dregora')
) {
  throw new Error(`Minecraft Launcher quick-play selection did not move the exact AHT profile to the active account: ${JSON.stringify(selectedQuickPlay)}`);
}
const curseForgeForeignProfile = {
  name: 'CurseForge Owned Instance',
  type: 'custom',
  gameDir: path.join(root, 'curseforge-owned-instance'),
  lastVersionId: 'forge-14.23.5.2860',
  lastUsed: recentCompetingLastUsed,
  foreignSentinel: { preserved: true }
};
const curseForgeForeignSettings = {
  crashAssistance: false,
  enableAdvanced: true,
  foreignSentinel: ['preserve', 'exactly']
};
await fs.writeFile(path.join(minecraftRoot, 'launcher_profiles.json'), `${JSON.stringify({
  profiles: { 'curseforge-owned': curseForgeForeignProfile },
  settings: curseForgeForeignSettings,
  version: 6
}, null, 2)}\n`, 'utf8');
const repairedStableSelection = await selectPreparedMinecraftLauncherProfile(stableSelection);
selectedProfiles = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
selectedKeys = Object.keys(selectedProfiles.profiles);
if (
  !repairedStableSelection.selectionPrepared
  || !selectedProfiles.profiles['a-hard-time-dregora']
  || selectedKeys.at(-1) !== 'a-hard-time-dregora'
  || Object.prototype.hasOwnProperty.call(selectedProfiles, 'selectedProfile')
  || JSON.stringify(selectedProfiles.profiles['curseforge-owned']) !== JSON.stringify(curseForgeForeignProfile)
  || JSON.stringify(selectedProfiles.settings) !== JSON.stringify(curseForgeForeignSettings)
) {
  throw new Error(`Prepared AHT profile repair damaged or malformed foreign CurseForge schema-6 metadata: ${JSON.stringify(selectedProfiles)}`);
}
const selectedStableLastUsed = selectedProfiles.profiles['a-hard-time-dregora'].lastUsed;
await ensureMinecraftLauncherProfile({
  config: {
    ...config,
    minecraftLauncher: {
      ...config.minecraftLauncher,
      memoryMb: 8192
    }
  },
  latest,
  installed: null
});
const ramProfiles = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
const ramProfile = ramProfiles.profiles['a-hard-time-dregora'];
if (!ramProfile.javaArgs.includes('-Xmx8192m') || !ramProfile.javaArgs.includes('-Daht.launcher.proofFile=')) {
  throw new Error(`Expected updated RAM and launcher proof args, got ${ramProfile.javaArgs}`);
}
if (ramProfile.lastUsed !== selectedStableLastUsed) {
  throw new Error(`Non-Play profile refresh changed lastUsed from ${selectedStableLastUsed} to ${ramProfile.lastUsed}.`);
}
const developerProofProfileId = 'a-hard-time-developer-proof-path';
await ensureMinecraftLauncherProfile({
  config: {
    ...config,
    launcherProof: { enabled: true, channel: 'developer' },
    minecraftLauncher: {
      ...config.minecraftLauncher,
      profileId: developerProofProfileId,
      profileName: 'A Hard Time Developer Proof Path'
    }
  },
  latest,
  installed: null
});
const developerProofProfiles = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
const developerProofProfile = developerProofProfiles.profiles[developerProofProfileId];
if (!developerProofProfile?.javaArgs?.includes('launcher-proof.developer.json')) {
  throw new Error(`Developer Minecraft profile did not use the isolated developer proof file: ${JSON.stringify(developerProofProfile)}`);
}
const ptbInstanceDir = path.join(root, 'A Hard Time PTB');
const ptbConfig = {
  ...config,
  instanceDir: ptbInstanceDir,
  minecraftLauncher: {
    ...config.minecraftLauncher,
    profileId: 'a-hard-time-ptb',
    profileName: 'A Hard Time PTB'
  }
};
await ensureMinecraftLauncherProfile({ config: ptbConfig, latest, installed: null, selectForPlay: true });
selectedProfiles = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
selectedKeys = Object.keys(selectedProfiles.profiles);
const selectedPtbLastUsed = selectedProfiles.profiles['a-hard-time-ptb']?.lastUsed;
if (selectedKeys.at(-1) !== 'a-hard-time-ptb' || Date.parse(selectedPtbLastUsed) <= Date.parse(selectedStableLastUsed)) {
  throw new Error(`PTB Play did not switch selection intent from stable: ${JSON.stringify(selectedProfiles)}`);
}
await ensureMinecraftLauncherProfile({ config, latest, installed: null, selectForPlay: true });
selectedProfiles = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
selectedKeys = Object.keys(selectedProfiles.profiles);
if (
  selectedKeys.at(-1) !== 'a-hard-time-dregora'
  || Date.parse(selectedProfiles.profiles['a-hard-time-dregora']?.lastUsed) <= Date.parse(selectedPtbLastUsed)
) {
  throw new Error(`Stable Play did not switch selection intent back from PTB: ${JSON.stringify(selectedProfiles)}`);
}

const duplicateMigrationRoot = path.join(root, 'duplicate-migration-root');
const duplicateInstanceDir = path.join(root, 'duplicate-current-instance');
const duplicateLegacyJava = path.join(root, 'duplicate-legacy-java', 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java');
await fs.mkdir(duplicateMigrationRoot, { recursive: true });
await fs.writeFile(path.join(duplicateMigrationRoot, 'launcher_profiles.json'), `${JSON.stringify({
  profiles: {
    unrelated: {
      name: 'Unrelated',
      gameDir: path.join(root, 'unrelated'),
      lastUsed: new Date(Date.now() - 120_000).toISOString()
    },
    'a-hard-time-dregora': {
      name: 'A Hard Time',
      gameDir: duplicateInstanceDir,
      lastVersionId: versionId,
      lastUsed: '2026-01-02T00:00:00.000Z'
    },
    'a-hard-time': {
      name: 'A Hard Time Dregora',
      gameDir: path.join(root, 'duplicate-old-instance'),
      javaDir: duplicateLegacyJava,
      lastUsed: '2026-01-01T00:00:00.000Z'
    }
  },
  selectedProfile: 'unrelated',
  version: 2
}, null, 2)}\n`, 'utf8');
const duplicateConfig = {
  ...config,
  instanceDir: duplicateInstanceDir,
  minecraftLauncher: {
    ...config.minecraftLauncher,
    rootDir: duplicateMigrationRoot
  }
};
await ensureMinecraftLauncherProfile({ config: duplicateConfig, latest, installed: null });
let duplicateProfiles = JSON.parse(await fs.readFile(path.join(duplicateMigrationRoot, 'launcher_profiles.json'), 'utf8'));
if (
  duplicateProfiles.profiles['a-hard-time']
  || path.resolve(duplicateProfiles.profiles['a-hard-time-dregora']?.javaDir || '') !== path.resolve(duplicateLegacyJava)
  || duplicateProfiles.selectedProfile !== 'unrelated'
) {
  throw new Error(`Duplicate legacy migration lost Java or unrelated non-Play selection state: ${JSON.stringify(duplicateProfiles)}`);
}
await ensureMinecraftLauncherProfile({ config: duplicateConfig, latest, installed: null, selectForPlay: true });
duplicateProfiles = JSON.parse(await fs.readFile(path.join(duplicateMigrationRoot, 'launcher_profiles.json'), 'utf8'));
if (
  duplicateProfiles.selectedProfile !== 'a-hard-time-dregora'
  || Object.keys(duplicateProfiles.profiles).at(-1) !== 'a-hard-time-dregora'
  || path.resolve(duplicateProfiles.profiles['a-hard-time-dregora']?.javaDir || '') !== path.resolve(duplicateLegacyJava)
) {
  throw new Error(`Legacy launcher selection or Java migration was not prepared correctly: ${JSON.stringify(duplicateProfiles)}`);
}

const futureTimestampRoot = path.join(root, 'future-timestamp-root');
await fs.mkdir(futureTimestampRoot, { recursive: true });
await fs.writeFile(path.join(futureTimestampRoot, 'launcher_profiles.json'), `${JSON.stringify({
  profiles: {
    'future-profile': {
      name: 'Future Profile',
      gameDir: path.join(root, 'future-profile'),
      lastUsed: '9999-12-31T23:59:59.999Z'
    },
    'invalid-maximum-profile': {
      name: 'Invalid Maximum Profile',
      gameDir: path.join(root, 'invalid-maximum-profile'),
      lastUsed: '+275760-09-13T00:00:00.000Z'
    }
  },
  version: 3
}, null, 2)}\n`, 'utf8');
let futureTimestampError = null;
try {
  await ensureMinecraftLauncherProfile({
    config: {
      ...config,
      minecraftLauncher: { ...config.minecraftLauncher, rootDir: futureTimestampRoot }
    },
    latest,
    installed: null,
    selectForPlay: true
  });
} catch (error) {
  futureTimestampError = error;
}
if (!/future last-used time/i.test(String(futureTimestampError?.message || ''))) {
  throw new Error(`Extreme future profile timestamp did not fail closed actionably: ${futureTimestampError?.message || 'no error'}`);
}
const expectedUrl = 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-installer.jar';
if (forgeInstallerUrl(latest.minecraft.version, latest.minecraft.modLoaders[0].id) !== expectedUrl) {
  throw new Error('Forge installer URL was not derived correctly.');
}
const forgePlan = buildForgeInstallPlan(created);
if (forgePlan.args.join(' ') !== `-jar ${forgePlan.installerPath} --installClient ${minecraftRoot}`) {
  throw new Error(`Unexpected Forge install args: ${forgePlan.args.join(' ')}`);
}
if (created.loaderInstallerUrl !== 'https://example.test/forge-installer.jar') {
  throw new Error(`Forge installer URL was not carried into profile state: ${created.loaderInstallerUrl}`);
}
const mirroredForgePlan = buildForgeInstallPlan(created, { installerUrl: created.loaderInstallerUrl });
if (mirroredForgePlan.installerUrl !== 'https://example.test/forge-installer.jar') {
  throw new Error(`Forge installer mirror URL was not honored: ${mirroredForgePlan.installerUrl}`);
}
const exactForgeInstall = await findInstalledForgeVersion(forgePlan);
if (!exactForgeInstall.installed || exactForgeInstall.versionId !== versionId) {
  throw new Error(`Expected exact Forge profile detection, got ${JSON.stringify(exactForgeInstall)}`);
}
let unsafeForgePlanError = null;
try {
  buildForgeInstallPlan({ ...created, loaderId: 'forge-../escape' });
} catch (error) {
  unsafeForgePlanError = error;
}
if (!unsafeForgePlanError || !/unsafe identifier/i.test(unsafeForgePlanError.message || '')) {
  throw new Error(`Unsafe Forge installer identifier was not rejected: ${unsafeForgePlanError?.message || 'no error'}`);
}
const invalidForgeRoot = path.join(root, 'invalid-forge-root');
await fs.mkdir(path.join(invalidForgeRoot, 'versions', versionId), { recursive: true });
await fs.writeFile(path.join(invalidForgeRoot, 'versions', versionId, `${versionId}.json`), '{}');
const invalidForgeInstall = await findInstalledForgeVersion({ ...forgePlan, rootDir: invalidForgeRoot }, { verifyLibraries: true });
if (invalidForgeInstall.installed || invalidForgeInstall.invalidVersions.length !== 1 || !/incomplete Forge/i.test(invalidForgeInstall.invalidVersions[0].reason || '')) {
  throw new Error(`Placeholder Forge metadata was accepted as installed: ${JSON.stringify(invalidForgeInstall)}`);
}
const unsafeForgeRoot = path.join(root, 'unsafe-forge-root');
const unsafeForgeFixture = await writeForgeInstallationFixture(unsafeForgeRoot, { versionId });
unsafeForgeFixture.metadata.libraries[0].downloads.artifact.path = '../outside-forge-library.jar';
await fs.writeFile(unsafeForgeFixture.versionJson, `${JSON.stringify(unsafeForgeFixture.metadata, null, 2)}\n`, 'utf8');
const unsafeForgeInstall = await findInstalledForgeVersion({ ...forgePlan, rootDir: unsafeForgeRoot }, { verifyLibraries: true });
if (unsafeForgeInstall.installed || !/incomplete Forge/i.test(unsafeForgeInstall.invalidVersions[0]?.reason || '')) {
  throw new Error(`Forge metadata path traversal was accepted: ${JSON.stringify(unsafeForgeInstall)}`);
}
const missingForgeLibraryRoot = path.join(root, 'missing-forge-library-root');
await writeForgeInstallationFixture(missingForgeLibraryRoot, { versionId, includeLibrary: false });
const missingForgeLibraryInstall = await findInstalledForgeVersion({ ...forgePlan, rootDir: missingForgeLibraryRoot }, { verifyLibraries: true });
if (missingForgeLibraryInstall.installed || missingForgeLibraryInstall.invalidVersions[0]?.missingLibraries?.length !== 1) {
  throw new Error(`Forge metadata with a missing library was accepted as installed: ${JSON.stringify(missingForgeLibraryInstall)}`);
}
const corruptForgeLibraryRoot = path.join(root, 'corrupt-forge-library-root');
const corruptForgeFixture = await writeForgeInstallationFixture(corruptForgeLibraryRoot, { versionId });
const corruptForgeArtifact = corruptForgeFixture.metadata.libraries[0].downloads.artifact;
await fs.writeFile(
  path.join(corruptForgeLibraryRoot, 'libraries', corruptForgeArtifact.path),
  Buffer.alloc(corruptForgeArtifact.size, 0x78)
);
const corruptForgeLibraryInstall = await findInstalledForgeVersion({ ...forgePlan, rootDir: corruptForgeLibraryRoot }, { verifyLibraries: true });
if (corruptForgeLibraryInstall.installed || !/SHA-1 mismatch/i.test(corruptForgeLibraryInstall.invalidVersions[0]?.missingLibraries?.[0]?.reason || '')) {
  throw new Error(`Forge metadata with a corrupt same-size library was accepted as installed: ${JSON.stringify(corruptForgeLibraryInstall)}`);
}
const nullableForgeRoot = path.join(root, 'nullable-forge-root');
const nullableForgeFixture = await writeForgeInstallationFixture(nullableForgeRoot, { versionId });
const nullableForgeMetadata = {
  ...nullableForgeFixture.metadata,
  arguments: null,
  libraries: nullableForgeFixture.metadata.libraries.map((library) => ({
    ...library,
    downloads: {
      ...library.downloads,
      artifact: { ...library.downloads.artifact, url: '' }
    },
    clientreq: null,
    serverreq: null,
    natives: null,
    rules: null,
    extract: null
  }))
};
await fs.writeFile(nullableForgeFixture.versionJson, `${JSON.stringify(nullableForgeMetadata, null, 2)}\n`, 'utf8');
const nullableForgeBeforeInspection = await fs.readFile(nullableForgeFixture.versionJson, 'utf8');
const readOnlyNullableForgeState = await inspectMinecraftLauncherProfile({
  config: {
    ...config,
    minecraftLauncher: {
      ...config.minecraftLauncher,
      rootDir: nullableForgeRoot,
      syncDefaultRoots: false
    }
  },
  latest,
  installed: null
});
const nullableForgeAfterInspection = await fs.readFile(nullableForgeFixture.versionJson, 'utf8');
if (readOnlyNullableForgeState.loaderInstalled || nullableForgeAfterInspection !== nullableForgeBeforeInspection) {
  throw new Error(`Read-only profile inspection mutated or accepted unrepaired Forge metadata: ${JSON.stringify(readOnlyNullableForgeState)}`);
}
const nullableForgeInstall = await findInstalledForgeVersion({ ...forgePlan, rootDir: nullableForgeRoot }, { verifyLibraries: true });
if (!nullableForgeInstall.installed || !nullableForgeInstall.repairedMetadata) {
  throw new Error(`Mojang-incompatible nullable Forge metadata was not sanitized in place: ${JSON.stringify(nullableForgeInstall)}`);
}
const sanitizedForgeMetadata = JSON.parse(await fs.readFile(nullableForgeFixture.versionJson, 'utf8'));
if (
  'arguments' in sanitizedForgeMetadata
  || sanitizedForgeMetadata.libraries.some((library) => (
    'clientreq' in library
    || 'serverreq' in library
    || 'natives' in library
    || 'rules' in library
    || 'extract' in library
  ))
  || sanitizedForgeMetadata.libraries.some((library) => library.downloads?.artifact?.url !== '')
) {
  throw new Error(`Nullable Forge metadata fields survived sanitization: ${JSON.stringify(sanitizedForgeMetadata)}`);
}
const nullableForgeBackups = (await fs.readdir(path.dirname(nullableForgeFixture.versionJson)))
  .filter((name) => name.includes(`${path.basename(nullableForgeFixture.versionJson)}.aht-invalid-`));
if (!nullableForgeBackups.length) {
  throw new Error('Sanitized Forge launcher metadata was not backed up before repair.');
}
const badRulesForgeRoot = path.join(root, 'bad-rules-forge-root');
const badRulesForgeFixture = await writeForgeInstallationFixture(badRulesForgeRoot, { versionId });
const badRulesForgeMetadata = {
  ...badRulesForgeFixture.metadata,
  libraries: badRulesForgeFixture.metadata.libraries.map((library) => ({
    ...library,
    rules: { action: 'allow' }
  }))
};
await fs.writeFile(badRulesForgeFixture.versionJson, `${JSON.stringify(badRulesForgeMetadata, null, 2)}\n`, 'utf8');
const badRulesForgeInstall = await findInstalledForgeVersion({ ...forgePlan, rootDir: badRulesForgeRoot }, { verifyLibraries: true });
if (badRulesForgeInstall.installed || !badRulesForgeInstall.invalidVersions.length) {
  throw new Error(`Non-null malformed Forge rules object was accepted: ${JSON.stringify(badRulesForgeInstall)}`);
}
const previousForgeTestInstall = process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS;
try {
  process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS = '1';
  await installForgeLoader({
    ...created,
    rootDir: badRulesForgeRoot,
    versionJson: badRulesForgeFixture.versionJson,
    loaderInstalled: false
  }, { verifyLibraries: true });
} finally {
  if (previousForgeTestInstall === undefined) delete process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS;
  else process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS = previousForgeTestInstall;
}
const reinstalledBadRulesForge = await findInstalledForgeVersion({ ...forgePlan, rootDir: badRulesForgeRoot }, { verifyLibraries: true });
if (!reinstalledBadRulesForge.installed) {
  throw new Error(`Malformed Forge rules metadata was rejected but not reinstalled: ${JSON.stringify(reinstalledBadRulesForge)}`);
}
const altForgeRoot = path.join(root, 'alt-forge-root');
const altForgeVersionId = '1.12.2-forge1.12.2-14.23.5.2860';
await writeForgeInstallationFixture(altForgeRoot, { versionId: altForgeVersionId });
const altForgeInstall = await findInstalledForgeVersion({ ...forgePlan, rootDir: altForgeRoot });
if (!altForgeInstall.installed || altForgeInstall.versionId !== altForgeVersionId) {
  throw new Error(`Expected alternate Forge profile detection, got ${JSON.stringify(altForgeInstall)}`);
}
const fakeRuntimeRoot = path.join(root, 'fake-minecraft-runtime');
const fakeLegacyJava = path.join(fakeRuntimeRoot, 'jre-legacy', 'windows-x64', 'jre-legacy', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const fakeModernJava = path.join(fakeRuntimeRoot, 'java-runtime-gamma', 'windows-x64', 'java-runtime-gamma', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
await fs.mkdir(path.dirname(fakeLegacyJava), { recursive: true });
await fs.mkdir(path.dirname(fakeModernJava), { recursive: true });
await fs.writeFile(fakeModernJava, 'modern');
await fs.writeFile(fakeLegacyJava, 'legacy');
await fs.writeFile(path.join(path.dirname(path.dirname(fakeModernJava)), 'release'), 'JAVA_VERSION="17.0.10"\n');
await fs.writeFile(path.join(path.dirname(path.dirname(fakeLegacyJava)), 'release'), 'JAVA_VERSION="1.8.0_999"\n');
const resolvedJava = await resolveJavaPath(created, { javaRoots: [fakeRuntimeRoot] });
if (resolvedJava !== fakeLegacyJava) {
  throw new Error(`Expected legacy Minecraft Java runtime, got ${resolvedJava}`);
}
const resolvedLegacyProfileJava = await resolveMinecraftProfileJavaPath(created, forgePlan, {
  javaRoots: [fakeRuntimeRoot],
  javaInstallRoots: [],
  includeDefaultJavaRoots: false,
  includeEnvironmentJava: false,
  includePathJava: false,
  javaDownloadUrl: path.join(root, 'must-not-download-java.zip')
});
if (resolvedLegacyProfileJava !== fakeLegacyJava) {
  throw new Error(`Expected a valid Mojang Java 8 runtime to be reused without an Adoptium download, got ${resolvedLegacyProfileJava}`);
}
const fakeBundledLegacyJava = path.join(minecraftRoot, 'runtime', 'jre-legacy', 'windows-x64', 'jre-legacy', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const fakeInstalledJavaRoot = path.join(root, 'Program Files', 'Eclipse Adoptium');
const fakeInstalledJava = path.join(fakeInstalledJavaRoot, 'jdk-8.0.999.1-hotspot', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const fakeInstalledJavaw = process.platform === 'win32'
  ? path.join(path.dirname(fakeInstalledJava), 'javaw.exe')
  : fakeInstalledJava;
await fs.mkdir(path.dirname(fakeBundledLegacyJava), { recursive: true });
await fs.mkdir(path.dirname(fakeInstalledJava), { recursive: true });
await fs.writeFile(fakeBundledLegacyJava, 'bundled-legacy');
await fs.writeFile(fakeInstalledJava, 'temurin-8');
await fs.writeFile(path.join(path.dirname(path.dirname(fakeBundledLegacyJava)), 'release'), 'JAVA_VERSION="1.8.0_998"\n');
await fs.writeFile(path.join(path.dirname(path.dirname(fakeInstalledJava)), 'release'), 'JAVA_VERSION="1.8.0_999"\n');
if (process.platform === 'win32') {
  await fs.writeFile(fakeInstalledJavaw, 'temurin-8-windowless');
}
const resolvedInstalledJava = await resolveJavaPath(created, { javaInstallRoots: [fakeInstalledJavaRoot] });
if (resolvedInstalledJava !== fakeInstalledJava) {
  throw new Error(`Expected installed Temurin Java 8 to beat bundled legacy Java, got ${resolvedInstalledJava}`);
}
const detectedInstalledJava = await detectJava8Runtime(
  { ...created, rootDir: minecraftRoot },
  {
    javaPath: fakeBundledLegacyJava,
    javaRoots: [fakeRuntimeRoot],
    javaInstallRoots: [fakeInstalledJavaRoot],
    includeDefaultJavaRoots: false,
    includeEnvironmentJava: false,
    includePathJava: false,
    refresh: true
  }
);
if (!detectedInstalledJava.usable || detectedInstalledJava.javaPath !== fakeInstalledJava) {
  throw new Error(`Installed Temurin Java 8 did not beat configured Mojang jre-legacy: ${JSON.stringify(detectedInstalledJava)}`);
}
const profileJava = await minecraftJavaExecutable(resolvedInstalledJava);
if (profileJava !== fakeInstalledJavaw) {
  throw new Error(`Expected the Minecraft profile to use the windowless Java 8 executable, got ${profileJava}`);
}
const resolvedProfileJavaForInstaller = await resolveJavaPath(created, { javaPath: profileJava });
if (resolvedProfileJavaForInstaller !== fakeInstalledJava) {
  throw new Error(`Expected Forge installation to convert javaw.exe back to java.exe, got ${resolvedProfileJavaForInstaller}`);
}
await ensureMinecraftLauncherProfile({
  config: {
    ...config,
    minecraftLauncher: {
      ...config.minecraftLauncher,
      javaPath: profileJava
    }
  },
  latest,
  installed: null,
  selectForPlay: true
});
const javaPinnedProfiles = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
if (javaPinnedProfiles.profiles['a-hard-time-dregora']?.javaDir !== path.resolve(profileJava)) {
  throw new Error(`Minecraft Launcher profile did not pin Java 8: ${JSON.stringify(javaPinnedProfiles.profiles['a-hard-time-dregora'])}`);
}
const javaPtbConfig = {
  ...ptbConfig,
  minecraftLauncher: {
    ...ptbConfig.minecraftLauncher,
    javaPath: profileJava
  }
};
await ensureMinecraftLauncherProfile({ config: javaPtbConfig, latest, installed: null, selectForPlay: true });
await ensureMinecraftLauncherProfile({
  config: {
    ...config,
    minecraftLauncher: { ...config.minecraftLauncher, javaPath: profileJava }
  },
  latest,
  installed: null,
  selectForPlay: true
});
const javaReversalProfiles = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
if (
  Object.keys(javaReversalProfiles.profiles).at(-1) !== 'a-hard-time-dregora'
  || path.resolve(javaReversalProfiles.profiles['a-hard-time-dregora']?.javaDir || '') !== path.resolve(profileJava)
  || path.resolve(javaReversalProfiles.profiles['a-hard-time-ptb']?.javaDir || '') !== path.resolve(profileJava)
) {
  throw new Error(`Java 8 did not survive stable to PTB to stable Play selection: ${JSON.stringify(javaReversalProfiles)}`);
}
const managedJavaRoot = path.join(root, 'managed-java-clean-root');
const managedJavaArchivePath = path.join(root, 'managed-temurin-8.zip');
const managedJavaArchive = new AdmZip();
const managedJavaExeName = process.platform === 'win32' ? 'java.exe' : 'java';
managedJavaArchive.addFile(`temurin-8-clean/bin/${managedJavaExeName}`, Buffer.from('managed Java 8 executable\n'));
if (process.platform === 'win32') {
  managedJavaArchive.addFile('temurin-8-clean/bin/javaw.exe', Buffer.from('managed windowless Java 8 executable\n'));
}
managedJavaArchive.addFile('temurin-8-clean/release', Buffer.from('JAVA_VERSION="1.8.0_999"\n'));
managedJavaArchive.writeZip(managedJavaArchivePath);
const managedJavaArchiveBytes = await fs.readFile(managedJavaArchivePath);
const managedJavaArchiveSha256 = createHash('sha256').update(managedJavaArchiveBytes).digest('hex');
const managedProfileJava = await resolveMinecraftProfileJavaPath(
  { ...created, rootDir: managedJavaRoot },
  { ...forgePlan, rootDir: managedJavaRoot },
  {
    javaPath: 'java',
    javaRoots: [],
    javaInstallRoots: [],
    includeDefaultJavaRoots: false,
    includeEnvironmentJava: false,
    includePathJava: false,
    javaDownloadUrl: managedJavaArchivePath,
    javaDownloadSha256: managedJavaArchiveSha256,
    javaDownloadSize: managedJavaArchiveBytes.length,
    javaCacheDir: path.join(managedJavaRoot, '.aht-launcher', 'java')
  }
);
if (!managedProfileJava.includes('temurin-8-clean') || path.basename(managedProfileJava).toLowerCase() !== managedJavaExeName) {
  throw new Error(`Clean-player managed Java 8 provisioning returned the wrong runtime: ${managedProfileJava}`);
}
const managedMinecraftJava = await minecraftJavaExecutable(managedProfileJava);
if (process.platform === 'win32' && path.basename(managedMinecraftJava).toLowerCase() !== 'javaw.exe') {
  throw new Error(`Managed Minecraft profile Java did not use javaw.exe: ${managedMinecraftJava}`);
}
const rejectedManagedJavaRoot = path.join(root, 'managed-java-rejected-root');
let managedJavaChecksumError = null;
try {
  await resolveMinecraftProfileJavaPath(
    { ...created, rootDir: rejectedManagedJavaRoot },
    { ...forgePlan, rootDir: rejectedManagedJavaRoot },
    {
      javaPath: 'java',
      javaRoots: [],
      javaInstallRoots: [],
      includeDefaultJavaRoots: false,
      includeEnvironmentJava: false,
      includePathJava: false,
      javaDownloadUrl: managedJavaArchivePath,
      javaDownloadSha256: '0'.repeat(64),
      javaDownloadSize: managedJavaArchiveBytes.length,
      javaCacheDir: path.join(rejectedManagedJavaRoot, '.aht-launcher', 'java')
    }
  );
} catch (error) {
  managedJavaChecksumError = error;
}
if (!managedJavaChecksumError || !/SHA-256 mismatch/i.test(managedJavaChecksumError.message || '')) {
  throw new Error(`Managed Java archive checksum mismatch was not rejected: ${managedJavaChecksumError?.message || 'no error'}`);
}
const fakeJava17Home = path.join(root, 'Program Files', 'Java', 'jdk-17');
const fakeJava17 = path.join(fakeJava17Home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
await fs.mkdir(path.dirname(fakeJava17), { recursive: true });
await fs.writeFile(fakeJava17, 'java-17');
await fs.writeFile(path.join(fakeJava17Home, 'release'), 'JAVA_VERSION="17.0.10"\n');
let macJava17Error = null;
const macNoJava8Root = path.join(root, 'mac-no-java8-root');
try {
  await resolveMinecraftProfileJavaPath(
    { ...created, rootDir: macNoJava8Root },
    { ...forgePlan, rootDir: macNoJava8Root },
    {
      javaPath: fakeJava17,
      javaRoots: [],
      javaInstallRoots: [],
      includeDefaultJavaRoots: false,
      includeEnvironmentJava: false,
      includePathJava: false,
      platform: 'darwin',
      arch: 'arm64'
    }
  );
} catch (error) {
  macJava17Error = error;
}
if (!macJava17Error || !/Java 8/i.test(macJava17Error.message || '')) {
  throw new Error(`macOS Java 17 was not rejected for Forge 1.12.2: ${macJava17Error?.message || 'no error'}`);
}
const previousJavaHome = process.env.JAVA_HOME;
process.env.JAVA_HOME = fakeJava17Home;
try {
  const resolvedWithWrongJavaHome = await resolveJavaPath(created, { javaInstallRoots: [fakeInstalledJavaRoot] });
  if (resolvedWithWrongJavaHome !== fakeInstalledJava) {
    throw new Error(`Expected installed Temurin Java 8 to beat JAVA_HOME Java 17, got ${resolvedWithWrongJavaHome}`);
  }
} finally {
  if (previousJavaHome === undefined) {
    delete process.env.JAVA_HOME;
  } else {
    process.env.JAVA_HOME = previousJavaHome;
  }
}
const fakeJava8EnvHome = path.join(root, 'Program Files', 'Eclipse Adoptium', 'jdk-8.0.888.1-hotspot-env');
const fakeJava8Env = path.join(fakeJava8EnvHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
await fs.mkdir(path.dirname(fakeJava8Env), { recursive: true });
await fs.writeFile(fakeJava8Env, 'temurin-8-env');
await fs.writeFile(path.join(fakeJava8EnvHome, 'release'), 'JAVA_VERSION="1.8.0_888"\n');
const previousJdk8Home = process.env.JDK8_HOME;
const previousJavaHomeForJdk8 = process.env.JAVA_HOME;
process.env.JAVA_HOME = fakeJava17Home;
process.env.JDK8_HOME = fakeJava8EnvHome;
try {
  const resolvedWithJdk8Home = await resolveJavaPath(created, { javaInstallRoots: [] });
  if (resolvedWithJdk8Home !== fakeJava8Env) {
    throw new Error(`Expected JDK8_HOME Temurin Java 8 to beat JAVA_HOME Java 17, got ${resolvedWithJdk8Home}`);
  }
} finally {
  if (previousJdk8Home === undefined) {
    delete process.env.JDK8_HOME;
  } else {
    process.env.JDK8_HOME = previousJdk8Home;
  }
  if (previousJavaHomeForJdk8 === undefined) {
    delete process.env.JAVA_HOME;
  } else {
    process.env.JAVA_HOME = previousJavaHomeForJdk8;
  }
}
if (process.platform === 'win32') {
  const fakeLocalAppData = path.join(root, 'LocalAppData');
  const fakeLocalTemurinHome = path.join(fakeLocalAppData, 'Programs', 'Eclipse Adoptium', 'jdk-8.0.889.1-hotspot');
  const fakeLocalTemurin = path.join(fakeLocalTemurinHome, 'bin', 'java.exe');
  await fs.mkdir(path.dirname(fakeLocalTemurin), { recursive: true });
  await fs.writeFile(fakeLocalTemurin, 'temurin-8-localappdata');
  await fs.writeFile(path.join(fakeLocalTemurinHome, 'release'), 'JAVA_VERSION="1.8.0_889"\n');
  const envNames = ['LOCALAPPDATA', 'ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'USERPROFILE', 'AHT_JAVA_HOME', 'JAVA8_HOME', 'JDK8_HOME', 'JRE8_HOME', 'JDK_HOME', 'JAVA_HOME', 'JRE_HOME'];
  const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  try {
    process.env.LOCALAPPDATA = fakeLocalAppData;
    process.env.ProgramW6432 = path.join(root, 'empty-program-w6432');
    process.env.ProgramFiles = path.join(root, 'empty-program-files');
    process.env['ProgramFiles(x86)'] = path.join(root, 'empty-program-files-x86');
    process.env.ProgramData = path.join(root, 'empty-program-data');
    process.env.USERPROFILE = path.join(root, 'empty-user-profile');
    for (const name of ['AHT_JAVA_HOME', 'JAVA8_HOME', 'JDK8_HOME', 'JRE8_HOME', 'JDK_HOME', 'JAVA_HOME', 'JRE_HOME']) {
      delete process.env[name];
    }
    const resolvedLocalTemurin = await resolveJavaPath(created, { javaRoots: [] });
    if (resolvedLocalTemurin !== fakeLocalTemurin) {
      throw new Error(`Expected user-local Temurin Java 8 to be detected, got ${resolvedLocalTemurin}`);
    }
  } finally {
    for (const [name, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
const fakeGenericJava8Home = path.join(root, 'custom-runtime-with-release-file');
const fakeGenericJava8 = path.join(fakeGenericJava8Home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
await fs.mkdir(path.dirname(fakeGenericJava8), { recursive: true });
await fs.writeFile(fakeGenericJava8, 'generic-java-8');
await fs.writeFile(path.join(fakeGenericJava8Home, 'release'), 'JAVA_VERSION="1.8.0_452"\n');
const resolvedReleaseFileJava8 = await resolveJavaPath(created, { javaRoots: [fakeGenericJava8Home] });
if (resolvedReleaseFileJava8 !== fakeGenericJava8) {
  throw new Error(`Expected release-file Java 8 detection, got ${resolvedReleaseFileJava8}`);
}
const detectedExplicitJava = await detectJava8Runtime(
  { ...created, rootDir: minecraftRoot },
  {
    javaPath: fakeGenericJava8,
    javaRoots: [],
    javaInstallRoots: [fakeInstalledJavaRoot],
    includeDefaultJavaRoots: false,
    includeEnvironmentJava: false,
    includePathJava: false,
    refresh: true
  }
);
if (!detectedExplicitJava.usable || detectedExplicitJava.javaPath !== fakeGenericJava8) {
  throw new Error(`Explicit non-legacy Java 8 was not preserved: ${JSON.stringify(detectedExplicitJava)}`);
}
const explicitJava = path.join(root, 'custom-java', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
await fs.mkdir(path.dirname(explicitJava), { recursive: true });
await fs.writeFile(explicitJava, 'custom');
const resolvedExplicitJava = await resolveJavaPath(created, { javaPath: explicitJava, javaRoots: [fakeRuntimeRoot] });
if (resolvedExplicitJava !== explicitJava) {
  throw new Error(`Expected explicit Java path, got ${resolvedExplicitJava}`);
}
const javaHelp = javaSetupHelpMessage('win32');
if (!javaHelp.includes('Eclipse Temurin JDK 8') || !javaHelp.includes('restart AHT Launcher')) {
  throw new Error(`Java setup help is not specific enough: ${javaHelp}`);
}
const missingJavaMessage = friendlyForgeJavaErrorMessage(Object.assign(new Error('spawn java ENOENT'), { code: 'ENOENT' }), 'java', 'win32');
if (!missingJavaMessage.includes('Java 8 runtime was not found') || !missingJavaMessage.includes('Eclipse Temurin JDK 8')) {
  throw new Error(`Missing Java message is not actionable: ${missingJavaMessage}`);
}
const certificateMessage = friendlyForgeJavaErrorMessage(new Error('sun.security.provider.certpath.SunCertPathBuilderException: unable to find valid certification path to requested target'), fakeLegacyJava, 'win32');
if (!certificateMessage.includes('could not validate Mojang/Forge HTTPS certificates') || !certificateMessage.includes('Eclipse Temurin JDK 8') || certificateMessage.includes('SunCertPathBuilderException')) {
  throw new Error(`Certificate message is not clean: ${certificateMessage}`);
}
const minecraftServiceMessage = friendlyForgeJavaErrorMessage(new Error('Forge installer exited with code 1: Error: could not open C:\\Users\\Player\\AppData\\Local\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\runtime\\java-runtime-gamma\\windows-x64\\java-runtime-gamma\\bin\\javaw.cfg'), fakeModernJava, 'win32');
if (!minecraftServiceMessage.includes('Minecraft services') || !minecraftServiceMessage.includes('Mojang/Microsoft') || minecraftServiceMessage.includes('javaw.cfg')) {
  throw new Error(`Minecraft outage message is not clean: ${minecraftServiceMessage}`);
}

const macAuthRoot = path.join(root, 'mac-launcher-auth');
await fs.mkdir(macAuthRoot, { recursive: true });
await fs.writeFile(path.join(macAuthRoot, 'launcher_accounts.json'), JSON.stringify({
  activeAccountLocalId: 'active',
  accounts: {
    backup: { type: 'Xbox', minecraftProfile: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'BackupMac' } },
    active: { type: 'Xbox', minecraftProfile: { id: '1234567890abcdef1234567890abcdef', name: 'MacUser' } }
  }
}));
const macAuth = await inspectMinecraftLauncherAuth(macAuthRoot);
if (
  !macAuth.signedIn
  || macAuth.preferredUsername !== 'MacUser'
  || macAuth.preferredMinecraftUuid !== '12345678-90ab-cdef-1234-567890abcdef'
  || macAuth.profiles[0]?.username !== 'MacUser'
  || macAuth.accountCount !== 2
) {
  throw new Error(`Expected active macOS launcher account, got ${JSON.stringify(macAuth)}`);
}

const macLegacyAuthRoot = path.join(root, 'mac-launcher-legacy-auth');
await fs.mkdir(macLegacyAuthRoot, { recursive: true });
await fs.writeFile(path.join(macLegacyAuthRoot, 'launcher_profiles.json'), JSON.stringify({
  selectedUser: { account: 'legacy-active', profile: 'fedcba0987654321fedcba0987654321' },
  authenticationDatabase: {
    other: { displayName: 'OtherMac' },
    'legacy-active': {
      displayName: 'LegacyMac',
      profiles: {
        fedcba0987654321fedcba0987654321: { displayName: 'LegacyMac' }
      }
    }
  }
}));
const legacyAuth = await inspectMinecraftLauncherAuth('', { extraRoots: [macLegacyAuthRoot] });
if (
  !legacyAuth.signedIn
  || legacyAuth.preferredUsername !== 'LegacyMac'
  || legacyAuth.preferredMinecraftUuid !== 'fedcba09-8765-4321-fedc-ba0987654321'
  || legacyAuth.accountCount !== 2
) {
  throw new Error(`Expected legacy macOS launcher account, got ${JSON.stringify(legacyAuth)}`);
}

const macMsaOnlyRoot = path.join(root, 'mac-launcher-msa-only');
await fs.mkdir(macMsaOnlyRoot, { recursive: true });
await fs.writeFile(path.join(macMsaOnlyRoot, 'launcher_msa_credentials.bin'), Buffer.from([1, 2, 3]));
const msaOnlyAuth = await inspectMinecraftLauncherAuth(macMsaOnlyRoot);
if (!msaOnlyAuth.signedIn || msaOnlyAuth.accountCount !== 0) {
  throw new Error(`Expected MSA credential file to count as signed in, got ${JSON.stringify(msaOnlyAuth)}`);
}
const curseForgeRoot = path.join(root, 'curseforge', 'minecraft', 'Install');
const curseForgeVersionId = 'forge-14.23.5.2860';
await writeForgeInstallationFixture(curseForgeRoot, { versionId: curseForgeVersionId });
const launcherUiStatePath = path.join(curseForgeRoot, 'launcher_ui_state.json');
const launcherUiPreamble = '#$\nMinecraft Launcher internal state\n$#\n';
await fs.writeFile(launcherUiStatePath, `${launcherUiPreamble}${JSON.stringify({
  data: { UiSettings: JSON.stringify({ lastVisitedPage: 'realms', animate: { transitions: false } }) },
  formatVersion: 1
}, null, 2)}\n`);
const homePageResult = await setMinecraftLauncherHomePage(curseForgeRoot);
const updatedLauncherUiState = await fs.readFile(launcherUiStatePath, 'utf8');
const updatedLauncherUiJson = JSON.parse(updatedLauncherUiState.slice(updatedLauncherUiState.indexOf('{')));
const updatedLauncherUiSettings = JSON.parse(updatedLauncherUiJson.data.UiSettings);
if (!homePageResult.ok || !homePageResult.changed || updatedLauncherUiSettings.lastVisitedPage !== 'home' || !updatedLauncherUiState.startsWith(launcherUiPreamble)) {
  throw new Error(`Minecraft Launcher home page state was not prepared safely: ${JSON.stringify(homePageResult)}`);
}
await fs.writeFile(path.join(curseForgeRoot, 'launcher_accounts.json'), JSON.stringify({
  activeAccountLocalId: 'active',
  accounts: {
    backup: { type: 'Xbox', minecraftProfile: { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'BackupUser' } },
    active: { type: 'Xbox', minecraftProfile: { id: '0123456789abcdef0123456789abcdef', name: 'ActiveUser' } }
  }
}));
const curseForgeConfig = {
  ...config,
  minecraftLauncher: {
    ...config.minecraftLauncher,
    rootDir: curseForgeRoot
  }
};
const curseForgeProfile = await ensureMinecraftLauncherProfile({ config: curseForgeConfig, latest, installed: null });
if (curseForgeProfile.versionId !== curseForgeVersionId || !curseForgeProfile.loaderInstalled) {
  throw new Error(`Expected CurseForge-style ${curseForgeVersionId}, got ${curseForgeProfile.versionId}.`);
}
if (!curseForgeProfile.accountReuseAvailable || curseForgeProfile.accountCount !== 2) {
  throw new Error('Expected existing Minecraft Launcher account state to be detected.');
}
if (curseForgeProfile.preferredMinecraftUsername !== 'ActiveUser') {
  throw new Error(`Expected active launcher account username, got ${curseForgeProfile.preferredMinecraftUsername}`);
}
if (curseForgeProfile.preferredMinecraftUuid !== '01234567-89ab-cdef-0123-456789abcdef') {
  throw new Error(`Expected active launcher account UUID, got ${curseForgeProfile.preferredMinecraftUuid}`);
}
const curseForgeProfiles = JSON.parse(await fs.readFile(path.join(curseForgeRoot, 'launcher_profiles.json'), 'utf8'));
const curseForgeProfileJson = curseForgeProfiles.profiles['a-hard-time-dregora'];
if (
  !curseForgeProfileJson.javaArgs.includes('-Xmx6144m')
  || !curseForgeProfileJson.javaArgs.includes('-DlibraryDirectory=')
  || !curseForgeProfileJson.javaArgs.includes('-Dfml.ignorePatchDiscrepancies=true')
) {
  throw new Error(`Expected CurseForge Java properties, got ${curseForgeProfileJson.javaArgs}`);
}

const syncedMinecraftRoot = path.join(root, 'synced-minecraft-root');
await writeForgeInstallationFixture(syncedMinecraftRoot, { versionId });
const syncedConfig = {
  ...curseForgeConfig,
  minecraftLauncher: {
    ...curseForgeConfig.minecraftLauncher,
    syncRoots: [syncedMinecraftRoot]
  }
};
const syncedState = await ensureMinecraftLauncherProfile({ config: syncedConfig, latest, installed: null });
if (syncedState.syncedProfileCount !== 2) {
  throw new Error(`Expected profile to sync to CurseForge and normal roots, got ${syncedState.syncedProfileCount}`);
}
const syncedProfiles = JSON.parse(await fs.readFile(path.join(syncedMinecraftRoot, 'launcher_profiles.json'), 'utf8'));
const syncedProfileJson = syncedProfiles.profiles['a-hard-time-dregora'];
if (!syncedProfileJson || syncedProfileJson.gameDir !== path.resolve(instanceDir)) {
  throw new Error(`Synced Minecraft profile did not point at the AHT instance: ${JSON.stringify(syncedProfileJson)}`);
}
if (
  syncedProfileJson.lastVersionId !== versionId
  || !syncedProfileJson.javaArgs.includes('-Dminecraft.applet.TargetDirectory=')
  || !syncedProfileJson.javaArgs.includes('-DlibraryDirectory=')
) {
  throw new Error(`Synced profile did not get CurseForge-style launch args: ${syncedProfileJson.javaArgs}`);
}
const missingLoaderRoot = path.join(root, 'missing-loader-root');
const missingLoaderConfig = {
  ...curseForgeConfig,
  minecraftLauncher: {
    ...curseForgeConfig.minecraftLauncher,
    syncRoots: [missingLoaderRoot]
  }
};
const missingLoaderState = await ensureMinecraftLauncherProfile({ config: missingLoaderConfig, latest, installed: null });
const missingLoaderProfile = missingLoaderState.syncedProfiles.find((item) => item.rootDir === missingLoaderRoot);
if (!missingLoaderProfile || missingLoaderProfile.loaderInstalled) {
  throw new Error(`Expected synced root to report missing Forge loader: ${JSON.stringify(missingLoaderProfile)}`);
}
const inspectedMissingLoader = await inspectMinecraftLauncherProfile({ config: missingLoaderConfig, latest, installed: null });
const inspectedMissingProfile = inspectedMissingLoader.syncedProfiles.find((item) => item.rootDir === missingLoaderRoot);
if (!inspectedMissingProfile || inspectedMissingProfile.loaderInstalled || inspectedMissingLoader.syncedProfileCount !== 2) {
  throw new Error(`Expected inspect to include missing synced loader state: ${JSON.stringify(inspectedMissingLoader)}`);
}

const corruptProfileRoot = path.join(root, 'corrupt-profile-root');
await writeForgeInstallationFixture(corruptProfileRoot, { versionId });
await fs.writeFile(path.join(corruptProfileRoot, 'launcher_profiles.json'), '', 'utf8');
const corruptProfileConfig = {
  ...config,
  minecraftLauncher: {
    ...config.minecraftLauncher,
    rootDir: corruptProfileRoot,
    syncDefaultRoots: false
  }
};
await ensureMinecraftLauncherProfile({ config: corruptProfileConfig, latest, installed: null });
const repairedProfiles = JSON.parse(await fs.readFile(path.join(corruptProfileRoot, 'launcher_profiles.json'), 'utf8'));
if (!repairedProfiles.profiles?.['a-hard-time-dregora']) {
  throw new Error(`Corrupt launcher_profiles.json was not repaired: ${JSON.stringify(repairedProfiles)}`);
}
const profileBackups = (await fs.readdir(corruptProfileRoot)).filter((name) => name.includes('launcher_profiles.json.aht-corrupt-'));
if (!profileBackups.length) {
  throw new Error('Corrupt launcher_profiles.json was not backed up before repair.');
}

const assetRoot = path.join(root, 'asset-root');
const assetSourceRoot = path.join(root, 'asset-sources');
const fakeManifestUrl = 'https://example.invalid/version_manifest_v2.json';
const fakeVersionUrl = 'https://example.invalid/1.12.2.json';
const fakeAssetUrl = path.join(assetSourceRoot, '1.12.json');
const clientBytes = Buffer.from('complete Minecraft 1.12.2 client fixture\n');
const libraryBytes = Buffer.from('complete Minecraft base library fixture\n');
const nativeBytes = Buffer.from('complete Minecraft native library fixture\n');
const assetIndexValue = { objects: { 'minecraft/lang/en_us.lang': { hash: 'a'.repeat(40), size: 1 } } };
const assetIndexBytes = Buffer.from(`${JSON.stringify(assetIndexValue, null, 2)}\n`);
const clientSource = path.join(assetSourceRoot, 'client.jar');
const librarySource = path.join(assetSourceRoot, 'base-library.jar');
const nativeSource = path.join(assetSourceRoot, 'native-library.jar');
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex');
const descriptor = (url, bytes, artifactPath = '') => ({
  ...(artifactPath ? { path: artifactPath } : {}),
  url,
  sha1: sha1(bytes),
  size: bytes.length
});
const nativePaths = {
  'natives-windows': 'example/native/1/native-1-natives-windows.jar',
  'natives-osx': 'example/native/1/native-1-natives-osx.jar',
  'natives-linux': 'example/native/1/native-1-natives-linux.jar'
};
const platformNativeClassifier = process.platform === 'win32'
  ? 'natives-windows'
  : (process.platform === 'darwin' ? 'natives-osx' : 'natives-linux');
await fs.mkdir(assetSourceRoot, { recursive: true });
await fs.writeFile(clientSource, clientBytes);
await fs.writeFile(librarySource, libraryBytes);
await fs.writeFile(nativeSource, nativeBytes);
await fs.writeFile(fakeAssetUrl, assetIndexBytes);
const completeBaseVersion = {
  id: '1.12.2',
  mainClass: 'net.minecraft.client.main.Main',
  minecraftArguments: '--username ${auth_player_name} --version ${version_name}',
  assetIndex: { id: '1.12', ...descriptor(fakeAssetUrl, assetIndexBytes) },
  downloads: { client: descriptor(clientSource, clientBytes) },
  libraries: [
    {
      name: 'example:base:1',
      downloads: {
        artifact: descriptor(librarySource, libraryBytes, 'example/base/1/base-1.jar')
      }
    },
    {
      name: 'example:native:1',
      natives: {
        windows: 'natives-windows',
        osx: 'natives-osx',
        linux: 'natives-linux'
      },
      downloads: {
        classifiers: Object.fromEntries(Object.entries(nativePaths).map(([classifier, artifactPath]) => [
          classifier,
          descriptor(nativeSource, nativeBytes, artifactPath)
        ]))
      }
    }
  ]
};
const minimalBaseVersion = { id: '1.12.2', assetIndex: { id: '1.12', url: fakeAssetUrl } };
const baseVersionDir = path.join(assetRoot, 'versions', '1.12.2');
await fs.mkdir(baseVersionDir, { recursive: true });
await fs.writeFile(
  path.join(baseVersionDir, '1.12.2.json'),
  `${JSON.stringify(minimalBaseVersion, null, 2)}\n`,
  'utf8'
);
const fakeFetches = [];
const fakeFetchJson = async (url) => {
  fakeFetches.push(String(url));
  if (url === fakeManifestUrl) {
    return { versions: [{ id: '1.12.2', url: fakeVersionUrl }] };
  }
  if (url === fakeVersionUrl) {
    return completeBaseVersion;
  }
  if (url === fakeAssetUrl) {
    return assetIndexValue;
  }
  throw new Error(`Unexpected fake fetch ${url}`);
};
const assetProfile = { rootDir: assetRoot, syncedProfiles: [{ rootDir: assetRoot }], minecraftVersion: '1.12.2' };
const firstAssetRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: assetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: assetProfile,
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson
});
if (!firstAssetRepair.ok || !firstAssetRepair.repaired) {
  throw new Error(`Expected incomplete Minecraft metadata to be repaired: ${JSON.stringify(firstAssetRepair)}`);
}
if (!fakeFetches.includes(fakeManifestUrl) || !fakeFetches.includes(fakeVersionUrl)) {
  throw new Error(`Minimal Minecraft metadata with no libraries was not replaced from the official metadata path: ${JSON.stringify(fakeFetches)}`);
}
const repairedBaseVersion = JSON.parse(await fs.readFile(path.join(baseVersionDir, '1.12.2.json'), 'utf8'));
if (!repairedBaseVersion.downloads?.client || repairedBaseVersion.libraries?.length !== 2) {
  throw new Error(`Minimal Minecraft metadata survived repair: ${JSON.stringify(repairedBaseVersion)}`);
}
const baseMetadataBackups = (await fs.readdir(baseVersionDir))
  .filter((name) => name.includes('1.12.2.json.aht-invalid-'));
if (!baseMetadataBackups.length) {
  throw new Error('Parseable but incomplete Minecraft base metadata was not backed up before replacement.');
}
const backedUpMinimalVersion = JSON.parse(await fs.readFile(path.join(baseVersionDir, baseMetadataBackups[0]), 'utf8'));
if (backedUpMinimalVersion.id !== '1.12.2' || 'libraries' in backedUpMinimalVersion) {
  throw new Error(`Minecraft base metadata backup did not preserve the rejected minimal JSON: ${JSON.stringify(backedUpMinimalVersion)}`);
}
const clientJarPath = path.join(baseVersionDir, '1.12.2.jar');
const baseLibraryPath = path.join(assetRoot, 'libraries', 'example', 'base', '1', 'base-1.jar');
const nativeLibraryPath = path.join(assetRoot, 'libraries', ...nativePaths[platformNativeClassifier].split('/'));
if (!(await fs.readFile(clientJarPath)).equals(clientBytes)) {
  throw new Error('Minecraft client JAR was not downloaded from its verified metadata descriptor.');
}
if (!(await fs.readFile(baseLibraryPath)).equals(libraryBytes)) {
  throw new Error('Required Minecraft base library was not downloaded from its verified metadata descriptor.');
}
if (!(await fs.readFile(nativeLibraryPath)).equals(nativeBytes)) {
  throw new Error('Required Minecraft native library was not downloaded from its verified metadata descriptor.');
}
if (firstAssetRepair.roots[0]?.baseLibraryCount !== 2 || firstAssetRepair.roots[0]?.downloadedLibraryCount !== 2) {
  throw new Error(`Minecraft base download counts were wrong: ${JSON.stringify(firstAssetRepair.roots[0])}`);
}
const assetIndexPath = path.join(assetRoot, 'assets', 'indexes', '1.12.json');
if (!JSON.parse(await fs.readFile(assetIndexPath, 'utf8')).objects?.['minecraft/lang/en_us.lang']) {
  throw new Error('Asset index was not written correctly.');
}
await fs.writeFile(assetIndexPath, Buffer.alloc(assetIndexBytes.length, 0x7a));
await fs.writeFile(clientJarPath, Buffer.alloc(clientBytes.length, 0x78));
await fs.writeFile(baseLibraryPath, Buffer.alloc(libraryBytes.length, 0x79));
const secondAssetRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: assetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: assetProfile,
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson
});
if (!secondAssetRepair.repaired) {
  throw new Error('Corrupt asset index or base files were not repaired.');
}
if (!(await fs.readFile(clientJarPath)).equals(clientBytes)) {
  throw new Error('Same-size corrupt Minecraft client JAR passed SHA-1 validation.');
}
if (!(await fs.readFile(baseLibraryPath)).equals(libraryBytes)) {
  throw new Error('Same-size corrupt Minecraft base library passed SHA-1 validation.');
}
if (!JSON.parse(await fs.readFile(assetIndexPath, 'utf8')).objects?.['minecraft/lang/en_us.lang']) {
  throw new Error('Same-size corrupt Minecraft asset index passed SHA-1 validation.');
}
if (secondAssetRepair.roots[0]?.downloadedLibraryCount !== 1) {
  throw new Error(`Expected exactly one corrupt base library repair: ${JSON.stringify(secondAssetRepair.roots[0])}`);
}
const assetBackupDir = path.join(assetRoot, 'assets', 'indexes');
const assetBackups = (await fs.readdir(assetBackupDir)).filter((name) => name.includes('1.12.json.aht-invalid-'));
if (!assetBackups.length) {
  throw new Error('Corrupt asset index was not backed up before repair.');
}
if (!(await fs.readFile(path.join(assetBackupDir, assetBackups[0]))).equals(Buffer.alloc(assetIndexBytes.length, 0x7a))) {
  throw new Error('Asset-index rollback backup did not preserve the exact corrupt bytes.');
}
const nullableBaseVersion = {
  ...completeBaseVersion,
  arguments: null,
  libraries: completeBaseVersion.libraries.map((library) => ({
    ...library,
    clientreq: null,
    serverreq: null,
    rules: null,
    natives: library.natives ?? null,
    extract: null
  }))
};
await fs.writeFile(path.join(baseVersionDir, '1.12.2.json'), `${JSON.stringify(nullableBaseVersion, null, 2)}\n`, 'utf8');
const fetchCountBeforeNullableBaseRepair = fakeFetches.length;
const nullableBaseRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: assetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: assetProfile,
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson
});
const repairedNullableBaseVersion = JSON.parse(await fs.readFile(path.join(baseVersionDir, '1.12.2.json'), 'utf8'));
if (
  !nullableBaseRepair.repaired
  || fakeFetches.length < fetchCountBeforeNullableBaseRepair + 2
  || 'arguments' in repairedNullableBaseVersion
  || repairedNullableBaseVersion.libraries.some((library) => (
    'clientreq' in library
    || 'serverreq' in library
    || library.rules === null
    || library.natives === null
    || library.extract === null
  ))
) {
  throw new Error(`Launcher-incompatible nullable base metadata was not replaced: ${JSON.stringify(nullableBaseRepair)}`);
}
const incompleteOfficialRoot = path.join(root, 'incomplete-official-root');
let incompleteOfficialError = null;
try {
  await ensureMinecraftLauncherAssets({
    config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: incompleteOfficialRoot, syncDefaultRoots: false } },
    latest,
    installed: null,
    profile: { rootDir: incompleteOfficialRoot, syncedProfiles: [{ rootDir: incompleteOfficialRoot }], minecraftVersion: '1.12.2' },
    manifestUrl: fakeManifestUrl,
    fetchJsonImpl: async (url) => {
      if (url === fakeManifestUrl) return { versions: [{ id: '1.12.2', url: fakeVersionUrl }] };
      if (url === fakeVersionUrl) return minimalBaseVersion;
      throw new Error(`Unexpected incomplete metadata fetch ${url}`);
    }
  });
} catch (error) {
  incompleteOfficialError = error;
}
if (!incompleteOfficialError || !/incomplete Minecraft 1\.12\.2 metadata/i.test(incompleteOfficialError.message || '')) {
  throw new Error(`Official metadata without client/libraries was not rejected: ${incompleteOfficialError?.message || 'no error'}`);
}
const unsafeAssetRoot = path.join(root, 'unsafe-asset-root');
let unsafeAssetError = null;
try {
  await ensureMinecraftLauncherAssets({
    config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: unsafeAssetRoot, syncDefaultRoots: false } },
    latest,
    installed: null,
    profile: { rootDir: unsafeAssetRoot, syncedProfiles: [{ rootDir: unsafeAssetRoot }], minecraftVersion: '1.12.2' },
    manifestUrl: fakeManifestUrl,
    fetchJsonImpl: async (url) => {
      if (url === fakeManifestUrl) return { versions: [{ id: '1.12.2', url: fakeVersionUrl }] };
      if (url === fakeVersionUrl) return { ...completeBaseVersion, assetIndex: { ...completeBaseVersion.assetIndex, id: '../escape' } };
      throw new Error(`Unexpected unsafe asset metadata fetch ${url}`);
    }
  });
} catch (error) {
  unsafeAssetError = error;
}
if (!unsafeAssetError || !/incomplete Minecraft 1\.12\.2 metadata/i.test(unsafeAssetError.message || '')) {
  throw new Error(`Unsafe asset-index identifier was not rejected: ${unsafeAssetError?.message || 'no error'}`);
}
const unsafeVersionRoot = path.join(root, 'unsafe-version-root');
let unsafeVersionError = null;
try {
  await ensureMinecraftLauncherAssets({
    config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: unsafeVersionRoot, syncDefaultRoots: false } },
    latest: { ...latest, minecraft: { ...latest.minecraft, version: '../escape' } },
    installed: null,
    profile: { rootDir: unsafeVersionRoot, syncedProfiles: [{ rootDir: unsafeVersionRoot }], minecraftVersion: '../escape' },
    manifestUrl: fakeManifestUrl,
    fetchJsonImpl: fakeFetchJson
  });
} catch (error) {
  unsafeVersionError = error;
}
if (!unsafeVersionError || !/unsafe Minecraft version identifier/i.test(unsafeVersionError.message || '')) {
  throw new Error(`Unsafe Minecraft version identifier was not rejected before path use: ${unsafeVersionError?.message || 'no error'}`);
}
const hookFixtureDir = path.join(root, 'minecraft-base-hook-fixture');
const hookMinecraftRoot = path.join(root, 'minecraft-base-hook-root');
await fs.mkdir(hookFixtureDir, { recursive: true });
await fs.writeFile(path.join(hookFixtureDir, 'client.jar'), clientBytes);
await fs.writeFile(path.join(hookFixtureDir, 'base-library.jar'), libraryBytes);
const hookAssetIndexBytes = Buffer.from(`${JSON.stringify({ objects: {} }, null, 2)}\n`);
await fs.writeFile(path.join(hookFixtureDir, 'asset-index.json'), hookAssetIndexBytes);
await fs.writeFile(path.join(hookFixtureDir, '1.12.2.json'), JSON.stringify({
  id: '1.12.2',
  mainClass: 'net.minecraft.client.main.Main',
  minecraftArguments: '--username ${auth_player_name}',
  assetIndex: { id: '1.12', ...descriptor('asset-index.json', hookAssetIndexBytes) },
  downloads: { client: descriptor('client.jar', clientBytes) },
  libraries: [{
    name: 'example:hook-library:1',
    downloads: {
      artifact: descriptor('base-library.jar', libraryBytes, 'example/hook-library/1/hook-library-1.jar')
    }
  }]
}, null, 2), 'utf8');
const previousTestHooks = process.env.AHT_TEST_HOOKS;
const previousBaseFixtureDir = process.env.AHT_TEST_MINECRAFT_BASE_FIXTURE_DIR;
let hookAssetRepair = null;
try {
  process.env.AHT_TEST_HOOKS = '1';
  process.env.AHT_TEST_MINECRAFT_BASE_FIXTURE_DIR = hookFixtureDir;
  hookAssetRepair = await ensureMinecraftLauncherAssets({
    config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: hookMinecraftRoot, syncDefaultRoots: false } },
    latest,
    installed: null,
    profile: { rootDir: hookMinecraftRoot, syncedProfiles: [{ rootDir: hookMinecraftRoot }], minecraftVersion: '1.12.2' }
  });
} finally {
  if (previousTestHooks === undefined) delete process.env.AHT_TEST_HOOKS;
  else process.env.AHT_TEST_HOOKS = previousTestHooks;
  if (previousBaseFixtureDir === undefined) delete process.env.AHT_TEST_MINECRAFT_BASE_FIXTURE_DIR;
  else process.env.AHT_TEST_MINECRAFT_BASE_FIXTURE_DIR = previousBaseFixtureDir;
}
if (!hookAssetRepair?.ok || !(await fs.readFile(path.join(hookMinecraftRoot, 'versions', '1.12.2', '1.12.2.jar'))).equals(clientBytes)) {
  throw new Error(`Dual-gated offline Minecraft base fixture was not honored: ${JSON.stringify(hookAssetRepair)}`);
}
console.log(JSON.stringify({
  profilesPath: created.profilesPath,
  platformRoots,
  macRootCandidates,
  winRootCandidates,
  syncedProfileCount: syncedState.syncedProfileCount,
  missingLoaderRoot: inspectedMissingProfile.rootDir,
  macAuth: {
    signedIn: macAuth.signedIn,
    preferredUsername: macAuth.preferredUsername,
    legacyPreferredUsername: legacyAuth.preferredUsername,
    msaOnlySignedIn: msaOnlyAuth.signedIn
  },
  versionId: created.versionId,
  curseForgeVersionId: curseForgeProfile.versionId,
  loaderInstalled: inspected.loaderInstalled,
  forgeInstallerUrl: forgePlan.installerUrl,
  forgeInstallArgs: forgePlan.args,
  profile
}, null, 2));
