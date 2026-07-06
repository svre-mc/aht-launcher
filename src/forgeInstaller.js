import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  downloadToFile,
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonFile
} from './utils.js';
import { minecraftServiceFailureMessage } from './minecraftServiceStatus.js';

export function forgeLoaderVersion(loaderId = '') {
  return String(loaderId).startsWith('forge-') ? String(loaderId).slice('forge-'.length) : '';
}

export function forgeInstallerFileName(minecraftVersion, loaderId) {
  const forgeVersion = forgeLoaderVersion(loaderId);
  if (!minecraftVersion || !forgeVersion) {
    return '';
  }
  return `forge-${minecraftVersion}-${forgeVersion}-installer.jar`;
}

export function forgeInstallerUrl(minecraftVersion, loaderId) {
  const forgeVersion = forgeLoaderVersion(loaderId);
  const fileName = forgeInstallerFileName(minecraftVersion, loaderId);
  if (!minecraftVersion || !forgeVersion || !fileName) {
    return '';
  }
  const coordinate = `${minecraftVersion}-${forgeVersion}`;
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${coordinate}/${fileName}`;
}

export function buildForgeInstallPlan(profile, options = {}) {
  const minecraftVersion = profile?.minecraftVersion || '';
  const loaderId = profile?.loaderId || '';
  const rootDir = profile?.rootDir || '';
  const fileName = forgeInstallerFileName(minecraftVersion, loaderId);
  if (!minecraftVersion || !loaderId || !rootDir) {
    throw new Error('Minecraft profile metadata is incomplete.');
  }
  if (!loaderId.startsWith('forge-')) {
    throw new Error(`Automatic loader installation only supports Forge. Found ${loaderId}.`);
  }
  const installerUrl = options.installerUrl || forgeInstallerUrl(minecraftVersion, loaderId);
  const installerDir = path.join(rootDir, '.aht-launcher', 'forge-installers');
  const installerPath = path.join(installerDir, fileName);
  return {
    minecraftVersion,
    loaderId,
    versionId: profile.versionId,
    rootDir,
    installerUrl,
    installerDir,
    installerPath,
    javaPath: options.javaPath || 'java',
    args: ['-jar', installerPath, '--installClient', rootDir]
  };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueValues(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    result.push(text);
  }
  return result;
}

function forgeVersionCandidates(plan = {}) {
  const forgeVersion = forgeLoaderVersion(plan.loaderId);
  return uniqueValues([
    plan.versionId,
    plan.minecraftVersion && forgeVersion ? `${plan.minecraftVersion}-forge-${forgeVersion}` : '',
    plan.minecraftVersion && forgeVersion ? `${plan.minecraftVersion}-forge${plan.minecraftVersion}-${forgeVersion}` : '',
    plan.minecraftVersion && forgeVersion ? `${plan.minecraftVersion}-Forge${forgeVersion}-${plan.minecraftVersion}` : '',
    plan.loaderId
  ]);
}

function forgeVersionScore(name = '', plan = {}) {
  const lower = String(name || '').toLowerCase();
  const candidates = forgeVersionCandidates(plan).map((candidate) => candidate.toLowerCase());
  const exactIndex = candidates.indexOf(lower);
  if (exactIndex >= 0) return exactIndex;
  const forgeVersion = forgeLoaderVersion(plan.loaderId).toLowerCase();
  const minecraftVersion = String(plan.minecraftVersion || '').toLowerCase();
  if (forgeVersion && minecraftVersion && lower.includes('forge') && lower.includes(forgeVersion) && lower.includes(minecraftVersion)) return 20;
  if (forgeVersion && lower.includes('forge') && lower.includes(forgeVersion)) return 30;
  return 100;
}

function forgeVersionJsonBackupPath(file = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.aht-invalid-${stamp}.bak`;
}

async function backupInvalidForgeVersionJson(file = '') {
  try {
    if (await pathExists(file)) {
      await fs.copyFile(file, forgeVersionJsonBackupPath(file));
    }
  } catch {
    // Backup is best-effort; Forge reinstall should still be allowed to continue.
  }
}

function validForgeVersionJson(value = null, versionId = '', plan = {}) {
  if (!value || typeof value !== 'object') return false;
  const id = String(value.id || '').trim();
  const inheritsFrom = String(value.inheritsFrom || '').trim();
  const minecraftArguments = String(value.minecraftArguments || '').trim();
  const libraries = Array.isArray(value.libraries) ? value.libraries : [];
  const validIds = forgeVersionCandidates(plan).map((candidate) => candidate.toLowerCase());
  if (!id || (versionId && id.toLowerCase() !== String(versionId).toLowerCase() && !validIds.includes(id.toLowerCase()))) {
    return false;
  }
  if (plan.minecraftVersion && inheritsFrom !== plan.minecraftVersion) {
    return false;
  }
  if (!minecraftArguments.includes('net.minecraftforge.fml.common.launcher.FMLTweaker')) {
    return false;
  }
  return libraries.length > 0 && libraries.some((item) => String(item?.name || '').startsWith('net.minecraftforge:forge:'));
}

function forgeLibraryArtifacts(versionJson = null) {
  const libraries = Array.isArray(versionJson?.libraries) ? versionJson.libraries : [];
  return libraries
    .map((item) => ({
      name: String(item?.name || '').trim(),
      path: String(item?.downloads?.artifact?.path || '').trim()
    }))
    .filter((item) => item.name && item.path);
}

async function missingForgeLibraryArtifacts(versionJson = null, plan = {}) {
  const missing = [];
  for (const item of forgeLibraryArtifacts(versionJson)) {
    const file = path.join(plan.rootDir || '', 'libraries', item.path);
    if (!(await pathExists(file))) {
      missing.push({ ...item, file });
    }
  }
  return missing;
}

async function inspectForgeVersionJson(jsonPath = '', versionId = '', plan = {}, options = {}) {
  if (!(await pathExists(jsonPath))) {
    return { installed: false, invalid: false, versionId, versionJson: jsonPath };
  }
  let parsed = null;
  try {
    parsed = await readJsonFile(jsonPath);
  } catch (error) {
    if (options.backupInvalid !== false) {
      await backupInvalidForgeVersionJson(jsonPath);
    }
    return {
      installed: false,
      invalid: true,
      versionId,
      versionJson: jsonPath,
      reason: error.message || String(error)
    };
  }
  if (!validForgeVersionJson(parsed, versionId, plan)) {
    if (options.backupInvalid !== false) {
      await backupInvalidForgeVersionJson(jsonPath);
    }
    return {
      installed: false,
      invalid: true,
      versionId,
      versionJson: jsonPath,
      reason: 'incomplete Forge launcher version metadata'
    };
  }
  if (options.verifyLibraries) {
    const missingLibraries = await missingForgeLibraryArtifacts(parsed, plan);
    if (missingLibraries.length) {
      return {
        installed: false,
        invalid: true,
        versionId,
        versionJson: jsonPath,
        reason: `missing ${missingLibraries.length} Forge library file${missingLibraries.length === 1 ? '' : 's'}`,
        missingLibraries
      };
    }
  }
  return { installed: true, invalid: false, versionId, versionJson: jsonPath };
}

export async function findInstalledForgeVersion(plan = {}, options = {}) {
  const versionsDir = path.join(plan.rootDir || '', 'versions');
  const candidates = forgeVersionCandidates(plan);
  const invalidVersions = [];
  for (const candidate of candidates) {
    const jsonPath = path.join(versionsDir, candidate, `${candidate}.json`);
    const inspected = await inspectForgeVersionJson(jsonPath, candidate, plan, options);
    if (inspected.installed) {
      return { installed: true, versionId: candidate, versionJson: jsonPath, invalidVersions };
    }
    if (inspected.invalid) {
      invalidVersions.push(inspected);
    }
  }
  let entries = [];
  try {
    entries = await fs.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return { installed: false, versionId: plan.versionId || '', versionJson: '', invalidVersions };
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const score = forgeVersionScore(entry.name, plan);
    if (score >= 100) continue;
    const jsonPath = path.join(versionsDir, entry.name, `${entry.name}.json`);
    const inspected = await inspectForgeVersionJson(jsonPath, entry.name, plan, options);
    if (inspected.installed) {
      matches.push({ score, versionId: entry.name, versionJson: jsonPath });
    } else if (inspected.invalid) {
      invalidVersions.push(inspected);
    }
  }
  matches.sort((left, right) => left.score - right.score || left.versionId.localeCompare(right.versionId));
  const best = matches[0];
  return best ? { installed: true, versionId: best.versionId, versionJson: best.versionJson, invalidVersions } : { installed: false, versionId: plan.versionId || '', versionJson: '', invalidVersions };
}

async function waitForInstalledForgeVersion(plan = {}, timeoutMs = 15000, options = {}) {
  const started = Date.now();
  let result = await findInstalledForgeVersion(plan, options);
  while (!result.installed && Date.now() - started < timeoutMs) {
    await sleep(500);
    result = await findInstalledForgeVersion(plan, options);
  }
  return result;
}

async function ensureLauncherProfilesFile(rootDir = '') {
  const profilesPath = path.join(rootDir, 'launcher_profiles.json');
  try {
    const profiles = await readJsonFile(profilesPath);
    if (profiles && typeof profiles === 'object') {
      profiles.profiles = profiles.profiles && typeof profiles.profiles === 'object' ? profiles.profiles : {};
      await writeJsonFile(profilesPath, profiles);
      return;
    }
  } catch {
    // Forge 1.12.2 refuses to install without a readable launcher_profiles.json.
  }
  await writeJsonFile(profilesPath, { profiles: {} });
}

function outputTail(output = '') {
  return String(output || '').trim().split(/\r?\n/).slice(-12).join('\n');
}

const WINDOWS_JAVA8_RUNTIME_URL = 'https://api.adoptium.net/v3/binary/latest/8/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk';
const DEFAULT_FORGE_VERSION_WAIT_MS = 5 * 60_000;

function javaExecutableName() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function javaRootKey(root = '') {
  const text = String(root || '').trim();
  if (!text) return '';
  const normalized = path.resolve(text);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isLegacyJavaPath(file = '') {
  const normalized = String(file || '').toLowerCase();
  return normalized.includes('jre-legacy') || normalized.includes('java-runtime-legacy');
}

function isJava8Path(file = '') {
  const normalized = String(file || '').toLowerCase();
  return isLegacyJavaPath(normalized)
    || /(jdk-?8|jre-?8|jdk8|jre8|8u|1\.8|java8|temurin-8)/i.test(normalized);
}

function javaMajorFromVersion(version = '') {
  const text = String(version || '').trim();
  const match = text.match(/^"?(\d+)(?:\.(\d+))?/);
  if (!match) return 0;
  const first = Number(match[1]);
  if (first === 1 && match[2]) return Number(match[2]);
  return first;
}

async function javaMajorFromReleaseFile(javaPath = '') {
  try {
    const releasePath = path.join(path.dirname(path.dirname(javaPath)), 'release');
    const text = await fs.readFile(releasePath, 'utf8');
    const match = text.match(/^JAVA_VERSION="([^"]+)"/m);
    return javaMajorFromVersion(match?.[1] || '');
  } catch {
    return 0;
  }
}

async function isJava8Candidate(file = '') {
  return isJava8Path(file) || await javaMajorFromReleaseFile(file) === 8;
}

function isManagedAhtJavaPath(file = '', cacheDir = '') {
  const javaPath = String(file || '').toLowerCase();
  const cachePath = String(cacheDir || '').toLowerCase();
  return Boolean(javaPath && cachePath && javaPath.startsWith(cachePath));
}

function certificateFailureMessage(error = null) {
  const text = `${error?.message || error || ''}`;
  return /PKIX|certification path|unable to find valid certification path|Failed to validate certificates/i.test(text);
}

function javaRuntimeLaunchFailureMessage(error = null) {
  const text = `${error?.message || error || ''}`;
  return error?.code === 'ENOENT'
    || /ENOENT|not found|spawn .* ENOENT|Java 8 runtime was not found/i.test(text)
    || /(?:could not open|no such file or directory|open).*?(?:java-runtime-[a-z0-9-]+|jre-legacy|[\\/]runtime[\\/].*(?:java-runtime|jre|jdk)|Microsoft\.4297127D64EC6_8wekyb3d8bbwe).*?(?:javaw?|jvm)\.cfg/i.test(text);
}

function managedJavaRetryReason(error = null) {
  if (certificateFailureMessage(error)) {
    return 'failed HTTPS certificate validation';
  }
  if (javaRuntimeLaunchFailureMessage(error)) {
    return 'was missing or could not start cleanly';
  }
  return '';
}

export function javaSetupHelpMessage(platform = process.platform) {
  const runtime = platform === 'win32'
    ? 'Eclipse Temurin JDK 8 (HotSpot) x64'
    : 'Java 8 / JDK 8';
  return `Install ${runtime}, restart AHT Launcher, then try again.`;
}

export function friendlyForgeJavaErrorMessage(error = null, javaPath = 'java', platform = process.platform) {
  const text = `${error?.message || error || ''}`;
  const serviceMessage = minecraftServiceFailureMessage(error);
  if (serviceMessage) {
    return serviceMessage;
  }
  const help = javaSetupHelpMessage(platform);
  if (error?.code === 'ENOENT' || /ENOENT|not found|spawn .* ENOENT/i.test(text)) {
    return `Java 8 runtime was not found (${javaPath}). ${help}`;
  }
  if (certificateFailureMessage(error)) {
    return `Forge could not validate Mojang/Forge HTTPS certificates with the selected Java runtime (${javaPath}). ${help}`;
  }
  return '';
}

function managedJavaDownloadFailureMessage(error = null, platform = process.platform) {
  return `AHT could not download its managed Java 8 runtime. ${javaSetupHelpMessage(platform)}`;
}

function defaultJavaCacheDir(plan = {}, options = {}) {
  return options.javaCacheDir || path.join(plan.rootDir || '.', '.aht-launcher', 'java');
}

function javaRuntimeDownloadUrl(options = {}) {
  if (options.javaDownloadUrl) return options.javaDownloadUrl;
  if (process.env.AHT_JAVA8_DOWNLOAD_URL) return process.env.AHT_JAVA8_DOWNLOAD_URL;
  if (process.platform === 'win32' && process.arch === 'x64') return WINDOWS_JAVA8_RUNTIME_URL;
  return '';
}

async function extractJavaArchive(archivePath, cacheDir) {
  const zip = new AdmZip(archivePath);
  zip.extractAllTo(cacheDir, true);
}

async function ensureManagedJava8Runtime(plan = {}, options = {}) {
  const cacheDir = defaultJavaCacheDir(plan, options);
  const existing = await findJavaInRoot(cacheDir, 8);
  if (existing) return existing;
  const downloadUrl = javaRuntimeDownloadUrl(options);
  if (!downloadUrl) return '';
  await ensureDir(cacheDir);
  const archivePath = path.join(cacheDir, 'temurin-jre8.zip');
  try {
    options.logger?.log?.('Downloading current Java 8 runtime for Forge installer HTTPS support...');
    await downloadToFile(downloadUrl, archivePath);
    options.logger?.log?.('Extracting Java 8 runtime...');
    await extractJavaArchive(archivePath, cacheDir);
  } catch (error) {
    throw new Error(managedJavaDownloadFailureMessage(error));
  }
  const javaPath = await findJavaInRoot(cacheDir, 8);
  if (!javaPath) {
    throw new Error(`Downloaded Java runtime, but ${javaExecutableName()} was not found in ${cacheDir}.`);
  }
  return javaPath;
}

function forgeVersionJsonForPlan(plan = {}, versionId = plan.versionId || '') {
  const forgeVersion = forgeLoaderVersion(plan.loaderId);
  const artifactPath = `net/minecraftforge/forge/${plan.minecraftVersion}-${forgeVersion}/forge-${plan.minecraftVersion}-${forgeVersion}.jar`;
  return {
    id: versionId,
    type: 'release',
    inheritsFrom: plan.minecraftVersion,
    minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker --versionType Forge',
    libraries: [
      {
        name: `net.minecraftforge:forge:${plan.minecraftVersion}-${forgeVersion}`,
        downloads: {
          artifact: {
            path: artifactPath
          }
        }
      }
    ]
  };
}

async function writeForgeLibraryFixturesForTest(plan = {}, versionJson = null) {
  if (process.env.AHT_TEST_HOOKS !== '1') return;
  for (const item of forgeLibraryArtifacts(versionJson)) {
    const file = path.join(plan.rootDir || '', 'libraries', item.path);
    await ensureDir(path.dirname(file));
    await fs.writeFile(file, `aht test forge library ${item.name}\n`, 'utf8');
  }
}

async function resolveForgeInstallerJavaPath(profile = {}, plan = {}, options = {}) {
  const resolved = await resolveJavaPath(profile, options);
  if (resolved === 'java' || isLegacyJavaPath(resolved) || !(await isJava8Candidate(resolved))) {
    const managed = await ensureManagedJava8Runtime(plan, options);
    if (managed) return managed;
  }
  return resolved;
}

async function runForgeInstallerProcess(plan, options = {}, javaPath = plan.javaPath) {
  plan.javaPath = javaPath;
  options.logger?.log?.(`Running ${plan.javaPath} ${plan.args.map((arg) => arg.includes(' ') ? `"${arg}"` : arg).join(' ')}`);
  const testRun = await maybeRunForgeInstallerProcessForTest(plan, options, javaPath);
  if (testRun) return testRun;
  return runProcess(plan.javaPath, plan.args, {
    cwd: plan.rootDir,
    logger: options.logger
  });
}

function looksPathLike(value = '') {
  const text = String(value || '').trim();
  return path.isAbsolute(text) || text.includes('/') || text.includes('\\');
}

function pushJavaRoot(roots, value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return;
  }
  const key = javaRootKey(text);
  if (key && !roots.some((root) => javaRootKey(root) === key)) {
    roots.push(text);
  }
}

function windowsJavaInstallRoots(env = process.env) {
  if (process.platform !== 'win32') {
    return [];
  }
  const programRoots = uniqueValues([
    env.ProgramW6432,
    env.ProgramFiles,
    env['ProgramFiles(x86)']
  ]);
  const userProgramRoots = uniqueValues([
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : '',
    env.USERPROFILE ? path.join(env.USERPROFILE, '.jdks') : ''
  ]);
  const scoopRoots = uniqueValues([
    env.SCOOP ? path.join(env.SCOOP, 'apps') : '',
    env.USERPROFILE ? path.join(env.USERPROFILE, 'scoop', 'apps') : ''
  ]);
  const chocolateyRoot = env.ProgramData ? path.join(env.ProgramData, 'chocolatey', 'lib') : '';
  const vendorDirs = [
    'Eclipse Adoptium',
    'Adoptium',
    'Java',
    'Microsoft',
    'Zulu',
    'BellSoft'
  ];
  const roots = [];
  for (const root of programRoots) {
    for (const vendor of vendorDirs) {
      pushJavaRoot(roots, path.join(root, vendor));
    }
  }
  for (const root of userProgramRoots) {
    pushJavaRoot(roots, root);
    for (const vendor of vendorDirs) {
      pushJavaRoot(roots, path.join(root, vendor));
    }
  }
  const packageDirs = [
    'temurin8',
    'temurin8-jdk',
    'temurin8-jre',
    'adoptium8',
    'adoptium8-jdk',
    'adoptium8-jre',
    'jdk8',
    'jre8',
    'zulu8',
    'zulu8-jdk',
    'zulu8-jre'
  ];
  for (const root of scoopRoots) {
    for (const dir of packageDirs) {
      pushJavaRoot(roots, path.join(root, dir));
    }
  }
  if (chocolateyRoot) {
    for (const dir of packageDirs) {
      pushJavaRoot(roots, path.join(chocolateyRoot, dir));
    }
  }
  return roots;
}

function javaSearchRoots(profile = {}, options = {}) {
  const roots = [];
  const rootDir = profile?.rootDir || '';
  for (const root of options.javaRoots || []) {
    pushJavaRoot(roots, root);
  }
  pushJavaRoot(roots, rootDir ? path.join(rootDir, '.aht-launcher', 'java') : '');
  pushJavaRoot(roots, rootDir ? path.join(rootDir, 'java') : '');
  for (const root of options.javaInstallRoots || windowsJavaInstallRoots()) {
    pushJavaRoot(roots, root);
  }
  pushJavaRoot(roots, rootDir ? path.join(rootDir, 'runtime') : '');
  if (process.platform === 'win32' && rootDir) {
    pushJavaRoot(roots, path.resolve(rootDir, '..', '..', 'Local', 'runtime'));
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    pushJavaRoot(roots, path.join(
      process.env.LOCALAPPDATA,
      'Packages',
      'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
      'LocalCache',
      'Local',
      'runtime'
    ));
  }
  if (process.env.APPDATA) {
    pushJavaRoot(roots, path.join(process.env.APPDATA, '.minecraft', 'runtime'));
  }
  return roots;
}

function rankJavaCandidate(file = '') {
  const normalized = String(file || '').toLowerCase();
  if (/(temurin|adoptium|eclipse adoptium|zulu|bellsoft|microsoft|java)/i.test(normalized) && isJava8Path(normalized)) return 0;
  if (normalized.includes('.aht-launcher') && isJava8Path(normalized)) return 1;
  if (normalized.includes('jre-legacy') || normalized.includes('java-runtime-legacy')) return 2;
  if (normalized.includes('java-runtime-gamma')) return 4;
  if (normalized.includes('java-runtime-beta')) return 5;
  if (normalized.includes('java-runtime-delta')) return 6;
  if (normalized.includes('java-runtime-epsilon')) return 7;
  if (normalized.includes('jre_21') || normalized.includes('java-runtime-alpha')) return 9;
  return 8;
}

async function findJavaInRoot(root, maxDepth = 6, options = {}) {
  const target = javaExecutableName().toLowerCase();
  const matches = [];
  async function visit(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) {
        matches.push(fullPath);
      } else if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
      }
    }
  }
  await visit(root, 0);
  matches.sort((left, right) => rankJavaCandidate(left) - rankJavaCandidate(right) || left.localeCompare(right));
  if (options.requireJava8) {
    for (const match of matches) {
      if (await isJava8Candidate(match)) return match;
    }
    return '';
  }
  return matches[0] || '';
}

export async function resolveJavaPath(profile = {}, options = {}) {
  const configured = String(options.javaPath || '').trim();
  const explicitCandidates = [];
  if (configured && configured !== 'java') {
    explicitCandidates.push(configured);
  }
  for (const candidate of explicitCandidates) {
    if (looksPathLike(candidate) && await pathExists(candidate)) {
      return candidate;
    }
  }
  const envCandidates = [];
  for (const envName of ['AHT_JAVA_HOME', 'JAVA8_HOME', 'JDK8_HOME', 'JRE8_HOME', 'JDK_HOME', 'JAVA_HOME', 'JRE_HOME']) {
    const envPath = String(process.env[envName] || '').trim();
    if (envPath) {
      envCandidates.push(path.join(envPath, 'bin', javaExecutableName()));
    }
  }
  const fallbackCandidates = [];
  for (const candidate of envCandidates) {
    if (looksPathLike(candidate) && await pathExists(candidate)) {
      if (await isJava8Candidate(candidate)) {
        return candidate;
      }
      fallbackCandidates.push(candidate);
    }
  }
  let fallbackRootJava = '';
  for (const root of javaSearchRoots(profile, options)) {
    const javaPath = await findJavaInRoot(root, 6, { requireJava8: true });
    if (javaPath) {
      return javaPath;
    }
    if (!fallbackRootJava) {
      fallbackRootJava = await findJavaInRoot(root);
    }
  }
  for (const candidate of fallbackCandidates) {
    return candidate;
  }
  if (fallbackRootJava) {
    return fallbackRootJava;
  }
  return configured || 'java';
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const output = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const collect = (chunk) => {
      const text = String(chunk);
      output.push(text);
      if (options.logger?.log) {
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          options.logger.log(line);
        }
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      const friendly = friendlyForgeJavaErrorMessage(error, command);
      reject(friendly ? new Error(friendly) : error);
    });
    child.once('close', (code) => {
      const text = output.join('');
      if (code === 0) {
        resolve({ code, output: text });
      } else {
        const tail = text.trim().split(/\r?\n/).slice(-8).join('\n');
        reject(new Error(`Forge installer exited with code ${code}${tail ? `:\n${tail}` : ''}`));
      }
    });
  });
}

async function maybeInstallForgeLoaderForTest(plan = {}) {
  if (process.env.AHT_TEST_HOOKS !== '1' || process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS !== '1') {
    return null;
  }
  const expectedUrl = String(process.env.AHT_TEST_EXPECT_FORGE_INSTALLER_URL || '').trim();
  if (expectedUrl && plan.installerUrl !== expectedUrl) {
    throw new Error(`Test Forge installer URL mismatch: expected ${expectedUrl}, got ${plan.installerUrl}`);
  }
  const versionId = plan.versionId || `${plan.minecraftVersion}-forge-${forgeLoaderVersion(plan.loaderId)}`;
  const versionDir = path.join(plan.rootDir, 'versions', versionId);
  const versionJson = path.join(versionDir, `${versionId}.json`);
  await ensureDir(versionDir);
  const metadata = forgeVersionJsonForPlan(plan, versionId);
  await writeJsonFile(versionJson, {
    ...metadata,
    ahtTestForgeInstaller: true
  });
  await writeForgeLibraryFixturesForTest(plan, metadata);
  return {
    ok: true,
    skipped: false,
    testHook: true,
    plan: { ...plan, versionId, versionJson },
    output: 'AHT test Forge installer hook wrote launcher version metadata.',
    loaderInstalled: true,
    versionId,
    versionJson
  };
}

async function writeForgeVersionForTest(plan = {}) {
  const versionId = plan.versionId || `${plan.minecraftVersion}-forge-${forgeLoaderVersion(plan.loaderId)}`;
  const versionDir = path.join(plan.rootDir, 'versions', versionId);
  const versionJson = path.join(versionDir, `${versionId}.json`);
  await ensureDir(versionDir);
  const metadata = forgeVersionJsonForPlan(plan, versionId);
  await writeJsonFile(versionJson, {
    ...metadata,
    ahtTestForgeInstaller: true
  });
  await writeForgeLibraryFixturesForTest(plan, metadata);
  return { versionId, versionJson };
}

async function maybeRunForgeInstallerProcessForTest(plan = {}, options = {}, javaPath = plan.javaPath) {
  if (process.env.AHT_TEST_HOOKS !== '1') {
    return null;
  }
  const cacheDir = defaultJavaCacheDir(plan, options);
  if (
    process.env.AHT_TEST_FORGE_JAVA_RUNTIME_FAIL_ONCE === '1'
    && process.env.AHT_TEST_FORGE_JAVA_RUNTIME_FAILED !== '1'
    && !isManagedAhtJavaPath(javaPath, cacheDir)
  ) {
    process.env.AHT_TEST_FORGE_JAVA_RUNTIME_FAILED = '1';
    const brokenCfg = path.join(path.dirname(path.dirname(javaPath)), 'lib', 'amd64', 'jvm.cfg');
    throw new Error(`Forge installer exited with code 1: Error: could not open ${brokenCfg}`);
  }
  if (process.env.AHT_TEST_FORGE_INSTALLER_RUN_SUCCESS !== '1') {
    return null;
  }
  const { versionId, versionJson } = await writeForgeVersionForTest(plan);
  return {
    code: 0,
    output: `AHT test Forge installer process wrote ${versionId} using ${javaPath}.\nVersion JSON: ${versionJson}`
  };
}
export async function installForgeLoader(profile, options = {}) {
  const plan = buildForgeInstallPlan(profile, options);
  if (profile.versionJson) {
    const existing = await inspectForgeVersionJson(profile.versionJson, profile.versionId, plan, {
      backupInvalid: true,
      verifyLibraries: Boolean(options.verifyLibraries)
    });
    if (existing.installed) {
      return {
        ok: true,
        skipped: true,
        reason: `${profile.versionId} is already installed.`,
        plan
      };
    }
    if (existing.invalid) {
      const reason = existing.reason ? ` (${existing.reason})` : '';
      options.logger?.log?.(`Forge ${profile.versionId} metadata or libraries were invalid${reason}; reinstalling before launch.`);
    }
  }
  if (profile.loaderInstalled && !profile.versionJson) {
    return {
      ok: true,
      skipped: true,
      reason: `${profile.versionId} is already installed.`,
      plan
    };
  }
  const testInstall = await maybeInstallForgeLoaderForTest(plan);
  if (testInstall) {
    return testInstall;
  }

  await ensureDir(plan.installerDir || path.dirname(plan.installerPath));
  await ensureLauncherProfilesFile(plan.rootDir);
  if (!(await pathExists(plan.installerPath)) || options.forceDownload) {
    options.logger?.log?.(`Downloading Forge installer ${plan.installerUrl}`);
    await downloadToFile(plan.installerUrl, plan.installerPath);
  }

  plan.javaPath = await resolveForgeInstallerJavaPath(profile, plan, options);
  let result;
  try {
    result = await runForgeInstallerProcess(plan, options, plan.javaPath);
  } catch (error) {
    const cacheDir = defaultJavaCacheDir(plan, options);
    const retryReason = managedJavaRetryReason(error);
    if (!retryReason || isManagedAhtJavaPath(plan.javaPath, cacheDir)) {
      const friendly = friendlyForgeJavaErrorMessage(error, plan.javaPath);
      throw new Error(friendly || error.message || String(error));
    }
    options.logger?.log?.(`Forge installer Java ${retryReason}. Retrying with AHT managed Java 8 runtime...`);
    let managedJava = '';
    try {
      managedJava = await ensureManagedJava8Runtime(plan, { ...options, forceDownloadJava: true });
      result = await runForgeInstallerProcess(plan, options, managedJava);
    } catch (retryError) {
      const friendly = friendlyForgeJavaErrorMessage(retryError, managedJava || plan.javaPath);
      throw new Error(friendly || managedJavaDownloadFailureMessage(retryError));
    }
  }
  const installed = await waitForInstalledForgeVersion(plan, options.versionWaitMs ?? DEFAULT_FORGE_VERSION_WAIT_MS, {
    backupInvalid: true,
    verifyLibraries: Boolean(options.verifyLibraries)
  });
  if (!installed.installed) {
    const tail = outputTail(result.output);
    const friendly = friendlyForgeJavaErrorMessage(tail, plan.javaPath);
    if (friendly) {
      throw new Error(friendly);
    }
    throw new Error(`Forge installer finished, but no compatible Forge ${forgeLoaderVersion(plan.loaderId)} profile was found in ${path.join(plan.rootDir, 'versions')}.${tail ? ` Installer output:\n${tail}` : ''}`);
  }
  plan.versionId = installed.versionId;
  plan.versionJson = installed.versionJson;
  return {
    ok: true,
    skipped: false,
    plan,
    output: result.output,
    loaderInstalled: true,
    versionId: installed.versionId,
    versionJson: installed.versionJson
  };
}
