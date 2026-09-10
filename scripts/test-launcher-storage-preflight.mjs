import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { uploadR2Plan } from './upload-r2-plan.mjs';
import { R2_LOCK_KEY } from '../src/r2StorageBudget.js';

// CI-only release boundary: no developer IPC, credentials, pack deletion or network.
class Storage {
  constructor(size = 0) { this.size = size; this.lock = null; this.unfinished = false; }
  async send(command) {
    const { Key, Metadata, IfNoneMatch } = command.input;
    switch (command.constructor.name) {
      case 'PutObjectCommand':
        assert.equal(Key, R2_LOCK_KEY); assert.equal(IfNoneMatch, '*');
        if (this.lock) throw Error('Already locked');
        this.lock = Metadata; return {};
      case 'HeadObjectCommand': assert.equal(Key, R2_LOCK_KEY); return { Metadata: this.lock };
      case 'DeleteObjectCommand': assert.equal(Key, R2_LOCK_KEY); this.lock = null; return {};
      case 'ListBucketsCommand': return { Buckets: [{ Name: 'ahtlauncher' }] };
      case 'ListObjectsV2Command': return { IsTruncated: false, Contents: [{ Key: 'existing', Size: this.size }] };
      case 'ListMultipartUploadsCommand': return { IsTruncated: false, Uploads: this.unfinished ? [{ Key: 'pending', UploadId: 'test' }] : [] };
      case 'ListPartsCommand': return { IsTruncated: false, Parts: [{ Size: 1 }] };
      default: assert.fail(`Unexpected storage operation: ${command.constructor.name}`);
    }
  }
}

test('launcher publication admits a complete plan, keeps the writer lock and commits the feed last', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-launcher-storage-'));
  const previous = { token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID };
  process.env.CLOUDFLARE_API_TOKEN = 'fixture'; process.env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
  try {
    const file = path.join(dir, 'asset'), planPath = path.join(dir, 'plan.json');
    await fs.writeFile(file, '0123456789');
    await fs.writeFile(planPath, JSON.stringify({ uploads: [{ rel: 'launcher/latest.json', file }, { rel: 'launcher/files/new.zip', file }] }));
    const over = new Storage(8_999_999_975);
    await assert.rejects(uploadR2Plan({ planPath, bucket: 'ahtlauncher', client: over, runImpl: () => assert.fail('No upload allowed') }), /projected peak/);
    assert.equal(over.lock, null);
    const pending = new Storage(); pending.unfinished = true;
    await assert.rejects(uploadR2Plan({ planPath, bucket: 'ahtlauncher', client: pending, runImpl: () => assert.fail('No upload allowed') }), /unfinished multipart/);
    const good = new Storage(8_999_999_970), order = [];
    await uploadR2Plan({ planPath, bucket: 'ahtlauncher', client: good, runImpl: async (_, args) => {
      assert.ok(good.lock); order.push(args[5]); good.size += 10; return {};
    } });
    assert.deepEqual(order, ['ahtlauncher/launcher/files/new.zip', 'ahtlauncher/launcher/latest.json']);
    assert.equal(good.lock, null);
    const drift = new Storage(), writes = [];
    await assert.rejects(uploadR2Plan({ planPath, bucket: 'ahtlauncher', client: drift, runImpl: async (_, args) => {
      writes.push(args[5]); drift.size = 9_000_000_000; return {};
    } }), /projected peak/);
    assert.deepEqual(writes, ['ahtlauncher/launcher/files/new.zip']);
    assert.equal(drift.lock, null);
  } finally {
    if (previous.token === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = previous.token;
    if (previous.account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = previous.account;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
