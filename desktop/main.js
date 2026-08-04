import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import yauzl from 'yauzl';
import {
  CLIENT_DELTA_FORMAT,
  CLIENT_DELTA_METADATA_ENTRY,
  CLIENT_MANIFEST_FORMAT,
  CLIENT_PACK_FORMAT,
  CLIENT_PACK_METADATA_ENTRY,
  isClientPackContentPath
} from '../src/clientPackFormat.js';
import { installPack } from '../src/installer.js';
import {
  captureManagedModFingerprint,
  scanLocalChanges,
  scanManagedIntegrity
} from '../src/localChanges.js';
import {
  defaultMinecraftRoot,
  ensureMinecraftLauncherAssets,
  ensureMinecraftLauncherProfile,
  inspectMinecraftLauncherAuth,
  inspectMinecraftLauncherProfile,
  minecraftRootCandidates,
  setMinecraftLauncherHomePage
} from '../src/minecraftLauncherProfile.js';
import {
  clearJavaRuntimeDetectionCache,
  detectJava8Runtime,
  installForgeLoader,
  minecraftJavaExecutable,
  preflightJava8Runtime
} from '../src/forgeInstaller.js';
import { sendLauncherEvent } from '../src/syncClient.js';
import { defaultInstanceDirForPlatform, platformKey, platformProfile } from '../src/platformProfile.js';
import { inspectLauncherProof, launcherProofPath, writeLauncherProof } from '../src/launcherProof.js';
import { fetchSocialState, sendSocialAction } from '../src/socialClient.js';
import { legalConsentStatus, recordLegalConsent } from '../src/legalConsent.js';
import {
  beginLaunchStep,
  completeLaunchAttempt,
  createLaunchAttempt,
  finishLaunchStep,
  formatLaunchReport,
  runLaunchStep,
  sanitizeDiagnosticText,
  setLaunchRequirement,
  writeLaunchReport
} from '../src/launchDiagnostics.js';
import { selectLauncherArtifact, validateLauncherUpdateManifest } from '../src/launcherUpdateManifest.js';
import {
  assertReleaseMatchesTarget,
  normalizeReleaseTarget,
  releaseTarget,
  releaseTargetFeedUrl,
  releaseTargetObjectKey,
  releaseTargetOutDir,
  workerServiceBaseUrl
} from '../src/releaseTargets.js';
import {
  buildWindowsMinecraftProcessSnapshotPowerShell,
  isKnownWindowsMinecraftLauncher,
  normalizeWindowsLauncherRecord,
  windowsLauncherRecordHasUsableWindow,
  windowsLauncherRecordIdentity,
  windowsLauncherRecordMatchesAllowedPath,
  windowsLauncherRecordMatchesTarget,
  windowsLauncherTaskkillArgs,
  windowsLauncherWindowIdentity
} from '../src/windowsMinecraftLauncher.js';

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
const DEFAULT_MINECRAFT_MEMORY_MB = 4096;
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

function configureTestUserDataPath() {
  if (process.env.AHT_TEST_HOOKS !== '1') return;
  const rawPath = String(process.env.AHT_TEST_USER_DATA || explicitUserDataDirArg() || '').trim();
  if (!rawPath) return;
  const resolvedPath = path.resolve(rawPath);
  app.setPath('userData', resolvedPath);
  writeTestStartupProbe('after-user-data-hook', { userData: resolvedPath });
}

configureTestRemoteDebugPort();
configureTestUserDataPath();

let releaseBuilderModulePromise = null;
let clientModpackZipModulePromise = null;
let serverTransferModulePromise = null;
let githubActionsModulePromise = null;
let githubModpackReleaseModulePromise = null;
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

function loadGithubModpackReleaseModule() {
  githubModpackReleaseModulePromise ||= importDeveloperModule('../src/githubModpackRelease.js');
  return githubModpackReleaseModulePromise;
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
let launcherDeployState = { running: false, lines: [], lastResult: null, error: null, progress: null };
let adminToken = '';
let adminTokenExpiresAt = 0;
let adminTokenBaseUrl = '';
const adminLoginPromises = new Map();
let developerSession = null;
const latestReleaseCache = new Map();
const launcherProofRefreshes = new Map();
const launcherVersionTelemetryInFlight = new Map();
const LATEST_RELEASE_CACHE_MAX_AGE_MS = 2 * 60 * 1000;
const LAUNCHER_UPDATE_INSTALLING_STALE_MS = 10 * 60 * 1000;

const DEFAULT_DEVELOPER_USERNAME = 'admin';
const DEVELOPER_SESSION_MS = 12 * 60 * 60 * 1000;
const REMOTE_ADMIN_LOGIN_TIMEOUT_MS = 15_000;
const DEVELOPER_SECRET_KEYS = ['curseforgeApiKey', 'serverSshPassword', 'launcherProofSecret', 'githubToken', 'r2AccountId', 'r2AccessKeyId', 'r2SecretAccessKey'];
const OPERATION_LINES_MAX = 120;
const OPERATION_LINE_MAX_CHARS = 900;
let launcherModeCache = null;

function operationLineText(line) {
  const text = String(line ?? '');
  return text.length > OPERATION_LINE_MAX_CHARS ? text.slice(0, OPERATION_LINE_MAX_CHARS) + '...' : text;
}

function trimOperationLines(state, max = OPERATION_LINES_MAX) {
  if (!state || !Array.isArray(state.lines)) return;
  const limit = Math.max(1, Number(max) || OPERATION_LINES_MAX);
  if (state.lines.length > limit) {
    state.lines = state.lines.slice(-limit);
  }
}

function appendOperationLine(state, line, max = OPERATION_LINES_MAX) {
  if (!state) return;
  if (!Array.isArray(state.lines)) state.lines = [];
  state.lines.push(operationLineText(line));
  trimOperationLines(state, max);
}

function appendOperationLines(state, lines = [], max = OPERATION_LINES_MAX) {
  if (!state) return;
  if (!Array.isArray(state.lines)) state.lines = [];
  for (const line of lines) {
    state.lines.push(operationLineText(line));
  }
  trimOperationLines(state, max);
}

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

let lastErrorDiagnostic = null;
let lastLaunchDiagnostic = null;
let launchHardwareSnapshotPromise = null;

function withDiagnosticTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function errorForDiagnostic(error = null) {
  if (!error) return { name: 'Error', message: 'Unknown error', stack: '' };
  return {
    name: String(error.name || 'Error'),
    message: String(error.message || error),
    code: error.code || '',
    stack: String(error.stack || '')
  };
}

function recordErrorDiagnostic(channel, error, context = {}) {
  lastErrorDiagnostic = {
    at: new Date().toISOString(),
    channel,
    error: errorForDiagnostic(error),
    context
  };
  return lastErrorDiagnostic;
}

function launchHardwareSnapshot() {
  if (launchHardwareSnapshotPromise) return launchHardwareSnapshotPromise;
  launchHardwareSnapshotPromise = (async () => {
    const cpu = os.cpus()?.[0] || {};
    let gpus = [];
    try {
      const gpuInfo = await withDiagnosticTimeout(app.getGPUInfo('basic'), 1500, 'Graphics information collection');
      gpus = (Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : [])
        .map((device) => {
          const name = String(device?.deviceString || '').trim();
          const driver = [device?.driverVendor, device?.driverVersion].filter(Boolean).join(' ');
          if (name && driver) return `${name} (${driver})`;
          if (name) return name;
          if (driver) return driver;
          const vendorId = Number(device?.vendorId || 0).toString(16).padStart(4, '0');
          const deviceId = Number(device?.deviceId || 0).toString(16).padStart(4, '0');
          return vendorId !== '0000' || deviceId !== '0000' ? `GPU ${vendorId}:${deviceId}` : '';
        })
        .filter(Boolean);
    } catch {}
    return {
      osName: `${os.type()} ${os.release()}${typeof os.version === 'function' ? ` (${os.version()})` : ''}`,
      arch: `${process.arch}${process.platform === 'win32' ? ' / Windows' : ''}`,
      cpuModel: String(cpu.model || '').trim(),
      logicalCores: os.cpus()?.length || 0,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      gpus
    };
  })();
  return launchHardwareSnapshotPromise;
}

async function existingFilesystemPath(value = '') {
  let current = path.resolve(String(value || app.getPath('home')));
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
  return current;
}

async function launchDiskSnapshot(label, targetPath = '') {
  try {
    const existing = await existingFilesystemPath(targetPath);
    if (!existing || typeof fs.statfs !== 'function') return null;
    const stat = await fs.statfs(existing);
    return {
      label,
      path: existing,
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
      freeBytes: Number(stat.bavail) * Number(stat.bsize)
    };
  } catch {
    return null;
  }
}

async function launchSystemSnapshot(config = {}) {
  const base = await launchHardwareSnapshot();
  const diskTargets = [
    ['AHT instance drive', config.instanceDir || defaultInstanceDir()],
    ['Minecraft Launcher drive', config.minecraftLauncher?.rootDir || defaultMinecraftRoot()]
  ];
  const seen = new Set();
  const disks = [];
  for (const [label, targetPath] of diskTargets) {
    const root = path.parse(path.resolve(targetPath)).root.toLowerCase();
    if (seen.has(root)) continue;
    seen.add(root);
    const disk = await launchDiskSnapshot(label, targetPath);
    if (disk) disks.push(disk);
  }
  return { ...base, freeMemoryBytes: os.freemem(), disks };
}

function minecraftSignalsForLaunch(diagnostic = null, attempt = {}) {
  const startMs = Date.parse(String(attempt?.startedAt || ''));
  const diagnosticSnapshot = attempt?.result === 'DIAGNOSTIC';
  const cutoff = Number.isFinite(startMs)
    ? startMs - (diagnosticSnapshot ? 24 * 60 * 60 * 1000 : 2 * 60 * 1000)
    : Date.now() - 24 * 60 * 60 * 1000;
  const useful = /No libraries\?!|Parsing version .*forge|Starting game in folder|using java executable|Usage: javaw|Process crashed|exit code|crash report|UnsupportedClassVersionError|OutOfMemoryError|Could not reserve enough space|EXCEPTION_ACCESS_VIOLATION|problematic frame|\bERROR\b|\bFATAL\b|Exception|Caused by:/i;
  const roots = (diagnostic?.roots || []).filter((root) => Date.parse(String(root?.launcherLog?.modifiedAt || '')) >= cutoff);
  const effectiveRoot = String(diagnostic?.effectiveRoot || '').trim();
  const isEffectiveRoot = (root) => {
    try {
      return effectiveRoot && path.resolve(root?.rootDir || '').toLowerCase() === path.resolve(effectiveRoot).toLowerCase();
    } catch {
      return false;
    }
  };
  const baselineRoots = Array.isArray(attempt?.minecraftSignalBaseline?.roots)
    ? attempt.minecraftSignalBaseline.roots
    : [];
  const signalsAfterBaseline = (root) => {
    const current = Array.isArray(root?.launcherLog?.signals) ? root.launcherLog.signals : [];
    if (!baselineRoots.length) return current;
    const baselineRoot = baselineRoots.find((candidate) => samePath(candidate?.rootDir || '', root?.rootDir || ''));
    const baseline = Array.isArray(baselineRoot?.launcherLog?.signals) ? baselineRoot.launcherLog.signals : [];
    const remaining = new Map();
    for (const line of baseline) remaining.set(line, (remaining.get(line) || 0) + 1);
    return current.filter((line) => {
      const count = remaining.get(line) || 0;
      if (!count) return true;
      remaining.set(line, count - 1);
      return false;
    });
  };
  const recordsForRoots = (selectedRoots) => selectedRoots
    .flatMap((root, rootIndex) => signalsAfterBaseline(root).map((line) => ({
      line,
      modifiedAt: root.launcherLog?.modifiedAt || '',
      source: isEffectiveRoot(root) ? 'Configured Minecraft root' : `Fallback Minecraft root ${rootIndex + 1}`
    })))
    .filter((record) => useful.test(record.line));
  const effectiveRecords = recordsForRoots(roots.filter(isEffectiveRoot));
  const records = (effectiveRecords.length ? effectiveRecords : recordsForRoots(roots))
    .sort((left, right) => String(left.modifiedAt).localeCompare(String(right.modifiedAt)));
  return records.slice(-12).map((record) => `[${record.source}] ${record.line}`);
}

async function enrichLaunchAttempt(attempt, config = {}) {
  const [system, minecraftDiagnostic, instanceSignals] = await Promise.all([
    launchSystemSnapshot(config).catch(() => null),
    minecraftLaunchDiagnostic(config).catch(() => null),
    minecraftInstanceSignalsForLaunch(config.instanceDir || attempt.instanceDir, attempt).catch(() => []),
  ]);
  attempt.system = system;
  const launcherSignals = minecraftSignalsForLaunch(minecraftDiagnostic, attempt);
  attempt.minecraftSignals = [...instanceSignals, ...launcherSignals].slice(-24);
  return attempt;
}

async function persistLaunchAttempt(attempt, config = {}) {
  const effectiveConfig = config?.instanceDir ? config : configForPack(defaultConfig(), attempt?.pack?.channel || 'stable');
  attempt.instanceDir = attempt.instanceDir || effectiveConfig.instanceDir || defaultInstanceDir();
  attempt.minecraftRoot = attempt.minecraftRoot || effectiveConfig.minecraftLauncher?.rootDir || defaultMinecraftRoot();
  await withDiagnosticTimeout(enrichLaunchAttempt(attempt, effectiveConfig), 3000, 'Launch report enrichment').catch(() => attempt);
  let saved = null;
  let writeError = '';
  try {
    saved = await withDiagnosticTimeout(writeLaunchReport(attempt.instanceDir, attempt), 2000, 'Launch report write');
  } catch (error) {
    writeError = error?.message || String(error);
    attempt.reportWriteError = `Could not save the report file: ${writeError}`;
  }
  const text = saved?.text || formatLaunchReport(attempt);
  lastLaunchDiagnostic = {
    attemptId: attempt.attemptId,
    result: attempt.result,
    path: saved?.path || '',
    directory: saved?.directory || '',
    text,
    writeError,
    attempt,
    config: effectiveConfig
  };
  return lastLaunchDiagnostic;
}

function markFailedLaunchRequirement(attempt) {
  const failed = [...(attempt?.steps || [])].reverse().find((step) => step.status === 'FAIL');
  if (!failed) return;
  const requirementByStep = {
    'legal-consent': 'legal',
    'load-config': 'instance',
    'installed-manifest': 'installed',
    'release-feed': 'releaseFeed',
    'launcher-version': 'launcherVersion',
    integrity: 'integrity',
    'java-profile-check': 'java8',
    'launcher-proof': 'launcherProof',
    'prepare-profile': 'minecraftProfile',
    'verify-assets': 'minecraftRuntime',
    'install-forge': 'minecraftRuntime',
    'final-readiness': 'minecraftRuntime',
    'launcher-handoff': 'minecraftLauncher',
    'select-profile': 'minecraftProfile',
    'profile-write-check': 'minecraftProfile',
    'open-launcher': 'minecraftLauncher'
  };
  const requirement = requirementByStep[failed.key];
  if (requirement) setLaunchRequirement(attempt, requirement, 'FAIL', failed.detail || 'This requirement failed during Play.');
}

function launchDiagnosticIpc(handler) {
  return async (event, payload = {}) => {
    const target = releaseTarget(payload?.packKey || payload || 'stable');
    const fallbackConfig = configForPack(defaultConfig(), target.id);
    const attempt = createLaunchAttempt({
      appName: app.getName(),
      appVersion: app.getVersion(),
      mode: isDeveloperMode() ? 'developer' : 'player',
      packaged: app.isPackaged,
      packId: target.packId,
      packName: target.name,
      channel: target.id,
      instanceDir: fallbackConfig.instanceDir,
      minecraftRoot: fallbackConfig.minecraftLauncher?.rootDir || ''
    });
    try {
      const result = await handler(event, payload, attempt);
      completeLaunchAttempt(attempt, 'HANDOFF CONFIRMED');
      await persistLaunchAttempt(attempt, attempt.runtimeConfig || fallbackConfig).catch(() => null);
      return result;
    } catch (error) {
      markFailedLaunchRequirement(attempt);
      completeLaunchAttempt(attempt, 'FAILED', error);
      const diagnostic = await persistLaunchAttempt(attempt, attempt.runtimeConfig || fallbackConfig).catch((reportError) => ({
        path: '',
        writeError: reportError?.message || String(reportError || 'Launch report could not be written.')
      }));
      recordErrorDiagnostic('play:start', error, {
        attemptId: attempt.attemptId,
        reportPath: diagnostic.path,
        reportWriteError: diagnostic.writeError
      });
      throw error;
    }
  };
}

function sanitizeMinecraftLauncherLog(text = '') {
  return String(text || '')
    .replace(/(--accessToken(?:\s+|=))("[^"]*"|'[^']*'|\S+)/gi, '$1<redacted>')
    .replace(/("(?:accessToken|clientToken|identityToken|refreshToken)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"')
    .replace(/(Authorization\s*:\s*(?:Bearer|XBL3\.0)[^\r\n]*)/gi, 'Authorization: <redacted>');
}

async function readFileTail(file, maxBytes = 256 * 1024) {
  const stat = await fs.stat(file);
  const bytes = Math.max(0, Math.min(stat.size, maxBytes));
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    if (bytes) await handle.read(buffer, 0, bytes, stat.size - bytes);
    return { stat, text: buffer.toString('utf8') };
  } finally {
    await handle.close();
  }
}

async function newestDiagnosticFile(directory, predicate = () => true) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !predicate(entry.name)) continue;
      const file = path.join(directory, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat) candidates.push({ file, stat });
    }
    return candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0] || null;
  } catch {
    return null;
  }
}

function diagnosticSignalLines(text = '', limit = 12) {
  const pattern = /(?:\bERROR\b|\bFATAL\b|Exception|Caused by:|NoClassDefFoundError|ClassNotFoundException|UnsupportedClassVersionError|OutOfMemoryError|EXCEPTION_ACCESS_VIOLATION|problematic frame|Process crashed|exit code|No libraries\?!|Could not (?:find|load|open|start)|Failed to (?:launch|start|load|initialize))/i;
  return sanitizeMinecraftLauncherLog(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && pattern.test(line))
    .slice(-limit);
}

async function minecraftInstanceSignalsForLaunch(instanceDir = '', attempt = {}) {
  const root = String(instanceDir || '').trim();
  if (!root || !(await pathExists(root))) return [];
  const startMs = Date.parse(String(attempt?.startedAt || ''));
  const diagnosticSnapshot = attempt?.result === 'DIAGNOSTIC';
  const cutoff = Number.isFinite(startMs)
    ? startMs - (diagnosticSnapshot ? 24 * 60 * 60 * 1000 : 2 * 60 * 1000)
    : Date.now() - 24 * 60 * 60 * 1000;
  const snapshot = await minecraftInstanceSignalDiagnostic(root);
  const baselineFiles = Array.isArray(attempt?.minecraftInstanceSignalBaseline?.files)
    ? attempt.minecraftInstanceSignalBaseline.files
    : [];
  const signals = [];
  for (const candidate of snapshot.files) {
    if (candidate.mtimeMs < cutoff) continue;
    const baseline = baselineFiles.find((item) => samePath(item?.file || '', candidate.file));
    let lines = [...candidate.signals];
    if (baseline) {
      if (candidate.size === baseline.size && candidate.mtimeMs <= baseline.mtimeMs) continue;
      if (candidate.size >= baseline.size) {
        const remaining = new Map();
        for (const line of baseline.signals || []) remaining.set(line, (remaining.get(line) || 0) + 1);
        lines = lines.filter((line) => {
          const count = remaining.get(line) || 0;
          if (!count) return true;
          remaining.set(line, count - 1);
          return false;
        });
      }
    }
    if (!lines.length) continue;
    signals.push(`${candidate.label} (${candidate.modifiedAt}):`);
    signals.push(...lines);
  }
  return signals.slice(-18);
}

async function minecraftInstanceSignalDiagnostic(instanceDir = '') {
  const root = String(instanceDir || '').trim();
  if (!root || !(await pathExists(root))) return { rootDir: root, files: [] };
  const latestLog = await newestDiagnosticFile(path.join(root, 'logs'), (name) => name.toLowerCase() === 'latest.log');
  const crashReport = await newestDiagnosticFile(path.join(root, 'crash-reports'), (name) => name.toLowerCase().endsWith('.txt'));
  const fatalJvm = await newestDiagnosticFile(root, (name) => /^hs_err_pid\d+\.log$/i.test(name));
  const files = [];
  for (const [label, candidate, limit] of [
    ['Minecraft latest.log', latestLog, 10],
    ['Minecraft crash report', crashReport, 12],
    ['Java fatal-error log', fatalJvm, 12]
  ]) {
    if (!candidate) continue;
    const { text } = await readFileTail(candidate.file, 160 * 1024).catch(() => ({ text: '' }));
    files.push({
      label,
      file: candidate.file,
      size: candidate.stat.size,
      mtimeMs: candidate.stat.mtimeMs,
      modifiedAt: candidate.stat.mtime.toISOString(),
      signals: diagnosticSignalLines(text, limit)
    });
  }
  return { rootDir: root, files };
}

async function minecraftRootLaunchDiagnostic(rootDir = '') {
  const root = String(rootDir || '').trim();
  if (!root) return null;
  const result = { rootDir: root, launcherLog: null };
  const logPath = path.join(root, 'launcher_log.txt');
  try {
    const { stat, text } = await readFileTail(logPath);
    const signalPattern = /No libraries\?!|Parsing version .*forge|\.json\.(?:arguments|libraries)|Starting game in folder|using java executable|Java argument:|Usage: javaw|Process crashed|exit code|crash report|UnsupportedClassVersionError|OutOfMemoryError|Could not reserve enough space|EXCEPTION_ACCESS_VIOLATION|problematic frame|\bERROR\b|\bFATAL\b|Exception|Caused by:/i;
    const signals = sanitizeMinecraftLauncherLog(text)
      .split(/\r?\n/)
      .filter((line) => signalPattern.test(line))
      .slice(-180);
    result.launcherLog = {
      file: logPath,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      signals
    };
  } catch (error) {
    result.launcherLog = { file: logPath, error: error.message || String(error), signals: [] };
  }
  return result;
}

async function minecraftLaunchDiagnostic(config = null) {
  if (!config) return null;
  const runtimeConfig = await minecraftLauncherRuntimeConfig(config).catch(() => config);
  const minecraft = runtimeConfig.minecraftLauncher || {};
  const roots = [...new Set([
    minecraft.rootDir,
    ...(Array.isArray(minecraft.syncRoots) ? minecraft.syncRoots : []),
    ...minecraftRootCandidates()
  ].filter(Boolean).map((item) => path.resolve(item)))];
  const existingRoots = [];
  for (const rootDir of roots) {
    if (await pathExists(rootDir)) existingRoots.push(rootDir);
  }
  const rootDiagnostics = [];
  for (const rootDir of existingRoots.slice(0, 6)) {
    rootDiagnostics.push(await minecraftRootLaunchDiagnostic(rootDir));
  }
  return {
    effectiveRoot: minecraft.rootDir || '',
    profileId: minecraft.profileId || '',
    roots: rootDiagnostics
  };
}

async function manualLaunchDiagnostic(payload = {}) {
  const target = releaseTarget(payload?.packKey || 'stable');
  const baseConfig = await loadConfig().catch(() => defaultConfig());
  const config = await minecraftLauncherRuntimeConfig(configForPack(baseConfig, target.id));
  const attempt = createLaunchAttempt({
    appName: app.getName(),
    appVersion: app.getVersion(),
    mode: isDeveloperMode() ? 'developer' : 'player',
    packaged: app.isPackaged,
    packId: target.packId,
    packName: target.name,
    channel: target.id,
    instanceDir: config.instanceDir,
    minecraftRoot: config.minecraftLauncher?.rootDir || ''
  });
  attempt.runtimeConfig = config;
  const step = beginLaunchStep(attempt, 'diagnostic-snapshot', 'Collect current launcher checks');
  try {
    const instanceExists = await pathExists(config.instanceDir);
    setLaunchRequirement(attempt, 'instance', instanceExists ? 'PASS' : 'FAIL', instanceExists ? config.instanceDir : 'The selected AHT instance folder does not exist.');

    const installedPath = path.join(config.instanceDir, '.aht-launcher', 'installed.json');
    let installed = null;
    if (await pathExists(installedPath)) {
      installed = await readJsonFile(installedPath).catch(() => null);
    }
    if (installed) {
      attempt.pack.installedVersion = String(installed.version || '');
      const packMatches = installed.packId === target.packId;
      setLaunchRequirement(
        attempt,
        'installed',
        packMatches ? 'PASS' : 'FAIL',
        packMatches
          ? `Installed version ${installed.version || 'unknown'}.`
          : `Installed pack ${installed.packId || 'unknown'} does not match ${target.packId}.`
      );
    } else {
      setLaunchRequirement(attempt, 'installed', 'FAIL', 'installed.json is missing or unreadable.');
    }
    setLaunchRequirement(
      attempt,
      'releaseFeed',
      config.latestUrl ? 'WARN' : 'FAIL',
      config.latestUrl ? 'Configured; live availability is checked during Play.' : 'No release feed is configured.'
    );

    const [java8, profile] = await Promise.all([
      java8RuntimeStatus(config, { refresh: true }).catch(() => null),
      inspectMinecraftLauncherProfile({ config, latest: installed, installed }).catch(() => null)
    ]);
    if (java8?.usable) {
      setLaunchRequirement(attempt, 'java8', 'PASS', `${java8.vendor || 'Java'} ${java8.version || '8'} ${java8.arch || '64-bit'} at ${java8.path}.`);
    } else {
      setLaunchRequirement(attempt, 'java8', 'FAIL', java8?.reason || java8?.rejectedReason || 'No usable 64-bit Java 8 runtime was detected.');
    }
    if (profile?.profileExists) {
      setLaunchRequirement(attempt, 'minecraftProfile', 'PASS', `${profile.profileName || target.name}; ${profile.versionId || 'version not resolved'}.`);
    } else {
      setLaunchRequirement(attempt, 'minecraftProfile', 'FAIL', 'The exact AHT Minecraft profile is missing.');
    }
    if (profile?.loaderInstalled) {
      setLaunchRequirement(attempt, 'minecraftRuntime', 'WARN', `${profile.versionId || 'Forge profile'} metadata exists; Play or Update verifies every required asset and library.`);
    } else {
      setLaunchRequirement(attempt, 'minecraftRuntime', 'WARN', 'Forge assets and libraries are fully verified during Play or Update.');
    }
    const proofFile = launcherProofPath(config.instanceDir, config.launcherProof?.channel || 'player');
    const proofExists = await pathExists(proofFile);
    setLaunchRequirement(
      attempt,
      'launcherProof',
      proofExists ? 'WARN' : 'NOT CHECKED',
      proofExists ? 'A prior proof file exists; Play always replaces it with a fresh proof.' : 'A fresh proof is created during Play.'
    );
    setLaunchRequirement(attempt, 'minecraftLauncher', 'NOT CHECKED', 'Application activation is verified when Play is clicked.');
    finishLaunchStep(step, 'PASS', 'Current checks and recent crash signals were collected.');
  } catch (error) {
    finishLaunchStep(step, 'WARN', error?.message || error);
  }
  completeLaunchAttempt(attempt, 'DIAGNOSTIC');
  return persistLaunchAttempt(attempt, config);
}

async function refreshLastLaunchDiagnostic() {
  if (!lastLaunchDiagnostic?.attempt) return null;
  const attempt = lastLaunchDiagnostic.attempt;
  const config = lastLaunchDiagnostic.config || attempt.runtimeConfig || defaultConfig();
  await withDiagnosticTimeout(enrichLaunchAttempt(attempt, config), 3000, 'Launch report refresh').catch(() => attempt);
  let saved = null;
  try {
    saved = await withDiagnosticTimeout(writeLaunchReport(attempt.instanceDir, attempt), 2000, 'Launch report refresh write');
  } catch (error) {
    attempt.reportWriteError = `Could not refresh the saved report file: ${error?.message || String(error)}`;
  }
  const text = saved?.text || formatLaunchReport(attempt);
  lastLaunchDiagnostic = {
    ...lastLaunchDiagnostic,
    path: saved?.path || lastLaunchDiagnostic.path || '',
    directory: saved?.directory || lastLaunchDiagnostic.directory || '',
    text,
    attempt,
    config
  };
  return lastLaunchDiagnostic;
}

async function buildErrorDiagnosticReport(payload = {}) {
  const target = releaseTarget(payload?.packKey || 'stable');
  const wantsLaunchReport = payload.context === 'play:start'
    || payload.context === 'settings-java'
    || /launch diagnostics|launch failed/i.test(String(payload.title || ''));
  if (wantsLaunchReport) {
    const samePack = lastLaunchDiagnostic?.attempt?.pack?.channel === target.id;
    const diagnostic = await (samePack
      ? refreshLastLaunchDiagnostic()
      : manualLaunchDiagnostic({ ...payload, packKey: target.id }))
      .catch(() => null);
    if (diagnostic?.text) return { text: diagnostic.text, path: diagnostic.path || '' };
  }

  const config = await loadConfig().catch(() => null);
  const system = await launchSystemSnapshot(config || {}).catch(() => ({}));
  const error = errorForDiagnostic(lastErrorDiagnostic?.error || payload.message || payload.detail || 'Unknown error');
  const lines = [
    'A HARD TIME LAUNCHER ERROR REPORT',
    '================================================================',
    `Created: ${new Date().toISOString()}`,
    `Launcher: ${app.getName()} ${app.getVersion()} (${isDeveloperMode() ? 'developer' : 'player'})`,
    `Context: ${sanitizeDiagnosticText(payload.context || lastErrorDiagnostic?.channel || 'launcher', 120)}`,
    '',
    'ERROR',
    `  ${sanitizeDiagnosticText(payload.message || payload.detail || error.message, 1200)}`,
    '',
    'LAST MAIN-PROCESS FAILURE',
    `  Channel: ${sanitizeDiagnosticText(lastErrorDiagnostic?.channel || 'Not recorded', 120)}`,
    `  Time: ${lastErrorDiagnostic?.at || 'Not recorded'}`,
    `  Message: ${sanitizeDiagnosticText(lastErrorDiagnostic?.error?.message || 'Not recorded', 1200)}`,
    '',
    'PC',
    `  Operating system: ${sanitizeDiagnosticText(system.osName || 'Unknown', 240)}`,
    `  Architecture: ${sanitizeDiagnosticText(system.arch || process.arch, 80)}`,
    `  CPU: ${sanitizeDiagnosticText(system.cpuModel || 'Unknown', 240)} (${system.logicalCores || 0} logical cores)`,
    `  Memory: ${Math.round((Number(system.totalMemoryBytes) || 0) / 1024 / 1024)} MB total; ${Math.round((Number(system.freeMemoryBytes) || 0) / 1024 / 1024)} MB free`,
    '',
    'PRIVACY',
    '  Passwords, Microsoft/Minecraft tokens, AHT proof tokens, API keys, and environment secrets are not included.',
    '================================================================',
    ''
  ];
  return { text: lines.join('\r\n'), path: '' };
}

async function copyErrorDiagnosticReport(payload = {}) {
  const report = await buildErrorDiagnosticReport(payload);
  clipboard.writeText(report.text);
  return {
    ok: true,
    copied: true,
    chars: report.text.length,
    fileName: report.path ? path.basename(report.path) : ''
  };
}

function diagnosticIpc(channel, handler) {
  return async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      recordErrorDiagnostic(channel, error);
      throw error;
    }
  };
}
function weightedOperationPercent(percent, base = 0, span = 100) {
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return Math.max(0, Math.min(100, Math.round(base + ((normalizedPercent / 100) * span))));
}

function byteOperationProgress(phase, currentPath, progress, base, span) {
  const completedBytes = Math.max(0, Number(progress.loaded || progress.completed || 0));
  const totalBytes = Math.max(0, Number(progress.total || 0));
  return {
    phase,
    currentPath,
    unit: 'bytes',
    completed: completedBytes,
    total: totalBytes,
    completedBytes,
    totalBytes,
    percent: weightedOperationPercent(progress.percent, base, span),
    currentPercent: Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : 0,
    speedBytesPerSecond: progress.speedBytesPerSecond || 0
  };
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

function trustedMinecraftOpenCommandAllowed() {
  return process.env.AHT_TEST_HOOKS === '1'
    && process.env.AHT_TEST_ALLOW_MINECRAFT_OPEN_COMMAND === '1';
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

function storedDeveloperSecretCount(file = {}) {
  return DEVELOPER_SECRET_KEYS.filter((key) => hasStoredSecret(file?.secrets?.[key])).length;
}

function developerSecretVaultEnabled() {
  return launchMode === 'developer' && (!explicitUserDataDir || Boolean(process.env.AHT_DEVELOPER_VAULT_DIR));
}

function developerSecretVaultDir() {
  const override = String(process.env.AHT_DEVELOPER_VAULT_DIR || '').trim();
  if (override) return path.resolve(override);
  const localData = process.env.LOCALAPPDATA || app.getPath('appData');
  return path.join(localData, 'AHT', 'developer-secret-vault');
}

function developerSecretVaultSnapshotsDir() {
  return path.join(developerSecretVaultDir(), 'snapshots');
}

function developerSecretVaultRecordsSync() {
  if (!developerSecretVaultEnabled()) return [];
  const snapshotsDir = developerSecretVaultSnapshotsDir();
  try {
    return fsSync.readdirSync(snapshotsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const dir = path.join(snapshotsDir, entry.name);
        const secrets = readJsonSync(path.join(dir, 'developer.secrets.json'));
        const localState = path.join(dir, 'Local State');
        return {
          dir,
          name: entry.name,
          secrets,
          localState,
          count: storedDeveloperSecretCount(secrets),
          hasLocalState: fsSync.existsSync(localState)
        };
      })
      .filter((entry) => entry.secrets?.secrets && entry.count > 0)
      .sort((left, right) => right.count - left.count || right.name.localeCompare(left.name));
  } catch {
    return [];
  }
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
  if (!developerSecretVaultEnabled()) {
    return;
  }
  const currentDir = app.getPath('userData');
  const legacyDir = path.join(app.getPath('appData'), 'aht-launcher');
  const currentLocalState = path.join(currentDir, 'Local State');
  const currentSecrets = readJsonSync(path.join(currentDir, 'developer.secrets.json'));
  const sources = developerSecretVaultRecordsSync();
  if (path.normalize(currentDir).toLowerCase() !== path.normalize(legacyDir).toLowerCase()) {
    const legacySecrets = readJsonSync(path.join(legacyDir, 'developer.secrets.json'));
    const legacyLocalState = path.join(legacyDir, 'Local State');
    if (legacySecrets?.secrets && fsSync.existsSync(legacyLocalState)) {
      sources.push({
        dir: legacyDir,
        name: 'legacy',
        secrets: legacySecrets,
        localState: legacyLocalState,
        count: storedDeveloperSecretCount(legacySecrets),
        hasLocalState: true
      });
    }
  }

  const best = sources
    .filter((entry) => entry.hasLocalState && entry.count > 0)
    .sort((left, right) => right.count - left.count || right.name.localeCompare(left.name))[0];
  if (!best) {
    return;
  }
  const currentCount = storedDeveloperSecretCount(currentSecrets);
  const shouldRestore = !fsSync.existsSync(currentLocalState)
    || currentCount === 0
    || (currentCount <= best.count && developerSecretsUseLegacyKey(currentSecrets, best.secrets));
  if (!shouldRestore) return;
  fsSync.mkdirSync(currentDir, { recursive: true });
  fsSync.copyFileSync(best.localState, currentLocalState);
}

function configPath() {
  return path.join(app.getPath('userData'), 'launcher.config.json');
}

function identityPath() {
  return path.join(app.getPath('userData'), 'identity.json');
}

function installerJava8SelectionPath() {
  return path.join(app.getPath('userData'), 'installer-java8-selection.json');
}

async function readPendingInstallerJava8Selection() {
  if (isDeveloperMode()) return null;
  const file = installerJava8SelectionPath();
  if (!(await pathExists(file))) return null;
  try {
    const selection = await readJsonFile(file);
    if (
      Number(selection?.schemaVersion) !== 1
      || selection?.consumedAt
      || typeof selection?.allowManagedJava8 !== 'boolean'
    ) {
      return null;
    }
    return { file, selection, allowManagedJava8: selection.allowManagedJava8 };
  } catch (error) {
    console.warn(`Unable to read the installer Java 8 selection: ${error.message || error}`);
    return null;
  }
}

async function markInstallerJava8SelectionConsumed(pending = null) {
  if (!pending?.file || !pending?.selection) return;
  try {
    await writeJsonFile(pending.file, {
      ...pending.selection,
      consumedAt: new Date().toISOString(),
      consumedByLauncherVersion: app.getVersion()
    });
  } catch (error) {
    console.warn(`Unable to mark the installer Java 8 selection as consumed: ${error.message || error}`);
  }
}

function legalConsentPath() {
  return path.join(app.getPath('userData'), 'legal-consent.json');
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
    try {
      current = await readJsonFile(file);
    } catch {
      current = { schemaVersion: 1, secrets: {} };
    }
  }

  if (!developerSecretVaultEnabled()) {
    return current;
  }

  const backupFiles = developerSecretVaultRecordsSync().map((entry) => path.join(entry.dir, 'developer.secrets.json'));
  const legacyFile = legacyDeveloperSecretsPath();
  if (!samePath(file, legacyFile) && await pathExists(legacyFile)) {
    backupFiles.push(legacyFile);
  }

  let mergedFile = current;
  let changed = false;
  for (const backupFile of backupFiles) {
    try {
      const backup = await readJsonFile(backupFile);
      const merged = mergeDeveloperSecretFiles(mergedFile, backup);
      mergedFile = merged.file;
      changed ||= merged.changed;
    } catch {
      // A damaged backup must not hide another valid snapshot.
    }
  }
  if (changed) await writeJsonFile(file, mergedFile);
  return mergedFile;
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
  if (!value) {
    return;
  }
  next.secrets[key] = encryptDeveloperSecret(value);
}

async function attachDeveloperVaultEncryptionProfile(snapshotDir, currentLocalState) {
  const snapshotLocalState = path.join(snapshotDir, 'Local State');
  if (await pathExists(snapshotLocalState)) return true;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await pathExists(currentLocalState)) {
      await fs.copyFile(currentLocalState, snapshotLocalState);
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function writeDeveloperSecretVaultSnapshot(file = {}) {
  if (!developerSecretVaultEnabled() || storedDeveloperSecretCount(file) === 0) return null;
  const currentLocalState = path.join(app.getPath('userData'), 'Local State');

  const existing = developerSecretVaultRecordsSync()[0];
  if (existing && JSON.stringify(existing.secrets?.secrets || {}) === JSON.stringify(file.secrets || {})) {
    if (!existing.hasLocalState) {
      void attachDeveloperVaultEncryptionProfile(existing.dir, currentLocalState).catch(() => {});
    }
    return existing.dir;
  }

  const snapshotsDir = developerSecretVaultSnapshotsDir();
  await ensureDir(snapshotsDir);
  const snapshotName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const temporaryDir = path.join(snapshotsDir, `.${snapshotName}.tmp`);
  const snapshotDir = path.join(snapshotsDir, snapshotName);
  await ensureDir(temporaryDir);
  try {
    if (await pathExists(currentLocalState)) {
      await fs.copyFile(currentLocalState, path.join(temporaryDir, 'Local State'));
    }
    await writeJsonFile(path.join(temporaryDir, 'developer.secrets.json'), file);
    await fs.rename(temporaryDir, snapshotDir);
  } catch (error) {
    await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  void attachDeveloperVaultEncryptionProfile(snapshotDir, currentLocalState).catch(() => {});
  return snapshotDir;
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
  await writeDeveloperSecretVaultSnapshot(next);
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

function defaultClientModpackDir() {
  return path.join(app.getPath('home'), 'curseforge', 'minecraft', 'Instances', 'RLCraft Dregora');
}

function defaultCacheModsDir() {
  return path.join(defaultClientModpackDir(), 'mods');
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
  return /\/curseforge\/minecraft\/install(?:\/|$)/.test(normalized);
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
    packs: {
      ptb: {
        packId: 'a-hard-time-ptb',
        name: 'A Hard Time PTB',
        latestUrl: '',
        instanceDir: defaultPtbInstanceDir()
      }
    },
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
      clientModpackDir: defaultClientModpackDir(),
      ptbClientModpackDir: defaultClientModpackDir(),
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
    social: {
      enabled: true,
      baseUrl: '',
      stateUrl: 'api/social',
      actionUrl: 'api/social/actions'
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
      memoryMb: DEFAULT_MINECRAFT_MEMORY_MB,
      java8InstallOverride: null
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

function defaultPtbInstanceDir() {
  if (process.platform === 'win32') {
    return path.join(ahtInstallRoot(), releaseTarget('ptb').instanceFolderName);
  }
  if (process.platform === 'darwin') {
    return path.join(app.getPath('appData'), 'A Hard Time', 'PTB Instance');
  }
  platformKey(process.platform);
}

function defaultInstanceDir() {
  return isDeveloperMode() ? defaultDeveloperInstanceDir() : defaultPlayerInstanceDir();
}

function configForPack(baseConfig, packValue = 'stable') {
  const target = releaseTarget(packValue);
  const packSettings = target.id === 'stable' ? {} : (baseConfig.packs?.[target.id] || {});
  const instanceDir = target.id === 'stable'
    ? baseConfig.instanceDir
    : (String(packSettings.instanceDir || '').trim() || defaultPtbInstanceDir());
  const latestUrl = target.id === 'stable'
    ? baseConfig.latestUrl
    : (String(packSettings.latestUrl || '').trim() || releaseTargetFeedUrl(baseConfig.latestUrl, target.id));
  return {
    ...baseConfig,
    packId: target.packId,
    instanceDir,
    latestUrl,
    launcherProof: {
      ...baseConfig.launcherProof,
      channel: isDeveloperMode() ? 'developer' : 'player'
    },
    minecraftLauncher: {
      ...baseConfig.minecraftLauncher,
      profileId: target.profileId,
      profileName: target.profileName
    },
    playCommand: {
      ...baseConfig.playCommand,
      cwd: instanceDir
    }
  };
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

function uniqueCurrentPlatformPaths(paths = []) {
  const seen = new Set();
  const result = [];
  for (const candidate of paths) {
    const text = String(candidate || '').trim();
    if (!text) continue;
    const normalized = path.normalize(text);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function curseForgeInstallRootFromMinecraftRoot(value = '') {
  const rootDir = String(value || '').trim();
  if (!rootDir) return '';
  const normalized = path.normalize(rootDir);
  const normalizedForMatch = normalized.replace(/\\/g, '/');
  const instanceMatch = normalizedForMatch.match(/^(.*)\/instances\/[^/]+$/i);
  if (instanceMatch?.[1]) {
    return path.join(path.normalize(instanceMatch[1]), 'Install');
  }
  if (/\/install$/i.test(normalizedForMatch)) {
    return normalized;
  }
  return path.join(normalized, 'Install');
}

function collectCurseForgeMinecraftRoots(value, key = '', roots = []) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return roots;
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try {
        collectCurseForgeMinecraftRoots(JSON.parse(text), key, roots);
      } catch {}
      return roots;
    }
    if (/minecraft[-_ ]?root|minecraft[-_ ]?dir|minecraft[-_ ]?path/i.test(key)) {
      const installRoot = curseForgeInstallRootFromMinecraftRoot(text);
      if (installRoot) roots.push(installRoot);
    }
    return roots;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCurseForgeMinecraftRoots(item, key, roots);
    return roots;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectCurseForgeMinecraftRoots(childValue, childKey, roots);
    }
  }
  return roots;
}

function curseForgeStorageFileCandidates() {
  if (process.env.AHT_TEST_HOOKS === '1') {
    const testStorageFile = String(process.env.AHT_TEST_CURSEFORGE_STORAGE_FILE || '').trim();
    return testStorageFile ? [path.resolve(testStorageFile)] : [];
  }
  const home = app.getPath('home');
  if (process.platform === 'darwin') {
    return uniqueCurrentPlatformPaths([
      path.join(home, 'Library', 'Application Support', 'CurseForge', 'storage.json'),
      path.join(home, 'Library', 'Application Support', 'curseforge', 'storage.json')
    ]);
  }
  if (process.platform !== 'win32') return [];
  return uniqueCurrentPlatformPaths([
    process.env.APPDATA ? path.join(process.env.APPDATA, 'CurseForge', 'storage.json') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'curseforge', 'storage.json') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CurseForge', 'storage.json') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'curseforge', 'storage.json') : ''
  ]);
}

function curseForgeStorageMinecraftRootCandidates() {
  const roots = [];
  for (const file of curseForgeStorageFileCandidates()) {
    try {
      if (!fsSync.existsSync(file)) continue;
      collectCurseForgeMinecraftRoots(JSON.parse(fsSync.readFileSync(file, 'utf8')), '', roots);
    } catch {}
  }
  return uniqueCurrentPlatformPaths(roots);
}

function localCurseForgeMinecraftRoots(config = {}) {
  const home = app.getPath('home');
  const documents = app.getPath('documents');
  const configuredRoots = [
    config.minecraftLauncher?.rootDir,
    ...(Array.isArray(config.minecraftLauncher?.syncRoots) ? config.minecraftLauncher.syncRoots : [])
  ];
  const staticRoots = process.platform === 'darwin'
    ? [
        path.join(home, 'curseforge', 'minecraft', 'Install'),
        path.join(home, 'CurseForge', 'minecraft', 'Install'),
        path.join(documents, 'CurseForge', 'minecraft', 'Install'),
        path.join(documents, 'curseforge', 'minecraft', 'Install'),
        path.join(home, 'Library', 'Application Support', 'CurseForge', 'minecraft', 'Install'),
        path.join(home, 'Library', 'Application Support', 'curseforge', 'minecraft', 'Install')
      ]
    : [
        path.join(home, 'curseforge', 'minecraft', 'Install'),
        path.join(home, 'CurseForge', 'minecraft', 'Install'),
        path.join(documents, 'CurseForge', 'minecraft', 'Install'),
        path.join(documents, 'curseforge', 'minecraft', 'Install'),
        process.env.APPDATA ? path.join(process.env.APPDATA, 'CurseForge', 'minecraft', 'Install') : '',
        process.env.APPDATA ? path.join(process.env.APPDATA, 'curseforge', 'minecraft', 'Install') : '',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CurseForge', 'minecraft', 'Install') : '',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'curseforge', 'minecraft', 'Install') : ''
      ];
  const detectedRoots = [
    process.env.AHT_TEST_HOOKS === '1' ? process.env.AHT_TEST_CURSEFORGE_MINECRAFT_ROOT : '',
    ...curseForgeStorageMinecraftRootCandidates(),
    ...configuredRoots.filter(isCurseForgeMinecraftRoot)
  ];
  if (process.env.AHT_TEST_HOOKS !== '1') detectedRoots.push(...staticRoots);
  return uniqueCurrentPlatformPaths(detectedRoots);
}

async function firstExistingCurseForgeMinecraftRoot(config = {}) {
  if (!['win32', 'darwin'].includes(process.platform)) return '';
  for (const rootDir of localCurseForgeMinecraftRoots(config)) {
    try {
      const stat = await fs.stat(rootDir);
      if (!stat.isDirectory()) continue;
      if (process.platform === 'win32' && await pathExists(path.join(rootDir, 'minecraft.exe'))) {
        return rootDir;
      }
      if (process.platform === 'darwin') {
        for (const marker of ['launcher_profiles.json', 'versions', 'libraries']) {
          if (await pathExists(path.join(rootDir, marker))) return rootDir;
        }
      }
    } catch {
      // Continue to the next known CurseForge storage root.
    }
  }
  return '';
}

async function existingMinecraftLauncherFallbackRoots(config = {}, primaryRoot = '') {
  const configuredRoot = String(config.minecraftLauncher?.rootDir || '').trim();
  const explicitRoots = Array.isArray(config.minecraftLauncher?.syncRoots)
    ? config.minecraftLauncher.syncRoots
    : [];
  const normalRoots = minecraftRootCandidates(process.platform, {
    ...process.env,
    HOME: process.env.HOME || app.getPath('home'),
    USERPROFILE: process.env.USERPROFILE || app.getPath('home')
  });
  const knownCurseForgeRoots = localCurseForgeMinecraftRoots(config);
  const candidates = uniqueCurrentPlatformPaths([
    configuredRoot,
    ...explicitRoots,
    defaultMinecraftRoot(),
    ...normalRoots
  ]);
  const roots = [];
  for (const candidate of candidates) {
    if (primaryRoot && samePath(candidate, primaryRoot)) continue;
    if (knownCurseForgeRoots.some((rootDir) => samePath(rootDir, candidate))) continue;
    const requiredFallback = Boolean(
      (configuredRoot && samePath(candidate, configuredRoot))
      || samePath(candidate, defaultMinecraftRoot())
      || explicitRoots.some((rootDir) => samePath(rootDir, candidate))
    );
    if (requiredFallback || await pathExists(candidate)) roots.push(candidate);
  }
  return uniqueCurrentPlatformPaths(roots);
}

async function minecraftLauncherRuntimeConfig(config = {}) {
  if (trustedMinecraftOpenCommandAllowed() && config.minecraftLauncher?.openCommand) return config;
  const safeConfig = config.minecraftLauncher?.openCommand
    ? {
      ...config,
      minecraftLauncher: {
        ...(config.minecraftLauncher || {}),
        openCommand: '',
        openArgs: []
      }
    }
    : config;
  const curseForgeRoot = await firstExistingCurseForgeMinecraftRoot(safeConfig);
  if (!curseForgeRoot) return safeConfig;
  const fallbackRoots = await existingMinecraftLauncherFallbackRoots(safeConfig, curseForgeRoot);
  return {
    ...safeConfig,
    minecraftLauncher: {
      ...(safeConfig.minecraftLauncher || {}),
      rootDir: curseForgeRoot,
      runtimeCurseForgeRoot: curseForgeRoot,
      syncDefaultRoots: false,
      syncRoots: fallbackRoots
    }
  };
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
    packs: {
      ...defaults.packs,
      ...stored.packs,
      ptb: { ...defaults.packs?.ptb, ...stored.packs?.ptb }
    },
    developer: { ...defaults.developer, ...stored.developer },
    launcherUpdate: { ...defaults.launcherUpdate, ...stored.launcherUpdate },
    launcherProof: { ...defaults.launcherProof, ...stored.launcherProof },
    social: { ...defaults.social, ...stored.social },
    serverTransfer: { ...defaults.serverTransfer, ...stored.serverTransfer },
    minecraftLauncher: { ...defaults.minecraftLauncher, ...stored.minecraftLauncher },
    playCommand: { ...defaults.playCommand, ...stored.playCommand }
  };
  if (merged.minecraftLauncher?.profileName === 'A Hard Time Dregora') {
    merged.minecraftLauncher.profileName = 'A Hard Time';
  }
  if (!trustedMinecraftOpenCommandAllowed()) {
    merged.minecraftLauncher.openCommand = '';
    merged.minecraftLauncher.openArgs = [];
  }
  merged.serverTransfer.remoteDir = serverTransferParentDir(
    merged.serverTransfer.remoteDir,
    merged.serverTransfer.sourceDir
  );
  merged.developer.defaultOutDir = resolveReleaseOutDir(merged.developer?.defaultOutDir);
  return merged;
}

function isPtbReleaseFeedUrl(value = '') {
  try {
    return /\/ptb\/latest\.json$/i.test(new URL(String(value || '').trim()).pathname);
  } catch {
    return false;
  }
}

function normalizedWorkerControlConfig(config = {}) {
  const normalized = {
    ...config,
    curseforge: { ...(config.curseforge || {}) },
    sync: { ...(config.sync || {}) },
    packs: {
      ...(config.packs || {}),
      ptb: { ...(config.packs?.ptb || {}) }
    },
    developer: { ...(config.developer || {}) },
    launcherUpdate: { ...(config.launcherUpdate || {}) },
    launcherProof: { ...(config.launcherProof || {}) },
    social: { ...(config.social || {}) },
    minecraftLauncher: { ...(config.minecraftLauncher || {}) },
    playCommand: { ...(config.playCommand || {}) }
  };
  let changed = false;

  const normalizeBase = (section, key) => {
    const current = String(normalized[section]?.[key] || '').trim();
    if (!current) return;
    const next = workerServiceBaseUrl(current);
    if (next && next !== current) {
      normalized[section][key] = next;
      changed = true;
    }
  };
  normalizeBase('sync', 'baseUrl');
  normalizeBase('developer', 'adminBaseUrl');
  normalizeBase('launcherProof', 'baseUrl');
  normalizeBase('social', 'baseUrl');

  const launcherLatest = String(normalized.launcherUpdate.latestUrl || '').trim();
  if (launcherLatest && /\/launcher\/latest\.json$/i.test((() => {
    try { return new URL(launcherLatest).pathname; } catch { return ''; }
  })())) {
    const base = workerServiceBaseUrl(launcherLatest);
    const next = base ? new URL('launcher/latest.json', base).toString() : launcherLatest;
    if (next !== launcherLatest) {
      normalized.launcherUpdate.latestUrl = next;
      changed = true;
    }
  }

  const proxyBase = String(normalized.curseforge.proxyBaseUrl || '').trim();
  if (proxyBase) {
    try {
      const proxyUrl = new URL(proxyBase);
      if (/\/ptb\/cf\/?$/i.test(proxyUrl.pathname)) {
        proxyUrl.pathname = proxyUrl.pathname.replace(/\/ptb\/cf\/?$/i, '/cf/');
        normalized.curseforge.proxyBaseUrl = proxyUrl.toString();
        changed = true;
      }
    } catch {}
  }

  const ptbFeed = String(normalized.packs.ptb.latestUrl || '').trim();
  const stableFeedWasPtb = isDeveloperMode()
    && isPtbReleaseFeedUrl(normalized.latestUrl)
    && (!ptbFeed || String(normalized.latestUrl).trim() === ptbFeed);
  if (stableFeedWasPtb) {
    const stableBase = workerServiceBaseUrl(normalized.latestUrl);
    if (stableBase) {
      normalized.latestUrl = new URL('latest.json', stableBase).toString();
      changed = true;
    }
    const contaminatedInstanceDir = String(normalized.instanceDir || '').trim();
    const ptbInstanceDir = String(normalized.packs.ptb.instanceDir || '').trim();
    if (
      contaminatedInstanceDir
      && (samePath(contaminatedInstanceDir, ptbInstanceDir) || samePath(contaminatedInstanceDir, defaultPtbInstanceDir()))
    ) {
      normalized.instanceDir = defaultDeveloperInstanceDir();
      if (!normalized.playCommand.cwd || samePath(normalized.playCommand.cwd, contaminatedInstanceDir)) {
        normalized.playCommand.cwd = normalized.instanceDir;
      }
      changed = true;
    }
    if (normalized.minecraftLauncher.profileId === releaseTarget('ptb').profileId) {
      normalized.minecraftLauncher.profileId = releaseTarget('stable').profileId;
      changed = true;
    }
    if (normalized.minecraftLauncher.profileName === releaseTarget('ptb').profileName) {
      normalized.minecraftLauncher.profileName = releaseTarget('stable').profileName;
      changed = true;
    }
  }

  return { config: normalized, changed };
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

function configMigrationBackupPrefix(file) {
  return `${path.basename(file)}.aht-before-curseforge-`;
}

async function backupConfigBeforeCurseForgeMigration(file) {
  if (!(await pathExists(file))) return '';
  const dir = path.dirname(file);
  const prefix = configMigrationBackupPrefix(file);
  try {
    const existing = (await fs.readdir(dir))
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.bak'))
      .sort();
    if (existing.length) return path.join(dir, existing[0]);
  } catch {}
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const backupFile = path.join(dir, `${prefix}${timestamp}.bak`);
  await fs.copyFile(file, backupFile, fsSync.constants.COPYFILE_EXCL);
  return backupFile;
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
  const detectedCurseForgeRoot = await firstExistingCurseForgeMinecraftRoot(configured);
  const detectedMinecraftRoot = detectedCurseForgeRoot
    || await firstExistingMinecraftLauncherRoot(localMinecraftLauncherCandidates());
  if (
    detectedMinecraftRoot
    && (
      detectedCurseForgeRoot
      || !configured.minecraftLauncher?.rootDir
      || configured.minecraftLauncher.rootDir === defaults.minecraftLauncher.rootDir
    )
  ) {
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
  const installerJava8Selection = await readPendingInstallerJava8Selection();
  if (!(await pathExists(file))) {
    if (installerJava8Selection) {
      defaults.minecraftLauncher = {
        ...defaults.minecraftLauncher,
        java8InstallOverride: installerJava8Selection.allowManagedJava8
      };
    }
    await ensureDir(defaults.instanceDir);
    await writeJsonFile(file, configForStorage(defaults));
    await markInstallerJava8SelectionConsumed(installerJava8Selection);
    return defaults;
  }
  const stored = await readJsonFile(file);
  let config = mergeConfig(defaults, stored);
  const normalizedWorkerConfig = normalizedWorkerControlConfig(config);
  config = normalizedWorkerConfig.config;
  let changed = normalizedWorkerConfig.changed;
  if (!trustedMinecraftOpenCommandAllowed() && String(stored.minecraftLauncher?.openCommand || '').trim()) {
    changed = true;
  }
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
  const preferredCurseForgeRoot = await firstExistingCurseForgeMinecraftRoot(config);
  if (preferredCurseForgeRoot && !samePath(config.minecraftLauncher?.rootDir, preferredCurseForgeRoot)) {
    try {
      await backupConfigBeforeCurseForgeMigration(file);
      config.minecraftLauncher = {
        ...config.minecraftLauncher,
        rootDir: preferredCurseForgeRoot
      };
      changed = true;
    } catch (error) {
      console.warn(`Unable to back up launcher settings before selecting CurseForge: ${error.message || error}`);
    }
  }
  if (!Number.isFinite(Number(stored.minecraftLauncher?.memoryMb)) || Number(stored.minecraftLauncher?.memoryMb) < DEFAULT_MINECRAFT_MEMORY_MB) {
    config.minecraftLauncher.memoryMb = DEFAULT_MINECRAFT_MEMORY_MB;
    changed = true;
  }
  if (installerJava8Selection) {
    config.minecraftLauncher = {
      ...config.minecraftLauncher,
      java8InstallOverride: installerJava8Selection.allowManagedJava8
    };
    changed = true;
  }
  if (isDeveloperMode()) {
    for (const key of ['sourceDir', 'host', 'username', 'remoteDir']) {
      if (!String(stored.serverTransfer?.[key] || '').trim() && String(defaults.serverTransfer?.[key] || '').trim()) {
        config.serverTransfer[key] = defaults.serverTransfer[key];
        changed = true;
      }
    }
  }
  if (!isDeveloperMode()) {
    for (const key of ['enabled', 'latestUrl']) {
      const value = defaults.launcherUpdate?.[key];
      if (value !== undefined && config.launcherUpdate?.[key] !== value) {
        config.launcherUpdate = { ...config.launcherUpdate, [key]: value };
        changed = true;
      }
    }
    for (const key of ['enabled', 'required', 'baseUrl', 'keyId']) {
      const value = defaults.launcherProof?.[key];
      if (value !== undefined && config.launcherProof?.[key] !== value) {
        config.launcherProof = { ...config.launcherProof, [key]: value };
        changed = true;
      }
    }
    for (const key of ['enabled', 'baseUrl', 'stateUrl', 'actionUrl']) {
      const value = defaults.social?.[key];
      if (value !== undefined && config.social?.[key] !== value) {
        config.social = { ...config.social, [key]: value };
        changed = true;
      }
    }
  }
  if (!Object.prototype.hasOwnProperty.call(stored.developer || {}, 'defaultCacheModsDir') && defaults.developer?.defaultCacheModsDir) {
    config.developer.defaultCacheModsDir = defaults.developer.defaultCacheModsDir;
    changed = true;
  }
  if (isDeveloperMode()) {
    for (const key of ['clientModpackDir', 'ptbClientModpackDir']) {
      if (!String(stored.developer?.[key] || '').trim() && String(defaults.developer?.[key] || '').trim()) {
        config.developer[key] = defaults.developer[key];
        changed = true;
      }
    }
  }
  if (!String(stored.developer?.defaultOutDir || '').trim()) {
    config.developer.defaultOutDir = resolveReleaseOutDir(config.developer?.defaultOutDir);
    changed = true;
  }
  await ensureDir(config.instanceDir);
  if (changed) {
    await writeJsonFile(file, configForStorage(config));
  }
  await markInstallerJava8SelectionConsumed(installerJava8Selection);
  return config;
}

async function saveConfig(nextConfig) {
  const current = await loadConfig();
  let merged = {
    ...current,
    ...nextConfig,
    curseforge: { ...current.curseforge, ...nextConfig.curseforge },
    sync: { ...current.sync, ...nextConfig.sync },
    packs: {
      ...current.packs,
      ...nextConfig.packs,
      ptb: { ...current.packs?.ptb, ...nextConfig.packs?.ptb }
    },
    developer: { ...current.developer, ...nextConfig.developer },
    launcherUpdate: { ...current.launcherUpdate, ...nextConfig.launcherUpdate },
    launcherProof: { ...current.launcherProof, ...nextConfig.launcherProof },
    social: { ...current.social, ...nextConfig.social },
    serverTransfer: { ...current.serverTransfer, ...nextConfig.serverTransfer },
    minecraftLauncher: { ...current.minecraftLauncher, ...nextConfig.minecraftLauncher },
    playCommand: { ...current.playCommand, ...nextConfig.playCommand }
  };
  if (!trustedMinecraftOpenCommandAllowed()) {
    merged.minecraftLauncher.openCommand = '';
    merged.minecraftLauncher.openArgs = [];
  }
  merged.serverTransfer.remoteDir = serverTransferParentDir(
    merged.serverTransfer.remoteDir,
    merged.serverTransfer.sourceDir
  );
  merged.developer.defaultOutDir = resolveReleaseOutDir(merged.developer?.defaultOutDir);
  merged = normalizedWorkerControlConfig(merged).config;
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

  const launcherConfig = await minecraftLauncherRuntimeConfig(config);
  let minecraftProfile = await ensureMinecraftLauncherProfile({ config: launcherConfig, latest, installed });
  const minecraftAssets = await ensureMinecraftLauncherAssets({
    config: launcherConfig,
    latest,
    installed,
    profile: minecraftProfile
  });
  minecraftProfile = await installMinecraftProfileLoaders(minecraftProfile, {
    config: launcherConfig,
    latest,
    installed
  });
  return { profileUpdated: true, minecraftProfile, minecraftAssets };
}

async function saveSettings(configPatch, packValue = 'stable') {
  const target = releaseTarget(packValue);
  let baseConfig = null;
  if (target.id === 'stable') {
    baseConfig = await saveConfig(configPatch);
  } else {
    const current = await loadConfig();
    const {
      packId: _packId,
      instanceDir,
      latestUrl,
      packs: _packs,
      minecraftLauncher = {},
      playCommand = {},
      ...sharedPatch
    } = configPatch || {};
    const {
      profileId: _profileId,
      profileName: _profileName,
      ...sharedMinecraftLauncher
    } = minecraftLauncher;
    const { cwd: _cwd, ...sharedPlayCommand } = playCommand;
    const currentPack = current.packs?.[target.id] || {};
    const nextPack = {
      ...currentPack,
      packId: target.packId,
      name: target.name
    };
    if (String(instanceDir || '').trim()) nextPack.instanceDir = String(instanceDir).trim();
    if (String(latestUrl || '').trim()) nextPack.latestUrl = String(latestUrl).trim();
    baseConfig = await saveConfig({
      ...sharedPatch,
      minecraftLauncher: sharedMinecraftLauncher,
      playCommand: sharedPlayCommand,
      packs: { ...current.packs, [target.id]: nextPack }
    });
    await ensureDir(nextPack.instanceDir || defaultPtbInstanceDir());
  }
  const config = configForPack(baseConfig, target.id);
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
  const detectedMinecraftRoot = await firstExistingCurseForgeMinecraftRoot(current)
    || await firstExistingMinecraftLauncherRoot(localMinecraftLauncherCandidates());
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

function clearRemoteAdminToken(expectedBaseUrl = '', expectedToken = '') {
  if (expectedBaseUrl && adminTokenBaseUrl !== expectedBaseUrl) return;
  if (expectedToken && adminToken !== expectedToken) return;
  adminToken = '';
  adminTokenExpiresAt = 0;
  adminTokenBaseUrl = '';
}

async function launcherProofAuthToken(config = {}) {
  if (!developerAdminSessionAllowed()) return '';
  const adminBase = workerServiceBaseUrl(config.developer?.adminBaseUrl || config.sync?.baseUrl);
  const proofBase = workerServiceBaseUrl(config.launcherProof?.baseUrl || config.sync?.baseUrl || config.developer?.adminBaseUrl);
  if (adminBase && proofBase && adminBase !== proofBase) {
    throw new Error('Developer launcher proof URL must use the same Worker origin and base path as developer admin login.');
  }
  return ensureRemoteAdminToken(config);
}

function isLauncherProofAuthenticationError(error) {
  return /developer launcher proof requires developer authentication|unauthorized|\b401\b|invalid (?:admin )?token/i.test(error?.message || String(error || ''));
}

async function writeLauncherProofWithDeveloperAuth({ config = {}, ...options } = {}) {
  const developerAuthRequired = developerAdminSessionAllowed();
  const writeWithCurrentToken = async () => writeLauncherProof({
    config,
    ...options,
    authToken: developerAuthRequired ? await launcherProofAuthToken(config) : ''
  });
  const requireTrustedDeveloperProof = (proof) => {
    if (developerAuthRequired && (!proof?.trusted || !proof?.token)) {
      throw new Error(proof?.error || 'Developer launcher proof signing did not return a trusted token.');
    }
    return proof;
  };
  try {
    return requireTrustedDeveloperProof(await writeWithCurrentToken());
  } catch (error) {
    if (!developerAuthRequired || !isLauncherProofAuthenticationError(error)) throw error;
    clearRemoteAdminToken(workerServiceBaseUrl(config.developer?.adminBaseUrl || config.sync?.baseUrl));
    return requireTrustedDeveloperProof(await writeWithCurrentToken());
  }
}

function runtimeIdentity(identity = {}) {
  return {
    ...identity,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  };
}

function isLauncherProofRegistrationError(error) {
  return /not registered to this launcher install/i.test(error?.message || String(error || ''));
}

function isUsernameUnavailableError(error) {
  return /username is not available|That username is not available/i.test(error?.message || String(error || ''));
}

async function clearUnavailableMinecraftUsername(username = '', message = 'That username is not available.') {
  const normalizedUsername = normalizeMinecraftUsername(username);
  if (!normalizedUsername) {
    return;
  }
  const current = await loadIdentity();
  if (normalizeMinecraftUsername(current.minecraftUsername).toLowerCase() !== normalizedUsername.toLowerCase()) {
    return;
  }
  await writeJsonFile(identityPath(), {
    ...current,
    minecraftUsername: '',
    usernameRegistrationMode: '',
    minecraftUsernameUnavailable: normalizedUsername,
    minecraftUsernameSyncWarning: message
  });
}

async function writeRegisteredLauncherProof({ config = {}, identity = {}, latest = null, installed = null } = {}) {
  const proofIdentity = launcherProofIdentity(runtimeIdentity(identity));
  try {
    return await writeLauncherProofWithDeveloperAuth({
      config,
      identity: proofIdentity,
      latest,
      installed
    });
  } catch (error) {
    if (!isLauncherProofRegistrationError(error)) {
      throw error;
    }
    if (developerAdminSessionAllowed()) {
      throw new Error('Authenticated developer launcher proof was rejected by the Worker registration gate. Player identity was not changed; update the Worker before retrying developer Play.');
    }
    const username = normalizeMinecraftUsername(identity.minecraftUsername || config.sync?.playerLabel || '');
    if (!username) {
      throw error;
    }
    try {
      await registerMinecraftUsername(username, {
        mode: identity.usernameRegistrationMode || 'proof-refresh',
        minecraftUuid: identity.minecraftUuid || identity.minecraftUUID || '',
        skipLauncherAuthSync: true
      });
    } catch (refreshError) {
      if (isUsernameUnavailableError(refreshError)) {
        await clearUnavailableMinecraftUsername(username, refreshError.message || String(refreshError));
        throw new Error('That username is not available. Enter an available Minecraft username to continue.');
      }
      throw new Error(`Launcher proof registration refresh failed: ${refreshError.message || refreshError}`);
    }
    const refreshedIdentity = runtimeIdentity(await loadIdentity());
    return writeLauncherProofWithDeveloperAuth({
      config,
      identity: launcherProofIdentity(refreshedIdentity),
      latest,
      installed
    });
  }
}

async function writeSerializedRegisteredLauncherProof({
  config = {},
  identity = {},
  latest = null,
  installed = null,
  minValidityMs = 2 * 60 * 1000
} = {}) {
  const expectedIdentity = launcherProofIdentity(runtimeIdentity(identity));
  const inspectExpectedProof = () => inspectLauncherProof({
    config,
    identity: expectedIdentity,
    latest,
    installed,
    minValidityMs
  });
  const resolvedProofFile = path.resolve(launcherProofPath(config.instanceDir || '', expectedIdentity));
  const key = process.platform === 'win32' ? resolvedProofFile.toLowerCase() : resolvedProofFile;
  const previous = launcherProofRefreshes.get(key);
  const refresh = (async () => {
    if (previous) await previous.catch(() => {});
    return writeRegisteredLauncherProof({ config, identity, latest, installed });
  })().finally(() => {
    if (launcherProofRefreshes.get(key) === refresh) launcherProofRefreshes.delete(key);
  });
  launcherProofRefreshes.set(key, refresh);
  const result = await refresh;
  const verified = await inspectExpectedProof();
  if (!verified.usable) {
    throw new Error(`Launcher proof changed before it could be used: ${verified.reason || 'proof no longer matches this launch'}.`);
  }
  return { ...result, ...verified, reused: false };
}

async function socialRequestContext() {
  const config = await loadConfig();
  const identity = await identityPayload(config);
  let latest = null;
  let installed = null;
  try {
    latest = await readLatest(config);
  } catch {}
  try {
    installed = await readInstalledPack(config);
  } catch {}
  const proof = await writeSerializedRegisteredLauncherProof({ config, identity, latest, installed });
  if (!proof?.trusted || !proof?.token) {
    throw new Error('A valid AHT Launcher session is required before friends can load.');
  }
  return { config, identity, latest, installed, proofToken: proof.token };
}

async function launcherLegalStatus() {
  const testBypass = process.env.AHT_TEST_HOOKS === '1' && process.env.AHT_TEST_REQUIRE_LEGAL !== '1';
  return legalConsentStatus({
    appRoot,
    consentPath: legalConsentPath(),
    identity: await loadIdentity(),
    developerMode: isDeveloperMode() || testBypass
  });
}

async function acceptLauncherLegal(payload = {}) {
  const record = await recordLegalConsent({
    appRoot,
    consentPath: legalConsentPath(),
    termsVersion: payload.termsVersion,
    privacyVersion: payload.privacyVersion,
    affirmed: payload.affirmed === true,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    identity: await loadIdentity()
  });
  return { ok: true, acceptedAt: record.acceptedAt };
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
    const detectedUsername = normalizeMinecraftUsername(auth.preferredUsername);
    const detectedMinecraftUuid = normalizeMinecraftUuid(auth.preferredMinecraftUuid);
    const currentUsername = normalizeMinecraftUsername(nextIdentity.minecraftUsername);
    const currentMinecraftUuid = normalizeMinecraftUuid(nextIdentity.minecraftUuid || nextIdentity.minecraftUUID);
    const sameUsername = Boolean(detectedUsername && currentUsername.toLowerCase() === detectedUsername.toLowerCase());
    const uuidConflict = Boolean(sameUsername && detectedMinecraftUuid && currentMinecraftUuid && detectedMinecraftUuid !== currentMinecraftUuid);
    if (uuidConflict) {
      nextIdentity = {
        ...nextIdentity,
        minecraftLauncherDetectedUsername: detectedUsername,
        minecraftUsernameSyncWarning: 'Minecraft account UUID does not match the saved launcher identity.'
      };
      await writeJsonFile(identityPath(), nextIdentity);
    } else if (detectedUsername && (!sameUsername || (detectedMinecraftUuid && !currentMinecraftUuid))) {
      try {
        const registered = await registerMinecraftUsername(detectedUsername, {
          mode: sameUsername ? 'minecraft-launcher-uuid' : 'minecraft-launcher',
          minecraftUuid: detectedMinecraftUuid,
          skipLauncherAuthSync: true
        });
        nextIdentity = await loadIdentity();
        nextIdentity.minecraftUsernameSyncWarning = '';
        nextIdentity.minecraftLauncherDetectedUsername = registered.username || detectedUsername;
      } catch (error) {
        nextIdentity = {
          ...nextIdentity,
          minecraftLauncherDetectedUsername: detectedUsername,
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

function normalizeMinecraftUuid(value = '') {
  const compact = String(value || '').trim().replace(/[{}-]/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact) || /^0{32}$/.test(compact)) return '';
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20)
  ].join('-');
}

function assertMinecraftUsername(username) {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw new Error('Enter a valid Minecraft username.');
  }
}

function accountBaseUrl(config) {
  return config.sync?.baseUrl || config.developer?.adminBaseUrl || '';
}

function accountRecoveryCredentialPath(config = {}, username = '') {
  const normalizedUsername = normalizeMinecraftUsername(username).toLowerCase();
  if (!/^[a-z0-9_]{3,16}$/.test(normalizedUsername)) {
    throw new Error('A valid Minecraft username is required for launcher recovery.');
  }
  return path.join(config.instanceDir || defaultInstanceDir(), '.aht-launcher', 'account-recovery', `${normalizedUsername}.json`);
}

async function accountRecoverySecret(config = {}, username = '') {
  const file = accountRecoveryCredentialPath(config, username);
  const existing = await readJsonFile(file).catch(() => null);
  const existingSecret = String(existing?.secret || '').trim();
  if (
    Number(existing?.schemaVersion) === 1
    && normalizeMinecraftUsername(existing?.username).toLowerCase() === normalizeMinecraftUsername(username).toLowerCase()
    && /^[A-Za-z0-9_-]{32,200}$/.test(existingSecret)
  ) {
    return existingSecret;
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  await writeJsonFile(file, {
    schemaVersion: 1,
    username: normalizeMinecraftUsername(username),
    secret,
    createdAt: new Date().toISOString()
  });
  return secret;
}

function minecraftUsernameMatchesAuth(auth = {}, username = '') {
  const target = normalizeMinecraftUsername(username).toLowerCase();
  if (!target) return false;
  return (auth.usernames || []).some((item) => normalizeMinecraftUsername(item).toLowerCase() === target)
    || normalizeMinecraftUsername(auth.preferredUsername).toLowerCase() === target;
}

async function inspectConfiguredMinecraftLauncherAuth(config = {}) {
  const rootDir = config.minecraftLauncher?.rootDir || defaultMinecraftRoot();
  if (!rootDir) {
    return { signedIn: false, accountCount: 0, files: [], usernames: [], preferredUsername: '' };
  }
  return inspectMinecraftLauncherAuth(rootDir, {
    extraRoots: minecraftRootCandidates(process.platform, {
      ...process.env,
      HOME: process.env.HOME || app.getPath('home'),
      USERPROFILE: process.env.USERPROFILE || app.getPath('home')
    }).filter((root) => !samePath(root, rootDir))
  });
}

async function canRecoverMinecraftUsernameFromLauncher(username, config = {}, options = {}) {
  if (options.allowMinecraftLauncherRecovery === false) return false;
  if (config.minecraftLauncher?.autoImportAccount === false && options.mode !== 'minecraft-launcher') return false;
  const auth = await inspectConfiguredMinecraftLauncherAuth(config);
  return minecraftUsernameMatchesAuth(auth, username);
}

async function registerMinecraftUsername(username, options = {}) {
  const normalizedUsername = normalizeMinecraftUsername(username);
  assertMinecraftUsername(normalizedUsername);
  const config = await loadConfig();
  const identity = await loadIdentity();
  const suppliedMinecraftUuidText = String(options.minecraftUuid || '').trim();
  const suppliedMinecraftUuid = normalizeMinecraftUuid(suppliedMinecraftUuidText);
  if (suppliedMinecraftUuidText && !suppliedMinecraftUuid) {
    throw new Error('Minecraft UUID is invalid.');
  }
  const sameSavedUsername = normalizeMinecraftUsername(identity.minecraftUsername).toLowerCase() === normalizedUsername.toLowerCase();
  const savedMinecraftUuid = sameSavedUsername
    ? normalizeMinecraftUuid(identity.minecraftUuid || identity.minecraftUUID)
    : '';
  if (savedMinecraftUuid && suppliedMinecraftUuid && savedMinecraftUuid !== suppliedMinecraftUuid) {
    throw new Error('Minecraft account UUID does not match the saved launcher identity.');
  }
  const minecraftUuid = suppliedMinecraftUuid || savedMinecraftUuid;
  const base = accountBaseUrl(config);
  const developerLocalOnly = isDeveloperMode();
  let remote = {
    skipped: true,
    reason: developerLocalOnly
      ? 'developer launcher identity stays local and uses authenticated developer proof'
      : 'sync URL is not configured'
  };

  if (base && !developerLocalOnly) {
    const url = new URL('api/users/register', base.endsWith('/') ? base : `${base}/`);
    const recoverySecret = await accountRecoverySecret(config, normalizedUsername);
    const registrationPayload = {
      username: normalizedUsername,
      minecraftUuid,
      accountRecoverySecret: recoverySecret,
      installId: identity.installId,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      packId: config.packId
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationPayload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body.error || `${response.status} ${response.statusText}`;
      if (!isUsernameUnavailableError(message) || !(await canRecoverMinecraftUsernameFromLauncher(normalizedUsername, config, options))) {
        throw new Error(message);
      }
      const recoveryResponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...registrationPayload,
          recoverExistingUsername: true,
          minecraftAccountMatched: true,
          recoveryReason: 'minecraft-launcher-account-match'
        })
      });
      const recoveryBody = await recoveryResponse.json().catch(() => ({}));
      if (!recoveryResponse.ok) {
        throw new Error(recoveryBody.error || message);
      }
      remote = { ...recoveryBody, recovered: true };
    } else {
      remote = body;
    }
  }

  const remoteMinecraftUuidText = String(remote.minecraftUuid || '').trim();
  const remoteMinecraftUuid = normalizeMinecraftUuid(remoteMinecraftUuidText);
  if (remoteMinecraftUuidText && !remoteMinecraftUuid) {
    throw new Error('The player service returned an invalid Minecraft UUID.');
  }
  if (remoteMinecraftUuid && minecraftUuid && remoteMinecraftUuid !== minecraftUuid) {
    throw new Error('Minecraft UUID does not match this registered player.');
  }
  const nextIdentity = {
    ...identity,
    minecraftUsername: remote.username || normalizedUsername,
    minecraftUuid: remoteMinecraftUuid || minecraftUuid,
    usernameRegisteredAt: identity.usernameRegisteredAt || new Date().toISOString(),
    usernameRegistrationMode: options.mode || (remote.recovered ? 'minecraft-launcher-recovery' : (remote.skipped ? 'local' : 'worker')),
    minecraftLauncherDetectedUsername: (String(options.mode || '').startsWith('minecraft-launcher') || remote.recovered) ? normalizedUsername : identity.minecraftLauncherDetectedUsername || '',
    minecraftUsernameUnavailable: '',
    minecraftUsernameSyncWarning: ''
  };
  await writeJsonFile(identityPath(), nextIdentity);
  return {
    ok: true,
    username: nextIdentity.minecraftUsername,
    minecraftUuid: nextIdentity.minecraftUuid || '',
    remote
  };
}

function launcherVersionWasReported(identity = {}, version = '') {
  const reportedVersions = Array.isArray(identity.reportedLauncherVersions)
    ? identity.reportedLauncherVersions.map((item) => String(item || '').trim())
    : [];
  return reportedVersions.includes(String(version || '').trim());
}

async function reportCurrentLauncherVersion(config = {}, identity = {}) {
  if (isDeveloperMode()) return { skipped: true, reason: 'developer launcher' };
  const version = String(app.getVersion() || '').trim();
  const installId = String(identity.installId || '').trim();
  const minecraftUsername = normalizeMinecraftUsername(identity.minecraftUsername);
  if (!version || !installId || !minecraftUsername || launcherVersionWasReported(identity, version)) {
    return { skipped: true, reason: 'launcher version already reported or player identity is incomplete' };
  }
  const previousVersion = String(identity.lastReportedLauncherVersion || '').trim();
  const result = await sendLauncherEvent(config, runtimeIdentity(identity), {
    type: 'launcher_update_completed',
    version,
    toVersion: version,
    fromVersion: previousVersion
  });
  if (!result?.launcherUpdateKey) {
    return { skipped: true, reason: 'player data service does not support launcher update records yet' };
  }

  const current = await loadIdentity();
  if (
    String(current.installId || '').trim() !== installId
    || normalizeMinecraftUsername(current.minecraftUsername).toLowerCase() !== minecraftUsername.toLowerCase()
  ) {
    return { skipped: true, reason: 'player identity changed before launcher update confirmation' };
  }
  const reportedLauncherVersions = [...new Set([
    ...(Array.isArray(current.reportedLauncherVersions) ? current.reportedLauncherVersions : []),
    version
  ].map((item) => String(item || '').trim()).filter(Boolean))].slice(-20);
  await writeJsonFile(identityPath(), {
    ...current,
    reportedLauncherVersions,
    lastReportedLauncherVersion: version,
    launcherVersionReportedAt: new Date().toISOString()
  });
  return { ok: true, version, launcherUpdateKey: result.launcherUpdateKey };
}

function queueCurrentLauncherVersionReport(config = {}, identity = {}) {
  if (isDeveloperMode()) return null;
  const version = String(app.getVersion() || '').trim();
  const installId = String(identity.installId || '').trim();
  const minecraftUsername = normalizeMinecraftUsername(identity.minecraftUsername).toLowerCase();
  if (!version || !installId || !minecraftUsername || launcherVersionWasReported(identity, version)) return null;
  const key = `${installId}\0${minecraftUsername}\0${version}`;
  if (launcherVersionTelemetryInFlight.has(key)) return launcherVersionTelemetryInFlight.get(key);
  const report = reportCurrentLauncherVersion(config, identity).catch((error) => {
    console.warn(`Launcher update history could not be recorded: ${error.message || error}`);
    return { ok: false, error: error.message || String(error) };
  }).finally(() => {
    if (launcherVersionTelemetryInFlight.get(key) === report) {
      launcherVersionTelemetryInFlight.delete(key);
    }
  });
  launcherVersionTelemetryInFlight.set(key, report);
  return report;
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
  const safeReleaseIdentifier = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value || '').trim());
  if (latest.minecraft?.version && !safeReleaseIdentifier(latest.minecraft.version)) {
    throw new Error(`Release feed has an unsafe Minecraft version identifier: ${source}.`);
  }
  for (const loader of Array.isArray(latest.minecraft?.modLoaders) ? latest.minecraft.modLoaders : []) {
    if (!safeReleaseIdentifier(loader?.id)) {
      throw new Error(`Release feed has an unsafe mod-loader identifier: ${source}.`);
    }
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

function latestReleaseCacheKey(config = {}) {
  return `${String(config.packId || '').trim()}|${String(config.latestUrl || '').trim()}`;
}

function cachedLatestRelease(config = {}, maxAgeMs = LATEST_RELEASE_CACHE_MAX_AGE_MS) {
  const entry = latestReleaseCache.get(latestReleaseCacheKey(config));
  if (!entry || Date.now() - entry.fetchedAt > Math.max(0, Number(maxAgeMs) || 0)) {
    return null;
  }
  return entry.latest;
}

async function readLatest(config, options = {}) {
  if (!config.latestUrl) {
    return null;
  }
  if (options.preferCache) {
    const cached = cachedLatestRelease(config, options.maxAgeMs);
    if (cached) return cached;
  }
  const latest = validateLatestReleaseFeed(await readJsonFromSource(config.latestUrl), config.latestUrl);
  latestReleaseCache.set(latestReleaseCacheKey(config), { latest, fetchedAt: Date.now() });
  return latest;
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

async function scanCurrentManagedIntegrity(config, latest = null, options = {}) {
  const requiredManaged = await expectedCacheExtraManagedFiles(config, latest).catch((error) => {
    console.warn(`Unable to load expected cache extras for integrity scan: ${error.message || error}`);
    return [];
  });
  return scanManagedIntegrity(config.instanceDir, {
    requiredManaged,
    onProgress: typeof options.onProgress === 'function' ? options.onProgress : null
  });
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

async function scanPlayIntegrity(config, latest = null) {
  const requiredManaged = await expectedCacheExtraManagedFiles(config, latest).catch((error) => {
    console.warn(`Unable to load expected cache extras for Play integrity check: ${error.message || error}`);
    return [];
  });
  const [stored, fingerprint] = await Promise.all([
    readIntegrityState(config),
    captureManagedModFingerprint(config.instanceDir, { requiredManaged })
  ]);
  const checkedAt = new Date().toISOString();

  if (
    stored?.valid
    && fingerprint.pathsValid
    && stored.fingerprint?.schemaVersion === fingerprint.schemaVersion
    && stored.fingerprint?.digest === fingerprint.digest
  ) {
    return writeIntegrityState(config, {
      ...stored,
      fingerprint,
      quickCheckedAt: checkedAt,
      checkMode: 'fingerprint'
    }, 'play-fast-check');
  }

  const verifiedAtMs = Date.parse(String(stored?.generatedAt || ''));
  const canAdoptLegacyBaseline = stored?.valid
    && !stored?.fingerprint?.digest
    && fingerprint.pathsValid
    && Number(stored?.counts?.corrupted || 0) === 0
    && Number(stored?.counts?.managed || 0) === fingerprint.managedCount
    && Number.isFinite(verifiedAtMs)
    && fingerprint.latestChangeMs <= verifiedAtMs;
  if (canAdoptLegacyBaseline) {
    return writeIntegrityState(config, {
      ...stored,
      fingerprint,
      quickCheckedAt: checkedAt,
      checkMode: 'fingerprint-baseline'
    }, 'play-fast-baseline');
  }

  const integrity = await scanManagedIntegrity(config.instanceDir, { requiredManaged });
  return writeIntegrityState(config, {
    ...integrity,
    checkMode: 'full-hash'
  }, 'play-check');
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
  const targets = minecraftProfileInstallTargets(profile).filter((item) => (
    item.versionId && item.loaderId?.startsWith('forge-')
  ));
  if (!targets.length) return profile;
  const total = targets.length;
  let selectedJavaPath = String(config.minecraftLauncher?.javaPath || '').trim();
  let forceManagedJava8 = config.minecraftLauncher?.java8InstallOverride === true;
  const allowManagedJavaDownload = config.minecraftLauncher?.java8InstallOverride !== false;
  for (const [index, target] of targets.entries()) {
    const installing = !target.loaderInstalled;
    if (operationState) {
      operationState.progress = {
        phase: `${installing ? 'Installing' : 'Validating'} Forge (${index + 1}/${total})`,
        completed: index,
        total,
        percent: 97
      };
      appendOperationLine(operationState, `${installing ? 'Installing' : 'Validating'} Forge ${target.versionId} for Minecraft Launcher root ${target.rootDir}...`);
    }
    const forgeLines = [];
    const result = await installForgeLoader(target, {
      javaPath: selectedJavaPath || target.javaPath || 'java',
      forceManagedJava8,
      allowManagedJavaDownload,
      installerUrl: target.loaderInstallerUrl || latest?.minecraft?.forgeInstallerUrl || latest?.minecraft?.loaderInstallerUrl || '',
      verifyLibraries: true,
      logger: { log: (line) => forgeLines.push(String(line)) }
    });
    selectedJavaPath = await minecraftJavaExecutable(result.plan?.javaPath) || selectedJavaPath;
    forceManagedJava8 = false;
    if (operationState) {
      appendOperationLines(operationState, forgeLines);
      appendOperationLine(operationState, `Forge ${target.versionId} is ready in ${target.rootDir}.`);
    }
  }
  const javaRuntime = await preflightJava8Runtime(
    selectedJavaPath,
    config.minecraftLauncher?.memoryMb || DEFAULT_MINECRAFT_MEMORY_MB
  );
  if (operationState) {
    appendOperationLine(
      operationState,
      `Java preflight passed: ${javaRuntime.vendor || 'Java'} ${javaRuntime.version || '8'} ${javaRuntime.arch || '64-bit'}, ${javaRuntime.heapMb} MB heap.`
    );
  }
  await saveConfig({
    minecraftLauncher: {
      javaPath: selectedJavaPath,
      java8InstallOverride: null
    }
  });
  clearJavaRuntimeDetectionCache();
  const profileConfig = selectedJavaPath
    ? {
      ...config,
      minecraftLauncher: {
        ...(config.minecraftLauncher || {}),
        javaPath: selectedJavaPath
      }
    }
    : config;
  const refreshed = await ensureMinecraftLauncherProfile({ config: profileConfig, latest, installed });
  const stillMissing = missingForgeLoaderProfiles(refreshed);
  if (stillMissing.length) {
    throw new Error(`Forge ${stillMissing[0].versionId} did not appear in all Minecraft Launcher roots: ${minecraftRootSummary(stillMissing)}`);
  }
  return {
    ...refreshed,
    javaRuntime
  };
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

  const java8Runtime = options.java8Runtime || null;
  if (java8Runtime && !java8Runtime.usable && !java8Runtime.installSupported) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: java8Runtime.reason || 'A usable 64-bit Java 8 runtime was not found on this platform.'
    };
  }
  if (java8Runtime && !java8Runtime.usable && !java8Runtime.installSelected) {
    return {
      playConfigured,
      launchReady: false,
      launchMode: 'minecraftLauncher',
      launchBlockedReason: 'A usable 64-bit Java 8 runtime was not found. Rerun the AHT installer with Adoptium Java 8 selected, then run Update.'
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

async function testReleaseFeed(configPatch = null, packValue = 'stable') {
  const target = releaseTarget(packValue);
  const current = configForPack(await loadConfig(), target.id);
  const config = configPatch ? mergeConfig(current, configPatch) : current;
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

function managedJavaPath(javaPath = '') {
  return String(javaPath || '').replace(/\\/g, '/').toLowerCase().includes('/.aht-launcher/java/');
}

function java8InstallSupported() {
  return process.platform === 'win32' && process.arch === 'x64';
}

async function java8RuntimeStatus(config = {}, options = {}) {
  const minecraft = config.minecraftLauncher || {};
  const detected = await detectJava8Runtime({ rootDir: minecraft.rootDir || '' }, {
    javaPath: minecraft.javaPath || '',
    refresh: Boolean(options.refresh)
  });
  const override = typeof minecraft.java8InstallOverride === 'boolean'
    ? minecraft.java8InstallOverride
    : null;
  const installSupported = java8InstallSupported();
  const recommendedInstall = !detected.usable && installSupported;
  const installSelected = override === null ? recommendedInstall : override;
  const totalMemoryMb = Math.floor(os.totalmem() / 1024 / 1024);
  const freeMemoryMb = Math.floor(os.freemem() / 1024 / 1024);
  const configuredMemoryMb = Math.max(0, Math.floor(Number(minecraft.memoryMb) || 0));
  const memoryWarning = configuredMemoryMb && totalMemoryMb && configuredMemoryMb > Math.floor(totalMemoryMb * 0.75)
    ? `Allocated RAM is ${configuredMemoryMb} MB on a ${totalMemoryMb} MB system. Leave memory for Windows and Minecraft Launcher.`
    : '';
  return {
    usable: Boolean(detected.usable),
    path: detected.usable ? detected.javaPath : '',
    version: detected.version || '',
    vendor: detected.vendor || '',
    arch: detected.arch || '',
    is64Bit: Boolean(detected.is64Bit),
    managed: Boolean(detected.managed || managedJavaPath(detected.javaPath)),
    reason: detected.reason || '',
    rejectedReason: detected.rejected?.[0]?.reason || '',
    installSupported,
    recommendedInstall,
    installSelected,
    installOverride: override,
    totalMemoryMb,
    freeMemoryMb,
    configuredMemoryMb,
    memoryWarning
  };
}

function minecraftProfileForRenderer(profile = null) {
  if (!profile) {
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
  return {
    trusted: Boolean(proof.trusted),
    source: proof.source || ''
  };
}

function minecraftLaunchResultForRenderer(result = {}) {
  return {
    ok: Boolean(result.ok),
    command: String(result.command || ''),
    args: Array.isArray(result.args) ? result.args.map((arg) => String(arg)) : [],
    kind: String(result.kind || ''),
    activationMode: String(result.activationMode || ''),
    activationConfirmed: Boolean(result.activationConfirmed)
  };
}

function minecraftLauncherHandoffForRenderer(handoff = {}) {
  return {
    restartedExisting: Boolean(handoff.detected && handoff.closed),
    profileReloadPrepared: Boolean(handoff.closed || !handoff.detected)
  };
}

async function getStatus(configOverride = null, packValue = 'stable') {
  const target = releaseTarget(packValue);
  const baseConfig = configOverride || await loadConfig();
  const config = configForPack(baseConfig, target.id);
  const launcherConfig = await minecraftLauncherRuntimeConfig(config);
  const identity = await identityPayload(launcherConfig);
  queueCurrentLauncherVersionReport(config, identity);
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
  let installed = null;
  if (await pathExists(installedPath)) {
    try {
      installed = await readJsonFile(installedPath);
    } catch (error) {
      latestError ||= `Installed manifest is damaged. Click Update to reinstall A Hard Time. ${error.message || error}`;
    }
  }
  const developerClientBypass = developerClientBypassAllowed();
  let integrity = developerClientBypass ? developerBypassIntegrityState(config) : await readIntegrityState(config);
  if (!developerClientBypass) {
    integrity = await refreshStaleIntegrityState(config, latest, integrity);
  }
  const launchLatest = latest || (developerClientBypass && installed ? installed : null);
  const launchLatestError = developerClientBypass && installed ? null : latestError;
  const [minecraftProfile, java8Runtime] = await Promise.all([
    inspectMinecraftLauncherProfile({ config: launcherConfig, latest: launchLatest, installed }),
    java8RuntimeStatus(launcherConfig)
  ]);
  const launchIntegrity = developerClientBypass ? null : integrity;
  const updateBlockedReason = !developerClientBypass ? playerUpdateBlockedReason(latest) : '';
  const updateRequired = !updateBlockedReason && latest && latest.required !== false
    ? installed?.version !== latest.version
    : false;
  const launchState = evaluateLaunchState(launcherConfig, launchLatest, launchLatestError, installed, minecraftProfile, launchIntegrity, {
    skipLoaderCheck: true,
    allowLegacyRelease: developerClientBypass,
    java8Runtime
  });
  const pendingLauncherUpdate = await hydratePendingLauncherUpdateState();
  let launcherUpdate = await readLauncherUpdate(config);
  if (pendingLauncherUpdate?.version && compareVersions(pendingLauncherUpdate.version, app.getVersion()) > 0) {
    launcherUpdate = {
      ...launcherUpdate,
      latestVersion: pendingLauncherUpdate.version,
      required: true,
      updateRequired: true,
      artifact: pendingLauncherUpdate.artifact || launcherUpdate.artifact,
      pendingStatus: pendingLauncherUpdate.status || 'staged',
      error: ''
    };
  }
  return {
    activePack: target.sidebarKey,
    releaseTarget: target.id,
    releaseName: target.name,
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
    java8Runtime,
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
    appendOperationLine(updateState, `${forceRepair ? 'Repair' : 'Update'} request ignored because an install is already running.`);
    return updateState;
  }
  const target = releaseTarget(options.packKey || 'stable');
  updateState = {
    ...createOperationState(forceRepair ? 'repair' : 'install', forceRepair ? 'Preparing repair' : 'Preparing update'),
    releaseTarget: target.id,
    packKey: target.sidebarKey
  };
  let config = null;
  let launcherConfig = null;
  let identity = null;
  try {
    config = configForPack(await loadConfig(), target.id);
    launcherConfig = await minecraftLauncherRuntimeConfig(config);
    identity = await identityPayload(launcherConfig);
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
    }).catch((error) => appendOperationLine(updateState, `Sync warning: ${error.message}`));
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
      logger: { log: (line) => appendOperationLine(updateState, line) }
    });
    let latestAfterInstall = null;
    if (config.minecraftLauncher?.enabled !== false) {
      try {
        latestAfterInstall = await readLatest(config);
        const launcherProof = await writeSerializedRegisteredLauncherProof({
          config: launcherConfig,
          latest: latestAfterInstall,
          installed: result.installed,
          identity
        });
        result.launcherProof = {
          proofFile: launcherProof.proofFile || '',
          trusted: Boolean(launcherProof.trusted),
          source: launcherProof.source || ''
        };
        let profile = await ensureMinecraftLauncherProfile({
          config: launcherConfig,
          latest: latestAfterInstall,
          installed: result.installed
        });
        const assetLines = [];
        updateState.progress = { phase: 'Repairing Minecraft 1.12.2 runtime', completed: 0, total: 1, percent: 96 };
        result.minecraftAssets = await ensureMinecraftLauncherAssets({
          config: launcherConfig,
          latest: latestAfterInstall,
          installed: result.installed,
          profile,
          logger: { log: (line) => assetLines.push(String(line)) }
        });
        appendOperationLines(updateState, assetLines);
        profile = await installMinecraftProfileLoaders(profile, {
          config: launcherConfig,
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
    const integrity = await scanCurrentManagedIntegrity(config, latestAfterInstall, {
      onProgress: (progress) => {
        updateState.progress = {
          ...progress,
          percent: Math.min(99, weightedOperationPercent(progress.percent, 98, 1))
        };
      }
    });
    await writeIntegrityState(config, integrity, forceRepair ? 'repair' : 'install');
    await sendLauncherEvent(config, identity, {
      type: forceRepair ? 'repair_completed' : 'install_completed',
      version: result.installed?.version || null,
      manifestFileCount: result.installed?.manifestFileCount || 0,
      overrideFileCount: result.installed?.overrideFileCount || 0
    }).catch((error) => appendOperationLine(updateState, `Sync warning: ${error.message}`));
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

function launcherUpdatePendingPath() {
  return path.join(app.getPath('userData'), 'launcher-updates', 'pending-launcher-update.json');
}

function launcherUpdatePendingFailurePath() {
  return path.join(app.getPath('userData'), 'launcher-updates', 'pending-launcher-update.failed');
}

async function readPendingLauncherUpdate() {
  try {
    const pending = await readJsonFile(launcherUpdatePendingPath());
    return pending && typeof pending === 'object' ? pending : null;
  } catch {
    return null;
  }
}

async function writePendingLauncherUpdate(pending = {}) {
  await writeJsonFile(launcherUpdatePendingPath(), {
    schemaVersion: 1,
    product: 'aht-launcher',
    updatedAt: new Date().toISOString(),
    ...pending
  });
  await fs.rm(launcherUpdatePendingFailurePath(), { force: true }).catch(() => {});
}

async function clearPendingLauncherUpdate() {
  await fs.rm(launcherUpdatePendingPath(), { force: true }).catch(() => {});
  await fs.rm(launcherUpdatePendingFailurePath(), { force: true }).catch(() => {});
}

function launcherUpdateResultFromPending(pending = {}) {
  if (!pending?.version || !pending?.preparedRestart) return null;
  return {
    ok: true,
    version: pending.version,
    downloadedPath: pending.downloadedPath || '',
    artifact: pending.artifact || null,
    restartRequired: true,
    pendingStatus: pending.status || 'staged',
    stagedAt: pending.stagedAt || pending.createdAt || '',
    installingStartedAt: pending.installingStartedAt || '',
    preparedRestart: pending.preparedRestart
  };
}

async function hydratePendingLauncherUpdateState() {
  const pending = await readPendingLauncherUpdate();
  if (!pending?.version) return null;
  if (compareVersions(app.getVersion(), pending.version) >= 0) {
    await clearPendingLauncherUpdate();
    if (launcherUpdateState.lastResult?.version === pending.version) {
      launcherUpdateState = { running: false, lines: [], lastResult: null, error: null, progress: null };
    }
    return null;
  }
  const lastResult = launcherUpdateResultFromPending(pending);
  if (!lastResult) return null;
  if (!launcherUpdateState.lastResult || launcherUpdateState.lastResult.version !== pending.version) {
    launcherUpdateState = {
      running: false,
      lines: Array.isArray(pending.lines) && pending.lines.length
        ? pending.lines
        : [
          `Launcher update ${app.getVersion()} -> ${pending.version}`,
          pending.status === 'installing'
            ? 'Launcher update install is already in progress.'
            : 'Launcher update is downloaded and ready to install.'
        ],
      lastResult,
      error: null,
      progress: {
        phase: pending.status === 'installing' ? 'Installing launcher update' : 'Ready to install',
        completed: 3,
        total: 3,
        percent: 100
      }
    };
  }
  return pending;
}

async function shouldExitForPendingLauncherInstall() {
  const pending = await readPendingLauncherUpdate();
  if (pending?.status !== 'installing' || !pending.version) return false;
  if (compareVersions(app.getVersion(), pending.version) >= 0) {
    await clearPendingLauncherUpdate();
    return false;
  }
  const started = Date.parse(pending.installingStartedAt || pending.updatedAt || '');
  const age = Number.isFinite(started) ? Date.now() - started : 0;
  const helperFailure = await fs.readFile(launcherUpdatePendingFailurePath(), 'utf8').catch(() => '');
  if (helperFailure || age > LAUNCHER_UPDATE_INSTALLING_STALE_MS || process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT === '1') {
    const retryLine = helperFailure
      ? `Previous install helper failed: ${helperFailure.trim() || 'unknown error'}`
      : 'Previous install handoff did not finish. The update is ready to retry.';
    await writePendingLauncherUpdate({
      ...pending,
      status: 'staged',
      installingStartedAt: '',
      lines: [
        `Launcher update ${app.getVersion()} -> ${pending.version}`,
        retryLine
      ]
    });
    await hydratePendingLauncherUpdateState();
    return false;
  }
  return true;
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
$pendingFailurePath = [string]$payload.pendingFailurePath
function Write-UpdateLog([string]$message) {
  try {
    $parent = Split-Path -Parent $logPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString('o') + ' ' + $message) -Encoding UTF8
  } catch {}
}
function Write-PendingFailure([string]$message) {
  try {
    if (-not $pendingFailurePath) { return }
    $parent = Split-Path -Parent $pendingFailurePath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Set-Content -LiteralPath $pendingFailurePath -Value $message -Encoding UTF8
  } catch {}
}
try {
  Write-UpdateLog ('Waiting for old launcher PID ' + $payload.oldPid)
  if ($payload.testStartOnly -eq $true -or $env:AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY -eq '1') {
    Write-UpdateLog 'Test mode helper startup confirmed.'
    exit 0
  }
  $target = [string]$payload.targetExe
  if ([int]$payload.oldPid -gt 0) {
    try {
      $old = Get-Process -Id ([int]$payload.oldPid) -ErrorAction SilentlyContinue
      if ($old) { Wait-Process -Id ([int]$payload.oldPid) -Timeout 120 -ErrorAction SilentlyContinue }
    } catch {}
  }
  function Get-BlockingLauncherProcesses {
    $targetPath = [string]$target
    if (-not $targetPath) { return @() }
    $targetName = [System.IO.Path]::GetFileNameWithoutExtension($targetPath)
    $targetFull = ''
    try { $targetFull = [System.IO.Path]::GetFullPath($targetPath).ToLowerInvariant() } catch {}
    $matches = @()
    foreach ($process in Get-Process -Name $targetName -ErrorAction SilentlyContinue) {
      if ($process.Id -eq $PID) { continue }
      $processPath = ''
      try { $processPath = [string]$process.Path } catch {}
      if (-not $processPath) {
        $matches += $process
        continue
      }
      try {
        if ([System.IO.Path]::GetFullPath($processPath).ToLowerInvariant() -eq $targetFull) {
          $matches += $process
        }
      } catch {}
    }
    return $matches
  }
  Write-UpdateLog ('Waiting for launcher processes to close for ' + $target)
  $remaining = @()
  for ($i = 0; $i -lt 240; $i += 1) {
    $remaining = @(Get-BlockingLauncherProcesses)
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($remaining.Count -gt 0) {
    throw ('Timed out waiting for launcher processes to close: ' + (($remaining | ForEach-Object { $_.Id }) -join ', '))
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
  $reason = [string]$_.Exception.Message
  Write-UpdateLog ('Launcher update helper failed: ' + $reason)
  Write-PendingFailure $reason
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
    pendingFailurePath: launcherUpdatePendingFailurePath(),
    testStartOnly: process.env.AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY === '1',
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

function macAppPathLooksTransient(appPath = '') {
  const normalized = String(appPath || '').replaceAll('\\', '/').toLowerCase();
  return normalized.startsWith('/volumes/') || normalized.includes('/apptranslocation/');
}

function defaultMacLauncherAppName(currentApp = '') {
  const name = path.basename(String(currentApp || ''));
  return name && name.toLowerCase().endsWith('.app') ? name : 'A Hard Time Launcher macOS.app';
}

function macLauncherUpdateTargetApp(currentApp = '') {
  const appName = defaultMacLauncherAppName(currentApp);
  const systemApp = path.join('/Applications', appName);
  const userApp = path.join(app.getPath('home'), 'Applications', appName);
  if (!currentApp || macAppPathLooksTransient(currentApp)) {
    return fsSync.existsSync(systemApp) ? systemApp : userApp;
  }
  return currentApp;
}

function macLauncherUpdateHelperScript(payload) {
  return `#!/bin/sh
set -eu
zip_path=${shellSingleQuote(payload.installerPath)}
target_app=${shellSingleQuote(payload.targetApp)}
fallback_app=${shellSingleQuote(payload.fallbackApp)}
old_pid=${Number(payload.oldPid) || 0}
log_path=${shellSingleQuote(payload.logPath)}
  pending_failure_path=${shellSingleQuote(payload.pendingFailurePath)}
  work_dir=${shellSingleQuote(payload.workDir)}
  test_start_only=${payload.testStartOnly ? '1' : '0'}
write_log() {
  parent_dir=$(dirname "$log_path")
  mkdir -p "$parent_dir" 2>/dev/null || true
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$log_path" 2>/dev/null || true
}
fail_update() {
  write_log "Launcher update helper failed: $1"
  if [ -n "$pending_failure_path" ]; then
    mkdir -p "$(dirname "$pending_failure_path")" 2>/dev/null || true
    printf '%s\n' "$1" > "$pending_failure_path" 2>/dev/null || true
  fi
  exit 1
}
write_log "Waiting for old launcher PID $old_pid"
if [ "$test_start_only" = "1" ] || [ "\${AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY:-}" = "1" ]; then
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
case "$target_app" in
  /Volumes/*|*/AppTranslocation/*)
    if [ -n "$fallback_app" ]; then
      write_log "Current launcher path is transient. Installing update to $fallback_app"
      target_app="$fallback_app"
    fi
    ;;
esac
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
install_to_target() {
  parent_dir=$(dirname "$target_app")
  mkdir -p "$parent_dir" || return 11
  backup_app="${target_app}.previous-update"
  rm -rf "$backup_app"
  if [ -d "$target_app" ]; then
    mv "$target_app" "$backup_app" || return 12
  fi
  if /usr/bin/ditto "$source_app" "$target_app"; then
    rm -rf "$backup_app"
    return 0
  fi
  rm -rf "$target_app"
  if [ -d "$backup_app" ]; then mv "$backup_app" "$target_app" || true; fi
  return 13
}
if install_to_target; then
  write_log "Installed update to $target_app"
else
  install_status=$?
  if [ -n "$fallback_app" ] && [ "$target_app" != "$fallback_app" ]; then
    write_log "Primary install target failed with $install_status. Trying fallback $fallback_app"
    target_app="$fallback_app"
    install_to_target || fail_update "Could not install updated app bundle to fallback: $target_app"
    write_log "Installed update to fallback $target_app"
  else
    fail_update "Could not install updated app bundle"
  fi
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
  const currentApp = launcherUpdateInstalledMacAppPath();
  const targetApp = macLauncherUpdateTargetApp(currentApp);
  const fallbackApp = path.join(app.getPath('home'), 'Applications', defaultMacLauncherAppName(currentApp || targetApp));
  if (!launcherUpdateInstalledMacAppPath() && process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT !== '1') {
    throw new Error('Could not resolve installed macOS .app bundle for restart.');
  }
  const payloadPath = path.join(helperDir, 'macos-payload.json');
  const scriptPath = path.join(helperDir, 'apply-launcher-update-macos.sh');
  const logPath = path.join(helperDir, 'macos-handoff.log');
  const payload = {
    installerPath: filePath,
    targetApp,
    fallbackApp,
    expectedVersion: latestVersion || '',
    oldPid: process.pid,
    logPath,
    pendingFailurePath: launcherUpdatePendingFailurePath(),
    workDir: path.join(helperDir, 'macos-extract'),
    testStartOnly: process.env.AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY === '1',
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
    appendOperationLine(launcherUpdateState, 'Launcher update request ignored because an app update is already running.');
    return launcherUpdateState;
  }
  const pending = await hydratePendingLauncherUpdateState();
  if (pending && launcherUpdateState.lastResult?.restartRequired) {
    appendOperationLine(launcherUpdateState, 'Launcher update is already downloaded and ready to install.');
    return launcherUpdateState.lastResult;
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
    await downloadToFile(source, target, {
      onProgress: (progress) => {
        launcherUpdateState.progress = byteOperationProgress('Downloading launcher', fileName, progress, 8, 55);
      }
    });
    launcherUpdateState.progress = { phase: 'Verifying launcher', completed: 1, total: 3, percent: 70 };
    if (update.artifact.sha256) {
      const actual = await hashFile(target, 'sha256', {
        onProgress: (progress) => {
          launcherUpdateState.progress = byteOperationProgress('Verifying launcher', fileName, progress, 63, 17);
        }
      });
      if (actual.toLowerCase() !== String(update.artifact.sha256).toLowerCase()) {
        throw new Error(`Launcher update hash mismatch: expected ${update.artifact.sha256}, got ${actual}`);
      }
    }
    appendOperationLine(launcherUpdateState, 'Launcher update downloaded and verified.');
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
    await writePendingLauncherUpdate({
      status: 'staged',
      version: update.latestVersion,
      downloadedPath: target,
      artifact: update.artifact,
      preparedRestart,
      stagedAt: new Date().toISOString(),
      lines: [
        `Launcher update ${app.getVersion()} -> ${update.latestVersion}`,
        'Launcher update downloaded and verified.',
        'Ready to install. Click Install and Restart to close AHT Launcher, install the update, and reopen it.'
      ]
    });
    launcherUpdateState.lastResult = result;
    launcherUpdateState.progress = { phase: 'Ready to install', completed: 3, total: 3, percent: 100 };
    appendOperationLine(launcherUpdateState, 'Ready to install.');
    appendOperationLine(launcherUpdateState, 'Click Install and Restart to close AHT Launcher, install the update, and reopen it.');
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
    appendOperationLine(launcherUpdateState, 'Restart request ignored because a launcher update is already running.');
    return launcherUpdateState;
  }
  const staged = launcherUpdateState.lastResult;
  if (!staged?.restartRequired || !staged?.preparedRestart) {
    throw new Error('Launcher update is not ready to restart yet.');
  }
  launcherUpdateState.running = true;
  launcherUpdateState.error = null;
  launcherUpdateState.progress = { phase: 'Starting install helper', completed: 3, total: 3, percent: 100 };
  appendOperationLine(launcherUpdateState, 'Install and restart requested. Starting launcher update helper.');
  try {
    await writePendingLauncherUpdate({
      status: 'installing',
      version: staged.version,
      downloadedPath: staged.downloadedPath,
      artifact: staged.artifact,
      preparedRestart: staged.preparedRestart,
      stagedAt: staged.stagedAt || '',
      installingStartedAt: new Date().toISOString(),
      lines: [
        `Launcher update ${app.getVersion()} -> ${staged.version}`,
        'Installing launcher update. If this copy opens before installation finishes, it will close so the helper can complete.'
      ]
    });
    const launched = await launchPreparedLauncherUpdate(staged.preparedRestart);
    const result = {
      ...staged,
      restartRequired: false,
      pendingStatus: 'installing',
      restartStartedAt: new Date().toISOString(),
      launched
    };
    launcherUpdateState.lastResult = result;
    launcherUpdateState.progress = { phase: process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT === '1' ? 'Restart verified' : 'Installing launcher update', completed: 3, total: 3, percent: 100 };
    appendOperationLine(launcherUpdateState, process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT === '1'
      ? 'Test mode verified the restart helper without closing the launcher.'
      : 'Install helper is running. Closing AHT Launcher so the update can install and reopen.');
    if (process.env.AHT_TEST_LAUNCHER_UPDATE_NO_QUIT !== '1') {
      setTimeout(() => app.quit(), 250);
    } else {
      launcherUpdateState.running = false;
    }
    return result;
  } catch (error) {
    await writePendingLauncherUpdate({
      status: 'staged',
      version: staged.version,
      downloadedPath: staged.downloadedPath,
      artifact: staged.artifact,
      preparedRestart: staged.preparedRestart,
      stagedAt: staged.stagedAt || new Date().toISOString(),
      installingStartedAt: '',
      lines: [
        `Launcher update ${app.getVersion()} -> ${staged.version}`,
        `Install helper failed to start: ${error.message || String(error)}`,
        'The update is still downloaded and can be retried.'
      ]
    }).catch(() => {});
    launcherUpdateState.error = error.message || String(error);
    launcherUpdateState.progress = { ...(launcherUpdateState.progress || {}), phase: 'Restart failed', percent: 100 };
    launcherUpdateState.running = false;
    throw error;
  }
}

function serverTransferPrivateKeyPath(configuredPath = '') {
  const home = process.env.USERPROFILE || process.env.HOME || app.getPath('home');
  const sshDir = path.join(home, '.ssh');
  const candidates = [
    configuredPath,
    process.env.AHT_SERVER_TRANSFER_PRIVATE_KEY || '',
    path.join(sshDir, 'aht_ubuntu_deploy'),
    path.join(sshDir, 'aht_mc_node_1_ed25519'),
    path.join(sshDir, 'id_ed25519'),
    path.join(sshDir, 'id_rsa')
  ];
  return candidates
    .map((candidate) => String(candidate || '').trim())
    .find((candidate) => candidate && fsSync.existsSync(candidate)) || '';
}

function serverTransferFolderName(sourceDir = '') {
  const normalized = String(sourceDir || '').trim().replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || '';
}

function serverTransferParentDir(remoteDir = '', sourceDir = '') {
  const normalized = String(remoteDir || '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (!normalized) return '';
  const slash = normalized.lastIndexOf('/');
  const leaf = normalized.slice(slash + 1);
  const sourceFolderName = serverTransferFolderName(sourceDir);
  if (
    slash > 0
    && (leaf.toLowerCase() === sourceFolderName.toLowerCase() || leaf.toLowerCase() === 'new folder-copy')
  ) {
    return normalized.slice(0, slash);
  }
  return normalized;
}

function serverTransferDestinationDir(remoteParentDir = '', sourceDir = '') {
  const parent = String(remoteParentDir || '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
  const sourceFolderName = serverTransferFolderName(sourceDir);
  if (!parent || !sourceFolderName) return parent;
  return `${parent}/${sourceFolderName}`;
}

function serverTransferOptions(config = {}, payload = {}, password = '') {
  const configured = config.serverTransfer || {};
  const excludeDirs = [...new Set(['DregoraRL', ...(configured.excludeDirs || []), ...(payload.excludeDirs || [])])];
  const includeDirs = [...new Set([...(payload.includeDirs || configured.includeDirs || DEFAULT_SERVER_TRANSFER_INCLUDED_DIRS)])];
  const sourceDir = payload.sourceDir || configured.sourceDir || process.env.AHT_SERVER_TRANSFER_SOURCE_DIR || '';
  const configuredRemoteDir = payload.remoteDir || configured.remoteDir || process.env.AHT_SERVER_TRANSFER_REMOTE_DIR || '';
  const remoteParentDir = serverTransferParentDir(configuredRemoteDir, sourceDir);
  return {
    sourceDir,
    host: payload.host || configured.host || process.env.AHT_SERVER_TRANSFER_HOST || '',
    port: Number(payload.port || configured.port || 22),
    username: payload.username || configured.username || process.env.AHT_SERVER_TRANSFER_USERNAME || '',
    remoteParentDir,
    remoteDir: serverTransferDestinationDir(remoteParentDir, sourceDir),
    password,
    privateKeyPath: serverTransferPrivateKeyPath(payload.privateKeyPath || configured.privateKeyPath || ''),
    excludeDirs,
    includeDirs,
    includeRootFiles: payload.includeRootFiles ?? configured.includeRootFiles ?? true,
    concurrency: Number(payload.concurrency || configured.concurrency || 8)
  };
}

async function persistServerTransferSettings(payload = {}) {
  assertDeveloperAuthenticated();
  const config = await loadConfig();
  const options = serverTransferOptions(config, payload);
  const saved = await saveConfig({
    serverTransfer: {
      sourceDir: options.sourceDir,
      host: options.host,
      port: options.port,
      username: options.username,
      remoteDir: options.remoteParentDir,
      privateKeyPath: options.privateKeyPath,
      excludeDirs: options.excludeDirs,
      includeDirs: options.includeDirs,
      includeRootFiles: options.includeRootFiles,
      concurrency: options.concurrency
    }
  });
  return saved.serverTransfer;
}

async function planServerTransfer(payload = {}) {
  assertDeveloperAuthenticated();
  const { collectServerTransferFiles } = await loadServerTransferModule();
  const persisted = await persistServerTransferSettings(payload);
  const options = serverTransferOptions({ serverTransfer: persisted });
  const plan = await collectServerTransferFiles(options.sourceDir, {
    excludeDirs: options.excludeDirs,
    includeDirs: options.includeDirs,
    includeRootFiles: options.includeRootFiles
  });
  return {
    ...plan,
    remoteParentDir: options.remoteParentDir,
    remoteDir: options.remoteDir,
    remoteFolderName: serverTransferFolderName(options.sourceDir)
  };
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
  const persisted = await persistServerTransferSettings(payload);
  const options = serverTransferOptions({ serverTransfer: persisted }, {}, payload.password || secrets.serverSshPassword || '');
  const { uploadServerFiles } = await loadServerTransferModule();
  serverTransferState = {
    running: true,
    lines: [
      `Uploading server files to ${options.username}@${options.host}:${options.remoteDir}`,
      `Authentication: ${options.privateKeyPath ? 'AHT SSH key' : 'saved SSH password'}`,
      `Scope: root files plus ${options.includeDirs.join(', ')}. DregoraRL is always excluded.`
    ],
    lastResult: null,
    error: null,
    progress: { phase: 'Planning', completed: 0, total: 0, percent: 0 }
  };
  try {
    const result = await uploadServerFiles(options, {
      logger: { log: (line) => appendOperationLine(serverTransferState, line) },
      onProgress: (progress) => {
        serverTransferState.progress = progress;
      }
    });
    serverTransferState.lastResult = result;
    appendOperationLine(serverTransferState, `Done. Uploaded ${result.uploaded} changed files, skipped ${result.skipped || 0} unchanged files. Excluded: ${result.excludedDirs.join(', ') || 'none'}`);
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
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs) : null;
    const record = (chunk) => {
      const text = String(chunk);
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

function isPublishableReleasePath(relPath = '') {
  const normalized = String(relPath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  return normalized === 'latest.json'
    || normalized === 'release-report.json'
    || normalized.startsWith('packs/')
    || normalized.startsWith('patches/')
    || normalized.startsWith('manifests/')
    || normalized.startsWith('cache/')
    || normalized.startsWith('server/');
}

function commandOnPath(command = '') {
  const value = String(command || '').trim();
  if (!value) return '';
  if (path.isAbsolute(value)) return fsSync.existsSync(value) ? value : '';
  const directories = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (path.extname(value) ? [''] : String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';'))
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), `${value}${extension}`);
      if (fsSync.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function configuredWranglerPrefix() {
  const raw = String(process.env.AHT_WRANGLER_ARGS_PREFIX || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch {
    // Accept a simple whitespace-separated private launcher override.
  }
  return raw.split(/\s+/).filter(Boolean);
}

function wranglerInvocation() {
  const configured = commandOnPath(process.env.AHT_WRANGLER_COMMAND || '');
  if (configured) {
    return { command: configured, prefix: configuredWranglerPrefix(), source: 'configured' };
  }
  const localName = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
  for (const root of developerSourceRoots()) {
    const local = path.join(root, 'node_modules', '.bin', localName);
    if (fsSync.existsSync(local)) return { command: local, prefix: [], source: 'local' };
  }
  const npx = commandOnPath(process.platform === 'win32' ? 'npx.cmd' : 'npx');
  if (npx) return { command: npx, prefix: ['--yes', 'wrangler@4'], source: 'npx' };
  const pnpm = commandOnPath(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  if (pnpm) return { command: pnpm, prefix: ['--silent', 'dlx', 'wrangler@4'], source: 'pnpm' };
  return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', prefix: ['--yes', 'wrangler@4'], source: 'missing' };
}

function wranglerCommand() {
  return wranglerInvocation().command;
}

function wranglerArgs(args = []) {
  return [...wranglerInvocation().prefix, ...args];
}

function wranglerToolHint() {
  const invocation = wranglerInvocation();
  return invocation.source === 'missing'
    ? 'No local Wrangler runner was found. Install Node/npm, provide pnpm on PATH, or configure AHT_WRANGLER_COMMAND.'
    : `Wrangler runner: ${invocation.source}`;
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
  return workerServiceBaseUrl(latestUrl);
}

function parseWorkerUrl(output = '') {
  const matches = [...String(output || '').matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0].replace(/[),.;]+$/, ''));
  return matches.find((url) => /workers\.dev/i.test(url)) || matches[0] || '';
}

function wranglerOutputShowsAuthenticated(output = '') {
  return /\byou are logged in\b|\byou're logged in\b/i.test(String(output || ''));
}

function wranglerOutputNeedsLogin(output = '') {
  const text = String(output || '');
  if (wranglerOutputShowsAuthenticated(text)) return false;
  return /not authenticated|not logged in|please run [`'"]?wrangler login|run [`'"]?wrangler login/i.test(text);
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
        summary: `${output.trim()}\nRun Setup Cloud to authenticate Wrangler.`
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
      summary: `${output}\nRun Setup Cloud to authenticate Wrangler.`
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
    add('error', 'Wrangler unavailable', `${error.message}\n${wranglerToolHint()}`);
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
    packs: {
      ptb: {
        packId: releaseTarget('ptb').packId,
        name: releaseTarget('ptb').name,
        latestUrl: releaseTargetFeedUrl(latestUrl, 'ptb')
      }
    },
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
      memoryMb: DEFAULT_MINECRAFT_MEMORY_MB,
      java8InstallOverride: null
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
      if (localLatest.clientManifest?.sha256
        && remoteLatest.clientManifest?.sha256 !== localLatest.clientManifest.sha256) {
        throw new Error('remote latest.json does not contain the uploaded client manifest SHA256');
      }
      if (localLatest.delta?.sha256
        && remoteLatest.delta?.sha256 !== localLatest.delta.sha256) {
        throw new Error('remote latest.json does not contain the uploaded delta SHA256');
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
  const clientManifestUrl = remoteLatest.clientManifest?.url || remoteLatest.clientManifest?.path
    ? resolveSource(latestUrl, remoteLatest.clientManifest.url || remoteLatest.clientManifest.path)
    : '';
  const deltaUrl = remoteLatest.delta?.url || remoteLatest.delta?.path
    ? resolveSource(latestUrl, remoteLatest.delta.url || remoteLatest.delta.path)
    : '';
  const checks = [];
  checks.push(await verifyRemoteHead(packUrl, remoteLatest.zip?.size || null));
  if (clientManifestUrl) {
    checks.push(await verifyRemoteHead(clientManifestUrl, remoteLatest.clientManifest?.size || null));
  }
  if (deltaUrl) {
    checks.push(await verifyRemoteHead(deltaUrl, remoteLatest.delta?.size || null));
  }
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

function normalizePublicBaseUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw || !isHttpUrl(raw)) return '';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function publicWorkerBaseUrl(config = {}) {
  return normalizePublicBaseUrl(workerBaseUrlFromLatest(config.latestUrl))
    || normalizePublicBaseUrl(accountBaseUrl(config));
}

function updateMediaAllowedExtensions(kind = '') {
  return kind === 'image'
    ? new Set(['.png', '.jpg', '.jpeg', '.webp'])
    : new Set(['.mp4', '.webm', '.mov']);
}

function safeUpdateMediaKey(filePath, kind = 'media') {
  const ext = path.extname(filePath).toLowerCase();
  if (!updateMediaAllowedExtensions(kind).has(ext)) {
    throw new Error(kind === 'image'
      ? 'Update-log banner must be a PNG, JPG, JPEG, or WEBP file.'
      : 'Update-log video must be an MP4, WEBM, or MOV file.');
  }
  const stamp = new Date().toISOString().slice(0, 7);
  const baseName = path.basename(filePath, ext)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || kind;
  return `update-media/${stamp}/${crypto.randomUUID()}-${baseName}${ext}`;
}

function cleanRemoteMediaUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!isHttpUrl(raw)) {
    throw new Error('Update-log media links must start with http:// or https://.');
  }
  return raw;
}

async function uploadDeveloperUpdateLogMedia({ config, payload, filePath, kind }) {
  const file = path.resolve(String(filePath || '').trim());
  if (!file || !(await pathExists(file))) {
    throw new Error(`Update-log ${kind} file was not found: ${filePath || '(empty)'}`);
  }
  const stat = await fs.stat(file);
  if (!stat.isFile()) {
    throw new Error(`Update-log ${kind} path is not a file: ${file}`);
  }
  const rel = safeUpdateMediaKey(file, kind);
  const bucket = String(payload.r2Bucket || config.developer?.r2Bucket || 'ahtlauncher').trim();
  const publicBase = publicWorkerBaseUrl(config);
  if (!publicBase) {
    throw new Error('Player Feed URL or Worker base URL is required before uploading update-log media.');
  }
  const secrets = await loadDeveloperSecrets().catch(() => ({}));
  const credentials = await resolveR2DirectCredentials({ payload, config, secrets });
  if (!directR2CredentialsReady(credentials)) {
    throw new Error(`Fast R2 upload credentials are required for update-log media. Missing ${missingDirectR2CredentialLabels(credentials).join(', ')}.`);
  }
  const r2Direct = await loadR2DirectUploadModule();
  const sha256 = await hashFile(file, 'sha256');
  await r2Direct.uploadR2ObjectDirect({
    ...credentials,
    bucket,
    key: rel,
    file,
    contentType: contentType(file),
    sha256,
    metadata: {
      'aht-uploaded-by': 'aht-launcher',
      'aht-update-log-media': kind
    }
  });
  return {
    type: kind === 'image' ? 'image' : 'video',
    url: new URL(rel, publicBase).toString(),
    path: rel,
    title: path.basename(file),
    size: stat.size,
    sha256
  };
}

async function prepareDeveloperUpdateLogPayload(config, payload = {}) {
  const next = { ...payload };
  const imageLocalPath = String(next.imageLocalPath || '').trim();
  const videoLocalPath = String(next.videoLocalPath || '').trim();
  const imageUrl = String(next.imageUrl || '').trim();
  const videoUrl = String(next.videoUrl || '').trim();
  const youtubeUrl = String(next.youtubeUrl || '').trim();

  if (imageLocalPath) {
    next.image = await uploadDeveloperUpdateLogMedia({ config, payload: next, filePath: imageLocalPath, kind: 'image' });
  } else if (imageUrl) {
    next.image = { type: 'image', url: cleanRemoteMediaUrl(imageUrl) };
  }

  if (videoLocalPath) {
    next.media = await uploadDeveloperUpdateLogMedia({ config, payload: next, filePath: videoLocalPath, kind: 'video' });
  } else if (youtubeUrl) {
    next.media = { type: 'youtube', url: cleanRemoteMediaUrl(youtubeUrl) };
  } else if (videoUrl) {
    next.media = { type: 'video', url: cleanRemoteMediaUrl(videoUrl) };
  }

  delete next.imageLocalPath;
  delete next.videoLocalPath;
  delete next.imageUrl;
  delete next.videoUrl;
  delete next.youtubeUrl;
  return next;
}

function trimUploadLines(max = 100) {
  if (uploadState.lines.length > max) {
    trimOperationLines(uploadState, max);
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
      const trackedUrl = new URL(entry.url);
      trackedUrl.searchParams.set('aht_download', descriptor.downloadKey);
      downloads[descriptor.downloadKey] = {
        ...entry,
        url: trackedUrl.toString()
      };
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
    allowInsecureLocalhost: process.env.AHT_TEST_ALLOW_INSECURE_LAUNCHER_UPDATE === '1',
    requireTrackedDownloads: true
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
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh';
  return commandOnPath(name) || name;
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

function assertPublicLauncherWorkflow(workflow = {}) {
  const expected = LAUNCHER_WORKFLOW_DEFAULTS;
  if (workflow.repo !== expected.repo
      || workflow.ref !== expected.branch
      || workflow.workflow !== expected.workflow) {
    throw new Error(`Launcher deploy is locked to ${expected.repo}:${expected.branch} using ${expected.workflow}.`);
  }
}

function publicLauncherWorkflow() {
  return {
    repo: LAUNCHER_WORKFLOW_DEFAULTS.repo,
    ref: LAUNCHER_WORKFLOW_DEFAULTS.branch,
    workflow: LAUNCHER_WORKFLOW_DEFAULTS.workflow
  };
}

async function waitForPublishedLauncherVersion(config, version) {
  const latestUrl = launcherLatestUrlForConfig(config);
  if (!latestUrl) throw new Error('Public launcher update feed is not configured.');
  const deadline = Date.now() + 3 * 60 * 1000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const latest = await fetchRemoteJson(latestUrl);
      const validation = validateLauncherUpdateManifest(latest, {
        latestUrl,
        requireTrackedDownloads: true,
        allowInsecureLocalhost: process.env.AHT_TEST_ALLOW_INSECURE_LAUNCHER_UPDATE === '1'
      });
      if (!validation.ok) {
        lastError = validation.errors.join('; ');
      } else if (latest.version === version) {
        return { latestUrl, latest };
      } else {
        lastError = `feed is ${latest.version || 'unknown'}, expected ${version}`;
      }
    } catch (error) {
      lastError = error.message || String(error);
    }
    await sleep(3_000);
  }
  throw new Error(`GitHub finished, but the public launcher feed did not reach ${version}: ${lastError || 'verification timed out'}`);
}

async function runLauncherDeploy(payload = {}) {
  try {
    const config = await loadConfig();
    const workflow = publicLauncherWorkflow();
    assertPublicLauncherWorkflow(workflow);
    const { token, source } = await resolveGithubToken(payload);
    const {
      readGithubPackageVersion,
      triggerLauncherReleaseWorkflow,
      waitForGithubWorkflowRun
    } = await loadGithubActionsModule();
    launcherDeployState.progress = { phase: 'Reading GitHub version', percent: 5 };
    const version = await readGithubPackageVersion({ repo: workflow.repo, ref: workflow.ref, token });
    appendOperationLine(launcherDeployState, `Deploying public AHT Launcher ${version} from ${workflow.repo}:${workflow.ref}.`);
    appendOperationLine(launcherDeployState, 'Developer launcher artifacts are excluded by the public-player workflow.');
    launcherDeployState.progress = { phase: 'Starting GitHub Actions', percent: 10 };
    const dispatched = await triggerLauncherReleaseWorkflow({
      ...workflow,
      token,
      publishToR2: true,
      waitForRunMs: 30_000,
      pollIntervalMs: 2_000
    });
    if (!dispatched.run?.id) {
      throw new Error(`GitHub accepted the deploy, but its workflow run could not be identified. Check ${dispatched.actionsUrl}`);
    }
    appendOperationLine(launcherDeployState, `GitHub run: ${dispatched.run.htmlUrl || dispatched.run.id}`);
    launcherDeployState.progress = { phase: 'Building Windows and macOS', percent: 25 };
    const completedRun = await waitForGithubWorkflowRun({
      repo: workflow.repo,
      runId: dispatched.run.id,
      token,
      waitForCompletionMs: 45 * 60 * 1000,
      pollIntervalMs: 5_000,
      onProgress(run) {
        const phase = run?.status === 'queued' ? 'Waiting for GitHub runner' : 'Building and publishing launchers';
        launcherDeployState.progress = { phase, percent: run?.status === 'queued' ? 20 : 60 };
      }
    });
    launcherDeployState.progress = { phase: 'Verifying public update feed', percent: 90 };
    const verification = await waitForPublishedLauncherVersion(config, version);
    const result = {
      ok: true,
      version,
      repo: workflow.repo,
      ref: workflow.ref,
      workflow: workflow.workflow,
      tokenSource: source,
      run: completedRun,
      releaseUrl: `https://github.com/${workflow.repo}/releases/tag/launcher-v${version}`,
      latestUrl: verification.latestUrl,
      publicArtifacts: ['Windows 10/11 installer', 'macOS Apple Silicon DMG', 'macOS Intel DMG'],
      developerArtifactsUploaded: false
    };
    appendOperationLine(launcherDeployState, `Verified launcher/latest.json at ${version}.`);
    completeOperationState(launcherDeployState, result, 'Published and verified');
  } catch (error) {
    appendOperationLine(launcherDeployState, error.message || String(error));
    failOperationState(launcherDeployState, error, 'Deploy failed');
  }
}

function startLauncherDeploy(payload = {}) {
  assertDeveloperAuthenticated();
  if (launcherDeployState.running) throw new Error('Launcher deploy is already running.');
  launcherDeployState = createOperationState('public-launcher-deploy', 'Preparing public deploy');
  void runLauncherDeploy(payload);
  return launcherDeployState;
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
      appendOperationLine(uploadState, `Uploading ${item.rel} (${item.size || (await fs.stat(item.file)).size} bytes)`);
      const output = await uploadR2Object({
        bucket,
        rel: item.rel,
        file: item.file,
        wranglerCwd,
        onOutput: (text) => {
          const compact = String(text || '').trim();
          if (compact) appendOperationLine(uploadState, compact);
        }
      });
      uploaded.push({ path: item.rel, output: output.trim() });
      uploadState.completed = uploaded.length;
      appendOperationLine(uploadState, `Uploaded ${item.rel}`);
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
  const target = releaseTarget(payload.releaseTarget || 'stable');
  assertDeveloperAuthenticated();
  if (uploadState.running) {
    throw new Error('R2 upload is already running');
  }
  const config = await loadConfig();
  const baseOutDir = resolveReleaseOutDir(payload.outDir || config.developer?.defaultOutDir);
  const outDir = releaseTargetOutDir(baseOutDir, target.id);
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
  assertReleaseMatchesTarget(localLatest, target.id);
  const listedFiles = await listFiles(outDir);
  const files = listedFiles.filter((file) => {
    const rel = path.relative(outDir, file).replaceAll(path.sep, '/');
    return isPublishableReleasePath(rel);
  }).sort((a, b) => {
    const left = path.relative(outDir, a).replaceAll(path.sep, '/');
    const right = path.relative(outDir, b).replaceAll(path.sep, '/');
    const order = releaseUploadOrder(left) - releaseUploadOrder(right);
    return order || left.localeCompare(right);
  });
  const excludedFiles = listedFiles.filter((file) => {
    const rel = path.relative(outDir, file).replaceAll(path.sep, '/');
    return !isPublishableReleasePath(rel);
  });
  const fileStats = new Map();
  let totalBytes = 0;
  for (const file of files) {
    const stat = await fs.stat(file);
    fileStats.set(file, stat);
    totalBytes += stat.size;
  }
  let excludedBytes = 0;
  for (const file of excludedFiles) {
    excludedBytes += (await fs.stat(file)).size;
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
    releaseTarget: target.id,
    packKey: target.sidebarKey,
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
      `Uploading ${files.length} ${target.name} files to remote R2 bucket ${bucket}`,
      ...(excludedFiles.length
        ? [`Excluded ${excludedFiles.length} local staging files (${formatBytes(excludedBytes)}) from the R2 upload.`]
        : []),
      `${releaseTargetObjectKey('latest.json', target.id)} will upload last so only ${target.name} players see the update after artifacts are ready.`,
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
      const objectKey = releaseTargetObjectKey(rel, target.id);
      uploadState.current = objectKey;
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
        currentFile: objectKey,
        currentPercent: 0,
        method: fastUpload ? 'direct-multipart' : 'wrangler'
      };
      appendOperationLine(uploadState, `Uploading ${objectKey} (${formatBytes(stat.size)})`);
      if (fastUpload) {
        appendOperationLine(uploadState, `Checking remote ${objectKey}`);
        trimUploadLines();
        const sha256 = await releaseObjectSha256({ rel, file, localLatest });
        const remote = await r2Direct.headR2ObjectDirect({
          ...directCredentials,
          bucket,
          key: objectKey
        });
        if (remoteReleaseObjectMatches({ rel, remote, stat, sha256 })) {
          uploaded.push({ path: objectKey, localPath: rel, output: `skipped ${objectKey}; remote object already matches`, method: 'direct-skip', skipped: true, size: stat.size });
          appendOperationLine(uploadState, `Skipped ${objectKey}; remote already matches.`);
        } else {
          const result = await r2Direct.uploadR2ObjectDirect({
            ...directCredentials,
            bucket,
            key: objectKey,
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
                currentFile: objectKey,
                currentPercent: progress.percent || 0,
                speedBytesPerSecond: progress.speedBytesPerSecond || 0,
                method: 'direct-multipart'
              };
              const pct = Number(progress.percent || 0);
              if (pct >= lastLoggedPercent + 10 || pct === 100) {
                lastLoggedPercent = pct;
                appendOperationLine(uploadState, `${objectKey}: ${pct}% (${formatBytes(currentLoaded)}/${formatBytes(stat.size)} at ${formatBytes(progress.speedBytesPerSecond || 0)}/s)`);
                trimUploadLines();
              }
            }
          });
          uploaded.push({ path: objectKey, localPath: rel, output: `uploaded ${objectKey}`, method: result.method, size: result.size });
        }
      } else {
        if (rel.endsWith('.zip')) {
          appendOperationLine(uploadState, 'Large ZIP upload is running through Wrangler; add R2 access keys for byte progress and faster multipart upload.');
        }
        const output = await spawnLogged(npx, wranglerArgs([
          'r2',
          'object',
          'put',
          `${bucket}/${objectKey}`,
          `--file=${file}`,
          `--content-type=${contentType(file)}`,
          '--remote'
        ]), {
          cwd: wranglerCwd,
          timeoutMs: 30 * 60_000,
          onOutput: (text) => {
            const compact = String(text || '').trim();
            if (compact) {
              appendOperationLine(uploadState, compact);
            }
          }
        });
        uploaded.push({ path: objectKey, localPath: rel, output: output.trim(), method: 'wrangler', size: stat.size });
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
        currentFile: objectKey,
        currentPercent: 100,
        speedBytesPerSecond: Math.round(stat.size / Math.max(0.001, (Date.now() - startedAt) / 1000)),
        method: fastUpload ? 'direct-multipart' : 'wrangler'
      };
      const latestUpload = uploaded.at(-1);
      appendOperationLine(uploadState, latestUpload?.skipped ? `Remote current ${objectKey}` : `Uploaded ${objectKey}`);
      trimUploadLines();
    }
    const verification = await verifyRemoteRelease({ publicLatestUrl, localLatest });
    uploadState.verification = verification;
    appendOperationLine(uploadState, `Verified player feed ${verification.publicLatestUrl}`);
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

function openInspectionZipFile(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error) reject(error);
      else resolve(zipFile);
    });
  });
}

function openInspectionZipEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, readStream) => {
      if (error) reject(error);
      else resolve(readStream);
    });
  });
}

async function readInspectionZipEntryBuffer(zipFile, entry, maxBytes = 5 * 1024 * 1024) {
  const stream = await openInspectionZipEntryStream(zipFile, entry);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`ZIP metadata entry is too large: ${entry.fileName}`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function inspectZipMetadataEntries(packZip) {
  const zipFile = await openInspectionZipFile(packZip);
  const result = { clientMetadata: null, manifest: null };
  try {
    await new Promise((resolve, reject) => {
      let stopped = false;
      const fail = (error) => {
        if (stopped) return;
        stopped = true;
        reject(error);
      };
      zipFile.on('entry', (entry) => {
        Promise.resolve().then(async () => {
          const entryName = normalizeRelPath(entry.fileName);
          if (!entryName.endsWith('/')) {
            if (!result.clientMetadata && (entryName === CLIENT_PACK_METADATA_ENTRY || entryName.endsWith(`/${CLIENT_PACK_METADATA_ENTRY}`))) {
              result.clientMetadata = JSON.parse((await readInspectionZipEntryBuffer(zipFile, entry)).toString('utf8'));
            } else if (!result.manifest && entryName === 'manifest.json') {
              result.manifest = JSON.parse((await readInspectionZipEntryBuffer(zipFile, entry)).toString('utf8'));
            }
          }
        })
          .then(() => {
            if (!stopped) {
              setImmediate(() => {
                if (!stopped) {
                  zipFile.readEntry();
                }
              });
            }
          })
          .catch(fail);
      });
      zipFile.on('end', () => {
        if (!stopped) {
          stopped = true;
          resolve();
        }
      });
      zipFile.on('error', fail);
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
  return result;
}

function stripClientPackRoot(relPath = '', rootPrefix = '') {
  const normalized = normalizeRelPath(relPath);
  if (!rootPrefix) return normalized;
  return normalized.startsWith(rootPrefix) ? normalizeRelPath(normalized.slice(rootPrefix.length)) : '';
}

async function inspectFullClientZipEntries(packZip) {
  const zipFile = await openInspectionZipFile(packZip);
  const rawEntries = [];
  let metadata = null;
  let metadataEntryName = '';
  try {
    await new Promise((resolve, reject) => {
      let stopped = false;
      const fail = (error) => {
        if (stopped) return;
        stopped = true;
        reject(error);
      };
      zipFile.on('entry', (entry) => {
        Promise.resolve().then(async () => {
          const entryName = normalizeRelPath(entry.fileName);
          if (entryName.endsWith('/')) {
            return;
          }
          rawEntries.push(entryName);
          if (!metadata && (entryName === CLIENT_PACK_METADATA_ENTRY || entryName.endsWith(`/${CLIENT_PACK_METADATA_ENTRY}`))) {
            metadata = JSON.parse((await readInspectionZipEntryBuffer(zipFile, entry)).toString('utf8'));
            metadataEntryName = entryName;
          }
        })
          .then(() => {
            if (!stopped) {
              setImmediate(() => {
                if (!stopped) {
                  zipFile.readEntry();
                }
              });
            }
          })
          .catch(fail);
      });
      zipFile.on('end', () => {
        if (!stopped) {
          stopped = true;
          resolve();
        }
      });
      zipFile.on('error', fail);
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
  const rootPrefix = metadataEntryName.endsWith(CLIENT_PACK_METADATA_ENTRY)
    ? metadataEntryName.slice(0, -CLIENT_PACK_METADATA_ENTRY.length)
    : '';
  const entries = rawEntries
    .map((entryName) => stripClientPackRoot(entryName, rootPrefix))
    .filter((relPath) => relPath && relPath !== CLIENT_PACK_METADATA_ENTRY && !relPath.startsWith('../') && !relPath.includes('/../') && !path.isAbsolute(relPath));
  const modEntries = entries.filter((entryName) => entryName.toLowerCase().startsWith('mods/') && /\.(jar|zip)$/i.test(entryName));
  return { metadata, entries, modEntries };
}

async function inspectPackZipFile(packZip) {
  if (!packZip) {
    throw new Error('Pack ZIP is required');
  }
  const versionHint = versionHintFromFileName(packZip);
  const { clientMetadata: metadata, manifest } = await inspectZipMetadataEntries(packZip);
  if (metadata) {
    if (metadata.format !== CLIENT_PACK_FORMAT) {
      throw new Error(`${CLIENT_PACK_METADATA_ENTRY} has unsupported format: ${metadata.format || 'missing'}`);
    }
    const version = String(metadata.version || '');
    return {
      packId: metadata.packId || '',
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
  if (!manifest) {
    throw new Error(`ZIP does not contain manifest.json or ${CLIENT_PACK_METADATA_ENTRY}`);
  }
  const version = String(manifest.version || '');
  return {
    packId: manifest.name ? String(manifest.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '',
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
        if (fullClientRelease) {
          const { metadata, entries, modEntries } = await inspectFullClientZipEntries(packPath);
          if (!metadata) {
            add('error', 'AHT client metadata missing', `${CLIENT_PACK_METADATA_ENTRY} was not found in the pack ZIP.`);
          } else {
            if (metadata.format !== CLIENT_PACK_FORMAT) {
              add('error', 'AHT client metadata invalid', `format=${metadata.format || 'missing'}`);
            } else {
              manifestFileCount = 0;
              overrideFileCount = entries.length;
              cacheCoverage = { total: 0, covered: 0, missing: [], complete: true };
              add('ok', 'AHT full client ZIP parsed', `${entries.length} files, ${modEntries.length} mod archives`);
              const versionLockEntry = modEntries.find((name) => /aht-version-lock-.+\.jar$/i.test(path.posix.basename(name)));
              if (versionLockEntry) {
                add('ok', 'client version lock mod included', versionLockEntry);
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
          const zip = new AdmZip(packPath);
          const entries = zip.getEntries();
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

  if (fullClientRelease) {
    const clientManifestRef = latest.clientManifest?.path || latest.clientManifest?.url;
    validateAbsoluteReleaseUrl({
      add,
      publicLatestUrl,
      label: 'client manifest',
      url: latest.clientManifest?.url || '',
      pathRef: latest.clientManifest?.path || ''
    });
    let clientManifest = null;
    if (!clientManifestRef) {
      add('error', 'client manifest reference missing', 'Full client releases require latest.clientManifest.');
    } else {
      const clientManifestPath = localReleasePath(outDir, clientManifestRef);
      if (!clientManifestPath) {
        add('warning', 'client manifest is remote-only', clientManifestRef);
      } else if (!(await pathExists(clientManifestPath))) {
        add('error', 'client manifest missing', clientManifestPath);
      } else {
        try {
          const stat = await fs.stat(clientManifestPath);
          if (Number(latest.clientManifest?.size || 0) > 0 && stat.size !== Number(latest.clientManifest.size)) {
            add('error', 'client manifest size mismatch', `latest.json=${latest.clientManifest.size}, actual=${stat.size}`);
          } else {
            add('ok', 'client manifest size matches', `${stat.size} bytes`);
          }
          if (!/^[a-f0-9]{64}$/i.test(String(latest.clientManifest?.sha256 || ''))) {
            add('error', 'client manifest SHA256 missing', 'A verified client manifest hash is required.');
          } else {
            const actualHash = await hashFile(clientManifestPath, 'sha256');
            if (actualHash.toLowerCase() === String(latest.clientManifest.sha256).toLowerCase()) {
              add('ok', 'client manifest SHA256 matches', actualHash);
            } else {
              add('error', 'client manifest SHA256 mismatch', `latest.json=${latest.clientManifest.sha256}, actual=${actualHash}`);
            }
          }

          clientManifest = await readJsonFile(clientManifestPath);
          const files = Array.isArray(clientManifest.files) ? clientManifest.files : [];
          const foldedPaths = new Set();
          let invalidFiles = 0;
          for (const file of files) {
            const relativePath = normalizeRelPath(file?.relativePath || file?.path || '');
            const folded = relativePath.toLowerCase();
            if (!isClientPackContentPath(relativePath)
              || !Number.isSafeInteger(Number(file?.size)) || Number(file.size) < 0
              || !/^[a-f0-9]{64}$/i.test(String(file?.sha256 || ''))
              || foldedPaths.has(folded)) {
              invalidFiles += 1;
            }
            foldedPaths.add(folded);
          }
          if (clientManifest.format !== CLIENT_MANIFEST_FORMAT
            || String(clientManifest.packId || '') !== String(latest.packId || '')
            || String(clientManifest.version || '') !== String(latest.version || '')
            || invalidFiles > 0) {
            add('error', 'client manifest invalid', `format=${clientManifest.format || 'missing'}, files=${files.length}, invalid=${invalidFiles}`);
          } else {
            add('ok', 'client manifest parsed', `${files.length} exact files for ${clientManifest.version}`);
          }
        } catch (error) {
          add('error', 'client manifest could not be inspected', error.message);
        }
      }
    }

    if (!latest.delta) {
      add('warning', 'delta update unavailable', 'This release remains installable from the full ZIP; a later release can use this manifest as its delta baseline.');
    } else {
      const deltaRef = latest.delta.path || latest.delta.url;
      validateAbsoluteReleaseUrl({
        add,
        publicLatestUrl,
        label: 'delta ZIP',
        url: latest.delta.url || '',
        pathRef: latest.delta.path || ''
      });
      if (!deltaRef) {
        add('error', 'delta ZIP reference missing', 'latest.delta.path or latest.delta.url is required.');
      } else if (latest.delta.format !== CLIENT_DELTA_FORMAT
        || String(latest.delta.toVersion || '') !== String(latest.version || '')
        || !String(latest.delta.fromVersion || '')) {
        add('error', 'delta release metadata invalid', `format=${latest.delta.format || 'missing'}, from=${latest.delta.fromVersion || 'missing'}, to=${latest.delta.toVersion || 'missing'}`);
      } else {
        const deltaPath = localReleasePath(outDir, deltaRef);
        if (!deltaPath) {
          add('warning', 'delta ZIP is remote-only', deltaRef);
        } else if (!(await pathExists(deltaPath))) {
          add('error', 'delta ZIP missing', deltaPath);
        } else {
          try {
            const stat = await fs.stat(deltaPath);
            if (Number(latest.delta.size || 0) > 0 && stat.size !== Number(latest.delta.size)) {
              add('error', 'delta ZIP size mismatch', `latest.json=${latest.delta.size}, actual=${stat.size}`);
            } else {
              add('ok', 'delta ZIP size matches', `${stat.size} bytes`);
            }
            if (!/^[a-f0-9]{64}$/i.test(String(latest.delta.sha256 || ''))) {
              add('error', 'delta ZIP SHA256 missing', 'A verified delta hash is required.');
            } else {
              const actualHash = await hashFile(deltaPath, 'sha256');
              if (actualHash.toLowerCase() === String(latest.delta.sha256).toLowerCase()) {
                add('ok', 'delta ZIP SHA256 matches', actualHash);
              } else {
                add('error', 'delta ZIP SHA256 mismatch', `latest.json=${latest.delta.sha256}, actual=${actualHash}`);
              }
            }

            const zip = new AdmZip(deltaPath);
            const metadataEntry = zip.getEntry(CLIENT_DELTA_METADATA_ENTRY);
            if (!metadataEntry) {
              add('error', 'delta metadata missing', `${CLIENT_DELTA_METADATA_ENTRY} was not found.`);
            } else {
              const metadata = JSON.parse(metadataEntry.getData().toString('utf8'));
              const files = Array.isArray(metadata.files) ? metadata.files : [];
              const deleted = Array.isArray(metadata.deleted) ? metadata.deleted.map((value) => normalizeRelPath(value)) : [];
              const filePaths = new Set(files.map((file) => normalizeRelPath(file?.relativePath || file?.path || '')));
              const archivePaths = zip.getEntries()
                .filter((entry) => !entry.isDirectory && entry.entryName !== CLIENT_DELTA_METADATA_ENTRY)
                .map((entry) => normalizeRelPath(entry.entryName));
              const exactPayload = archivePaths.length === filePaths.size
                && archivePaths.every((relativePath) => filePaths.has(relativePath));
              const validDeleted = deleted.every((relativePath) => isClientPackContentPath(relativePath) && !filePaths.has(relativePath));
              const targetHashMatches = String(metadata.targetManifest?.sha256 || '').toLowerCase()
                === String(latest.clientManifest?.sha256 || '').toLowerCase();
              if (metadata.format !== CLIENT_DELTA_FORMAT
                || String(metadata.packId || '') !== String(latest.packId || '')
                || String(metadata.fromVersion || '') !== String(latest.delta.fromVersion || '')
                || String(metadata.toVersion || '') !== String(latest.version || '')
                || !exactPayload || !validDeleted || !targetHashMatches) {
                add('error', 'delta metadata invalid', `${files.length} changed, ${deleted.length} deleted, exactPayload=${exactPayload}, targetManifest=${targetHashMatches}`);
              } else {
                add('ok', 'delta metadata parsed', `${files.length} changed files, ${deleted.length} explicit deletions`);
              }
            }
          } catch (error) {
            add('error', 'delta ZIP could not be inspected', error.message);
          }
        }
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

function remoteAdminBaseUrl(config = {}) {
  return workerServiceBaseUrl(config.developer?.adminBaseUrl || config.sync?.baseUrl);
}

function remoteAdminLoginTimeoutMs() {
  if (process.env.AHT_TEST_HOOKS === '1') {
    const testTimeout = Number(process.env.AHT_TEST_REMOTE_ADMIN_TIMEOUT_MS || 0);
    if (Number.isFinite(testTimeout) && testTimeout > 0) return Math.max(50, Math.floor(testTimeout));
  }
  return REMOTE_ADMIN_LOGIN_TIMEOUT_MS;
}

async function remoteAdminLogin(config, username = '', password = '') {
  const credentials = await loadDeveloperCredentials();
  const loginUsername = String(username || credentials.username || '').trim();
  const loginPassword = String(password || credentials.password || '');
  if (!loginUsername || !loginPassword) {
    return { ok: false, error: 'Developer credentials are not configured on this machine' };
  }
  const base = remoteAdminBaseUrl(config);
  if (!base) {
    return { ok: false, error: 'Developer admin URL is not configured' };
  }
  const url = new URL('admin/login', base.endsWith('/') ? base : `${base}/`);
  const timeoutMs = remoteAdminLoginTimeoutMs();
  let response = null;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: loginUsername, password: loginPassword }),
      signal: globalThis.AbortSignal?.timeout?.(timeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      error: timedOut
        ? `Worker admin login timed out after ${timeoutMs} ms`
        : `Worker admin login request failed: ${error.message || error}`
    };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: body.error || `${response.status} ${response.statusText}` };
  }
  const token = String(body.token || '');
  const expiresAt = Date.parse(body.expiresAt || '');
  const responseFields = Object.keys(body || {}).sort().slice(0, 8).join(', ') || 'none';
  if (!token) {
    return {
      ok: false,
      expiresAt: body.expiresAt || '',
      error: `Worker admin login response from ${url.pathname} did not include a token (response fields: ${responseFields}). Check the Worker API base URL.`
    };
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) {
    return {
      ok: false,
      expiresAt: body.expiresAt || '',
      error: `Worker admin login response from ${url.pathname} did not include a valid future expiresAt value.`
    };
  }
  adminToken = token;
  adminTokenExpiresAt = expiresAt;
  adminTokenBaseUrl = base;
  return { ok: true, token, baseUrl: base, expiresAt: body.expiresAt, error: '' };
}

async function ensureRemoteAdminToken(config, { username = '', password = '', force = false } = {}) {
  const base = remoteAdminBaseUrl(config);
  if (!base) throw new Error('Worker admin login failed: Developer admin URL is not configured');
  if (!force && adminToken && adminTokenBaseUrl === base && adminTokenExpiresAt > Date.now() + 30_000) {
    return adminToken;
  }
  if (force) clearRemoteAdminToken(base);
  const running = adminLoginPromises.get(base);
  if (running) return running;
  const loginPromise = (async () => {
      const result = await remoteAdminLogin(config, username, password);
      if (!result.ok) {
        throw new Error(`Worker admin login failed: ${result.error}`);
      }
      return result.token;
    })().finally(() => {
      if (adminLoginPromises.get(base) === loginPromise) adminLoginPromises.delete(base);
    });
  adminLoginPromises.set(base, loginPromise);
  return loginPromise;
}

async function adminFetch(config, route, options = {}) {
  assertDeveloperAuthenticated();
  const base = remoteAdminBaseUrl(config);
  if (!base) {
    throw new Error('Developer admin URL is not configured');
  }
  const loginRoute = route.replace(/^\/+/, '').startsWith('admin/login');
  let requestToken = loginRoute ? '' : await ensureRemoteAdminToken(config);
  const url = new URL(route.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`);
  const fetchWithToken = async (token = '') => {
    const headers = { ...(options.headers || {}) };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(url, {
      ...options,
      headers,
      signal: options.signal || globalThis.AbortSignal?.timeout?.(30_000)
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };
  let { response, body } = await fetchWithToken(requestToken);
  if (response.status === 401 && !loginRoute) {
    clearRemoteAdminToken(base, requestToken);
    requestToken = await ensureRemoteAdminToken(config);
    ({ response, body } = await fetchWithToken(requestToken));
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

function spawnDetached(command, args = [], cwd = app.getPath('home'), env = process.env, options = {}) {
  const windowsHide = options.windowsHide !== false;
  const capturePath = process.env.AHT_TEST_HOOKS === '1'
    ? String(process.env.AHT_TEST_MINECRAFT_SPAWN_CAPTURE_PATH || '').trim()
    : '';
  const captureImage = path.basename(String(command || '')).toLowerCase();
  if (capturePath && ['minecraft.exe', 'minecraftlauncher.exe'].includes(captureImage)) {
    fsSync.mkdirSync(path.dirname(capturePath), { recursive: true });
    let captureCount = 1;
    try {
      captureCount = (Number(JSON.parse(fsSync.readFileSync(capturePath, 'utf8'))?.captureCount) || 0) + 1;
    } catch {}
    fsSync.writeFileSync(capturePath, `${JSON.stringify({ command, args, cwd, windowsHide, captureCount }, null, 2)}\n`, 'utf8');
    registerTestWindowsLauncherProcess(command);
    return Promise.resolve({ ok: true, command, args, captured: true });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, command, args });
    });
  });
}

function spawnCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 0, ...spawnOptions } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      shell: false,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs) : null;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s\n${stderr || stdout}`));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with ${code}\n${stderr || stdout}`));
      }
    });
  });
}

function spawnDetachedGui(command, args = [], cwd = app.getPath('home'), env = process.env) {
  // This is the actual launcher GUI, not a console helper. SW_HIDE here can
  // suppress Minecraft Launcher itself on Windows.
  return spawnDetached(command, args, cwd, env, { windowsHide: false });
}

function windowsSystemExecutable(name) {
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(windowsRoot, 'System32', name);
}

function windowsPowerShellExecutable() {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

function encodedPowerShell(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

function testWindowsProcessStatePath() {
  return process.env.AHT_TEST_HOOKS === '1'
    ? String(process.env.AHT_TEST_WINDOWS_PROCESS_STATE_PATH || '').trim()
    : '';
}

function readTestWindowsProcessState() {
  const statePath = testWindowsProcessStatePath();
  if (!statePath) return null;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(statePath, 'utf8'));
    return {
      currentSessionId: Number(parsed.currentSessionId) || 1,
      nextPid: Number(parsed.nextPid) || 62000,
      packageRoots: Array.isArray(parsed.packageRoots) ? parsed.packageRoots : [],
      records: Array.isArray(parsed.records) ? parsed.records : []
    };
  } catch {
    return { currentSessionId: 1, nextPid: 62000, packageRoots: [], records: [] };
  }
}

function writeTestWindowsProcessState(state) {
  const statePath = testWindowsProcessStatePath();
  if (!statePath) return;
  fsSync.mkdirSync(path.dirname(statePath), { recursive: true });
  fsSync.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function registerTestWindowsLauncherProcess(executablePath) {
  const state = readTestWindowsProcessState();
  if (!state) return;
  const pid = state.nextPid;
  state.nextPid += 1;
  state.records = state.records.filter((record) => Number(record.pid) !== pid);
  state.records.push({
    pid,
    image: path.basename(executablePath).toLowerCase(),
    path: path.resolve(executablePath),
    sessionId: state.currentSessionId,
    startTimeUtc: new Date().toISOString(),
    mainWindowHandle: pid + 1000,
    mainWindowTitle: 'Minecraft Launcher',
    responding: true,
    windowVisible: true,
    windowMinimized: false,
    foreground: false
  });
  writeTestWindowsProcessState(state);
}

async function windowsMinecraftLauncherProcessSnapshot() {
  if (process.platform !== 'win32') return { currentSessionId: -1, packageRoots: [], records: [] };
  const testState = readTestWindowsProcessState();
  if (testState) {
    return {
      currentSessionId: testState.currentSessionId,
      packageRoots: testState.packageRoots,
      records: testState.records.filter(isKnownWindowsMinecraftLauncher).map(normalizeWindowsLauncherRecord)
    };
  }
  const result = await spawnCaptured(windowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedPowerShell(buildWindowsMinecraftProcessSnapshotPowerShell())
  ], { timeoutMs: 20_000 });
  const parsed = JSON.parse(String(result.stdout || '').trim() || '{}');
  return {
    currentSessionId: Number(parsed.currentSessionId),
    packageRoots: Array.isArray(parsed.packageRoots) ? parsed.packageRoots.map((root) => path.resolve(root)) : [],
    records: (Array.isArray(parsed.records) ? parsed.records : []).filter(isKnownWindowsMinecraftLauncher).map(normalizeWindowsLauncherRecord)
  };
}

function windowsDesktopMinecraftLauncherCandidates() {
  return [
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Minecraft Launcher', 'MinecraftLauncher.exe') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe') : ''
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
}

function windowsMinecraftLauncherAllowedPaths(config = {}) {
  const configuredRoot = String(config.minecraftLauncher?.rootDir || '').trim();
  return [
    configuredRoot ? path.join(configuredRoot, 'minecraft.exe') : '',
    ...windowsDesktopMinecraftLauncherCandidates()
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
}

function launcherRecordLabel(record = {}) {
  const normalized = normalizeWindowsLauncherRecord(record);
  return `${normalized.image || 'unknown'} PID ${normalized.pid || '?'}${normalized.path ? ` at ${normalized.path}` : ' with an unreadable path'}`;
}

async function terminateTestWindowsLauncherRecord(record) {
  const state = readTestWindowsProcessState();
  if (!state) return false;
  const before = state.records.length;
  state.records = state.records.filter((candidate) => Number(candidate.pid) !== Number(record.pid));
  writeTestWindowsProcessState(state);
  return state.records.length !== before;
}

async function closeWindowsMinecraftLaunchersForProfileReload(config = {}) {
  const snapshot = await windowsMinecraftLauncherProcessSnapshot();
  const currentSessionRecords = snapshot.records.filter((record) => record.sessionId === snapshot.currentSessionId);
  if (!currentSessionRecords.length) {
    return { detected: false, closed: false, images: [], sessionId: snapshot.currentSessionId };
  }
  const allowedPaths = windowsMinecraftLauncherAllowedPaths(config);
  const trusted = currentSessionRecords.filter((record) => windowsLauncherRecordMatchesAllowedPath(record, {
    allowedPaths,
    allowStore: true,
    storeRoots: snapshot.packageRoots,
    sessionId: snapshot.currentSessionId
  }));
  const untrusted = currentSessionRecords.filter((record) => !trusted.some((candidate) => candidate.pid === record.pid));
  if (untrusted.length) {
    throw new Error(`Close Minecraft Launcher and click Play again. A Hard Time will not close an unverified process: ${untrusted.map(launcherRecordLabel).join('; ')}.`);
  }

  const capturePath = process.env.AHT_TEST_HOOKS === '1'
    ? String(process.env.AHT_TEST_MINECRAFT_HANDOFF_CAPTURE_PATH || '').trim()
    : '';
  const terminatedPids = [];
  for (const record of trusted) {
    const current = (await windowsMinecraftLauncherProcessSnapshot()).records.find((candidate) => candidate.pid === record.pid);
    if (!current) continue;
    if (windowsLauncherRecordIdentity(current) !== windowsLauncherRecordIdentity(record)) {
      throw new Error(`Minecraft Launcher changed while preparing Play. Close it manually and try again: ${launcherRecordLabel(current)}.`);
    }
    try {
      if (readTestWindowsProcessState()) {
        await terminateTestWindowsLauncherRecord(record);
      } else {
        // PID targeting avoids killing unrelated launchers; never use /T or /F,
        // because a running Java game must survive and force-close is unsafe.
        await spawnLogged(windowsSystemExecutable('taskkill.exe'), windowsLauncherTaskkillArgs(record), { timeoutMs: 10_000 });
      }
      terminatedPids.push(record.pid);
    } catch {
      // The exact readback below distinguishes a normal self-close from refusal.
    }
  }

  const deadline = Date.now() + 10_000;
  let remaining = [];
  do {
    const current = await windowsMinecraftLauncherProcessSnapshot();
    remaining = current.records.filter((record) => currentSessionRecords.some((before) => before.pid === record.pid));
    if (!remaining.length) break;
    await sleep(250);
  } while (Date.now() < deadline);
  if (remaining.length) {
    throw new Error(`Minecraft Launcher did not close cleanly. Close it manually and click Play again: ${remaining.map(launcherRecordLabel).join('; ')}.`);
  }
  // Require a quiet interval before the final readback so an updater respawn
  // cannot slip between the check and the profile write.
  await sleep(500);
  const postClose = await windowsMinecraftLauncherProcessSnapshot();
  const reopened = postClose.records.filter((record) => record.sessionId === snapshot.currentSessionId);
  if (reopened.length) {
    throw new Error(`Minecraft Launcher reopened while A Hard Time was preparing the selected profile. Close it and click Play again: ${reopened.map(launcherRecordLabel).join('; ')}.`);
  }
  if (capturePath) {
    fsSync.mkdirSync(path.dirname(capturePath), { recursive: true });
    fsSync.writeFileSync(capturePath, `${JSON.stringify({
      detected: trusted,
      action: 'close-for-profile-reload',
      terminatedPids,
      taskkillArgs: trusted.map((record) => windowsLauncherTaskkillArgs(record))
    }, null, 2)}\n`, 'utf8');
  }
  return {
    detected: true,
    closed: true,
    images: trusted.map((record) => record.image),
    pids: trusted.map((record) => record.pid),
    sessionId: snapshot.currentSessionId,
    storeRoots: snapshot.packageRoots
  };
}

async function prepareMinecraftLauncherForPlay(config = {}) {
  if (trustedMinecraftOpenCommandAllowed() && config.minecraftLauncher?.openCommand) {
    return { detected: false, closed: false, images: [], sessionId: -1 };
  }
  if (process.platform === 'win32') {
    return closeWindowsMinecraftLaunchersForProfileReload(config);
  }
  if (process.platform === 'darwin') {
    try {
      const output = await spawnLogged('/usr/bin/pgrep', [
        '-f',
        'Minecraft( Launcher)?[.]app/Contents/MacOS|com[.]mojang[.]minecraftlauncher'
      ], { timeoutMs: 5_000 });
      if (String(output || '').trim()) {
        throw new Error('Close Minecraft Launcher and click Play again so A Hard Time can reload the exact profile.');
      }
    } catch (error) {
      if (/Close Minecraft Launcher/.test(String(error?.message || ''))) throw error;
      // pgrep exits 1 when no matching launcher exists.
    }
  }
  return { detected: false, closed: false, images: [], sessionId: -1 };
}

async function assertMinecraftLauncherStayedClosedForProfileWrite(handoff = {}) {
  if (process.platform !== 'win32' || Number(handoff.sessionId) < 0) return;
  await sleep(250);
  const snapshot = await windowsMinecraftLauncherProcessSnapshot();
  const reopened = snapshot.records.filter((record) => record.sessionId === Number(handoff.sessionId));
  if (reopened.length) {
    throw new Error(`Minecraft Launcher reopened before the selected A Hard Time profile was ready. Close it and click Play again: ${reopened.map(launcherRecordLabel).join('; ')}.`);
  }
}

async function focusWindowsMinecraftLauncher(record) {
  if (process.platform !== 'win32') return { focused: true, visible: true, minimized: false, foregroundPid: Number(record?.pid) || 0 };
  const testState = readTestWindowsProcessState();
  if (testState) {
    const target = testState.records.find((candidate) => Number(candidate.pid) === Number(record?.pid));
    if (!target || target.focusAllowed === false) {
      return { focused: false, visible: Boolean(target?.windowVisible), minimized: Boolean(target?.windowMinimized), foregroundPid: 0 };
    }
    for (const candidate of testState.records) candidate.foreground = false;
    target.windowVisible = true;
    target.windowMinimized = false;
    target.foreground = true;
    writeTestWindowsProcessState(testState);
    return { focused: true, visible: true, minimized: false, foregroundPid: Number(target.pid) };
  }
  const pid = Number(record?.pid);
  if (!pid) return { focused: false, visible: false, minimized: false, foregroundPid: 0 };
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::OutputEncoding = $utf8',
    '$OutputEncoding = $utf8',
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class AhtWindowFocus {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
    '}',
    "'@",
    `$process = Get-Process -Id ${pid} -ErrorAction Stop`,
    '$handle = [IntPtr]$process.MainWindowHandle',
    'if ($handle -eq [IntPtr]::Zero) { throw "Minecraft Launcher has no main window." }',
    '[void][AhtWindowFocus]::ShowWindowAsync($handle, 9)',
    '$activated = [bool][AhtWindowFocus]::SetForegroundWindow($handle)',
    'if (-not $activated) {',
    '  $shell = New-Object -ComObject WScript.Shell',
    '  $activated = [bool]$shell.AppActivate($process.Id)',
    '}',
    'Start-Sleep -Milliseconds 150',
    '$foregroundHandle = [AhtWindowFocus]::GetForegroundWindow()',
    '$foregroundPid = [uint32]0',
    'if ($foregroundHandle -ne [IntPtr]::Zero) { [void][AhtWindowFocus]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundPid) }',
    '[pscustomobject]@{',
    '  focused = [bool]($activated -and $foregroundPid -eq [uint32]$process.Id)',
    '  visible = [bool][AhtWindowFocus]::IsWindowVisible($handle)',
    '  minimized = [bool][AhtWindowFocus]::IsIconic($handle)',
    '  foregroundPid = [int]$foregroundPid',
    '} | ConvertTo-Json -Compress'
  ].join('\n');
  try {
    const result = await spawnCaptured(windowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedPowerShell(script)
    ], { timeoutMs: 10_000 });
    return JSON.parse(String(result.stdout || '').trim() || '{}');
  } catch {
    return { focused: false, visible: false, minimized: false, foregroundPid: 0 };
  }
}

async function confirmWindowsMinecraftLauncherActivation(result, target = {}, timeoutMs = 20_000) {
  if (process.platform !== 'win32') {
    return { ...result, activationConfirmed: true };
  }
  const deadline = Date.now() + timeoutMs;
  let stableIdentity = '';
  let stableSince = 0;
  let lastSeen = [];
  while (Date.now() < deadline) {
    const snapshot = await windowsMinecraftLauncherProcessSnapshot();
    const scopedTarget = {
      ...target,
      sessionId: target.sessionId ?? snapshot.currentSessionId,
      storeRoots: target.storeRoots?.length ? target.storeRoots : snapshot.packageRoots
    };
    lastSeen = snapshot.records.filter((record) => windowsLauncherRecordMatchesTarget(record, scopedTarget));
    const candidate = lastSeen.find(windowsLauncherRecordHasUsableWindow);
    if (candidate) {
      const identity = windowsLauncherWindowIdentity(candidate);
      if (identity !== stableIdentity) {
        stableIdentity = identity;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 750) {
        const focusResult = await focusWindowsMinecraftLauncher(candidate);
        const focusReadback = await windowsMinecraftLauncherProcessSnapshot();
        const focusedCandidate = focusReadback.records.find((current) => windowsLauncherRecordIdentity(current) === windowsLauncherRecordIdentity(candidate));
        const visibleAndFocused = Boolean(
          focusResult.focused
          && focusResult.visible
          && !focusResult.minimized
          && Number(focusResult.foregroundPid) === candidate.pid
          && focusedCandidate?.windowVisible
          && !focusedCandidate?.windowMinimized
          && focusedCandidate?.foreground
        );
        if (!visibleAndFocused) {
          throw new Error('Minecraft Launcher opened, but Windows did not make its window visible and active. Close Minecraft Launcher and click Play again.');
        }
        try {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
        } catch {}
        return {
          ...result,
          activationConfirmed: true,
          visibilityConfirmed: true,
          focusRequested: true,
          processImage: candidate.image,
          processPid: candidate.pid,
          processPath: candidate.path
        };
      }
    } else {
      stableIdentity = '';
      stableSince = 0;
    }
    await sleep(250);
  }
  const detail = lastSeen.length ? ` Found ${lastSeen.map(launcherRecordLabel).join('; ')}, but it did not present a responsive window.` : '';
  throw new Error(`Minecraft Launcher did not open a usable window.${detail} Repair or reinstall Minecraft Launcher, then click Play again.`);
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
async function macOpenCommand() {
  const absoluteOpen = '/usr/bin/open';
  return await pathExists(absoluteOpen) ? absoluteOpen : 'open';
}

async function openMacApplication(args, cwd, env) {
  const command = await macOpenCommand();
  await spawnLogged(command, args, { cwd, env, timeoutMs: 10_000 });
  return { ok: true, command, args };
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
      return await openMacApplication([appPath, '--args', '--workDir', cwd], cwd, env);
    } catch (error) {
      lastError = error;
    }
  }
  for (const args of [
    ['-b', 'com.mojang.minecraftlauncher'],
    ['-b', 'com.microsoft.minecraftlauncher'],
    ['-a', 'Minecraft Launcher'],
    ['-a', 'Minecraft']
  ]) {
    try {
      return await openMacApplication([...args, '--args', '--workDir', cwd], cwd, env);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Minecraft Launcher could not be opened on macOS.${lastError ? ` ${lastError.message}` : ''}`);
}

async function openWindowsStoreMinecraftLauncher(cwd, env, sessionId = -1, storeRoots = []) {
  const appTarget = 'shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft';
  const explorer = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'explorer.exe') : 'explorer.exe';
  const target = { kind: 'store', sessionId, storeRoots };
  let explorerError = null;
  try {
    const result = await spawnDetached(explorer, [appTarget], cwd, env);
    return {
      ...(await confirmWindowsMinecraftLauncherActivation(result, target, 12_000)),
      kind: 'store',
      activationMode: 'apps-folder'
    };
  } catch (error) {
    explorerError = error;
  }
  const commandPrompt = process.env.ComSpec || (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : 'cmd.exe');
  try {
    const result = await spawnDetached(commandPrompt, ['/d', '/s', '/c', 'start', '""', appTarget], cwd, env);
    return {
      ...(await confirmWindowsMinecraftLauncherActivation(result, target)),
      kind: 'store',
      activationMode: 'hidden-start'
    };
  } catch (startError) {
    throw new Error(`Minecraft Launcher could not be opened. App activation failed: ${explorerError?.message || 'unknown error'}. Hidden fallback failed: ${startError.message}`);
  }
}
async function openMinecraftLauncher(config, options = {}) {
  const launcherConfig = await minecraftLauncherRuntimeConfig(config);
  const requestedCwd = launcherConfig.minecraftLauncher?.rootDir || app.getPath('home');
  const cwd = await existingLaunchCwd(requestedCwd);
  const env = minecraftLaunchEnv();
  if (launcherConfig.minecraftLauncher?.openCommand) {
    return spawnDetachedGui(launcherConfig.minecraftLauncher.openCommand, launcherConfig.minecraftLauncher.openArgs || [], cwd, env);
  }

  if (process.platform === 'win32') {
    const candidateErrors = [];
    const preferredCurseForgeRoot = String(launcherConfig.minecraftLauncher?.runtimeCurseForgeRoot || '').trim();
    const usingCurseForgeRoot = Boolean(
      (preferredCurseForgeRoot && samePath(cwd, preferredCurseForgeRoot))
      || isCurseForgeMinecraftRoot(cwd)
    );
    const rootLauncher = cwd ? path.join(cwd, 'minecraft.exe') : '';
    if (rootLauncher && await pathExists(rootLauncher)) {
      const homePage = await setMinecraftLauncherHomePage(cwd);
      if (!homePage.ok) {
        console.warn(`Unable to set Minecraft Launcher home page: ${homePage.reason || 'unknown error'}`);
      }
      const target = { kind: 'root', executablePath: rootLauncher, sessionId: options.sessionId };
      try {
        const result = await confirmWindowsMinecraftLauncherActivation(
          await spawnDetachedGui(rootLauncher, ['--workDir', cwd], cwd, env),
          target
        );
        return {
          ...result,
          kind: usingCurseForgeRoot ? 'curseforge' : 'configured-root',
          rootDir: cwd,
          homePagePrepared: Boolean(homePage.ok)
        };
      } catch (error) {
        const snapshot = await windowsMinecraftLauncherProcessSnapshot();
        const lingering = snapshot.records.filter((record) => windowsLauncherRecordMatchesTarget(record, {
          ...target,
          sessionId: target.sessionId ?? snapshot.currentSessionId
        }));
        if (lingering.length) {
          throw new Error(`Minecraft Launcher started from ${rootLauncher} but did not present a usable window. Close or repair that installation before trying again.`);
        }
        candidateErrors.push(`${rootLauncher}: ${error.message || error}`);
      }
    }
    const candidates = windowsDesktopMinecraftLauncherCandidates();
    const desktopArgs = ['--workDir', cwd];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        try {
          return {
            ...(await confirmWindowsMinecraftLauncherActivation(
              await spawnDetachedGui(candidate, desktopArgs, cwd, env),
              { kind: 'desktop', executablePath: candidate, sessionId: options.sessionId }
            )),
            kind: 'desktop',
            rootDir: cwd
          };
        } catch (error) {
          const snapshot = await windowsMinecraftLauncherProcessSnapshot();
          const lingering = snapshot.records.filter((record) => windowsLauncherRecordMatchesTarget(record, {
            kind: 'desktop',
            executablePath: candidate,
            sessionId: options.sessionId ?? snapshot.currentSessionId
          }));
          if (lingering.length) {
            throw new Error(`Minecraft Launcher started from ${candidate} but did not present a usable window. Close or repair that installation before trying again.`);
          }
          candidateErrors.push(`${candidate}: ${error.message || error}`);
        }
      }
    }
    try {
      return await openWindowsStoreMinecraftLauncher(cwd, env, options.sessionId, options.storeRoots || []);
    } catch (error) {
      const prior = candidateErrors.length ? ` Desktop attempts: ${candidateErrors.join(' | ')}.` : '';
      throw new Error(`${error.message || error}${prior}`);
    }
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
  mainWindow.loadFile(path.join(appRoot, 'desktop', 'renderer', 'index.html'), {
    query: isDeveloperMode() ? { mode: 'developer' } : {}
  });
}

function focusMainWindow() {
  if (!mainWindow) {
    if (app.isReady()) {
      createWindow();
    } else {
      app.whenReady().then(() => {
        if (!mainWindow) {
          createWindow();
        }
        focusMainWindow();
      }).catch(() => {});
    }
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

ipcMain.handle('diagnostics:copyErrorReport', async (_event, payload = {}) => copyErrorDiagnosticReport(payload));
let testStatusFailuresRemaining = process.env.AHT_TEST_HOOKS === '1'
  ? Math.max(0, Number.parseInt(process.env.AHT_TEST_STATUS_FAILURE_COUNT || '0', 10) || 0)
  : 0;
ipcMain.handle('status:get', async (_event, payload = {}) => {
  if (process.env.AHT_TEST_HOOKS === '1' && testStatusFailuresRemaining > 0) {
    testStatusFailuresRemaining -= 1;
    throw new Error('Test-only initial status failure.');
  }
  return getStatus(null, payload?.packKey || payload || 'stable');
});
ipcMain.handle('settings:save', async (_event, payload = {}) => {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'config')) {
    return saveSettings(payload.config || {}, payload.packKey || 'stable');
  }
  return saveSettings(payload || {}, 'stable');
});
ipcMain.handle('settings:testFeed', async (_event, payload = {}) => {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'config')) {
    return testReleaseFeed(payload.config || {}, payload.packKey || 'stable');
  }
  return testReleaseFeed(payload || {}, 'stable');
});
ipcMain.handle('update:start', diagnosticIpc('update:start', async (_event, payload = {}) => runUpdate(Boolean(payload.forceRepair), {
  replaceGameSettings: Boolean(payload.replaceGameSettings),
  packKey: payload.packKey || 'stable'
})));
ipcMain.handle('update:state', async () => updateState);
ipcMain.handle('launcher:updateStart', diagnosticIpc('launcher:updateStart', async () => runLauncherUpdate()));
ipcMain.handle('launcher:updateRestart', diagnosticIpc('launcher:updateRestart', async () => restartLauncherUpdate()));
ipcMain.handle('launcher:updateState', async () => {
  await hydratePendingLauncherUpdateState();
  return launcherUpdateState;
});
ipcMain.handle('account:register', async (_event, username) => registerMinecraftUsername(username));
ipcMain.handle('legal:status', diagnosticIpc('legal:status', async () => launcherLegalStatus()));
ipcMain.handle('legal:accept', diagnosticIpc('legal:accept', async (_event, payload = {}) => acceptLauncherLegal(payload)));
ipcMain.handle('app:exit', async () => {
  app.quit();
  return { ok: true };
});
ipcMain.handle('social:list', diagnosticIpc('social:list', async () => {
  const context = await socialRequestContext();
  return fetchSocialState(context);
}));
ipcMain.handle('social:action', diagnosticIpc('social:action', async (_event, payload = {}) => {
  const context = await socialRequestContext();
  return sendSocialAction({
    ...context,
    action: payload.action,
    target: payload.target
  });
}));
ipcMain.handle('changes:scan', async (_event, payload = {}) => {
  const config = configForPack(await loadConfig(), payload?.packKey || payload || 'stable');
  if (developerClientBypassAllowed()) {
    return developerBypassLocalChangesState(config, 'developer-scan-bypass');
  }
  return scanLocalChanges(config.instanceDir);
});
ipcMain.handle('files:scan', async (_event, payload = {}) => {
  const config = configForPack(await loadConfig(), payload?.packKey || payload || 'stable');
  if (developerClientBypassAllowed()) {
    return developerBypassIntegrityState(config, 'developer-scan-bypass');
  }
  const integrity = await scanCurrentManagedIntegrity(config);
  return writeIntegrityState(config, integrity, 'scan');
});
ipcMain.handle('changes:sync', async (_event, payload = {}) => {
  const config = configForPack(await loadConfig(), payload?.packKey || payload || 'stable');
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
ipcMain.handle('play:start', launchDiagnosticIpc(async (_event, payload = {}, attempt) => {
  const target = releaseTarget(payload?.packKey || payload || 'stable');
  await runLaunchStep(
    attempt,
    'legal-consent',
    'Verify Terms and Privacy consent',
    async () => {
      const status = await launcherLegalStatus();
      if (status.required) {
        throw new Error('Review and accept the current Terms and Privacy notice before playing.');
      }
      return status;
    },
    'Current consent is recorded.'
  );
  setLaunchRequirement(attempt, 'legal', 'PASS', 'Current consent is recorded.');
  const config = await runLaunchStep(
    attempt,
    'load-config',
    'Load AHT launcher settings',
    async () => configForPack(await loadConfig(), target.id),
    (value) => `Selected ${target.name} at ${value.instanceDir}.`
  );
  attempt.instanceDir = config.instanceDir;
  const instanceExists = await pathExists(config.instanceDir);
  setLaunchRequirement(
    attempt,
    'instance',
    instanceExists ? 'PASS' : 'FAIL',
    instanceExists ? config.instanceDir : 'The selected AHT instance folder does not exist.'
  );
  const launcherConfig = await runLaunchStep(
    attempt,
    'runtime-config',
    'Resolve Minecraft Launcher paths',
    async () => minecraftLauncherRuntimeConfig(config),
    (value) => `Minecraft root: ${value.minecraftLauncher?.rootDir || 'not resolved'}.`
  );
  attempt.minecraftRoot = launcherConfig.minecraftLauncher?.rootDir || '';
  attempt.runtimeConfig = launcherConfig;
  attempt.minecraftSignalBaseline = await runLaunchStep(
    attempt,
    'launcher-log-baseline',
    'Snapshot existing Minecraft Launcher errors',
    async () => minecraftLaunchDiagnostic(launcherConfig).catch((error) => ({ roots: [], snapshotError: error?.message || String(error) })),
    (value) => value.snapshotError
      ? { status: 'WARN', detail: 'Existing launcher errors could not be separated; launch checks will continue.' }
      : 'Existing launcher errors were separated from this Play attempt.'
  );
  attempt.minecraftInstanceSignalBaseline = await runLaunchStep(
    attempt,
    'instance-log-baseline',
    'Snapshot existing Minecraft crash files',
    async () => minecraftInstanceSignalDiagnostic(config.instanceDir).catch((error) => ({ files: [], snapshotError: error?.message || String(error) })),
    (value) => value.snapshotError
      ? { status: 'WARN', detail: 'Existing instance crash files could not be separated; launch checks will continue.' }
      : 'Existing instance crash files were separated from this Play attempt.'
  );
  const developerClientBypass = developerClientBypassAllowed();

  const launcherUpdate = await runLaunchStep(
    attempt,
    'launcher-version',
    'Check the AHT Launcher version',
    async () => readLauncherUpdate(config),
    (value) => value?.updateRequired
      ? { status: 'FAIL', detail: `Launcher ${value.latestVersion || 'update'} must be installed before Play.` }
      : { status: value?.error ? 'WARN' : 'PASS', detail: value?.error || `Launcher ${app.getVersion()} is current.` }
  );
  const launcherVersionReady = !launcherUpdate?.updateRequired;
  setLaunchRequirement(
    attempt,
    'launcherVersion',
    launcherVersionReady ? (launcherUpdate?.error ? 'WARN' : 'PASS') : 'FAIL',
    launcherVersionReady
      ? (launcherUpdate?.error || `Launcher ${app.getVersion()} is current.`)
      : `Install launcher ${launcherUpdate.latestVersion || 'update'}, then restart AHT Launcher.`
  );
  if (!launcherVersionReady) {
    throw new Error(`AHT Launcher ${launcherUpdate.latestVersion || 'update'} must be installed before Play.`);
  }

  const installedPath = path.join(config.instanceDir, '.aht-launcher', 'installed.json');
  const installed = await runLaunchStep(
    attempt,
    'installed-manifest',
    'Read the installed AHT manifest',
    async () => {
      if (!(await pathExists(installedPath))) return null;
      try {
        return await readJsonFile(installedPath);
      } catch (error) {
        throw new Error(`Installed manifest is damaged. Click Update to reinstall ${target.name}. ${error.message || error}`);
      }
    },
    (value) => value
      ? (value.packId === target.packId
          ? `Installed version ${value.version || 'unknown'}.`
          : { status: 'FAIL', detail: `Installed pack ${value.packId || 'unknown'} does not match ${target.packId}.` })
      : { status: 'WARN', detail: 'No installed manifest was found.' }
  );
  attempt.pack.installedVersion = String(installed?.version || '');
  setLaunchRequirement(
    attempt,
    'installed',
    installed?.packId === target.packId ? 'PASS' : 'FAIL',
    installed
      ? (installed.packId === target.packId
          ? `Installed version ${installed.version || 'unknown'}.`
          : `Installed pack ${installed.packId || 'unknown'} does not match ${target.packId}.`)
      : 'Install or Update must complete before Play.'
  );
  let latest = null;
  let latestError = null;
  const feedStep = beginLaunchStep(attempt, 'release-feed', 'Check the AHT release service');
  try {
    latest = await readLatest(config, { preferCache: true });
    finishLaunchStep(feedStep, 'PASS', `Latest version ${latest?.version || 'unknown'} was loaded.`);
    setLaunchRequirement(attempt, 'releaseFeed', 'PASS', `Latest version ${latest?.version || 'unknown'} is available.`);
  } catch (error) {
    latestError = error.message || String(error);
    if (!developerClientBypass) {
      finishLaunchStep(feedStep, 'FAIL', latestError);
      setLaunchRequirement(attempt, 'releaseFeed', 'FAIL', latestError);
      throw new Error(`Release feed cannot be checked: ${error.message}`);
    }
    finishLaunchStep(feedStep, 'WARN', `Developer mode continued with the installed manifest. ${latestError}`);
    setLaunchRequirement(attempt, 'releaseFeed', 'WARN', 'Developer mode used the installed manifest because the release service was unavailable.');
  }

  const launchLatest = latest || (developerClientBypass && installed ? installed : null);
  attempt.pack.latestVersion = String(launchLatest?.version || '');
  if (installed && launchLatest && installed.packId === target.packId && installed.version !== launchLatest.version) {
    setLaunchRequirement(attempt, 'installed', 'FAIL', `Installed version ${installed.version || 'unknown'}; latest version ${launchLatest.version || 'unknown'}. Update is required.`);
  }
  const preflightOutcomes = await Promise.allSettled([
    runLaunchStep(
      attempt,
      'integrity',
      'Verify managed modpack files',
      async () => (developerClientBypass ? null : scanPlayIntegrity(config, launchLatest)),
      (value) => developerClientBypass
        ? { status: 'WARN', detail: 'Developer client integrity bypass is active.' }
        : (Boolean(value?.valid) && Number(value?.counts?.corrupted || 0) === 0
            ? {
                status: 'PASS',
                detail: `${Number(value?.counts?.checked || value?.counts?.managed || 0)} managed files checked; 0 issues.`
              }
            : { status: 'FAIL', detail: integrityBlockReason(value) })
    ),
    runLaunchStep(
      attempt,
      'minecraft-profile-check',
      'Inspect the exact AHT Minecraft profile',
      async () => inspectMinecraftLauncherProfile({ config: launcherConfig, latest: launchLatest, installed }),
      (value) => ({
        status: value?.profileExists ? 'PASS' : 'WARN',
        detail: `${value?.profileName || target.name}; ${value?.versionId || 'version will be prepared'}.`
      })
    ),
    runLaunchStep(
      attempt,
      'java-profile-check',
      'Detect a usable 64-bit Java 8 runtime',
      async () => java8RuntimeStatus(launcherConfig),
      (value) => ({
        status: value?.usable ? 'PASS' : 'WARN',
        detail: value?.usable
          ? `${value.vendor || 'Java'} ${value.version || '8'} ${value.arch || '64-bit'} at ${value.path}.`
          : (value?.reason || value?.rejectedReason || 'AHT-managed Java will be required.')
      })
    )
  ]);
  const rejectedPreflight = preflightOutcomes.find((outcome) => outcome.status === 'rejected');
  if (rejectedPreflight) throw rejectedPreflight.reason;
  const [integrity, minecraftProfile, java8Runtime] = preflightOutcomes.map((outcome) => outcome.value);
  if (developerClientBypass) {
    setLaunchRequirement(attempt, 'integrity', 'WARN', 'Developer client integrity bypass is active.');
  } else {
    const integrityOk = Boolean(integrity?.valid) && Number(integrity?.counts?.corrupted || 0) === 0;
    setLaunchRequirement(
      attempt,
      'integrity',
      integrityOk ? 'PASS' : 'FAIL',
      integrityOk ? `${Number(integrity?.counts?.checked || integrity?.counts?.managed || 0)} managed files passed.` : integrityBlockReason(integrity)
    );
  }
  setLaunchRequirement(
    attempt,
    'java8',
    java8Runtime?.usable ? 'PASS' : 'FAIL',
    java8Runtime?.usable
      ? `${java8Runtime.vendor || 'Java'} ${java8Runtime.version || '8'} ${java8Runtime.arch || '64-bit'} at ${java8Runtime.path}.`
      : (java8Runtime?.reason || java8Runtime?.rejectedReason || 'No usable 64-bit Java 8 runtime was detected.')
  );
  setLaunchRequirement(
    attempt,
    'minecraftProfile',
    minecraftProfile?.profileExists ? 'PASS' : 'WARN',
    minecraftProfile?.profileExists ? `${minecraftProfile.profileName}; ${minecraftProfile.versionId || 'version unresolved'}.` : 'The AHT profile will be created or repaired during this attempt.'
  );
  await runLaunchStep(
    attempt,
    'initial-readiness',
    'Validate launch prerequisites',
    async () => {
      const state = evaluateLaunchState(launcherConfig, launchLatest, developerClientBypass && installed ? null : latestError, installed, minecraftProfile, integrity, {
        skipLoaderCheck: true,
        allowLegacyRelease: developerClientBypass,
        java8Runtime
      });
      if (!state.launchReady) throw new Error(state.launchBlockedReason);
      return state;
    },
    'Prerequisites passed.'
  );

  const identity = await runLaunchStep(
    attempt,
    'launcher-identity',
    'Resolve the local launcher identity',
    async () => identityPayload(launcherConfig),
    'Local launcher identity is ready.'
  );
  const launcherProofPromise = runLaunchStep(
    attempt,
    'launcher-proof',
    'Create a fresh signed AHT launch proof',
    async () => writeSerializedRegisteredLauncherProof({
      config: launcherConfig,
      latest: launchLatest,
      installed,
      identity
    }),
    (value) => `Trusted proof created by ${value?.source || 'the configured signer'}; no token is written to this report.`
  );
  const runtimeRepairPromise = (async () => {
    let repairedProfile = await runLaunchStep(
      attempt,
      'prepare-profile',
      'Create or repair the exact AHT profile',
      async () => ensureMinecraftLauncherProfile({ config: launcherConfig, latest: launchLatest, installed }),
      (value) => `${value?.profileName || target.name}; ${value?.versionId || 'version unresolved'}.`
    );
    const repairedAssets = await runLaunchStep(
      attempt,
      'verify-assets',
      'Verify Minecraft 1.12.2 assets and libraries',
      async () => ensureMinecraftLauncherAssets({ config: launcherConfig, latest: launchLatest, installed, profile: repairedProfile }),
      (value) => {
        const count = Array.isArray(value?.results) ? value.results.length : 1;
        return `${count} Minecraft root${count === 1 ? '' : 's'} checked.`;
      }
    );
    repairedProfile = await runLaunchStep(
      attempt,
      'install-forge',
      'Install or validate Forge 14.23.5.2860',
      async () => installMinecraftProfileLoaders(repairedProfile, { config: launcherConfig, latest: launchLatest, installed }),
      (value) => `${value?.versionId || 'Forge profile'} is ready with ${value?.javaRuntime?.vendor || 'Java 8'} at ${value?.javaPath || value?.javaRuntime?.path || 'the selected Java path'}.`
    );
    return { profile: repairedProfile, minecraftAssets: repairedAssets };
  })();
  const [launcherProofOutcome, runtimeRepairOutcome] = await Promise.allSettled([launcherProofPromise, runtimeRepairPromise]);
  if (launcherProofOutcome.status === 'fulfilled') {
    setLaunchRequirement(attempt, 'launcherProof', 'PASS', `Fresh trusted proof from ${launcherProofOutcome.value?.source || 'the configured signer'}.`);
  }
  if (runtimeRepairOutcome.status === 'fulfilled') {
    setLaunchRequirement(attempt, 'minecraftProfile', 'PASS', `${runtimeRepairOutcome.value.profile?.profileName || target.name} is prepared.`);
    setLaunchRequirement(attempt, 'minecraftRuntime', 'PASS', `${runtimeRepairOutcome.value.profile?.versionId || 'Minecraft 1.12.2 Forge'} assets and libraries are ready.`);
    if (runtimeRepairOutcome.value.profile?.javaRuntime) {
      const runtimeJava = runtimeRepairOutcome.value.profile.javaRuntime;
      const runtimeJavaPath = runtimeRepairOutcome.value.profile.javaPath || runtimeJava.path || 'path not reported';
      setLaunchRequirement(attempt, 'java8', 'PASS', `${runtimeJava.vendor || 'Java'} ${runtimeJava.version || '8'} ${runtimeJava.arch || '64-bit'} at ${runtimeJavaPath} passed preflight.`);
    }
  }
  if (runtimeRepairOutcome.status === 'rejected') throw runtimeRepairOutcome.reason;
  if (launcherProofOutcome.status === 'rejected') throw launcherProofOutcome.reason;
  const launcherProof = launcherProofOutcome.value;
  const runtimeRepair = runtimeRepairOutcome.value;
  const { profile, minecraftAssets } = runtimeRepair;
  await runLaunchStep(
    attempt,
    'final-readiness',
    'Validate the repaired Minecraft installation',
    async () => {
      const state = evaluateLaunchState(launcherConfig, launchLatest, null, installed, profile, integrity, {
        allowLegacyRelease: developerClientBypass,
        java8Runtime: profile.javaRuntime ? { ...java8Runtime, usable: true } : java8Runtime
      });
      if (!state.launchReady) throw new Error(state.launchBlockedReason);
      return state;
    },
    'The repaired installation passed the final gate.'
  );
  const launcherHandoff = await runLaunchStep(
    attempt,
    'launcher-handoff',
    'Prepare Minecraft Launcher for profile selection',
    async () => prepareMinecraftLauncherForPlay(launcherConfig),
    (value) => value?.closed ? 'An existing verified Minecraft Launcher was closed for an exact profile reload.' : 'No conflicting Minecraft Launcher window was open.'
  );
  const selectionConfig = profile?.javaPath
    ? {
      ...launcherConfig,
      minecraftLauncher: {
        ...(launcherConfig.minecraftLauncher || {}),
        javaPath: profile.javaPath
      }
    }
    : launcherConfig;
  const selectedProfile = await runLaunchStep(
    attempt,
    'select-profile',
    `Select the exact ${target.name} profile`,
    async () => {
      const selected = await ensureMinecraftLauncherProfile({
        config: selectionConfig,
        latest: launchLatest,
        installed,
        selectForPlay: true
      });
      if (!selected.selectionPrepared) {
        throw new Error(`Minecraft Launcher profile selection could not be prepared for ${target.name}.`);
      }
      return selected;
    },
    (value) => `${value?.profileName || target.name}; ${value?.versionId || 'version unresolved'} selected.`
  );
  await runLaunchStep(
    attempt,
    'profile-write-check',
    'Confirm the profile stayed selected',
    async () => assertMinecraftLauncherStayedClosedForProfileWrite(launcherHandoff),
    'No competing Minecraft Launcher process rewrote the selection.'
  );
  const launchResult = await runLaunchStep(
    attempt,
    'open-launcher',
    'Open and verify the Minecraft Launcher window',
    async () => openMinecraftLauncher(launcherConfig, {
      sessionId: launcherHandoff.sessionId,
      storeRoots: launcherHandoff.storeRoots || []
    }),
    (value) => {
      const processId = value?.processPid || value?.pid || 0;
      const processImage = value?.processImage || (value?.processPath ? path.basename(value.processPath) : 'Minecraft Launcher');
      const activation = [value?.kind, value?.activationMode].filter(Boolean).join(' / ') || 'launcher application';
      return `${activation} activation confirmed for ${processImage}${processId ? ` (process ${processId})` : ''}.`;
    }
  );
  setLaunchRequirement(attempt, 'minecraftLauncher', 'PASS', 'A visible, responsive Minecraft Launcher window was confirmed.');
  return {
    ...minecraftLaunchResultForRenderer(launchResult),
    minecraftProfile: minecraftProfileForRenderer(selectedProfile),
    launcherHandoff: minecraftLauncherHandoffForRenderer(launcherHandoff),
    launcherProof: launcherProofForRenderer({
      proofFile: launcherProof.proofFile || '',
      trusted: Boolean(launcherProof.trusted),
      source: launcherProof.source || ''
    }),
    minecraftAssets
  };
}));
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
ipcMain.handle('dialog:updateLogImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Update-log banner images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('dialog:updateLogVideo', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Update-log videos', extensions: ['mp4', 'webm', 'mov'] }]
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
ipcMain.handle('shell:openPath', async (_event, target) => {
  const requested = String(target || '').trim();
  if (!requested) {
    return {
      ok: false,
      opened: false,
      target: '',
      error: 'Choose a folder first.',
      captured: false
    };
  }
  const resolved = path.resolve(requested);
  if (process.env.AHT_TEST_HOOKS === '1' && process.env.AHT_TEST_OPEN_PATH_ECHO === '1') {
    return {
      ok: true,
      opened: true,
      target: resolved,
      error: '',
      captured: true
    };
  }
  const error = String(await shell.openPath(resolved) || '').trim();
  return {
    ok: !error,
    opened: !error,
    target: resolved,
    error,
    captured: false
  };
});
ipcMain.handle('setup:recommend', async () => setupForRenderer(await setupRecommendations()));
ipcMain.handle('setup:apply', async () => applyRecommendedSetup());
ipcMain.handle('dev:buildClientZip', diagnosticIpc('dev:buildClientZip', async (_event, payload = {}) => {
  assertDeveloperAuthenticated();
  const target = releaseTarget(payload.releaseTarget || 'stable');
  const { createClientModpackZip } = await loadClientModpackZipModule();
  const config = await loadConfig();
  const baseOutDir = resolveReleaseOutDir(payload?.outDir || config.developer?.defaultOutDir);
  const outDir = path.join(releaseTargetOutDir(baseOutDir, target.id), 'client-zips');
  const version = String(payload.version || '').trim();
  const result = await createClientModpackZip({
    sourceDir: payload.sourceDir || (target.id === 'ptb' ? config.developer?.ptbClientModpackDir : config.developer?.clientModpackDir) || '',
    outDir,
    version,
    name: target.name,
    packId: target.packId,
    minecraft: payload.minecraft || config.minecraftLauncher?.minecraft || {},
    includeFiles: false
  });
  return { ...result, version, releaseTarget: target.id };
}));
ipcMain.handle('dev:buildRelease', diagnosticIpc('dev:buildRelease', async (_event, payload) => {
  assertDeveloperAuthenticated();
  const target = releaseTarget(payload?.releaseTarget || 'stable');
  const inspected = await inspectPackZipFile(payload?.packZip || '');
  assertFullClientReleaseAllowed(inspected, payload?.allowLegacyCurseForge === true);
  if (inspected.fullClientZip && inspected.packId !== target.packId) {
    throw new Error(`${target.name} publication requires a ${target.packId} client ZIP; selected ZIP contains ${inspected.packId || 'no packId'}.`);
  }
  const { buildRelease } = await loadReleaseBuilderModule();
  const config = await loadConfig();
  const targetConfig = configForPack(config, target.id);
  const baseOutDir = resolveReleaseOutDir(payload?.outDir || config.developer?.defaultOutDir);
  const outDir = releaseTargetOutDir(baseOutDir, target.id);
  await ensureDir(outDir);
  const result = await buildRelease({
    packZip: payload.packZip,
    outDir,
    baseUrl: payload.baseUrl,
    channel: target.channel,
    cacheModsDir: payload.cacheModsDir || '',
    previousLatestSource: targetConfig.latestUrl || ''
  });
  assertReleaseMatchesTarget(result.latest, target.id);
  return { ...result, releaseTarget: target.id };
}));
ipcMain.handle('dev:inspectPackZip', diagnosticIpc('dev:inspectPackZip', async (_event, packZip) => {
  assertDeveloperAuthenticated();
  return inspectPackZipFile(packZip);
}));
ipcMain.handle('dev:validateRelease', diagnosticIpc('dev:validateRelease', async (_event, payload) => {
  assertDeveloperAuthenticated();
  const target = releaseTarget(payload?.releaseTarget || 'stable');
  const config = await loadConfig();
  const baseOutDir = resolveReleaseOutDir(payload?.outDir || config.developer?.defaultOutDir);
  const result = await validateRelease({
    ...payload,
    outDir: releaseTargetOutDir(baseOutDir, target.id)
  });
  if (result.latest) {
    try {
      assertReleaseMatchesTarget(result.latest, target.id);
    } catch (error) {
      const item = { label: 'release target mismatch', detail: error.message };
      result.checks.push({ level: 'error', ...item });
      result.errors.push(item);
      result.ok = false;
    }
  }
  return { ...result, releaseTarget: target.id };
}));
ipcMain.handle('dev:cloudLogin', async (_event, payload) => cloudLogin(payload));
ipcMain.handle('dev:cloudSetupBuckets', async (_event, payload) => cloudSetupBuckets(payload));
ipcMain.handle('dev:cloudSetupSecrets', async (_event, payload) => cloudSetupSecrets(payload));
ipcMain.handle('dev:cloudDeployWorker', async (_event, payload) => cloudDeployWorker(payload));
ipcMain.handle('dev:cloudPreflight', async (_event, payload) => cloudPreflight(payload));
ipcMain.handle('dev:writePlayerDefaults', async (_event, payload) => writePlayerDefaults(payload));
ipcMain.handle('dev:syncR2', diagnosticIpc('dev:syncR2', async (_event, payload) => syncR2(payload)));
ipcMain.handle('dev:publishModpackGithub', diagnosticIpc('dev:publishModpackGithub', async (_event, payload = {}) => {
  assertDeveloperAuthenticated();
  const target = releaseTarget(payload.releaseTarget || 'stable');
  const config = await loadConfig();
  const baseOutDir = resolveReleaseOutDir(payload.outDir || config.developer?.defaultOutDir);
  const outDir = releaseTargetOutDir(baseOutDir, target.id);
  const { token, source } = await resolveGithubToken(payload);
  const { publishModpackGithubRelease } = await loadGithubModpackReleaseModule();
  const testGithubEndpoints = process.env.AHT_TEST_HOOKS === '1'
    ? {
        apiBase: process.env.AHT_TEST_GITHUB_API_BASE || undefined,
        uploadsBase: process.env.AHT_TEST_GITHUB_UPLOADS_BASE || undefined
      }
    : {};
  const result = await publishModpackGithubRelease({
    repo: payload.githubRepo || config.developer?.githubRepo || LAUNCHER_WORKFLOW_DEFAULTS.repo,
    ref: payload.githubBranch || config.developer?.githubBranch || LAUNCHER_WORKFLOW_DEFAULTS.branch,
    token,
    outDir,
    releaseTarget: target.id,
    ...testGithubEndpoints
  });
  return { ...result, tokenSource: source };
}));
ipcMain.handle('dev:findLauncherBuilds', async () => findLauncherBuilds());
ipcMain.handle('dev:syncLauncherUpdate', diagnosticIpc('dev:syncLauncherUpdate', async (_event, payload) => syncLauncherUpdate(payload)));
ipcMain.handle('dev:checkLauncherWorkflow', async (_event, payload) => checkLauncherWorkflow(payload));
ipcMain.handle('dev:dispatchLauncherWorkflow', diagnosticIpc('dev:dispatchLauncherWorkflow', async (_event, payload) => dispatchLauncherWorkflow(payload)));
ipcMain.handle('dev:deployLauncher', diagnosticIpc('dev:deployLauncher', async (_event, payload) => startLauncherDeploy(payload)));
ipcMain.handle('dev:launcherDeployState', async () => launcherDeployState);
ipcMain.handle('dev:uploadState', async () => uploadState);
ipcMain.handle('dev:saveServerTransfer', diagnosticIpc('dev:saveServerTransfer', async (_event, payload) => persistServerTransferSettings(payload)));
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
    clearRemoteAdminToken();
    throw new Error('Developer credentials are not configured on this machine. Set AHT_DEVELOPER_PASSWORD or create developer.credentials.json in the app data folder.');
  }
  const normalizedUsername = String(username || '').trim();
  if (normalizedUsername !== credentials.username || password !== credentials.password) {
    developerSession = null;
    clearRemoteAdminToken();
    throw new Error('Invalid username or password');
  }
  const expiresAt = Date.now() + DEVELOPER_SESSION_MS;
  developerSession = { username: normalizedUsername, expiresAt };
  clearRemoteAdminToken();
  const config = await loadConfig();
  const base = workerServiceBaseUrl(config.developer?.adminBaseUrl || config.sync?.baseUrl);
  const skipRemote = process.env.AHT_SKIP_REMOTE_DEVELOPER_LOGIN === '1';
  const remoteRequested = Boolean(base && !skipRemote);
  let remote = null;
  if (remoteRequested) {
    try {
      await ensureRemoteAdminToken(config, { username: normalizedUsername, password, force: true });
      remote = { ok: true, expiresAt: new Date(adminTokenExpiresAt).toISOString(), error: '' };
    } catch (error) {
      remote = { ok: false, expiresAt: '', error: error.message || String(error) };
      console.warn(`Worker admin login failed after local developer login: ${remote.error}`);
    }
  }
  return {
    ok: true,
    expiresAt: new Date(expiresAt).toISOString(),
    remoteAuthenticated: Boolean(remote?.ok),
    remotePending: false,
    remoteExpiresAt: remote?.expiresAt || '',
    remoteError: remoteRequested
      ? (remote?.error || '')
      : (base || skipRemote ? '' : 'Developer admin URL is not configured')
  };
});
ipcMain.handle('dev:summary', async () => adminFetch(await loadConfig(), 'admin/summary'));
ipcMain.handle('dev:events', async (_event, limit = 50) => adminFetch(await loadConfig(), `admin/events?limit=${limit}`));
ipcMain.handle('dev:launcherDownloads', async (_event, payload = {}) => {
  assertDeveloperAuthenticated();
  const limit = Math.max(1, Math.min(Number(payload.limit || 250), 250));
  const params = new URLSearchParams({ limit: String(limit) });
  if (payload.cursor) params.set('cursor', String(payload.cursor));
  return adminFetch(await loadConfig(), `admin/launcher-downloads?${params.toString()}`);
});
ipcMain.handle('dev:playerIpv4Groups', async () => {
  assertDeveloperAuthenticated();
  return adminFetch(await loadConfig(), 'admin/player-ipv4-groups');
});
ipcMain.handle('dev:playerRecords', async (_event, payload = {}) => {
  assertDeveloperAuthenticated();
  const limit = Math.max(1, Math.min(Number(payload.limit || 250), 250));
  const params = new URLSearchParams({ limit: String(limit) });
  if (payload.cursor) params.set('cursor', String(payload.cursor));
  return adminFetch(await loadConfig(), `admin/player-records?${params.toString()}`);
});
ipcMain.handle('dev:launcherUpdates', async (_event, payload = {}) => {
  assertDeveloperAuthenticated();
  const limit = Math.max(1, Math.min(Number(payload.limit || 250), 250));
  const params = new URLSearchParams({ limit: String(limit) });
  if (payload.cursor) params.set('cursor', String(payload.cursor));
  return adminFetch(await loadConfig(), `admin/launcher-updates?${params.toString()}`);
});
ipcMain.handle('dev:updateLogs', async (_event, limit = 20) => adminFetch(await loadConfig(), `admin/update-logs?limit=${limit}`));
ipcMain.handle('dev:publishUpdateLog', diagnosticIpc('dev:publishUpdateLog', async (_event, payload) => {
  assertDeveloperAuthenticated();
  const config = await loadConfig();
  const prepared = await prepareDeveloperUpdateLogPayload(config, payload || {});
  return adminFetch(config, 'admin/update-logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prepared)
  });
}));

if (!singleInstanceLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    writeTestStartupProbe('app-ready', { userData: app.getPath('userData') });
    if (await shouldExitForPendingLauncherInstall()) {
      writeTestStartupProbe('launcher-update-install-pending-exit', { version: app.getVersion() });
      app.exit(0);
      return;
    }
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
