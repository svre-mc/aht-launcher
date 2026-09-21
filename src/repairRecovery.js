import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const permissionCodes = new Set(['EACCES', 'EPERM']);
function causes(error) {
  const result = [];
  for (let current = error; current && result.length < 6 && !result.includes(current); current = current.cause) result.push(current);
  return result;
}
export function repairNetworkFailure(error) {
  return causes(error).some(item => ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK'].includes(item.code)
    || /fetch failed|network request failed|network connection|socket hang up/i.test(item.message || ''));
}
const within = (root, target) => target === root || target.startsWith(root + path.sep);

// Never elevate a whole launcher or recursively replace ownership/ACLs. Limit
// the grant to the denied object inside a configured game/runtime directory.
export async function repairPermissionTarget(error, roots = []) {
  const denied = causes(error).find(item => permissionCodes.has(item.code) && path.isAbsolute(item.path || ''));
  if (!denied) return null;
  const requested = path.resolve(denied.path);
  const protectedRoots = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
    process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).map(value => path.resolve(value).toLowerCase());
  const root = roots.filter(Boolean).map(value => path.resolve(value)).find(value => {
    const lower = value.toLowerCase();
    return value !== path.parse(value).root && !protectedRoots.some(protectedRoot => within(lower, protectedRoot))
      && !(process.env.SystemRoot && within(path.resolve(process.env.SystemRoot).toLowerCase(), lower))
      && within(lower, requested.toLowerCase());
  });
  if (!root) return null;
  let target = requested;
  let create = false;
  while (true) {
    try { await fs.lstat(target); break; }
    catch (failure) {
      if (failure.code !== 'ENOENT') return null;
      if (target.toLowerCase() === root.toLowerCase()) { create = true; break; }
      target = path.dirname(target);
    }
  }
  for (let current = target; ; current = path.dirname(current)) {
    let stat;
    try { stat = await fs.lstat(current); }
    catch (failure) { if (!create || failure.code !== 'ENOENT') return null; }
    if (stat?.isSymbolicLink()) return null;
    if (current === path.parse(current).root) break;
  }
  if (create) return { root, target, create: true };
  // A sharing violation is common on Windows. If this directory is writable,
  // UAC cannot resolve it and must not invite unnecessary permission changes.
  const stat = await fs.stat(target);
  if (!stat.isDirectory() && stat.nlink > 1) return null;
  if (stat.isDirectory()) {
    const probe = path.join(target, `.aht-write-probe-${crypto.randomUUID()}`);
    try {
      const handle = await fs.open(probe, 'wx');
      await handle.close();
      await fs.unlink(probe);
      return null;
    } catch (failure) {
      if (!permissionCodes.has(failure.code)) return null;
    }
  } else {
    try { const handle = await fs.open(target, 'r+'); await handle.close(); return null; }
    catch (failure) { if (!permissionCodes.has(failure.code)) return null; }
  }
  return { root, target };
}

export function permissionGrantScript({ root, target, sid, create = false }) {
  if (!/^S-1-(?:\d+-){1,14}\d+$/.test(sid || '')) throw new Error('Windows user identity is unavailable.');
  const encoded = Buffer.from(JSON.stringify({ root, target, sid, create }), 'utf8').toString('base64');
  return `$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($job.root).TrimEnd('\\')
$target = [IO.Path]::GetFullPath($job.target)
if ($root.Length -lt 4 -or ($target -ine $root -and -not $target.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase))) { exit 3 }
if ($root -ieq $env:SystemRoot -or $target.StartsWith($env:SystemRoot + '\\', [StringComparison]::OrdinalIgnoreCase)) { exit 3 }
for ($ancestor = $target; $ancestor; $ancestor = [IO.Path]::GetDirectoryName($ancestor)) {
  if (Test-Path -LiteralPath $ancestor) {
    $checked = Get-Item -LiteralPath $ancestor -Force
    if (($checked.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 3 }
  }
  if ($ancestor -eq [IO.Path]::GetPathRoot($ancestor)) { break }
}
if ($job.create -and -not (Test-Path -LiteralPath $target)) { [void][IO.Directory]::CreateDirectory($target) }
$item = Get-Item -LiteralPath $target -Force
if (-not $item.PSIsContainer -and $item.LinkType -eq 'HardLink') { exit 3 }
if ($item.PSIsContainer) {
  $pending = [Collections.Generic.Queue[string]]::new()
  $pending.Enqueue($target)
  $count = 0
  while ($pending.Count -gt 0) {
    foreach ($child in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
      $count++
      if ($count -gt 50000 -or ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $child.LinkType -eq 'HardLink') { exit 3 }
      if ($child.PSIsContainer) { $pending.Enqueue($child.FullName) }
    }
  }
}
for ($current = $item; $null -ne $current; $current = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($current.FullName)) -Force) {
  if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 3 }
  if ($current.FullName -eq [IO.Path]::GetPathRoot($current.FullName)) { break }
}
$sid = [Security.Principal.SecurityIdentifier]::new($job.sid)
$acl = Get-Acl -LiteralPath $target
$inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Modify, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
exit 0`;
}

export async function elevateRepairPermission(target) {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const { stdout } = await execute(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000 });
  const sid = stdout.match(/S-1-(?:\d+-){1,14}\d+/)?.[0];
  const command = Buffer.from(permissionGrantScript({ ...target, sid }), 'utf16le').toString('base64');
  const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // EncodedCommand carries a fixed, bounded operation with paths encoded as JSON
  // data. Nothing is read from an editable elevated job/script on disk.
  const wrapper = `$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME 'Modules'; try { $p = Start-Process -FilePath '${powershell.replaceAll("'", "''")}' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${command}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`;
  try {
    await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrapper, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 180000, maxBuffer: 16384 });
  } catch (error) {
    throw Object.assign(new Error(error.code === 1223
      ? 'Windows permission was not granted. Repair did not finish. Retry Repair and allow the Windows prompt to continue.'
      : 'Windows could not restore access to the repair folder. Close apps using it or choose a writable installation folder, then retry Repair.'),
    { code: 'AHT_REPAIR_PERMISSION_REQUIRED', cause: error });
  }
}

export async function recoverRepairFailure({ error, roots, platform = process.platform, ask,
  permissionAttempted = false, networkAttempted = false, findTarget = repairPermissionTarget, elevate = elevateRepairPermission }) {
  if (!permissionAttempted && platform === 'win32') {
    const target = await findTarget(error, roots);
    if (target) {
      if (!await ask('permission')) throw Object.assign(new Error('Windows permission was not granted. Repair did not finish. Retry Repair to continue.'), { code: 'AHT_REPAIR_PERMISSION_REQUIRED' });
      await elevate(target);
      return 'permission';
    }
  }
  if (!networkAttempted && repairNetworkFailure(error) && await ask('network')) return 'network';
  return null;
}
