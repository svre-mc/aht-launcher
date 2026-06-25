import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LAUNCHER_PROOF_PROTOCOL,
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
  instanceDir: path.join(root, 'A Hard Time Worker'),
  launcherProof: {
    enabled: true,
    baseUrl: 'https://worker.test/'
  }
};
const workerProof = await writeLauncherProof({
  config: workerConfig,
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
  fetchImpl: async (url, options) => {
    capturedWorkerRequest = { url: String(url), options };
    const payload = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        token: 'header.payload.signature',
        payload,
        signature: { alg: 'HS256', kid: 'test-key', value: 'signature' }
      })
    };
  }
});
if (capturedWorkerRequest?.options?.headers?.Authorization !== 'Bearer admin-token') {
  throw new Error(`Worker proof request did not include developer auth header: ${JSON.stringify(capturedWorkerRequest?.options?.headers)}`);
}
if (workerProof.source !== 'worker' || workerProof.payload.launcherChannel !== 'developer' || !workerProof.payload.modIntegrityBypass) {
  throw new Error(`Worker developer proof was not preserved: ${JSON.stringify(workerProof)}`);
}

console.log(JSON.stringify({
  proofFile,
  source: saved.source,
  trusted: saved.trusted,
  tokenParts: saved.token.split('.').length,
  workerAuthHeader: capturedWorkerRequest.options.headers.Authorization,
  javaArgs
}, null, 2));
