import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildWindowsMinecraftProcessSnapshotPowerShell,
  isWindowsStoreMinecraftLauncherPath,
  windowsLauncherRecordHasUsableWindow,
  windowsLauncherRecordIdentity,
  windowsLauncherRecordMatchesAllowedPath,
  windowsLauncherRecordMatchesTarget,
  windowsLauncherTaskkillArgs
} from '../src/windowsMinecraftLauncher.js';

const curseForgeLauncher = 'C:\\Users\\Player\\curseforge\\minecraft\\Install\\minecraft.exe';
const desktopLauncher = 'C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe';
const storeLauncher = 'C:\\Program Files\\WindowsApps\\Microsoft.4297127D64EC6_1.0.0.0_x64__8wekyb3d8bbwe\\Minecraft.exe';
const storeRoot = path.win32.dirname(storeLauncher);
const xboxRoot = 'D:\\XboxGames\\Minecraft Launcher\\Content';
const xboxLauncher = path.win32.join(xboxRoot, 'minecraft.exe');
const storeRoots = [storeRoot, xboxRoot];
const base = {
  pid: 42001,
  image: 'minecraft.exe',
  path: curseForgeLauncher,
  sessionId: 4,
  startTimeUtc: '2026-08-03T12:00:00.0000000Z',
  mainWindowHandle: 52001,
  mainWindowTitle: 'Minecraft Launcher',
  responding: true,
  windowVisible: true,
  windowMinimized: false
};

if (!windowsLauncherRecordMatchesAllowedPath(base, {
  allowedPaths: [curseForgeLauncher, desktopLauncher],
  sessionId: 4,
  storeRoots,
  allowStore: true
})) {
  throw new Error('Exact CurseForge launcher path was not trusted.');
}
const unicodeLauncher = 'C:\\Users\\玩家-é\\curseforge\\minecraft\\Install\\minecraft.exe';
if (!windowsLauncherRecordMatchesAllowedPath({ ...base, path: unicodeLauncher }, {
  allowedPaths: [unicodeLauncher],
  sessionId: 4,
  storeRoots,
  allowStore: true
})) {
  throw new Error('A non-ASCII Windows launcher path was corrupted or rejected.');
}
for (const rejected of [
  { ...base, pid: 42002, path: 'D:\\Unrelated\\minecraft.exe' },
  { ...base, pid: 42005, path: 'C:\\Users\\Player\\WindowsApps\\Microsoft.4297127D64EC6_fake\\minecraft.exe' },
  { ...base, pid: 42003, sessionId: 9 },
  { ...base, pid: 42004, path: '' }
]) {
  if (windowsLauncherRecordMatchesAllowedPath(rejected, {
    allowedPaths: [curseForgeLauncher, desktopLauncher],
    sessionId: 4,
    storeRoots,
    allowStore: true
  })) {
    throw new Error(`Unverified launcher record was trusted: ${JSON.stringify(rejected)}`);
  }
}

const storeRecord = { ...base, pid: 43001, path: storeLauncher };
const xboxRecord = { ...base, pid: 43003, path: xboxLauncher };
const storeBootstrap = {
  ...storeRecord,
  pid: 43002,
  image: 'GameLaunchHelper.exe',
  mainWindowHandle: 0,
  mainWindowTitle: ''
};
if (
  !isWindowsStoreMinecraftLauncherPath(storeLauncher, storeRoots)
  || !isWindowsStoreMinecraftLauncherPath(xboxLauncher, storeRoots)
  || !windowsLauncherRecordMatchesAllowedPath(storeRecord, { allowedPaths: [], sessionId: 4, storeRoots, allowStore: true })
  || !windowsLauncherRecordMatchesAllowedPath(xboxRecord, { allowedPaths: [], sessionId: 4, storeRoots, allowStore: true })
  || !windowsLauncherRecordMatchesTarget(storeRecord, { kind: 'store', sessionId: 4, storeRoots })
  || !windowsLauncherRecordMatchesTarget(xboxRecord, { kind: 'store', sessionId: 4, storeRoots })
  || windowsLauncherRecordMatchesTarget(storeBootstrap, { kind: 'store', sessionId: 4, storeRoots })
  || windowsLauncherRecordHasUsableWindow(storeBootstrap)
) {
  throw new Error('Store bootstrap and persistent-window discrimination failed.');
}

if (
  !windowsLauncherRecordMatchesTarget(base, { kind: 'root', executablePath: curseForgeLauncher, sessionId: 4 })
  || windowsLauncherRecordMatchesTarget({ ...base, path: desktopLauncher }, { kind: 'root', executablePath: curseForgeLauncher, sessionId: 4 })
  || !windowsLauncherRecordHasUsableWindow(base)
  || windowsLauncherRecordHasUsableWindow({ ...base, mainWindowHandle: 0 })
  || windowsLauncherRecordHasUsableWindow({ ...base, responding: false })
) {
  throw new Error('Exact route or responsive-window matching failed.');
}

if (
  windowsLauncherRecordIdentity(base) === windowsLauncherRecordIdentity({ ...base, pid: base.pid + 1 })
  || windowsLauncherRecordIdentity(base) === windowsLauncherRecordIdentity({ ...base, startTimeUtc: '2026-08-03T12:01:00.0000000Z' })
  || windowsLauncherRecordIdentity(base) !== windowsLauncherRecordIdentity({ ...base, mainWindowHandle: base.mainWindowHandle + 1 })
) {
  throw new Error('Immutable PID/path/session/start-time identity was not enforced.');
}
const taskkillArgs = windowsLauncherTaskkillArgs(base);
if (
  JSON.stringify(taskkillArgs) !== JSON.stringify(['/PID', String(base.pid)])
  || taskkillArgs.some((arg) => ['/F', '/T', '/IM'].includes(String(arg).toUpperCase()))
) {
  throw new Error(`Launcher termination is not exact-PID and non-forceful: ${JSON.stringify(taskkillArgs)}`);
}

let productionSnapshot = null;
if (process.platform === 'win32') {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = buildWindowsMinecraftProcessSnapshotPowerShell();
  if (!script.includes('UTF8Encoding') || !script.includes("$ProgressPreference = 'SilentlyContinue'")) {
    throw new Error('Production snapshot script does not force quiet UTF-8 output.');
  }
  for (const guardedRead of [
    'try { $executablePath = $process.Path } catch { $readFailed = $true }',
    "try { $startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o') } catch { $readFailed = $true }",
    'try { $sessionId = [int]$process.SessionId } catch { $readFailed = $true }',
    'try { $handle = [int64]$process.MainWindowHandle } catch { $readFailed = $true }',
    'try { $windowTitle = [string]$process.MainWindowTitle } catch { $readFailed = $true }',
    'try { $responding = [bool]$process.Responding } catch { $readFailed = $true }'
  ]) {
    if (!script.includes(guardedRead)) {
      throw new Error(`Production snapshot is missing guarded process read: ${guardedRead}`);
    }
  }
  if (!script.includes('Get-Process -Id $processId -ErrorAction SilentlyContinue')) {
    throw new Error('Production snapshot does not distinguish an exited PID from a still-running unreadable process.');
  }
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const captured = await new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || stdout || `PowerShell exited ${code}`)));
  });
  if (captured.stderr.trim()) {
    throw new Error(`Production snapshot wrote unexpected stderr/CLIXML: ${captured.stderr}`);
  }
  productionSnapshot = JSON.parse(captured.stdout.trim());
  if (!Number.isInteger(productionSnapshot.currentSessionId) || !Array.isArray(productionSnapshot.records) || !Array.isArray(productionSnapshot.packageRoots)) {
    throw new Error(`Production snapshot shape is invalid: ${captured.stdout}`);
  }
}

const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
const packageLock = JSON.parse(await fs.readFile(path.resolve('package-lock.json'), 'utf8'));
if (packageJson.version !== packageLock.version || packageJson.version !== packageLock.packages?.['']?.version) {
  throw new Error(`Release metadata versions are inconsistent: package=${packageJson.version}, lock=${packageLock.version}, root=${packageLock.packages?.['']?.version}`);
}

console.log(JSON.stringify({
  ok: true,
  version: packageJson.version,
  exactPidScopedPath: curseForgeLauncher,
  taskkillArgs,
  storeBootstrapRejected: true,
  xboxRegisteredRootAccepted: true,
  productionSnapshotParsed: Boolean(productionSnapshot),
  responsiveWindowRequired: true
}, null, 2));
