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
await fs.mkdir(path.join(dualProfileRoot, 'versions', versionId), { recursive: true });
await fs.writeFile(path.join(dualProfileRoot, 'versions', versionId, `${versionId}.json`), '{}');
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
const fakeFetches = [];
const fakeAssetDownloads = [];
const fakeFetchJson = async (url) => {
  fakeFetches.push(String(url));
  if (url === fakeManifestUrl) {
    return { versions: [{ id: '1.12.2', url: fakeVersionUrl }] };
  }
  if (url === fakeVersionUrl) {
    return { id: '1.12.2', assetIndex: { id: '1.12', url: fakeAssetUrl } };
  }
  if (url === fakeAssetUrl) {
    return { objects: { 'minecraft/lang/en_us.lang': { hash: fakeAssetHash, size: fakeAssetBytes.length } } };
  }
  throw new Error(`Unexpected fake fetch ${url}`);
};
const fakeDownloadFile = async (source, dest) => {
  fakeAssetDownloads.push({ source, dest });
  await fs.mkdir(path.dirname(dest), { recursive: true });
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
if (createHash('sha1').update(await fs.readFile(fakeAssetObjectPath)).digest('hex') !== fakeAssetHash) {
  throw new Error('Downloaded Minecraft asset object did not match the asset index hash.');
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
  || fakeAssetDownloads.length !== multiAssetDownloadsBefore + 1
) {
  throw new Error(`Synced asset roots should share local repaired assets before downloading again: ${JSON.stringify({ multiAssetRepair, fakeAssetDownloads })}`);
}
for (const item of [multiPrimaryObject, multiSyncedObject]) {
  if (createHash('sha1').update(await fs.readFile(item)).digest('hex') !== fakeAssetHash) {
    throw new Error(`Synced asset object did not match the asset index hash: ${item}`);
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
