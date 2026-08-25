import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadVerifiedManagedManifest } from '../src/managedManifest.js';
import { captureManagedModFingerprint, scanManagedIntegrity } from '../src/localChanges.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-managed-security-'));
const instanceDir = path.join(root, 'instance');
const releaseDir = path.join(root, 'release');
const modPath = path.join(instanceDir, 'mods', 'managed.jar');
const legacyManagedPath = path.join(instanceDir, '.aht-launcher', 'managed-files.json');
const expectedBytes = Buffer.from('trusted managed mod\n');
const expectedSha256 = crypto.createHash('sha256').update(expectedBytes).digest('hex');
await fs.mkdir(path.dirname(modPath), { recursive: true });
await fs.mkdir(path.dirname(legacyManagedPath), { recursive: true });
await fs.mkdir(releaseDir, { recursive: true });
await fs.writeFile(modPath, expectedBytes);
await fs.writeFile(legacyManagedPath, '[]\n', 'utf8');

const manifest = {
  format: 'aht-client-manifest-v1',
  packId: 'a-hard-time-dregora',
  version: '2.9.0',
  files: [{ relativePath: 'mods/managed.jar', size: expectedBytes.length, sha256: expectedSha256 }]
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
const manifestPath = path.join(releaseDir, 'client-manifest.json');
await fs.writeFile(manifestPath, manifestBytes);
const latest = {
  packId: manifest.packId,
  version: manifest.version,
  installMode: 'full-client-zip',
  clientManifest: {
    format: manifest.format,
    path: path.basename(manifestPath),
    size: manifestBytes.length,
    sha256: manifestSha256
  }
};

const verified = await loadVerifiedManagedManifest({
  latestSource: path.join(releaseDir, 'latest.json'),
  latest
});
if (verified.managedFiles.length !== 1 || verified.managedFiles[0].sha256 !== expectedSha256) {
  throw new Error(`Verified client manifest did not produce authoritative managed files: ${JSON.stringify(verified)}`);
}

const valid = await scanManagedIntegrity(instanceDir, {
  managedFiles: verified.managedFiles,
  ignoreLocalManaged: true
});
if (!valid.valid || valid.counts.managed !== 1 || valid.counts.corrupted !== 0) {
  throw new Error(`A tampered local managed-files cache overrode the verified manifest: ${JSON.stringify(valid)}`);
}
const firstFingerprint = await captureManagedModFingerprint(instanceDir, {
  managedFiles: verified.managedFiles,
  ignoreLocalManaged: true
});
await fs.writeFile(legacyManagedPath, JSON.stringify([{ relativePath: 'mods/fake.jar', sha256: '0'.repeat(64) }]));
const secondFingerprint = await captureManagedModFingerprint(instanceDir, {
  managedFiles: verified.managedFiles,
  ignoreLocalManaged: true
});
if (firstFingerprint.digest !== secondFingerprint.digest) {
  throw new Error('The ignored pack-local managed cache still influenced the authoritative fingerprint.');
}

await fs.writeFile(modPath, 'tampered mod\n', 'utf8');
const corrupted = await scanManagedIntegrity(instanceDir, {
  managedFiles: verified.managedFiles,
  ignoreLocalManaged: true
});
if (corrupted.valid || corrupted.changed?.[0]?.path !== 'mods/managed.jar') {
  throw new Error(`Verified manifest failed to catch a modified managed mod: ${JSON.stringify(corrupted)}`);
}

const tamperedManifestPath = path.join(releaseDir, 'tampered-client-manifest.json');
await fs.writeFile(tamperedManifestPath, Buffer.from(JSON.stringify({ ...manifest, version: 'attacker-version' })));
let tamperedRejected = false;
try {
  await loadVerifiedManagedManifest({
    latestSource: path.join(releaseDir, 'latest.json'),
    latest: {
      ...latest,
      clientManifest: { ...latest.clientManifest, path: path.basename(tamperedManifestPath) }
    }
  });
} catch (error) {
  tamperedRejected = /SHA-256|size mismatch/i.test(error.message || String(error));
}
if (!tamperedRejected) throw new Error('A client manifest with the wrong SHA-256 was accepted.');

console.log(JSON.stringify({
  authoritativeManagedFiles: verified.managedFiles.length,
  localCacheIgnored: firstFingerprint.digest === secondFingerprint.digest,
  modifiedModRejected: corrupted.valid === false,
  tamperedManifestRejected: tamperedRejected
}, null, 2));
