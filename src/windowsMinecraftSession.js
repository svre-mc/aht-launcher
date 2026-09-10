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
    $candidates = @()
    foreach ($field in $account.PSObject.Properties) {
      if ($field.Name -notmatch '^Xal\\..*\\.RETAIL\\.User\\.') { continue }
      try { $user = $field.Value | ConvertFrom-Json } catch { continue }
      foreach ($entry in $user.tokens) {
        try {
        if ($entry.RelyingParty -ne 'rp://api.minecraftservices.com/') { continue }
        $data = $entry.TokenData
        $hash = $data.DisplayClaims.xui[0].uhs
        $expiry = [DateTimeOffset]::MinValue
        if ($data.Token -and $hash -and [DateTimeOffset]::TryParse([string]$data.NotAfter, [ref]$expiry) -and $expiry -gt [DateTimeOffset]::UtcNow.AddSeconds(30)) {
          $candidates += @{ token = $data.Token; userHash = $hash; expiresAt = $expiry.ToString('o') }
        }
        } catch { continue }
      }
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject @($candidates | Sort-Object expiresAt -Descending) -Compress))
  } finally { [Array]::Clear($plain, 0, $plain.Length) }
} catch { }
`;

export function readWindowsMinecraftSessions({ file, remoteId, platform = process.platform }) {
  if (platform !== 'win32' || !file || !remoteId) return Promise.resolve([]);
  return new Promise(resolve => {
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DECRYPT, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) return resolve([]);
        try {
          const value = JSON.parse(stdout);
          resolve(Array.isArray(value) ? value.filter(entry => typeof entry.token === 'string' && entry.token.length <= 32_768
            && typeof entry.userHash === 'string' && entry.userHash.length <= 1024
            && Date.parse(entry.expiresAt) > Date.now() + 30_000) : []);
        } catch { resolve([]); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ file, remoteId: String(remoteId) }));
  });
}

export async function readWindowsMinecraftSession(options) {
  return (await readWindowsMinecraftSessions(options))[0] || null;
}
