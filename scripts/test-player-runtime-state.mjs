import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { captureManagedIntegrityFingerprint, isLaunchCriticalManagedPath } from '../src/localChanges.js';
import { isManagedClientPackPath } from '../src/clientPackFormat.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-player-state-'));
const statePath = 'fancymenu_data/last_world.fmdata';
const bytes = Buffer.from('required mod fixture');
const options = {managedFiles: [{relativePath: 'mods/required.jar', sha256: crypto.createHash('sha256').update(bytes).digest('hex')}]};
try {
  await fs.mkdir(path.join(root, 'mods'));
  await fs.mkdir(path.join(root, 'fancymenu_data'));
  await fs.writeFile(path.join(root, 'mods/required.jar'), bytes);
  assert.equal(isManagedClientPackPath(statePath), false);
  assert.equal(isLaunchCriticalManagedPath(statePath), false);
  assert.equal(isLaunchCriticalManagedPath('fancymenu_data/unknown.jar'), true);
  await fs.writeFile(path.join(root, statePath), 'world one');
  const before = await captureManagedIntegrityFingerprint(root, options);
  assert.equal(before.pathsValid, true);
  await fs.writeFile(path.join(root, statePath), 'a different world selected by ordinary gameplay');
  const after = await captureManagedIntegrityFingerprint(root, options);
  assert.equal(after.pathsValid, true);
  assert.equal(after.digest, before.digest, 'Player state must not invalidate prepared Play');
  await fs.unlink(path.join(root, statePath));
  assert.equal((await captureManagedIntegrityFingerprint(root, options)).pathsValid, true, 'Absent last-world history must not block Play');
  await fs.writeFile(path.join(root, 'fancymenu_data/unknown.jar'), 'unapproved');
  assert.equal((await captureManagedIntegrityFingerprint(root, options)).pathsValid, false, 'Unexpected payloads still block Play');
  await fs.unlink(path.join(root, 'fancymenu_data/unknown.jar'));
  let linkTest = 'PASSED';
  try {
    await fs.symlink(path.join(root, 'mods/required.jar'), path.join(root, statePath), 'file');
    assert.equal((await captureManagedIntegrityFingerprint(root, options)).pathsValid, false, 'A link cannot use the regular-file exception');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    linkTest = 'SKIPPED: OS symlink privilege unavailable';
  }
  console.log(JSON.stringify({ok: true, playerStateDoesNotBlockPlay: true, unexpectedPayloadRejected: true, linkTest}));
} finally {
  await fs.rm(root, {recursive: true, force: true});
}
