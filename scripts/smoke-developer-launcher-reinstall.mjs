import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadLegalDocuments } from '../src/legalConsent.js';
import { launcherVersionsReferToSameRelease } from '../src/launcherVersion.js';

if (process.platform !== 'win32') {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: 'Windows-only developer-to-player reinstall test' }, null, 2));
  process.exit(0);
}

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = String(packageJson.ahtLauncherVersion || packageJson.version || '');
const developerPort = Number(process.argv[2] || 10570);
const playerPort = developerPort + 1;
if (!Number.isInteger(developerPort) || developerPort < 1024 || playerPort > 65535) {
  throw new Error(`Invalid developer/player debugger ports: ${developerPort}/${playerPort}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-local-reinstall-bridge-'));
const resolvedTempBase = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
if (!`${path.resolve(root)}${path.sep}`.toLowerCase().startsWith(resolvedTempBase)) {
  throw new Error(`Refusing unsafe local reinstall smoke root: ${root}`);
}

const fakeAppData = path.join(root, 'appData');
const fakeLocalAppData = path.join(root, 'localAppData');
const developerUserData = path.join(root, 'developer-user-data');
const regularUserData = path.join(fakeAppData, 'aht-launcher');
const regularConfigPath = path.join(regularUserData, 'launcher.config.json');
const developerDefaultsPath = path.join(root, 'developer.defaults.json');
const playerDefaultsPath = path.join(root, 'player.defaults.json');
const installDir = path.join(fakeLocalAppData, 'Programs', 'A Hard Time Launcher Windows');
const targetExe = path.join(installDir, 'A Hard Time Launcher Windows.exe');
const uninstallerPath = path.join(installDir, 'Uninstall A Hard Time Launcher Windows.exe');
const requestInbox = path.join(regularUserData, 'launcher-updates', 'local-reinstall-test');
const pendingPath = path.join(regularUserData, 'launcher-updates', 'pending-launcher-update.json');
const developerPendingPath = path.join(developerUserData, 'launcher-updates', 'pending-launcher-update.json');
const exactArchiveName = `AHT-Launcher-Windows-10-11-${version}.zip`;
const sourceZip = path.join(root, exactArchiveName);
const smokeExe = path.resolve(String(process.env.AHT_SMOKE_EXE || '').trim() || '.');
const hasSmokeExe = Boolean(String(process.env.AHT_SMOKE_EXE || '').trim());
const fullTransaction = process.env.AHT_DEVELOPER_REINSTALL_FULL_TRANSACTION !== '0';
const preserveSmokeRoot = process.env.AHT_PRESERVE_FAILED_REINSTALL_SMOKE === '1';
const defaultPackagedDir = path.resolve('release-builds', 'windows', 'win-unpacked');
const installedSource = path.resolve(String(
  process.env.AHT_DEVELOPER_REINSTALL_INSTALLED_DIR
  || (fs.existsSync(path.join(defaultPackagedDir, 'A Hard Time Launcher Windows.exe'))
    ? defaultPackagedDir
    : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'A Hard Time Launcher Windows'))
));
const installedUninstallerSource = path.resolve(String(
  process.env.AHT_DEVELOPER_REINSTALL_UNINSTALLER
  || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'A Hard Time Launcher Windows', 'Uninstall A Hard Time Launcher Windows.exe')
));
const updateZip = path.resolve(String(
  process.env.AHT_DEVELOPER_REINSTALL_UPDATE_ZIP
  || path.join(process.cwd(), 'release-builds', 'windows', exactArchiveName)
));
const developerExecutable = hasSmokeExe ? smokeExe : path.resolve('node_modules', 'electron', 'dist', 'electron.exe');
const developerArgs = hasSmokeExe
  ? ['--developer', `--remote-debugging-port=${developerPort}`, `--user-data-dir=${developerUserData}`]
  : ['.', '--developer', `--remote-debugging-port=${developerPort}`, `--user-data-dir=${developerUserData}`];
const developerCwd = hasSmokeExe ? path.dirname(smokeExe) : process.cwd();
const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const execFileAsync = promisify(execFile);
const feedRequests = [];
const feedServer = http.createServer((request, response) => {
  feedRequests.push({
    method: String(request.method || 'GET').toUpperCase(),
    url: String(request.url || '')
  });
  response.writeHead(503, { 'content-type': 'application/json' });
  response.end('{"error":"local reinstall smoke must not read this feed"}');
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function assertNoFeedRequests(label) {
  if (feedRequests.length) {
    throw new Error(`${label} contacted the forbidden launcher feed: ${JSON.stringify(feedRequests)}`);
  }
}

function sameResolvedPath(left, right) {
  return path.resolve(String(left || '')).toLowerCase() === path.resolve(String(right || '')).toLowerCase();
}

async function snapshotFileIdentity(filePath) {
  const before = await fsp.lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Expected a normal file for identity snapshot: ${filePath}`);
  const sha256 = await sha256File(filePath);
  const after = await fsp.lstat(filePath, { bigint: true });
  const statFields = ['size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'dev', 'ino'];
  if (!after.isFile()
      || after.isSymbolicLink()
      || statFields.some((field) => before[field].toString() !== after[field].toString())) {
    throw new Error(`File changed while its identity snapshot was being captured: ${filePath}`);
  }
  return {
    sha256,
    ...Object.fromEntries(statFields.map((field) => [field, after[field].toString()]))
  };
}

async function assertFileIdentityUnchanged(filePath, expected, label) {
  const actual = await snapshotFileIdentity(filePath);
  for (const field of ['sha256', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'dev', 'ino']) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${label} changed regular launcher.config ${field}: expected ${expected[field]}, got ${actual[field]}.`);
    }
  }
  return actual;
}

const privateBoundaryKeyPattern = /(?:^|_)(?:absolute_?)?(?:path|dir|directory|url|uri|nonce|sha(?:256)?|hash|token|secret|password|credential|command|args|cwd|source)(?:$|_)/i;
const privateBoundaryExactKeys = new Set([
  'ackpath',
  'archivedpath',
  'archivepath',
  'backupdir',
  'bootstrapscriptpath',
  'downloadedpath',
  'extractroot',
  'failedcandidatedir',
  'helperdir',
  'installdir',
  'latesturl',
  'localreinstallrequestnonce',
  'logpath',
  'manifesturl',
  'payloadpath',
  'pendingfailurepath',
  'pendingpath',
  'preparedrestart',
  'receiptpath',
  'scriptpath',
  'stagingdir',
  'targetexe'
]);

function normalizedBoundaryKey(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase();
}

function rendererBoundaryViolations(value, options = {}) {
  const violations = [];
  const seen = new Set();
  const forbiddenStrings = [
    root,
    requestInbox,
    regularUserData,
    developerUserData,
    installDir,
    targetExe,
    sourceZip,
    ...(options.forbiddenStrings || [])
  ]
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  const forbiddenNonces = [options.nonce, ...(options.forbiddenNonces || [])]
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);

  function visit(candidate, location) {
    if (candidate === null || candidate === undefined) return;
    if (typeof candidate === 'string') {
      const lowered = candidate.toLowerCase();
      if (forbiddenStrings.some((secret) => lowered.includes(secret))) violations.push(`${location}:known-private-path`);
      if (forbiddenNonces.some((secret) => lowered.includes(secret))) violations.push(`${location}:nonce`);
      if (/\b[a-f0-9]{64}\b/i.test(candidate)) violations.push(`${location}:sha256`);
      if (/(?:[a-z]:[\\/]|\\\\)/i.test(candidate)) violations.push(`${location}:absolute-path`);
      if (/(?:https?:\/\/|file:\/\/)/i.test(candidate)) violations.push(`${location}:url`);
      return;
    }
    if (typeof candidate !== 'object') return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      const normalized = normalizedBoundaryKey(key);
      const compact = normalized.replaceAll('_', '');
      if (privateBoundaryKeyPattern.test(normalized) || privateBoundaryExactKeys.has(compact)) {
        violations.push(`${location}.${key}:sensitive-key`);
      }
      visit(child, `${location}.${key}`);
    }
  }

  visit(value, options.label || 'renderer');
  return [...new Set(violations)];
}

function assertRendererPrivacyBoundary(value, options = {}) {
  const violations = rendererBoundaryViolations(value, options);
  if (violations.length) {
    throw new Error(`${options.label || 'Renderer update boundary'} exposed private update data: ${violations.join(', ')}`);
  }
}

function safeReceiptRelativePath(rawPath = '') {
  const relative = String(rawPath || '');
  if (!relative
      || relative.includes('\0')
      || relative.includes('\\')
      || relative.startsWith('/')
      || /^[a-z]:/i.test(relative)) {
    throw new Error(`Staged receipt contains an unsafe path: ${JSON.stringify(relative)}`);
  }
  const segments = relative.split('/');
  const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || segment !== segment.normalize('NFC')
    || /[<>:"|?*]/.test(segment)
    || /[. ]$/.test(segment)
    || reservedWindowsName.test(segment)
  )) || relative.length > 1024) {
    throw new Error(`Staged receipt contains an unsafe path: ${JSON.stringify(relative)}`);
  }
  return segments.join('/');
}

async function listNormalTreeFiles(treeRoot, label) {
  const rootStat = await fsp.lstat(treeRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} is not a normal directory: ${treeRoot}`);
  }
  const files = [];
  async function visit(current, prefix = '') {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await fsp.lstat(absolute);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${relative}`);
      }
      if (entry.isDirectory() && stat.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && stat.isFile()) files.push({ absolute, relative: relative.replaceAll('\\', '/'), stat });
      else throw new Error(`${label} contains an unsupported entry: ${relative}`);
    }
  }
  await visit(treeRoot);
  return files;
}

async function validateReceiptTree(treeRoot, receipt, label) {
  if (receipt?.schema !== 'aht-launcher-staged-update/v1' || !Array.isArray(receipt.files)) {
    throw new Error(`${label} receipt schema/files are invalid.`);
  }
  const actualFiles = await listNormalTreeFiles(treeRoot, label);
  const actualByPath = new Map(actualFiles.map((entry) => [entry.relative.toLowerCase(), entry]));
  if (receipt.files.length !== Number(receipt.fileCount)
      || actualFiles.length !== Number(receipt.fileCount)) {
    throw new Error(`${label} file count does not match its receipt.`);
  }
  const seen = new Set();
  let totalBytes = 0;
  const treeHash = crypto.createHash('sha256');
  for (const expected of receipt.files) {
    const relative = safeReceiptRelativePath(expected?.path);
    const key = relative.toLowerCase();
    if (seen.has(key)) throw new Error(`${label} receipt repeats ${relative}.`);
    seen.add(key);
    const actual = actualByPath.get(key);
    if (!actual) throw new Error(`${label} is missing receipt file ${relative}.`);
    const expectedSize = Number(expected?.size);
    const expectedSha256 = String(expected?.sha256 || '').toLowerCase();
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || actual.stat.size !== expectedSize) {
      throw new Error(`${label} file size differs for ${relative}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error(`${label} receipt hash is invalid for ${relative}.`);
    const actualSha256 = await sha256File(actual.absolute);
    if (actualSha256 !== expectedSha256) throw new Error(`${label} file hash differs for ${relative}.`);
    totalBytes += expectedSize;
    treeHash.update(relative.toLowerCase());
    treeHash.update('\0');
    treeHash.update(String(expectedSize));
    treeHash.update('\0');
    treeHash.update(expectedSha256);
    treeHash.update('\0');
  }
  const actualTreeSha256 = treeHash.digest('hex');
  if (totalBytes !== Number(receipt.totalBytes)
      || actualTreeSha256 !== String(receipt.treeSha256 || '').toLowerCase()) {
    throw new Error(`${label} byte count/tree hash does not match its receipt.`);
  }
  return { fileCount: actualFiles.length, totalBytes, treeSha256: actualTreeSha256 };
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function validCommitMarker(commit, prepared, installedAck, expectedTreeSha256) {
  return commit?.schema === 'aht-launcher-update-commit/v1'
    && commit.product === 'aht-launcher'
    && commit.handoffNonce === prepared.handoffNonce
    && String(commit.version || '') === version
    && Number(commit.processId) === Number(installedAck.processId)
    && sameResolvedPath(commit.executablePath, targetExe)
    && commit.developerMode === false
    && String(commit.treeSha256 || '').toLowerCase() === String(expectedTreeSha256 || '').toLowerCase()
    && Number.isFinite(Date.parse(String(commit.acceptedAt || '')));
}

async function observeSwapLifecycle({ prepared, installedAckPromise, requestDir, signal }) {
  const commitPath = `${prepared.ackPath}.commit.json`;
  const cleanupPath = `${prepared.ackPath}.cleanup.json`;
  const startedAt = Date.now();
  let installedAck = null;
  let commit = null;
  let cleanup = null;
  let helperLog = '';
  let sawBackup = false;
  let sawStagingRemoval = false;
  let sawCleanupWaitingForCommit = false;
  let sawBackupRemoval = false;
  let cleanupDestructiveStartedAt = '';
  let commitObservedAtMs = 0;
  let backupRemovalObservedAtMs = 0;

  installedAckPromise.then((value) => { installedAck = value; }).catch(() => {});
  while (!signal?.aborted && Date.now() - startedAt < 180_000) {
    const nextLog = await fsp.readFile(prepared.logPath, 'utf8').catch(() => '');
    if (nextLog) helperLog = nextLog;
    const nextCommit = await readJsonIfPresent(commitPath);
    if (nextCommit) {
      commit = nextCommit;
      if (!commitObservedAtMs) commitObservedAtMs = Date.now();
    }
    const nextCleanup = await readJsonIfPresent(cleanupPath);
    if (nextCleanup) cleanup = nextCleanup;
    if (cleanup?.status === 'waiting-for-helper-commit') sawCleanupWaitingForCommit = true;
    if (!cleanupDestructiveStartedAt
        && ['running', 'removing', 'complete'].includes(String(cleanup?.status || ''))) {
      cleanupDestructiveStartedAt = String(cleanup.startedAt || cleanup.completedAt || '');
    }

    const stagingExists = fs.existsSync(prepared.stagingDir);
    const backupExists = fs.existsSync(prepared.backupDir);
    if (backupExists) sawBackup = true;
    if (!stagingExists) sawStagingRemoval = true;
    if (sawBackup && !backupExists) {
      sawBackupRemoval = true;
      if (!backupRemovalObservedAtMs) backupRemovalObservedAtMs = Date.now();
    }

    if (['running', 'removing', 'complete'].includes(String(cleanup?.status || '')) && !commit) {
      return { error: `Backup cleanup entered ${cleanup.status} before the helper commit marker was observable.` };
    }
    if (sawBackupRemoval && !commit) {
      return { error: 'The rollback backup disappeared before the helper commit marker was observable.' };
    }
    const cleanupCompletedOrRequestRemoved = cleanup?.status === 'complete'
      || (requestDir && !fs.existsSync(requestDir));
    if (installedAck && commit && cleanupCompletedOrRequestRemoved && sawBackupRemoval && sawStagingRemoval) {
      return {
        installedAck,
        commit,
        cleanup,
        helperLog,
        sawBackup,
        sawStagingRemoval,
        sawCleanupWaitingForCommit,
        sawBackupRemoval,
        cleanupDestructiveStartedAt,
        commitObservedAtMs,
        backupRemovalObservedAtMs,
        cleanupCompletedByRequestRemoval: cleanup?.status !== 'complete'
      };
    }
    await sleep(25);
  }
  if (signal?.aborted) return { error: 'Staged swap lifecycle observation was aborted.' };
  return {
    error: `Timed out observing staged swap lifecycle: ${JSON.stringify({
      sawBackup,
      sawStagingRemoval,
      sawCleanupWaitingForCommit,
      sawBackupRemoval,
      cleanupDestructiveStartedAt,
      commitObservedAtMs,
      backupRemovalObservedAtMs,
      hasCommit: Boolean(commit),
      cleanupStatus: cleanup?.status || ''
    })}`
  };
}

function assertOrderedLogMessages(logText, messages) {
  let offset = 0;
  for (const message of messages) {
    const index = String(logText || '').indexOf(message, offset);
    if (index < 0) throw new Error(`Launcher update helper log is missing ordered message: ${message}`);
    offset = index + message.length;
  }
}

async function waitForJson(filePath, label, options = {}) {
  const attempts = Number(options.attempts || 600);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw new Error(`Stopped waiting for ${label}.`);
    try {
      const value = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      if (!options.predicate || options.predicate(value)) return value;
    } catch {
      // Atomic writers and the update helper may be between states.
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}: ${filePath}`);
}

async function waitForFileRemoval(filePath, label, attempts = 600) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!fs.existsSync(filePath)) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}: ${filePath}`);
}

async function waitForChildExit(child, label, attempts = 600) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForRequestDirectory(developerClient) {
  let lastDeveloperState = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const names = await fsp.readdir(requestInbox).catch(() => []);
    const nonce = names.find((name) => /^[a-f0-9]{32}$/.test(name));
    if (nonce) return { nonce, requestDir: path.join(requestInbox, nonce) };
    if (attempt % 10 === 0) {
      lastDeveloperState = await evaluate(developerClient, `({
        card: document.querySelector('#launcherReinstallStatus')?.textContent || '',
        log: document.querySelector('#devLog')?.textContent || '',
        buttonDisabled: Boolean(document.querySelector('#testLauncherReinstallButton')?.disabled)
      })`).catch(() => lastDeveloperState);
      if (lastDeveloperState
          && !lastDeveloperState.buttonDisabled
          && /local update test failed|regular launcher was not opened/i.test(lastDeveloperState.card)) {
        throw new Error(`Developer bridge failed before creating its fixed-inbox request: ${JSON.stringify(lastDeveloperState)}`);
      }
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for fixed-inbox request: ${requestInbox}; developer state: ${JSON.stringify(lastDeveloperState)}`);
}

async function stopProcessesUnder(processRoot) {
  const script = [
    '$root = [System.IO.Path]::GetFullPath($env:AHT_PROCESS_ROOT).TrimEnd("\\") + "\\"',
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath([string]$_.ExecutablePath)).StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }'
  ].join('; ');
  await execFileAsync(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, AHT_PROCESS_ROOT: processRoot },
    timeout: 15_000
  }).catch(() => {});
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
}

async function waitForTarget(port, label, attempts = 400) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message || 'no debugger target'}`);
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
    else entry.resolve(message.result || {});
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({
      call(method, params = {}) {
        const id = nextId;
        nextId += 1;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((callResolve, callReject) => {
          pending.set(id, { resolve: callResolve, reject: callReject });
          setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            callReject(new Error(`CDP call timed out: ${method}`));
          }, 30_000);
        });
      },
      close() {
        socket.close();
      }
    }), { once: true });
    socket.addEventListener('error', () => reject(new Error(`Failed to connect to ${wsUrl}`)), { once: true });
  });
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(client, expression, label, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function installToastProbe(client) {
  await evaluate(client, `
    (() => {
      const stack = document.querySelector('#toastStack');
      const records = [];
      const active = new Map();
      window.__ahtToastProbe = { records };
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement) || !node.classList.contains('toast')) continue;
            const record = { text: node.textContent || '', addedAt: performance.now(), removedAt: 0, durationMs: 0 };
            active.set(node, record);
            records.push(record);
          }
          for (const node of mutation.removedNodes) {
            const record = active.get(node);
            if (!record) continue;
            record.removedAt = performance.now();
            record.durationMs = record.removedAt - record.addedAt;
            active.delete(node);
          }
        }
      }).observe(stack, { childList: true });
      return true;
    })()
  `);
}

async function waitForToastRemoval(client, title) {
  const encoded = JSON.stringify(title);
  const record = await waitFor(
    client,
    `window.__ahtToastProbe.records.find((item) => item.text.includes(${encoded}) && item.removedAt > 0) || null`,
    `${title} toast removal`,
    40
  );
  if (!(record.durationMs > 0) || record.durationMs > 4250) {
    throw new Error(`${title} toast remained for ${record.durationMs}ms; page-observed maximum is 4250ms.`);
  }
  return record.durationMs;
}

if (!fs.existsSync(path.join(installedSource, 'A Hard Time Launcher Windows.exe'))) {
  throw new Error(`Packaged launcher source is missing: ${installedSource}. Build win-unpacked or set AHT_DEVELOPER_REINSTALL_INSTALLED_DIR.`);
}
if (!fs.existsSync(updateZip)) {
  throw new Error(`Exact same-version launcher ZIP is missing: ${updateZip}. Build it or set AHT_DEVELOPER_REINSTALL_UPDATE_ZIP.`);
}
if (!fs.existsSync(developerExecutable)) {
  throw new Error(`Developer launcher executable is missing: ${developerExecutable}`);
}

let developerChild = null;
let developerClient = null;
let playerClient = null;
let relaunchedPlayerPid = 0;
let swapLifecycleAbortController = null;
const liveFeedPort = await listen(feedServer);
const forbiddenLiveFeed = `http://127.0.0.1:${liveFeedPort}/forbidden-launcher-latest.json`;

try {
  await fsp.mkdir(path.dirname(installDir), { recursive: true });
  await fsp.cp(installedSource, installDir, { recursive: true, force: true });
  if (!fs.existsSync(uninstallerPath)) {
    if (!fs.existsSync(installedUninstallerSource)) {
      throw new Error(`Installer-owned uninstaller fixture is missing: ${installedUninstallerSource}. Set AHT_DEVELOPER_REINSTALL_UNINSTALLER.`);
    }
    await fsp.copyFile(installedUninstallerSource, uninstallerPath);
  }
  await fsp.copyFile(updateZip, sourceZip);
  for (const required of [targetExe, uninstallerPath, path.join(installDir, 'resources', 'app.asar'), sourceZip]) {
    if (!fs.existsSync(required)) throw new Error(`Packaged local reinstall fixture is missing: ${required}`);
  }

  const baseDefaults = {
    packId: 'a-hard-time-dregora',
    instanceDir: path.join(root, 'instance'),
    latestUrl: '',
    sync: { enabled: false, sendLocalChanges: false, baseUrl: '', playerLabel: 'LocalReinstallSmoke' },
    minecraftLauncher: {
      enabled: true,
      closeLauncherWhenGameStarts: false,
      rootDir: path.join(root, 'minecraft'),
      profileId: 'a-hard-time-dregora',
      profileName: 'A Hard Time',
      memoryMb: 4096
    },
    playCommand: { command: '', args: [], cwd: path.join(root, 'instance') }
  };
  const developerConfig = {
    ...baseDefaults,
    launcherUpdate: { enabled: false, latestUrl: '' },
    developer: { adminBaseUrl: '', r2Bucket: 'ahtlauncher' }
  };
  const regularConfig = {
    ...baseDefaults,
    launcherUpdate: { enabled: true, latestUrl: forbiddenLiveFeed }
  };
  await writeJson(developerDefaultsPath, developerConfig);
  await writeJson(playerDefaultsPath, regularConfig);
  await writeJson(path.join(developerUserData, 'launcher.config.json'), developerConfig);
  await writeJson(regularConfigPath, regularConfig);
  await writeJson(path.join(developerUserData, 'identity.json'), { installId: 'dev-local-reinstall-smoke', minecraftUsername: 'DevLocalReinstallSmoke' });
  await writeJson(path.join(regularUserData, 'identity.json'), { installId: 'player-local-reinstall-smoke', minecraftUsername: 'PlayerLocalReinstallSmoke' });
  const legal = await loadLegalDocuments(process.cwd());
  await writeJson(path.join(regularUserData, 'legal-consent.json'), {
    schemaVersion: 1,
    affirmed: true,
    termsVersion: legal.termsVersion,
    privacyVersion: legal.privacyVersion,
    termsSha256: legal.termsSha256,
    privacySha256: legal.privacySha256,
    acceptedAt: new Date().toISOString(),
    appVersion: version,
    platform: process.platform,
    arch: process.arch,
    minecraftUsername: 'PlayerLocalReinstallSmoke',
    installIdSha256: crypto.createHash('sha256').update('player-local-reinstall-smoke').digest('hex')
  });

  const targetSha256Before = await sha256File(targetExe);
  const uninstallerSha256Before = await sha256File(uninstallerPath);
  const updateArchiveSha256 = await sha256File(sourceZip);
  const updateArchiveSize = (await fsp.stat(sourceZip)).size;

  developerChild = spawn(developerExecutable, developerArgs, {
    cwd: developerCwd,
    env: {
      ...process.env,
      APPDATA: fakeAppData,
      LOCALAPPDATA: fakeLocalAppData,
      AHT_TEST_HOOKS: '1',
      AHT_TEST_LOCAL_REINSTALL_BRIDGE: '1',
      AHT_TEST_LOCAL_REINSTALL_PLAYER_PORT: String(playerPort),
      AHT_TEST_LOCAL_REINSTALL_PLAYER_DEFAULTS: playerDefaultsPath,
      AHT_TEST_USER_DATA: developerUserData,
      AHT_APP_DEFAULTS: developerDefaultsPath,
      AHT_LAUNCHER_SOURCE_ROOT: process.cwd(),
      AHT_DEVELOPER_USERNAME: 'admin',
      AHT_DEVELOPER_PASSWORD: 'test-dev-password',
      AHT_SKIP_REMOTE_DEVELOPER_LOGIN: '1',
      AHT_TEST_DEVELOPER_REINSTALL_ZIP: sourceZip,
      AHT_TEST_LAUNCHER_UPDATE_TARGET_EXE: targetExe,
      ...(fullTransaction ? {} : {
        AHT_TEST_LAUNCHER_UPDATE_NO_QUIT: '1',
        AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY: '1'
      }),
      ...(hasSmokeExe ? { AHT_ALLOW_DEVELOPER: '1' } : {}),
      AHT_TEST_REMOTE_DEBUG_PORT: String(developerPort),
      ELECTRON_ENABLE_LOGGING: '0'
    },
    stdio: 'ignore',
    windowsHide: true
  });

  const developerTarget = await waitForTarget(developerPort, 'Developer Launcher debugger');
  developerClient = await connect(developerTarget.webSocketDebuggerUrl);
  await developerClient.call('Runtime.enable');
  await waitFor(developerClient, "document.readyState === 'complete' && document.body.classList.contains('is-launcher-ready') && document.querySelector('#developerLoginForm') && window.aht", 'hydrated developer launcher DOM');
  await installToastProbe(developerClient);

  await evaluate(developerClient, `
    (() => {
      document.querySelector('#adminUserInput').value = 'admin';
      document.querySelector('#adminPasswordInput').value = 'wrong-password';
      document.querySelector('#developerLoginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()
  `);
  await waitFor(developerClient, "window.__ahtToastProbe.records.some((item) => item.text.includes('Developer login failed') && item.text.includes('Invalid username or password'))", 'wrong-password error toast');
  const wrongPasswordToastMs = await waitForToastRemoval(developerClient, 'Developer login failed');

  await evaluate(developerClient, `
    (() => {
      document.querySelector('#adminUserInput').value = 'admin';
      document.querySelector('#adminPasswordInput').value = 'test-dev-password';
      document.querySelector('#developerLoginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()
  `);
  await waitFor(developerClient, "document.body.classList.contains('dev-locked') === false", 'developer authentication');
  const loginSuccessToastMs = await waitForToastRemoval(developerClient, 'Developer login successful');
  if (fs.existsSync(developerPendingPath)) {
    throw new Error(`Developer Launcher owned a pending player update before the test: ${developerPendingPath}`);
  }

  await evaluate(developerClient, `document.querySelector('[data-dev-target="launcherUpdateTools"]').click()`);
  const developerControl = await evaluate(developerClient, `({
    api: typeof window.aht.devPrepareLauncherReinstall,
    button: document.querySelector('#testLauncherReinstallButton')?.textContent || '',
    card: document.querySelector('#launcherReinstallStatus')?.textContent || ''
  })`);
  if (developerControl.api !== 'function'
      || !developerControl.button.includes('Test Local Reinstall')
      || !developerControl.card.includes('Open the installed player launcher')) {
    throw new Error(`Developer local reinstall control is not wired to the regular launcher: ${JSON.stringify(developerControl)}`);
  }

  const [playerDefaultsBytes, regularConfigBytes] = await Promise.all([
    fsp.readFile(playerDefaultsPath),
    fsp.readFile(regularConfigPath)
  ]);
  if (!playerDefaultsBytes.equals(regularConfigBytes)) {
    throw new Error('The regular player stored config must be byte-identical to the player defaults fixture.');
  }
  const storedRegularConfig = JSON.parse(regularConfigBytes.toString('utf8'));
  if (storedRegularConfig.launcherUpdate?.enabled !== true
      || storedRegularConfig.launcherUpdate?.latestUrl !== forbiddenLiveFeed) {
    throw new Error(`The player stored config does not contain the exact forbidden feed fixture: ${JSON.stringify(storedRegularConfig.launcherUpdate)}`);
  }
  const regularConfigIdentityBeforeAction = await snapshotFileIdentity(regularConfigPath);
  assertNoFeedRequests('Developer bridge before Test Local Reinstall');

  await evaluate(developerClient, `document.querySelector('#testLauncherReinstallButton').click()`);
  const { nonce, requestDir } = await waitForRequestDirectory(developerClient);
  const consumedRequestPath = path.join(requestDir, 'request.consumed.json');
  const promptReadyPath = path.join(requestDir, 'prompt-ready.json');

  const playerTarget = await waitForTarget(playerPort, 'regular AHT Launcher debugger', 600);
  playerClient = await connect(playerTarget.webSocketDebuggerUrl);
  await playerClient.call('Runtime.enable');
  await waitFor(playerClient, "document.readyState === 'complete' && document.querySelector('#launcherUpdateOverlay') && window.aht", 'regular launcher DOM', 600);
  const prompt = await waitFor(playerClient, `(async () => {
    const status = await window.aht.getStatus();
    const title = document.querySelector('#launcherUpdateTitle')?.textContent || '';
    const summary = document.querySelector('#launcherUpdateSummary')?.textContent || '';
    return status?.launcherUpdate?.localReinstallTest && !document.querySelector('#launcherUpdateOverlay')?.hidden
      ? { title, summary, status: status.launcherUpdate, state: await window.aht.getLauncherUpdateState(), search: location.search, devApi: typeof window.aht.devPrepareLauncherReinstall, legalHidden: document.querySelector('#legalOverlay')?.hidden }
      : null;
  })()`, 'genuine regular launcher update prompt', 600);
  if (prompt.search.includes('developer')
      || prompt.devApi !== 'undefined'
      || prompt.legalHidden !== true
      || !/Launcher update required|Update finished/.test(prompt.title)
      || /developer/i.test(`${prompt.title} ${prompt.summary}`)) {
    throw new Error(`Regular update prompt crossed the player privacy/mode boundary: ${JSON.stringify(prompt)}`);
  }
  assertRendererPrivacyBoundary({
    title: prompt.title,
    summary: prompt.summary,
    status: prompt.status,
    state: prompt.state
  }, { label: 'Regular update prompt', nonce });
  await assertFileIdentityUnchanged(regularConfigPath, regularConfigIdentityBeforeAction, 'Opening the regular update prompt');

  const consumedRequest = await waitForJson(consumedRequestPath, 'one-shot consumed local reinstall request');
  const promptReady = await waitForJson(promptReadyPath, 'regular renderer prompt-ready acknowledgement');
  if (Object.keys(consumedRequest).sort().join('|') !== ['artifact', 'createdAt', 'expiresAt', 'nonce', 'product', 'purpose', 'schema', 'targetExe', 'version'].sort().join('|')
      || Object.keys(consumedRequest.artifact || {}).sort().join('|') !== ['fileName', 'sha256', 'size'].sort().join('|')
      || fs.existsSync(path.join(requestDir, 'request.json'))
      || consumedRequest.schema !== 'aht-launcher-local-reinstall-request/v1'
      || consumedRequest.product !== 'aht-launcher'
      || consumedRequest.purpose !== 'local-reinstall-test'
      || consumedRequest.nonce !== nonce
      || consumedRequest.version !== version
      || !sameResolvedPath(consumedRequest.targetExe, targetExe)
      || consumedRequest.artifact?.fileName !== exactArchiveName
      || String(consumedRequest.artifact?.sha256 || '').toLowerCase() !== updateArchiveSha256
      || Number(consumedRequest.artifact?.size) !== updateArchiveSize
      || promptReady.rendererPromptReady !== true
      || promptReady.developerMode !== false
      || !sameResolvedPath(promptReady.executablePath, targetExe)) {
    throw new Error(`Fixed-inbox consume/prompt acknowledgement is invalid: ${JSON.stringify({ consumedRequest, promptReady })}`);
  }
  await waitForChildExit(developerChild, 'Developer Launcher exit after player prompt-ready acknowledgement');
  if (fs.existsSync(developerPendingPath)) {
    throw new Error('Developer Launcher staged or installed the update instead of the regular launcher.');
  }

  const staged = await waitFor(playerClient, `(async () => {
    const state = await window.aht.getLauncherUpdateState();
    if (state?.error) return { error: state.error, state };
    const title = document.querySelector('#launcherUpdateTitle')?.textContent || '';
    const button = document.querySelector('#launcherUpdateNowButton')?.textContent || '';
    return state?.lastResult?.restartRequired && title.includes('Update finished') && button.includes('Restart Launcher')
      ? { state, title, button }
      : null;
  })()`, 'regular launcher same-version staging', 1200);
  if (staged.error) throw new Error(`Regular launcher staging failed: ${JSON.stringify(staged)}`);
  if (staged.state?.purpose !== 'local-reinstall-test'
      || staged.state?.lastResult?.purpose !== 'local-reinstall-test'
      || staged.state?.lastResult?.restartRequired !== true
      || staged.state?.lastResult?.instantRestartReady !== true
      || Object.prototype.hasOwnProperty.call(staged.state.lastResult, 'preparedRestart')
      || !staged.title.includes('Update finished')
      || !staged.button.includes('Restart Launcher')) {
    throw new Error(`Regular launcher did not reach the privacy-shaped genuine Restart boundary: ${JSON.stringify(staged)}`);
  }
  assertRendererPrivacyBoundary({
    title: staged.title,
    button: staged.button,
    state: staged.state
  }, { label: 'Regular staged-update state', nonce });
  await assertFileIdentityUnchanged(regularConfigPath, regularConfigIdentityBeforeAction, 'Staging the local reinstall');

  const pending = await waitForJson(pendingPath, 'regular launcher staged pending record');
  const prepared = pending.preparedRestart || {};
  const installParent = path.dirname(installDir);
  if (pending.purpose !== 'local-reinstall-test'
      || pending.localReinstallRequestNonce !== nonce
      || pending.version !== version
      || pending.status !== 'ready-to-relaunch'
      || prepared.strategy !== 'windows-staged-helper'
      || prepared.mode !== 'staged-swap'
      || !/^[a-f0-9]{32}$/.test(String(prepared.handoffNonce || ''))
      || prepared.expectedVersion !== version
      || prepared.relaunchDeveloper !== false
      || (prepared.relaunchArgs || []).some((arg) => String(arg).includes('--developer'))
      || !sameResolvedPath(prepared.targetExe, targetExe)
      || !sameResolvedPath(prepared.installDir, installDir)
      || prepared.targetRelativePath !== path.basename(targetExe)
      || !sameResolvedPath(path.dirname(path.resolve(String(prepared.stagingDir || ''))), installParent)
      || !sameResolvedPath(path.dirname(path.resolve(String(prepared.backupDir || ''))), installParent)
      || !path.basename(String(prepared.stagingDir || '')).toLowerCase().startsWith('.aht-launcher-update-')
      || !path.basename(String(prepared.backupDir || '')).toLowerCase().startsWith('.aht-launcher-backup-')
      || !fs.existsSync(prepared.receiptPath)
      || !fs.existsSync(prepared.payloadPath)
      || !fs.existsSync(prepared.scriptPath)
      || !fs.existsSync(prepared.bootstrapScriptPath)) {
    throw new Error(`Regular local reinstall pending contract is incomplete: ${JSON.stringify(pending)}`);
  }
  const [payloadSha256, scriptSha256, bootstrapScriptSha256] = await Promise.all([
    sha256File(prepared.payloadPath),
    sha256File(prepared.scriptPath),
    sha256File(prepared.bootstrapScriptPath)
  ]);
  const helperPayload = JSON.parse(await fsp.readFile(prepared.payloadPath, 'utf8'));
  if (payloadSha256 !== String(prepared.payloadSha256 || '').toLowerCase()
      || scriptSha256 !== String(prepared.scriptSha256 || '').toLowerCase()
      || bootstrapScriptSha256 !== String(prepared.bootstrapScriptSha256 || '').toLowerCase()
      || helperPayload.mode !== 'staged-swap'
      || helperPayload.handoffNonce !== prepared.handoffNonce
      || helperPayload.expectedVersion !== version
      || helperPayload.relaunchDeveloper !== false
      || (helperPayload.relaunchArgs || []).some((arg) => String(arg).includes('--developer'))
      || !sameResolvedPath(helperPayload.installDir, installDir)
      || !sameResolvedPath(helperPayload.stagingDir, prepared.stagingDir)
      || !sameResolvedPath(helperPayload.backupDir, prepared.backupDir)
      || !sameResolvedPath(helperPayload.receiptPath, prepared.receiptPath)
      || String(helperPayload.receiptSha256 || '').toLowerCase() !== String(prepared.receiptSha256 || '').toLowerCase()
      || String(helperPayload.treeSha256 || '').toLowerCase() !== String(prepared.treeSha256 || '').toLowerCase()) {
    throw new Error('The staged PowerShell handoff is not hash-bound to the exact regular-player swap contract.');
  }
  const receiptSha256 = await sha256File(prepared.receiptPath);
  const receipt = JSON.parse(await fsp.readFile(prepared.receiptPath, 'utf8'));
  const productVersion = String(receipt.productVersion || '');
  if (receiptSha256 !== String(prepared.receiptSha256 || '').toLowerCase()
      || receipt.expectedVersion !== version
      || !launcherVersionsReferToSameRelease(productVersion, version)
      || receipt.targetExeRelativePath !== path.basename(targetExe)
      || String(receipt.archiveSha256 || '').toLowerCase() !== updateArchiveSha256
      || String(receipt.treeSha256 || '').toLowerCase() !== String(prepared.treeSha256 || '').toLowerCase()
      || Number(receipt.fileCount) !== Number(prepared.stagedFileCount)
      || Number(receipt.totalBytes) !== Number(prepared.stagedBytes)
      || !Array.isArray(receipt.preservedInstallerFiles)
      || !receipt.preservedInstallerFiles.some((name) => String(name).toLowerCase() === path.basename(uninstallerPath).toLowerCase())) {
    throw new Error(`Prepared staged receipt is not bound to the exact same-version player artifact: ${JSON.stringify(receipt)}`);
  }
  const stagedTree = await validateReceiptTree(prepared.stagingDir, receipt, 'Prepared launcher staging tree');
  if (stagedTree.treeSha256 !== String(prepared.treeSha256 || '').toLowerCase()) {
    throw new Error(`Prepared staging tree hash does not match the pending handoff: ${JSON.stringify(stagedTree)}`);
  }
  if (fs.existsSync(prepared.backupDir)) {
    throw new Error(`Rollback backup existed before Restart Launcher: ${prepared.backupDir}`);
  }
  assertNoFeedRequests('Local reinstall staging');
  if (await sha256File(targetExe) !== targetSha256Before
      || await sha256File(uninstallerPath) !== uninstallerSha256Before
      || !fs.existsSync(prepared.stagingDir)) {
    throw new Error('Installed bytes changed, or the prepared staging tree disappeared, before Restart Launcher.');
  }
  await assertFileIdentityUnchanged(regularConfigPath, regularConfigIdentityBeforeAction, 'Immediately before Restart Launcher');

  if (fullTransaction) {
    swapLifecycleAbortController = new AbortController();
    const installedAckPromise = waitForJson(prepared.ackPath, 'restarted regular launcher acknowledgement', {
      attempts: 1200,
      predicate: (value) => value?.handoffNonce === prepared.handoffNonce,
      signal: swapLifecycleAbortController.signal
    });
    const lifecyclePromise = observeSwapLifecycle({
      prepared,
      installedAckPromise,
      requestDir,
      signal: swapLifecycleAbortController.signal
    });
    await evaluate(playerClient, `document.querySelector('#launcherUpdateNowButton').click()`);
    playerClient.close();
    playerClient = null;
    const installedAck = await installedAckPromise;
    relaunchedPlayerPid = Number(installedAck.processId || 0);
    if (installedAck.developerMode !== false
        || String(installedAck.version || '') !== version
        || !sameResolvedPath(installedAck.executablePath, targetExe)
        || !Number.isInteger(relaunchedPlayerPid)
        || relaunchedPlayerPid <= 0) {
      throw new Error(`Updated launcher acknowledgement did not return in regular player mode: ${JSON.stringify(installedAck)}`);
    }
    const lifecycle = await lifecyclePromise;
    swapLifecycleAbortController = null;
    if (lifecycle.error) throw new Error(lifecycle.error);
    if (!lifecycle.sawBackup
        || !lifecycle.sawStagingRemoval
        || !lifecycle.sawBackupRemoval
        || !(lifecycle.commitObservedAtMs > 0)
        || lifecycle.commitObservedAtMs > lifecycle.backupRemovalObservedAtMs
        || !validCommitMarker(lifecycle.commit, prepared, installedAck, receipt.treeSha256)) {
      throw new Error(`Real staged-swap lifecycle/commit proof is incomplete: ${JSON.stringify(lifecycle)}`);
    }
    const commitAcceptedAt = Date.parse(lifecycle.commit.acceptedAt);
    const cleanupStartedAt = Date.parse(String(lifecycle.cleanupDestructiveStartedAt || ''));
    const cleanupCompletedAt = Date.parse(String(lifecycle.cleanup?.completedAt || ''));
    if (commitAcceptedAt > lifecycle.backupRemovalObservedAtMs
        || (Number.isFinite(cleanupStartedAt) && cleanupStartedAt < commitAcceptedAt)
        || (lifecycle.cleanup?.status === 'complete'
          ? (!Number.isFinite(cleanupCompletedAt)
            || cleanupCompletedAt < commitAcceptedAt
            || (Number.isFinite(cleanupStartedAt) && cleanupCompletedAt < cleanupStartedAt))
          : lifecycle.cleanupCompletedByRequestRemoval !== true)) {
      throw new Error(`Rollback cleanup was not completed after the helper commit: ${JSON.stringify({ commit: lifecycle.commit, cleanup: lifecycle.cleanup })}`);
    }
    assertOrderedLogMessages(lifecycle.helperLog, [
      `Ready to quit nonce=${prepared.handoffNonce}`,
      'Swapping prepared launcher payload into',
      'Started updated launcher PID',
      `Updated launcher acknowledged a ready window for nonce ${prepared.handoffNonce}`,
      'Launcher update commit accepted at',
      'delegated rollback directory cleanup to the new launcher'
    ]);
    const installedTree = await validateReceiptTree(installDir, receipt, 'Swapped installed launcher tree');
    if (installedTree.treeSha256 !== lifecycle.commit.treeSha256) {
      throw new Error(`Committed installed tree differs from the staged receipt: ${JSON.stringify(installedTree)}`);
    }
    await assertFileIdentityUnchanged(regularConfigPath, regularConfigIdentityBeforeAction, 'Relaunching the swapped regular launcher');
    await waitForFileRemoval(pendingPath, 'same-version pending state cleanup', 1200);
    await waitForFileRemoval(requestDir, 'one-shot local reinstall request cleanup', 1200);
    if (fs.existsSync(prepared.backupDir) || fs.existsSync(prepared.stagingDir)) {
      throw new Error(`Atomic swap did not clean its staging/rollback directories: ${JSON.stringify({ stagingDir: prepared.stagingDir, backupDir: prepared.backupDir })}`);
    }
  } else {
    await evaluate(playerClient, `document.querySelector('#launcherUpdateNowButton').click()`);
    const swapping = await waitForJson(pendingPath, 'test-only helper start', {
      predicate: (value) => value?.status === 'swapping'
    });
    if (swapping.purpose !== 'local-reinstall-test') throw new Error(`Test helper lost local reinstall purpose: ${JSON.stringify(swapping)}`);
  }

  if (await sha256File(uninstallerPath) !== uninstallerSha256Before
      || !fs.existsSync(targetExe)) {
    throw new Error('The real local reinstall changed installer-owned uninstaller bytes or lost the regular launcher executable.');
  }
  await assertFileIdentityUnchanged(regularConfigPath, regularConfigIdentityBeforeAction, 'Final local reinstall state');
  assertNoFeedRequests('Completed developer-to-regular local reinstall');

  console.log(JSON.stringify({
    ok: true,
    packagedDeveloper: hasSmokeExe,
    fullTransaction,
    version,
    proof: {
      wrongPasswordToastMs,
      loginSuccessToastMs,
      fixedInboxOneShot: true,
      developerExitedAtPromptReady: true,
      regularPrompt: prompt.title,
      noDeveloperApi: true,
      noPrivateUpdateStatus: true,
      noLiveFeedRequests: feedRequests.length === 0,
      feedRequestCount: feedRequests.length,
      realStagingStrategy: prepared.strategy,
      stagedTreeSha256: stagedTree.treeSha256,
      installedUntouchedBeforeRestart: true,
      regularConfigShaMtimeIdentityPreserved: true,
      relaunchDeveloper: prepared.relaunchDeveloper,
      ...(fullTransaction ? {
        acknowledgedPlayerMode: true,
        committedStagedSwap: true,
        commitBeforeBackupCleanup: true,
        installedTreeMatchesReceipt: true,
        stagingAndBackupLifecycleObserved: true,
        helperLogProvedSwap: true,
        pendingCleared: true,
        requestCleaned: true,
        backupCleaned: true,
        uninstallerPreserved: true
      } : {})
    }
  }, null, 2));
} finally {
  swapLifecycleAbortController?.abort();
  if (developerClient) {
    await developerClient.call('Browser.close').catch(() => {});
    developerClient.close();
  }
  if (playerClient) {
    await playerClient.call('Browser.close').catch(() => {});
    playerClient.close();
  }
  if (developerChild && developerChild.exitCode === null) developerChild.kill();
  if (relaunchedPlayerPid > 0) {
    try { process.kill(relaunchedPlayerPid); } catch {}
  }
  await stopProcessesUnder(root);
  await closeServer(feedServer);
  await sleep(400);
  if (preserveSmokeRoot) {
    console.error(`Preserved developer reinstall smoke root: ${root}`);
  } else {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
