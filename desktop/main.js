import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { buildRelease } from '../src/releaseBuilder.js';
import { installPack } from '../src/installer.js';
import { scanLocalChanges, scanManagedIntegrity } from '../src/localChanges.js';
import {
  defaultMinecraftRoot,
  ensureMinecraftLauncherProfile,
  inspectMinecraftLauncherAuth,
  inspectMinecraftLauncherProfile,
  minecraftRootCandidates
} from '../src/minecraftLauncherProfile.js';
import { installForgeLoader } from '../src/forgeInstaller.js';
import { sendLauncherEvent } from '../src/syncClient.js';
import { collectServerTransferFiles, DEFAULT_INCLUDED_DIRS, uploadServerFiles } from '../src/serverTransfer.js';
import { defaultInstanceDirForPlatform, platformProfile } from '../src/platformProfile.js';
import { writeLauncherProof } from '../src/launcherProof.js';
import {
  cleanGithubRepo,
  cleanRef,
  cleanWorkflowId,
  findRecentWorkflowRun,
  launcherWorkflowDefaults,
  readGithubPackageVersion,
  triggerLauncherReleaseWorkflow
} from '../src/githubActions.js';
import {
  cleanR2AccountId,
  directR2CredentialsReady,
  headR2ObjectDirect,
  missingDirectR2CredentialLabels,
  uploadR2ObjectDirect
} from '../src/r2DirectUpload.js';
import {
  ensureDir,
  downloadToFile,
  hashFile,
  isFileUrl,
  isHttpUrl,
  normalizeRelPath,
  pathExists,
  readJsonFile,
  readJsonFromSource,
  resolveSource,
  safeJoin,
  writeJsonFile
} from '../src/utils.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let mainWindow = null;
let updateState = { running: false, lines: [], lastResult: null, error: null, progress: null };
let launcherUpdateState = { running: false, lines: [], lastResult: null, error: null, progress: null };
let serverTransferState = { running: false, lines: [], lastResult: null, error: null, progress: null };
let uploadState = { running: false, total: 0, completed: 0, current: '', lines: [], lastResult: null, error: null, verification: null };
let adminToken = '';
let developerSession = null;
let keepOpenUntil = 0;

const DEFAULT_DEVELOPER_USERNAME = 'admin';
const DEVELOPER_SESSION_MS = 12 * 60 * 60 * 1000;
let launcherModeCache = null;

function rawRequestedDeveloperMode() {
  return process.argv.includes('--developer') || process.env.AHT_DEVELOPER === '1';
}

const launchMode = rawRequestedDeveloperMode() ? 'developer' : 'player';

if (launchMode === 'developer') {
  app.setName('AHT Developer Launcher');
  app.setPath('userData', path.join(app.getPath('appData'), 'aht-launcher-developer'));
}

if (process.platform === 'win32') {
  app.setAppUserModelId(launchMode === 'developer' ? 'com.ahardtime.launcher.developer' : 'com.ahardtime.launcher');
}

const singleInstanceLock = app.requestSingleInstanceLock({ mode: launchMode });

function launcherBuildMode() {
  if (launcherModeCache !== null) {
    return launcherModeCache;
  }
  const candidates = [
    path.join(appRoot, 'package.json'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'package.json') : ''
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const packageJson = JSON.parse(fsSync.readFileSync(candidate, 'utf8'));
      launcherModeCache = packageJson.ahtLauncherMode || packageJson.extraMetadata?.ahtLauncherMode || '';
      return launcherModeCache;
    } catch {
      // Source runs and packaged apps resolve package metadata differently.
    }
  }
  launcherModeCache = '';
  return launcherModeCache;
}

function developerModeAllowed() {
  return process.env.AHT_ALLOW_DEVELOPER === '1' || launcherBuildMode() !== 'player';
}

function requestedDeveloperMode() {
  return rawRequestedDeveloperMode();
}

function isDeveloperMode() {
  return developerModeAllowed() && requestedDeveloperMode();
}

function isDeveloperAuthenticated() {
  return Boolean(developerSession && developerSession.expiresAt > Date.now());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertDeveloperMode() {
  if (!isDeveloperMode()) {
    throw new Error('Developer tools are only available in developer mode.');
  }
}

function assertDeveloperAuthenticated() {
  assertDeveloperMode();
  if (!isDeveloperAuthenticated()) {
    throw new Error('Developer login is required.');
  }
}

function configPath() {
  return path.join(app.getPath('userData'), 'launcher.config.json');
}

function identityPath() {
  return path.join(app.getPath('userData'), 'identity.json');
}

function developerSecretsPath() {
  return path.join(app.getPath('userData'), 'developer.secrets.json');
}

function legacyDeveloperSecretsPath() {
  return path.join(app.getPath('appData'), 'aht-launcher', 'developer.secrets.json');
}

function developerCredentialsPath() {
  return path.join(app.getPath('userData'), 'developer.credentials.json');
}

async function loadDeveloperCredentials() {
  let localCredentials = {};
  try {
    localCredentials = await readJsonFile(developerCredentialsPath());
  } catch {
    localCredentials = {};
  }
  return {
    username: String(process.env.AHT_DEVELOPER_USERNAME || localCredentials.username || DEFAULT_DEVELOPER_USERNAME).trim(),
    password: String(process.env.AHT_DEVELOPER_PASSWORD || localCredentials.password || '')
  };
}

function developerCredentialsConfigured(credentials) {
  return Boolean(credentials?.username && credentials?.password);
}

function safeStorageAvailable() {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

function encryptDeveloperSecret(value = '') {
  const text = String(value || '');
  if (!text) {
    return { value: '', encrypted: safeStorageAvailable() };
  }
  if (safeStorageAvailable()) {
    return {
      value: safeStorage.encryptString(text).toString('base64'),
      encrypted: true
    };
  }
  return {
    value: Buffer.from(text, 'utf8').toString('base64'),
    encrypted: false
  };
}

function decryptDeveloperSecret(record = {}) {
  const value = String(record.value || '');
  if (!value) return '';
  const buffer = Buffer.from(value, 'base64');
  if (record.encrypted) {
    if (!safeStorageAvailable()) {
      throw new Error('OS secret decryption is not available on this machine.');
    }
    return safeStorage.decryptString(buffer);
  }
  return buffer.toString('utf8');
}

async function readDeveloperSecretsFile() {
  const file = developerSecretsPath();
  let current = { schemaVersion: 1, secrets: {} };
  if (await pathExists(file)) {
    current = await readJsonFile(file);
  }

  if (launchMode !== 'developer') {
    return current;
  }

  const legacyFile = legacyDeveloperSecretsPath();
  if (samePath(file, legacyFile) || !(await pathExists(legacyFile))) {
    return current;
  }

  const legacy = await readJsonFile(legacyFile);
  const merged = mergeDeveloperSecretFiles(current, legacy);
  if (merged.changed) {
    await writeJsonFile(file, merged.file);
  }
  return merged.file;
}

function hasStoredSecret(record = {}) {
  return Boolean(record && typeof record === 'object' && String(record.value || ''));
}

function mergeDeveloperSecretFiles(current = {}, legacy = {}) {
  const merged = {
    schemaVersion: current.schemaVersion || legacy.schemaVersion || 1,
    updatedAt: current.updatedAt || legacy.updatedAt || new Date().toISOString(),
    secrets: {
      ...(legacy.secrets || {}),
      ...(current.secrets || {})
    }
  };
  let changed = false;
  for (const [key, legacyValue] of Object.entries(legacy.secrets || {})) {
    const currentValue = current.secrets?.[key];
    if (!hasStoredSecret(currentValue) && hasStoredSecret(legacyValue)) {
      merged.secrets[key] = legacyValue;
      changed = true;
    }
  }
  return { file: merged, changed };
}

async function loadDeveloperSecrets() {
  assertDeveloperAuthenticated();
  const stored = await readDeveloperSecretsFile();
  const encrypted = safeStorageAvailable();
  const curseforge = stored.secrets?.curseforgeApiKey || {};
  const serverSsh = stored.secrets?.serverSshPassword || {};
  const launcherProof = stored.secrets?.launcherProofSecret || {};
  const github = stored.secrets?.githubToken || {};
  const r2Account = stored.secrets?.r2AccountId || {};
  const r2AccessKey = stored.secrets?.r2AccessKeyId || {};
  const r2SecretKey = stored.secrets?.r2SecretAccessKey || {};
  let curseforgeApiKey = '';
  let serverSshPassword = '';
  let launcherProofSecret = '';
  let githubToken = '';
  let r2AccountId = '';
  let r2AccessKeyId = '';
  let r2SecretAccessKey = '';
  let warning = '';
  try {
    curseforgeApiKey = decryptDeveloperSecret(curseforge);
  } catch (error) {
    warning = error.message;
  }
  try {
    serverSshPassword = decryptDeveloperSecret(serverSsh);
  } catch (error) {
    warning = warning || error.message;
  }
  try {
    launcherProofSecret = decryptDeveloperSecret(launcherProof);
  } catch (error) {
    warning = warning || error.message;
  }
  try {
    githubToken = decryptDeveloperSecret(github);
  } catch (error) {
    warning = warning || error.message;
  }
  try {
    r2AccountId = decryptDeveloperSecret(r2Account);
  } catch (error) {
    warning = warning || error.message;
  }
  try {
    r2AccessKeyId = decryptDeveloperSecret(r2AccessKey);
  } catch (error) {
    warning = warning || error.message;
  }
  try {
    r2SecretAccessKey = decryptDeveloperSecret(r2SecretKey);
  } catch (error) {
    warning = warning || error.message;
  }
  return {
    saved: Boolean(curseforge.value || serverSsh.value || launcherProof.value || github.value || r2Account.value || r2AccessKey.value || r2SecretKey.value),
    encrypted: Boolean(
      (curseforge.value ? curseforge.encrypted : true)
      && (serverSsh.value ? serverSsh.encrypted : true)
      && (launcherProof.value ? launcherProof.encrypted : true)
      && (github.value ? github.encrypted : true)
      && (r2AccessKey.value ? r2AccessKey.encrypted : true)
      && (r2SecretKey.value ? r2SecretKey.encrypted : true)
    ),
    encryptionAvailable: encrypted,
    warning,
    curseforgeApiKey,
    serverSshPassword,
    launcherProofSecret,
    githubToken,
    r2AccountId,
    r2AccessKeyId,
    r2SecretAccessKey
  };
}
function saveDeveloperSecretField(next, secrets, key) {
  if (!Object.prototype.hasOwnProperty.call(secrets, key)) {
    return;
  }
  const value = String(secrets[key] || '');
  if (!value && hasStoredSecret(next.secrets[key])) {
    return;
  }
  if (!value) {
    delete next.secrets[key];
    return;
  }
  next.secrets[key] = encryptDeveloperSecret(value);
}

async function saveDeveloperSecrets(secrets = {}) {
  assertDeveloperAuthenticated();
  const current = await readDeveloperSecretsFile();
  const next = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    secrets: {
      ...(current.secrets || {})
    }
  };
  saveDeveloperSecretField(next, secrets, 'curseforgeApiKey');
  saveDeveloperSecretField(next, secrets, 'serverSshPassword');
  saveDeveloperSecretField(next, secrets, 'launcherProofSecret');
  saveDeveloperSecretField(next, secrets, 'githubToken');
  saveDeveloperSecretField(next, secrets, 'r2AccountId');
  saveDeveloperSecretField(next, secrets, 'r2AccessKeyId');
  saveDeveloperSecretField(next, secrets, 'r2SecretAccessKey');
  await writeJsonFile(developerSecretsPath(), next);
  const usedEncryption = Object.entries(next.secrets).every(([key, item]) => key === 'r2AccountId' || !item?.value || item.encrypted);
  return {
    ok: true,
    saved: Object.values(next.secrets).some((item) => Boolean(item?.value)),
    encrypted: usedEncryption,
    warning: usedEncryption ? '' : 'OS secret encryption is unavailable; developer secret was saved with a plain local fallback.'
  };
}
function ahtInstallRoot() {
  if (process.platform === 'win32') {
    const systemDrive = process.env.SystemDrive || path.parse(app.getPath('home')).root || 'C:';
    return path.join(systemDrive.endsWith(path.sep) ? systemDrive : `${systemDrive}${path.sep}`, 'AHT');
  }
  return path.dirname(defaultInstanceDir());
}

function oldUserDataInstanceDir() {
  return path.join(app.getPath('userData'), 'instances', 'RLCraft Dregora');
}

function defaultCacheModsDir() {
  return path.join(app.getPath('home'), 'curseforge', 'minecraft', 'Instances', 'RLCraft Dregora', 'mods');
}

function isCurseForgeInstanceDir(value = '') {
  const normalized = String(value || '').replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/curseforge/minecraft/instances/');
}

function isOldLauncherInstanceDir(value = '') {
  if (!value) return false;
  const resolved = path.resolve(value);
  const oldRoot = path.resolve(path.join(app.getPath('userData'), 'instances'));
  return samePath(resolved, oldUserDataInstanceDir()) || resolved.toLowerCase().startsWith(`${oldRoot.toLowerCase()}${path.sep}`);
}

function defaultConfig() {
  const instanceDir = defaultInstanceDir();
  return {
    packId: 'a-hard-time-dregora',
    instanceDir,
    latestUrl: '',
    curseforge: {
      proxyBaseUrl: '',
      apiKeyEnv: 'CURSEFORGE_API_KEY'
    },
    sync: {
      enabled: true,
      sendLocalChanges: true,
      baseUrl: '',
      playerLabel: ''
    },
    developer: {
      adminBaseUrl: '',
      defaultOutDir: path.join(app.getPath('documents'), 'aht-release'),
      defaultCacheModsDir: defaultCacheModsDir(),
      r2Bucket: 'ahtlauncher',
      r2AccountId: '',
      githubRepo: launcherWorkflowDefaults.repo,
      githubBranch: launcherWorkflowDefaults.branch,
      githubWorkflow: launcherWorkflowDefaults.workflow
    },
    launcherUpdate: {
      enabled: true,
      latestUrl: ''
    },
    launcherProof: {
      enabled: true,
      required: false,
      baseUrl: '',
      keyId: 'aht-launcher-proof-v1'
    },
    serverTransfer: {
      sourceDir: 'C:\\RL CRAFT SERVER LIST\\New folder - Copy',
      host: '192.168.1.121',
      port: 22,
      username: 'notevil',
      remoteDir: '/home/notevil/Desktop/AHT Server Files',
      excludeDirs: ['DregoraRL'],
      includeDirs: DEFAULT_INCLUDED_DIRS,
      includeRootFiles: true,
      concurrency: 8
    },
    minecraftLauncher: {
      enabled: true,
      rootDir: defaultMinecraftRoot(),
      profileId: 'a-hard-time-dregora',
      profileName: 'A Hard Time',
      memoryMb: 4096
    },
    playCommand: {
      command: '',
      args: [],
      cwd: instanceDir
    }
  };
}

function defaultInstanceDir() {
  return defaultInstanceDirForPlatform(process.platform, {
    ...process.env,
    HOME: process.env.HOME || app.getPath('home'),
    USERPROFILE: process.env.USERPROFILE || app.getPath('home')
  });
}

function localInstanceCandidates() {
  const home = app.getPath('home');
  const documents = app.getPath('documents');
  return [...new Set([
    path.join(home, 'curseforge', 'minecraft', 'Instances', 'RLCraft Dregora'),
    path.join(home, 'curseforge', 'minecraft', 'Instances', 'A Hard Time Dregora'),
    path.join(documents, 'CurseForge', 'minecraft', 'Instances', 'RLCraft Dregora'),
    path.join(documents, 'CurseForge', 'minecraft', 'Instances', 'A Hard Time Dregora')
  ])];
}

function localMinecraftLauncherCandidates() {
  const home = app.getPath('home');
  const documents = app.getPath('documents');
  return [...new Set([
    path.join(home, 'curseforge', 'minecraft', 'Install'),
    path.join(documents, 'CurseForge', 'minecraft', 'Install'),
    ...minecraftRootCandidates(process.platform, {
      ...process.env,
      HOME: process.env.HOME || app.getPath('home'),
      USERPROFILE: process.env.USERPROFILE || app.getPath('home')
    })
  ])];
}

function localReleaseCandidates() {
  return [...new Set([
    path.join(appRoot, 'dist-r2-packaged-cache-test', 'latest.json'),
    path.join(appRoot, 'dist-r2-cache-test', 'latest.json'),
    path.join(appRoot, 'dist-r2-packaged-build-test', 'latest.json'),
    path.join(appRoot, 'dist-r2-bundle-test', 'latest.json')
  ])];
}

async function firstExistingMinecraftLauncherRoot(paths) {
  const candidates = [];
  for (const item of paths) {
    try {
      const stat = await fs.stat(item);
      const launcherExe = path.join(item, process.platform === 'win32' ? 'minecraft.exe' : 'minecraft-launcher');
      const hasLauncherExe = await pathExists(launcherExe);
      const hasProfiles = await pathExists(path.join(item, 'launcher_profiles.json'));
      const auth = await inspectMinecraftLauncherAuth(item);
      if (stat.isDirectory() && (hasProfiles || hasLauncherExe || auth.signedIn)) {
        const hasLibraries = await pathExists(path.join(item, 'libraries'));
        const hasVersions = await pathExists(path.join(item, 'versions'));
        candidates.push({
          rootDir: item,
          score:
            (auth.signedIn ? 1000 : 0)
            + (hasLauncherExe ? 250 : 0)
            + (hasProfiles ? 100 : 0)
            + (hasLibraries ? 25 : 0)
            + (hasVersions ? 25 : 0),
          auth,
          hasLauncherExe,
          hasProfiles
        });
      }
    } catch {}
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.rootDir || '';
}

async function firstExistingDirectory(paths) {
  for (const item of paths) {
    try {
      const stat = await fs.stat(item);
      if (stat.isDirectory()) {
        return item;
      }
    } catch {}
  }
  return '';
}

async function firstExistingFile(paths) {
  for (const item of paths) {
    try {
      const stat = await fs.stat(item);
      if (stat.isFile()) {
        return item;
      }
    } catch {}
  }
  return '';
}

function mergeConfig(defaults, stored) {
  const merged = {
    ...defaults,
    ...stored,
    curseforge: { ...defaults.curseforge, ...stored.curseforge },
    sync: { ...defaults.sync, ...stored.sync },
    developer: { ...defaults.developer, ...stored.developer },
    launcherUpdate: { ...defaults.launcherUpdate, ...stored.launcherUpdate },
    launcherProof: { ...defaults.launcherProof, ...stored.launcherProof },
    serverTransfer: { ...defaults.serverTransfer, ...stored.serverTransfer },
    minecraftLauncher: { ...defaults.minecraftLauncher, ...stored.minecraftLauncher },
    playCommand: { ...defaults.playCommand, ...stored.playCommand }
  };
  if (merged.minecraftLauncher?.profileName === 'A Hard Time Dregora') {
    merged.minecraftLauncher.profileName = 'A Hard Time';
  }
  return merged;
}

function samePath(left = '', right = '') {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function packagedDefaultFiles() {
  const files = [
    process.env.AHT_APP_DEFAULTS || '',
    process.execPath ? path.join(path.dirname(process.execPath), 'app.defaults.json') : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'app.defaults.json') : '',
    path.join(appRoot, 'config', 'app.defaults.json')
  ].filter(Boolean);
  return [...new Set(files.map((file) => path.resolve(file)))];
}

async function packagedDefaults() {
  const defaults = defaultConfig();
  let configured = defaults;
  for (const defaultsFile of packagedDefaultFiles()) {
    if (await pathExists(defaultsFile)) {
      configured = mergeConfig(defaults, await readJsonFile(defaultsFile));
      break;
    }
  }
  if (!configured.instanceDir || isCurseForgeInstanceDir(configured.instanceDir) || isOldLauncherInstanceDir(configured.instanceDir)) {
    configured.instanceDir = defaultInstanceDir();
  }
  const detectedInstanceDir = await firstExistingDirectory(localInstanceCandidates());
  if (detectedInstanceDir && !configured.developer.defaultCacheModsDir) {
    const modsDir = path.join(detectedInstanceDir, 'mods');
    if (await pathExists(modsDir)) {
      configured.developer.defaultCacheModsDir = modsDir;
    }
  }
  const localReleaseLatest = await firstExistingFile(localReleaseCandidates());
  if (!configured.latestUrl && localReleaseLatest) {
    configured.latestUrl = localReleaseLatest;
  }
  const detectedMinecraftRoot = await firstExistingMinecraftLauncherRoot(localMinecraftLauncherCandidates());
  if (detectedMinecraftRoot && (!configured.minecraftLauncher?.rootDir || configured.minecraftLauncher.rootDir === defaults.minecraftLauncher.rootDir)) {
    configured.minecraftLauncher.rootDir = detectedMinecraftRoot;
  }
  if (!configured.playCommand?.cwd || configured.playCommand.cwd === defaults.playCommand.cwd) {
    configured.playCommand.cwd = configured.instanceDir;
  }
  return configured;
}

async function loadConfig() {
  const file = configPath();
  const defaults = await packagedDefaults();
  if (!(await pathExists(file))) {
    await ensureDir(defaults.instanceDir);
    await writeJsonFile(file, defaults);
    return defaults;
  }
  const stored = await readJsonFile(file);
  const config = mergeConfig(defaults, stored);
  let changed = false;
  if (!stored.instanceDir || isCurseForgeInstanceDir(stored.instanceDir) || isOldLauncherInstanceDir(stored.instanceDir)) {
    config.instanceDir = defaultInstanceDir();
    changed = true;
  }
  if (!config.playCommand?.cwd || isCurseForgeInstanceDir(config.playCommand.cwd) || isOldLauncherInstanceDir(config.playCommand.cwd)) {
    config.playCommand = { ...config.playCommand, cwd: config.instanceDir };
    changed = true;
  }
  if (
    defaults.minecraftLauncher?.rootDir &&
    !samePath(defaults.minecraftLauncher.rootDir, defaultMinecraftRoot()) &&
    samePath(stored.minecraftLauncher?.rootDir, defaultMinecraftRoot())
  ) {
    config.minecraftLauncher.rootDir = defaults.minecraftLauncher.rootDir;
    changed = true;
  }
  if (!Number.isFinite(Number(stored.minecraftLauncher?.memoryMb))) {
    config.minecraftLauncher.memoryMb = 4096;
    changed = true;
  }
  if (!stored.developer?.defaultCacheModsDir && defaults.developer?.defaultCacheModsDir) {
    config.developer.defaultCacheModsDir = defaults.developer.defaultCacheModsDir;
    changed = true;
  }
  await ensureDir(config.instanceDir);
  if (changed) {
    await writeJsonFile(file, config);
  }
  return config;
}

async function saveConfig(nextConfig) {
  const current = await loadConfig();
  const merged = {
    ...current,
    ...nextConfig,
    curseforge: { ...current.curseforge, ...nextConfig.curseforge },
    sync: { ...current.sync, ...nextConfig.sync },
    developer: { ...current.developer, ...nextConfig.developer },
    launcherUpdate: { ...current.launcherUpdate, ...nextConfig.launcherUpdate },
    serverTransfer: { ...current.serverTransfer, ...nextConfig.serverTransfer },
    minecraftLauncher: { ...current.minecraftLauncher, ...nextConfig.minecraftLauncher },
    playCommand: { ...current.playCommand, ...nextConfig.playCommand }
  };
  if (merged.instanceDir) {
    merged.playCommand = {
      ...merged.playCommand,
      cwd: merged.playCommand?.cwd || merged.instanceDir
    };
    await ensureDir(merged.instanceDir);
  }
  delete merged.developer.curseforgeApiKey;
  delete merged.developer.launcherProofSecret;
  delete merged.developer.githubToken;
  delete merged.developer.r2AccessKeyId;
  delete merged.developer.r2SecretAccessKey;
  await writeJsonFile(configPath(), merged);
  return merged;
}

async function readInstalledPack(config) {
  const installedPath = path.join(config.instanceDir, '.aht-launcher', 'installed.json');
  return (await pathExists(installedPath)) ? await readJsonFile(installedPath) : null;
}

async function refreshMinecraftLauncherProfile(config) {
  if (config.minecraftLauncher?.enabled === false) {
    return { profileUpdated: false, profileSkipped: 'Minecraft Launcher profile is disabled.' };
  }

  const installed = await readInstalledPack(config);
  let latest = null;
  let latestError = '';

  if (!installed?.minecraft && config.latestUrl && !isHttpUrl(config.latestUrl)) {
    try {
      latest = await readLatest(config);
    } catch (error) {
      latestError = error.message;
    }
  }

  if (!installed?.minecraft && !latest?.minecraft) {
    return {
      profileUpdated: false,
      profileSkipped: latestError || 'Install the pack before a Minecraft Launcher profile can be written.'
    };
  }

  const minecraftProfile = await ensureMinecraftLauncherProfile({ config, latest, installed });
  return { profileUpdated: true, minecraftProfile };
}

async function saveSettings(configPatch) {
  const config = await saveConfig(configPatch);
  try {
    return {
      config,
      ...(await refreshMinecraftLauncherProfile(config))
    };
  } catch (error) {
    return {
      config,
      profileUpdated: false,
      profileError: error.message
    };
  }
}

async function setupRecommendations(config = null) {
  const current = config || await loadConfig();
  const detectedInstanceDir = await firstExistingDirectory(localInstanceCandidates());
  const detectedMinecraftRoot = await firstExistingMinecraftLauncherRoot(localMinecraftLauncherCandidates());
  const detectedMinecraftAuth = detectedMinecraftRoot
    ? await inspectMinecraftLauncherAuth(detectedMinecraftRoot)
    : { signedIn: false, accountCount: 0, files: [], usernames: [], preferredUsername: '' };
  const localReleaseLatest = await firstExistingFile(localReleaseCandidates());
  const recommendedInstanceDir = defaultInstanceDir();
  const cacheModsDir = detectedInstanceDir && await pathExists(path.join(detectedInstanceDir, 'mods'))
    ? path.join(detectedInstanceDir, 'mods')
    : '';
  return {
    configPath: configPath(),
    detectedInstanceDir,
    recommendedInstanceDir,
    defaultInstanceDir: defaultInstanceDir(),
    detectedMinecraftRoot,
    recommendedMinecraftRoot: detectedMinecraftRoot || current.minecraftLauncher?.rootDir || defaultMinecraftRoot(),
    minecraftLauncherExe: detectedMinecraftRoot ? path.join(detectedMinecraftRoot, process.platform === 'win32' ? 'minecraft.exe' : 'minecraft-launcher') : '',
    minecraftAccountReuseAvailable: detectedMinecraftAuth.signedIn,
    minecraftAccountFileCount: detectedMinecraftAuth.files.length,
    detectedMinecraftUsername: detectedMinecraftAuth.preferredUsername || '',
    instanceExists: Boolean(await firstExistingDirectory([current.instanceDir])),
    cacheModsDir,
    cacheModsExists: Boolean(cacheModsDir),
    localReleaseLatest,
    latestConfigured: Boolean(current.latestUrl),
    canAutoConfigure: Boolean(recommendedInstanceDir || localReleaseLatest)
  };
}

async function applyRecommendedSetup() {
  const current = await loadConfig();
  const setup = await setupRecommendations(current);
  const instanceDir = defaultInstanceDir();
  const playCwd = current.playCommand?.cwd;
  const nextConfig = await saveConfig({
    ...current,
    instanceDir,
    latestUrl: current.latestUrl || setup.localReleaseLatest || '',
    developer: {
      ...current.developer,
      defaultCacheModsDir: current.developer?.defaultCacheModsDir || setup.cacheModsDir || ''
    },
    minecraftLauncher: {
      ...current.minecraftLauncher,
      rootDir: setup.recommendedMinecraftRoot || current.minecraftLauncher?.rootDir || defaultMinecraftRoot()
    },
    playCommand: {
      ...current.playCommand,
      cwd: !playCwd || isCurseForgeInstanceDir(playCwd) || isOldLauncherInstanceDir(playCwd) ? instanceDir : playCwd
    }
  });
  return getStatus(nextConfig);
}

async function loadIdentity() {
  const file = identityPath();
  if (!(await pathExists(file))) {
    const identity = {
      installId: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    await writeJsonFile(file, identity);
    return identity;
  }
  return readJsonFile(file);
}

function developerClientBypassAllowed() {
  return isDeveloperMode() && isDeveloperAuthenticated();
}

function launcherProofIdentity(identity = {}) {
  const developerClient = isDeveloperMode();
  const bypass = developerClientBypassAllowed();
  return {
    ...identity,
    launcherChannel: developerClient ? 'developer' : 'player',
    developerClient,
    developerClientBypass: bypass,
    modIntegrityBypass: bypass
  };
}

function launcherProofAuthToken() {
  return developerClientBypassAllowed() ? adminToken : '';
}
async function identityPayload(config = null) {
  const identity = await loadIdentity();
  let nextIdentity = identity;
  if (config?.minecraftLauncher?.rootDir && config.minecraftLauncher?.autoImportAccount !== false) {
    const auth = await inspectMinecraftLauncherAuth(config.minecraftLauncher.rootDir, {
      extraRoots: minecraftRootCandidates(process.platform, {
        ...process.env,
        HOME: process.env.HOME || app.getPath('home'),
        USERPROFILE: process.env.USERPROFILE || app.getPath('home')
      }).filter((root) => !samePath(root, config.minecraftLauncher.rootDir))
    });
    if (auth.preferredUsername && auth.preferredUsername !== nextIdentity.minecraftUsername) {
      try {
        const registered = await registerMinecraftUsername(auth.preferredUsername, {
          mode: 'minecraft-launcher',
          skipLauncherAuthSync: true
        });
        nextIdentity = await loadIdentity();
        nextIdentity.minecraftUsernameSyncWarning = '';
        nextIdentity.minecraftLauncherDetectedUsername = registered.username || auth.preferredUsername;
      } catch (error) {
        nextIdentity = {
          ...nextIdentity,
          minecraftLauncherDetectedUsername: auth.preferredUsername,
          minecraftUsernameSyncWarning: error.message || String(error)
        };
        await writeJsonFile(identityPath(), nextIdentity);
      }
    }
  }
  return {
    ...nextIdentity,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  };
}

function normalizeMinecraftUsername(username) {
  return String(username || '').trim();
}

function assertMinecraftUsername(username) {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw new Error('Enter a valid Minecraft username.');
  }
}

function accountBaseUrl(config) {
  return config.sync?.baseUrl || config.developer?.adminBaseUrl || '';
}

async function registerMinecraftUsername(username, options = {}) {
  const normalizedUsername = normalizeMinecraftUsername(username);
  assertMinecraftUsername(normalizedUsername);
  const config = await loadConfig();
  const identity = await loadIdentity();
  const base = accountBaseUrl(config);
  let remote = { skipped: true, reason: 'sync URL is not configured' };

  if (base) {
    const url = new URL('api/users/register', base.endsWith('/') ? base : `${base}/`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: normalizedUsername,
        installId: identity.installId,
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        packId: config.packId
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `${response.status} ${response.statusText}`);
    }
    remote = body;
  }

  const nextIdentity = {
    ...identity,
    minecraftUsername: remote.username || normalizedUsername,
    usernameRegisteredAt: identity.usernameRegisteredAt || new Date().toISOString(),
    usernameRegistrationMode: options.mode || (remote.skipped ? 'local' : 'worker'),
    minecraftLauncherDetectedUsername: options.mode === 'minecraft-launcher' ? normalizedUsername : identity.minecraftLauncherDetectedUsername || '',
    minecraftUsernameSyncWarning: ''
  };
  await writeJsonFile(identityPath(), nextIdentity);
  return {
    ok: true,
    username: nextIdentity.minecraftUsername,
    remote
  };
}

async function readLatest(config) {
  if (!config.latestUrl) {
    return null;
  }
  return readJsonFromSource(config.latestUrl);
}

async function expectedCacheExtraManagedFiles(config, latest = null) {
  if (!config?.latestUrl) {
    return [];
  }
  const release = latest || await readLatest(config);
  const preferLocalPaths = !isHttpUrl(config.latestUrl);
  const cacheRef = preferLocalPaths
    ? (release?.cacheManifest?.path || release?.cacheManifest?.url)
    : (release?.cacheManifest?.url || release?.cacheManifest?.path);
  if (!cacheRef) {
    return [];
  }
  const cacheSource = resolveSource(config.latestUrl, cacheRef);
  const cacheManifest = await readJsonFromSource(cacheSource);
  const extraFiles = Array.isArray(cacheManifest?.extraFiles) ? cacheManifest.extraFiles : [];
  return extraFiles
    .filter((entry) => entry?.fileName)
    .map((entry) => ({
      relativePath: normalizeRelPath(`mods/${entry.fileName}`),
      source: 'cache-extra',
      sha256: entry.sha256 || '',
      sha1: entry.sha1 || '',
      requiredByLatest: true
    }));
}

async function scanCurrentManagedIntegrity(config, latest = null) {
  const requiredManaged = await expectedCacheExtraManagedFiles(config, latest).catch((error) => {
    console.warn(`Unable to load expected cache extras for integrity scan: ${error.message || error}`);
    return [];
  });
  return scanManagedIntegrity(config.instanceDir, { requiredManaged });
}

async function readUpdateLogs(config, limit = 3) {
  const base = accountBaseUrl(config);
  if (!base) {
    return [];
  }
  const url = new URL('api/update-logs', base.endsWith('/') ? base : `${base}/`);
  url.searchParams.set('limit', String(Math.max(1, Math.min(Number(limit) || 3, 20))));
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return Array.isArray(body.logs) ? body.logs : [];
}

function integrityStatePath(config) {
  return path.join(config.instanceDir, '.aht-launcher', 'integrity.json');
}

async function readIntegrityState(config) {
  const file = integrityStatePath(config);
  if (!(await pathExists(file))) {
    return null;
  }
  return readJsonFile(file).catch(() => null);
}

async function writeIntegrityState(config, integrity, source = 'scan') {
  const file = integrityStatePath(config);
  await ensureDir(path.dirname(file));
  const state = {
    ...integrity,
    source,
    generatedAt: integrity?.generatedAt || new Date().toISOString()
  };
  await writeJsonFile(file, state);
  return state;
}

function integrityBlockReason(integrity) {
  if (!integrity) return '';
  const counts = integrity.counts || {};
  if (!counts.managed) {
    return 'Repair required. The installed file manifest is missing.';
  }
  if (counts.corrupted > 0) {
    return `Repair required. ${counts.corrupted} managed file${counts.corrupted === 1 ? '' : 's'} failed validation.`;
  }
  return '';
}

function evaluateLaunchState(config, latest, latestError, installed, minecraftProfile = null, integrity = null) {
  const profileEnabled = config.minecraftLauncher?.enabled !== false;
  const playConfigured = profileEnabled;
  if (!playConfigured) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'none',
      launchBlockedReason: 'Minecraft Launcher profile integration is disabled.'
    };
  }

  if (!config.latestUrl) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: 'Release feed is not configured.'
    };
  }

  if (latestError) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: `Release feed cannot be checked: ${latestError}`
    };
  }

  if (!latest) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: 'Release feed did not return pack metadata.'
    };
  }

  if (latest.required === false) {
    return { playConfigured, launchReady: true, launchMode: 'minecraftLauncher', launchBlockedReason: '' };
  }

  if (!installed) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: 'Install the pack before playing.'
    };
  }

  const expectedPackId = latest.packId || config.packId;
  if (expectedPackId && installed.packId !== expectedPackId) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: `Installed pack ${installed.packId || 'unknown'} does not match ${expectedPackId}.`
    };
  }

  if (installed.version !== latest.version) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: `Update required. Installed ${installed.version || 'none'}, latest ${latest.version}.`
    };
  }

  const integrityReason = integrityBlockReason(integrity);
  if (integrityReason) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: integrityReason
    };
  }

  if (minecraftProfile?.versionId && !minecraftProfile.loaderInstalled) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: `Minecraft Launcher is missing loader ${minecraftProfile.versionId}. Run Update to install Forge automatically.`
    };
  }

  return { playConfigured, launchReady: true, launchMode: 'minecraftLauncher', launchBlockedReason: '' };
}

async function testReleaseFeed(configPatch = null) {
  const config = configPatch ? mergeConfig(await loadConfig(), configPatch) : await loadConfig();
  const latestUrl = String(config.latestUrl || '').trim();
  if (!latestUrl) {
    throw new Error('Latest URL is required before the launcher can check for updates.');
  }

  const latest = await readJsonFromSource(latestUrl);
  const missing = [];
  if (!latest || typeof latest !== 'object') missing.push('feed object');
  if (!latest?.name) missing.push('name');
  if (!latest?.version) missing.push('version');
  if (!latest?.zip?.url && !latest?.zip?.path) missing.push('zip.url or zip.path');
  if (missing.length) {
    throw new Error(`Release feed is missing: ${missing.join(', ')}`);
  }

  const preferLocalPaths = !isHttpUrl(latestUrl);
  const packRef = preferLocalPaths ? (latest.zip.path || latest.zip.url) : (latest.zip.url || latest.zip.path);
  const cacheRef = preferLocalPaths
    ? (latest.cacheManifest?.path || latest.cacheManifest?.url)
    : (latest.cacheManifest?.url || latest.cacheManifest?.path);
  const packSource = resolveSource(latestUrl, packRef);
  const cacheSource = cacheRef ? resolveSource(latestUrl, cacheRef) : null;

  return {
    ok: true,
    message: `${latest.name} ${latest.version} is available.`,
    latest: {
      name: latest.name,
      version: latest.version,
      packId: latest.packId || config.packId,
      required: latest.required !== false,
      curseforgeFileCount: latest.curseforge?.fileCount ?? null,
      hasCacheManifest: Boolean(cacheSource),
      packSource,
      cacheSource
    }
  };
}

async function readLauncherUpdate(config = {}) {
  const enabled = config.launcherUpdate?.enabled !== false;
  const latestUrl = launcherLatestUrlForConfig(config);
  const currentVersion = app.getVersion();
  const base = {
    enabled,
    latestUrl,
    currentVersion,
    latestVersion: '',
    required: false,
    updateRequired: false,
    artifact: null,
    error: ''
  };
  if (!enabled || !latestUrl) {
    return base;
  }
  try {
    const manifest = await fetchRemoteJson(latestUrl);
    const artifact = selectLauncherArtifact(manifest);
    const latestVersion = String(manifest.version || '').trim();
    const required = manifest.required !== false;
    const updateRequired = Boolean(required && latestVersion && compareVersions(latestVersion, currentVersion) > 0 && artifact);
    return {
      ...base,
      manifest,
      latestVersion,
      required,
      updateRequired,
      artifact,
      error: artifact || !latestVersion ? '' : `No launcher artifact for ${process.platform}-${process.arch}.`
    };
  } catch (error) {
    return {
      ...base,
      error: error.message || String(error)
    };
  }
}

async function getStatus(configOverride = null) {
  const config = configOverride || await loadConfig();
  const identity = await identityPayload(config);
  let latest = null;
  let latestError = null;
  let updateLogs = [];
  let updateLogsError = null;
  try {
    latest = await readLatest(config);
  } catch (error) {
    latestError = error.message;
  }
  try {
    updateLogs = await readUpdateLogs(config, 3);
  } catch (error) {
    updateLogsError = error.message;
  }
  const installedPath = path.join(config.instanceDir, '.aht-launcher', 'installed.json');
  const installed = await pathExists(installedPath) ? await readJsonFile(installedPath) : null;
  const integrity = await readIntegrityState(config);
  const minecraftProfile = await inspectMinecraftLauncherProfile({ config, latest, installed });
  const launchIntegrity = developerClientBypassAllowed() ? null : integrity;
  const launchState = evaluateLaunchState(config, latest, latestError, installed, minecraftProfile, launchIntegrity);
  const launcherUpdate = await readLauncherUpdate(config);
  return {
    developerMode: isDeveloperMode(),
    appVersion: app.getVersion(),
    platformProfile: platformProfile(process.platform, {
      ...process.env,
      HOME: process.env.HOME || app.getPath('home'),
      USERPROFILE: process.env.USERPROFILE || app.getPath('home')
    }),
    config,
    configPath: configPath(),
    identity,
    developerAuthenticated: isDeveloperAuthenticated(),
    developerSessionExpiresAt: developerSession?.expiresAt ? new Date(developerSession.expiresAt).toISOString() : '',
    developerSecrets: isDeveloperMode() && isDeveloperAuthenticated()
      ? await loadDeveloperSecrets().catch((error) => ({
        saved: false,
        encrypted: false,
        encryptionAvailable: safeStorageAvailable(),
        warning: error.message,
        curseforgeApiKey: '',
        serverSshPassword: '',
        launcherProofSecret: '',
        githubToken: '',
        r2AccountId: '',
        r2AccessKeyId: '',
        r2SecretAccessKey: ''
      }))
      : { saved: false, encrypted: false, encryptionAvailable: safeStorageAvailable(), warning: '', curseforgeApiKey: '', serverSshPassword: '', launcherProofSecret: '', githubToken: '', r2AccountId: '', r2AccessKeyId: '', r2SecretAccessKey: '' },
    setup: await setupRecommendations(config),
    minecraftProfile,
    latest,
    latestError,
    updateLogs,
    updateLogsError,
    launcherUpdate,
    installed,
    integrity,
    updateRequired: latest && latest.required !== false ? installed?.version !== latest.version : false,
    ...launchState
  };
}

async function runUpdate(forceRepair = false) {
  if (updateState.running) {
    updateState.lines.push(`${forceRepair ? 'Repair' : 'Update'} request ignored because an install is already running.`);
    return updateState;
  }
  const config = await loadConfig();
  const identity = await identityPayload(config);
  if (!config.latestUrl) {
    throw new Error('latestUrl is not configured');
  }
  updateState = { running: true, lines: [], lastResult: null, error: null, progress: { phase: 'Preparing', completed: 0, total: 0, percent: 0 } };
  await sendLauncherEvent(config, identity, {
    type: forceRepair ? 'repair_started' : 'install_started',
    version: null
  }).catch((error) => updateState.lines.push(`Sync warning: ${error.message}`));
  try {
    const result = await installPack({
      latestSource: config.latestUrl,
      instanceDir: config.instanceDir,
      cfProxyBaseUrl: config.curseforge?.proxyBaseUrl || '',
      cfApiKey: process.env[config.curseforge?.apiKeyEnv || 'CURSEFORGE_API_KEY'] || '',
      forceRepair,
      onProgress: (progress) => {
        updateState.progress = progress;
      },
      logger: { log: (line) => updateState.lines.push(String(line)) }
    });
    if (config.minecraftLauncher?.enabled !== false) {
      try {
        const latestAfterInstall = await readLatest(config);
        const launcherProof = await writeLauncherProof({
          config,
          identity: launcherProofIdentity(identity),
          latest: latestAfterInstall,
          installed: result.installed,
          authToken: launcherProofAuthToken()
        });
        result.launcherProof = {
          proofFile: launcherProof.proofFile || '',
          trusted: Boolean(launcherProof.trusted),
          source: launcherProof.source || ''
        };
        let profile = await ensureMinecraftLauncherProfile({
          config,
          latest: latestAfterInstall,
          installed: result.installed
        });
        if (profile.loaderId?.startsWith('forge-') && !profile.loaderInstalled) {
          updateState.progress = { phase: 'Installing Forge', completed: 0, total: 0, percent: 97 };
          updateState.lines.push(`Installing Forge ${profile.versionId} for Minecraft Launcher...`);
          const forgeLines = [];
          await installForgeLoader(profile, {
            javaPath: config.minecraftLauncher?.javaPath || 'java',
            logger: { log: (line) => forgeLines.push(String(line)) }
          });
          updateState.lines.push(...forgeLines);
          profile = await ensureMinecraftLauncherProfile({
            config,
            latest: latestAfterInstall,
            installed: result.installed
          });
          if (!profile.loaderInstalled) {
            throw new Error(`Forge ${profile.versionId} did not appear in the Minecraft Launcher versions folder after install.`);
          }
          updateState.lines.push(`Forge ${profile.versionId} is ready.`);
        }
        result.minecraftProfile = profile;
      } catch (error) {
        throw new Error(`Minecraft Launcher setup failed: ${error.message}`);
      }
    }
    updateState.lastResult = result;
    await writeIntegrityState(config, {
      valid: true,
      instanceDir: config.instanceDir,
      counts: {
        managed: (result.installed?.manifestFileCount || 0) + (result.installed?.overrideFileCount || 0),
        checked: (result.installed?.manifestFileCount || 0) + (result.installed?.overrideFileCount || 0),
        ok: (result.installed?.manifestFileCount || 0) + (result.installed?.overrideFileCount || 0),
        changed: 0,
        missing: 0,
        corrupted: 0
      },
      changed: [],
      missing: [],
      truncated: false
    }, forceRepair ? 'repair' : 'install');
    await sendLauncherEvent(config, identity, {
      type: forceRepair ? 'repair_completed' : 'install_completed',
      version: result.installed?.version || null,
      manifestFileCount: result.installed?.manifestFileCount || 0,
      overrideFileCount: result.installed?.overrideFileCount || 0
    }).catch((error) => updateState.lines.push(`Sync warning: ${error.message}`));
    return result;
  } catch (error) {
    updateState.error = error.message;
    await sendLauncherEvent(config, identity, {
      type: forceRepair ? 'repair_failed' : 'install_failed',
      error: error.message
    }).catch(() => {});
    throw error;
  } finally {
    updateState.running = false;
  }
}

function defaultLauncherInstallerArgs(artifact = {}) {
  if (Array.isArray(artifact.installArgs)) {
    return artifact.installArgs.map((item) => String(item));
  }
  const fileName = String(artifact.fileName || artifact.path || artifact.url || '').toLowerCase();
  if (process.platform === 'win32' && fileName.endsWith('.exe')) {
    return ['/S'];
  }
  return [];
}

async function launchDownloadedLauncherUpdate(filePath, artifact = {}) {
  if (process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT === '1') {
    return { ok: true, skipped: true, command: filePath, args: defaultLauncherInstallerArgs(artifact) };
  }

  const cwd = path.dirname(filePath);
  const args = defaultLauncherInstallerArgs(artifact);
  if (process.platform === 'darwin') {
    return spawnDetached('open', [filePath], cwd, process.env);
  }
  if (process.platform === 'linux') {
    if (/\.deb$/i.test(filePath)) {
      return spawnDetached('xdg-open', [filePath], cwd, process.env);
    }
    await fs.chmod(filePath, 0o755).catch(() => {});
    return spawnDetached(filePath, args, cwd, process.env);
  }
  return spawnDetached(filePath, args, cwd, process.env);
}

async function runLauncherUpdate() {
  if (launcherUpdateState.running) {
    launcherUpdateState.lines.push('Launcher update request ignored because an app update is already running.');
    return launcherUpdateState;
  }
  const config = await loadConfig();
  const update = await readLauncherUpdate(config);
  if (!update.updateRequired || !update.artifact) {
    throw new Error(update.error || 'Launcher is already current.');
  }
  const source = resolveSource(update.latestUrl, update.artifact.url || update.artifact.path);
  if (!source) {
    throw new Error('Launcher update artifact URL is missing.');
  }
  const fileName = update.artifact.fileName || path.basename(new URL(source).pathname) || `aht-launcher-${update.latestVersion}`;
  const downloadDir = path.join(app.getPath('userData'), 'launcher-updates', normalizedVersion(update.latestVersion));
  const target = path.join(downloadDir, fileName);
  launcherUpdateState = {
    running: true,
    lines: [`Launcher update ${app.getVersion()} -> ${update.latestVersion}`, `Downloading ${fileName}`],
    lastResult: null,
    error: null,
    progress: { phase: 'Downloading launcher', completed: 0, total: 1, percent: 20 }
  };
  try {
    await downloadToFile(source, target);
    launcherUpdateState.progress = { phase: 'Verifying launcher', completed: 1, total: 3, percent: 70 };
    if (update.artifact.sha256) {
      const actual = await hashFile(target, 'sha256');
      if (actual.toLowerCase() !== String(update.artifact.sha256).toLowerCase()) {
        throw new Error(`Launcher update hash mismatch: expected ${update.artifact.sha256}, got ${actual}`);
      }
    }
    launcherUpdateState.lines.push('Launcher update downloaded and verified.');
    launcherUpdateState.progress = { phase: 'Starting installer', completed: 2, total: 3, percent: 92 };
    const launched = await launchDownloadedLauncherUpdate(target, update.artifact);
    const result = {
      ok: true,
      version: update.latestVersion,
      downloadedPath: target,
      artifact: update.artifact,
      launched
    };
    launcherUpdateState.lastResult = result;
    launcherUpdateState.progress = { phase: process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT === '1' ? 'Ready' : 'Restarting launcher', completed: 3, total: 3, percent: 100 };
    launcherUpdateState.lines.push(process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT === '1'
      ? 'Test mode skipped installer launch and app quit.'
      : 'Installer started. The launcher will close so the update can finish.');
    if (process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT !== '1') {
      setTimeout(() => app.quit(), 900);
    }
    return result;
  } catch (error) {
    launcherUpdateState.error = error.message || String(error);
    throw error;
  } finally {
    launcherUpdateState.running = false;
  }
}

function serverTransferOptions(config = {}, payload = {}, password = '') {
  const configured = config.serverTransfer || {};
  const excludeDirs = [...new Set(['DregoraRL', ...(configured.excludeDirs || []), ...(payload.excludeDirs || [])])];
  const includeDirs = [...new Set([...(payload.includeDirs || configured.includeDirs || DEFAULT_INCLUDED_DIRS)])];
  return {
    sourceDir: payload.sourceDir || configured.sourceDir || 'C:\\RL CRAFT SERVER LIST\\New folder - Copy',
    host: payload.host || configured.host || '192.168.1.121',
    port: Number(payload.port || configured.port || 22),
    username: payload.username || configured.username || 'notevil',
    remoteDir: payload.remoteDir || configured.remoteDir || '/home/notevil/Desktop/AHT Server Files',
    password,
    excludeDirs,
    includeDirs,
    includeRootFiles: payload.includeRootFiles ?? configured.includeRootFiles ?? true,
    concurrency: Number(payload.concurrency || configured.concurrency || 8)
  };
}

async function planServerTransfer(payload = {}) {
  assertDeveloperAuthenticated();
  const config = await loadConfig();
  const options = serverTransferOptions(config, payload);
  return collectServerTransferFiles(options.sourceDir, {
    excludeDirs: options.excludeDirs,
    includeDirs: options.includeDirs,
    includeRootFiles: options.includeRootFiles
  });
}

async function syncServerFiles(payload = {}) {
  assertDeveloperAuthenticated();
  if (serverTransferState.running) {
    throw new Error('Server file upload is already running');
  }
  if (payload.password) {
    await saveDeveloperSecrets({ serverSshPassword: payload.password });
  }
  const secrets = await loadDeveloperSecrets();
  const config = await loadConfig();
  const options = serverTransferOptions(config, payload, payload.password || secrets.serverSshPassword || '');
  serverTransferState = {
    running: true,
    lines: [
      `Uploading server files to ${options.username}@${options.host}:${options.remoteDir}`,
      `Scope: root files plus ${options.includeDirs.join(', ')}. DregoraRL is always excluded.`
    ],
    lastResult: null,
    error: null,
    progress: { phase: 'Planning', completed: 0, total: 0, percent: 0 }
  };
  try {
    const result = await uploadServerFiles(options, {
      logger: { log: (line) => serverTransferState.lines.push(String(line)) },
      onProgress: (progress) => {
        serverTransferState.progress = progress;
      }
    });
    serverTransferState.lastResult = result;
    serverTransferState.lines.push(`Done. Uploaded ${result.uploaded} changed files, skipped ${result.skipped || 0} unchanged files. Excluded: ${result.excludedDirs.join(', ') || 'none'}`);
    serverTransferState.progress = {
      phase: 'Complete',
      completed: result.fileCount,
      total: result.fileCount,
      completedBytes: result.totalBytes,
      totalBytes: result.totalBytes,
      percent: 100
    };
    return result;
  } catch (error) {
    serverTransferState.error = error.message || String(error);
    throw error;
  } finally {
    serverTransferState.running = false;
  }
}

function spawnLogged(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const {
      timeoutMs = 0,
      input = null,
      onOutput = null,
      ...spawnOptions
    } = options;
    const needsWindowsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      ...spawnOptions,
      shell: needsWindowsShell,
      windowsHide: true
    });
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs) : null;
    const record = (chunk) => {
      const text = chunk.toString();
      lines.push(text);
      if (onOutput) {
        onOutput(text);
      }
    };
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);
    if (input !== null && child.stdin) {
      child.stdin.end(String(input));
    }
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const output = lines.join('');
      if (timedOut) {
        reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s\n${output}`));
        return;
      }
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${command} exited with ${code}\n${output}`));
      }
    });
  });
}

async function listFiles(root, rel = '') {
  const target = path.join(root, rel);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    const childAbs = path.join(root, childRel);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, childRel));
    } else if (entry.isFile()) {
      files.push(childAbs);
    }
  }
  return files;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.jar') return 'application/java-archive';
  if (ext === '.exe') return 'application/vnd.microsoft.portable-executable';
  if (ext === '.dmg') return 'application/x-apple-diskimage';
  if (ext === '.deb') return 'application/vnd.debian.binary-package';
  if (ext === '.appimage') return 'application/octet-stream';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function versionHintFromFileName(filePath = '') {
  const name = path.basename(filePath).replace(/\.zip$/i, '');
  const match = name.match(/(?:^|[\s_-])v?(\d+(?:\.\d+){1,4}(?:[-_+][A-Za-z0-9][A-Za-z0-9._-]*)?)$/i);
  return match?.[1]?.replace(/_/g, '-') || '';
}

function normalizedVersion(value = '') {
  return String(value || '').trim().replace(/^v/i, '').replace(/_/g, '-').toLowerCase();
}

function latestUrlFromWorkerInput(value = '') {
  const raw = String(value || '').trim();
  if (!raw || !isHttpUrl(raw)) {
    return '';
  }
  const url = new URL(raw);
  if (!/\/latest\.json$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/latest.json`;
  }
  return url.toString();
}

function launcherLatestUrlFromInput(value = '') {
  const raw = String(value || '').trim();
  if (!raw || !isHttpUrl(raw)) {
    return '';
  }
  const url = new URL(raw);
  if (/\/launcher\/latest\.json$/i.test(url.pathname)) {
    return url.toString();
  }
  if (/\/latest\.json$/i.test(url.pathname)) {
    return new URL('launcher/latest.json', new URL('.', url)).toString();
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/launcher/latest.json`;
  return url.toString();
}

function launcherLatestUrlForConfig(config = {}) {
  const explicit = launcherLatestUrlFromInput(config.launcherUpdate?.latestUrl || '');
  if (explicit) {
    return explicit;
  }
  const packLatest = latestUrlFromWorkerInput(config.latestUrl || '');
  if (!packLatest) {
    return '';
  }
  return new URL('launcher/latest.json', workerBaseUrlFromLatest(packLatest)).toString();
}

function compareVersions(left = '', right = '') {
  const parse = (value) => String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.+_-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return normalizedVersion(left).localeCompare(normalizedVersion(right));
}

function launcherPlatformKeys(platform = process.platform, arch = process.arch) {
  const keys = [`${platform}-${arch}`, platform];
  if (platform === 'win32') keys.push('windows', 'windows-x64');
  if (platform === 'darwin') keys.push(arch === 'arm64' ? 'macos-arm64' : 'macos-x64', 'macos');
  if (platform === 'linux') keys.push('ubuntu-linux', 'ubuntu', 'linux-x64');
  return [...new Set(keys)];
}

function selectLauncherArtifact(manifest, platform = process.platform, arch = process.arch) {
  const platforms = manifest?.platforms || {};
  for (const key of launcherPlatformKeys(platform, arch)) {
    if (platforms[key]) {
      return { key, ...platforms[key] };
    }
  }
  return null;
}

function cacheBustUrl(value) {
  const url = new URL(value);
  url.searchParams.set('aht_verify', `${Date.now()}`);
  return url.toString();
}

function releaseUploadOrder(relPath) {
  if (relPath === 'launcher/latest.json') return 1000;
  if (relPath === 'latest.json') return 1000;
  if (relPath === 'release-report.json') return 900;
  return 0;
}

function wranglerCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function wranglerArgs(args = []) {
  return ['--yes', 'wrangler', ...args];
}

function wranglerWorkDir() {
  return path.join(app.getPath('userData'), 'wrangler');
}

function cleanBucketName(value = '', fallback = '') {
  return String(value || fallback || '').trim();
}

function dataBucketNameFor(releaseBucket = 'ahtlauncher', dataBucket = '') {
  const release = cleanBucketName(releaseBucket, 'ahtlauncher');
  return cleanBucketName(dataBucket, release === 'ahtlauncher' ? 'ahtlauncher-data' : `${release}-data`);
}

function wranglerToml({ releaseBucket = 'ahtlauncher', dataBucket = '' } = {}) {
  const release = cleanBucketName(releaseBucket, 'ahtlauncher');
  const data = dataBucketNameFor(release, dataBucket);
  return [
    'name = "aht-curseforge-proxy"',
    'main = "curseforge-proxy-worker.js"',
    'compatibility_date = "2026-06-01"',
    'workers_dev = true',
    '',
    '[[r2_buckets]]',
    'binding = "AHT_RELEASES"',
    `bucket_name = "${release.replace(/"/g, '\\"')}"`,
    '',
    '[[r2_buckets]]',
    'binding = "AHT_DATA"',
    `bucket_name = "${data.replace(/"/g, '\\"')}"`,
    ''
  ].join('\n');
}

async function prepareWranglerProject(options = {}) {
  const cwd = wranglerWorkDir();
  await ensureDir(cwd);
  const workerSource = path.join(appRoot, 'cloudflare', 'curseforge-proxy-worker.js');
  if (!(await pathExists(workerSource))) {
    throw new Error(`Cloudflare project file missing: ${workerSource}`);
  }
  await fs.copyFile(workerSource, path.join(cwd, 'curseforge-proxy-worker.js'));
  await fs.writeFile(path.join(cwd, 'wrangler.toml'), wranglerToml(options), 'utf8');
  return cwd;
}

function workerBaseUrlFromLatest(value = '') {
  const latestUrl = latestUrlFromWorkerInput(value);
  if (!latestUrl) {
    return '';
  }
  return new URL('.', latestUrl).toString();
}

function parseWorkerUrl(output = '') {
  const matches = [...String(output || '').matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0].replace(/[),.;]+$/, ''));
  return matches.find((url) => /workers\.dev/i.test(url)) || matches[0] || '';
}

function wranglerOutputNeedsLogin(output = '') {
  return /not authenticated|wrangler login|please run [`'"]?wrangler login/i.test(String(output || ''));
}

function wranglerAccountSummary(output = '') {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(?:[\u2500-\u257f]+|\u26c5\ufe0f?|getting user settings)/i.test(line));
  return lines.slice(-2).join(' ') || String(output || '').trim();
}

async function wranglerWhoami(cwd) {
  try {
    const output = await spawnLogged(wranglerCommand(), wranglerArgs(['whoami']), {
      cwd,
      timeoutMs: 180_000
    });
    if (wranglerOutputNeedsLogin(output)) {
      return {
        ok: false,
        output,
        summary: `${output.trim()}\nRun Setup Cloud, or run: npx wrangler login`
      };
    }
    return {
      ok: true,
      output,
      summary: wranglerAccountSummary(output)
    };
  } catch (error) {
    const output = error.message || String(error);
    return {
      ok: false,
      output,
      summary: `${output}\nRun Setup Cloud, or run: npx wrangler login`
    };
  }
}

async function cloudLogin(options = {}) {
  assertDeveloperAuthenticated();
  const cwd = await prepareWranglerProject(options);
  const before = await wranglerWhoami(cwd);
  if (before.ok) {
    return {
      ok: true,
      alreadyAuthenticated: true,
      output: before.output,
      summary: before.summary
    };
  }
  const loginOutput = await spawnLogged(wranglerCommand(), wranglerArgs(['login']), {
    cwd,
    timeoutMs: 10 * 60_000
  });
  const after = await wranglerWhoami(cwd);
  return {
    ok: after.ok,
    alreadyAuthenticated: false,
    output: `${before.output || ''}\n${loginOutput || ''}\n${after.output || ''}`.trim(),
    summary: after.ok ? after.summary : after.summary
  };
}

async function createR2Bucket(bucketName, options = {}) {
  const name = String(bucketName || '').trim();
  if (!name) {
    return { bucket: name, ok: false, output: 'Bucket name is empty' };
  }
  const cwd = await prepareWranglerProject(options);
  try {
    const output = await spawnLogged(wranglerCommand(), wranglerArgs(['r2', 'bucket', 'create', name]), {
      cwd,
      timeoutMs: 180_000
    });
    return { bucket: name, ok: true, output };
  } catch (error) {
    const message = error.message || '';
    if (/already exists|already owned|10014|name is already in use/i.test(message)) {
      return { bucket: name, ok: true, alreadyExists: true, output: message };
    }
    return { bucket: name, ok: false, output: message };
  }
}

async function cloudSetupBuckets({ releaseBucket = 'ahtlauncher', dataBucket = 'ahtlauncher-data' } = {}) {
  assertDeveloperAuthenticated();
  const releaseName = cleanBucketName(releaseBucket, 'ahtlauncher');
  const dataName = dataBucketNameFor(releaseName, dataBucket);
  const options = { releaseBucket: releaseName, dataBucket: dataName };
  const release = await createR2Bucket(releaseName, options);
  const data = await createR2Bucket(dataName, options);
  const results = [release, data];
  return {
    ok: results.every((item) => item.ok),
    results,
    checks: results.map((item) => ({
      level: item.ok ? 'ok' : 'error',
      label: item.alreadyExists ? `R2 bucket exists: ${item.bucket}` : `R2 bucket ${item.ok ? 'ready' : 'failed'}: ${item.bucket}`,
      detail: item.output || ''
    })),
    errors: results.filter((item) => !item.ok).map((item) => ({ label: `R2 bucket failed: ${item.bucket}`, detail: item.output || '' })),
    warnings: []
  };
}

async function cloudDeployWorker({ releaseBucket = 'ahtlauncher', dataBucket = '' } = {}) {
  assertDeveloperAuthenticated();
  const releaseName = cleanBucketName(releaseBucket, 'ahtlauncher');
  const dataName = dataBucketNameFor(releaseName, dataBucket);
  const cwd = await prepareWranglerProject({ releaseBucket: releaseName, dataBucket: dataName });
  const output = await spawnLogged(wranglerCommand(), wranglerArgs(['deploy', '--config', 'wrangler.toml']), {
    cwd,
    timeoutMs: 5 * 60_000
  });
  const workerUrl = parseWorkerUrl(output);
  return {
    ok: true,
    output,
    workerUrl,
    latestUrl: workerUrl ? latestUrlFromWorkerInput(workerUrl) : '',
    releaseBucket: releaseName,
    dataBucket: dataName
  };
}

async function putWorkerSecret(name, value, options = {}) {
  const secretName = String(name || '').trim();
  const secretValue = String(value || '');
  if (!secretName) {
    return { name: secretName, ok: false, output: 'Secret name is empty' };
  }
  if (!secretValue) {
    return { name: secretName, ok: false, output: `${secretName} is empty` };
  }
  const cwd = await prepareWranglerProject(options);
  try {
    const output = await spawnLogged(wranglerCommand(), wranglerArgs(['secret', 'put', secretName, '--config', 'wrangler.toml']), {
      cwd,
      input: `${secretValue}\n`,
      timeoutMs: 180_000
    });
    return { name: secretName, ok: true, output };
  } catch (error) {
    return { name: secretName, ok: false, output: error.message || String(error) };
  }
}

function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

async function cloudSetupSecrets({
  curseforgeApiKey = '',
  adminUsername = '',
  adminPassword = '',
  adminTokenSecret = '',
  launcherProofSecret = '',
  releaseBucket = 'ahtlauncher',
  dataBucket = '',
  cacheOnlyMode = false
} = {}) {
  assertDeveloperAuthenticated();
  const releaseName = cleanBucketName(releaseBucket, 'ahtlauncher');
  const dataName = dataBucketNameFor(releaseName, dataBucket);
  launcherProofSecret = String(launcherProofSecret || '').trim();
  if (!launcherProofSecret) {
    throw new Error('Launcher Proof Secret is required before cloud setup. Set the same value on the server as LAUNCHER_PROOF_SECRET.');
  }
  const credentials = await loadDeveloperCredentials();
  const resolvedAdminUsername = String(adminUsername || credentials.username || DEFAULT_DEVELOPER_USERNAME).trim();
  const resolvedAdminPassword = String(adminPassword || credentials.password || '');
  if (!resolvedAdminUsername || !resolvedAdminPassword) {
    throw new Error('Developer credentials are not configured on this machine. Set AHT_DEVELOPER_PASSWORD or create developer.credentials.json in the app data folder.');
  }
  const options = { releaseBucket: releaseName, dataBucket: dataName };
  const secrets = [
    ['ADMIN_USERNAME', resolvedAdminUsername],
    ['ADMIN_PASSWORD', resolvedAdminPassword],
    ['ADMIN_TOKEN_SECRET', adminTokenSecret || randomSecret()],
    ['LAUNCHER_PROOF_SECRET', launcherProofSecret]
  ];
  if (curseforgeApiKey || !cacheOnlyMode) {
    secrets.unshift(['CURSEFORGE_API_KEY', curseforgeApiKey]);
  }
  const results = [];
  for (const [name, value] of secrets) {
    results.push(await putWorkerSecret(name, value, options));
  }
  return {
    ok: results.every((item) => item.ok),
    results,
    checks: results.map((item) => ({
      level: item.ok ? 'ok' : 'error',
      label: item.ok ? `Secret set: ${item.name}` : `Secret failed: ${item.name}`,
      detail: item.ok ? 'Stored in Cloudflare Worker secrets.' : item.output || ''
    })),
    warnings: [],
    errors: results.filter((item) => !item.ok).map((item) => ({ label: `Secret failed: ${item.name}`, detail: item.output || '' }))
  };
}

async function fetchRemoteJson(url) {
  const response = await fetch(cacheBustUrl(url), {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`);
  }
  return response.json();
}

async function cloudPreflight({ publicLatestUrl = '', bucket = '' }) {
  assertDeveloperAuthenticated();
  const checks = [];
  const warnings = [];
  const errors = [];
  const add = (level, label, detail = '') => {
    const item = { level, label, detail };
    checks.push(item);
    if (level === 'warning') warnings.push(item);
    if (level === 'error') errors.push(item);
  };

  const latestUrl = latestUrlFromWorkerInput(publicLatestUrl);
  const bucketName = String(bucket || '').trim();
  if (!latestUrl) {
    add('error', 'Player Feed URL invalid', 'Use the public Cloudflare Worker URL ending in /latest.json.');
  } else {
    add('ok', 'Player Feed URL parsed', latestUrl);
    const baseUrl = workerBaseUrlFromLatest(latestUrl);
    try {
      const response = await fetch(cacheBustUrl(baseUrl), { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (response.ok) {
        add('ok', 'Worker root reachable', baseUrl);
      } else {
        add('warning', 'Worker root did not return 200', `${response.status} ${response.statusText}`);
      }
    } catch (error) {
      add('warning', 'Worker root check failed', error.message);
    }

    try {
      const latest = await fetchRemoteJson(latestUrl);
      add('ok', 'Current player feed reachable', `${latest.name || 'Pack'} ${latest.version || 'unknown'}`.trim());
    } catch (error) {
      add('warning', 'Current player feed not available yet', 'This is okay before the first upload. Upload will verify it afterward.');
    }
  }

  if (!bucketName) {
    add('error', 'R2 bucket missing', 'Set the R2 bucket name, normally ahtlauncher.');
  } else {
    add('ok', 'R2 bucket set', bucketName);
  }

  const npx = wranglerCommand();
  const cwd = wranglerWorkDir();
  await ensureDir(cwd);
  try {
    const version = await spawnLogged(npx, wranglerArgs(['--version']), { cwd, timeoutMs: 180_000 });
    add('ok', 'Wrangler available', version.trim().split(/\r?\n/).at(-1) || 'wrangler');
  } catch (error) {
    add('error', 'Wrangler unavailable', `${error.message}\nThe app uses npx --yes wrangler. Install Node/npm or run npm/npx once on this machine.`);
  }

  const auth = await wranglerWhoami(cwd);
  add(auth.ok ? 'ok' : 'error', auth.ok ? 'Cloudflare account authenticated' : 'Cloudflare login required', auth.summary);

  return {
    ok: errors.length === 0,
    latestUrl,
    bucket: bucketName,
    checks,
    warnings,
    errors
  };
}

function playerDefaultsForCloud(config, { publicLatestUrl = '', bucket = '' } = {}) {
  const latestUrl = latestUrlFromWorkerInput(publicLatestUrl || config.latestUrl);
  if (!latestUrl) {
    throw new Error('Player Feed URL is required before writing player defaults.');
  }
  const workerBase = workerBaseUrlFromLatest(latestUrl);
  const releaseBucket = cleanBucketName(bucket || config.developer?.r2Bucket, 'ahtlauncher');
  const cacheOnly = Boolean(config.developer?.cacheOnlyMode);
  return {
    packId: config.packId || 'a-hard-time-dregora',
    latestUrl,
    curseforge: {
      proxyBaseUrl: cacheOnly ? '' : (workerBase ? new URL('cf/', workerBase).toString() : ''),
      apiKeyEnv: 'CURSEFORGE_API_KEY'
    },
    sync: {
      enabled: true,
      sendLocalChanges: true,
      baseUrl: workerBase,
      playerLabel: ''
    },
    developer: {
      adminBaseUrl: workerBase,
      r2Bucket: releaseBucket,
      cacheOnlyMode: cacheOnly
    },
    launcherUpdate: {
      enabled: true,
      latestUrl: workerBase ? new URL('launcher/latest.json', workerBase).toString() : ''
    },
    minecraftLauncher: {
      enabled: true,
      profileId: 'a-hard-time-dregora',
      profileName: 'A Hard Time',
      memoryMb: 4096
    }
  };
}

function playerDefaultsTargets() {
  if (process.env.AHT_PLAYER_DEFAULTS_DIR) {
    return [{
      kind: 'override',
      path: path.resolve(process.env.AHT_PLAYER_DEFAULTS_DIR, 'app.defaults.json')
    }];
  }
  const targets = [
    { kind: 'documents-copy', path: path.join(app.getPath('documents'), 'aht-launcher', 'app.defaults.json') }
  ];
  if (process.env.AHT_SKIP_SOURCE_DEFAULTS !== '1') {
    targets.unshift({ kind: 'source-config', path: path.join(appRoot, 'config', 'app.defaults.json') });
  }
  if (app.isPackaged && process.execPath) {
    targets.unshift({ kind: 'app-folder', path: path.join(path.dirname(process.execPath), 'app.defaults.json') });
  }
  const seen = new Set();
  return targets.filter((target) => {
    const resolved = path.resolve(target.path);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    target.path = resolved;
    return true;
  });
}

async function writePlayerDefaults(payload = {}) {
  assertDeveloperAuthenticated();
  const config = await loadConfig();
  const defaults = playerDefaultsForCloud(config, payload);
  const written = [];
  const failed = [];
  for (const target of playerDefaultsTargets()) {
    if (target.path.includes('.asar')) {
      failed.push({ ...target, error: 'Packaged app archive is read-only.' });
      continue;
    }
    try {
      await ensureDir(path.dirname(target.path));
      await writeJsonFile(target.path, defaults);
      written.push(target);
    } catch (error) {
      failed.push({ ...target, error: error.message || String(error) });
    }
  }
  if (!written.length) {
    throw new Error(`Could not write player defaults: ${failed.map((item) => `${item.kind}: ${item.error}`).join('; ')}`);
  }
  return {
    ok: true,
    latestUrl: defaults.latestUrl,
    baseUrl: defaults.sync.baseUrl,
    defaults,
    written,
    failed
  };
}

async function verifyRemoteHead(url, expectedSize = null) {
  const response = await fetch(cacheBustUrl(url), { method: 'HEAD', cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`HEAD ${url} failed: ${response.status} ${response.statusText}`);
  }
  const length = response.headers.get('content-length');
  if (expectedSize && length && Number(length) !== Number(expectedSize)) {
    throw new Error(`HEAD ${url} size mismatch: expected ${expectedSize}, got ${length}`);
  }
  return {
    url,
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    contentLength: length || ''
  };
}

async function verifyRemoteRelease({ publicLatestUrl, localLatest }) {
  const latestUrl = latestUrlFromWorkerInput(publicLatestUrl);
  if (!latestUrl) {
    throw new Error('Public player feed URL must be a Cloudflare Worker http(s) URL ending in /latest.json.');
  }

  let remoteLatest = null;
  let verified = false;
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      remoteLatest = await fetchRemoteJson(latestUrl);
      if (remoteLatest?.version !== localLatest.version || remoteLatest?.packId !== localLatest.packId) {
        throw new Error(`remote latest is ${remoteLatest?.packId || 'unknown'} ${remoteLatest?.version || 'unknown'}, expected ${localLatest.packId} ${localLatest.version}`);
      }
      if (remoteLatest.zip?.sha256 !== localLatest.zip?.sha256) {
        throw new Error('remote latest.json does not contain the uploaded pack SHA256');
      }
      verified = true;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 6) {
        await sleep(2000);
      }
    }
  }
  if (!verified) {
    throw lastError || new Error('Remote latest.json could not be verified.');
  }

  const packUrl = resolveSource(latestUrl, remoteLatest.zip?.url || remoteLatest.zip?.path);
  const cacheUrl = remoteLatest.cacheManifest?.url || remoteLatest.cacheManifest?.path
    ? resolveSource(latestUrl, remoteLatest.cacheManifest.url || remoteLatest.cacheManifest.path)
    : '';
  const checks = [];
  checks.push(await verifyRemoteHead(packUrl, remoteLatest.zip?.size || null));
  if (cacheUrl) {
    checks.push(await verifyRemoteHead(cacheUrl));
  }
  return {
    publicLatestUrl: latestUrl,
    latest: {
      packId: remoteLatest.packId || '',
      name: remoteLatest.name || '',
      version: remoteLatest.version || '',
      required: remoteLatest.required !== false,
      zipSha256: remoteLatest.zip?.sha256 || ''
    },
    checks
  };
}

async function uploadR2Object({ bucket, rel, file, wranglerCwd, onOutput = null }) {
  return spawnLogged(wranglerCommand(), wranglerArgs([
    'r2',
    'object',
    'put',
    `${bucket}/${rel}`,
    `--file=${file}`,
    `--content-type=${contentType(file)}`,
    '--remote'
  ]), {
    cwd: wranglerCwd,
    timeoutMs: 30 * 60_000,
    onOutput
  });
}

function r2DirectCredentials({ payload = {}, config = {}, secrets = {} } = {}) {
  return {
    accountId: cleanR2AccountId(
      payload.r2AccountId
      || secrets.r2AccountId
      || config.developer?.r2AccountId
      || process.env.AHT_R2_ACCOUNT_ID
      || process.env.CLOUDFLARE_ACCOUNT_ID
      || ''
    ),
    accessKeyId: String(
      payload.r2AccessKeyId
      || secrets.r2AccessKeyId
      || process.env.AHT_R2_ACCESS_KEY_ID
      || process.env.R2_ACCESS_KEY_ID
      || process.env.AWS_ACCESS_KEY_ID
      || ''
    ).trim(),
    secretAccessKey: String(
      payload.r2SecretAccessKey
      || secrets.r2SecretAccessKey
      || process.env.AHT_R2_SECRET_ACCESS_KEY
      || process.env.R2_SECRET_ACCESS_KEY
      || process.env.AWS_SECRET_ACCESS_KEY
      || ''
    ).trim()
  };
}

async function detectCloudflareAccountId() {
  try {
    const output = await spawnLogged(wranglerCommand(), wranglerArgs(['whoami']), {
      cwd: wranglerWorkDir(),
      timeoutMs: 20_000
    });
    return output.match(/\b[0-9a-f]{32}\b/i)?.[0] || '';
  } catch {
    return '';
  }
}

async function resolveR2DirectCredentials({ payload = {}, config = {}, secrets = {} } = {}) {
  const credentials = r2DirectCredentials({ payload, config, secrets });
  if (!credentials.accountId && credentials.accessKeyId && credentials.secretAccessKey) {
    credentials.accountId = await detectCloudflareAccountId();
  }
  return credentials;
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function trimUploadLines(max = 100) {
  if (uploadState.lines.length > max) {
    uploadState.lines = uploadState.lines.slice(-max);
  }
}

function sha256FromReleasePath(rel = '') {
  return String(rel || '').match(/^cache\/files\/([a-f0-9]{64})\.jar$/i)?.[1]?.toLowerCase() || '';
}

async function releaseObjectSha256({ rel = '', file = '', localLatest = null } = {}) {
  const relHash = sha256FromReleasePath(rel);
  if (relHash) return relHash;
  if (localLatest?.zip?.path && normalizeRelPath(localLatest.zip.path) === rel && localLatest.zip.sha256) {
    return String(localLatest.zip.sha256).toLowerCase();
  }
  return (await hashFile(file, 'sha256')).toLowerCase();
}

function remoteReleaseObjectMatches({ rel = '', remote = {}, stat = {}, sha256 = '' } = {}) {
  if (!remote?.exists || Number(remote.size || 0) !== Number(stat.size || 0)) return false;
  const remoteSha = String(remote.sha256 || '').toLowerCase();
  if (remoteSha && remoteSha === String(sha256 || '').toLowerCase()) return true;
  return Boolean(sha256FromReleasePath(rel) && String(sha256 || '').toLowerCase() === sha256FromReleasePath(rel));
}

function launcherUpdateRootUrl(publicLatestUrl, config = {}) {
  const launcherLatest = launcherLatestUrlFromInput(publicLatestUrl || config.launcherUpdate?.latestUrl || config.latestUrl || '');
  if (!launcherLatest) {
    throw new Error('A public Worker URL is required before publishing launcher updates.');
  }
  return new URL('../', launcherLatest).toString();
}

function launcherArtifactDescriptors(payload = {}) {
  return [
    {
      key: 'win32-x64',
      aliases: ['win32', 'windows', 'windows-x64'],
      label: 'Windows 10/11',
      kind: 'nsis',
      installArgs: ['/S'],
      file: payload.windowsPath || payload.win32Path || ''
    },
    {
      key: 'darwin',
      aliases: ['macos'],
      label: 'macOS',
      kind: 'dmg',
      installArgs: [],
      file: payload.macosPath || payload.darwinPath || ''
    },
    {
      key: 'linux-x64',
      aliases: ['linux', 'ubuntu', 'ubuntu-linux'],
      label: 'Ubuntu/Linux',
      kind: 'appimage',
      installArgs: [],
      file: payload.ubuntuPath || payload.linuxPath || ''
    }
  ].filter((item) => String(item.file || '').trim());
}

async function buildLauncherUpdateManifest({ version, publicLatestUrl = '', artifacts = [] }) {
  const config = await loadConfig();
  const rootUrl = launcherUpdateRootUrl(publicLatestUrl, config);
  const cleanVersion = String(version || '').trim() || app.getVersion();
  if (!cleanVersion) {
    throw new Error('Launcher update version is required.');
  }
  const platforms = {};
  const uploads = [];
  for (const descriptor of artifacts) {
    const file = path.resolve(descriptor.file);
    if (!(await pathExists(file))) {
      throw new Error(`${descriptor.label} launcher artifact is missing: ${file}`);
    }
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      throw new Error(`${descriptor.label} launcher artifact is not a file: ${file}`);
    }
    const sha256 = await hashFile(file, 'sha256');
    const fileName = path.basename(file);
    const rel = `launcher/files/${descriptor.key}/${fileName}`;
    const entry = {
      label: descriptor.label,
      kind: descriptor.kind,
      fileName,
      path: rel,
      url: new URL(rel, rootUrl).toString(),
      sha256,
      size: stat.size,
      installArgs: descriptor.installArgs || []
    };
    platforms[descriptor.key] = entry;
    for (const alias of descriptor.aliases || []) {
      platforms[alias] = entry;
    }
    uploads.push({ rel, file, label: descriptor.label, size: stat.size });
  }
  if (!uploads.length) {
    throw new Error('Add at least one launcher artifact before publishing.');
  }
  const manifest = {
    schemaVersion: 1,
    product: 'aht-launcher',
    name: 'A Hard Time Launcher',
    version: cleanVersion,
    required: true,
    createdAt: new Date().toISOString(),
    currentVersion: app.getVersion(),
    platforms
  };
  return { manifest, uploads, rootUrl };
}

async function findNewestFile(roots, pattern) {
  const matches = [];
  for (const root of roots) {
    if (!root || !(await pathExists(root))) continue;
    for (const file of await listFiles(root)) {
      if (pattern.test(path.basename(file))) {
        matches.push({ file, stat: await fs.stat(file) });
      }
    }
  }
  matches.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return matches[0]?.file || '';
}

async function findLauncherBuilds() {
  assertDeveloperAuthenticated();
  return {
    version: app.getVersion(),
    windowsPath: await findNewestFile([
      path.join(appRoot, 'release-builds', 'windows'),
      path.join(appRoot, 'release-builds')
    ], /\.exe$/i),
    macosPath: await findNewestFile([
      path.join(appRoot, 'release-builds', 'macos')
    ], /\.dmg$/i),
    ubuntuPath: await findNewestFile([
      path.join(appRoot, 'release-builds', 'ubuntu')
    ], /\.(appimage|deb)$/i)
  };
}

function githubCommand() {
  return process.platform === 'win32' ? 'gh.cmd' : 'gh';
}

async function resolveGithubToken(payload = {}) {
  const explicit = String(payload.githubToken || payload.token || '').trim();
  if (explicit) return { token: explicit, source: 'input' };
  const secrets = await loadDeveloperSecrets();
  if (secrets.githubToken) return { token: secrets.githubToken, source: 'saved' };
  const envToken = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (envToken) return { token: envToken, source: 'environment' };
  try {
    const output = await spawnLogged(githubCommand(), ['auth', 'token'], {
      timeoutMs: 10_000
    });
    const token = output.trim();
    if (token) return { token, source: 'gh-cli' };
  } catch {}
  throw new Error('GitHub token is required. Paste a token in the Launcher Updates tab, or sign in with GitHub CLI.');
}

function githubWorkflowPayload(payload = {}, config = {}) {
  const developer = config.developer || {};
  return {
    repo: cleanGithubRepo(payload.githubRepo || payload.repo || developer.githubRepo || launcherWorkflowDefaults.repo),
    ref: cleanRef(payload.githubBranch || payload.branch || developer.githubBranch || launcherWorkflowDefaults.branch),
    workflow: cleanWorkflowId(payload.githubWorkflow || payload.workflow || developer.githubWorkflow || launcherWorkflowDefaults.workflow)
  };
}

async function checkLauncherWorkflow(payload = {}) {
  assertDeveloperAuthenticated();
  const config = await loadConfig();
  const workflow = githubWorkflowPayload(payload, config);
  const { token, source } = await resolveGithubToken(payload);
  const packageVersion = await readGithubPackageVersion({
    repo: workflow.repo,
    ref: workflow.ref,
    token
  });
  const run = await findRecentWorkflowRun({
    ...workflow,
    token,
    since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  });
  return {
    ok: true,
    ...workflow,
    version: packageVersion,
    packageVersion,
    tokenSource: source,
    actionsUrl: `https://github.com/${workflow.repo}/actions/workflows/${workflow.workflow}`,
    latestRun: run
  };
}

async function dispatchLauncherWorkflow(payload = {}) {
  assertDeveloperAuthenticated();
  const config = await loadConfig();
  const workflow = githubWorkflowPayload(payload, config);
  const { token, source } = await resolveGithubToken(payload);
  const version = await readGithubPackageVersion({
    repo: workflow.repo,
    ref: workflow.ref,
    token
  });
  const result = await triggerLauncherReleaseWorkflow({
    ...workflow,
    token,
    launcherVersion: version,
    publishToR2: payload.publishToR2 !== false,
    waitForRunMs: 24_000,
    pollIntervalMs: 2_000
  });
  return {
    ...result,
    version: result.version || version,
    packageVersion: version,
    tokenSource: source,
    releaseUrl: `https://github.com/${result.repo}/releases/tag/launcher-v${result.version || version}`
  };
}

async function verifyRemoteLauncherUpdate({ publicLatestUrl, localManifest }) {
  const latestUrl = launcherLatestUrlFromInput(publicLatestUrl);
  if (!latestUrl) {
    throw new Error('Public launcher feed URL is invalid.');
  }
  const remote = await fetchRemoteJson(latestUrl);
  if (remote.version !== localManifest.version || remote.product !== localManifest.product) {
    throw new Error(`remote launcher latest is ${remote.product || 'unknown'} ${remote.version || 'unknown'}, expected ${localManifest.product} ${localManifest.version}`);
  }
  const artifact = selectLauncherArtifact(remote);
  const checks = [];
  if (artifact?.url || artifact?.path) {
    checks.push(await verifyRemoteHead(resolveSource(latestUrl, artifact.url || artifact.path), artifact.size || null));
  }
  return { publicLatestUrl: latestUrl, latest: { version: remote.version, product: remote.product }, artifact, checks };
}

async function syncLauncherUpdate(payload = {}) {
  assertDeveloperAuthenticated();
  if (uploadState.running) {
    throw new Error('R2 upload is already running');
  }
  const config = await loadConfig();
  const bucket = cleanBucketName(payload.bucket || config.developer?.r2Bucket, 'ahtlauncher');
  const launcherLatestUrl = launcherLatestUrlFromInput(payload.publicLatestUrl || config.launcherUpdate?.latestUrl || config.latestUrl);
  if (!launcherLatestUrl) {
    throw new Error('Player Feed URL is required before publishing launcher updates.');
  }
  const preflight = await cloudPreflight({ publicLatestUrl: latestUrlFromWorkerInput(config.latestUrl || payload.publicLatestUrl), bucket });
  if (!preflight.ok) {
    const summary = preflight.errors.map((error) => error.label).join(', ') || 'cloud preflight failed';
    throw new Error(`Cloud preflight failed: ${summary}`);
  }
  const artifacts = launcherArtifactDescriptors(payload);
  const { manifest, uploads } = await buildLauncherUpdateManifest({
    version: payload.version,
    publicLatestUrl: launcherLatestUrl,
    artifacts
  });
  const staging = path.join(app.getPath('userData'), 'launcher-update-staging', normalizedVersion(manifest.version));
  const manifestPath = path.join(staging, 'launcher', 'latest.json');
  await writeJsonFile(manifestPath, manifest);
  const files = [
    ...uploads,
    { rel: 'launcher/latest.json', file: manifestPath, label: 'launcher/latest.json', size: (await fs.stat(manifestPath)).size }
  ];
  const wranglerCwd = wranglerWorkDir();
  await ensureDir(wranglerCwd);
  const uploaded = [];
  uploadState = {
    running: true,
    total: files.length,
    completed: 0,
    current: '',
    lines: [
      `Uploading ${files.length} launcher update files to remote R2 bucket ${bucket}`,
      'launcher/latest.json will upload last so players only see the update after artifacts are ready.'
    ],
    lastResult: null,
    error: null,
    verification: null
  };
  try {
    for (const item of files) {
      uploadState.current = item.rel;
      uploadState.lines.push(`Uploading ${item.rel} (${item.size || (await fs.stat(item.file)).size} bytes)`);
      const output = await uploadR2Object({
        bucket,
        rel: item.rel,
        file: item.file,
        wranglerCwd,
        onOutput: (text) => {
          const compact = String(text || '').trim();
          if (compact) uploadState.lines.push(compact);
        }
      });
      uploaded.push({ path: item.rel, output: output.trim() });
      uploadState.completed = uploaded.length;
      uploadState.lines.push(`Uploaded ${item.rel}`);
    }
    const verification = await verifyRemoteLauncherUpdate({ publicLatestUrl: launcherLatestUrl, localManifest: manifest });
    uploadState.verification = verification;
    uploadState.lastResult = { uploaded, manifest, verification, preflight };
    return { uploaded, manifest, verification, preflight };
  } catch (error) {
    uploadState.error = error.message;
    throw error;
  } finally {
    uploadState.running = false;
  }
}

async function syncR2(payload = {}) {
  const { outDir, bucket, publicLatestUrl = '' } = payload;
  assertDeveloperAuthenticated();
  if (uploadState.running) {
    throw new Error('R2 upload is already running');
  }
  const config = await loadConfig();
  if (!outDir || !bucket) {
    throw new Error('Output directory and R2 bucket are required');
  }
  const validation = await validateRelease({ outDir, publicLatestUrl });
  if (!validation.ok) {
    const summary = validation.errors.map((error) => error.label).join(', ') || 'release validation failed';
    throw new Error(`Release blocked: ${summary}`);
  }
  const preflight = await cloudPreflight({ publicLatestUrl, bucket });
  if (!preflight.ok) {
    const summary = preflight.errors.map((error) => error.label).join(', ') || 'cloud preflight failed';
    throw new Error(`Cloud preflight failed: ${summary}`);
  }
  const localLatestPath = path.join(outDir, 'latest.json');
  const localLatest = await readJsonFile(localLatestPath);
  const files = (await listFiles(outDir)).sort((a, b) => {
    const left = path.relative(outDir, a).replaceAll(path.sep, '/');
    const right = path.relative(outDir, b).replaceAll(path.sep, '/');
    const order = releaseUploadOrder(left) - releaseUploadOrder(right);
    return order || left.localeCompare(right);
  });
  const fileStats = new Map();
  let totalBytes = 0;
  for (const file of files) {
    const stat = await fs.stat(file);
    fileStats.set(file, stat);
    totalBytes += stat.size;
  }
  const secrets = await loadDeveloperSecrets().catch(() => ({}));
  const directCredentials = await resolveR2DirectCredentials({ payload, config, secrets });
  const fastUpload = directR2CredentialsReady(directCredentials);
  const missingFastUpload = missingDirectR2CredentialLabels(directCredentials);
  const largeUploadThreshold = 50 * 1024 * 1024;
  if (!fastUpload && totalBytes >= largeUploadThreshold && !payload.allowSlowWranglerUpload) {
    throw new Error(`Fast R2 upload credentials are required for large releases (${formatBytes(totalBytes)}). Missing ${missingFastUpload.join(', ')}. Add the R2 Account ID, Access Key ID, and Secret Access Key in Release Builder.`);
  }
  const npx = fastUpload ? '' : wranglerCommand();
  const wranglerCwd = fastUpload ? '' : wranglerWorkDir();
  if (!fastUpload) {
    await ensureDir(wranglerCwd);
  }
  const uploaded = [];
  let uploadedBytes = 0;
  uploadState = {
    running: true,
    total: files.length,
    completed: 0,
    current: '',
    totalBytes,
    uploadedBytes: 0,
    progress: {
      phase: fastUpload ? 'Fast R2 upload' : 'Wrangler upload',
      completed: 0,
      total: totalBytes || files.length,
      percent: 0,
      unit: totalBytes ? 'bytes' : 'files',
      method: fastUpload ? 'direct-multipart' : 'wrangler'
    },
    lines: [
      `Uploading ${files.length} files to remote R2 bucket ${bucket}`,
      'latest.json will upload last so players only see the update after artifacts are ready.',
      fastUpload
        ? 'Fast direct R2 upload enabled: multipart upload with byte progress.'
        : `Fast direct R2 upload disabled; missing ${missingFastUpload.join(', ')}. Falling back to Wrangler.`
    ],
    lastResult: null,
    error: null,
    verification: null
  };
  try {
    for (const file of files) {
      const rel = path.relative(outDir, file).replaceAll(path.sep, '/');
      uploadState.current = rel;
      const stat = fileStats.get(file) || await fs.stat(file);
      const startedAt = Date.now();
      let lastLoggedPercent = -1;
      uploadState.currentSize = stat.size;
      uploadState.currentBytes = 0;
      uploadState.progress = {
        phase: fastUpload ? 'Fast R2 upload' : 'Wrangler upload',
        completed: uploadedBytes,
        total: totalBytes || files.length,
        percent: totalBytes ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : Math.round((uploaded.length / files.length) * 100),
        unit: totalBytes ? 'bytes' : 'files',
        currentFile: rel,
        currentPercent: 0,
        method: fastUpload ? 'direct-multipart' : 'wrangler'
      };
      uploadState.lines.push(`Uploading ${rel} (${formatBytes(stat.size)})`);
      if (fastUpload) {
        uploadState.lines.push(`Checking remote ${rel}`);
        trimUploadLines();
        const sha256 = await releaseObjectSha256({ rel, file, localLatest });
        const remote = await headR2ObjectDirect({
          ...directCredentials,
          bucket,
          key: rel
        });
        if (remoteReleaseObjectMatches({ rel, remote, stat, sha256 })) {
          uploaded.push({ path: rel, output: `skipped ${rel}; remote object already matches`, method: 'direct-skip', skipped: true, size: stat.size });
          uploadState.lines.push(`Skipped ${rel}; remote already matches.`);
        } else {
          const result = await uploadR2ObjectDirect({
            ...directCredentials,
            bucket,
            key: rel,
            file,
            contentType: contentType(file),
            sha256,
            metadata: { 'aht-uploaded-by': 'aht-launcher' },
            onProgress: (progress) => {
              const currentLoaded = Math.min(Number(progress.loaded || 0), stat.size);
              const loadedTotal = uploadedBytes + currentLoaded;
              const totalPercent = totalBytes ? Math.min(100, Math.round((loadedTotal / totalBytes) * 100)) : 0;
              uploadState.currentBytes = currentLoaded;
              uploadState.uploadedBytes = loadedTotal;
              uploadState.progress = {
                phase: 'Fast R2 upload',
                completed: loadedTotal,
                total: totalBytes,
                percent: totalPercent,
                unit: 'bytes',
                currentFile: rel,
                currentPercent: progress.percent || 0,
                speedBytesPerSecond: progress.speedBytesPerSecond || 0,
                method: 'direct-multipart'
              };
              const pct = Number(progress.percent || 0);
              if (pct >= lastLoggedPercent + 10 || pct === 100) {
                lastLoggedPercent = pct;
                uploadState.lines.push(`${rel}: ${pct}% (${formatBytes(currentLoaded)}/${formatBytes(stat.size)} at ${formatBytes(progress.speedBytesPerSecond || 0)}/s)`);
                trimUploadLines();
              }
            }
          });
          uploaded.push({ path: rel, output: `uploaded ${rel}`, method: result.method, size: result.size });
        }
      } else {
        if (rel.endsWith('.zip')) {
          uploadState.lines.push('Large ZIP upload is running through Wrangler; add R2 access keys for byte progress and faster multipart upload.');
        }
        const output = await spawnLogged(npx, wranglerArgs([
          'r2',
          'object',
          'put',
          `${bucket}/${rel}`,
          `--file=${file}`,
          `--content-type=${contentType(file)}`,
          '--remote'
        ]), {
          cwd: wranglerCwd,
          timeoutMs: 30 * 60_000,
          onOutput: (text) => {
            const compact = String(text || '').trim();
            if (compact) {
              uploadState.lines.push(compact);
              trimUploadLines();
            }
          }
        });
        uploaded.push({ path: rel, output: output.trim(), method: 'wrangler', size: stat.size });
      }
      uploadedBytes += stat.size;
      uploadState.currentBytes = stat.size;
      uploadState.uploadedBytes = uploadedBytes;
      uploadState.completed = uploaded.length;
      uploadState.progress = {
        phase: fastUpload ? 'Fast R2 upload' : 'Wrangler upload',
        completed: totalBytes ? uploadedBytes : uploaded.length,
        total: totalBytes || files.length,
        percent: totalBytes ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : Math.round((uploaded.length / files.length) * 100),
        unit: totalBytes ? 'bytes' : 'files',
        currentFile: rel,
        currentPercent: 100,
        speedBytesPerSecond: Math.round(stat.size / Math.max(0.001, (Date.now() - startedAt) / 1000)),
        method: fastUpload ? 'direct-multipart' : 'wrangler'
      };
      const latestUpload = uploaded.at(-1);
      uploadState.lines.push(latestUpload?.skipped ? `Remote current ${rel}` : `Uploaded ${rel}`);
      trimUploadLines();
    }
    const verification = await verifyRemoteRelease({ publicLatestUrl, localLatest });
    uploadState.verification = verification;
    uploadState.lines.push(`Verified player feed ${verification.publicLatestUrl}`);
    uploadState.lastResult = { uploaded, validation, verification, preflight };
    return { uploaded, validation, verification, preflight };
  } catch (error) {
    uploadState.error = error.message;
    throw error;
  } finally {
    uploadState.running = false;
  }
}

function localReleasePath(outDir, ref) {
  if (!ref || isHttpUrl(ref)) {
    return null;
  }
  if (isFileUrl(ref)) {
    return fileURLToPath(ref);
  }
  if (path.isAbsolute(ref)) {
    return ref;
  }
  return safeJoin(outDir, normalizeRelPath(ref));
}

function urlString(value = '') {
  try {
    return new URL(String(value || '')).toString();
  } catch {
    return '';
  }
}

function isUrlUnderBase(value = '', baseValue = '') {
  const url = urlString(value);
  const base = urlString(baseValue);
  if (!url || !base) {
    return false;
  }
  const parsedUrl = new URL(url);
  const parsedBase = new URL(base);
  return parsedUrl.origin === parsedBase.origin && parsedUrl.pathname.startsWith(parsedBase.pathname);
}

function validateAbsoluteReleaseUrl({ add, publicLatestUrl = '', label, url = '', pathRef = '' }) {
  if (!url || !isHttpUrl(url)) {
    return;
  }
  const latestUrl = latestUrlFromWorkerInput(publicLatestUrl);
  if (!latestUrl) {
    add('warning', `${label} URL not checked`, 'Enter the public Player Feed URL before upload validation.');
    return;
  }

  const baseUrl = new URL('.', latestUrl).toString();
  const normalizedUrl = urlString(url);
  const expectedUrl = pathRef && !isHttpUrl(pathRef) ? urlString(resolveSource(latestUrl, pathRef)) : '';
  if (expectedUrl && normalizedUrl !== expectedUrl) {
    add('error', `${label} URL does not match Player Feed URL`, `expected=${expectedUrl}, actual=${normalizedUrl}`);
    return;
  }
  if (!isUrlUnderBase(normalizedUrl, baseUrl)) {
    add('error', `${label} URL is outside Player Feed URL`, `expected base=${baseUrl}, actual=${normalizedUrl}`);
    return;
  }
  add('ok', `${label} URL matches Player Feed URL`, normalizedUrl);
}

function addReleaseCheck(checks, level, label, detail = '') {
  checks.push({ level, label, detail });
}

async function validateRelease({ outDir, publicLatestUrl = '' }) {
  if (!outDir) {
    throw new Error('Output directory is required');
  }

  const checks = [];
  const warnings = [];
  const errors = [];
  const add = (level, label, detail = '') => {
    addReleaseCheck(checks, level, label, detail);
    if (level === 'warning') warnings.push({ label, detail });
    if (level === 'error') errors.push({ label, detail });
  };

  const latestPath = path.join(outDir, 'latest.json');
  if (!(await pathExists(latestPath))) {
    add('error', 'latest.json missing', latestPath);
    return { ok: false, latest: null, checks, warnings, errors };
  }

  let latest = null;
  try {
    latest = await readJsonFile(latestPath);
    add('ok', 'latest.json parsed', latestPath);
  } catch (error) {
    add('error', 'latest.json is invalid JSON', error.message);
    return { ok: false, latest: null, checks, warnings, errors };
  }

  const reportPath = path.join(outDir, 'release-report.json');
  let releaseReport = null;
  if (await pathExists(reportPath)) {
    try {
      releaseReport = await readJsonFile(reportPath);
    } catch (error) {
      add('warning', 'release report invalid JSON', error.message);
    }
  }

  for (const field of ['packId', 'name', 'version']) {
    if (latest[field]) add('ok', `${field} present`, String(latest[field]));
    else add('error', `${field} missing`, 'Required release metadata is missing.');
  }

  const latestUrl = latestUrlFromWorkerInput(publicLatestUrl);
  if (publicLatestUrl) {
    if (latestUrl) {
      add('ok', 'Player Feed URL selected', latestUrl);
    } else {
      add('error', 'Player Feed URL invalid', 'Use the public Cloudflare Worker URL ending in /latest.json.');
    }
  }

  const sourceZip = releaseReport?.sourceZip || {};
  const sourceVersionHint = sourceZip.versionHint || versionHintFromFileName(sourceZip.fileName || sourceZip.path || '');
  if (sourceVersionHint && latest.version) {
    if (normalizedVersion(sourceVersionHint) === normalizedVersion(latest.version)) {
      add('ok', 'ZIP filename version matches manifest', `${sourceZip.fileName || path.basename(sourceZip.path || '')}: ${sourceVersionHint}`);
    } else {
      add(
        'error',
        'ZIP filename version differs from manifest',
        `${sourceZip.fileName || path.basename(sourceZip.path || '')} looks like ${sourceVersionHint}, but manifest/latest.json says ${latest.version}. Fix manifest.json before upload.`
      );
    }
  }

  const packRef = latest.zip?.path || latest.zip?.url;
  validateAbsoluteReleaseUrl({
    add,
    publicLatestUrl,
    label: 'pack ZIP',
    url: latest.zip?.url || '',
    pathRef: latest.zip?.path || ''
  });
  if (!packRef) {
    add('error', 'pack ZIP reference missing', 'latest.zip.path or latest.zip.url is required.');
  }

  let manifestFileCount = 0;
  let overrideFileCount = 0;
  let manifestKeys = new Set();
  let cacheCoverage = {
    total: 0,
    covered: 0,
    missing: [],
    complete: true
  };
  const packPath = localReleasePath(outDir, packRef);
  if (!packPath && packRef) {
    add('warning', 'pack ZIP is remote-only', packRef);
  } else if (packPath) {
    if (!(await pathExists(packPath))) {
      add('error', 'pack ZIP missing', packPath);
    } else {
      const stat = await fs.stat(packPath);
      add('ok', 'pack ZIP found', `${path.relative(outDir, packPath)} (${stat.size} bytes)`);
      if (latest.zip?.size && stat.size !== latest.zip.size) {
        add('error', 'pack ZIP size mismatch', `latest.json=${latest.zip.size}, actual=${stat.size}`);
      } else if (latest.zip?.size) {
        add('ok', 'pack ZIP size matches', String(stat.size));
      } else {
        add('warning', 'pack ZIP size not recorded', 'latest.zip.size is missing.');
      }

      if (latest.zip?.sha256) {
        const actualHash = await hashFile(packPath, 'sha256');
        if (actualHash.toLowerCase() === String(latest.zip.sha256).toLowerCase()) {
          add('ok', 'pack ZIP SHA256 matches', actualHash);
        } else {
          add('error', 'pack ZIP SHA256 mismatch', `latest.json=${latest.zip.sha256}, actual=${actualHash}`);
        }
      } else {
        add('warning', 'pack ZIP SHA256 not recorded', 'latest.zip.sha256 is missing.');
      }

      try {
        const zip = new AdmZip(packPath);
        const manifestEntry = zip.getEntry('manifest.json');
        if (!manifestEntry) {
          add('error', 'CurseForge manifest missing', 'manifest.json was not found in the pack ZIP.');
        } else {
          const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
          const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
          manifestFileCount = manifestFiles.length;
          manifestKeys = new Set(manifestFiles.map((file) => {
            const projectId = file.projectID ?? file.projectId;
            const fileId = file.fileID ?? file.fileId;
            return projectId && fileId ? `${projectId}:${fileId}` : '';
          }).filter(Boolean));
          cacheCoverage = {
            total: manifestKeys.size,
            covered: 0,
            missing: [...manifestKeys],
            complete: manifestKeys.size === 0
          };
          const overridesDir = manifest.overrides || latest.overrides || 'overrides';
          const prefix = `${String(overridesDir).replace(/\/+$/, '')}/`;
          const entries = zip.getEntries();
          overrideFileCount = entries.filter((entry) => !entry.isDirectory && entry.entryName.startsWith(prefix)).length;
          add('ok', 'CurseForge manifest parsed', `${manifestFileCount} mod entries, ${overrideFileCount} override files`);
          const versionLockEntry = entries.find((entry) => {
            const name = entry.entryName.replaceAll('\\', '/');
            return !entry.isDirectory && name.startsWith(`${prefix}mods/`) && /aht-version-lock-.+\.jar$/i.test(path.posix.basename(name));
          });
          if (versionLockEntry) {
            add('ok', 'client version lock mod included', versionLockEntry.entryName);
          } else {
            add('error', 'client version lock mod missing', `${prefix}mods/aht-version-lock-*.jar is required so stale clients cannot bypass the launcher.`);
          }
          if (manifest.minecraft?.version) {
            add('ok', 'Minecraft version present', manifest.minecraft.version);
          } else {
            add('warning', 'Minecraft version missing', 'manifest.minecraft.version is not set.');
          }
        }
      } catch (error) {
        add('error', 'pack ZIP could not be inspected', error.message);
      }
    }
  }

  const cacheRef = latest.cacheManifest?.path || latest.cacheManifest?.url;
  validateAbsoluteReleaseUrl({
    add,
    publicLatestUrl,
    label: 'fallback cache manifest',
    url: latest.cacheManifest?.url || '',
    pathRef: latest.cacheManifest?.path || ''
  });
  const cachePath = localReleasePath(outDir, cacheRef);
  if (!cacheRef) {
    cacheCoverage = {
      total: manifestKeys.size,
      covered: 0,
      missing: [...manifestKeys],
      complete: manifestKeys.size === 0
    };
    add('warning', 'fallback cache manifest missing', 'CurseForge downloads will have no cache fallback.');
  } else if (!cachePath) {
    cacheCoverage = {
      total: manifestKeys.size,
      covered: 0,
      missing: [...manifestKeys],
      complete: manifestKeys.size === 0
    };
    add('warning', 'fallback cache manifest is remote-only', cacheRef);
  } else if (!(await pathExists(cachePath))) {
    cacheCoverage = {
      total: manifestKeys.size,
      covered: 0,
      missing: [...manifestKeys],
      complete: manifestKeys.size === 0
    };
    add('error', 'fallback cache manifest missing', cachePath);
  } else {
    try {
      const cacheManifest = await readJsonFile(cachePath);
      const entries = cacheManifest.entries && typeof cacheManifest.entries === 'object' ? cacheManifest.entries : {};
      const entryList = Object.entries(entries);
      add('ok', 'fallback cache manifest parsed', `${entryList.length} cache entries`);
      if (entryList.length === 0) {
        cacheCoverage = {
          total: manifestKeys.size,
          covered: 0,
          missing: [...manifestKeys],
          complete: manifestKeys.size === 0
        };
        add('warning', 'fallback cache is empty', 'Mods without CurseForge automatic downloads will fail until cache entries are added.');
      } else if (manifestKeys.size) {
        const coveredKeys = entryList.filter(([key]) => manifestKeys.has(key)).map(([key]) => key);
        const missingKeys = [...manifestKeys].filter((key) => !entries[key]);
        cacheCoverage = {
          total: manifestKeys.size,
          covered: coveredKeys.length,
          missing: missingKeys,
          complete: missingKeys.length === 0
        };
        if (missingKeys.length === 0) {
          add('ok', 'fallback cache covers CurseForge manifest', `${coveredKeys.length}/${manifestKeys.size} files`);
        } else {
          add('warning', 'fallback cache coverage is partial', `${coveredKeys.length}/${manifestKeys.size} files; ${missingKeys.length} still depend on CurseForge automatic downloads.`);
        }
      } else {
        cacheCoverage = {
          total: 0,
          covered: 0,
          missing: [],
          complete: true
        };
      }
      for (const [key, entry] of entryList) {
        if (!entry?.url) add('error', `cache entry ${key} missing url`, 'Each fallback entry needs a url.');
        validateAbsoluteReleaseUrl({
          add,
          publicLatestUrl,
          label: `cache entry ${key}`,
          url: entry?.url || ''
        });
        if (!entry?.fileName) add('warning', `cache entry ${key} missing fileName`, 'The installer can infer a name, but explicit names are safer.');
        if (!entry?.sha256 && !entry?.sha1) add('warning', `cache entry ${key} missing hash`, 'Fallback jars should include sha256 or sha1.');
        const cacheFile = localReleasePath(outDir, entry?.url);
        if (cacheFile && !(await pathExists(cacheFile))) {
          add('error', `cache file missing for ${key}`, cacheFile);
        } else if (cacheFile && entry?.sha256) {
          const actualHash = await hashFile(cacheFile, 'sha256');
          if (actualHash.toLowerCase() !== String(entry.sha256).toLowerCase()) {
            add('error', `cache file hash mismatch for ${key}`, `expected=${entry.sha256}, actual=${actualHash}`);
          }
        }
      }
      const extraFiles = Array.isArray(cacheManifest.extraFiles) ? cacheManifest.extraFiles : [];
      if (extraFiles.length) {
        add('ok', 'fallback cache extra local jars indexed', `${extraFiles.length} local jars`);
      }
      for (const [index, entry] of extraFiles.entries()) {
        const label = entry?.fileName || `extra ${index + 1}`;
        if (!entry?.url) {
          add('error', `cache extra file ${label} missing url`, 'Each fallback extra file needs a url.');
          continue;
        }
        validateAbsoluteReleaseUrl({
          add,
          publicLatestUrl,
          label: `cache extra file ${label}`,
          url: entry.url
        });
        const cacheFile = localReleasePath(outDir, entry.url);
        if (cacheFile && !(await pathExists(cacheFile))) {
          add('error', `cache extra file missing for ${label}`, cacheFile);
        } else if (cacheFile && entry?.sha256) {
          const actualHash = await hashFile(cacheFile, 'sha256');
          if (actualHash.toLowerCase() !== String(entry.sha256).toLowerCase()) {
            add('error', `cache extra file hash mismatch for ${label}`, `expected=${entry.sha256}, actual=${actualHash}`);
          }
        }
      }
    } catch (error) {
      cacheCoverage = {
        total: manifestKeys.size,
        covered: 0,
        missing: [...manifestKeys],
        complete: manifestKeys.size === 0
      };
      add('error', 'fallback cache manifest invalid', error.message);
    }
  }

  if (releaseReport) {
    add('ok', 'release report found', reportPath);
  } else {
    add('warning', 'release report missing', reportPath);
  }

  const serverLockRef = latest.serverLock?.configPath || 'server/aht_version_lock.cfg';
  const serverLockPath = localReleasePath(outDir, serverLockRef);
  if (!serverLockPath) {
    add('warning', 'server version lock config is remote-only', serverLockRef);
  } else if (!(await pathExists(serverLockPath))) {
    add('warning', 'server version lock config missing', serverLockPath);
  } else {
    const serverLockConfig = await fs.readFile(serverLockPath, 'utf8');
    const hasPackId = serverLockConfig.includes(`S:requiredPackId=${latest.packId}`);
    const hasVersion = serverLockConfig.includes(`S:requiredVersion=${latest.version}`);
    if (hasPackId && hasVersion) {
      add('ok', 'server version lock config matches release', path.relative(outDir, serverLockPath));
    } else {
      add('error', 'server version lock config mismatch', `Expected ${latest.packId} ${latest.version}`);
    }
  }

  const serverLockModRef = latest.serverLock?.modPath || 'server/mods/aht-version-lock-1.0.0.jar';
  const serverLockModPath = localReleasePath(outDir, serverLockModRef);
  if (!serverLockModPath) {
    add('warning', 'server version lock jar is remote-only', serverLockModRef);
  } else if (!(await pathExists(serverLockModPath))) {
    add('error', 'server version lock jar missing', serverLockModPath);
  } else {
    add('ok', 'server version lock jar bundled', path.relative(outDir, serverLockModPath));
  }

  return {
    ok: errors.length === 0,
    latest: latest ? {
      packId: latest.packId || '',
      name: latest.name || '',
      version: latest.version || '',
      channel: latest.channel || '',
      required: latest.required !== false
    } : null,
    artifacts: {
      outDir,
      latestPath,
      packPath,
      cachePath,
      manifestFileCount,
      overrideFileCount,
      cacheCoverage
    },
    checks,
    warnings,
    errors
  };
}

async function remoteAdminLogin(config, username = '', password = '') {
  const credentials = await loadDeveloperCredentials();
  const loginUsername = String(username || credentials.username || '').trim();
  const loginPassword = String(password || credentials.password || '');
  if (!loginUsername || !loginPassword) {
    return { ok: false, error: 'Developer credentials are not configured on this machine' };
  }
  const base = config.developer?.adminBaseUrl || config.sync?.baseUrl;
  if (!base) {
    return { ok: false, error: 'Developer admin URL is not configured' };
  }
  const url = new URL('admin/login', base.endsWith('/') ? base : `${base}/`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: loginUsername, password: loginPassword })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: body.error || `${response.status} ${response.statusText}` };
  }
  adminToken = body.token || '';
  return { ok: Boolean(adminToken), expiresAt: body.expiresAt || '', error: adminToken ? '' : 'Worker did not return a token' };
}

async function ensureRemoteAdminToken(config) {
  if (adminToken) {
    return;
  }
  const result = await remoteAdminLogin(config);
  if (!result.ok) {
    throw new Error(`Worker admin login failed: ${result.error}`);
  }
}

async function adminFetch(config, route, options = {}) {
  assertDeveloperAuthenticated();
  const base = config.developer?.adminBaseUrl || config.sync?.baseUrl;
  if (!base) {
    throw new Error('Developer admin URL is not configured');
  }
  if (!route.replace(/^\/+/, '').startsWith('admin/login')) {
    await ensureRemoteAdminToken(config);
  }
  const url = new URL(route.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`);
  const fetchWithCurrentToken = async () => {
    const headers = { ...(options.headers || {}) };
    if (adminToken) {
      headers.Authorization = `Bearer ${adminToken}`;
    }
    const response = await fetch(url, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };
  let { response, body } = await fetchWithCurrentToken();
  if (response.status === 401 && !route.replace(/^\/+/, '').startsWith('admin/login')) {
    adminToken = '';
    await ensureRemoteAdminToken(config);
    ({ response, body } = await fetchWithCurrentToken());
  }
  if (!response.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

function minecraftLaunchEnv() {
  return {
    ...process.env,
    DISABLE_RTSS_LAYER: '1',
    DISABLE_VULKAN_OBS_CAPTURE: '1'
  };
}

function spawnDetached(command, args = [], cwd = app.getPath('home'), env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: 'ignore'
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, command, args });
    });
  });
}

async function openMacApplication(args, cwd, env) {
  await spawnLogged('open', args, { cwd, env, timeoutMs: 10_000 });
  return { ok: true, command: 'open', args };
}

async function openMacMinecraftLauncher(cwd, env) {
  const home = app.getPath('home');
  const appPaths = [
    process.env.AHT_MINECRAFT_MAC_APP || '',
    '/Applications/Minecraft.app',
    '/Applications/Minecraft Launcher.app',
    path.join(home, 'Applications', 'Minecraft.app'),
    path.join(home, 'Applications', 'Minecraft Launcher.app')
  ].filter(Boolean);
  let lastError = null;
  for (const appPath of appPaths) {
    if (!(await pathExists(appPath))) {
      continue;
    }
    try {
      return await openMacApplication([appPath], cwd, env);
    } catch (error) {
      lastError = error;
    }
  }
  for (const args of [
    ['-b', 'com.mojang.minecraftlauncher'],
    ['-a', 'Minecraft'],
    ['-a', 'Minecraft Launcher']
  ]) {
    try {
      return await openMacApplication(args, cwd, env);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Minecraft Launcher could not be opened on macOS.${lastError ? ` ${lastError.message}` : ''}`);
}

async function openMinecraftLauncher(config) {
  const cwd = config.minecraftLauncher?.rootDir || app.getPath('home');
  const env = minecraftLaunchEnv();
  if (config.minecraftLauncher?.openCommand) {
    return spawnDetached(config.minecraftLauncher.openCommand, config.minecraftLauncher.openArgs || [], cwd, env);
  }

  if (process.platform === 'win32') {
    const rootLauncher = cwd ? path.join(cwd, 'minecraft.exe') : '';
    if (rootLauncher && await pathExists(rootLauncher)) {
      return spawnDetached(rootLauncher, ['--workDir', cwd], cwd, env);
    }
    const candidates = [
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Minecraft Launcher', 'MinecraftLauncher.exe') : '',
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe') : ''
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return spawnDetached(candidate, [], cwd, env);
      }
    }
    return spawnDetached('explorer.exe', ['shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'], cwd, env);
  }

  if (process.platform === 'darwin') {
    return openMacMinecraftLauncher(cwd, env);
  }

  return spawnDetached('minecraft-launcher', [], cwd, env);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#f5f5f7',
    title: 'A Hard Time Launcher',
    icon: path.join(appRoot, 'build', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(appRoot, 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.on('close', (event) => {
    if (Date.now() < keepOpenUntil) {
      event.preventDefault();
      focusMainWindow();
    }
  });
  mainWindow.loadFile(path.join(appRoot, 'desktop', 'renderer', 'index.html'), {
    query: isDeveloperMode() ? { mode: 'developer' } : {}
  });
}

function focusMainWindow() {
  if (!mainWindow) {
    if (app.isReady()) {
      createWindow();
    }
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

ipcMain.handle('status:get', async () => getStatus());
ipcMain.handle('settings:save', async (_event, config) => saveSettings(config));
ipcMain.handle('settings:testFeed', async (_event, config) => testReleaseFeed(config));
ipcMain.handle('update:start', async (_event, payload = {}) => runUpdate(Boolean(payload.forceRepair)));
ipcMain.handle('update:state', async () => updateState);
ipcMain.handle('launcher:updateStart', async () => runLauncherUpdate());
ipcMain.handle('launcher:updateState', async () => launcherUpdateState);
ipcMain.handle('account:register', async (_event, username) => registerMinecraftUsername(username));
ipcMain.handle('changes:scan', async () => {
  const config = await loadConfig();
  return scanLocalChanges(config.instanceDir);
});
ipcMain.handle('files:scan', async () => {
  const config = await loadConfig();
  const integrity = await scanCurrentManagedIntegrity(config);
  return writeIntegrityState(config, integrity, 'scan');
});
ipcMain.handle('changes:sync', async () => {
  const config = await loadConfig();
  const identity = await identityPayload(config);
  const changes = await scanLocalChanges(config.instanceDir);
  return sendLauncherEvent(config, identity, {
    type: 'local_changes',
    version: null,
    changes
  });
});
ipcMain.handle('play:start', async () => {
  const config = await loadConfig();

  let latest = null;
  try {
    latest = await readLatest(config);
  } catch (error) {
    throw new Error(`Release feed cannot be checked: ${error.message}`);
  }

  const installedPath = path.join(config.instanceDir, '.aht-launcher', 'installed.json');
  const installed = await pathExists(installedPath) ? await readJsonFile(installedPath) : null;
  const integrity = developerClientBypassAllowed()
    ? null
    : await writeIntegrityState(config, await scanCurrentManagedIntegrity(config, latest), 'play-check');
  const minecraftProfile = await inspectMinecraftLauncherProfile({ config, latest, installed });
  const launchState = evaluateLaunchState(config, latest, null, installed, minecraftProfile, integrity);
  if (!launchState.launchReady) {
    throw new Error(launchState.launchBlockedReason);
  }

  keepOpenUntil = Date.now() + 20_000;
  const identity = await identityPayload(config);
  const launcherProof = await writeLauncherProof({
    config,
    identity: launcherProofIdentity(identity),
    latest,
    installed,
    authToken: launcherProofAuthToken()
  });
  const profile = await ensureMinecraftLauncherProfile({ config, latest, installed });
  if (profile.versionId && !profile.loaderInstalled) {
    throw new Error(`Minecraft Launcher is missing loader ${profile.versionId}. Run Update to install Forge automatically.`);
  }
  return {
    ...(await openMinecraftLauncher(config)),
    minecraftProfile: profile,
    launcherProof: {
      proofFile: launcherProof.proofFile || '',
      trusted: Boolean(launcherProof.trusted),
      source: launcherProof.source || ''
    }
  };
});
ipcMain.handle('dialog:zip', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CurseForge exports', extensions: ['zip'] }]
  });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('dialog:json', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Release feed', extensions: ['json'] }]
  });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('dialog:folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('shell:openPath', async (_event, target) => shell.openPath(target));
ipcMain.handle('setup:recommend', async () => setupRecommendations());
ipcMain.handle('setup:apply', async () => applyRecommendedSetup());
ipcMain.handle('dev:buildRelease', async (_event, payload) => {
  assertDeveloperAuthenticated();
  await ensureDir(payload.outDir);
  return buildRelease({
    packZip: payload.packZip,
    outDir: payload.outDir,
    baseUrl: payload.baseUrl,
    channel: payload.channel || 'stable',
    cacheModsDir: payload.cacheModsDir || ''
  });
});
ipcMain.handle('dev:inspectPackZip', async (_event, packZip) => {
  assertDeveloperAuthenticated();
  if (!packZip) {
    throw new Error('Pack ZIP is required');
  }
  const zip = new AdmZip(packZip);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    throw new Error('ZIP does not contain manifest.json');
  }
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  const versionHint = versionHintFromFileName(packZip);
  const version = String(manifest.version || '');
  return {
    name: manifest.name || '',
    version,
    fileName: path.basename(packZip),
    versionHint,
    versionMismatch: Boolean(versionHint && version && normalizedVersion(versionHint) !== normalizedVersion(version)),
    minecraft: manifest.minecraft || null,
    fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0
  };
});
ipcMain.handle('dev:validateRelease', async (_event, payload) => {
  assertDeveloperAuthenticated();
  return validateRelease(payload);
});
ipcMain.handle('dev:cloudLogin', async (_event, payload) => cloudLogin(payload));
ipcMain.handle('dev:cloudSetupBuckets', async (_event, payload) => cloudSetupBuckets(payload));
ipcMain.handle('dev:cloudSetupSecrets', async (_event, payload) => cloudSetupSecrets(payload));
ipcMain.handle('dev:cloudDeployWorker', async (_event, payload) => cloudDeployWorker(payload));
ipcMain.handle('dev:cloudPreflight', async (_event, payload) => cloudPreflight(payload));
ipcMain.handle('dev:writePlayerDefaults', async (_event, payload) => writePlayerDefaults(payload));
ipcMain.handle('dev:syncR2', async (_event, payload) => syncR2(payload));
ipcMain.handle('dev:findLauncherBuilds', async () => findLauncherBuilds());
ipcMain.handle('dev:syncLauncherUpdate', async (_event, payload) => syncLauncherUpdate(payload));
ipcMain.handle('dev:checkLauncherWorkflow', async (_event, payload) => checkLauncherWorkflow(payload));
ipcMain.handle('dev:dispatchLauncherWorkflow', async (_event, payload) => dispatchLauncherWorkflow(payload));
ipcMain.handle('dev:uploadState', async () => uploadState);
ipcMain.handle('dev:planServerTransfer', async (_event, payload) => planServerTransfer(payload));
ipcMain.handle('dev:syncServerFiles', async (_event, payload) => syncServerFiles(payload));
ipcMain.handle('dev:serverTransferState', async () => serverTransferState);
ipcMain.handle('dev:getSecrets', async () => loadDeveloperSecrets());
ipcMain.handle('dev:saveSecrets', async (_event, payload) => saveDeveloperSecrets(payload));
ipcMain.handle('dev:login', async (_event, { username, password }) => {
  assertDeveloperMode();
  const credentials = await loadDeveloperCredentials();
  if (!developerCredentialsConfigured(credentials)) {
    developerSession = null;
    adminToken = '';
    throw new Error('Developer credentials are not configured on this machine. Set AHT_DEVELOPER_PASSWORD or create developer.credentials.json in the app data folder.');
  }
  const normalizedUsername = String(username || '').trim();
  if (normalizedUsername !== credentials.username || password !== credentials.password) {
    developerSession = null;
    adminToken = '';
    throw new Error('Invalid username or password');
  }
  const expiresAt = Date.now() + DEVELOPER_SESSION_MS;
  developerSession = { username: normalizedUsername, expiresAt };
  adminToken = '';
  const config = await loadConfig();
  const remotePromise = remoteAdminLogin(config, normalizedUsername, password).catch((error) => ({
    ok: false,
    error: error.message
  }));
  const remote = await Promise.race([
    remotePromise,
    sleep(650).then(() => ({ ok: false, pending: true, error: 'Worker admin login is still connecting' }))
  ]);
  if (remote.pending) {
    remotePromise.then((lateRemote) => {
      if (!lateRemote.ok) console.warn(`Worker admin login failed after local developer login: ${lateRemote.error || 'unknown error'}`);
    }).catch(() => {});
  }
  return {
    ok: true,
    expiresAt: new Date(expiresAt).toISOString(),
    remoteAuthenticated: Boolean(remote.ok),
    remotePending: Boolean(remote.pending),
    remoteExpiresAt: remote.expiresAt || '',
    remoteError: remote.ok || remote.pending ? '' : remote.error
  };
});
ipcMain.handle('dev:summary', async () => adminFetch(await loadConfig(), 'admin/summary'));
ipcMain.handle('dev:events', async (_event, limit = 50) => adminFetch(await loadConfig(), `admin/events?limit=${limit}`));
ipcMain.handle('dev:updateLogs', async (_event, limit = 20) => adminFetch(await loadConfig(), `admin/update-logs?limit=${limit}`));
ipcMain.handle('dev:publishUpdateLog', async (_event, payload) => adminFetch(await loadConfig(), 'admin/update-logs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload || {})
}));

if (!singleInstanceLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      focusMainWindow();
    }
  });
}
