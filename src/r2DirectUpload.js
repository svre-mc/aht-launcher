import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { withR2StorageBudget } from './r2StorageBudget.js';
import { commitModpackPublication, immutableModpackObject } from './modpackPublication.js';
import { releaseTargetObjectKey } from './releaseTargets.js';

export async function preflightR2Uploads({ uploads, bucket, ...credentials }) {
  return withR2StorageBudget({ credentials, bucket, uploads });
}

const DEFAULT_PART_SIZE = 32 * 1024 * 1024;
const DEFAULT_QUEUE_SIZE = 8;

function budgetedFileStream(file, expectedSize, expectedSha256 = '') {
  // ContentLength is not a byte limit for the SDK's multipart reader. Stop
  // before yielding a chunk that would exceed the size admitted by preflight.
  return Readable.from((async function* () {
    let total = 0;
    const digest = expectedSha256 ? createHash('sha256') : null;
    for await (const chunk of fs.createReadStream(file)) {
      total += chunk.length;
      if (total > expectedSize) throw new Error('Upload file changed after the storage preflight.');
      digest?.update(chunk);
      yield chunk;
    }
    if (total !== expectedSize) throw new Error('Upload file changed after the storage preflight.');
    if (digest && digest.digest('hex') !== expectedSha256.toLowerCase()) throw new Error('Upload content changed after verification.');
  })(), { objectMode: false });
}

export function cleanR2AccountId(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('.r2.cloudflarestorage.com')) {
      return host.replace(/\.r2\.cloudflarestorage\.com$/, '');
    }
  } catch {}
  return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.r2\.cloudflarestorage\.com$/i, '').trim();
}

export function directR2CredentialsReady(credentials = {}) {
  return Boolean(
    cleanR2AccountId(credentials.accountId)
    && String(credentials.accessKeyId || '').trim()
    && String(credentials.secretAccessKey || '').trim()
  );
}

export function missingDirectR2CredentialLabels(credentials = {}) {
  const missing = [];
  if (!cleanR2AccountId(credentials.accountId)) missing.push('R2 Account ID');
  if (!String(credentials.accessKeyId || '').trim()) missing.push('R2 Access Key ID');
  if (!String(credentials.secretAccessKey || '').trim()) missing.push('R2 Secret Access Key');
  return missing;
}

export function r2Endpoint(accountId = '') {
  const clean = cleanR2AccountId(accountId);
  if (!clean) return '';
  return `https://${clean}.r2.cloudflarestorage.com`;
}

function assertDirectR2Credentials(credentials = {}) {
  if (!directR2CredentialsReady(credentials)) {
    throw new Error(`Direct R2 upload is missing: ${missingDirectR2CredentialLabels(credentials).join(', ')}`);
  }
}

function r2Client({ accountId, accessKeyId, secretAccessKey } = {}) {
  assertDirectR2Credentials({ accountId, accessKeyId, secretAccessKey });
  return new S3Client({
    region: 'auto',
    endpoint: r2Endpoint(accountId),
    forcePathStyle: true,
    credentials: {
      accessKeyId: String(accessKeyId || '').trim(),
      secretAccessKey: String(secretAccessKey || '').trim()
    }
  });
}

export async function headR2ObjectDirect({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  key
} = {}) {
  const client = r2Client({ accountId, accessKeyId, secretAccessKey });
  try {
    const result = await client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: key
    }));
    const metadata = result.Metadata || {};
    return {
      exists: true,
      size: Number(result.ContentLength || 0),
      etag: String(result.ETag || '').replace(/^"|"$/g, ''),
      metadata,
      sha256: metadata['aht-sha256'] || metadata.ahtSha256 || ''
    };
  } catch (error) {
    const status = Number(error?.$metadata?.httpStatusCode || 0);
    if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') {
      return { exists: false, size: 0, etag: '', metadata: {}, sha256: '' };
    }
    throw error;
  }
}

export async function getR2JsonDirect({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  key,
  maxBytes = 8 * 1024 * 1024
} = {}) {
  const client = r2Client({ accountId, accessKeyId, secretAccessKey });
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const size = Number(result.ContentLength || 0);
    if (size > maxBytes) throw new Error(`R2 JSON object ${key} is larger than ${maxBytes} bytes.`);
    const body = await result.Body?.transformToString('utf8');
    if (!body) throw new Error(`R2 JSON object ${key} is empty.`);
    return {
      exists: true,
      size: size || Buffer.byteLength(body, 'utf8'),
      etag: String(result.ETag || '').replace(/^"|"$/g, ''),
      value: JSON.parse(body)
    };
  } catch (error) {
    const status = Number(error?.$metadata?.httpStatusCode || 0);
    if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') {
      return { exists: false, size: 0, etag: '', value: null };
    }
    throw error;
  }
}

export async function uploadR2ObjectDirect({
  accountId,
  accessKeyId,
  secretAccessKey,
  inventoryAccessKeyId,
  inventorySecretAccessKey,
  bucket,
  key,
  file,
  contentType = 'application/octet-stream',
  sha256 = '',
  metadata = {},
  partSize = DEFAULT_PART_SIZE,
  queueSize = DEFAULT_QUEUE_SIZE,
  onProgress = null
} = {}) {
  assertDirectR2Credentials({ accountId, accessKeyId, secretAccessKey });
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error('R2 upload must contain a regular file.');
  const startedAt = Date.now();
  const endpoint = r2Endpoint(accountId);
  const client = r2Client({ accountId, accessKeyId, secretAccessKey });
  const uploadMetadata = {
    ...metadata,
    ...(sha256 ? { 'aht-sha256': String(sha256).toLowerCase() } : {})
  };
  return withR2StorageBudget({ credentials: { accountId, accessKeyId, secretAccessKey, inventoryAccessKeyId, inventorySecretAccessKey }, bucket,
    uploads: [{ key, size: stat.size }] }, async () => {
    const current = await fsp.stat(file);
    if (!current.isFile() || current.size !== stat.size) throw new Error('Upload file changed after the storage preflight.');
    if (immutableModpackObject(key)) {
      if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('Versioned modpack uploads require a verified SHA256.');
      const existing = await headR2ObjectDirect({ accountId, accessKeyId, secretAccessKey, bucket, key });
      if (existing.exists) {
        if (existing.size !== stat.size || existing.sha256.toLowerCase() !== sha256.toLowerCase()) {
          throw new Error(`Immutable release artifact already exists with different bytes: ${key}. Use a new release version.`);
        }
        return { method: 'direct-skip', bucket, key, size: stat.size, skipped: true };
      }
    }
    const body = budgetedFileStream(file, stat.size, sha256);
    const upload = new Upload({
      client,
      queueSize,
      partSize,
      leavePartsOnError: false,
      params: {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: stat.size,
        StorageClass: 'STANDARD',
        ContentType: contentType,
        ...(Object.keys(uploadMetadata).length ? { Metadata: uploadMetadata } : {})
      }
    });
    upload.on('httpUploadProgress', (event = {}) => {
      const loaded = Number(event.loaded || 0);
      const total = Number(event.total || stat.size || 0);
      const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
      onProgress?.({
        loaded,
        total,
        percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
        speedBytesPerSecond: Math.round(loaded / elapsedSeconds),
        part: event.part || null
      });
    });
    try { await upload.done(); } finally { body.destroy(); }
    return {
      method: 'direct-multipart',
      endpoint,
      bucket,
      key,
      size: stat.size,
      partSize,
      queueSize
    };
  }).finally(() => client.destroy());
}

export async function commitR2ModpackRelease({ bucket, target, latest, baseline, verifyPublic, ...credentials }) {
  const key = releaseTargetObjectKey('latest.json', target);
  const body = JSON.stringify(latest);
  return withR2StorageBudget({ credentials, bucket, uploads: [{ key, size: Buffer.byteLength(body) }] }, () =>
    commitModpackPublication({ latest, baseline, target, verifyPublic,
      readFeed: async () => (await getR2JsonDirect({ ...credentials, bucket, key })).value,
      head: artifactKey => headR2ObjectDirect({ ...credentials, bucket, key: artifactKey }),
      writeFeed: value => uploadR2JsonDirect({ ...credentials, bucket, key, value,
        sha256: createHash('sha256').update(body).digest('hex'),
        metadata: { 'aht-uploaded-by': 'aht-launcher', 'aht-release-target': target } })
    }));
}

export async function uploadR2JsonDirect({
  accountId,
  accessKeyId,
  secretAccessKey,
  inventoryAccessKeyId,
  inventorySecretAccessKey,
  bucket,
  key,
  value,
  sha256 = '',
  metadata = {}
} = {}) {
  assertDirectR2Credentials({ accountId, accessKeyId, secretAccessKey });
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const size = Buffer.byteLength(body, 'utf8');
  if (!body || size > 256 * 1024) {
    throw new Error('Direct R2 JSON upload must contain between 1 byte and 256 KB.');
  }
  const client = r2Client({ accountId, accessKeyId, secretAccessKey });
  const uploadMetadata = {
    ...metadata,
    ...(sha256 ? { 'aht-sha256': String(sha256).toLowerCase() } : {})
  };
  return withR2StorageBudget({ credentials: { accountId, accessKeyId, secretAccessKey, inventoryAccessKeyId, inventorySecretAccessKey }, bucket,
    uploads: [{ key, size }] }, async () => {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentLength: size,
      StorageClass: 'STANDARD',
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'public, max-age=60, must-revalidate',
      ...(Object.keys(uploadMetadata).length ? { Metadata: uploadMetadata } : {})
    }));
    return {
      method: 'direct-put-json',
      endpoint: r2Endpoint(accountId),
      bucket,
      key,
      size
    };
  }).finally(() => client.destroy());
}
