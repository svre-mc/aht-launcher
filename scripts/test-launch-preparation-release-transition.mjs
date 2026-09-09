import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { releaseForInstalledPack, preparedRuntimeMatchesInstalled, matchingManagedFileStates } from '../src/launchPreparationPolicy.js';
import { verifyManagedIntegritySnapshot } from '../src/localChanges.js';

const minecraft = { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860' }] };
const oldRelease = { packId: 'aht', version: '2.8.653', minecraft, clientManifest: { path: 'old.json' } };
const installed = { packId: 'aht', version: '2.8.654', minecraft };
assert.equal(releaseForInstalledPack(installed, oldRelease), installed);
assert.equal(releaseForInstalledPack(installed, { ...oldRelease, packId: 'ptb', version: installed.version }), installed);
assert(preparedRuntimeMatchesInstalled({ installed: oldRelease }, installed));
assert(!preparedRuntimeMatchesInstalled({ installed: oldRelease }, { ...installed, minecraft: { ...minecraft, version: '1.13' } }));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-release-transition-'));
const record = (name, bytes) => ({ relativePath: `mods/${name}.jar`, size: Buffer.byteLength(bytes), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
try {
  await fs.mkdir(path.join(root, 'mods'));
  const original = [record('unchanged', 'trusted'), record('retired', 'old')];
  for (const [name, bytes] of [['unchanged', 'trusted'], ['retired', 'old']]) await fs.writeFile(path.join(root, `mods/${name}.jar`), bytes);
  const previous = { ...await verifyManagedIntegritySnapshot(root, { managedFiles: original, ignoreLocalManaged: true, forceAll: true }), complete: true };
  await fs.rename(path.join(root, 'mods/retired.jar'), path.join(root, 'mods/canonical.jar'));
  await fs.writeFile(path.join(root, 'mods/canonical.jar'), 'new');
  const next = [original[0], record('canonical', 'new')];
  const previousFileStates = matchingManagedFileStates(previous, next);
  const update = await verifyManagedIntegritySnapshot(root, { managedFiles: next, ignoreLocalManaged: true, previousFileStates });
  assert(update.valid);
  assert.equal(update.hashedFiles, 1, 'Only the new JAR should need hashing, not the whole pack.');
  const changedHash = matchingManagedFileStates(previous, [record('unchanged', 'changed')]);
  assert.equal(changedHash.length, 0, 'Changed expected bytes must never inherit an old trusted file state.');
  await fs.writeFile(path.join(root, 'mods/hidden.jar'), 'unexpected');
  const injected = await verifyManagedIntegritySnapshot(root, { managedFiles: next, ignoreLocalManaged: true, previousFileStates: update.fileStates });
  assert(!injected.valid, 'Unexpected payloads must still block Play after an update.');
  console.log('Release transition passed: correct manifest, unchanged runtime reused, changed-only hashing, injected mod rejected.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
