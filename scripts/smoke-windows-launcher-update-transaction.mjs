import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  stageWindowsLauncherUpdate,
  validateStagedWindowsLauncherUpdate,
  versionMatches
} from '../src/launcherUpdateStaging.js';

const execFileAsync = promisify(execFile);
const PACKAGED_PRODUCTION_UPDATE_SMOKE = true;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const expectedVersion = String(packageJson.version || '').trim();
const transactionMode = String(process.env.AHT_TRANSACTION_MODE || 'version-upgrade').trim().toLowerCase();
const sameVersionDeveloperReinstall = transactionMode === 'same-version-developer-reinstall';
const targetExeName = 'A Hard Time Launcher Windows.exe';
const installedDir = path.resolve(process.env.AHT_TRANSACTION_INSTALLED_DIR
  || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'A Hard Time Launcher Windows'));
const archivePath = path.resolve(process.env.AHT_TRANSACTION_UPDATE_ZIP
  || path.join(repoRoot, 'release-builds', 'windows', `AHT-Launcher-Windows-10-11-${expectedVersion}.zip`));
const helperSourcePath = path.join(repoRoot, 'desktop', 'launcher-update-helper.ps1');
const bootstrapSourcePath = path.join(repoRoot, 'desktop', 'launcher-update-bootstrap.ps1');
const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

if (process.platform !== 'win32') {
  console.log(JSON.stringify({ ok: true, skipped: 'Windows-only packaged updater transaction smoke' }, null, 2));
  process.exit(0);
}

if (!PACKAGED_PRODUCTION_UPDATE_SMOKE) throw new Error('Packaged update smoke marker is disabled.');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readProductVersion(filePath) {
  const script = "$item = Get-Item -LiteralPath $env:AHT_VERSION_TARGET; [Console]::Out.Write([string]$item.VersionInfo.ProductVersion)";
  const result = await execFileAsync(powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], {
    windowsHide: true,
    env: { ...process.env, AHT_VERSION_TARGET: filePath },
    timeout: 15_000
  });
  return String(result.stdout || '').trim();
}

async function waitForText(filePath, predicate, label, timeoutMs = 90_000) {
  const started = Date.now();
  let latest = '';
  while (Date.now() - started < timeoutMs) {
    latest = await fs.readFile(filePath, 'utf8').catch(() => '');
    if (predicate(latest)) return latest;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}. Latest log: ${latest.slice(-2000)}`);
}

async function waitForJson(filePath, label, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${filePath}`);
}

async function waitForBackupCleanup(filePath, statusPath, processId, timeoutMs = 60_000) {
  const started = Date.now();
  let latestStatus = null;
  let lastProcessCheck = 0;
  while (Date.now() - started < timeoutMs) {
    latestStatus = await fs.readFile(statusPath, 'utf8').then((value) => JSON.parse(value)).catch(() => latestStatus);
    if (latestStatus?.status === 'failed') {
      throw new Error(`Updated launcher backup cleanup failed: ${JSON.stringify(latestStatus)}`);
    }
    if (!(await fs.lstat(filePath).catch(() => null))) return latestStatus;
    if (Date.now() - lastProcessCheck > 1000) {
      lastProcessCheck = Date.now();
      const proof = await processProof(processId);
      if (!proof.processId) throw new Error(`Updated launcher exited before backup cleanup finished: ${JSON.stringify(latestStatus)}`);
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for rollback backup cleanup: ${filePath}. Status: ${JSON.stringify(latestStatus)}`);
}

async function processProof(processId) {
  const script = [
    '$process = Get-Process -Id ([int]$env:AHT_PROCESS_ID) -ErrorAction SilentlyContinue',
    'if (-not $process) { [Console]::Out.Write("{}"); exit 0 }',
    '$path = ""; try { $path = [string]$process.Path } catch {}',
    '[pscustomobject]@{ processId=$process.Id; path=$path; mainWindowHandle=[int64]$process.MainWindowHandle; mainWindowTitle=[string]$process.MainWindowTitle } | ConvertTo-Json -Compress'
  ].join('; ');
  const result = await execFileAsync(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, AHT_PROCESS_ID: String(processId) },
    timeout: 10_000
  });
  return JSON.parse(String(result.stdout || '{}').trim() || '{}');
}

async function waitForVisibleWindow(processId, timeoutMs = 30_000) {
  const started = Date.now();
  let proof = {};
  while (Date.now() - started < timeoutMs) {
    proof = await processProof(processId);
    if (Number(proof.mainWindowHandle || 0) !== 0) return proof;
    await sleep(100);
  }
  throw new Error(`Updated launcher PID ${processId} did not expose a visible window. Last proof: ${JSON.stringify(proof)}`);
}

async function stopProcessesUnder(root) {
  const script = [
    '$root = [System.IO.Path]::GetFullPath($env:AHT_PROCESS_ROOT).TrimEnd("\\") + "\\"',
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath([string]$_.ExecutablePath)).StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }'
  ].join('; ');
  await execFileAsync(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, AHT_PROCESS_ROOT: root },
    timeout: 15_000
  }).catch(() => {});
}

const nonce = crypto.randomBytes(16).toString('hex');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-launcher-update-transaction-'));
const resolvedTempBase = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
if (!`${path.resolve(tempRoot)}${path.sep}`.toLowerCase().startsWith(resolvedTempBase)) {
  throw new Error(`Refusing unsafe transaction smoke root: ${tempRoot}`);
}

const installDir = path.join(tempRoot, 'A Hard Time Launcher Windows');
const stagingDir = path.join(tempRoot, `.aht-launcher-update-${expectedVersion}-${nonce}`);
const extractRoot = path.join(tempRoot, `.aht-launcher-extract-${expectedVersion}-${nonce}`);
const backupDir = path.join(tempRoot, `.aht-launcher-backup-old-${nonce}`);
const failedCandidateDir = path.join(tempRoot, `.aht-launcher-failed-${expectedVersion}-${nonce}`);
const userDataDir = path.join(tempRoot, 'user-data');
const handoffDir = path.join(userDataDir, 'launcher-updates', expectedVersion, 'handoff');
const pendingPath = path.join(userDataDir, 'launcher-updates', 'pending-launcher-update.json');
const pendingFailurePath = path.join(userDataDir, 'launcher-updates', 'pending-launcher-update.failed');
const receiptPath = path.join(handoffDir, `receipt-${nonce}.json`);
const payloadPath = path.join(handoffDir, `payload-${nonce}.json`);
const helperPath = path.join(handoffDir, `apply-launcher-update-${nonce}.ps1`);
const bootstrapPath = path.join(handoffDir, `start-launcher-update-${nonce}.ps1`);
const logPath = path.join(handoffDir, `handoff-${nonce}.log`);
const bootstrapLogPath = path.join(handoffDir, `bootstrap-${nonce}.log`);
const ackPath = path.join(handoffDir, `ready-${nonce}.json`);
const cleanupStatusPath = `${ackPath}.cleanup.json`;
const sentinelPath = path.join(userDataDir, 'update-identity-sentinel.json');
let logText = '';

try {
  for (const required of [archivePath, path.join(installedDir, targetExeName), helperSourcePath, bootstrapSourcePath]) {
    const stat = await fs.stat(required).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Required transaction input is missing: ${required}`);
  }

  await fs.cp(installedDir, installDir, { recursive: true, force: false, errorOnExist: true });
  await fs.mkdir(handoffDir, { recursive: true });
  await writeJson(sentinelPath, { identity: 'preserve-across-update', nonce });
  const sentinelSha256 = await sha256File(sentinelPath);
  const archiveSha256 = await sha256File(archivePath);
  const oldExePath = path.join(installDir, targetExeName);
  const oldVersion = await readProductVersion(oldExePath);
  const oldExeSha256 = await sha256File(oldExePath);
  const oldUninstallerPath = path.join(installDir, 'Uninstall A Hard Time Launcher Windows.exe');
  const oldUninstallerSha256 = await sha256File(oldUninstallerPath);
  if (!oldVersion || (sameVersionDeveloperReinstall
    ? !versionMatches(oldVersion, expectedVersion)
    : versionMatches(oldVersion, expectedVersion))) {
    throw new Error(sameVersionDeveloperReinstall
      ? `Developer reinstall transaction requires the same launcher version; found ${oldVersion || 'unknown'}, expected ${expectedVersion}.`
      : `Transaction smoke requires an older installed launcher; found ${oldVersion || 'unknown'}.`);
  }

  const staged = await stageWindowsLauncherUpdate({
    archivePath,
    archiveSha256,
    installDir,
    stagingDir,
    extractRoot,
    targetExeName,
    expectedVersion,
    readProductVersion
  });
  await validateStagedWindowsLauncherUpdate({
    stagingDir,
    receipt: staged.receipt,
    expectedVersion,
    readProductVersion,
    verifyHashes: true
  });
  await writeJson(receiptPath, staged.receipt);
  const receiptSha256 = await sha256File(receiptPath);
  await Promise.all([
    fs.copyFile(helperSourcePath, helperPath),
    fs.copyFile(bootstrapSourcePath, bootstrapPath)
  ]);

  const payload = {
    mode: 'staged-swap',
    handoffNonce: nonce,
    oldPid: 0,
    installDir,
    stagingDir,
    backupDir,
    failedCandidateDir,
    targetRelativePath: targetExeName,
    expectedVersion,
    receiptPath,
    receiptSha256,
    treeSha256: staged.receipt.treeSha256,
    logPath,
    ackPath,
    pendingPath,
    pendingFailurePath,
    relaunchArgs: [
      ...(sameVersionDeveloperReinstall ? ['--developer'] : []),
      `--user-data-dir=${userDataDir}`
    ],
    relaunchDeveloper: sameVersionDeveloperReinstall,
    testStartOnly: false,
    createdAt: new Date().toISOString()
  };
  await writeJson(payloadPath, payload);
  const payloadSha256 = await sha256File(payloadPath);
  const scriptSha256 = await sha256File(helperPath);
  const bootstrapScriptSha256 = await sha256File(bootstrapPath);
  const preparedRestart = {
    strategy: 'windows-staged-helper',
    mode: payload.mode,
    helperDir: handoffDir,
    payloadPath,
    payloadSha256,
    scriptPath: helperPath,
    scriptSha256,
    bootstrapScriptPath: bootstrapPath,
    bootstrapScriptSha256,
    logPath,
    bootstrapLogPath,
    ackPath,
    pendingPath,
    pendingFailurePath,
    handoffNonce: nonce,
    relaunchDeveloper: sameVersionDeveloperReinstall,
    expectedVersion,
    installDir,
    stagingDir,
    backupDir,
    failedCandidateDir,
    targetRelativePath: targetExeName,
    receiptPath,
    receiptSha256,
    treeSha256: staged.receipt.treeSha256
  };
  await writeJson(pendingPath, {
    schemaVersion: 2,
    product: 'aht-launcher',
    status: 'swapping',
    ...(sameVersionDeveloperReinstall ? { purpose: 'developer-reinstall' } : {}),
    version: expectedVersion,
    downloadedPath: archivePath,
    artifact: { size: (await fs.stat(archivePath)).size, sha256: archiveSha256 },
    installingStartedAt: new Date().toISOString(),
    preparedRestart
  });

  const helperStartedAt = Date.now();
  await execFileAsync(powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    bootstrapPath,
    '-HelperPath',
    helperPath,
    '-PayloadPath',
    payloadPath,
    '-ExpectedPayloadSha256',
    payloadSha256,
    '-ExpectedHelperSha256',
    scriptSha256
  ], {
    windowsHide: true,
    timeout: 20_000,
    env: { ...process.env, AHT_ALLOW_DEVELOPER: '' }
  });

  logText = await waitForText(logPath, (text) => text.toLowerCase().includes(`ready to quit nonce=${nonce}`.toLowerCase()), 'verified ready-to-quit handoff');
  const readyLine = logText.split(/\r?\n/).find((line) => line.toLowerCase().includes(`ready to quit nonce=${nonce}`.toLowerCase()));
  const readyAt = Date.parse(String(readyLine || '').split(' ')[0]);
  const ack = await waitForJson(ackPath, 'updated launcher window acknowledgement');
  if (sameVersionDeveloperReinstall && ack.developerMode !== true) {
    throw new Error('Same-version reinstall relaunched without authenticated Developer Mode allowance.');
  }
  if (ack.handoffNonce !== nonce || !versionMatches(ack.version, expectedVersion) || !Number(ack.processId)) {
    throw new Error(`Invalid updated launcher acknowledgement: ${JSON.stringify(ack)}`);
  }
  const windowProof = await waitForVisibleWindow(Number(ack.processId));
  logText = await waitForText(logPath, (text) => text.includes('Launcher update handoff complete.'), 'completed handoff');
  const backupCleanup = await waitForBackupCleanup(backupDir, cleanupStatusPath, Number(ack.processId));

  const newExePath = path.join(installDir, targetExeName);
  const newVersion = await readProductVersion(newExePath);
  const newExeSha256 = await sha256File(newExePath);
  const expectedExeReceipt = staged.receipt.files.find((entry) => entry.path.toLowerCase() === targetExeName.toLowerCase());
  if (!versionMatches(newVersion, expectedVersion) || newExeSha256 !== expectedExeReceipt?.sha256) {
    throw new Error(`Swapped launcher does not match staged receipt: version=${newVersion}, sha256=${newExeSha256}`);
  }
  if (await fs.stat(stagingDir).catch(() => null)) throw new Error('Staging directory still exists after atomic swap.');
  if (await fs.stat(pendingPath).catch(() => null)) throw new Error('Pending update was not cleared after acknowledged startup.');
  if (await fs.stat(pendingFailurePath).catch(() => null)) throw new Error('Update helper wrote an unexpected failure marker.');
  if (await sha256File(sentinelPath) !== sentinelSha256) throw new Error('User-data identity sentinel changed during update.');
  if (await sha256File(path.join(installDir, 'Uninstall A Hard Time Launcher Windows.exe')) !== oldUninstallerSha256) {
    throw new Error('Installer-owned uninstaller was not preserved byte-for-byte.');
  }
  const helperSource = await fs.readFile(helperPath, 'utf8');
  const bootstrapSource = await fs.readFile(bootstrapPath, 'utf8');
  if (/\bcmd(?:\.exe)?\b|\.cmd\b/i.test(`${helperSource}\n${bootstrapSource}`)) {
    throw new Error('Windows update handoff contains a cmd.exe or batch-file path.');
  }

  const windowReadyAt = Date.parse(String(ack.windowReadyAt || ''));
  const closeToWindowReadyMs = Number.isFinite(readyAt) && Number.isFinite(windowReadyAt)
    ? Math.max(0, windowReadyAt - readyAt)
    : null;
  console.log(JSON.stringify({
    ok: true,
    transactionMode,
    oldVersion,
    expectedVersion,
    oldExeSha256,
    newExeSha256,
    archiveSha256,
    stagedFileCount: staged.receipt.fileCount,
    stagedTreeSha256: staged.receipt.treeSha256,
    helperPreflightMs: Number.isFinite(readyAt) ? Math.max(0, readyAt - helperStartedAt) : null,
    closeToWindowReadyMs,
    updatedProcessId: ack.processId,
    visibleWindow: windowProof,
    uninstallerPreserved: true,
    userDataPreserved: true,
    noCmdHandoff: true,
    backupCleanup
  }, null, 2));
} catch (error) {
  logText = logText || await fs.readFile(logPath, 'utf8').catch(() => '');
  throw new Error(`${error.message || String(error)}${logText ? `\nHelper log:\n${logText}` : ''}`);
} finally {
  await stopProcessesUnder(installDir);
  await stopProcessesUnder(stagingDir);
  await sleep(500);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
