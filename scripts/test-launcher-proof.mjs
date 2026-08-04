import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerLauncherProofFixture } from './helpers/launcher-proof-fixture.mjs';
import {
  LAUNCHER_PROOF_PROTOCOL,
  inspectLauncherProof,
  launcherProofJavaArgs,
  launcherProofPath,
  signLauncherProofPayload,
  writeLauncherProof
} from '../src/launcherProof.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-proof-test-'));
const instanceDir = path.join(root, 'A Hard Time');
const config = {
  packId: 'a-hard-time-dregora',
  instanceDir,
  launcherProof: {
    enabled: true,
    localSecret: 'local-proof-secret',
    keyId: 'test-key'
  }
};
const identity = {
  installId: 'install-proof-test',
  minecraftUsername: 'ProofUser',
  appVersion: '0.1.0',
  platform: 'win32',
  arch: 'x64'
};
const latest = {
  packId: 'a-hard-time-dregora',
  version: '2.8.2',
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  }
};
const installed = {
  packId: 'a-hard-time-dregora',
  version: '2.8.2',
  minecraft: latest.minecraft
};

const proof = await writeLauncherProof({ config, identity, latest, installed, fetchImpl: null });
const proofFile = launcherProofPath(instanceDir);
const saved = JSON.parse(await fs.readFile(proofFile, 'utf8'));
if (!proof.trusted || proof.source !== 'local-hmac' || saved.token.split('.').length !== 3) {
  throw new Error(`Expected signed local proof, got ${JSON.stringify(saved)}`);
}
if (saved.payload.protocol !== LAUNCHER_PROOF_PROTOCOL || saved.payload.minecraftUsername !== 'ProofUser') {
  throw new Error(`Proof payload did not include expected protocol/user: ${JSON.stringify(saved.payload)}`);
}
if (saved.proofFile !== path.resolve(proofFile)) {
  throw new Error(`Unexpected proof file path: ${saved.proofFile}`);
}
const reusableProof = await inspectLauncherProof({ config, identity, latest, installed, minValidityMs: 30_000 });
if (!reusableProof.usable || reusableProof.proofFile !== path.resolve(proofFile)) {
  throw new Error(`Fresh matching proof was not reusable: ${JSON.stringify(reusableProof)}`);
}
await fs.writeFile(proofFile, `${JSON.stringify({ ...saved, token: 'not.a.valid-token' }, null, 2)}\n`, 'utf8');
const corruptTokenReuse = await inspectLauncherProof({ config, identity, latest, installed, minValidityMs: 30_000 });
if (corruptTokenReuse.usable || !/token format mismatch/i.test(corruptTokenReuse.reason || '')) {
  throw new Error(`Malformed cached proof token was incorrectly reused: ${JSON.stringify(corruptTokenReuse)}`);
}
await fs.writeFile(proofFile, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
const wrongUserProof = await inspectLauncherProof({
  config,
  identity: { ...identity, minecraftUsername: 'OtherUser' },
  latest,
  installed,
  minValidityMs: 30_000
});
if (wrongUserProof.usable || !/username mismatch/i.test(wrongUserProof.reason || '')) {
  throw new Error(`Mismatched launcher proof was incorrectly reused: ${JSON.stringify(wrongUserProof)}`);
}
const developerReuseOfPlayerProof = await inspectLauncherProof({
  config,
  identity: {
    ...identity,
    launcherChannel: 'developer',
    developerClient: true,
    developerClientBypass: true,
    modIntegrityBypass: true
  },
  latest,
  installed,
  minValidityMs: 30_000
});
if (
  developerReuseOfPlayerProof.usable
  || developerReuseOfPlayerProof.proofFile !== path.resolve(launcherProofPath(instanceDir, 'developer'))
  || !/missing proof file/i.test(developerReuseOfPlayerProof.reason || '')
) {
  throw new Error(`Developer launcher did not isolate its proof file from the player launcher: ${JSON.stringify(developerReuseOfPlayerProof)}`);
}
const expiringProof = await inspectLauncherProof({ config, identity, latest, installed, minValidityMs: 2 * 60 * 60 * 1000 });
if (expiringProof.usable || !/expires too soon/i.test(expiringProof.reason || '')) {
  throw new Error(`Expiring launcher proof was incorrectly reused: ${JSON.stringify(expiringProof)}`);
}
const javaArgs = launcherProofJavaArgs(proofFile).join(' ');
if (!javaArgs.includes('-Daht.launcher.present=true') || !javaArgs.includes('-Daht.launcher.proofFile=')) {
  throw new Error(`Expected launcher proof Java args, got ${javaArgs}`);
}

const manual = signLauncherProofPayload(saved.payload, 'local-proof-secret', 'test-key');
if (manual.token !== saved.token) {
  throw new Error('Manual proof signing did not match saved proof token.');
}

let capturedWorkerRequest = null;
const workerConfig = {
  ...config,
  instanceDir,
  launcherProof: {
    enabled: true,
    baseUrl: 'https://worker.test/ptb/',
    keyId: 'test-key'
  }
};
const developerIdentity = {
  ...identity,
  launcherChannel: 'developer',
  developerClient: true,
  developerClientBypass: true,
  modIntegrityBypass: true
};
const workerProof = await writeLauncherProof({
  config: workerConfig,
  identity: developerIdentity,
  latest,
  installed,
  authToken: 'admin-token',
  fetchImpl: async (url, options) => {
    capturedWorkerRequest = { url: String(url), options };
    const payload = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => workerLauncherProofFixture(payload, { kid: 'test-key' })
    };
  }
});
if (capturedWorkerRequest?.options?.headers?.Authorization !== 'Bearer admin-token') {
  throw new Error(`Worker proof request did not include developer auth header: ${JSON.stringify(capturedWorkerRequest?.options?.headers)}`);
}
if (capturedWorkerRequest?.url !== 'https://worker.test/api/launcher-proof') {
  throw new Error(`Worker proof request retained a PTB release prefix: ${capturedWorkerRequest?.url}`);
}
if (workerProof.source !== 'worker' || workerProof.payload.launcherChannel !== 'developer' || !workerProof.payload.modIntegrityBypass) {
  throw new Error(`Worker developer proof was not preserved: ${JSON.stringify(workerProof)}`);
}
const developerProofFile = launcherProofPath(instanceDir, 'developer');
if (workerProof.proofFile !== path.resolve(developerProofFile)) {
  throw new Error(`Developer proof used the player proof path: ${JSON.stringify(workerProof)}`);
}
const wrongServiceReuse = await inspectLauncherProof({
  config: {
    ...workerConfig,
    launcherProof: { ...workerConfig.launcherProof, baseUrl: 'https://alternate-worker.test/' }
  },
  identity: developerIdentity,
  latest,
  installed,
  minValidityMs: 30_000
});
if (wrongServiceReuse.usable || !/signing service mismatch/i.test(wrongServiceReuse.reason || '')) {
  throw new Error(`Developer proof was reused after the Worker signing service changed: ${JSON.stringify(wrongServiceReuse)}`);
}
const playerProofAfterDeveloperWrite = await inspectLauncherProof({
  config: workerConfig,
  identity,
  latest,
  installed,
  minValidityMs: 30_000
});
if (!playerProofAfterDeveloperWrite.usable || playerProofAfterDeveloperWrite.token !== saved.token) {
  throw new Error(`Developer proof write replaced or invalidated the player proof: ${JSON.stringify(playerProofAfterDeveloperWrite)}`);
}

const mismatchedResponseConfig = {
  ...workerConfig,
  instanceDir: path.join(root, 'Mismatched Worker Response')
};
let mismatchedResponseError = '';
try {
  await writeLauncherProof({
    config: mismatchedResponseConfig,
    identity: {
      ...identity,
      launcherChannel: 'developer',
      developerClient: true,
      developerClientBypass: true,
      modIntegrityBypass: true
    },
    latest,
    installed,
    authToken: 'admin-token',
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => workerLauncherProofFixture({
          ...payload,
          launcherChannel: 'player',
          developerClient: false,
          developerClientBypass: false,
          modIntegrityBypass: false
        }, { kid: 'test-key' })
      };
    }
  });
} catch (error) {
  mismatchedResponseError = error.message || String(error);
}
if (!/did not match the request.*launcherChannel.*developerClient/i.test(mismatchedResponseError)) {
  throw new Error(`Opposite-channel Worker response was not rejected: ${mismatchedResponseError}`);
}
try {
  await fs.access(launcherProofPath(mismatchedResponseConfig.instanceDir, 'developer'));
  throw new Error('Opposite-channel Worker response was written to the developer proof file.');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const tokenPayloadMismatchConfig = {
  ...workerConfig,
  instanceDir: path.join(root, 'Mismatched Token Payload')
};
let tokenPayloadMismatchError = '';
try {
  await writeLauncherProof({
    config: tokenPayloadMismatchConfig,
    identity: developerIdentity,
    latest,
    installed,
    authToken: 'admin-token',
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      const poisoned = workerLauncherProofFixture({
        ...payload,
        launcherChannel: 'player',
        developerClient: false,
        developerClientBypass: false,
        modIntegrityBypass: false
      }, { kid: 'test-key' });
      return {
        ok: true,
        json: async () => ({ ...poisoned, payload })
      };
    }
  });
} catch (error) {
  tokenPayloadMismatchError = error.message || String(error);
}
if (!/did not match the request.*token payload/i.test(tokenPayloadMismatchError)) {
  throw new Error(`Worker token/body payload mismatch was not rejected: ${tokenPayloadMismatchError}`);
}
try {
  await fs.access(launcherProofPath(tokenPayloadMismatchConfig.instanceDir, 'developer'));
  throw new Error('Worker token/body mismatch was written to the developer proof file.');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const strictBooleanConfig = {
  ...workerConfig,
  instanceDir: path.join(root, 'String Boolean Response')
};
let strictBooleanError = '';
try {
  await writeLauncherProof({
    config: strictBooleanConfig,
    identity: developerIdentity,
    latest,
    installed,
    authToken: 'admin-token',
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => workerLauncherProofFixture({ ...payload, developerClient: 'true' }, { kid: 'test-key' })
      };
    }
  });
} catch (error) {
  strictBooleanError = error.message || String(error);
}
if (!/did not match the request.*developerClient/i.test(strictBooleanError)) {
  throw new Error(`String developer boolean was accepted by the Worker proof contract: ${strictBooleanError}`);
}

const shortValidityConfig = {
  ...workerConfig,
  instanceDir: path.join(root, 'Short Validity Response')
};
let shortValidityError = '';
try {
  await writeLauncherProof({
    config: shortValidityConfig,
    identity: developerIdentity,
    latest,
    installed,
    authToken: 'admin-token',
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      const issuedAt = new Date();
      const shortPayload = {
        ...payload,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 90_000).toISOString()
      };
      return { ok: true, json: async () => workerLauncherProofFixture(shortPayload, { kid: 'test-key' }) };
    }
  });
} catch (error) {
  shortValidityError = error.message || String(error);
}
if (!/expires too soon/i.test(shortValidityError)) {
  throw new Error(`Worker proof with less than two minutes validity was accepted: ${shortValidityError}`);
}
const wrongKeyConfig = {
  ...workerConfig,
  instanceDir: path.join(root, 'Wrong Key Response')
};
let wrongKeyError = '';
try {
  await writeLauncherProof({
    config: wrongKeyConfig,
    identity: developerIdentity,
    latest,
    installed,
    authToken: 'admin-token',
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      return { ok: true, json: async () => workerLauncherProofFixture(payload, { kid: 'wrong-key-id' }) };
    }
  });
} catch (error) {
  wrongKeyError = error.message || String(error);
}
if (!/proof key mismatch/i.test(wrongKeyError)) {
  throw new Error(`Worker proof with the wrong anti-cheat key ID was accepted: ${wrongKeyError}`);
}
const desktopMain = await fs.readFile(path.resolve('desktop', 'main.js'), 'utf8');
if (!/function writeSerializedRegisteredLauncherProof[\s\S]*?const expectedIdentity = launcherProofIdentity\(runtimeIdentity\(identity\)\);[\s\S]*?inspectLauncherProof\(\{\s*config,\s*identity: expectedIdentity,/m.test(desktopMain)) {
  throw new Error('Application proof reuse does not compare the expected player/developer launcher identity.');
}
if (!/launcherProofPath\(config\.instanceDir \|\| '', expectedIdentity\)/m.test(desktopMain)) {
  throw new Error('In-flight proof refreshes are not isolated by the channel-specific proof path.');
}
if (!/ipcMain\.handle\('play:start', launchDiagnosticIpc\([\s\S]*?const launcherProofPromise = runLaunchStep\([\s\S]*?'launcher-proof'[\s\S]*?writeSerializedRegisteredLauncherProof\(/m.test(desktopMain)) {
  throw new Error('Play does not force a serialized fresh one-time launcher proof.');
}
if (/function writeSerializedRegisteredLauncherProof[\s\S]*?if \(current\.usable\)/m.test(desktopMain)) {
  throw new Error('Play proof writer still reuses a cached one-time launchId.');
}

console.log(JSON.stringify({
  proofFile,
  source: saved.source,
  trusted: saved.trusted,
  tokenParts: saved.token.split('.').length,
  workerAuthHeader: capturedWorkerRequest.options.headers.Authorization,
  developerProofFile,
  playerProofPreserved: playerProofAfterDeveloperWrite.usable,
  mismatchedResponseRejected: true,
  mismatchedTokenRejected: true,
  cachedMalformedTokenRejected: true,
  strictBooleanRejected: true,
  shortValidityRejected: true,
  wrongKeyRejected: true,
  javaArgs
}, null, 2));
