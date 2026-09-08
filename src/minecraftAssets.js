import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadToFile, hashFile, safeJoin } from './utils.js';

export async function repairMinecraftAssetObjects({ rootDir, index, logger = null, onProgress = null,
  download = downloadToFile, concurrency = 6 }) {
  const objects = new Map();
  if (!index?.objects || typeof index.objects !== 'object' || Array.isArray(index.objects)) {
    throw new Error('Minecraft asset index has no valid object map.');
  }
  for (const entry of Object.values(index.objects)) {
    const hash = String(entry?.hash || '').toLowerCase();
    const size = Number(entry?.size);
    if (!/^[a-f0-9]{40}$/.test(hash) || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('Minecraft asset index contains an invalid file hash or size.');
    }
    if (objects.has(hash) && objects.get(hash).size !== size) throw new Error('Minecraft asset index has conflicting file sizes.');
    objects.set(hash, { hash, size });
  }
  const queue = [...objects.values()];
  let cursor = 0;
  let checked = 0;
  let downloaded = 0;
  let failure = null;
  logger?.log?.(`Checking ${queue.length} Minecraft asset files...`);
  const worker = async () => {
    while (!failure && cursor < queue.length) {
      const item = queue[cursor++];
      const file = safeJoin(path.join(rootDir, 'assets', 'objects'), `${item.hash.slice(0, 2)}/${item.hash}`);
      try {
        const stat = await fs.stat(file).catch(() => null);
        if (!stat?.isFile() || stat.size !== item.size || await hashFile(file, 'sha1') !== item.hash) {
          const staging = `${file}.aht-repair`;
          try {
            await download(`https://resources.download.minecraft.net/${item.hash.slice(0, 2)}/${item.hash}`, staging,
              { timeoutMs: 120_000, retries: 2 });
            if ((await fs.stat(staging)).size !== item.size || await hashFile(staging, 'sha1') !== item.hash) {
              throw new Error(`Minecraft asset ${item.hash} failed checksum validation.`);
            }
            await fs.rename(staging, file);
            downloaded++;
          } finally { await fs.rm(staging, { force: true }); }
        }
        checked++;
        onProgress?.({ checked, total: queue.length, downloaded });
      } catch (error) { failure ||= error; }
    }
  };
  // Drain every active worker before returning an error; no background repair
  // may keep writing after the launcher says the operation is finished.
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency, queue.length)) }, worker));
  if (failure) throw failure;
  logger?.log?.(`Minecraft assets ready: ${checked} verified, ${downloaded} repaired.`);
  return { checked, downloaded };
}
