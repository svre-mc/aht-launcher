import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultMinecraftRoot,
  ensureMinecraftLauncherProfile,
  inspectMinecraftLauncherAuth,
  inspectMinecraftLauncherProfile,
  minecraftRootCandidates,
  loaderVersionId
} from '../src/minecraftLauncherProfile.js';
import {
  buildForgeInstallPlan,
  findInstalledForgeVersion,
  forgeInstallerUrl,
  resolveJavaPath
} from '../src/forgeInstaller.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-profile-test-'));
const instanceDir = path.join(root, 'instance');
const minecraftRoot = path.join(root, '.minecraft');
const versionId = '1.12.2-forge-14.23.5.2860';
await fs.mkdir(path.join(minecraftRoot, 'versions', versionId), { recursive: true });
await fs.writeFile(path.join(minecraftRoot, 'versions', versionId, `${versionId}.json`), '{}');

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
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }],
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

if (loaderVersionId(latest.minecraft) !== versionId) {
  throw new Error('Forge loader id was not mapped to the expected Minecraft Launcher version id.');
}

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
if (!profile.javaArgs.includes('-Xmx4096m') || !profile.javaArgs.includes('-Daht.launcher.present=true') || !profile.javaArgs.includes('-Daht.launcher.proofFile=')) {
  throw new Error(`Expected RAM and launcher proof args, got ${profile.javaArgs}`);
}
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
const expectedUrl = 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-installer.jar';
if (forgeInstallerUrl(latest.minecraft.version, latest.minecraft.modLoaders[0].id) !== expectedUrl) {
  throw new Error('Forge installer URL was not derived correctly.');
}
const forgePlan = buildForgeInstallPlan(created);
if (forgePlan.args.join(' ') !== `-jar ${forgePlan.installerPath} --installClient ${minecraftRoot}`) {
  throw new Error(`Unexpected Forge install args: ${forgePlan.args.join(' ')}`);
}
const exactForgeInstall = await findInstalledForgeVersion(forgePlan);
if (!exactForgeInstall.installed || exactForgeInstall.versionId !== versionId) {
  throw new Error(`Expected exact Forge profile detection, got ${JSON.stringify(exactForgeInstall)}`);
}
const altForgeRoot = path.join(root, 'alt-forge-root');
const altForgeVersionId = '1.12.2-forge1.12.2-14.23.5.2860';
await fs.mkdir(path.join(altForgeRoot, 'versions', altForgeVersionId), { recursive: true });
await fs.writeFile(path.join(altForgeRoot, 'versions', altForgeVersionId, `${altForgeVersionId}.json`), '{}');
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
const resolvedJava = await resolveJavaPath(created, { javaRoots: [fakeRuntimeRoot] });
if (resolvedJava !== fakeLegacyJava) {
  throw new Error(`Expected legacy Minecraft Java runtime, got ${resolvedJava}`);
}
const explicitJava = path.join(root, 'custom-java', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
await fs.mkdir(path.dirname(explicitJava), { recursive: true });
await fs.writeFile(explicitJava, 'custom');
const resolvedExplicitJava = await resolveJavaPath(created, { javaPath: explicitJava, javaRoots: [fakeRuntimeRoot] });
if (resolvedExplicitJava !== explicitJava) {
  throw new Error(`Expected explicit Java path, got ${resolvedExplicitJava}`);
}

const macAuthRoot = path.join(root, 'mac-launcher-auth');
await fs.mkdir(macAuthRoot, { recursive: true });
await fs.writeFile(path.join(macAuthRoot, 'launcher_accounts.json'), JSON.stringify({
  activeAccountLocalId: 'active',
  accounts: {
    backup: { type: 'Xbox', minecraftProfile: { name: 'BackupMac' } },
    active: { type: 'Xbox', minecraftProfile: { name: 'MacUser' } }
  }
}));
const macAuth = await inspectMinecraftLauncherAuth(macAuthRoot);
if (!macAuth.signedIn || macAuth.preferredUsername !== 'MacUser' || macAuth.accountCount !== 2) {
  throw new Error(`Expected active macOS launcher account, got ${JSON.stringify(macAuth)}`);
}

const macLegacyAuthRoot = path.join(root, 'mac-launcher-legacy-auth');
await fs.mkdir(macLegacyAuthRoot, { recursive: true });
await fs.writeFile(path.join(macLegacyAuthRoot, 'launcher_profiles.json'), JSON.stringify({
  selectedUser: { account: 'legacy-active' },
  authenticationDatabase: {
    other: { displayName: 'OtherMac' },
    'legacy-active': { displayName: 'LegacyMac' }
  }
}));
const legacyAuth = await inspectMinecraftLauncherAuth('', { extraRoots: [macLegacyAuthRoot] });
if (!legacyAuth.signedIn || legacyAuth.preferredUsername !== 'LegacyMac' || legacyAuth.accountCount !== 2) {
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
await fs.mkdir(path.join(curseForgeRoot, 'versions', curseForgeVersionId), { recursive: true });
await fs.writeFile(path.join(curseForgeRoot, 'versions', curseForgeVersionId, `${curseForgeVersionId}.json`), '{}');
await fs.writeFile(path.join(curseForgeRoot, 'launcher_accounts.json'), JSON.stringify({
  activeAccountLocalId: 'active',
  accounts: {
    backup: { type: 'Xbox', minecraftProfile: { name: 'BackupUser' } },
    active: { type: 'Xbox', minecraftProfile: { name: 'ActiveUser' } }
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
const curseForgeProfiles = JSON.parse(await fs.readFile(path.join(curseForgeRoot, 'launcher_profiles.json'), 'utf8'));
const curseForgeProfileJson = curseForgeProfiles.profiles['a-hard-time-dregora'];
if (
  !curseForgeProfileJson.javaArgs.includes('-Xmx4096m')
  || !curseForgeProfileJson.javaArgs.includes('-DlibraryDirectory=')
  || !curseForgeProfileJson.javaArgs.includes('-Dfml.ignorePatchDiscrepancies=true')
) {
  throw new Error(`Expected CurseForge Java properties, got ${curseForgeProfileJson.javaArgs}`);
}

const syncedMinecraftRoot = path.join(root, 'synced-minecraft-root');
await fs.mkdir(path.join(syncedMinecraftRoot, 'versions', versionId), { recursive: true });
await fs.writeFile(path.join(syncedMinecraftRoot, 'versions', versionId, `${versionId}.json`), '{}');
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
