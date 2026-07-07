import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJsonFile(filePath) {
  return JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function writeJsonFile(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function hashFile(filePath, algorithm = 'sha256', options = {}) {
  const hash = createHash(algorithm);
  const stream = createReadStream(filePath);
  const stat = await fs.stat(filePath).catch(() => null);
  const reportProgress = createByteProgressEmitter(options, stat?.size || 0);
  let loaded = 0;
  reportProgress(0, true);
  for await (const chunk of stream) {
    hash.update(chunk);
    loaded += chunk.length;
    reportProgress(loaded);
  }
  reportProgress(loaded, true);
  return hash.digest('hex');
}

export function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'pack';
}

export function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

export function normalizeRelPath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\/+/, '');
}

export function safeJoin(root, relPath) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relPath);
  if (!isPathInside(rootResolved, target)) {
    throw new Error(`Refusing to write outside target directory: ${relPath}`);
  }
  return target;
}

export function isPathInside(root, target) {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const rootComparable = process.platform === 'win32' ? rootResolved.toLowerCase() : rootResolved;
  const targetComparable = process.platform === 'win32' ? targetResolved.toLowerCase() : targetResolved;
  return targetComparable === rootComparable || targetComparable.startsWith(`${rootComparable}${path.sep}`);
}

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value));
}

export function isFileUrl(value) {
  return /^file:\/\//i.test(String(value));
}

export function isUrl(value) {
  return isHttpUrl(value) || isFileUrl(value);
}

export function sourceToDisplay(source) {
  return isFileUrl(source) ? fileURLToPath(source) : source;
}

export function resolveSource(baseSource, value) {
  if (!value) {
    return null;
  }
  const raw = String(value);
  if (isUrl(raw)) {
    return raw;
  }
  if (isHttpUrl(baseSource) || isFileUrl(baseSource)) {
    const base = new URL(baseSource);
    if (!base.pathname.endsWith('/')) {
      base.pathname = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
    }
    return new URL(raw.replaceAll('\\', '/'), base).toString();
  }
  return path.resolve(path.dirname(path.resolve(baseSource)), raw);
}

export function filePathToSource(filePath) {
  return pathToFileURL(path.resolve(filePath)).toString();
}

export function cacheBustHttpUrl(value, paramName = 'aht_cache_bust') {
  const url = new URL(value);
  url.searchParams.set(paramName, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return url.toString();
}

export async function readJsonFromSource(source, headers = {}) {
  if (isHttpUrl(source)) {
    const response = await fetch(cacheBustHttpUrl(source), {
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        ...headers
      },
      cache: 'no-store'
    });
    if (!response.ok) {
      throw new Error(`GET ${source} failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
  const localPath = isFileUrl(source) ? fileURLToPath(source) : source;
  return readJsonFile(localPath);
}

export async function fetchJson(source, headers = {}) {
  const response = await fetch(isHttpUrl(source) ? cacheBustHttpUrl(source) : source, {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      ...headers
    },
    cache: 'no-store'
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET ${source} failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function abortSignal(timeoutMs) {
  if (!timeoutMs || !globalThis.AbortSignal?.timeout) {
    return undefined;
  }
  return globalThis.AbortSignal.timeout(timeoutMs);
}

function retryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function downloadHeaders(headers = {}, extra = {}) {
  return {
    ...headers,
    ...extra
  };
}

function createByteProgressEmitter(options = {}, total = 0) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const progressIntervalMs = positiveInteger(options.progressIntervalMs, 250);
  const startedAt = Date.now();
  const meta = options.progressMeta && typeof options.progressMeta === 'object' ? options.progressMeta : {};
  let lastEmitAt = 0;
  if (!onProgress) {
    return () => {};
  }
  return (loaded, force = false) => {
    const now = Date.now();
    const normalizedLoaded = Math.max(0, Number(loaded) || 0);
    const normalizedTotal = Math.max(0, Number(total) || 0);
    if (!force && now - lastEmitAt < progressIntervalMs && (!normalizedTotal || normalizedLoaded < normalizedTotal)) {
      return;
    }
    lastEmitAt = now;
    const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
    onProgress({
      ...meta,
      loaded: normalizedLoaded,
      total: normalizedTotal,
      percent: normalizedTotal ? Math.min(100, Math.round((normalizedLoaded / normalizedTotal) * 100)) : 0,
      speedBytesPerSecond: Math.round(normalizedLoaded / elapsedSeconds)
    });
  };
}

function parseContentRange(value = '') {
  const match = String(value).match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) {
    return null;
  }
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3])
  };
}

async function runConcurrent(items, concurrency, handler) {
  const workers = Array.from({ length: Math.max(1, Math.min(items.length || 1, concurrency)) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < items.length; index += concurrency) {
      await handler(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function probeRangeDownload(source, options, timeoutMs) {
  const response = await fetch(source, {
    headers: downloadHeaders(options.headers || {}, {
      Range: 'bytes=0-0',
      'Accept-Encoding': 'identity'
    }),
    cache: 'no-store',
    signal: abortSignal(timeoutMs)
  });
  if (response.status === 206) {
    const range = parseContentRange(response.headers.get('content-range'));
    await response.body?.cancel().catch(() => {});
    if (!range || !Number.isFinite(range.total) || range.total <= 1) {
      return { supported: false, total: 0 };
    }
    return { supported: true, total: range.total };
  }
  if (!response.ok) {
    const error = new Error(`Download failed ${source}: ${response.status} ${response.statusText}`);
    error.retryable = retryableHttpStatus(response.status);
    throw error;
  }
  await response.body?.cancel().catch(() => {});
  return { supported: false, total: 0 };
}

async function downloadRangePart({ source, fileHandle, start, end, total, options, timeoutMs, reportBytes }) {
  const response = await fetch(source, {
    headers: downloadHeaders(options.headers || {}, {
      Range: `bytes=${start}-${end}`,
      'Accept-Encoding': 'identity'
    }),
    cache: 'no-store',
    signal: abortSignal(timeoutMs)
  });
  if (response.status !== 206) {
    const error = new Error(`Range download failed ${source}: expected 206, got ${response.status} ${response.statusText}`);
    error.retryable = retryableHttpStatus(response.status);
    throw error;
  }
  const range = parseContentRange(response.headers.get('content-range'));
  if (!range || range.start !== start || range.end !== end || range.total !== total) {
    throw new Error(`Range download returned unexpected Content-Range for ${source}: ${response.headers.get('content-range') || 'missing'}`);
  }
  if (!response.body) {
    throw new Error(`Range download failed ${source}: response body is empty`);
  }
  const reader = response.body.getReader();
  let position = start;
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = Buffer.from(value);
      await fileHandle.write(buffer, 0, buffer.length, position);
      position += buffer.length;
      bytesRead += buffer.length;
      reportBytes(buffer.length);
    }
  } finally {
    reader.releaseLock();
  }
  const expectedBytes = end - start + 1;
  if (bytesRead !== expectedBytes) {
    throw new Error(`Range download ended early for ${source}: expected ${expectedBytes} bytes, got ${bytesRead}`);
  }
}

async function downloadMultipartToFile(source, tmp, options, attempt, timeoutMs) {
  const threshold = positiveInteger(options.multipartThresholdBytes, 16 * 1024 * 1024);
  const partSize = positiveInteger(options.multipartPartSizeBytes, 8 * 1024 * 1024);
  const concurrency = Math.min(12, positiveInteger(options.multipartConcurrency, 6));
  const probe = await probeRangeDownload(source, options, timeoutMs);
  if (!probe.supported || probe.total < threshold) {
    return false;
  }

  const progressMeta = {
    ...(options.progressMeta || {}),
    attempt,
    method: 'multipart-range'
  };
  const reportProgress = createByteProgressEmitter({ ...options, progressMeta }, probe.total);
  let loaded = 0;
  const reportBytes = (bytes) => {
    loaded += bytes;
    reportProgress(loaded);
  };
  const ranges = [];
  for (let start = 0; start < probe.total; start += partSize) {
    ranges.push({ start, end: Math.min(probe.total - 1, start + partSize - 1) });
  }

  if (options.logger?.log) {
    options.logger.log(`Using parallel range download: ${ranges.length} parts, ${concurrency} workers`);
  }
  reportProgress(0, true);
  const fileHandle = await fs.open(tmp, 'w');
  try {
    await fileHandle.truncate(probe.total);
    await runConcurrent(ranges, concurrency, (range) => downloadRangePart({
      source,
      fileHandle,
      start: range.start,
      end: range.end,
      total: probe.total,
      options,
      timeoutMs,
      reportBytes
    }));
  } finally {
    await fileHandle.close();
  }
  reportProgress(probe.total, true);
  return true;
}

function createByteProgressTransform(total, options = {}) {
  const reportProgress = createByteProgressEmitter(options, total);
  let loaded = 0;
  reportProgress(0, true);
  return new Transform({
    transform(chunk, encoding, callback) {
      loaded += chunk.length;
      reportProgress(loaded);
      callback(null, chunk);
    },
    flush(callback) {
      reportProgress(loaded, true);
      callback();
    }
  });
}

async function replaceFileWithDownload(tmp, dest) {
  await fs.rm(dest, { force: true }).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await fs.rename(tmp, dest);
}

export async function downloadToFile(source, dest, options = {}) {
  await ensureDir(path.dirname(dest));
  const tmp = `${dest}.download`;
  const attempts = Math.max(1, positiveInteger(options.retries, 3) + 1);
  const retryDelayMs = positiveInteger(options.retryDelayMs, 750);
  const timeoutMs = positiveInteger(options.timeoutMs, 15 * 60_000);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(tmp, { force: true }).catch(() => {});
      if (isHttpUrl(source)) {
        let usedMultipart = false;
        if (options.multipart) {
          try {
            usedMultipart = await downloadMultipartToFile(source, tmp, options, attempt, timeoutMs);
          } catch (error) {
            await fs.rm(tmp, { force: true }).catch(() => {});
            if (options.logger?.log) {
              options.logger.log(`Parallel range download failed; falling back to single stream. ${error?.message || error}`);
            }
            usedMultipart = false;
          }
        }
        if (!usedMultipart) {
          const response = await fetch(source, {
            headers: options.headers || {},
            cache: 'no-store',
            signal: abortSignal(timeoutMs)
          });
          if (!response.ok) {
            const error = new Error(`Download failed ${source}: ${response.status} ${response.statusText}`);
            error.retryable = retryableHttpStatus(response.status);
            throw error;
          }
          if (!response.body) {
            throw new Error(`Download failed ${source}: response body is empty`);
          }
          const total = Number(response.headers.get('content-length')) || 0;
          await pipeline(
            Readable.fromWeb(response.body),
            createByteProgressTransform(total, { ...options, progressMeta: { ...(options.progressMeta || {}), attempt, method: 'stream' } }),
            createWriteStream(tmp)
          );
        }
      } else {
        const localPath = isFileUrl(source) ? fileURLToPath(source) : source;
        const stat = await fs.stat(localPath).catch(() => null);
        await pipeline(
          createReadStream(localPath),
          createByteProgressTransform(stat?.size || 0, { ...options, progressMeta: { ...(options.progressMeta || {}), attempt } }),
          createWriteStream(tmp)
        );
      }
      await replaceFileWithDownload(tmp, dest);
      return;
    } catch (error) {
      lastError = error;
      await fs.rm(tmp, { force: true }).catch(() => {});
      if (error?.retryable === false || attempt >= attempts) {
        const reason = error?.message || String(error);
        throw new Error(`Download failed after ${attempt} attempt${attempt === 1 ? '' : 's'} for ${source}: ${reason}`);
      }
      if (options.logger?.log) {
        options.logger.log(`Download attempt ${attempt} failed for ${source}; retrying. ${error?.message || error}`);
      }
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError || new Error(`Download failed for ${source}`);
}

export async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

export function pickArg(args, name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1];
}

export function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

export function artifactUrl(baseUrl, relPath) {
  const normalized = normalizeRelPath(relPath);
  if (!baseUrl) {
    return normalized;
  }
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(normalized, base).toString();
}
