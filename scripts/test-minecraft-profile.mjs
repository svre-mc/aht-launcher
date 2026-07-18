import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultMinecraftRoot,
  ensureMinecraftLauncherAssets,
  ensureMinecraftLauncherProfile,
  inspectMinecraftLauncherAuth,
  inspectMinecraftLauncherProfile,
  minecraftRootCandidates,
  loaderVersionId,
  setMinecraftLauncherHomePage
} from '../src/minecraftLauncherProfile.js';
import {
  buildForgeInstallPlan,
  findInstalledForgeVersion,
  forgeInstallerUrl,
  friendlyForgeJavaErrorMessage,
  javaSetupHelpMessage,
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
const fakeBundledLegacyJava = path.join(minecraftRoot, 'runtime', 'jre-legacy', 'windows-x64', 'jre-legacy', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const fakeInstalledJavaRoot = path.join(root, 'Program Files', 'Eclipse Adoptium');
const fakeInstalledJava = path.join(fakeInstalledJavaRoot, 'jdk-8.0.999.1-hotspot', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
await fs.mkdir(path.dirname(fakeBundledLegacyJava), { recursive: true });
await fs.mkdir(path.dirname(fakeInstalledJava), { recursive: true });
await fs.writeFile(fakeBundledLegacyJava, 'bundled-legacy');
await fs.writeFile(fakeInstalledJava, 'temurin-8');
const resolvedInstalledJava = await resolveJavaPath(created, { javaInstallRoots: [fakeInstalledJavaRoot] });
if (resolvedInstalledJava !== fakeInstalledJava) {
  throw new Error(`Expected installed Temurin Java 8 to beat bundled legacy Java, got ${resolvedInstalledJava}`);
}
const fakeJava17Home = path.join(root, 'Program Files', 'Java', 'jdk-17');
const fakeJava17 = path.join(fakeJava17Home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
await fs.mkdir(path.dirname(fakeJava17), { recursive: true });
await fs.writeFile(fakeJava17, 'java-17');
await fs.writeFile(path.join(fakeJava17Home, 'release'), 'JAVA_VERSION="17.0.10"\n');
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

const corruptProfileRoot = path.join(root, 'corrupt-profile-root');
await fs.mkdir(path.join(corruptProfileRoot, 'versions', versionId), { recursive: true });
await fs.writeFile(path.join(corruptProfileRoot, 'versions', versionId, `${versionId}.json`), '{}', 'utf8');
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
const fakeManifestUrl = 'https://example.invalid/version_manifest_v2.json';
const fakeVersionUrl = 'https://example.invalid/1.12.2.json';
const fakeAssetUrl = 'https://example.invalid/1.12.json';
const fakeFetches = [];
const fakeFetchJson = async (url) => {
  fakeFetches.push(String(url));
  if (url === fakeManifestUrl) {
    return { versions: [{ id: '1.12.2', url: fakeVersionUrl }] };
  }
  if (url === fakeVersionUrl) {
    return { id: '1.12.2', assetIndex: { id: '1.12', url: fakeAssetUrl } };
  }
  if (url === fakeAssetUrl) {
    return { objects: { 'minecraft/lang/en_us.lang': { hash: 'a'.repeat(40), size: 1 } } };
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
  throw new Error(`Expected missing Minecraft metadata to be repaired: ${JSON.stringify(firstAssetRepair)}`);
}
const assetIndexPath = path.join(assetRoot, 'assets', 'indexes', '1.12.json');
if (!JSON.parse(await fs.readFile(assetIndexPath, 'utf8')).objects?.['minecraft/lang/en_us.lang']) {
  throw new Error('Asset index was not written correctly.');
}
await fs.writeFile(assetIndexPath, '', 'utf8');
const secondAssetRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: assetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: assetProfile,
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson
});
if (!secondAssetRepair.repaired) {
  throw new Error('Corrupt asset index was not repaired.');
}
const assetBackupDir = path.join(assetRoot, 'assets', 'indexes');
const assetBackups = (await fs.readdir(assetBackupDir)).filter((name) => name.includes('1.12.json.aht-corrupt-'));
if (!assetBackups.length) {
  throw new Error('Corrupt asset index was not backed up before repair.');
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
