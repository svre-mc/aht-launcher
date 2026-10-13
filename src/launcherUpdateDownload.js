import { stat } from 'node:fs/promises';
import { downloadToFile, isHttpUrl } from './utils.js';

// Small ranges keep all workers busy even for a launcher-sized archive. The
// existing downloader validates each Content-Range and falls back when an
// origin cannot serve ranges; the caller still verifies the complete SHA256.
export async function downloadLauncherUpdate(source, target, { onProgress, logger } = {}) {
  const startedAt = Date.now();
  let method = 'stream';
  await downloadToFile(source, target, {
    multipart: isHttpUrl(source),
    multipartThresholdBytes: 16 * 1024 * 1024,
    multipartPartSizeBytes: 8 * 1024 * 1024,
    multipartConcurrency: 6,
    logger,
    onProgress(progress) {
      method = progress.method || method;
      onProgress?.(progress);
    }
  });
  const bytes = (await stat(target)).size;
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  const result = { method, bytes, elapsedMs, bytesPerSecond: Math.round(bytes * 1000 / elapsedMs) };
  logger?.log?.(`Launcher download completed: ${bytes} bytes in ${elapsedMs} ms (${method}, ${result.bytesPerSecond} bytes/sec).`);
  return result;
}
