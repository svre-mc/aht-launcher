import path from 'node:path';
import { execFile } from 'node:child_process';

// Use the logged-in Windows user's DPAPI context. Return only the selected
// account's Minecraft relying-party credential, never the whole MSA cache.
const DECRYPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($request.file), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  try {
    $cache = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
    $account = $cache.credentials.PSObject.Properties[$request.remoteId].Value
    foreach ($field in $account.PSObject.Properties) {
      if ($field.Name -notmatch '^Xal\\..*\\.RETAIL\\.User\\.') { continue }
      $user = $field.Value | ConvertFrom-Json
      foreach ($entry in $user.tokens) {
        if ($entry.RelyingParty -ne 'rp://api.minecraftservices.com/') { continue }
        $data = $entry.TokenData
        $hash = $data.DisplayClaims.xui[0].uhs
        if ($data.Token -and $hash) {
          [Console]::Out.Write((@{ token = $data.Token; userHash = $hash; expiresAt = $data.NotAfter } | ConvertTo-Json -Compress))
          exit 0
        }
      }
    }
  } finally { [Array]::Clear($plain, 0, $plain.Length) }
} catch { }
exit 1
`;

export function readWindowsMinecraftSession({ file, remoteId, platform = process.platform }) {
  if (platform !== 'win32' || !file || !remoteId) return Promise.resolve(null);
  return new Promise(resolve => {
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DECRYPT, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) return resolve(null);
        try {
          const value = JSON.parse(stdout);
          resolve(typeof value.token === 'string' && typeof value.userHash === 'string'
            && Date.parse(value.expiresAt) > Date.now() + 30_000 ? value : null);
        } catch { resolve(null); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ file, remoteId: String(remoteId) }));
  });
}
