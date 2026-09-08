import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Windows scanners can briefly hold freshly extracted JVM binaries. Retry only
// sharing/permission failures; never turn a missing path or another error into a loop.
export async function renameRuntimeDirectory(source, destination, {
  rename = fs.rename, wait = delay, platform = process.platform, logger = null
} = {}) {
  const delays = [100, 200, 400, 800, 1000, 1500, 2000];
  for (let attempt = 0; ; attempt++) {
    try { return await rename(source, destination); }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error;
      if (attempt === 0) logger?.log?.('Waiting briefly for Windows to release the Java runtime files...');
      await wait(delays[attempt]);
    }
  }
}
