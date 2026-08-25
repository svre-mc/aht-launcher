import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_MANIFEST_FORMAT,
  isClientPackContentPath,
  isManagedClientPackPath
} from './clientPackFormat.js';
import {
  cacheBustHttpUrl,
  isFileUrl,
  isHttpUrl,
  normalizeRelPath,
  resolveSource
} from './utils.js';

const DEFAULT_MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const verifiedManifestCache = new Map();

function normalizedManifestFile(record = {}) {
  const relativePath = normalizeRelPath(record.relativePath || record.path || '');
  const size = Number(record.size);
  const sha256 = String(record.sha256 || '').trim().toLowerCase();
  if (!isClientPackContentPath(relativePath)
      || !Number.isSafeInteger(size) || size < 0
      || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Client manifest contains an invalid file record: ${JSON.stringify(record)}`);
  }
  return {
    relativePath,
    size,
    sha256,
    managed: isManagedClientPackPath(relativePath)
  };
}

export function validateManagedClientManifest(manifest = {}, latest = {}) {
  if (manifest.format !== CLIENT_MANIFEST_FORMAT || !Array.isArray(manifest.files)) {
    throw new Error('Client manifest is missing or unsupported.');
  }
  if (String(manifest.packId || '') !== String(latest.packId || '')
      || String(manifest.version || '') !== String(latest.version || '')) {
    throw new Error('Client manifest does not match the selected release.');
  }
  const files = [];
  const foldedPaths = new Set();
  for (const raw of manifest.files) {
    const file = normalizedManifestFile(raw);
    const folded = file.relativePath.toLowerCase();
    if (foldedPaths.has(folded)) {
      throw new Error(`Client manifest contains a duplicate path: ${file.relativePath}`);
    }
    foldedPaths.add(folded);
    files.push(file);
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    format: manifest.format,
    packId: String(manifest.packId || ''),
    version: String(manifest.version || ''),
    files,
    managedFiles: files
      .filter((file) => file.managed)
      .map((file) => ({
        relativePath: file.relativePath,
        source: 'verified-client-manifest',
        sha256: file.sha256,
        size: file.size,
        requiredByLatest: true
      }))
  };
}

async function readSourceBytes(source, maxBytes) {
  if (!isHttpUrl(source)) {
    const localPath = isFileUrl(source) ? fileURLToPath(source) : source;
    const stat = await fs.stat(localPath);
    if (stat.size > maxBytes) throw new Error(`Client manifest exceeds the ${maxBytes}-byte limit.`);
    return fs.readFile(localPath);
  }
  const response = await fetch(cacheBustHttpUrl(source, 'aht_manifest'), {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    cache: 'no-store',
    signal: globalThis.AbortSignal?.timeout?.(20_000)
  });
  if (!response.ok) {
    throw new Error(`GET ${source} failed: ${response.status} ${response.statusText}`);
  }
  const declaredSize = Number(response.headers.get('Content-Length') || 0);
  if (declaredSize > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Client manifest exceeds the ${maxBytes}-byte limit.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`Client manifest exceeds the ${maxBytes}-byte limit.`);
  return bytes;
}

export async function loadVerifiedManagedManifest({
  latestSource = '',
  latest = {},
  maxBytes = DEFAULT_MAX_MANIFEST_BYTES
} = {}) {
  const reference = latest?.clientManifest || {};
  if (reference.format !== CLIENT_MANIFEST_FORMAT) {
    throw new Error('The selected full-client release does not declare a supported client manifest.');
  }
  const expectedSha256 = String(reference.sha256 || '').trim().toLowerCase();
  const expectedSize = Number(reference.size || 0);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error('The selected release does not contain a valid client-manifest SHA-256.');
  }
  const preferLocalPath = !isHttpUrl(latestSource);
  const manifestRef = preferLocalPath
    ? (reference.path || reference.url)
    : (reference.url || reference.path);
  if (!manifestRef) throw new Error('The selected release does not contain a client-manifest location.');
  const source = resolveSource(latestSource, manifestRef);
  const cacheKey = `${source}\0${expectedSha256}`;
  if (verifiedManifestCache.has(cacheKey)) return verifiedManifestCache.get(cacheKey);

  const bytes = await readSourceBytes(source, Math.max(1024, Number(maxBytes) || DEFAULT_MAX_MANIFEST_BYTES));
  if (expectedSize > 0 && bytes.length !== expectedSize) {
    throw new Error(`Client manifest size mismatch: expected ${expectedSize}, got ${bytes.length}.`);
  }
  const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error('Client manifest SHA-256 does not match latest.json.');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Client manifest JSON is invalid: ${error.message || error}`);
  }
  const verified = {
    ...validateManagedClientManifest(parsed, latest),
    source,
    sha256: actualSha256,
    size: bytes.length,
    verifiedAt: new Date().toISOString()
  };
  verifiedManifestCache.set(cacheKey, verified);
  return verified;
}
