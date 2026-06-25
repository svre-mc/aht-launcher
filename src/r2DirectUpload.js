import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
const DEFAULT_QUEUE_SIZE = 6;

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

export async function uploadR2ObjectDirect({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  key,
  file,
  contentType = 'application/octet-stream',
  partSize = DEFAULT_PART_SIZE,
  queueSize = DEFAULT_QUEUE_SIZE,
  onProgress = null
} = {}) {
  if (!directR2CredentialsReady({ accountId, accessKeyId, secretAccessKey })) {
    throw new Error(`Direct R2 upload is missing: ${missingDirectR2CredentialLabels({ accountId, accessKeyId, secretAccessKey }).join(', ')}`);
  }
  const stat = await fsp.stat(file);
  const startedAt = Date.now();
  const endpoint = r2Endpoint(accountId);
  const client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: String(accessKeyId || '').trim(),
      secretAccessKey: String(secretAccessKey || '').trim()
    }
  });
  const upload = new Upload({
    client,
    queueSize,
    partSize,
    leavePartsOnError: false,
    params: {
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(file),
      ContentType: contentType
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
  await upload.done();
  return {
    method: 'direct-multipart',
    endpoint,
    bucket,
    key,
    size: stat.size,
    partSize,
    queueSize
  };
}
