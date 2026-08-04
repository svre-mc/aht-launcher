import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  downloadToFile,
  ensureDir,
  fetchJson,
  hashFile,
  pathExists,
  readJsonFile,
  safeJoin,
  writeJsonFile
} from './utils.js';

function safeForgeIdentifier(value = '') {
  const text = String(value || '').trim();
  return Boolean(
    text
    && text !== '.'
    && text !== '..'
    && text.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)
  );
}

export function forgeLoaderVersion(loaderId = '') {
  const text = String(loaderId || '').trim();
  if (!safeForgeIdentifier(text) || !text.startsWith('forge-')) return '';
  const version = text.slice('forge-'.length);
  return safeForgeIdentifier(version) ? version : '';
}

export function forgeInstallerFileName(minecraftVersion, loaderId) {
  const forgeVersion = forgeLoaderVersion(loaderId);
  if (!safeForgeIdentifier(minecraftVersion) || !forgeVersion) {
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
  if (!safeForgeIdentifier(minecraftVersion) || !safeForgeIdentifier(loaderId) || (profile.versionId && !safeForgeIdentifier(profile.versionId))) {
    throw new Error('Minecraft or Forge version metadata contains an unsafe identifier.');
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
  ]).filter(safeForgeIdentifier);
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
  if (!(await pathExists(file))) return '';
  const backupPath = forgeVersionJsonBackupPath(file);
  await fs.copyFile(file, backupPath);
  return backupPath;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeForgeLauncherMetadata(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeForgeLauncherMetadata(item))
      .filter((item) => item !== undefined);
  }
  if (!isPlainObject(value)) return value;
  const sanitized = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    // Forge's legacy serializer can emit optional fields as null. The current
    // Mojang launcher rejects those library records instead of treating null
    // as "not set", which leaves the Java command without a classpath.
    if (entryValue === null || entryValue === undefined) continue;
    if (entryKey === 'clientreq' || entryKey === 'serverreq') continue;
    const next = sanitizeForgeLauncherMetadata(entryValue);
    if (next !== undefined) sanitized[entryKey] = next;
  }
  return sanitized;
}

function forgeLibraryLauncherCompatible(library = null, plan = {}) {
  if (!isPlainObject(library) || !String(library.name || '').trim()) return false;
  if ('clientreq' in library || 'serverreq' in library) return false;
  if ('rules' in library && !Array.isArray(library.rules)) return false;
  if ('natives' in library && !isPlainObject(library.natives)) return false;
  if ('extract' in library && !isPlainObject(library.extract)) return false;
  const artifact = library.downloads?.artifact;
  if (!isPlainObject(library.downloads) || !isPlainObject(artifact)) return false;
  const artifactPath = String(artifact.path || '').trim().replaceAll('\\', '/');
  if (
    !artifactPath
    || artifactPath.startsWith('/')
    || /^[a-z]:/i.test(artifactPath)
    || artifactPath.split('/').includes('..')
  ) return false;
  const artifactUrl = String(artifact.url || '').trim();
  // Forge 1.12.2 legitimately leaves only its own artifact URL empty in some
  // launcher roots after installing the verified file locally. All other
  // artifacts must retain HTTPS download metadata.
  const expectedForgeName = `net.minecraftforge:forge:${plan.minecraftVersion || ''}-${forgeLoaderVersion(plan.loaderId || '')}`.toLowerCase();
  if (!artifactUrl && String(library.name || '').trim().toLowerCase() !== expectedForgeName) return false;
  if (artifactUrl && !/^https:\/\//i.test(artifactUrl)) return false;
  if (!/^[a-f0-9]{40}$/i.test(String(artifact.sha1 || '').trim())) return false;
  if (!Number.isFinite(Number(artifact.size)) || Number(artifact.size) <= 0) return false;
  return true;
}

function validForgeVersionJson(value = null, versionId = '', plan = {}) {
  if (!isPlainObject(value)) return false;
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
  if (!String(value.mainClass || '').trim()) return false;
  if ('arguments' in value && !isPlainObject(value.arguments)) return false;
  if (!libraries.every((library) => forgeLibraryLauncherCompatible(library, plan))) return false;
  return libraries.length > 0
    && libraries.some((item) => String(item?.name || '').startsWith('net.minecraftforge:forge:'));
}

function forgeLibraryArtifacts(versionJson = null) {
  const libraries = Array.isArray(versionJson?.libraries) ? versionJson.libraries : [];
  return libraries
    .map((item) => ({
      name: String(item?.name || '').trim(),
      path: String(item?.downloads?.artifact?.path || '').trim(),
      sha1: String(item?.downloads?.artifact?.sha1 || '').trim().toLowerCase(),
      size: Number(item?.downloads?.artifact?.size)
    }))
    .filter((item) => item.name && item.path);
}

const forgeLibraryValidationCache = new Map();

async function missingForgeLibraryArtifacts(versionJson = null, plan = {}) {
  const invalid = [];
  for (const item of forgeLibraryArtifacts(versionJson)) {
    const file = safeJoin(path.join(plan.rootDir || '', 'libraries'), item.path.replaceAll('\\', '/'));
    let stat = null;
    try {
      stat = await fs.stat(file);
    } catch {
      invalid.push({ ...item, file, reason: 'missing' });
      continue;
    }
    if (!stat.isFile()) {
      invalid.push({ ...item, file, reason: 'not a file' });
      continue;
    }
    if (Number.isFinite(item.size) && item.size >= 0 && stat.size !== item.size) {
      invalid.push({ ...item, file, actualSize: stat.size, reason: `size mismatch (${stat.size} != ${item.size})` });
      continue;
    }
    if (/^[a-f0-9]{40}$/.test(item.sha1)) {
      const resolvedFile = path.resolve(file);
      const cacheKey = process.platform === 'win32' ? resolvedFile.toLowerCase() : resolvedFile;
      const cached = forgeLibraryValidationCache.get(cacheKey);
      let actualSha1 = cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs
        ? cached.sha1
        : '';
      if (!actualSha1) {
        try {
          actualSha1 = await hashFile(file, 'sha1');
          forgeLibraryValidationCache.set(cacheKey, { size: stat.size, mtimeMs: stat.mtimeMs, sha1: actualSha1 });
        } catch (error) {
          invalid.push({ ...item, file, reason: `unreadable (${error.message || error})` });
          continue;
        }
      }
      if (actualSha1.toLowerCase() !== item.sha1) {
        invalid.push({ ...item, file, actualSha1, reason: 'SHA-1 mismatch' });
      }
    }
  }
  return invalid;
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
  const sanitized = sanitizeForgeLauncherMetadata(parsed);
  const repairedMetadata = JSON.stringify(sanitized) !== JSON.stringify(parsed);
  if (repairedMetadata && options.repairMetadata !== false && validForgeVersionJson(sanitized, versionId, plan)) {
    // Any code path that elects to rewrite launcher metadata must preserve the
    // original, even when the caller suppresses backups for read-only invalid
    // inspections. Status-only callers disable repairMetadata below.
    await backupInvalidForgeVersionJson(jsonPath);
    try {
      await writeJsonFile(jsonPath, sanitized);
      parsed = sanitized;
      options.logger?.log?.(`Repaired Mojang-incompatible null fields in Forge launcher metadata ${jsonPath}.`);
    } catch (error) {
      return {
        installed: false,
        invalid: true,
        versionId,
        versionJson: jsonPath,
        reason: `could not repair incompatible Forge launcher metadata (${error.message || error})`
      };
    }
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
        reason: `${missingLibraries.length} Forge library file${missingLibraries.length === 1 ? '' : 's'} failed integrity validation`,
        missingLibraries
      };
    }
  }
  return { installed: true, invalid: false, versionId, versionJson: jsonPath, repairedMetadata };
}

export async function findInstalledForgeVersion(plan = {}, options = {}) {
  const versionsDir = path.join(plan.rootDir || '', 'versions');
  const candidates = forgeVersionCandidates(plan);
  const invalidVersions = [];
  const inspectedVersionIds = new Set();
  for (const candidate of candidates) {
    inspectedVersionIds.add(candidate.toLowerCase());
    const jsonPath = path.join(versionsDir, candidate, `${candidate}.json`);
    const inspected = await inspectForgeVersionJson(jsonPath, candidate, plan, options);
    if (inspected.installed) {
      return { ...inspected, invalidVersions };
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
    if (inspectedVersionIds.has(entry.name.toLowerCase())) continue;
    const score = forgeVersionScore(entry.name, plan);
    if (score >= 100) continue;
    const jsonPath = path.join(versionsDir, entry.name, `${entry.name}.json`);
    const inspected = await inspectForgeVersionJson(jsonPath, entry.name, plan, options);
    if (inspected.installed) {
      matches.push({ score, ...inspected });
    } else if (inspected.invalid) {
      invalidVersions.push(inspected);
    }
  }
  matches.sort((left, right) => left.score - right.score || left.versionId.localeCompare(right.versionId));
  const best = matches[0];
  return best
    ? { ...best, invalidVersions }
    : { installed: false, versionId: plan.versionId || '', versionJson: '', invalidVersions };
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

const WINDOWS_JAVA8_RUNTIME_ASSETS_URL = 'https://api.adoptium.net/v3/assets/feature_releases/8/ga?architecture=x64&heap_size=normal&image_type=jre&jvm_impl=hotspot&os=windows&page=0&page_size=1&project=jdk&sort_method=DEFAULT&sort_order=DESC&vendor=eclipse';
const DEFAULT_FORGE_VERSION_WAIT_MS = 5 * 60_000;
const JAVA_PROBE_TIMEOUT_MS = 15_000;
const JAVA_DETECTION_CACHE_MS = 30_000;
const javaProbeCache = new Map();
const javaDetectionCache = new Map();

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

function javaVersionFromOutput(output = '') {
  const text = String(output || '');
  return text.match(/^\s*java\.version\s*=\s*(.+)$/mi)?.[1]?.trim()
    || text.match(/(?:openjdk|java) version "([^"]+)"/i)?.[1]?.trim()
    || '';
}

function javaVendorFromOutput(output = '') {
  return String(output || '').match(/^\s*java\.vendor\s*=\s*(.+)$/mi)?.[1]?.trim() || '';
}

function javaArchFromOutput(output = '') {
  const text = String(output || '');
  return text.match(/^\s*os\.arch\s*=\s*(.+)$/mi)?.[1]?.trim()
    || (/64-Bit/i.test(text) ? '64-bit' : (/32-Bit|x86 Client VM/i.test(text) ? 'x86' : ''));
}

function is64BitJavaArch(arch = '') {
  return /(?:amd64|x86_64|aarch64|arm64|ppc64|sparcv9|s390x|64-bit)/i.test(String(arch || ''));
}

function normalizeJavaRuntimeProbe(javaPath, raw = {}, options = {}) {
  const output = String(raw.output || '');
  const version = String(raw.version || javaVersionFromOutput(output) || '').trim();
  const major = Number(raw.major || javaMajorFromVersion(version) || 0);
  const arch = String(raw.arch || javaArchFromOutput(output) || '').trim();
  const is64Bit = raw.is64Bit === undefined ? is64BitJavaArch(arch) : Boolean(raw.is64Bit);
  const requires64Bit = options.require64Bit !== false;
  const found = raw.found !== false;
  const executable = String(raw.javaPath || javaPath || '').trim();
  const usable = found && major === 8 && (!requires64Bit || is64Bit) && raw.ok !== false;
  let reason = String(raw.reason || '').trim();
  if (!reason && !found) reason = 'Java executable was not found.';
  if (!reason && major && major !== 8) reason = `Java ${major} was found, but Forge 1.12.2 requires Java 8.`;
  if (!reason && major === 8 && requires64Bit && !is64Bit) reason = 'Java 8 is 32-bit; A Hard Time requires a 64-bit Java 8 runtime.';
  if (!reason && !major) reason = 'The Java executable did not report a readable version.';
  return {
    found,
    usable,
    javaPath: executable,
    version,
    major,
    arch,
    is64Bit,
    vendor: String(raw.vendor || javaVendorFromOutput(output) || '').trim(),
    managed: Boolean(raw.managed),
    reason,
    output
  };
}

function runJavaProbeProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const output = [];
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const collect = (chunk) => output.push(String(chunk));
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(reject, new Error(`Java runtime probe timed out after ${options.timeoutMs || JAVA_PROBE_TIMEOUT_MS} ms.`));
    }, options.timeoutMs || JAVA_PROBE_TIMEOUT_MS);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      const text = output.join('');
      if (code === 0) {
        finish(resolve, { code, output: text });
      } else {
        const tail = text.trim().split(/\r?\n/).slice(-8).join('\n');
        finish(reject, new Error(`Java exited with code ${code}${tail ? `:\n${tail}` : ''}`));
      }
    });
  });
}

export async function inspectJavaRuntime(file = '', options = {}) {
  const configured = String(file || '').trim();
  const executable = await forgeInstallerJavaExecutable(configured);
  if (!executable) {
    return normalizeJavaRuntimeProbe('', { found: false }, options);
  }
  if (typeof options.javaRuntimeProbe === 'function') {
    try {
      return normalizeJavaRuntimeProbe(executable, await options.javaRuntimeProbe(executable), options);
    } catch (error) {
      return normalizeJavaRuntimeProbe(executable, { found: false, reason: error.message || String(error) }, options);
    }
  }
  if (process.env.AHT_TEST_HOOKS === '1' && process.env.AHT_TEST_JAVA_RUNTIME_PROBE === 'release-file') {
    const major = await javaMajorFromReleaseFile(executable);
    return normalizeJavaRuntimeProbe(executable, {
      found: Boolean(major),
      major,
      version: major === 8 ? '1.8.0-test' : '',
      vendor: 'AHT test runtime',
      arch: process.env.AHT_TEST_JAVA_ARCH || 'amd64',
      managed: String(executable).toLowerCase().includes('.aht-launcher')
    }, options);
  }
  let cacheKey = executable;
  if (looksPathLike(executable)) {
    try {
      const stat = await fs.stat(executable);
      cacheKey = `${path.resolve(executable)}|${stat.size}|${stat.mtimeMs}|require64=${options.require64Bit !== false}`;
    } catch {
      return normalizeJavaRuntimeProbe(executable, { found: false }, options);
    }
  }
  if (options.refresh !== true && javaProbeCache.has(cacheKey)) {
    return javaProbeCache.get(cacheKey);
  }
  let inspected;
  try {
    const result = await runJavaProbeProcess(executable, ['-XshowSettings:properties', '-version'], options);
    inspected = normalizeJavaRuntimeProbe(executable, {
      found: true,
      ok: true,
      output: result.output,
      managed: String(executable).toLowerCase().includes('.aht-launcher')
    }, options);
  } catch (error) {
    inspected = normalizeJavaRuntimeProbe(executable, {
      found: false,
      reason: error.message || String(error)
    }, options);
  }
  javaProbeCache.set(cacheKey, inspected);
  return inspected;
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
  const cause = String(error?.message || error || '').replace(/\s+/g, ' ').trim().slice(0, 320);
  return `AHT could not download or validate its managed Java 8 runtime.${cause ? ` Cause: ${cause}` : ''} ${javaSetupHelpMessage(platform)}`;
}

function defaultJavaCacheDir(plan = {}, options = {}) {
  return options.javaCacheDir || path.join(plan.rootDir || '.', '.aht-launcher', 'java');
}

async function managedJava8Package(options = {}) {
  const testHooksEnabled = process.env.AHT_TEST_HOOKS === '1';
  const environmentUrl = testHooksEnabled ? process.env.AHT_JAVA8_DOWNLOAD_URL : '';
  const explicitUrl = String(options.javaDownloadUrl || environmentUrl || '').trim();
  if (explicitUrl) {
    const sha256 = String(options.javaDownloadSha256 || (testHooksEnabled ? process.env.AHT_JAVA8_DOWNLOAD_SHA256 : '') || '').trim().toLowerCase();
    const size = Number(options.javaDownloadSize || (testHooksEnabled ? process.env.AHT_JAVA8_DOWNLOAD_SIZE : '') || 0);
    if (!testHooksEnabled && (!/^https:\/\//i.test(explicitUrl) || !/^[a-f0-9]{64}$/.test(sha256))) {
      throw new Error('A custom Java 8 package requires an HTTPS URL and an expected SHA-256 checksum.');
    }
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('The expected Java 8 package SHA-256 checksum is invalid.');
    }
    return {
      url: explicitUrl,
      sha256,
      size
    };
  }
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform !== 'win32' || arch !== 'x64') return null;
  const assets = await (options.fetchJsonImpl || fetchJson)(WINDOWS_JAVA8_RUNTIME_ASSETS_URL);
  const binary = Array.isArray(assets)
    ? assets.flatMap((release) => Array.isArray(release?.binaries) ? release.binaries : [])
      .find((item) => item?.architecture === 'x64' && item?.image_type === 'jre' && item?.jvm_impl === 'hotspot' && item?.os === 'windows')
    : null;
  const packageInfo = binary?.package;
  const url = String(packageInfo?.link || '').trim();
  const sha256 = String(packageInfo?.checksum || '').trim().toLowerCase();
  const size = Number(packageInfo?.size);
  if (!/^https:\/\//i.test(url) || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isFinite(size) || size <= 0) {
    throw new Error('Adoptium returned incomplete Java 8 package metadata.');
  }
  return { url, sha256, size };
}

async function extractJavaArchive(archivePath, cacheDir) {
  const zip = new AdmZip(archivePath);
  zip.extractAllTo(cacheDir, true);
}

async function ensureManagedJava8Runtime(plan = {}, options = {}) {
  const cacheDir = defaultJavaCacheDir(plan, options);
  if (!options.forceDownloadJava) {
    const existing = await detectJava8Runtime({}, {
      ...options,
      javaPath: '',
      javaRoots: [cacheDir],
      javaInstallRoots: [],
      includeDefaultJavaRoots: false,
      includeEnvironmentJava: false,
      includePathJava: false,
      refresh: true
    });
    if (existing.usable) return existing.javaPath;
  }
  let downloadPackage = null;
  try {
    downloadPackage = await managedJava8Package(options);
  } catch (error) {
    throw new Error(managedJavaDownloadFailureMessage(error));
  }
  if (!downloadPackage?.url) return '';
  await ensureDir(cacheDir);
  const stagingRoot = path.join(cacheDir, `.adoptium-install-${process.pid}-${Date.now()}`);
  const archivePath = path.join(stagingRoot, 'temurin-jre8.zip');
  const extractedRoot = path.join(stagingRoot, 'runtime');
  const installedRoot = path.join(cacheDir, 'adoptium-jre8-current');
  let previousRoot = '';
  let promoted = false;
  try {
    await ensureDir(extractedRoot);
    options.logger?.log?.('Downloading AHT-managed Adoptium Java 8 (64-bit)...');
    await downloadToFile(downloadPackage.url, archivePath);
    const archiveStat = await fs.stat(archivePath);
    if (Number.isFinite(downloadPackage.size) && downloadPackage.size > 0 && archiveStat.size !== downloadPackage.size) {
      throw new Error(`Adoptium Java archive size mismatch (${archiveStat.size} != ${downloadPackage.size}).`);
    }
    if (downloadPackage.sha256) {
      if (!/^[a-f0-9]{64}$/.test(downloadPackage.sha256)) {
        throw new Error('Adoptium Java archive SHA-256 metadata is invalid.');
      }
      const actualSha256 = await hashFile(archivePath, 'sha256');
      if (actualSha256.toLowerCase() !== downloadPackage.sha256) {
        throw new Error(`Adoptium Java archive SHA-256 mismatch (${actualSha256}).`);
      }
    }
    options.logger?.log?.('Extracting and validating Adoptium Java 8...');
    await extractJavaArchive(archivePath, extractedRoot);
    const staged = await detectJava8Runtime({}, {
      ...options,
      javaPath: '',
      javaRoots: [extractedRoot],
      javaInstallRoots: [],
      includeDefaultJavaRoots: false,
      includeEnvironmentJava: false,
      includePathJava: false,
      refresh: true
    });
    if (!staged.usable) {
      throw new Error(staged.reason || 'Downloaded Java 8 failed its executable and architecture probe.');
    }
    if (await pathExists(installedRoot)) {
      previousRoot = path.join(cacheDir, `adoptium-jre8-previous-${Date.now()}`);
      await fs.rename(installedRoot, previousRoot);
    }
    await fs.rename(extractedRoot, installedRoot);
    promoted = true;
    clearJavaRuntimeDetectionCache();
    const installedJava = path.join(installedRoot, path.relative(extractedRoot, staged.javaPath));
    const verified = await inspectJavaRuntime(installedJava, { ...options, refresh: true });
    if (!verified.usable) {
      throw new Error(verified.reason || 'Installed Adoptium Java 8 failed its final executable probe.');
    }
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    if (previousRoot) {
      await fs.rm(previousRoot, { recursive: true, force: true }).catch(() => {});
    }
    return verified.javaPath;
  } catch (error) {
    if (promoted) {
      await fs.rm(installedRoot, { recursive: true, force: true }).catch(() => {});
      if (previousRoot) {
        await fs.rename(previousRoot, installedRoot).catch(() => {});
      }
      clearJavaRuntimeDetectionCache();
    } else if (!promoted && previousRoot && !(await pathExists(installedRoot))) {
      await fs.rename(previousRoot, installedRoot).catch(() => {});
      clearJavaRuntimeDetectionCache();
    }
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw new Error(managedJavaDownloadFailureMessage(error));
  }
}

async function resolveForgeInstallerJavaPath(profile = {}, plan = {}, options = {}) {
  if (options.forceManagedJava8) {
    const forced = await ensureManagedJava8Runtime(plan, { ...options, forceDownloadJava: true });
    if (forced) return forced;
  }
  const detected = await detectJava8Runtime(profile, { ...options, refresh: true });
  if (detected.usable) {
    return detected.javaPath;
  }
  if (options.allowManagedJavaDownload !== false) {
    const managed = await ensureManagedJava8Runtime(plan, options);
    if (managed) return managed;
  }
  throw new Error(`Forge 1.12.2 requires Java 8. ${javaSetupHelpMessage(options.platform || process.platform)}`);
}

export async function resolveMinecraftProfileJavaPath(profile = {}, plan = {}, options = {}) {
  if (options.forceManagedJava8) {
    const forced = await ensureManagedJava8Runtime(plan, { ...options, forceDownloadJava: true });
    if (forced) return forced;
  }
  const detected = await detectJava8Runtime(profile, { ...options, refresh: true });
  if (detected.usable) {
    return detected.javaPath;
  }
  if (options.allowManagedJavaDownload !== false) {
    const managed = await ensureManagedJava8Runtime(plan, options);
    const inspected = managed ? await inspectJavaRuntime(managed, { ...options, refresh: true }) : null;
    if (inspected?.usable) {
      return inspected.javaPath;
    }
  }
  throw new Error(`${detected.reason || 'Minecraft Forge 1.12.2 requires a usable 64-bit Java 8 runtime.'} ${javaSetupHelpMessage(options.platform || process.platform)}`);
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
  const includeDefaultRoots = options.includeDefaultJavaRoots !== false;
  for (const root of options.javaRoots || []) {
    pushJavaRoot(roots, root);
  }
  pushJavaRoot(roots, rootDir ? path.join(rootDir, '.aht-launcher', 'java') : '');
  pushJavaRoot(roots, rootDir ? path.join(rootDir, 'java') : '');
  for (const root of options.javaInstallRoots || (includeDefaultRoots ? windowsJavaInstallRoots() : [])) {
    pushJavaRoot(roots, root);
  }
  pushJavaRoot(roots, rootDir ? path.join(rootDir, 'runtime') : '');
  if (includeDefaultRoots && process.platform === 'win32' && rootDir) {
    pushJavaRoot(roots, path.resolve(rootDir, '..', '..', 'Local', 'runtime'));
  }
  if (includeDefaultRoots && process.platform === 'win32' && process.env.LOCALAPPDATA) {
    pushJavaRoot(roots, path.join(
      process.env.LOCALAPPDATA,
      'Packages',
      'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
      'LocalCache',
      'Local',
      'runtime'
    ));
  }
  if (includeDefaultRoots && process.env.APPDATA) {
    pushJavaRoot(roots, path.join(process.env.APPDATA, '.minecraft', 'runtime'));
  }
  return roots;
}

async function forgeInstallerJavaExecutable(file = '') {
  const configured = String(file || '').trim();
  if (process.platform === 'win32' && path.basename(configured).toLowerCase() === 'javaw.exe') {
    const javaPath = path.join(path.dirname(configured), 'java.exe');
    if (await pathExists(javaPath)) {
      return javaPath;
    }
  }
  return configured;
}

function rankJavaCandidate(file = '') {
  const normalized = String(file || '').toLowerCase();
  if (normalized.includes('.aht-launcher') && isJava8Path(normalized)) return 0;
  if (/(temurin|adoptium|eclipse adoptium|zulu|bellsoft|microsoft)/i.test(normalized) && isJava8Path(normalized)) return 1;
  if (isJava8Path(normalized) && !isLegacyJavaPath(normalized)) return 2;
  if (normalized.includes('jre-legacy') || normalized.includes('java-runtime-legacy')) return 20;
  if (normalized.includes('java-runtime-gamma')) return 4;
  if (normalized.includes('java-runtime-beta')) return 5;
  if (normalized.includes('java-runtime-delta')) return 6;
  if (normalized.includes('java-runtime-epsilon')) return 7;
  if (normalized.includes('jre_21') || normalized.includes('java-runtime-alpha')) return 9;
  return 8;
}

async function findJavaCandidatesInRoot(root, maxDepth = 6) {
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
  return matches;
}

async function findJavaInRoot(root, maxDepth = 6, options = {}) {
  const matches = await findJavaCandidatesInRoot(root, maxDepth);
  if (options.requireJava8) {
    for (const match of matches) {
      if (await isJava8Candidate(match)) return match;
    }
    return '';
  }
  return matches[0] || '';
}

function pathJavaCandidates(env = process.env) {
  const executable = javaExecutableName();
  return uniqueValues(String(env.PATH || '').split(path.delimiter).map((dir) => (
    String(dir || '').trim() ? path.join(String(dir).trim(), executable) : ''
  )));
}

async function collectJavaCandidates(profile = {}, options = {}) {
  const candidates = [];
  const push = async (candidate = '') => {
    const executable = await forgeInstallerJavaExecutable(String(candidate || '').trim());
    if (!executable) return;
    const key = process.platform === 'win32' ? executable.toLowerCase() : executable;
    if (!candidates.some((item) => (process.platform === 'win32' ? item.toLowerCase() : item) === key)) {
      candidates.push(executable);
    }
  };
  const configured = String(options.javaPath || '').trim();
  if (configured && configured !== 'java') await push(configured);
  if (options.includeEnvironmentJava !== false) {
    for (const envName of ['AHT_JAVA_HOME', 'JAVA8_HOME', 'JDK8_HOME', 'JRE8_HOME', 'JDK_HOME', 'JAVA_HOME', 'JRE_HOME']) {
      const envPath = String(process.env[envName] || '').trim();
      if (envPath) await push(path.join(envPath, 'bin', javaExecutableName()));
    }
  }
  for (const root of javaSearchRoots(profile, options)) {
    for (const candidate of await findJavaCandidatesInRoot(root, 6)) {
      await push(candidate);
    }
  }
  if (options.includePathJava !== false) {
    for (const candidate of pathJavaCandidates(options.env || process.env)) {
      if (await pathExists(candidate)) await push(candidate);
    }
  }
  const configuredExecutable = configured && configured !== 'java'
    ? await forgeInstallerJavaExecutable(configured)
    : '';
  const configuredKey = process.platform === 'win32'
    ? configuredExecutable.toLowerCase()
    : configuredExecutable;
  candidates.sort((left, right) => {
    const leftKey = process.platform === 'win32' ? left.toLowerCase() : left;
    const rightKey = process.platform === 'win32' ? right.toLowerCase() : right;
    const leftLegacy = isLegacyJavaPath(left);
    const rightLegacy = isLegacyJavaPath(right);
    const leftExplicit = Boolean(configuredKey && leftKey === configuredKey);
    const rightExplicit = Boolean(configuredKey && rightKey === configuredKey);
    if (leftExplicit !== rightExplicit && !leftLegacy && !rightLegacy) return leftExplicit ? -1 : 1;
    if (leftLegacy !== rightLegacy) return leftLegacy ? 1 : -1;
    if (leftExplicit !== rightExplicit) return leftExplicit ? -1 : 1;
    return rankJavaCandidate(left) - rankJavaCandidate(right) || left.localeCompare(right);
  });
  return candidates;
}

function javaDetectionCacheKey(profile = {}, options = {}) {
  return JSON.stringify({
    rootDir: profile?.rootDir || '',
    javaPath: options.javaPath || '',
    javaRoots: options.javaRoots || [],
    javaInstallRoots: options.javaInstallRoots || [],
    includeDefaultJavaRoots: options.includeDefaultJavaRoots !== false,
    includeEnvironmentJava: options.includeEnvironmentJava !== false,
    includePathJava: options.includePathJava !== false,
    platform: options.platform || process.platform,
    arch: options.arch || process.arch,
    require64Bit: options.require64Bit !== false
  });
}

export function clearJavaRuntimeDetectionCache() {
  javaDetectionCache.clear();
  javaProbeCache.clear();
}

export async function detectJava8Runtime(profile = {}, options = {}) {
  const cacheKey = javaDetectionCacheKey(profile, options);
  const cached = javaDetectionCache.get(cacheKey);
  if (
    options.refresh !== true
    && typeof options.javaRuntimeProbe !== 'function'
    && cached
    && (Date.now() - cached.at) < JAVA_DETECTION_CACHE_MS
  ) {
    return cached.value;
  }
  const candidates = await collectJavaCandidates(profile, options);
  const rejected = [];
  for (const candidate of candidates) {
    const inspected = await inspectJavaRuntime(candidate, options);
    if (inspected.usable) {
      const value = {
        ...inspected,
        available: true,
        candidateCount: candidates.length,
        rejected
      };
      javaDetectionCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
    if (inspected.major === 8 || await isJava8Candidate(candidate)) {
      rejected.push({
        javaPath: inspected.javaPath || candidate,
        version: inspected.version || '',
        arch: inspected.arch || '',
        reason: inspected.reason || 'Java 8 runtime is unusable.'
      });
    }
  }
  const value = {
    available: false,
    usable: false,
    javaPath: '',
    version: '',
    major: 0,
    arch: '',
    is64Bit: false,
    vendor: '',
    managed: false,
    candidateCount: candidates.length,
    rejected,
    reason: rejected[0]?.reason || 'No usable 64-bit Java 8 runtime was detected.'
  };
  javaDetectionCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export async function resolveJavaPath(profile = {}, options = {}) {
  const configured = String(options.javaPath || '').trim();
  const explicitCandidates = [];
  if (configured && configured !== 'java') {
    explicitCandidates.push(configured);
  }
  for (const candidate of explicitCandidates) {
    const executable = await forgeInstallerJavaExecutable(candidate);
    if (looksPathLike(executable) && await pathExists(executable)) {
      return executable;
    }
  }
  const envCandidates = [];
  if (options.includeEnvironmentJava !== false) {
    for (const envName of ['AHT_JAVA_HOME', 'JAVA8_HOME', 'JDK8_HOME', 'JRE8_HOME', 'JDK_HOME', 'JAVA_HOME', 'JRE_HOME']) {
      const envPath = String(process.env[envName] || '').trim();
      if (envPath) {
        envCandidates.push(path.join(envPath, 'bin', javaExecutableName()));
      }
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

export async function minecraftJavaExecutable(javaPath = '') {
  const configured = String(javaPath || '').trim();
  if (!configured || configured === 'java' || !path.isAbsolute(configured)) {
    return '';
  }
  if (process.platform === 'win32' && path.basename(configured).toLowerCase() === 'java.exe') {
    const javawPath = path.join(path.dirname(configured), 'javaw.exe');
    if (await pathExists(javawPath)) {
      return path.resolve(javawPath);
    }
  }
  return path.resolve(configured);
}

export async function preflightJava8Runtime(javaPath = '', memoryMb = 4096, options = {}) {
  const executable = await forgeInstallerJavaExecutable(javaPath);
  const inspected = await inspectJavaRuntime(executable, { ...options, refresh: true });
  if (!inspected.usable) {
    throw new Error(inspected.reason || 'The selected Java runtime is not a usable 64-bit Java 8 executable.');
  }
  const heapMb = Math.max(1024, Math.floor(Number(memoryMb) || 4096));
  if (typeof options.javaHeapProbe === 'function') {
    await options.javaHeapProbe(executable, heapMb, inspected);
    return { ...inspected, heapMb, heapReady: true };
  }
  if (process.env.AHT_TEST_HOOKS === '1' && process.env.AHT_TEST_JAVA_RUNTIME_PROBE === 'release-file') {
    return { ...inspected, heapMb, heapReady: true };
  }
  try {
    await runJavaProbeProcess(executable, ['-Xms512m', `-Xmx${heapMb}m`, '-version'], options);
  } catch (error) {
    throw new Error(`Java 8 was found, but it could not start with the configured ${Math.round(heapMb / 1024 * 10) / 10} GB heap. Lower Allocated RAM or install 64-bit Adoptium Java 8. ${error.message || error}`);
  }
  return { ...inspected, heapMb, heapReady: true };
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

function forgeLibraryFixtureBytes(name = '') {
  return Buffer.from(`aht test forge library ${name}\n`, 'utf8');
}

function forgeVersionJsonForPlan(plan = {}, versionId = plan.versionId || '') {
  const forgeVersion = forgeLoaderVersion(plan.loaderId);
  const forgeName = `net.minecraftforge:forge:${plan.minecraftVersion}-${forgeVersion}`;
  const artifactPath = `net/minecraftforge/forge/${plan.minecraftVersion}-${forgeVersion}/forge-${plan.minecraftVersion}-${forgeVersion}.jar`;
  const artifactBytes = forgeLibraryFixtureBytes(forgeName);
  return {
    id: versionId,
    type: 'release',
    inheritsFrom: plan.minecraftVersion,
    mainClass: 'net.minecraft.launchwrapper.Launch',
    minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker --versionType Forge',
    libraries: [
      {
        name: forgeName,
        downloads: {
          artifact: {
            path: artifactPath,
            url: `https://example.test/forge-libraries/${artifactPath}`,
            sha1: crypto.createHash('sha1').update(artifactBytes).digest('hex'),
            size: artifactBytes.length
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
    await fs.writeFile(file, forgeLibraryFixtureBytes(item.name));
  }
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
export async function installForgeLoader(profile, options = {}) {
  const plan = buildForgeInstallPlan(profile, options);
  if (profile.versionJson) {
    const existing = await inspectForgeVersionJson(profile.versionJson, profile.versionId, plan, {
      backupInvalid: true,
      verifyLibraries: Boolean(options.verifyLibraries),
      logger: options.logger
    });
    if (existing.installed) {
      plan.javaPath = await resolveMinecraftProfileJavaPath(profile, plan, options);
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
    plan.javaPath = await resolveMinecraftProfileJavaPath(profile, plan, options);
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
  const installed = await waitForInstalledForgeVersion(plan, options.versionWaitMs ?? DEFAULT_FORGE_VERSION_WAIT_MS, {
    backupInvalid: true,
    verifyLibraries: Boolean(options.verifyLibraries),
    logger: options.logger
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
