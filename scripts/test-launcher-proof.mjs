import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workerLauncherProofFixture } from './helpers/launcher-proof-fixture.mjs';
import {
  LAUNCHER_PROOF_PROTOCOL,
  inspectLauncherProof,
  launcherProofJavaArgs,
  launcherProofPath,
  launcherProofStorageDir,
  writeLauncherProof
} from '../src/launcherProof.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-proof-test-'));
const instanceDir = path.join(root, 'A Hard Time');
const config = {
  packId: 'a-hard-time-dregora',
  instanceDir,
  launcherProof: {
    enabled: true,
    required: true,
    baseUrl: 'https://worker.test/ptb/',
    keyId: 'aht-launcher-attestation-v2',
    localSecret: 'must-never-sign-a-proof'
  }
};
const identity = {
  installId: 'install-proof-test',
  minecraftUsername: 'ProofUser',
  minecraftUuid: '01234567-89ab-4def-8123-456789abcdef',
  appVersion: '0.1.0',
  platform: 'win32',
  arch: 'x64',
  launcherChannel: 'player',
  developerClient: false,
  developerClientBypass: false,
  modIntegrityBypass: false
};
const latest = {
  packId: config.packId,
  version: '2.8.2',
  minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }] }
};
const installed = { ...latest };

let capturedRequest = null;
const workerLaunchId = randomUUID();
const proof = await writeLauncherProof({
  config,
  identity,
  latest,
  installed,
  recoverySecret: 'recovery_secret_that_is_long_enough_123456',
  fetchImpl: async (url, options) => {
    capturedRequest = { url: String(url), options };
    const payload = JSON.parse(options.body);
    return { ok: true, json: async () => workerLauncherProofFixture(payload, { launchId: workerLaunchId }) };
  }
});
assert.equal(capturedRequest.url, 'https://worker.test/api/launcher-proof');
assert.equal(capturedRequest.options.headers['X-AHT-Launcher-Recovery'], 'recovery_secret_that_is_long_enough_123456');
assert.equal(JSON.parse(capturedRequest.options.body).protocol, LAUNCHER_PROOF_PROTOCOL);
assert.equal(Object.hasOwn(JSON.parse(capturedRequest.options.body), 'accountRecoverySecret'), false);
assert.equal(proof.protocol, 'aht-launcher-attestation-v2');
assert.equal(proof.schemaVersion, 2);
assert.equal(proof.source, 'worker');
assert.equal(proof.header.alg, 'RS256');
assert.equal(proof.header.typ, 'AHT-LAUNCHER-ATTESTATION');
assert.equal(proof.header.kid, 'aht-launcher-attestation-v2');
assert.equal(proof.payload.launchId, workerLaunchId, 'v2 must accept a Worker-generated launchId');
assert.equal(proof.payload.jti, workerLaunchId);
assert.equal(proof.payload.minecraftUuid, identity.minecraftUuid);
assert.equal(JSON.stringify(proof).includes('recovery_secret_that_is_long_enough_123456'), false);

const proofFile = launcherProofPath(instanceDir);
const reusable = await inspectLauncherProof({ config, identity, latest, installed, minValidityMs: 30_000 });
assert.equal(reusable.usable, true, reusable.reason);
assert.equal(reusable.proofFile, path.resolve(proofFile));
assert.match(launcherProofJavaArgs(proofFile).join(' '), /aht\.launcher\.protocol=aht-launcher-attestation-v2/);

const privateInstanceDir = path.join(root, 'Private Proof Instance');
const privateProofDir = path.join(root, 'launcher-user-data', '.aht-launcher');
const privateConfig = {
  ...config,
  instanceDir: privateInstanceDir,
  launcherProof: { ...config.launcherProof, proofDir: privateProofDir }
};
const legacyInstanceProof = launcherProofPath(privateInstanceDir);
await fs.mkdir(path.dirname(legacyInstanceProof), { recursive: true });
await fs.writeFile(legacyInstanceProof, '{"stale":true}\n', 'utf8');
const privateProof = await writeLauncherProof({
  config: privateConfig,
  identity,
  latest,
  installed,
  recoverySecret: 'recovery_secret_that_is_long_enough_123456',
  fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    return { ok: true, json: async () => workerLauncherProofFixture(payload) };
  }
});
assert.equal(privateProof.proofFile, path.resolve(launcherProofPath(privateInstanceDir, identity, { proofDir: privateProofDir })));
await fs.access(privateProof.proofFile);
await assert.rejects(fs.access(legacyInstanceProof), /ENOENT/, 'pack-local launcher proof compatibility mirror must be removed by default');

const unsignedConfig = {
  ...config,
  instanceDir: path.join(root, 'Unsigned'),
  launcherProof: { ...config.launcherProof, required: false, baseUrl: '', localSecret: 'still-not-trusted' }
};
const unsigned = await writeLauncherProof({ config: unsignedConfig, identity, latest, installed, fetchImpl: null });
assert.equal(unsigned.trusted, false);
assert.equal(unsigned.source, 'unsigned-fallback');
assert.equal(unsigned.token, '');
await assert.rejects(
  writeLauncherProof({
    config: { ...unsignedConfig, instanceDir: path.join(root, 'Required'), launcherProof: { ...unsignedConfig.launcherProof, required: true } },
    identity,
    latest,
    installed,
    fetchImpl: null
  }),
  /signing failed/i,
  'a local HMAC secret must never produce a trusted proof'
);

const oldWorkerConfig = { ...config, instanceDir: path.join(root, 'Old Worker') };
const oldWorker = await writeLauncherProof({
  config: oldWorkerConfig,
  identity,
  latest,
  installed,
  recoverySecret: 'recovery_secret_that_is_long_enough_123456',
  fetchImpl: async (_url, options) => {
    const requestPayload = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => workerLauncherProofFixture({
        ...requestPayload,
        protocol: 'aht-launcher-proof-v1',
        schemaVersion: 1
      }, { legacy: true })
    };
  }
});
assert.equal(oldWorker.protocol, 'aht-launcher-proof-v1', 'new launcher must accept an exact remote v1 fallback');
assert.equal(oldWorker.source, 'worker');

async function expectRejected(name, mutate) {
  const caseConfig = { ...config, instanceDir: path.join(root, name) };
  await assert.rejects(writeLauncherProof({
    config: caseConfig,
    identity,
    latest,
    installed,
    recoverySecret: 'recovery_secret_that_is_long_enough_123456',
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      const fixture = workerLauncherProofFixture(payload);
      return { ok: true, json: async () => mutate(fixture, payload) };
    }
  }), /did not match the request/i);
  await assert.rejects(fs.access(launcherProofPath(caseConfig.instanceDir)), /ENOENT/);
}

await expectRejected('Wrong Key', (fixture, payload) => workerLauncherProofFixture(payload, { kid: 'wrong-key' }));
await expectRejected('Opposite Channel', (_fixture, payload) => workerLauncherProofFixture({
  ...payload,
  launcherChannel: 'developer',
  developerClient: true,
  developerClientBypass: true,
  modIntegrityBypass: true
}));
await expectRejected('Token Body Mismatch', (fixture) => ({ ...fixture, payload: { ...fixture.payload, packId: 'poisoned-pack' } }));
await expectRejected('Short Validity', (_fixture, payload) => {
  const issuedAt = new Date();
  return workerLauncherProofFixture({
    ...payload,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 90_000).toISOString()
  });
});

const multiInstanceProofRoot = path.join(root, 'multi-instance-user-data', '.aht-launcher');
const firstInstanceDir = path.join(root, 'A Hard Time Stable');
const secondInstanceDir = path.join(root, 'A Hard Time PTB');
const firstLatest = { ...latest, version: '2.8.534' };
const secondLatest = { ...latest, version: '2.8.6' };
const firstConfig = {
  ...config,
  instanceDir: firstInstanceDir,
  launcherProof: {
    ...config.launcherProof,
    proofDir: launcherProofStorageDir(multiInstanceProofRoot, firstInstanceDir)
  }
};
const secondConfig = {
  ...config,
  instanceDir: secondInstanceDir,
  launcherProof: {
    ...config.launcherProof,
    proofDir: launcherProofStorageDir(multiInstanceProofRoot, secondInstanceDir)
  }
};
const fixtureFetch = async (_url, options) => {
  const payload = JSON.parse(options.body);
  return { ok: true, json: async () => workerLauncherProofFixture(payload) };
};
const firstPreparedProof = await writeLauncherProof({
  config: firstConfig,
  identity,
  latest: firstLatest,
  installed: firstLatest,
  recoverySecret: 'recovery_secret_that_is_long_enough_123456',
  fetchImpl: fixtureFetch
});
const secondPreparedProof = await writeLauncherProof({
  config: secondConfig,
  identity,
  latest: secondLatest,
  installed: secondLatest,
  recoverySecret: 'recovery_secret_that_is_long_enough_123456',
  fetchImpl: fixtureFetch
});
assert.notEqual(firstPreparedProof.proofFile, secondPreparedProof.proofFile, 'prepared pack proofs must not share a file');
const [firstStillUsable, secondStillUsable] = await Promise.all([
  inspectLauncherProof({ config: firstConfig, identity, latest: firstLatest, installed: firstLatest, minValidityMs: 30_000 }),
  inspectLauncherProof({ config: secondConfig, identity, latest: secondLatest, installed: secondLatest, minValidityMs: 30_000 })
]);
assert.equal(firstStillUsable.usable, true, `second pack refresh replaced the first proof: ${firstStillUsable.reason}`);
assert.equal(secondStillUsable.usable, true, secondStillUsable.reason);

const localSourceFile = launcherProofPath(instanceDir);
const saved = JSON.parse(await fs.readFile(localSourceFile, 'utf8'));
await fs.writeFile(localSourceFile, `${JSON.stringify({ ...saved, source: 'local-hmac' }, null, 2)}\n`, 'utf8');
const localSourceInspection = await inspectLauncherProof({ config, identity, latest, installed, minValidityMs: 30_000 });
assert.equal(localSourceInspection.usable, false);
assert.match(localSourceInspection.reason, /source is not trusted/i);

const desktopMain = await fs.readFile(path.resolve('desktop', 'main.js'), 'utf8');
assert.match(desktopMain, /X-AHT-Launcher-Recovery|recoverySecret/);
assert.match(desktopMain, /writeSerializedRegisteredLauncherProof[\s\S]*?writeRegisteredLauncherProof/);
assert.doesNotMatch(await fs.readFile(path.resolve('src', 'launcherProof.js'), 'utf8'), /source:\s*['"]local-hmac['"]|createHmac|AHT_LAUNCHER_PROOF_SECRET/);

console.log(JSON.stringify({
  protocol: proof.protocol,
  keyId: proof.header.kid,
  workerLaunchIdAccepted: proof.payload.launchId === workerLaunchId,
  recoveryHeaderOnly: true,
  remoteV1Fallback: oldWorker.protocol,
  localTrustedSigningDisabled: true,
  malformedResponsesRejected: 4,
  packLocalMirrorRemoved: true,
  multiInstanceProofIsolation: true,
  proofFile
}, null, 2));
