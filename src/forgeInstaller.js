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

export async function findInstalledForgeVersion(plan = {}) {
  const versionsDir = path.join(plan.rootDir || '', 'versions');
  const candidates = forgeVersionCandidates(plan);
  for (const candidate of candidates) {
    const jsonPath = path.join(versionsDir, candidate, `${candidate}.json`);
    if (await pathExists(jsonPath)) {
      return { installed: true, versionId: candidate, versionJson: jsonPath };
    }
  }
  let entries = [];
  try {
    entries = await fs.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return { installed: false, versionId: plan.versionId || '', versionJson: '' };
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const score = forgeVersionScore(entry.name, plan);
    if (score >= 100) continue;
    const jsonPath = path.join(versionsDir, entry.name, `${entry.name}.json`);
    if (await pathExists(jsonPath)) {
      matches.push({ score, versionId: entry.name, versionJson: jsonPath });
    }
  }
  matches.sort((left, right) => left.score - right.score || left.versionId.localeCompare(right.versionId));
  const best = matches[0];
  return best ? { installed: true, versionId: best.versionId, versionJson: best.versionJson } : { installed: false, versionId: plan.versionId || '', versionJson: '' };
}

async function waitForInstalledForgeVersion(plan = {}, timeoutMs = 15000) {
  const started = Date.now();
  let result = await findInstalledForgeVersion(plan);
  while (!result.installed && Date.now() - started < timeoutMs) {
    await sleep(500);
    result = await findInstalledForgeVersion(plan);
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

export function javaSetupHelpMessage(platform = process.platform) {
  const runtime = platform === 'win32'
    ? 'Eclipse Temurin JDK 8 (HotSpot) x64'
    : 'Java 8 / JDK 8';
  return `Install ${runtime}, restart AHT Launcher, then click Update again.`;
}

function minecraftServiceFailureMessage(error = null) {
  const text = `${error?.message || error || ''}`;
  const compact = text.replace(/\s+/g, ' ');
  const officialServicePattern = /REQUEST_FAILED|Unable to prepare assets for download|launcher\.mojang\.com|piston-meta\.mojang\.com|resources\.download\.minecraft\.net|libraries\.minecraft\.net|api\.minecraftservices\.com|sessionserver\.mojang\.com|authserver\.mojang\.com|maven\.minecraftforge\.net|maven\.forgecdn\.net|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network timeout/i;
  const launcherRuntimePattern = /could not open .*java-runtime-(?:gamma|beta|delta|epsilon|alpha).*javaw?\.cfg/i;
  if (!officialServicePattern.test(compact) && !launcherRuntimePattern.test(compact)) {
    return '';
  }
  return 'Minecraft services or the Minecraft Launcher runtime are currently unavailable. Wait for Mojang/Microsoft services to recover, reopen Minecraft Launcher, then try AHT Launcher again.';
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
  await writeJsonFile(versionJson, {
    id: versionId,
    type: 'release',
    inheritsFrom: plan.minecraftVersion,
    ahtTestForgeInstaller: true
  });
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
export async function installForgeLoader(profile, options = {}) {
  const plan = buildForgeInstallPlan(profile, options);
  if (profile.loaderInstalled && await pathExists(profile.versionJson)) {
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
    if (!certificateFailureMessage(error) || isManagedAhtJavaPath(plan.javaPath, cacheDir)) {
      const friendly = friendlyForgeJavaErrorMessage(error, plan.javaPath);
      throw new Error(friendly || error.message || String(error));
    }
    options.logger?.log?.('Forge installer Java failed HTTPS certificate validation. Retrying with current Java 8 runtime...');
    let managedJava = '';
    try {
      managedJava = await ensureManagedJava8Runtime(plan, { ...options, forceDownloadJava: true });
      result = await runForgeInstallerProcess(plan, options, managedJava);
    } catch (retryError) {
      const friendly = friendlyForgeJavaErrorMessage(retryError, managedJava || plan.javaPath);
      throw new Error(friendly || managedJavaDownloadFailureMessage(retryError));
    }
  }
  const installed = await waitForInstalledForgeVersion(plan, options.versionWaitMs ?? DEFAULT_FORGE_VERSION_WAIT_MS);
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
