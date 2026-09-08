import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureManagedIntegrityFingerprint, captureManagedModFingerprint, scanManagedIntegrity } from '../src/localChanges.js';
import { hashFile, writeJsonFile } from '../src/utils.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(repoRoot, 'src', 'localChanges.js'), 'utf8');

assert(!source.includes('files.push(...await walkFiles'), 'localChanges walker must not recursively spread child arrays');
assert(source.includes('maxFiles'), 'localChanges walker must bound nested scans by the requested issue limit');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-localchanges-large-tree-'));
const instanceDir = path.join(root, 'A Hard Time');
const managedDir = path.join(instanceDir, 'mods', 'managed-tree');
const largeDir = path.join(managedDir, 'huge');
const stateDir = path.join(instanceDir, '.aht-launcher');

try {
  await fs.mkdir(largeDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const knownJar = path.join(managedDir, 'known.jar');
  const managedConfig = path.join(instanceDir, 'config', 'aht.cfg');
  await fs.mkdir(path.dirname(managedConfig), { recursive: true });
  await fs.writeFile(knownJar, 'managed jar', 'utf8');
  await fs.writeFile(managedConfig, 'mode=alpha', 'utf8');

  const extraCount = 2500;
  const batchSize = 250;
  for (let start = 0; start < extraCount; start += batchSize) {
    const writes = [];
    for (let index = start; index < Math.min(extraCount, start + batchSize); index += 1) {
      writes.push(fs.writeFile(path.join(largeDir, `${String(index).padStart(6, '0')}.jar`), '', 'utf8'));
    }
    await Promise.all(writes);
  }

  await writeJsonFile(path.join(stateDir, 'managed-files.json'), [
    {
      relativePath: 'mods/managed-tree/known.jar',
      sha256: await hashFile(knownJar, 'sha256'),
      source: 'test'
    },
    {
      relativePath: 'config/aht.cfg',
      sha256: await hashFile(managedConfig, 'sha256'),
      source: 'test'
    }
  ]);

  const scan = await scanManagedIntegrity(instanceDir, { limit: 5 });
  assert.equal(scan.counts.managed, 2);
  assert.equal(scan.counts.changed, 0);
  assert.equal(scan.counts.missing, 0);
  assert.equal(scan.counts.added, 5);
  assert.equal(scan.counts.corrupted, 5);
  assert.equal(scan.truncated, true);
  assert(scan.added.every((item) => item.path.startsWith('mods/managed-tree/huge/')), JSON.stringify(scan.added));
  assert(scan.fingerprint?.digest, 'full integrity scan must produce a reusable fingerprint');

  const unchangedIntegrityFingerprint = await captureManagedIntegrityFingerprint(instanceDir);
  assert.equal(unchangedIntegrityFingerprint.digest, scan.fingerprint.digest, 'unchanged managed files must keep the same full-installation fingerprint');

  const unchangedModFingerprint = await captureManagedModFingerprint(instanceDir);

  await fs.writeFile(knownJar, 'managed JAR', 'utf8');
  const rewrittenModFingerprint = await captureManagedModFingerprint(instanceDir);
  assert.notEqual(rewrittenModFingerprint.digest, unchangedModFingerprint.digest, 'same-size mod rewrites must change the mod-tree fingerprint');
  const rewrittenIntegrityFingerprint = await captureManagedIntegrityFingerprint(instanceDir);
  assert.notEqual(rewrittenIntegrityFingerprint.digest, unchangedIntegrityFingerprint.digest, 'same-size mod rewrites must change the full-installation fingerprint');

  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(managedConfig, 'mode=omega', 'utf8');
  const rewrittenConfigFingerprint = await captureManagedIntegrityFingerprint(instanceDir);
  assert.notEqual(rewrittenConfigFingerprint.digest, rewrittenIntegrityFingerprint.digest, 'same-size rewrites outside mods must change the full-installation fingerprint');

  const otgDir = path.join(instanceDir, 'mods', 'OpenTerrainGenerator');
  await fs.mkdir(otgDir, { recursive: true });
  await fs.writeFile(path.join(otgDir, 'runtime.dat'), 'runtime data', 'utf8');
  const otgFingerprint = await captureManagedModFingerprint(instanceDir);
  assert.equal(otgFingerprint.digest, rewrittenModFingerprint.digest, 'OpenTerrainGenerator runtime data must not affect the mod-tree fingerprint');

  console.log(JSON.stringify({
    ok: true,
    root,
    counts: scan.counts,
    truncated: scan.truncated,
    fingerprintEntries: scan.fingerprint.entryCount
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
