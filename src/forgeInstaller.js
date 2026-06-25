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

function javaExecutableName() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function isLegacyJavaPath(file = '') {
  const normalized = String(file || '').toLowerCase();
  return normalized.includes('jre-legacy') || normalized.includes('java-runtime-legacy');
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
  options.logger?.log?.('Downloading current Java 8 runtime for Forge installer HTTPS support...');
  await downloadToFile(downloadUrl, archivePath);
  options.logger?.log?.('Extracting Java 8 runtime...');
  await extractJavaArchive(archivePath, cacheDir);
  const javaPath = await findJavaInRoot(cacheDir, 8);
  if (!javaPath) {
    throw new Error(`Downloaded Java runtime, but ${javaExecutableName()} was not found in ${cacheDir}.`);
  }
  return javaPath;
}

async function resolveForgeInstallerJavaPath(profile = {}, plan = {}, options = {}) {
  const resolved = await resolveJavaPath(profile, options);
  if (isLegacyJavaPath(resolved)) {
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
  if (text && !roots.includes(text)) {
    roots.push(text);
  }
}

function javaSearchRoots(profile = {}, options = {}) {
  const roots = [];
  const rootDir = profile?.rootDir || '';
  for (const root of options.javaRoots || []) {
    pushJavaRoot(roots, root);
  }
  pushJavaRoot(roots, rootDir ? path.join(rootDir, 'runtime') : '');
  pushJavaRoot(roots, rootDir ? path.join(rootDir, 'java') : '');
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
  if (normalized.includes('jre-legacy') || normalized.includes('java-runtime-legacy')) return 0;
  if (normalized.includes('java-runtime-gamma')) return 2;
  if (normalized.includes('java-runtime-beta')) return 3;
  if (normalized.includes('java-runtime-delta')) return 4;
  if (normalized.includes('java-runtime-epsilon')) return 5;
  if (normalized.includes('jre_21') || normalized.includes('java-runtime-alpha')) return 8;
  return 6;
}

async function findJavaInRoot(root, maxDepth = 6) {
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
  return matches[0] || '';
}

export async function resolveJavaPath(profile = {}, options = {}) {
  const configured = String(options.javaPath || '').trim();
  const candidates = [];
  if (configured && configured !== 'java') {
    candidates.push(configured);
  }
  for (const envName of ['JAVA_HOME', 'JRE_HOME']) {
    const envPath = String(process.env[envName] || '').trim();
    if (envPath) {
      candidates.push(path.join(envPath, 'bin', javaExecutableName()));
    }
  }
  for (const candidate of candidates) {
    if (looksPathLike(candidate) && await pathExists(candidate)) {
      return candidate;
    }
  }
  for (const root of javaSearchRoots(profile, options)) {
    const javaPath = await findJavaInRoot(root);
    if (javaPath) {
      return javaPath;
    }
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
      if (error?.code === 'ENOENT') {
        reject(new Error(`Java runtime was not found (${command}). Open Minecraft Launcher once so it can download its runtime, or install Java and try Update again.`));
      } else {
        reject(error);
      }
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
      throw error;
    }
    options.logger?.log?.('Forge installer Java failed HTTPS certificate validation. Retrying with current Java 8 runtime...');
    const managedJava = await ensureManagedJava8Runtime(plan, { ...options, forceDownloadJava: true });
    result = await runForgeInstallerProcess(plan, options, managedJava);
  }
  const installed = await waitForInstalledForgeVersion(plan, options.versionWaitMs || 15000);
  if (!installed.installed) {
    const tail = outputTail(result.output);
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
