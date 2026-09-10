import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { withR2StorageLock } from './r2StorageBudget.js';

export const ROLLBACK_DOWNLOAD_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const liveKeys = ['latest.json', 'ptb/latest.json', 'launcher/latest.json'];

// Current policy: retain the live full pack and the incoming update, without
// keeping superseded full-pack rollback archives. Other release types and
// future/staged pack versions are outside this deletion policy.
export async function deleteSupersededR2Packs({ client, inventory, bucket = 'ahtlauncher', uploads = [], approvedKeys = [] }) {
  if (bucket !== 'ahtlauncher') throw new Error('Pack retention is restricted to the launcher release bucket.');
  if (!approvedKeys.length && !inventory.objects.some(item => item.bucket === bucket
      && /^(?:ptb\/)?packs\/[^/]*[-_]\d+\.\d+\.\d+\.zip$/i.test(item.key))) return [];
  return withR2StorageLock(client, async () => {
    const before = await readManifests(client, bucket);
    const pending = new Set(uploads.map(item => item.key));
    const approved = new Set(approvedKeys);
    const selected = inventory.objects.filter(item => {
      if (item.bucket !== bucket || pending.has(item.key) || before.references.has(item.key)) return false;
      const match = item.key.match(/^(ptb\/)?packs\/[^/]*[-_](\d+\.\d+\.\d+)\.zip$/i);
      if (!match) return false;
      const feed = before.manifests[match[1] ? 'ptb/latest.json' : 'latest.json'];
      return item.etag && Number.isSafeInteger(item.size) && item.size > 0
        && (olderVersion(match[2], String(feed?.version || '')) || approved.has(item.key));
    });
    if (approvedKeys.some(key => !selected.some(item => item.key === key))) throw new Error('An approved superseded pack is absent, active, pending, or invalid.');
    if (!selected.length) return [];
    const current = await readManifests(client, bucket);
    if (JSON.stringify(current.digests) !== JSON.stringify(before.digests)) throw new Error('Release manifests changed during retention; cloud copies preserved.');
    const deleted = [];
    for (const item of selected) {
      const remote = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: item.key }));
      if (remote.ETag !== item.etag || remote.ContentLength !== item.size) throw new Error('Superseded pack changed; cloud copy preserved.');
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.key, IfMatch: item.etag }));
      deleted.push({ key: item.key, size: item.size, etag: item.etag });
    }
    return deleted;
  });
}

async function readManifests(client, bucket) {
  const manifests = {};
  const digests = {};
  const queue = [...liveKeys];
  const references = new Set(liveKeys);
  // Follow referenced JSON as well as top-level feeds. Cache manifests and
  // supported delta/update dependencies must remain available.
  for (let index = 0; index < queue.length; index += 1) {
    if (queue.length > 1000) throw new Error('Too many release manifests to prove safe rollback archival.');
    const key = queue[index];
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!Number.isSafeInteger(response.ContentLength) || response.ContentLength > 8 * 1024 * 1024) throw new Error('Unknown or oversized release manifest.');
    const body = await response.Body.transformToString('utf8');
    if (Buffer.byteLength(body) !== response.ContentLength) throw new Error('Release manifest size changed.');
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid release manifest.');
    manifests[key] = value;
    digests[key] = createHash('sha256').update(body).digest('hex');
    const visit = item => {
      if (Array.isArray(item)) return item.forEach(visit);
      if (item && typeof item === 'object') return Object.values(item).forEach(visit);
      if (typeof item !== 'string') return;
      let ref = item.replaceAll('\\', '/');
      try {
        // Conservatively protect matching R2 paths even on historical origins.
        ref = decodeURIComponent(new URL(item).pathname).replace(/^\/+/, '').replace(/^releases\//, '');
      } catch {}
      if (key.startsWith('ptb/') && /^(packs|patches|manifests|cache)\//.test(ref)) ref = `ptb/${ref}`;
      if (!/^(?:ptb\/)?(?:packs|patches|manifests|cache)\/|^launcher\/|^server\//.test(ref)) return;
      if (ref.includes('\0') || ref.split('/').includes('..')) throw new Error('Unsafe release reference.');
      if (references.has(ref)) return;
      references.add(ref);
      if (ref.endsWith('.json')) queue.push(ref);
    };
    visit(value);
  }
  return { manifests, digests, references };
}

function olderVersion(version, current) {
  if (![version, current].every(value => /^\d+\.\d+\.\d+$/.test(value))) return false;
  const a = version.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

export function selectRollbackArchives({ objects, manifests, references, bytesNeeded, now = Date.now() }) {
  const candidates = objects.filter(item => {
    const match = item.key.match(/^(ptb\/)?packs\/[^/]*[-_](\d+\.\d+\.\d+)\.zip$/i);
    if (!match || references.has(item.key)) return false;
    const feedKey = match[1] ? 'ptb/latest.json' : 'latest.json';
    const feed = objects.find(object => object.key === feedKey);
    const modified = new Date(item.lastModified).getTime();
    const superseded = new Date(feed?.lastModified).getTime();
    // A full week after channel publication protects clients still fetching
    // ranges using the previous feed. Unknown ages never make an object eligible.
    return olderVersion(match[2], String(manifests[feedKey]?.version || ''))
      && Number.isFinite(modified) && Number.isFinite(superseded)
      && modified <= superseded && now - superseded >= ROLLBACK_DOWNLOAD_GRACE_MS;
  }).sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified) || a.key.localeCompare(b.key));
  const selected = [];
  let freedBytes = 0;
  for (const item of candidates) {
    if (freedBytes >= bytesNeeded) break;
    if (!item.etag || !Number.isSafeInteger(item.size) || item.size <= 0) continue;
    selected.push(item);
    freedBytes += item.size;
  }
  if (freedBytes < bytesNeeded) throw new Error(`R2 upload blocked: eligible rollback ZIPs cannot free ${bytesNeeded} bytes. Live references, recent downloads, and unknown objects are protected.`);
  return selected;
}

async function fileDigest(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest('hex') };
}

export async function archiveR2Rollbacks(options) {
  return withR2StorageLock(options.client, () => archiveR2RollbacksLocked(options));
}

async function archiveR2RollbacksLocked({ client, inventory, bucket, archiveDir, bytesNeeded, now = Date.now() }) {
  if (bucket !== 'ahtlauncher') throw new Error('Rollback archival is restricted to the launcher release bucket.');
  if (process.env.CI) throw new Error('Rollback copies require durable local storage; ephemeral CI runners cannot remove cloud rollback archives.');
  if (!path.isAbsolute(archiveDir)) throw new Error('AHT_R2_ROLLBACK_DIR must be an absolute durable local directory.');
  const before = await readManifests(client, bucket);
  const objects = inventory.objects.filter(item => item.bucket === bucket);
  const selected = selectRollbackArchives({ objects, ...before, bytesNeeded, now });
  await fsp.mkdir(archiveDir, { recursive: true });
  const root = await fsp.realpath(archiveDir);
  const receipts = [];
  // Complete and read back ALL necessary local copies before the first deletion.
  for (const item of selected) {
    const id = createHash('sha256').update(`${bucket}\n${item.key}\n${item.etag}`).digest('hex');
    const destination = path.join(root, `${id}.zip`);
    const partial = path.join(root, `${id}.${randomUUID()}.partial`);
    const remote = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.key, IfMatch: item.etag }));
    if (remote.ContentLength !== item.size || remote.ETag !== item.etag) throw new Error('Rollback object changed before archival.');
    const hash = createHash('sha256');
    let size = 0;
    try {
      await pipeline(remote.Body, new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length; hash.update(chunk); callback(null, chunk);
      } }), fs.createWriteStream(partial, { flags: 'wx' }));
      const sha256 = hash.digest('hex');
      if (size !== item.size || (remote.Metadata?.['aht-sha256'] && remote.Metadata['aht-sha256'] !== sha256)) throw new Error('Rollback download failed size/hash verification.');
      const handle = await fsp.open(partial, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      const readback = await fileDigest(partial);
      if (readback.size !== size || readback.sha256 !== sha256) throw new Error('Local rollback readback failed.');
      // Existing retained copies are immutable; verify instead of overwriting.
      try {
        await fsp.link(partial, destination);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fileDigest(destination);
        if (existing.size !== size || existing.sha256 !== sha256) throw new Error('Existing local rollback copy failed verification.');
      }
      const receipt = { bucket, key: item.key, etag: item.etag, size, sha256, file: destination,
        archivedAt: new Date(now).toISOString(), manifests: before.manifests, manifestDigests: before.digests };
      const receiptPath = path.join(root, `${id}.json`);
      const record = await fsp.open(receiptPath, 'w');
      try { await record.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); await record.sync(); } finally { await record.close(); }
      if (JSON.parse(await fsp.readFile(receiptPath, 'utf8')).sha256 !== sha256) throw new Error('Rollback receipt readback failed.');
      receipts.push(receipt);
    } finally {
      await fsp.unlink(partial).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  const current = await readManifests(client, bucket);
  if (JSON.stringify(current.digests) !== JSON.stringify(before.digests)) throw new Error('Release manifests changed during archival; cloud copies preserved.');
  for (const receipt of receipts) {
    const remote = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: receipt.key }));
    if (remote.ETag !== receipt.etag || remote.ContentLength !== receipt.size || current.references.has(receipt.key)) throw new Error('Rollback changed or became active; cloud copy preserved.');
    const local = await fileDigest(receipt.file);
    if (local.size !== receipt.size || local.sha256 !== receipt.sha256) throw new Error('Local rollback changed; cloud copy preserved.');
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: receipt.key }));
  }
  return receipts;
}
