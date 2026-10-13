import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const SUPPORT_GAME_LOG_MAX_BYTES = 8 * 1024 * 1024;

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

// Called only when the player requests a copied support report. No upload occurs.
export async function minecraftLatestLogSection(instanceDir, { maxBytes = SUPPORT_GAME_LOG_MAX_BYTES } = {}) {
  const heading = '\r\nMINECRAFT LATEST.LOG\r\n================================================================\r\n';
  if (!String(instanceDir || '').trim()) return heading + 'Status: No selected Minecraft instance.\r\n';
  const limit = Math.max(1, Math.min(SUPPORT_GAME_LOG_MAX_BYTES, Number(maxBytes) || SUPPORT_GAME_LOG_MAX_BYTES));
  let handle;
  try {
    const root = await fs.realpath(path.resolve(instanceDir));
    const logs = path.join(root, 'logs');
    const file = path.join(logs, 'latest.log');
    for (const candidate of [logs, file]) {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() || !within(root, await fs.realpath(candidate))) {
        return heading + 'Status: Unavailable; redirected log paths are excluded.\r\n';
      }
    }
    if (!(await fs.lstat(file)).isFile()) return heading + 'Status: Unavailable; latest.log is not a regular file.\r\n';
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || !within(root, await fs.realpath(file))) throw new Error('Invalid log');
    const offset = Math.max(0, stat.size - limit);
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    let read = 0;
    while (read < buffer.length) {
      const result = await handle.read(buffer, read, buffer.length - read, offset + read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    // Drop the partial first line, including any split credential or UTF-8 sequence.
    if (offset) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    const status = offset ? `Included newest ${limit} bytes; older content omitted.` : stat.size ? 'Included complete log snapshot.' : 'Log exists but is empty.';
    return heading + `Source: selected instance / logs / latest.log\r\nModified: ${stat.mtime.toISOString()}\r\nOriginal size: ${stat.size} bytes\r\nStatus: ${status}\r\nCredentials and private addresses/paths are redacted; exceptionally long lines may be shortened.\r\n\r\n${text}\r\n`;
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 'No latest.log exists in the selected instance yet.' : 'The selected instance latest.log could not be read.';
    return heading + `Status: ${status}\r\n`;
  } finally {
    await handle?.close().catch(() => {});
  }
}
