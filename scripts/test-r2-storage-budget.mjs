import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import fileStreams from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { S3Client } from '@aws-sdk/client-s3';
import { projectR2Storage, createR2StorageClient, discoverR2Buckets, inventoryR2Account, withR2StorageBudget, withR2StorageLock, R2_LOCK_KEY } from '../src/r2StorageBudget.js';
import { archiveR2Rollbacks, deleteSupersededR2Packs } from '../src/r2RollbackArchive.js';
import { uploadR2Plan } from './upload-r2-plan.mjs';
import { uploadR2JsonDirect, uploadR2ObjectDirect, commitR2ModpackRelease } from '../src/r2DirectUpload.js';
import { runRetention } from './r2-retention.mjs';

// These tests own an in-memory account and throwaway local files. Exercise the
// durable-local branch under CI without allowing a real CI publisher to use it.
delete process.env.CI;
process.env.AHT_R2_ROLLBACK_DIR = '';

const date = new Date('2026-08-01T00:00:00Z');
const now = Date.parse('2026-09-09T00:00:00Z');
const credentials = { accountId: 'a'.repeat(32), accessKeyId: 'fixture', secretAccessKey: 'fixture' };
test('read-only inventory identity is separate from existing release writes and both clients close', async () => {
  const originalSend = S3Client.prototype.send, originalDestroy = S3Client.prototype.destroy;
  const calls = [], closed = new Set();
  S3Client.prototype.send = async function(command) {
    const auth = await this.config.credentials();
    calls.push({ key: auth.accessKeyId, command: command.constructor.name });
    return new R2().send(command);
  };
  S3Client.prototype.destroy = function() { closed.add(this); };
  try {
    const client = createR2StorageClient({ ...credentials, inventoryAccessKeyId: 'read-only', inventorySecretAccessKey: 'fixture' });
    await inventoryR2Account(client);
    const { PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await client.send(new PutObjectCommand({ Bucket: 'ahtlauncher', Key: 'release', Body: 'payload' }));
    await client.send(new DeleteObjectCommand({ Bucket: 'ahtlauncher', Key: 'release' }));
    client.destroy();
    assert.equal(closed.size, 2);
    assert.ok(calls.filter(x => x.command.startsWith('List')).every(x => x.key === 'read-only'));
    assert.ok(calls.filter(x => !x.command.startsWith('List')).every(x => x.key === 'fixture'));
    assert.throws(() => createR2StorageClient({ ...credentials, inventoryAccessKeyId: 'partial' }), /Both read-only/);
  } finally { S3Client.prototype.send = originalSend; S3Client.prototype.destroy = originalDestroy; }
});
test('object credentials can use authorized paginated control API discovery without bypassing denied inventories', async () => {
  const denied = { send: async () => { throw Object.assign(new Error('Access Denied'), { $metadata: { httpStatusCode: 403 } }); } };
  let calls = 0;
  const options = { accountId: credentials.accountId, apiToken: 'fixture', fetchImpl: async (url, request) => {
    assert.equal(url.origin, 'https://api.cloudflare.com');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer fixture');
    calls++;
    return { ok: true, json: async () => ({ success: true,
      result: { buckets: [{ name: calls === 1 ? 'ahtlauncher' : 'ahtlauncher-data', jurisdiction: 'default' }] },
      result_info: calls === 1 ? { cursor: 'next' } : {} }) };
  } };
  assert.deepEqual(await discoverR2Buckets(denied, options), [{ Name: 'ahtlauncher' }, { Name: 'ahtlauncher-data' }]);
  assert.equal(calls, 2);
  await assert.rejects(discoverR2Buckets(denied, { ...options, apiToken: '' }), /Access Denied/);
  await assert.rejects(discoverR2Buckets(denied, { ...options, fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  await assert.rejects(discoverR2Buckets(denied, { ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, result: { buckets: [] }, result_info: { cursor: 'same' } }) }) }), /pagination stalled/);
  const r2 = new R2();
  r2.hook = name => { if (name === 'ListObjectsV2Command') throw new Error('Object access denied'); };
  await assert.rejects(inventoryR2Account(r2), /Object access denied/);
});
function entry(key, body, size = Buffer.byteLength(body), bucket = 'ahtlauncher') {
  return { key, body, size, bucket, etag: `"${createHash('md5').update(body).digest('hex')}"`, lastModified: date };
}
class R2 {
  constructor(objects = []) { this.objects = objects; this.calls = []; this.multipart = []; this.hook = null; this.lock = null; }
  async send(command) {
    const name = command.constructor.name, input = command.input;
    this.calls.push({ name, input });
    const intercepted = await this.hook?.(name, input);
    if (intercepted !== undefined) return intercepted;
    if (name === 'PutObjectCommand' && input.Key === R2_LOCK_KEY) {
      assert.equal(input.IfNoneMatch, '*'); assert.equal(input.ContentLength, 0);
      if (this.lock) throw new Error('precondition failed');
      this.lock = input.Metadata; return {};
    }
    if (name === 'HeadObjectCommand' && input.Key === R2_LOCK_KEY) return { Metadata: this.lock };
    if (name === 'DeleteObjectCommand' && input.Key === R2_LOCK_KEY) { this.lock = null; return {}; }
    if (name === 'ListBucketsCommand') return { Buckets: [{ Name: 'ahtlauncher' }, { Name: 'ahtlauncher-data' }] };
    if (name === 'ListObjectsV2Command') return { IsTruncated: false, Contents: this.objects.filter(item => item.bucket === input.Bucket)
      .map(item => ({ Key: item.key, Size: item.size, ETag: item.etag, LastModified: item.lastModified, StorageClass: 'STANDARD' })) };
    if (name === 'ListMultipartUploadsCommand') return { IsTruncated: false, Uploads: this.multipart.filter(item => item.Bucket === input.Bucket) };
    if (name === 'ListPartsCommand') return { IsTruncated: false, Parts: [{ Size: 31, PartNumber: 1 }] };
    const object = this.objects.find(item => item.key === input.Key && item.bucket === input.Bucket);
    if (name === 'GetObjectCommand') {
      if (!object) throw new Error(`No such object: ${input.Key}`);
      if (input.IfMatch) assert.equal(input.IfMatch, object.etag);
      const Body = Readable.from([Buffer.from(object.body)]);
      Body.transformToString = async () => object.body;
      return { Body, ContentLength: object.size, ETag: object.etag, Metadata: {} };
    }
    if (name === 'HeadObjectCommand') {
      if (!object) throw Object.assign(new Error('Not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return { ContentLength: object.size, ETag: object.etag, Metadata: object.metadata || {} };
    }
    if (name === 'DeleteObjectCommand') { this.objects = this.objects.filter(item => item !== object); return {}; }
    if (name === 'PutObjectCommand') {
      const body = typeof input.Body === 'string' ? input.Body : Buffer.from(input.Body).toString();
      this.objects = this.objects.filter(item => item !== object);
      this.objects.push({ ...entry(input.Key, body), metadata: input.Metadata || {} }); return { ETag: 'written' };
    }
    throw new Error(`Unexpected command ${name}`);
  }
}
const dataWrites = r2 => r2.calls.filter(call => call.name === 'PutObjectCommand' && call.input.Key !== R2_LOCK_KEY);
const archiveDeletes = r2 => r2.calls.filter(call => call.name === 'DeleteObjectCommand' && call.input.Key !== R2_LOCK_KEY);
async function scratch(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-r2-budget-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('decimal ceiling counts old rollback bytes, replacements, staging and exact boundary', () => {
  const input = { storedBytes: 8_000_000_000, multipartBytes: 0, uploads: [{ key: 'overwrite', size: 500_000_000 }] };
  assert.equal(projectR2Storage(input).projectedPeakBytes, 9_000_000_000);
  assert.equal(projectR2Storage(input).allowed, true);
  assert.equal(projectR2Storage({ ...input, multipartBytes: 1 }).allowed, false);
  assert.equal(projectR2Storage({ storedBytes: 5, multipartBytes: 2, uploads: [{ size: 3 }, { size: 7 }] }).projectedPeakBytes, 24);
  for (const bad of [NaN, Infinity, -1, 0, 9_000_000_001, '9000000000']) assert.throws(() => projectR2Storage({ ...input, budgetBytes: bad }));
  for (const bad of [undefined, NaN, -1, '12']) assert.throws(() => projectR2Storage({ ...input, uploads: [{ size: bad }] }));
});

test('inventory includes every bucket and paginated objects, multipart uploads and parts', async () => {
  const r2 = new R2([entry('data', '', 19, 'ahtlauncher-data')]);
  r2.hook = (name, input) => {
    if (name === 'ListObjectsV2Command' && input.Bucket === 'ahtlauncher') return input.ContinuationToken
      ? { IsTruncated: false, Contents: [{ Key: 'second', Size: 20 }] }
      : { IsTruncated: true, NextContinuationToken: 'two', Contents: [{ Key: 'first', Size: 10 }] };
    if (name === 'ListMultipartUploadsCommand' && input.Bucket === 'ahtlauncher') return input.KeyMarker
      ? { IsTruncated: false, Uploads: [{ Key: 'b', UploadId: 'b' }] }
      : { IsTruncated: true, NextKeyMarker: 'b', NextUploadIdMarker: 'b', Uploads: [{ Key: 'a', UploadId: 'a' }] };
    if (name === 'ListPartsCommand') return input.PartNumberMarker
      ? { IsTruncated: false, Parts: [{ Size: 7, PartNumber: 2 }] }
      : { IsTruncated: true, NextPartNumberMarker: '1', Parts: [{ Size: 5, PartNumber: 1 }] };
  };
  const inventory = await inventoryR2Account(r2);
  assert.equal(inventory.storedBytes, 49); assert.equal(inventory.multipartBytes, 24);
});

test('inventory errors, stalled/missing pagination, invalid sizes and nonstandard classes block before data writes', async () => {
  for (const failure of ['denied', 'stalled', 'missing-pagination', 'bad-size', 'paid-storage']) {
    const r2 = new R2();
    r2.hook = name => {
      if (name !== 'ListObjectsV2Command') return;
      if (failure === 'denied') throw new Error('Access denied');
      if (failure === 'stalled') return { IsTruncated: true, NextContinuationToken: 'same', Contents: [] };
      if (failure === 'missing-pagination') return { Contents: [] };
      return { IsTruncated: false, Contents: [{ Key: 'unknown', Size: failure === 'bad-size' ? undefined : 4, StorageClass: failure === 'paid-storage' ? 'STANDARD_IA' : 'STANDARD' }] };
    };
    let uploaded = false;
    await assert.rejects(withR2StorageBudget({ client: r2, uploads: [{ size: 1 }], archiveDir: '' }, () => { uploaded = true; }));
    assert.equal(uploaded, false); assert.equal(r2.lock, null); assert.equal(dataWrites(r2).length, 0);
  }
});

test('existing unfinished uploads block even when their current part sizes fit', async () => {
  const r2 = new R2(); r2.multipart = [{ Bucket: 'ahtlauncher', Key: 'in-progress', UploadId: '1' }];
  await assert.rejects(withR2StorageBudget({ client: r2, uploads: [{ size: 1 }], archiveDir: '' }), /unfinished multipart/);
  assert.equal(dataWrites(r2).length, 0); assert.equal(r2.lock, null);
});

test('concurrent publishers cannot double-spend headroom; failed uploads release the lock', async () => {
  const r2 = new R2();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const first = withR2StorageBudget({ client: r2, uploads: [{ size: 1 }] }, async () => { started(); await hold; });
  await ready;
  await assert.rejects(withR2StorageBudget({ client: r2, uploads: [{ size: 1 }] }), /lock unavailable/);
  release(); await first;
  await assert.rejects(withR2StorageBudget({ client: r2, uploads: [{ size: 1 }] }, () => { throw new Error('Upload failed'); }), /Upload failed/);
  assert.equal(r2.lock, null);
});

test('retention uses the same lock before any manifest reads/deletions', async () => {
  const r2 = new R2(); r2.lock = { owner: 'other-publisher' };
  await assert.rejects(runRetention({ apply: true, storageClient: r2, accountId: credentials.accountId, token: 'fixture',
    fetchImpl: () => { assert.fail('Retention must not start while publisher owns lock'); } }), /lock unavailable/);
  assert.equal(archiveDeletes(r2).length, 0);
});

test('launcher plan checks entire peak before first upload and commits its feed last', async () => scratch(async dir => {
  process.env.CLOUDFLARE_API_TOKEN = 'fixture'; process.env.CLOUDFLARE_ACCOUNT_ID = credentials.accountId;
  const file = path.join(dir, 'asset'); await fs.writeFile(file, '1234567890');
  const planPath = path.join(dir, 'plan.json');
  await fs.writeFile(planPath, JSON.stringify({ uploads: [{ rel: 'launcher/latest.json', file }, { rel: 'launcher/files/new.zip', file }] }));
  const over = new R2([entry('old rollback', '', 8_999_999_975)]);
  await assert.rejects(uploadR2Plan({ planPath, bucket: 'ahtlauncher', client: over, runImpl: () => assert.fail('Must block before upload') }), /projected peak/);
  const r2 = new R2([entry('old rollback', '', 8_999_999_970)]), order = [];
  await uploadR2Plan({ planPath, bucket: 'ahtlauncher', client: r2, runImpl: async (command, args) => {
    const key = args[5].slice('ahtlauncher/'.length);
    assert(r2.lock); order.push(key); r2.objects.push(entry(key, '1234567890')); return {};
  } });
  assert.deepEqual(order, ['launcher/files/new.zip', 'launcher/latest.json']);
  assert.equal(r2.lock, null);
}));

test('plan rechecks storage drift between files and leaves feed untouched on failure', async () => scratch(async dir => {
  const file = path.join(dir, 'asset'); await fs.writeFile(file, 'x');
  const planPath = path.join(dir, 'plan.json');
  await fs.writeFile(planPath, JSON.stringify({ uploads: [{ rel: 'launcher/files/new.zip', file }, { rel: 'launcher/latest.json', file }] }));
  const r2 = new R2(); let writes = 0;
  await assert.rejects(uploadR2Plan({ planPath, bucket: 'ahtlauncher', client: r2, runImpl: async () => {
    writes += 1; r2.objects.push(entry('external-growth', '', 9_000_000_000, 'ahtlauncher-data')); return {};
  } }), /projected peak/);
  assert.equal(writes, 1);
}));

test('direct file and JSON entry points cannot bypass storage failures', async () => scratch(async dir => {
  const r2 = new R2([entry('account usage', '', 9_000_000_000)]);
  const original = S3Client.prototype.send;
  S3Client.prototype.send = command => r2.send(command);
  try {
    const file = path.join(dir, 'file'); await fs.writeFile(file, 'payload');
    await assert.rejects(uploadR2ObjectDirect({ ...credentials, bucket: 'ahtlauncher', key: 'packs/new.zip', file }), /projected peak/);
    await assert.rejects(uploadR2JsonDirect({ ...credentials, bucket: 'ahtlauncher', key: 'latest.json', value: {} }), /projected peak/);
    assert.equal(dataWrites(r2).length, 0);
  } finally { S3Client.prototype.send = original; }
}));

test('actual developer Wrangler upload entry stops before spawning when storage is over budget', async () => scratch(async dir => {
  const main = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
  const start = main.indexOf('async function uploadR2Object('), end = main.indexOf('\nfunction cleanR2AccountId(', start);
  assert(start >= 0 && end > start);
  const r2 = new R2([entry('latest.json', '{"version":"old"}'), entry('stored', '', 9_000_000_000)]);
  const upload = vm.runInNewContext(`${main.slice(start, end)}; uploadR2Object`, {
    fs, importDeveloperModule: async () => ({ withR2StorageBudget: (options, callback) => withR2StorageBudget({ ...options, client: r2 }, callback) }),
    spawnLogged: () => assert.fail('Blocked developer upload must not invoke Wrangler'),
    wranglerCommand: () => 'wrangler', wranglerArgs: args => args, contentType: () => 'application/zip'
  });
  const file = path.join(dir, 'file'); await fs.writeFile(file, 'release');
  await assert.rejects(upload({ bucket: 'ahtlauncher', rel: 'packs/new.zip', file, wranglerCwd: dir }), /projected peak/);
  assert.equal(r2.objects.find(item => item.key === 'latest.json').body, '{"version":"old"}');
}));

test('direct file and JSON uploads still publish exact bytes when budget permits', async () => scratch(async dir => {
  const r2 = new R2(); const original = S3Client.prototype.send;
  S3Client.prototype.send = command => r2.send(command);
  try {
    const file = path.join(dir, 'file'); await fs.writeFile(file, 'verified release');
    await uploadR2ObjectDirect({ ...credentials, bucket: 'ahtlauncher', key: 'packs/new.zip', file,
      sha256: createHash('sha256').update('verified release').digest('hex') });
    await uploadR2JsonDirect({ ...credentials, bucket: 'ahtlauncher', key: 'latest.json', value: { version: 'new' } });
    assert.deepEqual(dataWrites(r2).map(call => call.input.Key), ['packs/new.zip', 'latest.json']);
    assert.equal(r2.objects[0].body, 'verified release');
    assert.equal(r2.objects[1].body, '{"version":"new"}');
    assert.equal(r2.lock, null);
  } finally { S3Client.prototype.send = original; }
}));

test('direct upload rejects a file that grows during storage inventory before writing release bytes', async () => scratch(async dir => {
  const file = path.join(dir, 'release.zip'); await fs.writeFile(file, 'x');
  const r2 = new R2([entry('existing', '', 8_999_999_998)]);
  r2.hook = async name => { if (name === 'ListBucketsCommand') await fs.appendFile(file, 'grew'); };
  const original = S3Client.prototype.send;
  S3Client.prototype.send = command => r2.send(command);
  try {
    await assert.rejects(uploadR2ObjectDirect({ ...credentials, bucket: 'ahtlauncher', key: 'packs/new.zip', file }), /changed/);
    assert.equal(dataWrites(r2).length, 0);
    assert.equal(r2.lock, null);
  } finally { S3Client.prototype.send = original; }
}));

test('direct stream rejects growth, truncation or same-size changes after verification', async () => scratch(async dir => {
  const originalSend = S3Client.prototype.send, originalStream = fileStreams.createReadStream;
  try {
    for (const content of ['larger-than-budget', '', 'NO']) {
      const file = path.join(dir, 'release.zip'); await fs.writeFile(file, 'ok');
      const r2 = new R2([entry('existing', '', 8_999_999_996)]);
      S3Client.prototype.send = command => r2.send(command);
      fileStreams.createReadStream = (...args) => {
        if (args[0] === file) fileStreams.writeFileSync(file, content);
        return originalStream(...args);
      };
      await assert.rejects(uploadR2ObjectDirect({ ...credentials, bucket: 'ahtlauncher', key: 'packs/new.zip', file,
        sha256: createHash('sha256').update('ok').digest('hex') }), /changed/);
      assert.equal(dataWrites(r2).length, 0);
      assert.equal(r2.lock, null);
    }
  } finally {
    S3Client.prototype.send = originalSend;
    fileStreams.createReadStream = originalStream;
  }
}));

test('a concurrent uploader cannot overwrite an immutable modpack object', async () => scratch(async dir => {
  const original = S3Client.prototype.send;
  const r2 = new R2();
  S3Client.prototype.send = command => r2.send(command);
  try {
    const file = path.join(dir, 'release.zip'); await fs.writeFile(file, 'ready');
    const options = { ...credentials, bucket: 'ahtlauncher', key: 'packs/new.zip', file,
      sha256: createHash('sha256').update('ready').digest('hex') };
    await uploadR2ObjectDirect(options);
    assert.equal((await uploadR2ObjectDirect(options)).skipped, true);
    await fs.writeFile(file, 'other');
    await assert.rejects(uploadR2ObjectDirect({ ...options, sha256: createHash('sha256').update('other').digest('hex') }), /Immutable/);
    assert.equal(r2.objects.find(item => item.key === options.key).body, 'ready');
    assert.equal(dataWrites(r2).length, 1);
    assert.equal(r2.lock, null);
  } finally { S3Client.prototype.send = original; }
}));

test('the real publication wrapper holds the writer lock through verification and feed commit', async () => {
  const baseline = { packId: 'a-hard-time-dregora', channel: 'stable', version: '1' };
  const artifact = (key, body) => ({ path: key, size: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  const latest = { ...baseline, version: '2', zip: artifact('packs/new.zip', 'zip'),
    clientManifest: artifact('manifests/new.json', 'manifest') };
  const objects = [entry('latest.json', JSON.stringify(baseline)), ...[
    [latest.zip, 'zip'], [latest.clientManifest, 'manifest']
  ].map(([ref, body]) => ({ ...entry(ref.path, body), metadata: { 'aht-sha256': ref.sha256 } }))];
  const r2 = new R2(objects), original = S3Client.prototype.send;
  S3Client.prototype.send = command => r2.send(command);
  let unblock, entered;
  const paused = new Promise(resolve => { unblock = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  try {
    const publishing = commitR2ModpackRelease({ ...credentials, bucket: 'ahtlauncher', target: 'stable', latest, baseline,
      verifyPublic: async () => { assert(r2.lock); entered(); await paused; } });
    await waiting;
    assert.equal(JSON.parse(r2.objects.find(item => item.key === 'latest.json').body).version, '1');
    await assert.rejects(uploadR2JsonDirect({ ...credentials, bucket: 'ahtlauncher', key: 'latest.json', value: { version: '3' } }), /lock unavailable/);
    unblock();
    assert.equal((await publishing).committed, true);
    assert.deepEqual(JSON.parse(r2.objects.find(item => item.key === 'latest.json').body), latest);
    assert.equal(r2.lock, null);
  } finally { unblock(); S3Client.prototype.send = original; }
});

test('developer Wrangler upload rejects a file that grows during storage inventory before spawning', async () => scratch(async dir => {
  const main = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
  const start = main.indexOf('async function uploadR2Object('), end = main.indexOf('\nfunction cleanR2AccountId(', start);
  const file = path.join(dir, 'release.zip'); await fs.writeFile(file, 'x');
  const r2 = new R2([entry('existing', '', 8_999_999_998)]);
  r2.hook = async name => { if (name === 'ListBucketsCommand') await fs.appendFile(file, 'grew'); };
  let spawned = false;
  const upload = vm.runInNewContext(`${main.slice(start, end)}; uploadR2Object`, {
    fs, importDeveloperModule: async () => ({ withR2StorageBudget: (options, callback) => withR2StorageBudget({ ...options, client: r2 }, callback) }),
    spawnLogged: () => { spawned = true; },
    wranglerCommand: () => 'wrangler', wranglerArgs: args => args, contentType: () => 'application/zip'
  });
  await assert.rejects(upload({ bucket: 'ahtlauncher', rel: 'packs/new.zip', file, wranglerCwd: dir }), /changed/);
  assert.equal(spawned, false);
  assert.equal(r2.lock, null);
}));

function rollbackStore() {
  return new R2([
    entry('latest.json', JSON.stringify({ version: '1.0.3', zip: { path: 'packs/aht-1.0.3.zip' }, cacheManifest: { path: 'manifests/cache.json' } })),
    entry('ptb/latest.json', JSON.stringify({ version: '2.0.3', zip: { path: 'packs/aht-2.0.3.zip' } })),
    entry('launcher/latest.json', JSON.stringify({ version: '0.2.15', artifact: 'launcher/current.exe' })),
    entry('manifests/cache.json', JSON.stringify({ dependencies: ['packs/aht-1.0.1.zip'] })),
    entry('packs/aht-1.0.3.zip', 'live'), entry('packs/aht-1.0.2.zip', 'rollback'),
    entry('packs/aht-1.0.1.zip', 'still needed'), entry('ptb/packs/aht-2.0.3.zip', 'ptb live'),
    entry('launcher/current.exe', 'launcher'), entry('packs/aht-9.0.0.zip', 'future'), entry('packs/unknown.zip', 'unknown')
  ]);
}

test('older rollback is deleted only after durable local hash/receipt verification; active/transitive references survive', async () => scratch(async dir => {
  const r2 = rollbackStore();
  r2.hook = async (name, input) => {
    if (name === 'DeleteObjectCommand' && input.Key !== R2_LOCK_KEY) {
      const files = await fs.readdir(dir);
      const receipt = JSON.parse(await fs.readFile(path.join(dir, files.find(file => file.endsWith('.json'))), 'utf8'));
      const data = await fs.readFile(receipt.file);
      assert.equal(receipt.key, 'packs/aht-1.0.2.zip');
      assert.equal(receipt.sha256, createHash('sha256').update(data).digest('hex'));
    }
  };
  await withR2StorageLock(r2, async () => archiveR2Rollbacks({ client: r2, inventory: await inventoryR2Account(r2), bucket: 'ahtlauncher', archiveDir: dir, bytesNeeded: 8, now }));
  assert.deepEqual(archiveDeletes(r2).map(call => call.input.Key), ['packs/aht-1.0.2.zip']);
  for (const key of ['packs/aht-1.0.3.zip', 'packs/aht-1.0.1.zip', 'ptb/packs/aht-2.0.3.zip', 'packs/aht-9.0.0.zip', 'packs/unknown.zip']) assert(r2.objects.some(item => item.key === key));
}));

test('recent publication and insufficient eligible space preserve cloud copies', async () => scratch(async dir => {
  for (const reason of ['recent', 'insufficient']) {
    const r2 = rollbackStore();
    if (reason === 'recent') r2.objects[0].lastModified = new Date(now - 1000);
    await assert.rejects(archiveR2Rollbacks({ client: r2, inventory: await inventoryR2Account(r2), bucket: 'ahtlauncher', archiveDir: dir, bytesNeeded: reason === 'recent' ? 8 : 1000, now }), /eligible rollback/);
    assert.equal(archiveDeletes(r2).length, 0);
  }
}));

test('failed archive download or manifest drift never deletes rollback', async () => scratch(async dir => {
  for (const failure of ['disk', 'short-download', 'manifest-drift']) {
    const r2 = rollbackStore(); let reads = 0;
    r2.hook = (name, input) => {
      if (name === 'GetObjectCommand' && input.Key === 'packs/aht-1.0.2.zip' && failure === 'short-download') {
        return { ContentLength: 8, ETag: r2.objects.find(item => item.key === input.Key).etag, Body: Readable.from(['short']), Metadata: {} };
      }
      if (name === 'GetObjectCommand' && input.Key === 'latest.json' && ++reads === 2 && failure === 'manifest-drift') {
        r2.objects[0] = entry('latest.json', JSON.stringify({ version: '1.0.4', zip: { path: 'packs/aht-1.0.2.zip' } }));
      }
    };
    const archiveDir = path.join(dir, failure);
    if (failure === 'disk') await fs.writeFile(archiveDir, 'not a directory');
    await assert.rejects(archiveR2Rollbacks({ client: r2, inventory: await inventoryR2Account(r2), bucket: 'ahtlauncher', archiveDir, bytesNeeded: 8, now }));
    assert.equal(archiveDeletes(r2).length, 0);
  }
}));

test('incoming full pack prunes superseded ZIP without local backup and guard rechecks storage', async () => scratch(async dir => {
  const r2 = rollbackStore(); const stored = (await inventoryR2Account(r2)).storedBytes;
  r2.objects[0].lastModified = new Date();
  let wrote = false;
  await withR2StorageBudget({ client: r2, uploads: [{ key: 'packs/aht-1.0.4.zip', size: 4 }], budgetBytes: stored, archiveDir: dir }, () => { wrote = true; });
  assert.equal(wrote, true); assert.equal(archiveDeletes(r2).length, 1);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.ok(r2.objects.some(item => item.key === 'packs/aht-1.0.3.zip'));
  assert.ok(r2.objects.some(item => item.key === 'packs/aht-9.0.0.zip'));
}));

test('explicit superseded version approval still cannot delete active or incoming full packs', async () => {
  for (const key of ['packs/aht-1.0.3.zip', 'packs/aht-9.0.0.zip']) {
    const r2 = rollbackStore();
    await assert.rejects(deleteSupersededR2Packs({ client:r2, inventory:await inventoryR2Account(r2),
      approvedKeys:[key], uploads:[{ key:'packs/aht-9.0.0.zip', size:6 }] }), /active, pending/);
    assert.equal(archiveDeletes(r2).length, 0);
  }
  const r2 = rollbackStore();
  const removed = await deleteSupersededR2Packs({client:r2,inventory:await inventoryR2Account(r2),approvedKeys:['packs/aht-9.0.0.zip']});
  assert.ok(removed.some(x=>x.key==='packs/aht-9.0.0.zip'));
  assert.ok(archiveDeletes(r2).every(x=>x.input.IfMatch));
});

test('CI cannot delete rollback copies using temporary runner storage', async () => scratch(async dir => {
  const r2 = rollbackStore();
  process.env.CI = 'true';
  try {
    await assert.rejects(archiveR2Rollbacks({ client: r2, inventory: await inventoryR2Account(r2), bucket: 'ahtlauncher', archiveDir: dir, bytesNeeded: 8, now }), /ephemeral CI/);
    assert.equal(archiveDeletes(r2).length, 0);
  } finally { delete process.env.CI; }
}));
