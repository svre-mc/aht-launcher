import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  S3Client, ListBucketsCommand, ListObjectsV2Command, ListMultipartUploadsCommand,
  ListPartsCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand
} from '@aws-sdk/client-s3';

// Decimal bytes. Keep 1 GB outside the publisher budget for account-data growth
// and metadata. This is a storage guard, not an account-wide billing switch.
export const R2_STORAGE_BUDGET_BYTES = 9_000_000_000;
export const R2_LOCK_BUCKET = 'ahtlauncher';
export const R2_LOCK_KEY = '_publisher/storage-budget.lock';
const ownership = new AsyncLocalStorage();
const discoveryCredentials = new WeakMap();

function bytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Unknown or invalid storage size: ${label}.`);
  return value;
}

export function projectR2Storage({ storedBytes, multipartBytes, uploads, budgetBytes = R2_STORAGE_BUDGET_BYTES }) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0 || budgetBytes > R2_STORAGE_BUDGET_BYTES) {
    throw new Error(`R2 storage budget must be between 1 and ${R2_STORAGE_BUDGET_BYTES} decimal bytes.`);
  }
  if (!Array.isArray(uploads)) throw new Error('A complete upload plan is required for the R2 storage check.');
  const sizes = uploads.map((item) => bytes(item.size, item.key || 'upload'));
  const incomingBytes = bytes(sizes.reduce((sum, size) => sum + size, 0), 'incoming total');
  // Do not subtract overwritten objects or planned deletions. Old bytes coexist
  // with new ones until publication succeeds. Reserve one extra largest upload
  // for multipart completion/staging, even for single-PUT callers.
  const temporaryBytes = sizes.reduce((max, size) => Math.max(max, size), 0);
  const projectedPeakBytes = bytes(bytes(storedBytes, 'account objects')
    + bytes(multipartBytes, 'unfinished parts') + incomingBytes + temporaryBytes, 'projected peak');
  return { storedBytes, multipartBytes, incomingBytes, temporaryBytes, projectedPeakBytes,
    budgetBytes, allowed: projectedPeakBytes <= budgetBytes };
}

export function createR2StorageClient(credentials = {}) {
  const accountId = String(credentials.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.AHT_R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(credentials.accessKeyId || process.env.R2_ACCESS_KEY_ID || process.env.AHT_R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(credentials.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || process.env.AHT_R2_SECRET_ACCESS_KEY || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 storage guard requires an account ID and account-wide R2 access keys (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY). Upload blocked; Wrangler credentials alone cannot inventory unfinished uploads.');
  }
  const client = new S3Client({ region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId, secretAccessKey } });
  const inventoryAccessKeyId = credentials.inventoryAccessKeyId || process.env.R2_INVENTORY_ACCESS_KEY_ID;
  const inventorySecretAccessKey = credentials.inventorySecretAccessKey || process.env.R2_INVENTORY_SECRET_ACCESS_KEY;
  if (inventoryAccessKeyId || inventorySecretAccessKey) {
    if (!inventoryAccessKeyId || !inventorySecretAccessKey) { client.destroy(); throw new Error('Both read-only R2 inventory credentials are required.'); }
    const reader = new S3Client({ region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: inventoryAccessKeyId, secretAccessKey: inventorySecretAccessKey } });
    const send = client.send.bind(client), destroy = client.destroy.bind(client);
    client.send = (command, ...args) => isInventoryCommand(command) ? reader.send(command, ...args) : send(command, ...args);
    client.destroy = () => { reader.destroy(); destroy(); };
  }
  discoveryCredentials.set(client, { accountId, apiToken: credentials.apiToken || process.env.CLOUDFLARE_API_TOKEN });
  return client;
}

function isInventoryCommand(command) {
  return command instanceof ListBucketsCommand || command instanceof ListObjectsV2Command
    || command instanceof ListMultipartUploadsCommand || command instanceof ListPartsCommand;
}

async function pages(client, Command, input, rowsKey, markers) {
  const rows = [];
  const seen = new Set();
  for (let count = 0; count < 10_000; count += 1) {
    const page = await client.send(new Command(input));
    if (page[rowsKey] !== undefined && !Array.isArray(page[rowsKey])) throw new Error(`Invalid R2 ${rowsKey} listing.`);
    rows.push(...(page[rowsKey] || []));
    const truncated = rowsKey === 'Buckets' ? Boolean(page.ContinuationToken) : page.IsTruncated;
    if (rowsKey !== 'Buckets' && typeof truncated !== 'boolean') throw new Error(`Incomplete R2 ${rowsKey} pagination metadata.`);
    if (!truncated) return rows;
    const next = Object.fromEntries(markers.map(([request, response]) => [request, page[response]]));
    const cursor = JSON.stringify(next);
    if (!Object.values(next).some(value => value !== undefined && value !== '') || seen.has(cursor)) {
      throw new Error(`R2 ${rowsKey} pagination stalled; storage is unknown.`);
    }
    seen.add(cursor);
    input = { ...input, ...next };
  }
  throw new Error(`R2 ${rowsKey} listing exceeded the bounded page limit.`);
}

export async function discoverR2Buckets(client, { accountId, apiToken, fetchImpl = fetch } = discoveryCredentials.get(client) || {}) {
  try {
    return await pages(client, ListBucketsCommand, {}, 'Buckets', [['ContinuationToken', 'ContinuationToken']]);
  } catch (error) {
    // Object-scoped S3 credentials may enumerate all objects/parts but cannot
    // list buckets. A separate authorized control API can supply that list.
    if (error.$metadata?.httpStatusCode !== 403 || !/^[a-f0-9]{32}$/i.test(accountId || '') || !apiToken) throw error;
  }
  const buckets = [], seen = new Set();
  let cursor = '';
  for (let page = 0; page < 10_000; page += 1) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`);
    url.searchParams.set('per_page', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiToken}` },
      redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`R2 control API bucket inventory failed (HTTP ${response.status}).`);
    const body = await response.json();
    if (body.success !== true || !Array.isArray(body.result?.buckets)) throw new Error('Invalid R2 control API bucket inventory.');
    for (const bucket of body.result.buckets) {
      if (bucket.jurisdiction && bucket.jurisdiction !== 'default') throw new Error('R2 jurisdiction requires its own object inventory; upload blocked.');
      buckets.push({ Name: bucket.name });
    }
    cursor = body.result_info?.cursor;
    if (cursor === undefined || cursor === null || cursor === '') return buckets;
    if (typeof cursor !== 'string' || seen.has(cursor)) throw new Error('R2 bucket pagination stalled; storage is unknown.');
    seen.add(cursor);
  }
  throw new Error('R2 bucket listing exceeded the bounded page limit.');
}

export async function inventoryR2Account(client) {
  const buckets = await discoverR2Buckets(client);
  if (!buckets.length || buckets.some(bucket => !bucket.Name)
      || new Set(buckets.map(bucket => bucket.Name)).size !== buckets.length) throw new Error('R2 account bucket inventory is invalid.');
  if (!buckets.some(bucket => bucket.Name === R2_LOCK_BUCKET)) throw new Error('R2 publisher lock bucket is not visible.');
  const objects = [];
  const multipartUploads = [];
  let storedBytes = 0;
  let multipartBytes = 0;
  for (const { Name: Bucket } of buckets) {
    const entries = await pages(client, ListObjectsV2Command, { Bucket, MaxKeys: 1000 }, 'Contents',
      [['ContinuationToken', 'NextContinuationToken']]);
    const keys = new Set();
    for (const item of entries) {
      if (!item.Key || keys.has(item.Key)) throw new Error('Invalid or duplicate R2 object in inventory.');
      if (item.StorageClass && item.StorageClass !== 'STANDARD') throw new Error('R2 storage guard requires Standard storage; another class is billable.');
      keys.add(item.Key);
      storedBytes += bytes(item.Size, item.Key);
      objects.push({ bucket: Bucket, key: item.Key, size: item.Size, etag: item.ETag, lastModified: item.LastModified });
    }
    const uploads = await pages(client, ListMultipartUploadsCommand, { Bucket, MaxUploads: 1000 }, 'Uploads',
      [['KeyMarker', 'NextKeyMarker'], ['UploadIdMarker', 'NextUploadIdMarker']]);
    const ids = new Set();
    for (const upload of uploads) {
      const id = `${upload.Key}/${upload.UploadId}`;
      if (!upload.Key || !upload.UploadId || ids.has(id)) throw new Error('Invalid R2 multipart inventory.');
      ids.add(id);
      const parts = await pages(client, ListPartsCommand, { Bucket, Key: upload.Key, UploadId: upload.UploadId, MaxParts: 1000 }, 'Parts',
        [['PartNumberMarker', 'NextPartNumberMarker']]);
      const size = bytes(parts.reduce((sum, part) => sum + bytes(part.Size, 'multipart part'), 0), 'multipart upload');
      multipartBytes += size;
      multipartUploads.push({ bucket: Bucket, key: upload.Key, uploadId: upload.UploadId, size });
    }
  }
  return { objects, multipartUploads, storedBytes: bytes(storedBytes, 'stored total'), multipartBytes: bytes(multipartBytes, 'multipart total') };
}

// A zero-byte conditional object is the only write before the size check.
// Never steal/expire it: a paused uploader could otherwise continue after losing
// its lock. A crashed process needs explicit recovery after its writers stop.
export async function withR2StorageLock(client, operation) {
  if (ownership.getStore()?.client === client) return operation();
  const owner = randomUUID();
  try {
    await client.send(new PutObjectCommand({ Bucket: R2_LOCK_BUCKET, Key: R2_LOCK_KEY,
      Body: '', ContentLength: 0, IfNoneMatch: '*', StorageClass: 'STANDARD', Metadata: { owner } }));
  } catch (error) {
    throw new Error('R2 publisher lock unavailable. Another publisher/retention job may be running. A stale lock must be recovered only after stopping its writer.', { cause: error });
  }
  try {
    return await ownership.run({ client, owner }, operation);
  } finally {
    const lock = await client.send(new HeadObjectCommand({ Bucket: R2_LOCK_BUCKET, Key: R2_LOCK_KEY }));
    if (lock.Metadata?.owner !== owner) throw new Error('R2 publisher lock ownership changed; refusing to release another writer’s lock.');
    await client.send(new DeleteObjectCommand({ Bucket: R2_LOCK_BUCKET, Key: R2_LOCK_KEY }));
  }
}

export async function withR2StorageBudget({ client, credentials, bucket = R2_LOCK_BUCKET, uploads,
  budgetBytes = R2_STORAGE_BUDGET_BYTES, onProjection = null }, operation) {
  // Validate even a malformed/NaN budget before acquiring the lock.
  projectR2Storage({ storedBytes: 0, multipartBytes: 0, uploads, budgetBytes });
  if (uploads.some(item => String(item.key || '').startsWith('_publisher/'))) throw new Error('Publisher control objects cannot appear in an upload plan.');
  const inherited = ownership.getStore()?.client;
  const ownedClient = !client && !inherited;
  client ||= inherited || createR2StorageClient(credentials);
  try {
    return await withR2StorageLock(client, async () => {
      let inventory = await inventoryR2Account(client);
      if (!inventory.objects.some(item => item.bucket === bucket) && bucket !== R2_LOCK_BUCKET) {
        throw new Error('Upload bucket is not present in the account inventory.');
      }
      // An unfinished upload may still grow. Its current part size is not an
      // upper bound; block instead of racing it or aborting another writer.
      if (inventory.multipartUploads.length) throw new Error(`R2 upload blocked: ${inventory.multipartUploads.length} unfinished multipart upload(s), ${inventory.multipartBytes} bytes. Finish or explicitly recover them first.`);
      if (bucket === R2_LOCK_BUCKET && uploads.some(item => /^(?:ptb\/)?packs\/.+\.zip$/i.test(item.key || ''))) {
        const { deleteSupersededR2Packs } = await import('./r2RollbackArchive.js');
        const deleted = await deleteSupersededR2Packs({ client, inventory, bucket, uploads });
        if (deleted.length) {
          inventory = await inventoryR2Account(client);
          if (inventory.multipartUploads.length) throw new Error('Multipart state changed during pack retention; upload blocked.');
        }
      }
      const projection = projectR2Storage({ ...inventory, uploads, budgetBytes });
      onProjection?.(projection);
      if (!projection.allowed) {
        throw new Error(`R2 upload blocked: projected peak ${projection.projectedPeakBytes} bytes exceeds ${budgetBytes} bytes (stored ${projection.storedBytes}, incoming ${projection.incomingBytes}, temporary ${projection.temporaryBytes}). Superseded full packs are pruned before incoming pack uploads; active release files will not be removed to pass the budget.`);
      }
      return operation ? await operation(projection, client) : projection;
    });
  } finally {
    if (ownedClient) client.destroy();
  }
}
