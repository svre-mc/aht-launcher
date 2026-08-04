import path from 'node:path';

export const WINDOWS_MINECRAFT_LAUNCHER_IMAGES = Object.freeze([
  'minecraft.exe',
  'minecraftlauncher.exe',
  'gamelaunchhelper.exe'
]);

function pathKey(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return path.win32.normalize(text).replace(/[\\/]+$/, '').toLowerCase();
}

export function normalizeWindowsLauncherRecord(record = {}) {
  const image = String(record.image || record.name || '').trim().toLowerCase();
  const executablePath = String(record.path || record.executablePath || '').trim();
  return {
    pid: Number(record.pid) || 0,
    image,
    path: executablePath,
    pathKey: pathKey(executablePath),
    sessionId: Number.isFinite(Number(record.sessionId)) ? Number(record.sessionId) : -1,
    startTimeUtc: String(record.startTimeUtc || '').trim(),
    mainWindowHandle: Number(record.mainWindowHandle) || 0,
    mainWindowTitle: String(record.mainWindowTitle || '').trim(),
    responding: record.responding !== false,
    windowVisible: record.windowVisible !== false,
    windowMinimized: record.windowMinimized === true,
    foreground: record.foreground === true
  };
}

export function isKnownWindowsMinecraftLauncher(record = {}) {
  const normalized = normalizeWindowsLauncherRecord(record);
  return WINDOWS_MINECRAFT_LAUNCHER_IMAGES.includes(normalized.image);
}

export function isWindowsStoreMinecraftLauncherPath(value = '', packageRoots = []) {
  const normalized = pathKey(value);
  return Boolean(normalized && packageRoots.some((root) => {
    const rootKey = pathKey(root);
    return rootKey && (normalized === rootKey || normalized.startsWith(`${rootKey}\\`));
  }));
}

export function windowsLauncherRecordMatchesAllowedPath(record = {}, options = {}) {
  const normalized = normalizeWindowsLauncherRecord(record);
  if (!normalized.pid || !WINDOWS_MINECRAFT_LAUNCHER_IMAGES.includes(normalized.image)) return false;
  if (Number.isFinite(Number(options.sessionId)) && normalized.sessionId !== Number(options.sessionId)) return false;
  if (!normalized.pathKey) return false;
  const allowedPaths = new Set((options.allowedPaths || []).map(pathKey).filter(Boolean));
  return allowedPaths.has(normalized.pathKey)
    || (options.allowStore !== false && isWindowsStoreMinecraftLauncherPath(normalized.path, options.storeRoots || []));
}

export function windowsLauncherRecordMatchesTarget(record = {}, target = {}) {
  const normalized = normalizeWindowsLauncherRecord(record);
  if (!normalized.pid || !WINDOWS_MINECRAFT_LAUNCHER_IMAGES.includes(normalized.image)) return false;
  if (Number.isFinite(Number(target.sessionId)) && normalized.sessionId !== Number(target.sessionId)) return false;
  if (target.kind === 'store') {
    return normalized.image !== 'gamelaunchhelper.exe'
      && isWindowsStoreMinecraftLauncherPath(normalized.path, target.storeRoots || []);
  }
  const expectedPath = pathKey(target.executablePath);
  return Boolean(expectedPath && normalized.pathKey === expectedPath);
}

export function windowsLauncherRecordHasUsableWindow(record = {}) {
  const normalized = normalizeWindowsLauncherRecord(record);
  return normalized.image !== 'gamelaunchhelper.exe'
    && normalized.mainWindowHandle > 0
    && normalized.responding;
}

export function windowsLauncherRecordIdentity(record = {}) {
  const normalized = normalizeWindowsLauncherRecord(record);
  return `${normalized.pid}|${normalized.image}|${normalized.pathKey}|${normalized.sessionId}|${normalized.startTimeUtc}`;
}

export function windowsLauncherWindowIdentity(record = {}) {
  const normalized = normalizeWindowsLauncherRecord(record);
  return `${windowsLauncherRecordIdentity(normalized)}|${normalized.mainWindowHandle}`;
}

export function windowsLauncherTaskkillArgs(record = {}) {
  const normalized = normalizeWindowsLauncherRecord(record);
  if (!Number.isInteger(normalized.pid) || normalized.pid <= 0) {
    throw new Error('A valid launcher PID is required.');
  }
  return ['/PID', String(normalized.pid)];
}

export function buildWindowsMinecraftProcessSnapshotPowerShell(options = {}) {
  const requestedProcessNames = Array.isArray(options.processNames) && options.processNames.length
    ? options.processNames
    : WINDOWS_MINECRAFT_LAUNCHER_IMAGES;
  const processNames = requestedProcessNames
    .map((image) => path.win32.basename(String(image || ''), '.exe'))
    .filter(Boolean)
    .filter((name, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === name.toLowerCase()) === index)
    .map((name) => `'${name.replaceAll("'", "''")}'`)
    .join(',');
  const packageRootLines = options.includeStoreRoots === false
    ? ['$packageRoots = @()']
    : [
      '$packageRoots = @()',
      "foreach ($package in @(Get-AppxPackage -Name 'Microsoft.4297127D64EC6' -ErrorAction SilentlyContinue)) {",
      '  if ($package.InstallLocation) { $packageRoots += [System.IO.Path]::GetFullPath([string]$package.InstallLocation) }',
      '}',
      '$packageRoots = @($packageRoots | Sort-Object -Unique)'
    ];
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::OutputEncoding = $utf8',
    '$OutputEncoding = $utf8',
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class AhtWindowProbe {',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '}',
    "'@",
    '$currentSessionId = (Get-Process -Id $PID).SessionId',
    ...packageRootLines,
    `$names = @(${processNames})`,
    '$foregroundHandle = [AhtWindowProbe]::GetForegroundWindow()',
    '$records = @()',
    'foreach ($name in $names) {',
    '  foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {',
    '    try { $processId = [int]$process.Id } catch { continue }',
    '    $readFailed = $false',
    "    $executablePath = ''",
    "    $startTimeUtc = ''",
    '    $sessionId = -1',
    '    $handle = [int64]0',
    "    $windowTitle = ''",
    '    $responding = $false',
    '    try { $executablePath = $process.Path } catch { $readFailed = $true }',
    "    try { $startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o') } catch { $readFailed = $true }",
    '    try { $sessionId = [int]$process.SessionId } catch { $readFailed = $true }',
    '    try { $handle = [int64]$process.MainWindowHandle } catch { $readFailed = $true }',
    '    try { $windowTitle = [string]$process.MainWindowTitle } catch { $readFailed = $true }',
    '    try { $responding = [bool]$process.Responding } catch { $readFailed = $true }',
    '    if ($readFailed -and $null -eq (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { continue }',
    '    $records += [pscustomobject]@{',
    '      pid = $processId',
    "      image = ($name + '.exe').ToLowerInvariant()",
    '      path = [string]$executablePath',
    '      sessionId = $sessionId',
    '      startTimeUtc = [string]$startTimeUtc',
    '      mainWindowHandle = $handle',
    '      mainWindowTitle = $windowTitle',
    '      responding = $responding',
    '      windowVisible = [bool]($handle -ne 0 -and [AhtWindowProbe]::IsWindowVisible([IntPtr]$handle))',
    '      windowMinimized = [bool]($handle -ne 0 -and [AhtWindowProbe]::IsIconic([IntPtr]$handle))',
    '      foreground = [bool]($handle -ne 0 -and [IntPtr]$handle -eq $foregroundHandle)',
    '    }',
    '  }',
    '}',
    '[pscustomobject]@{ currentSessionId = [int]$currentSessionId; packageRoots = @($packageRoots); records = @($records) } | ConvertTo-Json -Depth 4 -Compress'
  ].join('\n');
}
