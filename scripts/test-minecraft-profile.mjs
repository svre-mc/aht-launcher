import { createHash } from 'node:crypto';
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
  loaderVersionId
} from '../src/minecraftLauncherProfile.js';
import {
  buildForgeInstallPlan,
  findInstalledForgeVersion,
  forgeInstallerUrl,
  friendlyForgeJavaErrorMessage,
  installForgeLoader,
  javaSetupHelpMessage,
  resolveJavaPath
} from '../src/forgeInstaller.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-profile-test-'));
const instanceDir = path.join(root, 'instance');
const minecraftRoot = path.join(root, '.minecraft');
const versionId = '1.12.2-forge-14.23.5.2860';
function forgeVersionMetadata(id = versionId, minecraftVersion = '1.12.2') {
  return {
    id,
    type: 'release',
    inheritsFrom: minecraftVersion,
    minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker --versionType Forge',
    libraries: [
      {
        name: `net.minecraftforge:forge:${minecraftVersion}-14.23.5.2860`,
        downloads: {
          artifact: {
            path: `net/minecraftforge/forge/${minecraftVersion}-14.23.5.2860/forge-${minecraftVersion}-14.23.5.2860.jar`
          }
        }
      }
    ]
  };
}

async function writeForgeVersion(rootDir, id = versionId, minecraftVersion = '1.12.2') {
  await fs.mkdir(path.join(rootDir, 'versions', id), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'versions', id, `${id}.json`), JSON.stringify(forgeVersionMetadata(id, minecraftVersion), null, 2));
}

await writeForgeVersion(minecraftRoot);

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
    profileId: 'a-hard-time',
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
const profile = profiles.profiles['a-hard-time'];

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
profiles.profiles['a-hard-time'] = {
  ...profile,
  gameDir: path.join(os.tmpdir(), 'aht-stale-player-instance')
};
profiles.profiles['a-hard-time-dregora'] = {
  name: 'A Hard Time',
  type: 'custom',
  lastVersionId: versionId,
  gameDir: path.join(root, 'AHT', 'A Hard Time Developer')
};
profiles.profiles['a-hard-time-developer'] = {
  name: 'A Hard Time',
  type: 'custom',
  lastVersionId: versionId,
  gameDir: path.join(root, 'AHT', 'A Hard Time')
};
await fs.writeFile(path.join(minecraftRoot, 'launcher_profiles.json'), JSON.stringify(profiles, null, 2));
const cleanedProfile = await ensureMinecraftLauncherProfile({ config, latest, installed: null });
const cleanedProfiles = JSON.parse(await fs.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
if (cleanedProfiles.profiles['a-hard-time'].gameDir !== path.resolve(instanceDir)) {
  throw new Error(`Current player profile was not repaired from a stale temp gameDir: ${JSON.stringify(cleanedProfiles.profiles['a-hard-time'])}`);
}
if (cleanedProfiles.profiles['a-hard-time-dregora'] || cleanedProfiles.profiles['a-hard-time-developer']) {
  throw new Error(`Stale legacy/wrong-folder AHT profiles were not cleaned: ${JSON.stringify(cleanedProfiles.profiles)}`);
}
const removedProfileIds = (cleanedProfile.profileCleanup || []).map((item) => item.profileId).sort();
if (removedProfileIds.join(',') !== 'a-hard-time-developer,a-hard-time-dregora') {
  throw new Error(`Expected stale managed profile cleanup, got ${JSON.stringify(cleanedProfile.profileCleanup)}`);
}
const dualProfileRoot = path.join(root, 'dual-profile-root');
const playerNamedDir = path.join(root, 'AHT', 'A Hard Time');
const developerNamedDir = path.join(root, 'AHT', 'A Hard Time Developer');
await writeForgeVersion(dualProfileRoot);
await fs.writeFile(path.join(dualProfileRoot, 'launcher_profiles.json'), JSON.stringify({
  profiles: {
    'a-hard-time': {
      name: 'A Hard Time',
      type: 'custom',
      lastVersionId: versionId,
      gameDir: playerNamedDir
    },
    'a-hard-time-dregora': {
      name: 'A Hard Time',
      type: 'custom',
      lastVersionId: versionId,
      gameDir: path.join(os.tmpdir(), 'aht-legacy-profile')
    }
  }
}, null, 2));
await ensureMinecraftLauncherProfile({
  config: {
    ...config,
    instanceDir: developerNamedDir,
    minecraftLauncher: {
      ...config.minecraftLauncher,
      rootDir: dualProfileRoot,
      profileId: 'a-hard-time-developer'
    }
  },
  latest,
  installed: null
});
const dualProfiles = JSON.parse(await fs.readFile(path.join(dualProfileRoot, 'launcher_profiles.json'), 'utf8'));
if (!dualProfiles.profiles['a-hard-time'] || dualProfiles.profiles['a-hard-time'].gameDir !== playerNamedDir) {
  throw new Error(`Valid player profile should coexist with developer profile: ${JSON.stringify(dualProfiles.profiles)}`);
}
if (!dualProfiles.profiles['a-hard-time-developer'] || dualProfiles.profiles['a-hard-time-developer'].gameDir !== path.resolve(developerNamedDir)) {
  throw new Error(`Developer profile was not written to the developer instance: ${JSON.stringify(dualProfiles.profiles)}`);
}
if (dualProfiles.profiles['a-hard-time-dregora']) {
  throw new Error(`Legacy AHT profile was not removed during developer profile write: ${JSON.stringify(dualProfiles.profiles)}`);
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
const ramProfile = ramProfiles.profiles['a-hard-time'];
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
await writeForgeVersion(altForgeRoot, altForgeVersionId);
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

const forgeRetryRoot = path.join(root, 'forge-runtime-retry-root');
const brokenRuntimeHome = path.join(forgeRetryRoot, 'runtime', 'java-runtime-gamma');
const brokenRuntimeJava = path.join(brokenRuntimeHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const managedJavaCacheDir = path.join(forgeRetryRoot, '.aht-launcher', 'java');
const managedJavaHome = path.join(managedJavaCacheDir, 'temurin-8');
const managedJava = path.join(managedJavaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
await fs.mkdir(path.dirname(brokenRuntimeJava), { recursive: true });
await fs.writeFile(brokenRuntimeJava, 'broken runtime java');
await fs.writeFile(path.join(brokenRuntimeHome, 'release'), 'JAVA_VERSION="1.8.0_51"\n');
await fs.mkdir(path.dirname(managedJava), { recursive: true });
await fs.writeFile(managedJava, 'managed java 8');
await fs.writeFile(path.join(managedJavaHome, 'release'), 'JAVA_VERSION="1.8.0_452"\n');
const forgeRetryProfile = {
  minecraftVersion: '1.12.2',
  loaderId: 'forge-14.23.5.2860',
  versionId,
  rootDir: forgeRetryRoot
};
const forgeRetryPlan = buildForgeInstallPlan(forgeRetryProfile, {
  javaPath: brokenRuntimeJava,
  installerUrl: 'https://example.test/forge-installer.jar'
});
await fs.mkdir(forgeRetryPlan.installerDir, { recursive: true });
await fs.writeFile(forgeRetryPlan.installerPath, 'fake forge installer');
const previousForgeHookEnv = new Map([
  ['AHT_TEST_HOOKS', process.env.AHT_TEST_HOOKS],
  ['AHT_TEST_FORGE_JAVA_RUNTIME_FAIL_ONCE', process.env.AHT_TEST_FORGE_JAVA_RUNTIME_FAIL_ONCE],
  ['AHT_TEST_FORGE_JAVA_RUNTIME_FAILED', process.env.AHT_TEST_FORGE_JAVA_RUNTIME_FAILED],
  ['AHT_TEST_FORGE_INSTALLER_RUN_SUCCESS', process.env.AHT_TEST_FORGE_INSTALLER_RUN_SUCCESS]
]);
try {
  process.env.AHT_TEST_HOOKS = '1';
  process.env.AHT_TEST_FORGE_JAVA_RUNTIME_FAIL_ONCE = '1';
  delete process.env.AHT_TEST_FORGE_JAVA_RUNTIME_FAILED;
  process.env.AHT_TEST_FORGE_INSTALLER_RUN_SUCCESS = '1';
  const retryLog = [];
  const retryResult = await installForgeLoader(forgeRetryProfile, {
    javaPath: brokenRuntimeJava,
    installerUrl: 'https://example.test/forge-installer.jar',
    javaCacheDir: managedJavaCacheDir,
    logger: { log: (line) => retryLog.push(String(line)) },
    versionWaitMs: 1
  });
  if (!retryResult.loaderInstalled || retryResult.versionId !== versionId) {
    throw new Error(`Broken Java retry did not install Forge metadata: ${JSON.stringify(retryResult)}`);
  }
  if (!retryLog.some((line) => /could not start cleanly|AHT managed Java 8 runtime/i.test(line))) {
    throw new Error(`Broken Java retry did not log managed Java fallback: ${retryLog.join('\n')}`);
  }
  if (!retryResult.output.includes(managedJava)) {
    throw new Error(`Broken Java retry did not run the managed Java path: ${retryResult.output}`);
  }
} finally {
  for (const [name, value] of previousForgeHookEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
const javaHelp = javaSetupHelpMessage('win32');
if (!javaHelp.includes('Eclipse Temurin JDK 8') || !javaHelp.includes('restart AHT Launcher') || !javaHelp.includes('then try again') || javaHelp.includes('click Update again')) {
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
const certificateWithForgeHostMessage = friendlyForgeJavaErrorMessage(new Error('PKIX path building failed while connecting to https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-installer.jar'), fakeLegacyJava, 'win32');
if (!certificateWithForgeHostMessage.includes('could not validate Mojang/Forge HTTPS certificates') || certificateWithForgeHostMessage.includes('Minecraft services')) {
  throw new Error(`Certificate host message was mislabeled: ${certificateWithForgeHostMessage}`);
}

const minecraftServiceMessage = friendlyForgeJavaErrorMessage(new Error('Forge installer exited with code 1: Error: could not open C:\\Users\\Player\\AppData\\Local\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\runtime\\java-runtime-gamma\\windows-x64\\java-runtime-gamma\\lib\\amd64\\jvm.cfg'), fakeModernJava, 'win32');
if (!minecraftServiceMessage.includes('Minecraft services') || !minecraftServiceMessage.includes('Mojang/Microsoft') || minecraftServiceMessage.includes('jvm.cfg')) {
  throw new Error(`Minecraft outage message is not clean: ${minecraftServiceMessage}`);
}

const screenshotRuntimeServiceMessage = friendlyForgeJavaErrorMessage(new Error("Forge installer exited with code 1: Error: could not open 'C:\\Users\\coars\\AppData\\Local\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\runtime\\java-runtime-gamma\\windows-x64\\java-runtime-gamma\\bin\\javaw.exe\\lib\\amd64\\jvm.cfg'"), fakeModernJava, 'win32');
if (!screenshotRuntimeServiceMessage.includes('Minecraft services') || !screenshotRuntimeServiceMessage.includes('Mojang/Microsoft') || screenshotRuntimeServiceMessage.includes('javaw.exe') || screenshotRuntimeServiceMessage.includes('jvm.cfg')) {
  throw new Error(`Screenshot runtime outage message is not clean: ${screenshotRuntimeServiceMessage}`);
}

const minecraftGammaLegacyServiceMessage = friendlyForgeJavaErrorMessage(new Error('Forge installer exited with code 1: Error: could not open C:\\Users\\coars\\AppData\\Local\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\runtime\\java-runtime-gamma-legacy\\windows-x64\\java-runtime-gamma-legacy\\lib\\amd64\\jvm.cfg'), fakeModernJava, 'win32');
if (!minecraftGammaLegacyServiceMessage.includes('Minecraft services') || !minecraftGammaLegacyServiceMessage.includes('Mojang/Microsoft') || minecraftGammaLegacyServiceMessage.includes('java-runtime-gamma-legacy')) {
  throw new Error(`Minecraft gamma legacy outage message is not clean: ${minecraftGammaLegacyServiceMessage}`);
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
if (msaOnlyAuth.profileKnown || !msaOnlyAuth.credentialOnly) {
  throw new Error(`Expected MSA-only auth to be marked as credential-only without a known profile, got ${JSON.stringify(msaOnlyAuth)}`);
}
const curseForgeRoot = path.join(root, 'curseforge', 'minecraft', 'Install');
const curseForgeVersionId = 'forge-14.23.5.2860';
await writeForgeVersion(curseForgeRoot, curseForgeVersionId);
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
if (!curseForgeProfile.accountProfileKnown || curseForgeProfile.accountCredentialOnly) {
  throw new Error(`Expected full launcher account profile state, got ${JSON.stringify(curseForgeProfile)}`);
}
if (curseForgeProfile.preferredMinecraftUsername !== 'ActiveUser') {
  throw new Error(`Expected active launcher account username, got ${curseForgeProfile.preferredMinecraftUsername}`);
}
if (curseForgeProfile.syncedProfileCount !== 1) {
  throw new Error(`Expected only the selected Minecraft root to be written by default, got ${curseForgeProfile.syncedProfileCount}`);
}
const curseForgeProfiles = JSON.parse(await fs.readFile(path.join(curseForgeRoot, 'launcher_profiles.json'), 'utf8'));
const curseForgeProfileJson = curseForgeProfiles.profiles['a-hard-time'];
if (
  !curseForgeProfileJson.javaArgs.includes('-Xmx4096m')
  || !curseForgeProfileJson.javaArgs.includes('-DlibraryDirectory=')
  || !curseForgeProfileJson.javaArgs.includes('-Dfml.ignorePatchDiscrepancies=true')
) {
  throw new Error(`Expected CurseForge Java properties, got ${curseForgeProfileJson.javaArgs}`);
}

const syncedMinecraftRoot = path.join(root, 'synced-minecraft-root');
await writeForgeVersion(syncedMinecraftRoot);
const syncedConfig = {
  ...curseForgeConfig,
  minecraftLauncher: {
    ...curseForgeConfig.minecraftLauncher,
    syncRoots: [syncedMinecraftRoot]
  }
};
const syncedState = await ensureMinecraftLauncherProfile({ config: syncedConfig, latest, installed: null });
if (syncedState.syncedProfileCount !== 2) {
  throw new Error(`Expected explicit syncRoots to write both selected and synced roots, got ${syncedState.syncedProfileCount}`);
}
const syncedProfiles = JSON.parse(await fs.readFile(path.join(syncedMinecraftRoot, 'launcher_profiles.json'), 'utf8'));
const syncedProfileJson = syncedProfiles.profiles['a-hard-time'];
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

const invalidForgeRoot = path.join(root, 'invalid-forge-version-root');
const invalidForgeVersionJson = path.join(invalidForgeRoot, 'versions', versionId, `${versionId}.json`);
await fs.mkdir(path.dirname(invalidForgeVersionJson), { recursive: true });
await fs.writeFile(invalidForgeVersionJson, '{}', 'utf8');
const invalidForgeConfig = {
  ...config,
  minecraftLauncher: {
    ...config.minecraftLauncher,
    rootDir: invalidForgeRoot,
    syncDefaultRoots: false
  }
};
const invalidForgeState = await ensureMinecraftLauncherProfile({ config: invalidForgeConfig, latest, installed: null });
if (invalidForgeState.loaderInstalled) {
  throw new Error(`Incomplete Forge version JSON should not count as installed: ${JSON.stringify(invalidForgeState)}`);
}
const invalidForgeEnv = new Map([
  ['AHT_TEST_HOOKS', process.env.AHT_TEST_HOOKS],
  ['AHT_TEST_FORGE_INSTALLER_SUCCESS', process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS]
]);
try {
  process.env.AHT_TEST_HOOKS = '1';
  process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS = '1';
  const invalidForgeLog = [];
  const invalidForgeInstall = await installForgeLoader(invalidForgeState, {
    installerUrl: 'https://example.test/forge-installer.jar',
    logger: { log: (line) => invalidForgeLog.push(String(line)) },
    versionWaitMs: 1
  });
  if (!invalidForgeInstall.loaderInstalled || invalidForgeInstall.versionId !== versionId) {
    throw new Error(`Invalid Forge metadata was not repaired by install flow: ${JSON.stringify(invalidForgeInstall)}`);
  }
  if (!invalidForgeLog.some((line) => /metadata or libraries were invalid/i.test(line))) {
    throw new Error(`Invalid Forge metadata repair was not logged: ${invalidForgeLog.join('\n')}`);
  }
  const invalidForgeBackups = (await fs.readdir(path.dirname(invalidForgeVersionJson))).filter((name) => name.includes(`${versionId}.json.aht-invalid-`));
  if (!invalidForgeBackups.length) {
    throw new Error('Invalid Forge version JSON was not backed up before reinstall.');
  }
  const repairedForgeState = await inspectMinecraftLauncherProfile({ config: invalidForgeConfig, latest, installed: null });
  if (!repairedForgeState.loaderInstalled) {
    throw new Error(`Repaired Forge metadata did not become launchable: ${JSON.stringify(repairedForgeState)}`);
  }
} finally {
  for (const [name, value] of invalidForgeEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

const missingLibraryRoot = path.join(root, 'missing-forge-library-root');
await writeForgeVersion(missingLibraryRoot);
const missingLibraryConfig = {
  ...config,
  minecraftLauncher: {
    ...config.minecraftLauncher,
    rootDir: missingLibraryRoot,
    syncDefaultRoots: false
  }
};
const missingLibraryState = await ensureMinecraftLauncherProfile({ config: missingLibraryConfig, latest, installed: null });
if (!missingLibraryState.loaderInstalled) {
  throw new Error(`Missing-library fixture should have valid Forge metadata before library verification: ${JSON.stringify(missingLibraryState)}`);
}
const missingLibraryEnv = new Map([
  ['AHT_TEST_HOOKS', process.env.AHT_TEST_HOOKS],
  ['AHT_TEST_FORGE_INSTALLER_SUCCESS', process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS]
]);
try {
  process.env.AHT_TEST_HOOKS = '1';
  process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS = '1';
  const missingLibraryLog = [];
  const missingLibraryInstall = await installForgeLoader(missingLibraryState, {
    installerUrl: 'https://example.test/forge-installer.jar',
    logger: { log: (line) => missingLibraryLog.push(String(line)) },
    versionWaitMs: 1,
    verifyLibraries: true
  });
  if (!missingLibraryInstall.loaderInstalled || missingLibraryInstall.versionId !== versionId) {
    throw new Error(`Missing Forge library was not repaired by install flow: ${JSON.stringify(missingLibraryInstall)}`);
  }
  if (!missingLibraryLog.some((line) => /missing 1 Forge library file|metadata or libraries were invalid/i.test(line))) {
    throw new Error(`Missing Forge library repair was not logged: ${missingLibraryLog.join('\n')}`);
  }
} finally {
  for (const [name, value] of missingLibraryEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

const corruptProfileRoot = path.join(root, 'corrupt-profile-root');
await writeForgeVersion(corruptProfileRoot);
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
if (!repairedProfiles.profiles?.['a-hard-time']) {
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
const fakeAssetBytes = Buffer.from('aht asset object\n');
const fakeAssetHash = createHash('sha1').update(fakeAssetBytes).digest('hex');
const fakeAssetObjectPath = path.join(assetRoot, 'assets', 'objects', fakeAssetHash.slice(0, 2), fakeAssetHash);
const minecraftLibraryOsName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const minecraftLibraryArch = /64/.test(process.arch) ? '64' : '32';
const fakeLibraryBytes = Buffer.from('aht minecraft library jar\n');
const fakeNativeBytes = Buffer.from('aht minecraft native jar\n');
const fakeClientJarBytes = Buffer.from('aht minecraft client jar\n');
const fakeLogConfigBytes = Buffer.from('<Configuration>aht log config</Configuration>\n');
const fakeLibraryHash = createHash('sha1').update(fakeLibraryBytes).digest('hex');
const fakeNativeHash = createHash('sha1').update(fakeNativeBytes).digest('hex');
const fakeClientJarHash = createHash('sha1').update(fakeClientJarBytes).digest('hex');
const fakeLogConfigHash = createHash('sha1').update(fakeLogConfigBytes).digest('hex');
const fakeLibraryRelPath = 'com/example/base-lib/1.0.0/base-lib-1.0.0.jar';
const fakeNativeClassifier = `natives-${minecraftLibraryOsName}-${minecraftLibraryArch}`;
const fakeNativeRelPath = `com/example/native-lib/1.0.0/native-lib-1.0.0-${fakeNativeClassifier}.jar`;
const fakeLibraryUrl = 'https://libraries.example.invalid/base-lib-1.0.0.jar';
const fakeNativeUrl = 'https://libraries.example.invalid/native-lib-1.0.0-native.jar';
const fakeClientJarUrl = 'https://piston-data.example.invalid/client.jar';
const fakeLogConfigUrl = 'https://piston-data.example.invalid/client-1.12.xml';
const fakeLibraryPath = path.join(assetRoot, 'libraries', fakeLibraryRelPath);
const fakeNativePath = path.join(assetRoot, 'libraries', fakeNativeRelPath);
const fakeClientJarPath = path.join(assetRoot, 'versions', '1.12.2', '1.12.2.jar');
const fakeLogConfigPath = path.join(assetRoot, 'assets', 'log_configs', 'client-1.12.xml');
const fakeFetches = [];
const fakeAssetDownloads = [];
const fakeLibraryDownloads = [];
const fakeRuntimeDownloads = [];
const fakeFetchJson = async (url) => {
  fakeFetches.push(String(url));
  if (url === fakeManifestUrl) {
    return { versions: [{ id: '1.12.2', url: fakeVersionUrl }] };
  }
  if (url === fakeVersionUrl) {
    return {
      id: '1.12.2',
      assetIndex: { id: '1.12', url: fakeAssetUrl },
      downloads: {
        client: {
          sha1: fakeClientJarHash,
          size: fakeClientJarBytes.length,
          url: fakeClientJarUrl
        }
      },
      logging: {
        client: {
          argument: '-Dlog4j.configurationFile=${path}',
          file: {
            id: 'client-1.12.xml',
            sha1: fakeLogConfigHash,
            size: fakeLogConfigBytes.length,
            url: fakeLogConfigUrl
          },
          type: 'log4j2-xml'
        }
      },
      libraries: [
        {
          name: 'com.example:base-lib:1.0.0',
          downloads: {
            artifact: {
              path: fakeLibraryRelPath,
              url: fakeLibraryUrl,
              sha1: fakeLibraryHash,
              size: fakeLibraryBytes.length
            }
          }
        },
        {
          name: 'com.example:native-lib:1.0.0',
          natives: { [minecraftLibraryOsName]: `natives-${minecraftLibraryOsName}-${'${arch}'}` },
          downloads: {
            classifiers: {
              [fakeNativeClassifier]: {
                path: fakeNativeRelPath,
                url: fakeNativeUrl,
                sha1: fakeNativeHash,
                size: fakeNativeBytes.length
              }
            }
          }
        },
        {
          name: 'com.example:blocked-lib:1.0.0',
          rules: [{ action: 'allow', os: { name: 'not-this-os' } }],
          downloads: {
            artifact: {
              path: 'com/example/blocked-lib/1.0.0/blocked-lib-1.0.0.jar',
              url: 'https://libraries.example.invalid/blocked-lib.jar',
              sha1: fakeLibraryHash,
              size: fakeLibraryBytes.length
            }
          }
        }
      ]
    };
  }
  if (url === fakeAssetUrl) {
    return { objects: { 'minecraft/lang/en_us.lang': { hash: fakeAssetHash, size: fakeAssetBytes.length } } };
  }
  throw new Error(`Unexpected fake fetch ${url}`);
};
const fakeDownloadFile = async (source, dest) => {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (source === fakeLibraryUrl) {
    fakeLibraryDownloads.push({ source, dest });
    await fs.writeFile(dest, fakeLibraryBytes);
    return;
  }
  if (source === fakeNativeUrl) {
    fakeLibraryDownloads.push({ source, dest });
    await fs.writeFile(dest, fakeNativeBytes);
    return;
  }
  if (source === fakeClientJarUrl) {
    fakeRuntimeDownloads.push({ source, dest });
    await fs.writeFile(dest, fakeClientJarBytes);
    return;
  }
  if (source === fakeLogConfigUrl) {
    fakeRuntimeDownloads.push({ source, dest });
    await fs.writeFile(dest, fakeLogConfigBytes);
    return;
  }
  fakeAssetDownloads.push({ source, dest });
  await fs.writeFile(dest, fakeAssetBytes);
};
const assetProfile = { rootDir: assetRoot, syncedProfiles: [{ rootDir: assetRoot }], minecraftVersion: '1.12.2' };
const firstAssetRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: assetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: assetProfile,
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson,
  downloadFileImpl: fakeDownloadFile
});
if (!firstAssetRepair.ok || !firstAssetRepair.repaired) {
  throw new Error(`Expected missing Minecraft metadata to be repaired: ${JSON.stringify(firstAssetRepair)}`);
}
if (firstAssetRepair.assetObjects.downloaded !== 1 || fakeAssetDownloads.length !== 1) {
  throw new Error(`Missing Minecraft asset object was not downloaded: ${JSON.stringify({ firstAssetRepair, fakeAssetDownloads })}`);
}
if (firstAssetRepair.libraries.downloaded !== 2 || fakeLibraryDownloads.length !== 2) {
  throw new Error(`Missing Minecraft libraries were not downloaded: ${JSON.stringify({ firstAssetRepair, fakeLibraryDownloads })}`);
}
if (firstAssetRepair.runtimeArtifacts.downloaded !== 2 || fakeRuntimeDownloads.length !== 2) {
  throw new Error(`Missing Minecraft runtime artifacts were not downloaded: ${JSON.stringify({ firstAssetRepair, fakeRuntimeDownloads })}`);
}
if (createHash('sha1').update(await fs.readFile(fakeAssetObjectPath)).digest('hex') !== fakeAssetHash) {
  throw new Error('Downloaded Minecraft asset object did not match the asset index hash.');
}
if (createHash('sha1').update(await fs.readFile(fakeLibraryPath)).digest('hex') !== fakeLibraryHash) {
  throw new Error('Downloaded Minecraft base library did not match the version metadata hash.');
}
if (createHash('sha1').update(await fs.readFile(fakeNativePath)).digest('hex') !== fakeNativeHash) {
  throw new Error('Downloaded Minecraft native library did not match the version metadata hash.');
}
if (createHash('sha1').update(await fs.readFile(fakeClientJarPath)).digest('hex') !== fakeClientJarHash) {
  throw new Error('Downloaded Minecraft client jar did not match the version metadata hash.');
}
if (createHash('sha1').update(await fs.readFile(fakeLogConfigPath)).digest('hex') !== fakeLogConfigHash) {
  throw new Error('Downloaded Minecraft logging config did not match the version metadata hash.');
}
const assetIndexPath = path.join(assetRoot, 'assets', 'indexes', '1.12.json');
if (!JSON.parse(await fs.readFile(assetIndexPath, 'utf8')).objects?.['minecraft/lang/en_us.lang']) {
  throw new Error('Asset index was not written correctly.');
}
const legacyAssetIndexPath = path.join(assetRoot, 'assets', 'indexes', 'legacy.json');
if (!JSON.parse(await fs.readFile(legacyAssetIndexPath, 'utf8')).objects?.['minecraft/lang/en_us.lang']) {
  throw new Error('Legacy asset index alias was not written for Minecraft 1.12.2.');
}
const multiAssetPrimaryRoot = path.join(root, 'asset-multi-primary-root');
const multiAssetSyncedRoot = path.join(root, 'asset-multi-synced-root');
const multiAssetDownloadsBefore = fakeAssetDownloads.length;
const multiLibraryDownloadsBefore = fakeLibraryDownloads.length;
const multiRuntimeDownloadsBefore = fakeRuntimeDownloads.length;
const multiAssetRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: multiAssetPrimaryRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: {
    rootDir: multiAssetPrimaryRoot,
    syncedProfiles: [
      { rootDir: multiAssetPrimaryRoot },
      { rootDir: multiAssetSyncedRoot }
    ],
    minecraftVersion: '1.12.2'
  },
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson,
  downloadFileImpl: fakeDownloadFile,
  verifyAssetHashes: true
});
const multiPrimaryObject = path.join(multiAssetPrimaryRoot, 'assets', 'objects', fakeAssetHash.slice(0, 2), fakeAssetHash);
const multiSyncedObject = path.join(multiAssetSyncedRoot, 'assets', 'objects', fakeAssetHash.slice(0, 2), fakeAssetHash);
if (
  multiAssetRepair.assetObjects.downloaded !== 1
  || multiAssetRepair.assetObjects.copied !== 1
  || multiAssetRepair.libraries.downloaded !== 2
  || multiAssetRepair.libraries.copied !== 2
  || multiAssetRepair.runtimeArtifacts.downloaded !== 2
  || multiAssetRepair.runtimeArtifacts.copied !== 2
  || fakeAssetDownloads.length !== multiAssetDownloadsBefore + 1
  || fakeLibraryDownloads.length !== multiLibraryDownloadsBefore + 2
  || fakeRuntimeDownloads.length !== multiRuntimeDownloadsBefore + 2
) {
  throw new Error(`Synced asset roots should share local repaired assets, libraries, and runtime files before downloading again: ${JSON.stringify({ multiAssetRepair, fakeAssetDownloads, fakeLibraryDownloads, fakeRuntimeDownloads })}`);
}
for (const item of [multiPrimaryObject, multiSyncedObject]) {
  if (createHash('sha1').update(await fs.readFile(item)).digest('hex') !== fakeAssetHash) {
    throw new Error(`Synced asset object did not match the asset index hash: ${item}`);
  }
}
for (const rootDir of [multiAssetPrimaryRoot, multiAssetSyncedRoot]) {
  const libraryFile = path.join(rootDir, 'libraries', fakeLibraryRelPath);
  const nativeFile = path.join(rootDir, 'libraries', fakeNativeRelPath);
  if (createHash('sha1').update(await fs.readFile(libraryFile)).digest('hex') !== fakeLibraryHash) {
    throw new Error(`Synced base library did not match version metadata hash: ${libraryFile}`);
  }
  if (createHash('sha1').update(await fs.readFile(nativeFile)).digest('hex') !== fakeNativeHash) {
    throw new Error(`Synced native library did not match version metadata hash: ${nativeFile}`);
  }
  const clientJarFile = path.join(rootDir, 'versions', '1.12.2', '1.12.2.jar');
  const logConfigFile = path.join(rootDir, 'assets', 'log_configs', 'client-1.12.xml');
  if (createHash('sha1').update(await fs.readFile(clientJarFile)).digest('hex') !== fakeClientJarHash) {
    throw new Error(`Synced client jar did not match version metadata hash: ${clientJarFile}`);
  }
  if (createHash('sha1').update(await fs.readFile(logConfigFile)).digest('hex') !== fakeLogConfigHash) {
    throw new Error(`Synced logging config did not match version metadata hash: ${logConfigFile}`);
  }
}
if (!JSON.parse(await fs.readFile(path.join(multiAssetSyncedRoot, 'assets', 'indexes', 'legacy.json'), 'utf8')).objects?.['minecraft/lang/en_us.lang']) {
  throw new Error('Synced launcher root did not get the legacy asset index alias.');
}
await fs.writeFile(legacyAssetIndexPath, '', 'utf8');
const legacyAliasRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: assetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: assetProfile,
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson,
  downloadFileImpl: fakeDownloadFile
});
if (!legacyAliasRepair.repaired || !JSON.parse(await fs.readFile(legacyAssetIndexPath, 'utf8')).objects?.['minecraft/lang/en_us.lang']) {
  throw new Error('Corrupt legacy asset index alias was not repaired.');
}
await fs.writeFile(assetIndexPath, '', 'utf8');
const secondAssetRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: assetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: assetProfile,
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson,
  downloadFileImpl: fakeDownloadFile
});
if (!secondAssetRepair.repaired) {
  throw new Error('Corrupt asset index was not repaired.');
}
await fs.writeFile(fakeAssetObjectPath, '');
const downloadsBeforeCorruptObjectRepair = fakeAssetDownloads.length;
const corruptObjectRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: assetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: assetProfile,
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson,
  downloadFileImpl: fakeDownloadFile
});
if (!corruptObjectRepair.repaired || corruptObjectRepair.assetObjects.downloaded !== 1 || fakeAssetDownloads.length !== downloadsBeforeCorruptObjectRepair + 1) {
  throw new Error(`Corrupt Minecraft asset object was not repaired: ${JSON.stringify({ corruptObjectRepair, fakeAssetDownloads })}`);
}
await fs.writeFile(fakeLibraryPath, Buffer.from('bad minecraft library bytes\n'));
const downloadsBeforeCorruptLibraryRepair = fakeLibraryDownloads.length;
const corruptLibraryRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: assetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: assetProfile,
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson,
  downloadFileImpl: fakeDownloadFile,
  verifyAssetHashes: true
});
if (
  !corruptLibraryRepair.repaired
  || corruptLibraryRepair.libraries.downloaded !== 1
  || fakeLibraryDownloads.length !== downloadsBeforeCorruptLibraryRepair + 1
  || createHash('sha1').update(await fs.readFile(fakeLibraryPath)).digest('hex') !== fakeLibraryHash
) {
  throw new Error(`Corrupt Minecraft library was not repaired: ${JSON.stringify({ corruptLibraryRepair, fakeLibraryDownloads })}`);
}
await fs.writeFile(fakeClientJarPath, Buffer.from('bad minecraft client jar bytes\n'));
const downloadsBeforeCorruptRuntimeRepair = fakeRuntimeDownloads.length;
const corruptRuntimeRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: assetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
  profile: assetProfile,
  manifestUrl: fakeManifestUrl,
  fetchJsonImpl: fakeFetchJson,
  downloadFileImpl: fakeDownloadFile,
  verifyAssetHashes: true
});
if (
  !corruptRuntimeRepair.repaired
  || corruptRuntimeRepair.runtimeArtifacts.downloaded !== 1
  || fakeRuntimeDownloads.length !== downloadsBeforeCorruptRuntimeRepair + 1
  || createHash('sha1').update(await fs.readFile(fakeClientJarPath)).digest('hex') !== fakeClientJarHash
) {
  throw new Error(`Corrupt Minecraft runtime artifact was not repaired: ${JSON.stringify({ corruptRuntimeRepair, fakeRuntimeDownloads })}`);
}
const assetBackupDir = path.join(assetRoot, 'assets', 'indexes');
const assetBackups = (await fs.readdir(assetBackupDir)).filter((name) => name.includes('1.12.json.aht-corrupt-'));
if (!assetBackups.length) {
  throw new Error('Corrupt asset index was not backed up before repair.');
}
const flakyAssetRoot = path.join(root, 'asset-flaky-root');
let flakyDownloadAttempts = 0;
const flakyAssetRepair = await ensureMinecraftLauncherAssets({
  config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: flakyAssetRoot, syncDefaultRoots: false } },
  latest,
  installed: null,
    profile: { rootDir: flakyAssetRoot, syncedProfiles: [{ rootDir: flakyAssetRoot }], minecraftVersion: '1.12.2' },
    manifestUrl: fakeManifestUrl,
    fetchJsonImpl: fakeFetchJson,
    ensureLibraries: false,
    ensureRuntimeArtifacts: false,
    downloadFileImpl: async (source, dest) => {
    flakyDownloadAttempts += 1;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, flakyDownloadAttempts === 1 ? Buffer.from('bad asset bytes\n') : fakeAssetBytes);
  }
});
const flakyAssetObjectPath = path.join(flakyAssetRoot, 'assets', 'objects', fakeAssetHash.slice(0, 2), fakeAssetHash);
if (!flakyAssetRepair.repaired || flakyDownloadAttempts !== 2 || createHash('sha1').update(await fs.readFile(flakyAssetObjectPath)).digest('hex') !== fakeAssetHash) {
  throw new Error(`Asset object hash mismatch was not retried and repaired: ${JSON.stringify({ flakyAssetRepair, flakyDownloadAttempts })}`);
}
const badAssetRoot = path.join(root, 'asset-bad-root');
let badAssetMessage = '';
try {
  await ensureMinecraftLauncherAssets({
    config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: badAssetRoot, syncDefaultRoots: false } },
    latest,
    installed: null,
    profile: { rootDir: badAssetRoot, syncedProfiles: [{ rootDir: badAssetRoot }], minecraftVersion: '1.12.2' },
    manifestUrl: fakeManifestUrl,
    fetchJsonImpl: fakeFetchJson,
    ensureLibraries: false,
    ensureRuntimeArtifacts: false,
    downloadFileImpl: async (_source, dest) => {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from('always bad asset bytes\n'));
    }
  });
} catch (error) {
  badAssetMessage = error.message;
}
if (!badAssetMessage.includes('Minecraft services') || badAssetMessage.includes('Mojang metadata after download') || badAssetMessage.includes('minecraft/lang/en_us.lang')) {
  throw new Error(`Repeated Minecraft asset hash failures should produce a clean service message: ${badAssetMessage}`);
}
const badLibraryRoot = path.join(root, 'library-bad-root');
let badLibraryMessage = '';
try {
  await ensureMinecraftLauncherAssets({
    config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: badLibraryRoot, syncDefaultRoots: false } },
    latest,
    installed: null,
    profile: { rootDir: badLibraryRoot, syncedProfiles: [{ rootDir: badLibraryRoot }], minecraftVersion: '1.12.2' },
    manifestUrl: fakeManifestUrl,
    fetchJsonImpl: fakeFetchJson,
    ensureAssetObjects: false,
    downloadFileImpl: async (_source, dest) => {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from('always bad library bytes\n'));
    },
    verifyAssetHashes: true
  });
} catch (error) {
  badLibraryMessage = error.message;
}
if (!badLibraryMessage.includes('Minecraft services') || badLibraryMessage.includes('Mojang metadata after download') || badLibraryMessage.includes('base-lib')) {
  throw new Error(`Repeated Minecraft library hash failures should produce a clean service message: ${badLibraryMessage}`);
}
const badRuntimeRoot = path.join(root, 'runtime-bad-root');
let badRuntimeMessage = '';
try {
  await ensureMinecraftLauncherAssets({
    config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: badRuntimeRoot, syncDefaultRoots: false } },
    latest,
    installed: null,
    profile: { rootDir: badRuntimeRoot, syncedProfiles: [{ rootDir: badRuntimeRoot }], minecraftVersion: '1.12.2' },
    manifestUrl: fakeManifestUrl,
    fetchJsonImpl: fakeFetchJson,
    ensureAssetObjects: false,
    ensureLibraries: false,
    downloadFileImpl: async (_source, dest) => {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from('always bad runtime bytes\n'));
    },
    verifyAssetHashes: true
  });
} catch (error) {
  badRuntimeMessage = error.message;
}
if (!badRuntimeMessage.includes('Minecraft services') || badRuntimeMessage.includes('Mojang metadata after download') || badRuntimeMessage.includes('client jar') || badRuntimeMessage.includes('1.12.2.jar')) {
  throw new Error(`Repeated Minecraft runtime hash failures should produce a clean service message: ${badRuntimeMessage}`);
}
const outageAssetRoot = path.join(root, 'asset-outage-root');
let assetOutageMessage = '';
try {
  await ensureMinecraftLauncherAssets({
    config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, rootDir: outageAssetRoot, syncDefaultRoots: false } },
    latest,
    installed: null,
    profile: { rootDir: outageAssetRoot, syncedProfiles: [{ rootDir: outageAssetRoot }], minecraftVersion: '1.12.2' },
    manifestUrl: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    fetchJsonImpl: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    }
  });
} catch (error) {
  assetOutageMessage = error.message;
}
if (!assetOutageMessage.includes('Minecraft services') || !assetOutageMessage.includes('Mojang/Microsoft') || assetOutageMessage.includes('Unexpected end of JSON')) {
  throw new Error(`Minecraft asset outage message is not clean: ${assetOutageMessage}`);
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
