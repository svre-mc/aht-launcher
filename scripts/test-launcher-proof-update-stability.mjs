import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerLauncherProofFixture } from './helpers/launcher-proof-fixture.mjs';
import {
  inspectLauncherProof,
  launcherProofJavaArgs,
  launcherProofPath,
  writeLauncherProof
} from '../src/launcherProof.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-proof-update-'));
const instanceDir = path.join(root, 'A Hard Time');
const stableProofDir = path.join(root, 'launcher-user-data', '.aht-launcher');
const config = {
  packId: 'a-hard-time-dregora',
  instanceDir,
  launcherProof: {
    enabled: true,
    required: true,
    proofDir: stableProofDir,
    baseUrl: 'https://worker.test/',
    keyId: 'aht-launcher-attestation-v2'
  }
};
const identity = {
  installId: 'stable-install-id',
  minecraftUsername: 'UpdateProofPlayer',
  minecraftUuid: '01234567-89ab-4def-8123-456789abcdef',
  launcherChannel: 'player',
  appVersion: '0.1.83',
  platform: 'win32',
  arch: 'x64'
};
const installed = { packId: config.packId, version: '2.8.534', minecraft: { version: '1.12.2', modLoaders: [] } };
const latest = { packId: config.packId, version: '2.8.534', minecraft: installed.minecraft };

const fixtureFetch = async (_url, options) => ({
  ok: true,
  json: async () => workerLauncherProofFixture(JSON.parse(options.body))
});
const first = await writeLauncherProof({ config, identity, installed, latest, recoverySecret: 'fixture_recovery_secret_123456789012345', fetchImpl: fixtureFetch });
const stableFile = launcherProofPath(instanceDir, identity, { proofDir: stableProofDir });
const legacyFile = launcherProofPath(instanceDir, identity);
assert.equal(first.proofFile, path.resolve(stableFile));
await fs.access(stableFile);
await fs.access(legacyFile);
assert.match(launcherProofJavaArgs(stableFile).join(' '), /launcher-user-data[\\/]\.aht-launcher/);

const afterUpdate = await writeLauncherProof({
  config,
  identity: { ...identity, appVersion: '0.1.84' },
  installed,
  latest,
  recoverySecret: 'fixture_recovery_secret_123456789012345',
  fetchImpl: fixtureFetch
});
const inspected = await inspectLauncherProof({
  config,
  identity: { ...identity, appVersion: '0.1.84' },
  installed,
  latest,
  minValidityMs: 30_000
});
assert.equal(afterUpdate.payload.installId, identity.installId, 'launcher updates must preserve install identity');
assert.equal(afterUpdate.payload.appVersion, '0.1.84');
assert.equal(inspected.usable, true, inspected.reason);
assert.equal(inspected.proofFile, path.resolve(stableFile));

// A profile left behind by an older launcher can still find the compatibility
// mirror while the next Play rewrites the canonical user-data proof.
await fs.rm(stableFile);
const legacyInspection = await inspectLauncherProof({
  config,
  identity: { ...identity, appVersion: '0.1.84' },
  installed,
  latest,
  minValidityMs: 30_000
});
assert.equal(legacyInspection.usable, true, legacyInspection.reason);
assert.equal(legacyInspection.proofFile, path.resolve(legacyFile));

console.log(JSON.stringify({
  stableFile,
  legacyFile,
  installIdPreserved: afterUpdate.payload.installId === identity.installId,
  updateVersion: afterUpdate.payload.appVersion,
  canonicalInspection: inspected.usable,
  legacyFallbackInspection: legacyInspection.usable
}, null, 2));
