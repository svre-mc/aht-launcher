import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const phoenixBuildSources = Object.freeze(['Guard.cs', 'PhoenixProbeServer.cs']);
export async function readPhoenixBuildSource(root) {
  return (await Promise.all(phoenixBuildSources.map(async file =>
    `// source: ${file}\n${await fs.readFile(path.join(root, 'native-guard', file), 'utf8')}`))).join('\n');
}

export const phoenixSourceHash = source => crypto.createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex');

export async function reusePhoenixRelease(pin, version, source, fetcher = fetch) {
  if (pin.version !== version) return null;
  if (pin.sourceSha256 !== phoenixSourceHash(source)) {
    throw new Error('Phoenix source changed. Increment phoenixAntiCheatVersion before building a new binary.');
  }
  const url = new URL(pin.url);
  if (url.origin !== 'https://api.ahardtime.net'
      || url.pathname !== `/launcher/anticheat/win32-x64/Phoenix-Anti-cheat-Windows-x64-${version}.exe`
      || url.search || url.hash || !/^[a-f0-9]{64}$/.test(pin.sha256)
      || !Number.isSafeInteger(pin.size) || pin.size <= 0 || pin.size > 16 * 1024 * 1024) {
    throw new Error('Invalid published Phoenix artifact pin.');
  }
  const response = await fetcher(url.href, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Published Phoenix artifact unavailable (${response.status}). No rebuild fallback is permitted.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > pin.size) throw new Error('Published Phoenix artifact size mismatch.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (size !== pin.size || crypto.createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
    throw new Error('Published Phoenix artifact failed verification. No rebuild fallback is permitted.');
  }
  return bytes;
}
