import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { CLIENT_PACK_FORMAT, CLIENT_PACK_METADATA_ENTRY } from '../src/clientPackFormat.js';
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
import { defaultInstanceDirForPlatform, platformKey, platformProfile } from '../src/platformProfile.js';
import { writeLauncherProof } from '../src/launcherProof.js';
import { selectLauncherArtifact, validateLauncherUpdateManifest } from '../src/launcherUpdateManifest.js';

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

const DEFAULT_SERVER_TRANSFER_INCLUDED_DIRS = ['mods', 'scripts', 'config', 'ForgeEssentials'];
const LAUNCHER_WORKFLOW_DEFAULTS = {
  repo: 'svre-mc/aht-launcher',
  branch: 'main',
  workflow: 'build-macos.yml'
};

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeTestStartupProbe(stage, extra = {}) {
  if (process.env.AHT_TEST_HOOKS !== '1') return;
  const probePath = String(process.env.AHT_TEST_STARTUP_PROBE_PATH || '').trim();
  if (!probePath) return;
  try {
    const dir = path.dirname(probePath);
    if (dir) fsSync.mkdirSync(dir, { recursive: true });
    const payload = {
      stage,
      argv: process.argv,
      execPath: process.execPath,
      cwd: process.cwd(),
      appRoot,
      userData: app.getPath('userData'),
      testRemoteDebugPort: process.env.AHT_TEST_REMOTE_DEBUG_PORT || '',
      testHooks: process.env.AHT_TEST_HOOKS || '',
      ...extra
    };
    fsSync.appendFileSync(probePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // Test-only diagnostics must never block normal launcher startup.
  }
}

function configureTestRemoteDebugPort() {
  if (process.env.AHT_TEST_HOOKS !== '1') return;
  const rawPort = String(process.env.AHT_TEST_REMOTE_DEBUG_PORT || '').trim();
  writeTestStartupProbe('before-remote-debug-hook', { rawPort });
  if (!/^\d{2,5}$/.test(rawPort)) return;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
  writeTestStartupProbe('after-remote-debug-hook', { port });
}

configureTestRemoteDebugPort();

let releaseBuilderModulePromise = null;
let clientModpackZipModulePromise = null;
let serverTransferModulePromise = null;
let githubActionsModulePromise = null;
let r2DirectUploadModulePromise = null;

function developerModuleRelativePath(appRelativePath = '') {
  return String(appRelativePath || '').replace(/^[.][.][\\/]/, '');
}

function developerSourceRoots() {
  const roots = [
    process.env.AHT_LAUNCHER_SOURCE_ROOT,
    process.env.INIT_CWD,
    process.env.npm_config_local_prefix,
    process.cwd()
  ].filter(Boolean);
  return [...new Set(roots.map((item) => path.resolve(item)))];
}

async function importDeveloperModule(appRelativePath) {
  const relativePath = developerModuleRelativePath(appRelativePath);
  const packagedPath = path.join(appRoot, relativePath);
  try {
    return await import(appRelativePath);
  } catch (error) {
    if (await pathExists(packagedPath)) {
      throw error;
    }
    const attempted = [];
    for (const root of developerSourceRoots()) {
      const candidate = path.join(root, relativePath);
      attempted.push(candidate);
      if (await pathExists(candidate)) {
        return import(pathToFileURL(candidate).href);
      }
    }
    const wrapped = new Error(
      `Developer module ${relativePath} is not packaged in the public player app. ` +
      `Set AHT_LAUNCHER_SOURCE_ROOT to the local aht-launcher repo for private developer mode. ` +
      `Tried: ${attempted.join('; ') || 'none'}. Original error: ${error.message}`
    );
    wrapped.cause = error;
    throw wrapped;
  }
}
function loadReleaseBuilderModule() {
  releaseBuilderModulePromise ||= importDeveloperModule('../src/releaseBuilder.js');
  return releaseBuilderModulePromise;
}

function loadClientModpackZipModule() {
  clientModpackZipModulePromise ||= importDeveloperModule('../src/clientModpackZip.js');
  return clientModpackZipModulePromise;
}

function loadServerTransferModule() {
  serverTransferModulePromise ||= importDeveloperModule('../src/serverTransfer.js');
  return serverTransferModulePromise;
}

function loadGithubActionsModule() {
  githubActionsModulePromise ||= importDeveloperModule('../src/githubActions.js');
  return githubActionsModulePromise;
}

function loadR2DirectUploadModule() {
  r2DirectUploadModulePromise ||= importDeveloperModule('../src/r2DirectUpload.js');
  return r2DirectUploadModulePromise;
}
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
const DEVELOPER_SECRET_KEYS = ['curseforgeApiKey', 'serverSshPassword', 'launcherProofSecret', 'githubToken', 'r2AccountId', 'r2AccessKeyId', 'r2SecretAccessKey'];
let launcherModeCache = null;
function createOperationState(kind, phase = 'Preparing') {
  return {
    running: true,
    kind,
    startedAt: new Date().toISOString(),
    completedAt: null,
    lines: [],
    lastResult: null,
    error: null,
    progress: { phase, completed: 0, total: 0, percent: 0 }
  };
}

function completeOperationState(state, result, phase = 'Complete') {
  const previous = state.progress || {};
  const total = Number(previous.total || previous.completed || 0);
  state.running = false;
  state.completedAt = new Date().toISOString();
  state.error = null;
  state.lastResult = result;
  state.progress = {
    ...previous,
    phase,
    completed: total || previous.completed || 0,
    total,
    percent: 100
  };
}

function failOperationState(state, error, phase = 'Failed') {
  const previous = state.progress || {};
  state.running = false;
  state.completedAt = new Date().toISOString();
  state.error = error?.message || String(error || 'Unknown error');
  state.progress = { ...previous, phase, percent: 100 };
}


function rawRequestedDeveloperMode() {
  return process.argv.includes('--developer') || process.env.AHT_DEVELOPER === '1';
}
function explicitUserDataDirArg() {
  const inline = process.argv.find((arg) => arg.startsWith('--user-data-dir='));
  if (inline) {
    return inline.slice('--user-data-dir='.length);
  }
  const index = process.argv.indexOf('--user-data-dir');
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

const launchMode = rawRequestedDeveloperMode() ? 'developer' : 'player';
const explicitUserDataDir = explicitUserDataDirArg();

if (launchMode === 'developer') {
  app.setName('AHT Developer Launcher');
  if (!explicitUserDataDir) {
    app.setPath('userData', path.join(app.getPath('appData'), 'aht-launcher-developer'));
  }
}

if (process.platform === 'win32') {
  app.setAppUserModelId(launchMode === 'developer' ? 'com.ahardtime.launcher.developer' : 'com.ahardtime.launcher');
}

migrateDeveloperEncryptionProfile();

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

function readJsonSync(file) {
  try {
    return JSON.parse(fsSync.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function storedSecretValue(file, key) {
  return String(file?.secrets?.[key]?.value || '');
}

function hasEncryptedStoredSecret(file, key) {
  return Boolean(file?.secrets?.[key]?.encrypted && storedSecretValue(file, key));
}

function developerSecretsUseLegacyKey(currentSecrets, legacySecrets) {
  if (!currentSecrets?.secrets || !legacySecrets?.secrets) {
    return true;
  }
  return DEVELOPER_SECRET_KEYS.some((key) => (
    hasEncryptedStoredSecret(currentSecrets, key)
    && storedSecretValue(currentSecrets, key) === storedSecretValue(legacySecrets, key)
  ));
}

function migrateDeveloperEncryptionProfile() {
  if (launchMode !== 'developer' || explicitUserDataDir) {
    return;
  }
  const currentDir = app.getPath('userData');
  const legacyDir = path.join(app.getPath('appData'), 'aht-launcher');
  if (path.normalize(currentDir).toLowerCase() === path.normalize(legacyDir).toLowerCase()) {
    return;
  }
  const legacyLocalState = path.join(legacyDir, 'Local State');
  const currentLocalState = path.join(currentDir, 'Local State');
  const legacySecrets = readJsonSync(path.join(legacyDir, 'developer.secrets.json'));
  const currentSecrets = readJsonSync(path.join(currentDir, 'developer.secrets.json'));
  if (!fsSync.existsSync(legacyLocalState) || !legacySecrets?.secrets) {
    return;
  }
  if (fsSync.existsSync(currentLocalState) && !developerSecretsUseLegacyKey(currentSecrets, legacySecrets)) {
    return;
  }
  fsSync.mkdirSync(currentDir, { recursive: true });
  fsSync.copyFileSync(legacyLocalState, currentLocalState);
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

  if (launchMode !== 'developer' || explicitUserDataDir) {
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

function defaultReleaseOutDir() {
  return path.join(app.getPath('userData'), 'release-builder');
}

function resolveReleaseOutDir(value = '') {
  const normalized = String(value || '').trim();
  return normalized ? normalized : defaultReleaseOutDir();
}

function isCurseForgeInstanceDir(value = '') {
  const normalized = String(value || '').replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/curseforge/minecraft/instances/');
}

function isCurseForgeMinecraftRoot(value = '') {
  const normalized = String(value || '').replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/curseforge/minecraft/install');
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
      defaultOutDir: defaultReleaseOutDir(),
      defaultCacheModsDir: defaultCacheModsDir(),
      r2Bucket: 'ahtlauncher',
      r2AccountId: '',
      githubRepo: LAUNCHER_WORKFLOW_DEFAULTS.repo,
      githubBranch: LAUNCHER_WORKFLOW_DEFAULTS.branch,
      githubWorkflow: LAUNCHER_WORKFLOW_DEFAULTS.workflow
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
      sourceDir: process.env.AHT_SERVER_TRANSFER_SOURCE_DIR || '',
      host: process.env.AHT_SERVER_TRANSFER_HOST || '',
      port: 22,
      username: process.env.AHT_SERVER_TRANSFER_USERNAME || '',
      remoteDir: process.env.AHT_SERVER_TRANSFER_REMOTE_DIR || '',
      excludeDirs: ['DregoraRL'],
      includeDirs: DEFAULT_SERVER_TRANSFER_INCLUDED_DIRS,
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

function defaultPlayerInstanceDir() {
  return defaultInstanceDirForPlatform(process.platform, {
    ...process.env,
    HOME: process.env.HOME || app.getPath('home'),
    USERPROFILE: process.env.USERPROFILE || app.getPath('home')
  });
}

function defaultDeveloperInstanceDir() {
  if (process.platform === 'win32') {
    return path.join(ahtInstallRoot(), 'A Hard Time Developer');
  }
  if (process.platform === 'darwin') {
    return path.join(app.getPath('appData'), 'A Hard Time', 'Developer Instance');
  }
  platformKey(process.platform);
}

function defaultInstanceDir() {
  return isDeveloperMode() ? defaultDeveloperInstanceDir() : defaultPlayerInstanceDir();
}

function isPlayerDefaultInstanceDir(value = '') {
  return Boolean(value) && samePath(value, defaultPlayerInstanceDir());
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
  const normalRoots = minecraftRootCandidates(process.platform, {
    ...process.env,
    HOME: process.env.HOME || app.getPath('home'),
    USERPROFILE: process.env.USERPROFILE || app.getPath('home')
  });
  return [...new Set([
    ...normalRoots,
    path.join(home, 'curseforge', 'minecraft', 'Install'),
    path.join(documents, 'CurseForge', 'minecraft', 'Install')
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
          fallback: isCurseForgeMinecraftRoot(item),
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
  candidates.sort((a, b) => Number(a.fallback) - Number(b.fallback) || b.score - a.score);
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
  merged.developer.defaultOutDir = resolveReleaseOutDir(merged.developer?.defaultOutDir);
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
    await writeJsonFile(file, configForStorage(defaults));
    return defaults;
  }
  const stored = await readJsonFile(file);
  const config = mergeConfig(defaults, stored);
  let changed = false;
  if (!isDeveloperMode() && ('developer' in (stored || {}) || 'serverTransfer' in (stored || {}))) {
    changed = true;
  }
  const migrateDeveloperPlayableDir = isDeveloperMode() && isPlayerDefaultInstanceDir(stored.instanceDir);
  if (!stored.instanceDir || isCurseForgeInstanceDir(stored.instanceDir) || isOldLauncherInstanceDir(stored.instanceDir) || migrateDeveloperPlayableDir) {
    config.instanceDir = defaultInstanceDir();
    changed = true;
  }
  if (
    !config.playCommand?.cwd
    || isCurseForgeInstanceDir(config.playCommand.cwd)
    || isOldLauncherInstanceDir(config.playCommand.cwd)
    || (isDeveloperMode() && isPlayerDefaultInstanceDir(config.playCommand.cwd))
  ) {
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
  if (!isDeveloperMode() && isCurseForgeMinecraftRoot(config.minecraftLauncher?.rootDir) && !isCurseForgeMinecraftRoot(defaults.minecraftLauncher?.rootDir)) {
    config.minecraftLauncher.rootDir = defaults.minecraftLauncher.rootDir || defaultMinecraftRoot();
    changed = true;
  }
  if (!Number.isFinite(Number(stored.minecraftLauncher?.memoryMb))) {
    config.minecraftLauncher.memoryMb = 4096;
    changed = true;
  }
  if (!isDeveloperMode()) {
    for (const key of ['enabled', 'required', 'baseUrl', 'keyId']) {
      const value = defaults.launcherProof?.[key];
      if (value !== undefined && config.launcherProof?.[key] !== value) {
        config.launcherProof = { ...config.launcherProof, [key]: value };
        changed = true;
      }
    }
  }
  if (!Object.prototype.hasOwnProperty.call(stored.developer || {}, 'defaultCacheModsDir') && defaults.developer?.defaultCacheModsDir) {
    config.developer.defaultCacheModsDir = defaults.developer.defaultCacheModsDir;
    changed = true;
  }
  if (!String(stored.developer?.defaultOutDir || '').trim()) {
    config.developer.defaultOutDir = resolveReleaseOutDir(config.developer?.defaultOutDir);
    changed = true;
  }
  await ensureDir(config.instanceDir);
  if (changed) {
    await writeJsonFile(file, configForStorage(config));
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
    launcherProof: { ...current.launcherProof, ...nextConfig.launcherProof },
    serverTransfer: { ...current.serverTransfer, ...nextConfig.serverTransfer },
    minecraftLauncher: { ...current.minecraftLauncher, ...nextConfig.minecraftLauncher },
    playCommand: { ...current.playCommand, ...nextConfig.playCommand }
  };
  merged.developer.defaultOutDir = resolveReleaseOutDir(merged.developer?.defaultOutDir);
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
  await writeJsonFile(configPath(), configForStorage(merged));
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
  const safeConfig = rendererStatusConfig(config);
  try {
    return {
      config: safeConfig,
      ...minecraftProfileResultForRenderer(await refreshMinecraftLauncherProfile(config))
    };
  } catch (error) {
    return {
      config: safeConfig,
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
      cwd: !playCwd || isCurseForgeInstanceDir(playCwd) || isOldLauncherInstanceDir(playCwd) || (isDeveloperMode() && isPlayerDefaultInstanceDir(playCwd)) ? instanceDir : playCwd
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
  return isDeveloperMode();
}

function developerAdminSessionAllowed() {
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
  return developerAdminSessionAllowed() ? adminToken : '';
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

function validateLatestReleaseFeed(latest, source = 'latest.json') {
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) {
    throw new Error(`Release feed is invalid: ${source} must be a JSON object.`);
  }
  const missing = [];
  if (!latest.name) missing.push('name');
  if (!latest.version) missing.push('version');
  if (!latest.zip?.url && !latest.zip?.path) missing.push('zip.url or zip.path');
  if (missing.length) {
    throw new Error(`Release feed is missing: ${missing.join(', ')}.`);
  }
  return latest;
}

function isFullClientRelease(latest = null) {
  return Boolean(latest && (
    latest.installMode === 'full-client-zip'
    || latest.zipFormat === CLIENT_PACK_FORMAT
  ));
}

function playerFullClientReleaseBlockReason(latest = null) {
  const versionText = latest?.version ? ` version ${latest.version}` : ' this version';
  return `Update package is not ready. A verified AHT client package has not been published for${versionText} yet.`;
}

function playerUpdateBlockedReason(latest = null, options = {}) {
  if (!latest || options.allowLegacyRelease || latest.required === false || isFullClientRelease(latest)) {
    return '';
  }
  return playerFullClientReleaseBlockReason(latest);
}

function requirePlayerFullClientRelease(latest = null, options = {}) {
  const reason = playerUpdateBlockedReason(latest, options);
  if (reason) {
    throw new Error(reason);
  }
}

async function readLatest(config) {
  if (!config.latestUrl) {
    return null;
  }
  return validateLatestReleaseFeed(await readJsonFromSource(config.latestUrl), config.latestUrl);
}

async function expectedCacheExtraManagedFiles(config, latest = null) {
  if (!config?.latestUrl) {
    return [];
  }
  const release = latest || await readLatest(config);
  if (isFullClientRelease(release)) {
    return [];
  }
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
      relativePath: normalizeRelPath(entry.installPath || `mods/${entry.fileName}`),
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

function developerBypassIntegrityState(config, source = 'developer-bypass') {
  return {
    generatedAt: new Date().toISOString(),
    instanceDir: config.instanceDir,
    valid: true,
    counts: {
      managed: 0,
      checked: 0,
      ok: 0,
      changed: 0,
      missing: 0,
      corrupted: 0
    },
    changed: [],
    missing: [],
    truncated: false,
    source,
    developerClientBypass: true
  };
}

function developerBypassLocalChangesState(config, source = 'developer-bypass') {
  return {
    generatedAt: new Date().toISOString(),
    instanceDir: config.instanceDir,
    counts: {
      managed: 0,
      changed: 0,
      missing: 0,
      added: 0
    },
    changed: [],
    missing: [],
    added: [],
    truncated: false,
    source,
    developerClientBypass: true
  };
}
function cacheExtraZipPathIssue(integrity) {
  const issues = [...(integrity?.changed || []), ...(integrity?.missing || [])];
  if (!issues.length || integrity?.source === 'status-refresh') {
    return false;
  }
  return issues.every((item) => {
    const relPath = normalizeRelPath(String(item?.path || ''));
    return item?.source === 'cache-extra' && relPath.startsWith('mods/') && relPath.toLowerCase().endsWith('.zip');
  });
}

async function refreshStaleIntegrityState(config, latest, integrity) {
  if (!latest || !cacheExtraZipPathIssue(integrity)) {
    return integrity;
  }
  try {
    const refreshed = await scanCurrentManagedIntegrity(config, latest);
    if (refreshed.valid || refreshed.counts?.corrupted !== integrity?.counts?.corrupted) {
      return writeIntegrityState(config, refreshed, 'status-refresh');
    }
  } catch (error) {
    console.warn(`Unable to refresh stale integrity state: ${error.message || error}`);
  }
  return integrity;
}
function integrityBlockReason(integrity) {
  if (!integrity) return '';
  const counts = integrity.counts || {};
  if (!counts.managed) {
    return 'Repair required. The installed file manifest is missing.';
  }
  if (counts.corrupted > 0) {
    const parts = [];
    if (counts.changed) parts.push(`${counts.changed} changed`);
    if (counts.missing) parts.push(`${counts.missing} missing`);
    if (counts.added) parts.push(`${counts.added} extra`);
    const detail = parts.length ? ` (${parts.join(', ')})` : '';
    return `Repair required. ${counts.corrupted} mod file issue${counts.corrupted === 1 ? '' : 's'} found${detail}.`;
  }
  return '';
}

function minecraftProfileInstallTargets(profile = null) {
  const seen = new Set();
  const targets = [];
  for (const item of [profile, ...(Array.isArray(profile?.syncedProfiles) ? profile.syncedProfiles : [])]) {
    if (!item?.rootDir || !item?.versionId) continue;
    const key = `${path.resolve(item.rootDir).toLowerCase()}|${item.versionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(item);
  }
  return targets;
}

function missingForgeLoaderProfiles(profile = null) {
  return minecraftProfileInstallTargets(profile).filter((item) => (
    item.versionId
    && item.loaderId?.startsWith('forge-')
    && !item.loaderInstalled
  ));
}

function minecraftRootSummary(items = []) {
  return items.map((item) => item.rootDir || 'unknown root').join(', ');
}

async function installMinecraftProfileLoaders(profile, { config, latest, installed, operationState = null } = {}) {
  const missing = missingForgeLoaderProfiles(profile);
  if (!missing.length) return profile;
  const total = missing.length;
  for (const [index, target] of missing.entries()) {
    if (operationState) {
      operationState.progress = {
        phase: `Installing Forge (${index + 1}/${total})`,
        completed: index,
        total,
        percent: 97
      };
      operationState.lines.push(`Installing Forge ${target.versionId} for Minecraft Launcher root ${target.rootDir}...`);
    }
    const forgeLines = [];
    await installForgeLoader(target, {
      javaPath: config.minecraftLauncher?.javaPath || 'java',
      installerUrl: target.loaderInstallerUrl || latest?.minecraft?.forgeInstallerUrl || latest?.minecraft?.loaderInstallerUrl || '',
      logger: { log: (line) => forgeLines.push(String(line)) }
    });
    if (operationState) {
      operationState.lines.push(...forgeLines);
      operationState.lines.push(`Forge ${target.versionId} is ready in ${target.rootDir}.`);
    }
  }
  const refreshed = await ensureMinecraftLauncherProfile({ config, latest, installed });
  const stillMissing = missingForgeLoaderProfiles(refreshed);
  if (stillMissing.length) {
    throw new Error(`Forge ${stillMissing[0].versionId} did not appear in all Minecraft Launcher roots: ${minecraftRootSummary(stillMissing)}`);
  }
  return refreshed;
}

function evaluateLaunchState(config, latest, latestError, installed, minecraftProfile = null, integrity = null, options = {}) {
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

  const updateBlockedReason = playerUpdateBlockedReason(latest, {
    allowLegacyRelease: Boolean(options.allowLegacyRelease)
  });
  if (updateBlockedReason) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: updateBlockedReason
    };
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

  const missingLoaders = options.skipLoaderCheck ? [] : missingForgeLoaderProfiles(minecraftProfile);
  if (missingLoaders.length) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: `Minecraft Launcher is missing loader ${missingLoaders[0].versionId} in ${missingLoaders.length} launcher root${missingLoaders.length === 1 ? '' : 's'}. Run Update or Play through AHT Launcher to install Forge automatically.`
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

  const latest = validateLatestReleaseFeed(await readJsonFromSource(latestUrl), latestUrl);
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
      installMode: latest.installMode || '',
      fullClientZip: isFullClientRelease(latest),
      playerInstallReady: isFullClientRelease(latest),
      playerBlockedReason: playerUpdateBlockedReason(latest),
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
    const validation = validateLauncherUpdateManifest(manifest, {
      latestUrl,
      requireDownloads: false,
      requireAllPlatforms: false,
      allowInsecureLocalhost: process.env.AHT_TEST_ALLOW_INSECURE_LAUNCHER_UPDATE === '1'
    });
    if (!validation.ok) {
      throw new Error(`Launcher update feed is invalid: ${validation.errors.join('; ')}`);
    }
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

function playerSafeConfig(config = {}) {
  const { developer, serverTransfer, ...safeConfig } = config;
  return safeConfig;
}

function configForStorage(config = {}) {
  return isDeveloperMode() ? config : playerSafeConfig(config);
}

function rendererStatusConfig(config = {}) {
  return isDeveloperMode() ? config : playerSafeConfig(config);
}

function setupForRenderer(setup = {}) {
  if (isDeveloperMode()) {
    return setup;
  }
  return {
    instanceExists: Boolean(setup.instanceExists),
    latestConfigured: Boolean(setup.latestConfigured),
    canAutoConfigure: Boolean(setup.canAutoConfigure),
    minecraftAccountReuseAvailable: Boolean(setup.minecraftAccountReuseAvailable)
  };
}

function platformProfileForRenderer(profile = {}) {
  if (isDeveloperMode()) {
    return profile;
  }
  const { instanceDir, ...safeProfile } = profile;
  return safeProfile;
}

function configPathForRenderer() {
  return isDeveloperMode() ? configPath() : '';
}

function minecraftProfileForRenderer(profile = null) {
  if (!profile || isDeveloperMode()) {
    return profile;
  }
  return {
    enabled: profile.enabled !== false,
    profileId: profile.profileId || '',
    profileName: profile.profileName || '',
    profileExists: Boolean(profile.profileExists),
    versionId: profile.versionId || '',
    loaderInstalled: Boolean(profile.loaderInstalled),
    minecraftVersion: profile.minecraftVersion || '',
    loaderId: profile.loaderId || '',
    accountReuseAvailable: Boolean(profile.accountReuseAvailable)
  };
}

function minecraftProfileResultForRenderer(result = {}) {
  if (isDeveloperMode() || !result?.minecraftProfile) {
    return result;
  }
  return {
    ...result,
    minecraftProfile: minecraftProfileForRenderer(result.minecraftProfile)
  };
}

function launcherProofForRenderer(proof = {}) {
  if (isDeveloperMode()) {
    return proof;
  }
  return {
    trusted: Boolean(proof.trusted),
    source: proof.source || ''
  };
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
  const developerClientBypass = developerClientBypassAllowed();
  let integrity = developerClientBypass ? developerBypassIntegrityState(config) : await readIntegrityState(config);
  if (!developerClientBypass) {
    integrity = await refreshStaleIntegrityState(config, latest, integrity);
  }
  const launchLatest = latest || (developerClientBypass && installed ? installed : null);
  const launchLatestError = developerClientBypass && installed ? null : latestError;
  const minecraftProfile = await inspectMinecraftLauncherProfile({ config, latest: launchLatest, installed });
  const launchIntegrity = developerClientBypass ? null : integrity;
  const updateBlockedReason = !developerClientBypass ? playerUpdateBlockedReason(latest) : '';
  const updateRequired = !developerClientBypass && !updateBlockedReason && latest && latest.required !== false
    ? installed?.version !== latest.version
    : false;
  const launchState = evaluateLaunchState(config, launchLatest, launchLatestError, installed, minecraftProfile, launchIntegrity, {
    skipLoaderCheck: true,
    allowLegacyRelease: developerClientBypass
  });
  const launcherUpdate = await readLauncherUpdate(config);
  return {
    developerMode: isDeveloperMode(),
    developerClientBypass,
    appVersion: app.getVersion(),
    platformProfile: platformProfileForRenderer(platformProfile(process.platform, {
      ...process.env,
      HOME: process.env.HOME || app.getPath('home'),
      USERPROFILE: process.env.USERPROFILE || app.getPath('home')
    })),
    config: rendererStatusConfig(config),
    configPath: configPathForRenderer(),
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
    setup: setupForRenderer(await setupRecommendations(config)),
    minecraftProfile: minecraftProfileForRenderer(minecraftProfile),
    latest,
    latestError,
    updateLogs,
    updateLogsError,
    launcherUpdate,
    installed,
    integrity,
    updateBlockedReason,
    updateRequired,
    ...launchState
  };
}

async function runUpdate(forceRepair = false, options = {}) {
  if (updateState.running) {
    updateState.lines.push(`${forceRepair ? 'Repair' : 'Update'} request ignored because an install is already running.`);
    return updateState;
  }
  updateState = createOperationState(forceRepair ? 'repair' : 'install', forceRepair ? 'Preparing repair' : 'Preparing update');
  let config = null;
  let identity = null;
  try {
    config = await loadConfig();
    identity = await identityPayload(config);
    if (!config.latestUrl) {
      throw new Error('latestUrl is not configured');
    }
    const latestBeforeInstall = await readLatest(config);
    if (!developerClientBypassAllowed()) {
      requirePlayerFullClientRelease(latestBeforeInstall);
    }
    await sendLauncherEvent(config, identity, {
      type: forceRepair ? 'repair_started' : 'install_started',
      version: null
    }).catch((error) => updateState.lines.push(`Sync warning: ${error.message}`));
    const result = await installPack({
      latestSource: config.latestUrl,
      instanceDir: config.instanceDir,
      cfProxyBaseUrl: config.curseforge?.proxyBaseUrl || '',
      cfApiKey: process.env[config.curseforge?.apiKeyEnv || 'CURSEFORGE_API_KEY'] || '',
      forceRepair,
      replaceGameSettings: Boolean(options.replaceGameSettings),
      onProgress: (progress) => {
        updateState.progress = progress;
      },
      logger: { log: (line) => updateState.lines.push(String(line)) }
    });
    let latestAfterInstall = null;
    if (config.minecraftLauncher?.enabled !== false) {
      try {
        latestAfterInstall = await readLatest(config);
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
        profile = await installMinecraftProfileLoaders(profile, {
          config,
          latest: latestAfterInstall,
          installed: result.installed,
          operationState: updateState
        });
        result.minecraftProfile = profile;
      } catch (error) {
        throw new Error(`Minecraft Launcher setup failed: ${error.message}`);
      }
    }
    updateState.progress = { ...(updateState.progress || {}), phase: 'Verifying installed files', percent: 98 };
    const integrity = await scanCurrentManagedIntegrity(config, latestAfterInstall);
    await writeIntegrityState(config, integrity, forceRepair ? 'repair' : 'install');
    await sendLauncherEvent(config, identity, {
      type: forceRepair ? 'repair_completed' : 'install_completed',
      version: result.installed?.version || null,
      manifestFileCount: result.installed?.manifestFileCount || 0,
      overrideFileCount: result.installed?.overrideFileCount || 0
    }).catch((error) => updateState.lines.push(`Sync warning: ${error.message}`));
    completeOperationState(updateState, result, 'Complete');
    return result;
  } catch (error) {
    failOperationState(updateState, error, forceRepair ? 'Repair failed' : 'Update failed');
    if (config && identity) {
      await sendLauncherEvent(config, identity, {
        type: forceRepair ? 'repair_failed' : 'install_failed',
        error: updateState.error
      }).catch(() => {});
    }
    throw error;
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

function windowsLauncherInstallerArgs(artifact = {}, targetExe = '') {
  const args = defaultLauncherInstallerArgs(artifact).filter(Boolean);
  const targetDir = targetExe ? path.dirname(targetExe) : '';
  const hasTargetDir = args.some((arg) => /^\/D=/i.test(String(arg || '')));
  if (targetDir && !hasTargetDir) {
    return [...args, `/D=${targetDir}`];
  }
  return args;
}

function windowsPowerShellPath() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function windowsCommandPromptPath() {
  return process.env.ComSpec || (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : 'cmd.exe');
}

function launcherUpdateInstalledExePath() {
  if (process.platform !== 'win32') return '';
  return process.execPath || '';
}

function launcherUpdateHelperBatch(scriptPath, bootstrapLogPath) {
  return [
    '@echo off',
    'setlocal',
    `>> "${bootstrapLogPath}" echo %DATE% %TIME% Launcher update helper bootstrap started.`,
    `"${windowsPowerShellPath()}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" >> "${bootstrapLogPath}" 2>&1`,
    `>> "${bootstrapLogPath}" echo %DATE% %TIME% Launcher update helper bootstrap exited with %ERRORLEVEL%.`,
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n');
}

function launcherUpdateHelperScript(payloadPath) {
  return `
$ErrorActionPreference = 'Stop'
$payloadPath = ${JSON.stringify(payloadPath)}
$payload = Get-Content -LiteralPath $payloadPath -Raw | ConvertFrom-Json
$logPath = [string]$payload.logPath
function Write-UpdateLog([string]$message) {
  try {
    $parent = Split-Path -Parent $logPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString('o') + ' ' + $message) -Encoding UTF8
  } catch {}
}
try {
  Write-UpdateLog ('Waiting for old launcher PID ' + $payload.oldPid)
  if ($env:AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY -eq '1') {
    Write-UpdateLog 'Test mode helper startup confirmed.'
    exit 0
  }
  if ([int]$payload.oldPid -gt 0) {
    try {
      $old = Get-Process -Id ([int]$payload.oldPid) -ErrorAction SilentlyContinue
      if ($old) { Wait-Process -Id ([int]$payload.oldPid) -Timeout 120 -ErrorAction SilentlyContinue }
    } catch {}
  }
  Start-Sleep -Milliseconds 600
  $installerArgs = @()
  if ($payload.installerArgs) {
    foreach ($arg in $payload.installerArgs) { $installerArgs += [string]$arg }
  }
  Write-UpdateLog ('Running installer ' + $payload.installerPath)
  $installer = Start-Process -FilePath ([string]$payload.installerPath) -ArgumentList $installerArgs -Wait -PassThru -WindowStyle Hidden
  $exitCode = 0
  if ($null -ne $installer.ExitCode) { $exitCode = [int]$installer.ExitCode }
  if ($exitCode -ne 0) { throw ('Installer exited with code ' + $exitCode) }
  $target = [string]$payload.targetExe
  $expected = [string]$payload.expectedVersion
  $ready = $false
  for ($i = 0; $i -lt 160; $i += 1) {
    if ($target -and (Test-Path -LiteralPath $target)) {
      $versionOk = $true
      if ($expected) {
        try {
          $productVersion = [string](Get-Item -LiteralPath $target).VersionInfo.ProductVersion
          if ($productVersion) { $versionOk = $productVersion.StartsWith($expected) }
        } catch {}
      }
      if ($versionOk) { $ready = $true; break }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw ('Updated launcher executable was not ready: ' + $target) }
  try {
    $iconRefresh = Join-Path $env:windir 'System32\\ie4uinit.exe'
    if (Test-Path -LiteralPath $iconRefresh) { Start-Process -FilePath $iconRefresh -ArgumentList '-show' -Wait -WindowStyle Hidden }
  } catch {}
  Start-Sleep -Milliseconds 500
  Write-UpdateLog ('Starting updated launcher ' + $target)
  Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target)
  Write-UpdateLog 'Launcher update handoff complete.'
  exit 0
} catch {
  Write-UpdateLog ('Launcher update helper failed: ' + $_.Exception.Message)
  exit 1
}
`.trimStart();
}

async function writeWindowsLauncherUpdateHelper({ filePath, artifact, latestVersion, downloadDir }) {
  const targetExe = launcherUpdateInstalledExePath();
  if (!targetExe) {
    throw new Error('Could not resolve installed launcher executable for restart.');
  }
  const helperDir = path.join(downloadDir, 'handoff');
  await ensureDir(helperDir);
  const payloadPath = path.join(helperDir, 'payload.json');
  const scriptPath = path.join(helperDir, 'apply-launcher-update.ps1');
  const cmdPath = path.join(helperDir, 'apply-launcher-update.cmd');
  const logPath = path.join(helperDir, 'handoff.log');
  const bootstrapLogPath = path.join(helperDir, 'bootstrap.log');
  const installerArgs = windowsLauncherInstallerArgs(artifact, targetExe);
  await writeJsonFile(payloadPath, {
    installerPath: filePath,
    installerArgs,
    targetExe,
    installDir: path.dirname(targetExe),
    expectedVersion: latestVersion || '',
    oldPid: process.pid,
    logPath,
    bootstrapLogPath,
    createdAt: new Date().toISOString()
  });
  await fs.writeFile(scriptPath, launcherUpdateHelperScript(payloadPath), 'utf8');
  await fs.writeFile(cmdPath, launcherUpdateHelperBatch(scriptPath, bootstrapLogPath), 'utf8');
  return { scriptPath, cmdPath, payloadPath, logPath, bootstrapLogPath, targetExe, installerArgs };
}

async function launchWindowsLauncherUpdateHelper(filePath, artifact = {}, options = {}) {
  const prepared = await prepareWindowsLauncherUpdateHelper(filePath, artifact, options);
  return launchPreparedLauncherUpdate(prepared);
}

async function prepareWindowsLauncherUpdateHelper(filePath, artifact = {}, options = {}) {
  const helper = await writeWindowsLauncherUpdateHelper({
    filePath,
    artifact,
    latestVersion: options.latestVersion || '',
    downloadDir: options.downloadDir || path.dirname(filePath)
  });
  const command = windowsCommandPromptPath();
  const args = ['/d', '/s', '/c', 'start', '""', '/min', windowsCommandPromptPath(), '/d', '/s', '/c', helper.cmdPath];
  return { ok: true, prepared: true, strategy: 'windows-helper', command, args, cwd: path.dirname(helper.scriptPath), ...helper };
}

function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function launcherUpdateInstalledMacAppPath() {
  if (process.platform !== 'darwin') return '';
  const executable = process.execPath || '';
  const marker = '.app/Contents/MacOS/';
  const markerIndex = executable.indexOf(marker);
  if (markerIndex >= 0) return executable.slice(0, markerIndex + 4);
  let current = executable;
  while (current && current !== path.dirname(current)) {
    if (current.toLowerCase().endsWith('.app')) return current;
    current = path.dirname(current);
  }
  return '';
}

function macLauncherUpdateHelperScript(payload) {
  return `#!/bin/sh
set -eu
zip_path=${shellSingleQuote(payload.installerPath)}
target_app=${shellSingleQuote(payload.targetApp)}
old_pid=${Number(payload.oldPid) || 0}
log_path=${shellSingleQuote(payload.logPath)}
work_dir=${shellSingleQuote(payload.workDir)}
write_log() {
  parent_dir=$(dirname "$log_path")
  mkdir -p "$parent_dir" 2>/dev/null || true
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$log_path" 2>/dev/null || true
}
fail_update() {
  write_log "Launcher update helper failed: $1"
  /usr/bin/open "$zip_path" 2>/dev/null || true
  exit 1
}
write_log "Waiting for old launcher PID $old_pid"
if [ "\${AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY:-}" = "1" ]; then
  write_log "Test mode helper startup confirmed."
  exit 0
fi
if [ "$old_pid" -gt 0 ]; then
  waits=0
  while kill -0 "$old_pid" 2>/dev/null; do
    waits=$((waits + 1))
    if [ "$waits" -ge 240 ]; then break; fi
    sleep 0.5
  done
fi
sleep 0.6
[ -n "$zip_path" ] && [ -f "$zip_path" ] || fail_update "Update ZIP was not found: $zip_path"
[ -n "$target_app" ] || fail_update "Target app path is empty"
case "$target_app" in *.app) ;; *) fail_update "Target app is not a .app bundle: $target_app" ;; esac
[ -n "$work_dir" ] && [ "$work_dir" != "/" ] || fail_update "Unsafe work dir: $work_dir"
rm -rf "$work_dir"
mkdir -p "$work_dir" || fail_update "Could not create extraction directory"
write_log "Extracting update ZIP $zip_path"
/usr/bin/ditto -x -k "$zip_path" "$work_dir" || fail_update "Could not extract update ZIP"
source_app=""
for candidate in "$work_dir"/*.app "$work_dir"/*/*.app; do
  if [ -d "$candidate" ]; then source_app="$candidate"; break; fi
done
[ -n "$source_app" ] || fail_update "No .app bundle was found in update ZIP"
parent_dir=$(dirname "$target_app")
mkdir -p "$parent_dir" || fail_update "Could not create target app parent directory"
backup_app="${target_app}.previous-update"
rm -rf "$backup_app"
if [ -d "$target_app" ]; then
  mv "$target_app" "$backup_app" || fail_update "Could not move old app bundle"
fi
if /usr/bin/ditto "$source_app" "$target_app"; then
  rm -rf "$backup_app"
else
  rm -rf "$target_app"
  if [ -d "$backup_app" ]; then mv "$backup_app" "$target_app" || true; fi
  fail_update "Could not install updated app bundle"
fi
chmod -R u+rwX "$target_app" 2>/dev/null || true
xattr -dr com.apple.quarantine "$target_app" 2>/dev/null || true
write_log "Starting updated launcher $target_app"
/usr/bin/open "$target_app" || fail_update "Could not reopen updated launcher"
write_log "Launcher update handoff complete."
exit 0
`;
}

async function writeMacLauncherUpdateHelper({ filePath, latestVersion, downloadDir }) {
  const helperDir = path.join(downloadDir, 'handoff');
  await ensureDir(helperDir);
  const targetApp = launcherUpdateInstalledMacAppPath() || path.join(app.getPath('userData'), 'A Hard Time Launcher macOS.app');
  if (!launcherUpdateInstalledMacAppPath() && process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT !== '1') {
    throw new Error('Could not resolve installed macOS .app bundle for restart.');
  }
  const payloadPath = path.join(helperDir, 'macos-payload.json');
  const scriptPath = path.join(helperDir, 'apply-launcher-update-macos.sh');
  const logPath = path.join(helperDir, 'macos-handoff.log');
  const payload = {
    installerPath: filePath,
    targetApp,
    expectedVersion: latestVersion || '',
    oldPid: process.pid,
    logPath,
    workDir: path.join(helperDir, 'macos-extract'),
    createdAt: new Date().toISOString()
  };
  await writeJsonFile(payloadPath, payload);
  await fs.writeFile(scriptPath, macLauncherUpdateHelperScript(payload), 'utf8');
  await fs.chmod(scriptPath, 0o755).catch(() => {});
  return { scriptPath, payloadPath, logPath, targetApp, expectedVersion: payload.expectedVersion };
}

async function launchMacLauncherUpdateHelper(filePath, artifact = {}, options = {}) {
  const prepared = await prepareMacLauncherUpdateHelper(filePath, artifact, options);
  return launchPreparedLauncherUpdate(prepared);
}

async function prepareMacLauncherUpdateHelper(filePath, artifact = {}, options = {}) {
  const helper = await writeMacLauncherUpdateHelper({
    filePath,
    artifact,
    latestVersion: options.latestVersion || '',
    downloadDir: options.downloadDir || path.dirname(filePath)
  });
  const command = '/bin/sh';
  const args = [helper.scriptPath];
  return { ok: true, prepared: true, strategy: 'macos-helper', command, args, cwd: path.dirname(helper.scriptPath), ...helper };
}

async function launchDownloadedLauncherUpdate(filePath, artifact = {}, options = {}) {
  const prepared = await prepareDownloadedLauncherUpdate(filePath, artifact, options);
  return launchPreparedLauncherUpdate(prepared);
}

async function prepareDownloadedLauncherUpdate(filePath, artifact = {}, options = {}) {
  const fileName = String(artifact.fileName || artifact.path || artifact.url || filePath).toLowerCase();
  if (process.platform === 'win32' && fileName.endsWith('.exe')) {
    return prepareWindowsLauncherUpdateHelper(filePath, artifact, options);
  }
  if (process.platform === 'darwin' && fileName.endsWith('.zip')) {
    return prepareMacLauncherUpdateHelper(filePath, artifact, options);
  }

  const cwd = path.dirname(filePath);
  const args = defaultLauncherInstallerArgs(artifact);
  if (process.platform === 'darwin') {
    return { ok: true, prepared: true, strategy: 'direct-open', command: 'open', args: [filePath], cwd };
  }

  return { ok: true, prepared: true, strategy: 'direct', command: filePath, args, cwd };
}

async function waitForLauncherUpdateHelperStart(prepared = {}, timeoutMs = 5000) {
  if (!prepared.logPath || !['windows-helper', 'macos-helper'].includes(prepared.strategy)) return;
  const start = Date.now();
  let bootstrapText = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const text = await fs.readFile(prepared.logPath, 'utf8');
      if (text.includes('Waiting for old launcher PID') || text.includes('Test mode helper startup confirmed.')) {
        return;
      }
    } catch {
      // Helper has not written its first line yet.
    }
    if (prepared.bootstrapLogPath) {
      bootstrapText = await fs.readFile(prepared.bootstrapLogPath, 'utf8').catch(() => bootstrapText);
    }
    await sleep(100);
  }
  const bootstrapDetail = prepared.bootstrapLogPath
    ? ` Bootstrap log: ${prepared.bootstrapLogPath}${bootstrapText ? ` (${bootstrapText.slice(-500)})` : ''}.`
    : '';
  throw new Error(`Launcher update helper did not start. No handoff log was written at ${prepared.logPath}.${bootstrapDetail}`);
}

async function launchPreparedLauncherUpdate(prepared = {}) {
  if (!prepared?.command) {
    throw new Error('Launcher update restart helper is not prepared.');
  }
  const shouldSkipLaunch = process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT === '1'
    && process.env.AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY !== '1';
  if (shouldSkipLaunch) {
    return { ...prepared, ok: true, skipped: true };
  }
  const launched = await spawnDetached(prepared.command, prepared.args || [], prepared.cwd || path.dirname(prepared.command), process.env);
  const result = { ...prepared, ...launched, strategy: prepared.strategy };
  await waitForLauncherUpdateHelperStart(prepared);
  return result;
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
    launcherUpdateState.progress = { phase: 'Preparing restart handoff', completed: 2, total: 3, percent: 92 };
    const preparedRestart = await prepareDownloadedLauncherUpdate(target, update.artifact, { latestVersion: update.latestVersion, downloadDir });
    const result = {
      ok: true,
      version: update.latestVersion,
      downloadedPath: target,
      artifact: update.artifact,
      restartRequired: true,
      preparedRestart
    };
    launcherUpdateState.lastResult = result;
    launcherUpdateState.progress = { phase: 'Update Is Done, Restart Required', completed: 3, total: 3, percent: 100 };
    launcherUpdateState.lines.push('Update Is Done, Restart Required.');
    launcherUpdateState.lines.push('Click Restart Launcher to install the update and reopen AHT Launcher.');
    return result;
  } catch (error) {
    launcherUpdateState.error = error.message || String(error);
    throw error;
  } finally {
    launcherUpdateState.running = false;
  }
}

async function restartLauncherUpdate() {
  if (launcherUpdateState.running) {
    launcherUpdateState.lines.push('Restart request ignored because a launcher update is already running.');
    return launcherUpdateState;
  }
  const staged = launcherUpdateState.lastResult;
  if (!staged?.restartRequired || !staged?.preparedRestart) {
    throw new Error('Launcher update is not ready to restart yet.');
  }
  launcherUpdateState.running = true;
  launcherUpdateState.error = null;
  launcherUpdateState.progress = { phase: 'Starting restart helper', completed: 3, total: 3, percent: 100 };
  launcherUpdateState.lines.push('Restart requested. Starting launcher update helper.');
  try {
    const launched = await launchPreparedLauncherUpdate(staged.preparedRestart);
    const result = {
      ...staged,
      restartRequired: false,
      restartStartedAt: new Date().toISOString(),
      launched
    };
    launcherUpdateState.lastResult = result;
    launcherUpdateState.progress = { phase: process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT === '1' ? 'Restart verified' : 'Restarting launcher', completed: 3, total: 3, percent: 100 };
    launcherUpdateState.lines.push(process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT === '1'
      ? 'Test mode verified the restart helper without closing the launcher.'
      : 'Restart helper is running. Closing AHT Launcher so the update can install and reopen.');
    if (process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT !== '1') {
      setTimeout(() => app.quit(), 250);
    } else {
      launcherUpdateState.running = false;
    }
    return result;
  } catch (error) {
    launcherUpdateState.error = error.message || String(error);
    launcherUpdateState.progress = { ...(launcherUpdateState.progress || {}), phase: 'Restart failed', percent: 100 };
    launcherUpdateState.running = false;
    throw error;
  }
}

function serverTransferOptions(config = {}, payload = {}, password = '') {
  const configured = config.serverTransfer || {};
  const excludeDirs = [...new Set(['DregoraRL', ...(configured.excludeDirs || []), ...(payload.excludeDirs || [])])];
  const includeDirs = [...new Set([...(payload.includeDirs || configured.includeDirs || DEFAULT_SERVER_TRANSFER_INCLUDED_DIRS)])];
  return {
    sourceDir: payload.sourceDir || configured.sourceDir || process.env.AHT_SERVER_TRANSFER_SOURCE_DIR || '',
    host: payload.host || configured.host || process.env.AHT_SERVER_TRANSFER_HOST || '',
    port: Number(payload.port || configured.port || 22),
    username: payload.username || configured.username || process.env.AHT_SERVER_TRANSFER_USERNAME || '',
    remoteDir: payload.remoteDir || configured.remoteDir || process.env.AHT_SERVER_TRANSFER_REMOTE_DIR || '',
    password,
    excludeDirs,
    includeDirs,
    includeRootFiles: payload.includeRootFiles ?? configured.includeRootFiles ?? true,
    concurrency: Number(payload.concurrency || configured.concurrency || 8)
  };
}

async function planServerTransfer(payload = {}) {
  assertDeveloperAuthenticated();
  const { collectServerTransferFiles } = await loadServerTransferModule();
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
  const { uploadServerFiles } = await loadServerTransferModule();
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
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function versionHintFromFileName(filePath = '') {
  const name = path.basename(filePath).replace(/\.zip$/i, '');
  const normalizedName = name.replace(/(?:[\s_-](?:aht-client|client-zip|full-client|client))$/i, '');
  const match = normalizedName.match(/(?:^|[\s_-])v?(\d+(?:\.\d+){1,4}(?:[-_+][A-Za-z0-9][A-Za-z0-9._-]*)?)$/i);
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

async function resolveWorkerSourceFile() {
  const candidateRoots = [
    appRoot,
    process.env.AHT_LAUNCHER_SOURCE_ROOT,
    process.env.INIT_CWD,
    process.env.npm_config_local_prefix,
    process.cwd()
  ].filter(Boolean);
  for (const root of [...new Set(candidateRoots.map((item) => path.resolve(item)))]) {
    const candidate = path.join(root, 'cloudflare', 'curseforge-proxy-worker.js');
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  throw new Error('Cloudflare project file missing. Set AHT_LAUNCHER_SOURCE_ROOT to the local aht-launcher repo before running developer cloud setup from a packaged app.');
}

async function prepareWranglerProject(options = {}) {
  const cwd = wranglerWorkDir();
  await ensureDir(cwd);
  const workerSource = await resolveWorkerSourceFile();
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
  if (curseforgeApiKey) {
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

function playerDefaultsForCloud(config, { publicLatestUrl = '', bucket = '', cacheOnlyMode = null } = {}) {
  const latestUrl = latestUrlFromWorkerInput(publicLatestUrl || config.latestUrl);
  if (!latestUrl) {
    throw new Error('Player Feed URL is required before writing player defaults.');
  }
  const workerBase = workerBaseUrlFromLatest(latestUrl);
  const cacheOnly = cacheOnlyMode === null || cacheOnlyMode === undefined
    ? Boolean(config.developer?.cacheOnlyMode)
    : Boolean(cacheOnlyMode);
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

    launcherUpdate: {
      enabled: true,
      latestUrl: workerBase ? new URL('launcher/latest.json', workerBase).toString() : ''
    },
    launcherProof: {
      enabled: true,
      required: true,
      baseUrl: workerBase,
      keyId: 'aht-launcher-proof-v1'
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

function cleanR2AccountId(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('.r2.cloudflarestorage.com')) {
      return host.replace(/\.r2\.cloudflarestorage\.com$/, '');
    }
  } catch {}
  return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.r2\.cloudflarestorage\.com$/i, '').trim();
}

function directR2CredentialsReady(credentials = {}) {
  return Boolean(
    cleanR2AccountId(credentials.accountId)
    && String(credentials.accessKeyId || '').trim()
    && String(credentials.secretAccessKey || '').trim()
  );
}

function missingDirectR2CredentialLabels(credentials = {}) {
  const missing = [];
  if (!cleanR2AccountId(credentials.accountId)) missing.push('R2 Account ID');
  if (!String(credentials.accessKeyId || '').trim()) missing.push('R2 Access Key ID');
  if (!String(credentials.secretAccessKey || '').trim()) missing.push('R2 Secret Access Key');
  return missing;
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
      downloadKey: 'windows-x64',
      file: payload.windowsPath || payload.win32Path || ''
    },
    {
      key: 'darwin-arm64',
      aliases: ['macos-arm64'],
      label: 'macOS Apple Silicon update ZIP',
      kind: 'zip',
      installArgs: [],
      file: payload.macosArmZipPath || payload.darwinArm64ZipPath || ''
    },
    {
      key: 'darwin-x64',
      aliases: ['macos-x64', 'darwin', 'macos'],
      label: 'macOS Intel update ZIP',
      kind: 'zip',
      installArgs: [],
      file: payload.macosX64ZipPath || payload.darwinX64ZipPath || payload.macosZipPath || payload.darwinZipPath || ''
    },
    {
      key: 'darwin-arm64',
      label: 'macOS Apple Silicon DMG',
      kind: 'dmg',
      installArgs: [],
      downloadKey: 'macos-arm64',
      platform: false,
      file: payload.macosArmDmgPath || payload.darwinArm64DmgPath || ''
    },
    {
      key: 'darwin-x64',
      label: 'macOS Intel DMG',
      kind: 'dmg',
      installArgs: [],
      downloadKey: 'macos-x64',
      platform: false,
      file: payload.macosX64DmgPath || payload.darwinX64DmgPath || payload.macosPath || payload.darwinPath || ''
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
  const downloads = {};
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
    if (descriptor.platform !== false) {
      platforms[descriptor.key] = entry;
      for (const alias of descriptor.aliases || []) {
        platforms[alias] = entry;
      }
    }
    if (descriptor.downloadKey) {
      downloads[descriptor.downloadKey] = entry;
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
    platforms,
    downloads
  };
  const validation = validateLauncherUpdateManifest(manifest, {
    latestUrl: launcherLatestUrlFromInput(publicLatestUrl || config.launcherUpdate?.latestUrl || config.latestUrl || ''),
    allowInsecureLocalhost: process.env.AHT_TEST_ALLOW_INSECURE_LAUNCHER_UPDATE === '1'
  });
  if (!validation.ok) {
    throw new Error(`Launcher update manifest is invalid: ${validation.errors.join('; ')}`);
  }
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
  const macosRoots = [
    path.join(appRoot, 'release-builds', 'macos')
  ];
  return {
    version: app.getVersion(),
    windowsPath: await findNewestFile([
      path.join(appRoot, 'release-builds', 'windows'),
      path.join(appRoot, 'release-builds')
    ], /\.exe$/i),
    macosArmZipPath: await findNewestFile(macosRoots, /(?:arm64|aarch64).*\.zip$/i),
    macosX64ZipPath: await findNewestFile(macosRoots, /(?:x64|x86_64|intel).*\.zip$/i),
    macosArmDmgPath: await findNewestFile(macosRoots, /(?:arm64|aarch64).*\.dmg$/i),
    macosX64DmgPath: await findNewestFile(macosRoots, /(?:x64|x86_64|intel).*\.dmg$/i),
    macosPath: await findNewestFile(macosRoots, /\.dmg$/i)
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

async function githubWorkflowPayload(payload = {}, config = {}) {
  const { cleanGithubRepo, cleanRef, cleanWorkflowId } = await loadGithubActionsModule();
  const developer = config.developer || {};
  return {
    repo: cleanGithubRepo(payload.githubRepo || payload.repo || developer.githubRepo || LAUNCHER_WORKFLOW_DEFAULTS.repo),
    ref: cleanRef(payload.githubBranch || payload.branch || developer.githubBranch || LAUNCHER_WORKFLOW_DEFAULTS.branch),
    workflow: cleanWorkflowId(payload.githubWorkflow || payload.workflow || developer.githubWorkflow || LAUNCHER_WORKFLOW_DEFAULTS.workflow)
  };
}

async function checkLauncherWorkflow(payload = {}) {
  assertDeveloperAuthenticated();
  const config = await loadConfig();
  const workflow = await githubWorkflowPayload(payload, config);
  const { token, source } = await resolveGithubToken(payload);
  const { findRecentWorkflowRun, readGithubPackageVersion } = await loadGithubActionsModule();
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
  const workflow = await githubWorkflowPayload(payload, config);
  const { token, source } = await resolveGithubToken(payload);
  const { readGithubPackageVersion, triggerLauncherReleaseWorkflow } = await loadGithubActionsModule();
  const version = await readGithubPackageVersion({
    repo: workflow.repo,
    ref: workflow.ref,
    token
  });
  const result = await triggerLauncherReleaseWorkflow({
    ...workflow,
    token,
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
  const validation = validateLauncherUpdateManifest(remote, {
    latestUrl,
    allowInsecureLocalhost: process.env.AHT_TEST_ALLOW_INSECURE_LAUNCHER_UPDATE === '1'
  });
  if (!validation.ok) {
    throw new Error(`remote launcher latest is invalid: ${validation.errors.join('; ')}`);
  }
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
  const { publicLatestUrl = '' } = payload;
  assertDeveloperAuthenticated();
  if (uploadState.running) {
    throw new Error('R2 upload is already running');
  }
  const config = await loadConfig();
  const outDir = resolveReleaseOutDir(payload.outDir || config.developer?.defaultOutDir);
  const bucket = String(payload.bucket || config.developer?.r2Bucket || 'ahtlauncher').trim();
  if (!bucket) {
    throw new Error('R2 bucket is required');
  }
  const validation = await validateRelease({ outDir, publicLatestUrl, allowLegacyCurseForge: payload.allowLegacyCurseForge === true });
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
  const r2Direct = fastUpload ? await loadR2DirectUploadModule() : null;
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
        const remote = await r2Direct.headR2ObjectDirect({
          ...directCredentials,
          bucket,
          key: rel
        });
        if (remoteReleaseObjectMatches({ rel, remote, stat, sha256 })) {
          uploaded.push({ path: rel, output: `skipped ${rel}; remote object already matches`, method: 'direct-skip', skipped: true, size: stat.size });
          uploadState.lines.push(`Skipped ${rel}; remote already matches.`);
        } else {
          const result = await r2Direct.uploadR2ObjectDirect({
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

function legacyCurseForgeReleaseMessage() {
  return 'Legacy CurseForge export ZIPs are blocked for normal player releases. Use the Modpack ZIP tab to create an exact AHT client ZIP, then publish that ZIP.';
}

function assertFullClientReleaseAllowed(inspected, allowLegacyCurseForge = false) {
  if (inspected?.fullClientZip || allowLegacyCurseForge) return;
  throw new Error(legacyCurseForgeReleaseMessage());
}

function inspectPackZipFile(packZip) {
  if (!packZip) {
    throw new Error('Pack ZIP is required');
  }
  const zip = new AdmZip(packZip);
  const versionHint = versionHintFromFileName(packZip);
  const clientMetadataEntry = zip.getEntry(CLIENT_PACK_METADATA_ENTRY);
  if (clientMetadataEntry) {
    const metadata = JSON.parse(clientMetadataEntry.getData().toString('utf8'));
    if (metadata.format !== CLIENT_PACK_FORMAT) {
      throw new Error(`${CLIENT_PACK_METADATA_ENTRY} has unsupported format: ${metadata.format || 'missing'}`);
    }
    const version = String(metadata.version || '');
    return {
      name: metadata.name || 'A Hard Time',
      version,
      fileName: path.basename(packZip),
      versionHint,
      versionMismatch: Boolean(versionHint && version && normalizedVersion(versionHint) !== normalizedVersion(version)),
      minecraft: metadata.minecraft || null,
      fileCount: Number(metadata.fileCount || 0),
      installMode: 'full-client-zip',
      fullClientZip: true
    };
  }
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    throw new Error(`ZIP does not contain manifest.json or ${CLIENT_PACK_METADATA_ENTRY}`);
  }
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  const version = String(manifest.version || '');
  return {
    name: manifest.name || '',
    version,
    fileName: path.basename(packZip),
    versionHint,
    versionMismatch: Boolean(versionHint && version && normalizedVersion(versionHint) !== normalizedVersion(version)),
    minecraft: manifest.minecraft || null,
    fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
    installMode: 'curseforge',
    fullClientZip: false
  };
}

async function validateRelease({ outDir, publicLatestUrl = '', allowLegacyCurseForge = false }) {
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
  const fullClientRelease = latest.installMode === 'full-client-zip' || latest.zipFormat === CLIENT_PACK_FORMAT;
  if (!fullClientRelease && !allowLegacyCurseForge) {
    add('error', 'legacy CurseForge release blocked', legacyCurseForgeReleaseMessage());
  }
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
        const entries = zip.getEntries();
        if (fullClientRelease) {
          const metadataEntry = zip.getEntry(CLIENT_PACK_METADATA_ENTRY);
          if (!metadataEntry) {
            add('error', 'AHT client metadata missing', `${CLIENT_PACK_METADATA_ENTRY} was not found in the pack ZIP.`);
          } else {
            const metadata = JSON.parse(metadataEntry.getData().toString('utf8'));
            if (metadata.format !== CLIENT_PACK_FORMAT) {
              add('error', 'AHT client metadata invalid', `format=${metadata.format || 'missing'}`);
            } else {
              const fileEntries = entries.filter((entry) => !entry.isDirectory && entry.entryName.replaceAll('\\', '/') !== CLIENT_PACK_METADATA_ENTRY);
              const modEntries = fileEntries.filter((entry) => entry.entryName.replaceAll('\\', '/').toLowerCase().startsWith('mods/') && /\.(jar|zip)$/i.test(entry.entryName));
              manifestFileCount = 0;
              overrideFileCount = fileEntries.length;
              cacheCoverage = { total: 0, covered: 0, missing: [], complete: true };
              add('ok', 'AHT full client ZIP parsed', `${fileEntries.length} files, ${modEntries.length} mod archives`);
              const versionLockEntry = entries.find((entry) => {
                const name = entry.entryName.replaceAll('\\', '/');
                return !entry.isDirectory && name.startsWith('mods/') && /aht-version-lock-.+\.jar$/i.test(path.posix.basename(name));
              });
              if (versionLockEntry) {
                add('ok', 'client version lock mod included', versionLockEntry.entryName);
              } else {
                add('error', 'client version lock mod missing', 'mods/aht-version-lock-*.jar is required so stale clients cannot bypass the launcher.');
              }
              if (metadata.minecraft?.version || latest.minecraft?.version) {
                add('ok', 'Minecraft version present', metadata.minecraft?.version || latest.minecraft?.version);
              } else {
                add('warning', 'Minecraft version missing', `${CLIENT_PACK_METADATA_ENTRY} minecraft.version is not set.`);
              }
            }
          }
        } else {
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
        }
      } catch (error) {
        add('error', 'pack ZIP could not be inspected', error.message);
      }
    }
  }

  let cachePath = null;
  if (fullClientRelease) {
    add('ok', 'fallback cache not required', 'Full client ZIP releases install exact files without CurseForge fallback resolution.');
  } else {
  const cacheRef = latest.cacheManifest?.path || latest.cacheManifest?.url;
  validateAbsoluteReleaseUrl({
    add,
    publicLatestUrl,
    label: 'fallback cache manifest',
    url: latest.cacheManifest?.url || '',
    pathRef: latest.cacheManifest?.path || ''
  });
  cachePath = localReleasePath(outDir, cacheRef);
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
      required: latest.required !== false,
      installMode: latest.installMode || ''
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
      stdio: 'ignore',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, command, args });
    });
  });
}

async function existingLaunchCwd(preferred = '') {
  const candidates = [preferred, app.getPath('home'), process.cwd()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // Try the next fallback path.
    }
  }
  return app.getPath('home');
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

async function openWindowsStoreMinecraftLauncher(cwd, env) {
  const appTarget = 'shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft';
  const explorer = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'explorer.exe') : 'explorer.exe';
  try {
    return await spawnDetached(explorer, [appTarget], cwd, env);
  } catch (explorerError) {
    const commandPrompt = process.env.ComSpec || (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : 'cmd.exe');
    try {
      return await spawnDetached(commandPrompt, ['/d', '/s', '/c', 'start', '""', appTarget], cwd, env);
    } catch (startError) {
      throw new Error(`Minecraft Launcher could not be opened. Explorer failed: ${explorerError.message}. Start failed: ${startError.message}`);
    }
  }
}
async function openMinecraftLauncher(config) {
  const requestedCwd = config.minecraftLauncher?.rootDir || app.getPath('home');
  const cwd = await existingLaunchCwd(requestedCwd);
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
    return openWindowsStoreMinecraftLauncher(cwd, env);
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
ipcMain.handle('update:start', async (_event, payload = {}) => runUpdate(Boolean(payload.forceRepair), {
  replaceGameSettings: Boolean(payload.replaceGameSettings)
}));
ipcMain.handle('update:state', async () => updateState);
ipcMain.handle('launcher:updateStart', async () => runLauncherUpdate());
ipcMain.handle('launcher:updateRestart', async () => restartLauncherUpdate());
ipcMain.handle('launcher:updateState', async () => launcherUpdateState);
ipcMain.handle('account:register', async (_event, username) => registerMinecraftUsername(username));
ipcMain.handle('changes:scan', async () => {
  const config = await loadConfig();
  if (developerClientBypassAllowed()) {
    return developerBypassLocalChangesState(config, 'developer-scan-bypass');
  }
  return scanLocalChanges(config.instanceDir);
});
ipcMain.handle('files:scan', async () => {
  const config = await loadConfig();
  if (developerClientBypassAllowed()) {
    return developerBypassIntegrityState(config, 'developer-scan-bypass');
  }
  const integrity = await scanCurrentManagedIntegrity(config);
  return writeIntegrityState(config, integrity, 'scan');
});
ipcMain.handle('changes:sync', async () => {
  const config = await loadConfig();
  const identity = await identityPayload(config);
  const changes = developerClientBypassAllowed()
    ? developerBypassLocalChangesState(config, 'developer-sync-bypass')
    : await scanLocalChanges(config.instanceDir);
  return sendLauncherEvent(config, identity, {
    type: 'local_changes',
    version: null,
    changes
  });
});
ipcMain.handle('play:start', async () => {
  const config = await loadConfig();
  const developerClientBypass = developerClientBypassAllowed();

  const installedPath = path.join(config.instanceDir, '.aht-launcher', 'installed.json');
  const installed = await pathExists(installedPath) ? await readJsonFile(installedPath) : null;
  let latest = null;
  let latestError = null;
  try {
    latest = await readLatest(config);
  } catch (error) {
    latestError = error.message;
    if (!developerClientBypass) {
      throw new Error(`Release feed cannot be checked: ${error.message}`);
    }
  }

  const launchLatest = latest || (developerClientBypass && installed ? installed : null);
  const integrity = developerClientBypass
    ? null
    : await writeIntegrityState(config, await scanCurrentManagedIntegrity(config, launchLatest), 'play-check');
  const minecraftProfile = await inspectMinecraftLauncherProfile({ config, latest: launchLatest, installed });
  const initialLaunchState = evaluateLaunchState(config, launchLatest, developerClientBypass && installed ? null : latestError, installed, minecraftProfile, integrity, {
    skipLoaderCheck: true,
    allowLegacyRelease: developerClientBypass
  });
  if (!initialLaunchState.launchReady) {
    throw new Error(initialLaunchState.launchBlockedReason);
  }

  keepOpenUntil = Date.now() + 5 * 60_000;
  const identity = await identityPayload(config);
  const launcherProof = await writeLauncherProof({
    config,
    identity: launcherProofIdentity(identity),
    latest: launchLatest,
    installed,
    authToken: launcherProofAuthToken()
  });
  let profile = await ensureMinecraftLauncherProfile({ config, latest: launchLatest, installed });
  profile = await installMinecraftProfileLoaders(profile, { config, latest: launchLatest, installed });
  const finalLaunchState = evaluateLaunchState(config, launchLatest, null, installed, profile, integrity, {
    allowLegacyRelease: developerClientBypass
  });
  if (!finalLaunchState.launchReady) {
    throw new Error(finalLaunchState.launchBlockedReason);
  }
  return {
    ...(await openMinecraftLauncher(config)),
    minecraftProfile: minecraftProfileForRenderer(profile),
    launcherProof: launcherProofForRenderer({
      proofFile: launcherProof.proofFile || '',
      trusted: Boolean(launcherProof.trusted),
      source: launcherProof.source || ''
    })
  };
});
ipcMain.handle('dialog:zip', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Exact AHT client ZIPs', extensions: ['zip'] }]
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
ipcMain.handle('dialog:folder', async (_event, defaultPath = '') => {
  const options = { properties: ['openDirectory', 'createDirectory'] };
  const startingPath = typeof defaultPath === 'string' ? defaultPath.trim() : '';
  if (process.env.AHT_TEST_HOOKS === '1' && process.env.AHT_TEST_DIALOG_ECHO_DEFAULT_PATH === '1') {
    return startingPath ? path.join(startingPath, '__aht_dialog_default_path__') : '';
  }
  if (startingPath) options.defaultPath = startingPath;
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('shell:openPath', async (_event, target) => shell.openPath(target));
ipcMain.handle('setup:recommend', async () => setupForRenderer(await setupRecommendations()));
ipcMain.handle('setup:apply', async () => applyRecommendedSetup());
ipcMain.handle('dev:buildClientZip', async (_event, payload = {}) => {
  assertDeveloperAuthenticated();
  const { createClientModpackZip } = await loadClientModpackZipModule();
  const config = await loadConfig();
  const outDir = path.join(resolveReleaseOutDir(payload?.outDir || config.developer?.defaultOutDir), 'client-zips');
  const result = await createClientModpackZip({
    sourceDir: payload.sourceDir || config.developer?.clientModpackDir || '',
    outDir,
    version: payload.version || '',
    name: payload.name || 'A Hard Time',
    packId: payload.packId || config.packId || 'a-hard-time-dregora',
    minecraft: payload.minecraft || config.minecraftLauncher?.minecraft || {}
  });
  return result;
});
ipcMain.handle('dev:buildRelease', async (_event, payload) => {
  assertDeveloperAuthenticated();
  const inspected = inspectPackZipFile(payload?.packZip || '');
  assertFullClientReleaseAllowed(inspected, payload?.allowLegacyCurseForge === true);
  const { buildRelease } = await loadReleaseBuilderModule();
  const config = await loadConfig();
  const outDir = resolveReleaseOutDir(payload?.outDir || config.developer?.defaultOutDir);
  await ensureDir(outDir);
  return buildRelease({
    packZip: payload.packZip,
    outDir,
    baseUrl: payload.baseUrl,
    channel: payload.channel || 'stable',
    cacheModsDir: payload.cacheModsDir || ''
  });
});
ipcMain.handle('dev:inspectPackZip', async (_event, packZip) => {
  assertDeveloperAuthenticated();
  return inspectPackZipFile(packZip);
});
ipcMain.handle('dev:validateRelease', async (_event, payload) => {
  assertDeveloperAuthenticated();
  const config = await loadConfig();
  return validateRelease({
    ...payload,
    outDir: resolveReleaseOutDir(payload?.outDir || config.developer?.defaultOutDir)
  });
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
  const base = config.developer?.adminBaseUrl || config.sync?.baseUrl;
  const skipRemote = process.env.AHT_SKIP_REMOTE_DEVELOPER_LOGIN === '1';
  const remotePending = Boolean(base && !skipRemote);
  if (remotePending) {
    remoteAdminLogin(config, normalizedUsername, password)
      .then((remote) => {
        if (!remote.ok) console.warn(`Worker admin login failed after local developer login: ${remote.error || 'unknown error'}`);
      })
      .catch((error) => {
        console.warn(`Worker admin login failed after local developer login: ${error.message || error}`);
      });
  }
  return {
    ok: true,
    expiresAt: new Date(expiresAt).toISOString(),
    remoteAuthenticated: false,
    remotePending,
    remoteExpiresAt: '',
    remoteError: base || skipRemote ? '' : 'Developer admin URL is not configured'
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

  app.whenReady().then(() => {
    writeTestStartupProbe('app-ready', { userData: app.getPath('userData') });
    createWindow();
  });
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
