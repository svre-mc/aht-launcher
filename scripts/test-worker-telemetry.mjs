import crypto from 'node:crypto';
import worker, { LauncherStateHub } from '../cloudflare/curseforge-proxy-worker.js';
import { launcherTelemetryPlatform, sendLauncherEvent } from '../src/syncClient.js';
import {
  TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8,
  TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI
} from './helpers/launcher-proof-fixture.mjs';
import { createDeviceAssertion, createDeviceCredential } from '../src/deviceIdentity.js';
import { launcherProofDeviceBinding } from '../src/launcherProof.js';

const originalFetch = globalThis.fetch;
let sentLauncherPayload = null;
globalThis.fetch = async (_url, options = {}) => {
  sentLauncherPayload = JSON.parse(String(options.body || '{}'));
  return Response.json({ ok: true });
};
await sendLauncherEvent({
  packId: 'a-hard-time-dregora',
  sync: { baseUrl: 'https://worker.test/' }
}, {
  installId: 'sync-client-install',
  minecraftUsername: 'SyncPlayer',
  minecraftUuid: '01234567-89ab-cdef-0123-456789abcdef',
  appVersion: '0.1.82',
  platform: 'win32',
  arch: 'x64'
}, { type: 'launcher_update_completed', fromVersion: '0.1.81', toVersion: '0.1.82' });
globalThis.fetch = originalFetch;
if (
  sentLauncherPayload?.minecraftUuid !== '01234567-89ab-cdef-0123-456789abcdef'
  || sentLauncherPayload?.platform !== 'Windows'
) {
  throw new Error(`Sync client did not send canonical UUID/platform fields: ${JSON.stringify(sentLauncherPayload)}`);
}
if (launcherTelemetryPlatform('linux') !== 'Linux' || launcherTelemetryPlatform('Ubuntu 24.04') !== 'Linux') {
  throw new Error('Sync client did not normalize Ubuntu/Linux telemetry.');
}

const objects = new Map();
const durableObjectStorage = new Map();
const durableObjectInstances = new Map();
const env = {
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'secret',
  ADMIN_TOKEN_SECRET: 'test-admin-token-secret-at-least-32-bytes',
  LAUNCHER_PROOF_SECRET: 'proof-secret',
  LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8: TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8,
  LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI: TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI,
  LAUNCHER_ATTESTATION_KEY_ID: 'aht-launcher-attestation-v2',
  AHT_REQUIRED_LAUNCHER_VERSION: '0.1.0',
  AHT_LAUNCHER_STATE: {
    idFromName(name) {
      return name;
    },
    get(id) {
      if (!durableObjectInstances.has(id)) {
        const values = new Map();
        durableObjectStorage.set(id, values);
        const instance = new LauncherStateHub({
          storage: {
            async get(key) {
              return values.get(key);
            },
            async put(key, value) {
              values.set(key, structuredClone(value));
            }
          },
          getWebSockets() {
            return [];
          },
          acceptWebSocket() {}
        }, env);
        durableObjectInstances.set(id, {
          async fetch(input, init) {
            return instance.fetch(input instanceof Request ? input : new Request(input, init));
          }
        });
      }
      return durableObjectInstances.get(id);
    }
  },
  AHT_DATA: {
    async put(key, value) {
      objects.set(key, value);
    },
    async list({ prefix, limit = 1000, cursor = '' }) {
      const matches = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort((left, right) => left.localeCompare(right));
      const start = Number(cursor || 0);
      const page = matches.slice(start, start + limit);
      const next = start + page.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated: next < matches.length,
        cursor: next < matches.length ? String(next) : undefined
      };
    },
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return {
        size: bytes.length,
        body: bytes,
        httpMetadata: { contentType: key.endsWith('.json') ? 'application/json' : 'application/octet-stream' },
        async json() { return JSON.parse(value); }
      };
    },
    async head(key) {
      const value = objects.get(key);
      return value === undefined ? null : { size: new TextEncoder().encode(value).length, httpMetadata: {} };
    }
  }
};

objects.set('launcher/latest.json', JSON.stringify({
  schemaVersion: 1,
  product: 'aht-launcher',
  version: '9.9.9',
  required: true,
  downloads: {
    'windows-x64': { label: 'Windows 10/11', fileName: 'AHT-Windows.exe', path: 'launcher/files/win32-x64/AHT-Windows.exe' },
    'macos-arm64': { label: 'macOS Apple Silicon', fileName: 'AHT-arm64.dmg', path: 'launcher/files/darwin-arm64/AHT-arm64.dmg' },
    'macos-x64': { label: 'macOS Intel', fileName: 'AHT-x64.dmg', path: 'launcher/files/darwin-x64/AHT-x64.dmg' },
    'ubuntu-x64': { label: 'Ubuntu Linux x64', fileName: 'AHT-Ubuntu.deb', path: 'launcher/files/linux-x64/AHT-Ubuntu.deb' },
    'ubuntu-x64-appimage': { label: 'Ubuntu Linux x64 AppImage', fileName: 'AHT-Ubuntu.AppImage', path: 'launcher/files/linux-x64/AHT-Ubuntu.AppImage' }
  }
}));
objects.set('launcher/files/win32-x64/AHT-Windows.exe', 'windows installer');
objects.set('launcher/files/darwin-arm64/AHT-arm64.dmg', 'mac arm installer');
objects.set('launcher/files/darwin-x64/AHT-x64.dmg', 'mac intel installer');
objects.set('launcher/files/linux-x64/AHT-Ubuntu.deb', 'ubuntu deb');
objects.set('launcher/files/linux-x64/AHT-Ubuntu.AppImage', 'ubuntu appimage');

async function jsonRequest(path, options = {}) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`, options), env, {
    country: 'US'
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function trackedDownload(path, headers = {}) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`, { headers }), env, {});
  if (response.status !== 302) {
    throw new Error(`${path} did not redirect to an installer: ${response.status} ${await response.text()}`);
  }
  return response.headers.get('Location') || '';
}

const windowsDownload = await trackedDownload('/launcher/download/windows-x64?aht_player=DownloadUser&aht_uuid=01234567-89ab-cdef-0123-456789abcdef', {
  'CF-Connecting-IP': '203.0.113.42',
  'User-Agent': 'AHT website test'
});
await trackedDownload('/launcher/download/macos-arm64', {
  'CF-Connecting-IP': '2001:db8::10',
  'CF-Pseudo-IPv4': '240.10.20.30',
  'User-Agent': 'AHT website test'
});
await trackedDownload('/launcher/download/macos-x64', {
  'CF-Connecting-IP': '2001:db8::20',
  'User-Agent': 'AHT website test'
});
const ubuntuDownload = await trackedDownload('/launcher/download/ubuntu-x64', {
  'CF-Connecting-IP': '203.0.113.44',
  'User-Agent': 'AHT website Ubuntu test'
});
const ubuntuAppImageDownload = await trackedDownload('/launcher/download/ubuntu-x64-appimage', {
  'CF-Connecting-IP': '203.0.113.45',
  'User-Agent': 'AHT website Ubuntu portable test'
});
if (!windowsDownload.endsWith('/launcher/files/win32-x64/AHT-Windows.exe')) {
  throw new Error(`Tracked Windows download redirected to the wrong file: ${windowsDownload}`);
}
if (!ubuntuDownload.endsWith('/launcher/files/linux-x64/AHT-Ubuntu.deb') || !ubuntuAppImageDownload.endsWith('/launcher/files/linux-x64/AHT-Ubuntu.AppImage')) {
  throw new Error(`Tracked Ubuntu downloads redirected to the wrong files: ${ubuntuDownload}, ${ubuntuAppImageDownload}`);
}
const downloadCountBeforeDirectUpdate = [...objects.keys()].filter((key) => key.startsWith('launcher-downloads/')).length;
const directUpdate = await worker.fetch(new Request('https://worker.test/launcher/files/win32-x64/AHT-Windows.exe'), env, {});
if (!directUpdate.ok) throw new Error(`Direct launcher update artifact failed: ${directUpdate.status}`);
const downloadCountAfterDirectUpdate = [...objects.keys()].filter((key) => key.startsWith('launcher-downloads/')).length;
if (downloadCountAfterDirectUpdate !== downloadCountBeforeDirectUpdate) {
  throw new Error('Launcher self-update artifact requests must not be counted as installer downloads.');
}
const taggedInstaller = await worker.fetch(new Request('https://worker.test/launcher/files/win32-x64/AHT-Windows.exe?aht_download=windows-x64', {
  headers: {
    'CF-Connecting-IP': '203.0.113.43',
    'User-Agent': 'AHT website legacy-compatible test'
  }
}), env, {});
if (!taggedInstaller.ok) throw new Error(`Tagged launcher installer artifact failed: ${taggedInstaller.status}`);
const downloadCountAfterTaggedInstaller = [...objects.keys()].filter((key) => key.startsWith('launcher-downloads/')).length;
if (downloadCountAfterTaggedInstaller !== downloadCountBeforeDirectUpdate + 1) {
  throw new Error('Telemetry-tagged direct installer request was not counted exactly once.');
}

await jsonRequest('/api/events', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '203.0.113.42',
    'User-Agent': 'AHT test'
  },
  body: JSON.stringify({
    schemaVersion: 1,
    installId: 'install-a',
    playerLabel: 'auSavant',
    platform: 'win32',
    arch: 'x64',
    packId: 'a-hard-time-dregora',
    event: { type: 'install_completed', version: '2.8.1' }
  })
});

await jsonRequest('/api/events', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '198.51.100.14',
    'User-Agent': 'AHT test'
  },
  body: JSON.stringify({
    schemaVersion: 1,
    installId: 'install-b',
    playerLabel: 'TestRig',
    platform: 'darwin',
    arch: 'x64',
    packId: 'a-hard-time-dregora',
    event: {
      type: 'local_changes',
      changes: {
        counts: { changed: 2, missing: 0, added: 1 },
        changed: [{ path: 'config/example.cfg' }],
        added: [{ path: 'shaderpacks/local.zip' }],
        missing: []
      }
    }
  })
});

const testRigCredential = createDeviceCredential();
function withTestRigProofDevice(payload) {
  const decorated = {
    ...payload,
    protocol: payload.protocol || 'aht-launcher-proof-v1',
    deviceId: testRigCredential.deviceId,
    devicePublicKey: testRigCredential.publicKey
  };
  decorated.deviceAssertion = createDeviceAssertion(testRigCredential, {
    purpose: 'launcher-proof',
    binding: launcherProofDeviceBinding(decorated)
  });
  return decorated;
}
const testRigRegistrationPayload = {
  username: 'TestRig',
  minecraftUuid: '0123456789abcdef0123456789abcdef',
  installId: 'install-b',
  deviceId: testRigCredential.deviceId,
  devicePublicKey: testRigCredential.publicKey,
  appVersion: '0.1.81',
  platform: 'darwin',
  arch: 'x64',
  packId: 'a-hard-time-dregora'
};
testRigRegistrationPayload.deviceAssertion = createDeviceAssertion(testRigCredential, {
  purpose: 'account-registration',
  binding: {
    username: 'testrig',
    minecraftUuid: '01234567-89ab-cdef-0123-456789abcdef',
    installId: 'install-b',
    deviceId: testRigCredential.deviceId
  }
});
const registration = await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '203.0.113.42',
    'User-Agent': 'AHT test',
    'X-AHT-Launcher-Recovery': 'test_rig_recovery_secret_123456789012345'
  },
  body: JSON.stringify(testRigRegistrationPayload)
});

const repeatRegistrationPayload = {
  ...testRigRegistrationPayload,
  username: 'testrig'
};
repeatRegistrationPayload.deviceAssertion = createDeviceAssertion(testRigCredential, {
  purpose: 'account-registration',
  binding: {
    username: 'testrig',
    minecraftUuid: '01234567-89ab-cdef-0123-456789abcdef',
    installId: 'install-b',
    deviceId: testRigCredential.deviceId
  }
});
const repeatRegistration = await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(repeatRegistrationPayload)
});

const duplicateResponse = await worker.fetch(new Request('https://worker.test/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'TestRig',
    installId: 'install-c'
  })
}), env, {});
const duplicateBody = await duplicateResponse.json();
if (registration.username !== 'TestRig' || repeatRegistration.username !== 'testrig') {
  throw new Error(`Username registration failed: ${JSON.stringify({ registration, repeatRegistration })}`);
}
if (registration.minecraftUuid !== '01234567-89ab-cdef-0123-456789abcdef') {
  throw new Error(`Minecraft UUID was not canonicalized during registration: ${JSON.stringify(registration)}`);
}
if (duplicateResponse.status !== 409 || !/not available/i.test(duplicateBody.error || '')) {
  throw new Error(`Expected duplicate username rejection, got ${duplicateResponse.status} ${JSON.stringify(duplicateBody)}`);
}
const conflictingUuidResponse = await worker.fetch(new Request('https://worker.test/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'TestRig',
    minecraftUuid: 'ffffffffffffffffffffffffffffffff',
    installId: 'install-b'
  })
}), env, {});
const conflictingUuidBody = await conflictingUuidResponse.json();
if (conflictingUuidResponse.status !== 409 || !/UUID does not match/i.test(conflictingUuidBody.error || '')) {
  throw new Error(`Expected conflicting Minecraft UUID rejection, got ${conflictingUuidResponse.status} ${JSON.stringify(conflictingUuidBody)}`);
}

for (const [username, installId, minecraftUuid] of [
  ['SharedOne', 'shared-install-one', '11111111111111111111111111111111'],
  ['SharedTwo', 'shared-install-two', '22222222222222222222222222222222']
]) {
  await jsonRequest('/api/users/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.99' },
    body: JSON.stringify({ username, minecraftUuid, installId, appVersion: '0.1.81', platform: 'win32', arch: 'x64', packId: 'a-hard-time-dregora' })
  });
}
const recoveredRigSecret = 'RecoveredRig_secure_launcher_credential_000000000001';
await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.88' },
  body: JSON.stringify({ username: 'SharedOne', installId: 'shared-install-one', platform: 'win32', arch: 'x64', packId: 'a-hard-time-dregora' })
});
await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Forwarded-For': '192.0.2.200'
  },
  body: JSON.stringify({
    username: 'ForwardedOnly',
    installId: 'forwarded-only-install',
    platform: 'Windows 11',
    arch: 'x64',
    packId: 'a-hard-time-dregora'
  })
});
await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.201' },
  body: JSON.stringify({
    username: 'AHTProofCheck',
    installId: 'aht-production-readiness-proof',
    platform: 'win32',
    arch: 'x64',
    packId: 'a-hard-time-dregora'
  })
});

await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'RecoveredRig',
    minecraftUuid: '33333333333333333333333333333333',
    accountRecoverySecret: recoveredRigSecret,
    installId: 'install-old',
    platform: 'win32',
    arch: 'x64',
    packId: 'a-hard-time-dregora'
  })
});
const blankUuidRecoveryResponse = await worker.fetch(new Request('https://worker.test/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'RecoveredRig',
    installId: 'install-new',
    accountRecoverySecret: recoveredRigSecret,
    recoverExistingUsername: true,
    minecraftAccountMatched: true,
    recoveryReason: 'minecraft-launcher-account-match'
  })
}), env, {});
const blankUuidRecoveryBody = await blankUuidRecoveryResponse.json();
const accountAfterBlankRecovery = JSON.parse(objects.get('accounts/usernames/recoveredrig.json'));
if (
  blankUuidRecoveryResponse.status !== 409
  || !/UUID is required/i.test(blankUuidRecoveryBody.error || '')
  || accountAfterBlankRecovery.installId !== 'install-old'
) {
  throw new Error(`Blank UUID recovery did not fail closed without changing the account: ${JSON.stringify({ status: blankUuidRecoveryResponse.status, blankUuidRecoveryBody, accountAfterBlankRecovery })}`);
}
const forgedRecoveryResponse = await worker.fetch(new Request('https://worker.test/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'RecoveredRig',
    minecraftUuid: '33333333-3333-3333-3333-333333333333',
    accountRecoverySecret: 'ForgedRig_secure_launcher_credential_000000000000',
    installId: 'install-new',
    recoverExistingUsername: true,
    minecraftAccountMatched: true,
    recoveryReason: 'minecraft-launcher-account-match'
  })
}), env, {});
const forgedRecoveryBody = await forgedRecoveryResponse.json();
const accountAfterForgedRecovery = JSON.parse(objects.get('accounts/usernames/recoveredrig.json'));
if (
  forgedRecoveryResponse.status !== 409
  || !/Secure launcher recovery could not be verified/i.test(forgedRecoveryBody.error || '')
  || accountAfterForgedRecovery.installId !== 'install-old'
) {
  throw new Error(`Public UUID recovery did not fail closed without changing the account: ${JSON.stringify({ status: forgedRecoveryResponse.status, forgedRecoveryBody, accountAfterForgedRecovery })}`);
}
const recoveryResponse = await worker.fetch(new Request('https://worker.test/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'RecoveredRig',
    minecraftUuid: '33333333-3333-3333-3333-333333333333',
    accountRecoverySecret: recoveredRigSecret,
    installId: 'install-new',
    recoverExistingUsername: true,
    minecraftAccountMatched: true,
    recoveryReason: 'minecraft-launcher-account-match'
  })
}), env, {});
const recoveryBody = await recoveryResponse.json();
if (!recoveryResponse.ok || !recoveryBody.recovered) {
  throw new Error(`Expected Minecraft Launcher account recovery, got ${recoveryResponse.status} ${JSON.stringify(recoveryBody)}`);
}
const recoveredProof = await jsonRequest('/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'RecoveredRig',
    installId: 'install-new',
    packId: 'a-hard-time-dregora',
    appVersion: '0.1.0',
    installedVersion: '2.8.2'
  })
});
if (!recoveredProof.trusted || recoveredProof.payload.installId !== 'install-new') {
  throw new Error(`Recovered username did not produce a proof for the new install: ${JSON.stringify(recoveredProof)}`);
}
const oldRecoveredProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ minecraftUsername: 'RecoveredRig', installId: 'install-old', appVersion: '0.1.0' })
}), env, {});
if (oldRecoveredProofResponse.status !== 403) {
  throw new Error(`Recovered username should reject the old install proof, got ${oldRecoveredProofResponse.status}`);
}

const launcherProofRequest = {
  protocol: 'aht-launcher-attestation-v2',
  launchId: 'launch-proof-test',
  username: 'TestRig',
  minecraftUsername: 'TestRig',
  minecraftUuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  installId: 'install-b',
  packId: 'client-controlled-pack-id',
  packVersion: '2.8.2',
  installedVersion: '2.8.2',
  launcherVersion: '0.1.0',
  appVersion: '0.1.0',
  platform: 'win32',
  arch: 'x64',
  instanceDirHash: 'abc123',
  deviceId: testRigCredential.deviceId,
  devicePublicKey: testRigCredential.publicKey
};
launcherProofRequest.deviceAssertion = createDeviceAssertion(testRigCredential, {
  purpose: 'launcher-proof',
  binding: launcherProofDeviceBinding(launcherProofRequest)
});
const launcherProof = await jsonRequest('/api/launcher-proof', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-AHT-Launcher-Recovery': 'test_rig_recovery_secret_123456789012345'
  },
  body: JSON.stringify(launcherProofRequest)
});
if (
  !launcherProof.trusted
  || launcherProof.source !== 'worker'
  || launcherProof.protocol !== 'aht-launcher-attestation-v2'
  || launcherProof.schemaVersion !== 2
  || launcherProof.signature?.alg !== 'RS256'
  || launcherProof.header?.typ !== 'AHT-LAUNCHER-ATTESTATION'
  || launcherProof.header?.kid !== 'aht-launcher-attestation-v2'
  || launcherProof.token.split('.').length !== 3
  || launcherProof.payload.minecraftUsername !== 'TestRig'
  || launcherProof.payload.minecraftUuid !== '01234567-89ab-cdef-0123-456789abcdef'
  || launcherProof.payload.installId !== 'install-b'
  || launcherProof.payload.packId !== 'a-hard-time-dregora'
  || launcherProof.payload.issuer !== 'aht-launcher-worker'
  || launcherProof.payload.audience !== 'aht-minecraft-server'
  || launcherProof.payload.jti !== launcherProof.payload.launchId
  || launcherProof.payload.launchId === 'launch-proof-test'
) {
  throw new Error(`Launcher proof signing failed: ${JSON.stringify(launcherProof)}`);
}

const missingRecoveryProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    protocol: 'aht-launcher-attestation-v2',
    minecraftUsername: 'TestRig',
    installId: 'install-b',
    launcherVersion: '0.1.0',
    appVersion: '0.1.0'
  })
}), env, {});
if (missingRecoveryProofResponse.status !== 403) {
  throw new Error(`v2 player proof without account recovery was accepted: ${missingRecoveryProofResponse.status}`);
}

const fallbackProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(withTestRigProofDevice({
    minecraftUsername: 'TestRig',
    installId: 'install-b',
    appVersion: '0.1.0'
  }))
}), {
  ...env,
  LAUNCHER_PROOF_SECRET: '',
  AHT_LAUNCHER_PROOF_SECRET: 'aht-proof-secret'
}, {});
const fallbackProof = await fallbackProofResponse.json();
if (!fallbackProofResponse.ok || !fallbackProof.trusted || fallbackProof.source !== 'worker' || fallbackProof.token.split('.').length !== 3) {
  throw new Error(`AHT_LAUNCHER_PROOF_SECRET fallback did not sign proof: ${fallbackProofResponse.status} ${JSON.stringify(fallbackProof)}`);
}

const curseForgeOnlyProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(withTestRigProofDevice({
    minecraftUsername: 'TestRig',
    installId: 'install-b',
    appVersion: '0.1.0'
  }))
}), {
  AHT_DATA: env.AHT_DATA,
  AHT_REQUIRED_LAUNCHER_VERSION: '0.1.0',
  CURSEFORGE_API_KEY: 'cf-key-is-not-a-proof-secret'
}, {});
const curseForgeOnlyProof = await curseForgeOnlyProofResponse.json();
if (curseForgeOnlyProofResponse.status !== 500
    || curseForgeOnlyProof.error !== 'Internal service error.'
    || !curseForgeOnlyProof.requestId) {
  throw new Error(`CurseForge API key should not sign launcher proofs: ${curseForgeOnlyProofResponse.status} ${JSON.stringify(curseForgeOnlyProof)}`);
}

const objectCountBeforeProofStatus = objects.size;
const proofStatus = await jsonRequest('/api/launcher-proof/status');
if (
  JSON.stringify(Object.keys(proofStatus).sort()) !== JSON.stringify(['algorithm', 'configured', 'dedicatedConfigured', 'keyId', 'ok', 'privateKeyConfigured', 'protocol', 'publicKeyConfigured', 'signingVerified'])
  || !proofStatus.ok
  || !proofStatus.configured
  || !proofStatus.dedicatedConfigured
  || !proofStatus.privateKeyConfigured
  || !proofStatus.publicKeyConfigured
  || !proofStatus.signingVerified
  || proofStatus.protocol !== 'aht-launcher-attestation-v2'
  || proofStatus.algorithm !== 'RS256'
  || proofStatus.keyId !== 'aht-launcher-attestation-v2'
  || objects.size !== objectCountBeforeProofStatus
) {
  throw new Error(`Launcher proof status was not read-only/minimal: ${JSON.stringify(proofStatus)}`);
}
let proofStatusStorageTouched = false;
const inMemoryProofStatusResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof/status'), {
  LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8: env.LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8,
  LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI: env.LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI,
  LAUNCHER_ATTESTATION_KEY_ID: env.LAUNCHER_ATTESTATION_KEY_ID,
  AHT_DATA: {
    async get() { proofStatusStorageTouched = true; throw new Error('launcher proof status read R2'); },
    async put() { proofStatusStorageTouched = true; throw new Error('launcher proof status wrote R2'); }
  }
}, {});
const inMemoryProofStatus = await inMemoryProofStatusResponse.json();
if (!inMemoryProofStatusResponse.ok || !inMemoryProofStatus.signingVerified || proofStatusStorageTouched) {
  throw new Error(`Launcher proof status self-test was not in-memory only: ${inMemoryProofStatusResponse.status} ${JSON.stringify(inMemoryProofStatus)}`);
}
const unconfiguredProofStatusResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof/status'), {
  AHT_DATA: env.AHT_DATA,
  CURSEFORGE_API_KEY: 'not-a-proof-secret'
}, {});
const unconfiguredProofStatus = await unconfiguredProofStatusResponse.json();
if (
  unconfiguredProofStatusResponse.status !== 200
  || unconfiguredProofStatus.ok
  || unconfiguredProofStatus.configured
  || unconfiguredProofStatus.signingVerified
) {
  throw new Error(`Unconfigured launcher proof status was incorrect: ${unconfiguredProofStatusResponse.status} ${JSON.stringify(unconfiguredProofStatus)}`);
}
const adminFallbackProofStatusResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof/status'), {
  ADMIN_PASSWORD: 'admin-only-proof-fallback',
  AHT_DATA: env.AHT_DATA
}, {});
const adminFallbackProofStatus = await adminFallbackProofStatusResponse.json();
if (
  adminFallbackProofStatusResponse.status !== 200
  || adminFallbackProofStatus.ok
  || adminFallbackProofStatus.configured
  || adminFallbackProofStatus.privateKeyConfigured
  || adminFallbackProofStatus.publicKeyConfigured
  || adminFallbackProofStatus.signingVerified
) {
  throw new Error(`Admin-only fallback incorrectly passed production launcher proof status: ${adminFallbackProofStatusResponse.status} ${JSON.stringify(adminFallbackProofStatus)}`);
}
const invalidKeyProofStatusResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof/status'), {
  ...env,
  LAUNCHER_ATTESTATION_KEY_ID: 'wrong-key-id'
}, {});
const invalidKeyProofStatus = await invalidKeyProofStatusResponse.json();
if (
  invalidKeyProofStatusResponse.status !== 200
  || invalidKeyProofStatus.ok
  || !invalidKeyProofStatus.configured
  || invalidKeyProofStatus.signingVerified
  || invalidKeyProofStatus.keyId !== 'wrong-key-id'
  || objects.size !== objectCountBeforeProofStatus
) {
  throw new Error(`Invalid launcher proof key passed the read-only signing self-test: ${invalidKeyProofStatusResponse.status} ${JSON.stringify(invalidKeyProofStatus)}`);
}

const proofMismatchResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-c',
    appVersion: '0.1.0'
  })
}), env, {});
if (proofMismatchResponse.status !== 403) {
  throw new Error(`Expected launcher proof install mismatch rejection, got ${proofMismatchResponse.status}`);
}

const unauthDeveloperProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-b',
    launcherChannel: 'developer',
    developerClient: true,
    developerClientBypass: true,
    modIntegrityBypass: true
  })
}), env, {});
if (unauthDeveloperProofResponse.status !== 401) {
  throw new Error(`Expected unauthenticated developer proof rejection, got ${unauthDeveloperProofResponse.status}`);
}

const unauthDeveloperClientAliasResponse = await worker.fetch(new Request('https://packs.example.com/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-b',
    developerClient: true
  })
}), env, {});
if (unauthDeveloperClientAliasResponse.status !== 401) {
  throw new Error(`Expected unauthenticated developerClient alias rejection, got ${unauthDeveloperClientAliasResponse.status}`);
}

const unauthDeveloperChannelAliasResponse = await worker.fetch(new Request('https://packs.example.com/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-b',
    launcherChannel: 'developer'
  })
}), env, {});
if (unauthDeveloperChannelAliasResponse.status !== 401) {
  throw new Error(`Expected unauthenticated developer channel alias rejection, got ${unauthDeveloperChannelAliasResponse.status}`);
}

const launcherUpdatePayload = {
  schemaVersion: 1,
  installId: 'install-b',
  minecraftUsername: 'TestRig',
  minecraftUuid: '0123456789abcdef0123456789abcdef',
  appVersion: '0.1.82',
  platform: 'win32',
  arch: 'x64',
  packId: 'a-hard-time-dregora',
  event: { type: 'launcher_update_completed', fromVersion: '0.1.81', toVersion: '0.1.82' }
};
for (let attempt = 0; attempt < 2; attempt += 1) {
  const updateResult = await jsonRequest('/api/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.55',
      'User-Agent': 'AHT launcher update test'
    },
    body: JSON.stringify(launcherUpdatePayload)
  });
  if (!updateResult.accountValidated || updateResult.accountRefreshed || !updateResult.launcherUpdateKey) {
    throw new Error(`Registered launcher update was not validated without mutating canonical identity: ${JSON.stringify(updateResult)}`);
  }
}
await jsonRequest('/api/events', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.99' },
  body: JSON.stringify({
    installId: 'shared-install-two',
    minecraftUsername: 'SharedTwo',
    minecraftUuid: '22222222222222222222222222222222',
    appVersion: '0.1.82',
    platform: 'darwin',
    arch: 'arm64',
    packId: 'a-hard-time-dregora',
    event: { type: 'launcher_update_completed', fromVersion: '0.1.81', toVersion: '0.1.82' }
  })
});
const mismatchedUpdateResponse = await worker.fetch(new Request('https://worker.test/api/events', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.250' },
  body: JSON.stringify({
    ...launcherUpdatePayload,
    installId: 'install-c',
    minecraftUuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  })
}), env, {});
const mismatchedUpdateBody = await mismatchedUpdateResponse.json();
if (mismatchedUpdateResponse.status !== 409 || !/does not match/i.test(mismatchedUpdateBody.error || '')) {
  throw new Error(`Mismatched launcher update overwrote an account: ${mismatchedUpdateResponse.status} ${JSON.stringify(mismatchedUpdateBody)}`);
}
const testRigAccountBeforeInvalidUpdate = objects.get('accounts/usernames/testrig.json');
const invalidUpdateResponse = await worker.fetch(new Request('https://worker.test/api/events', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.251' },
  body: JSON.stringify({
    installId: 'install-b',
    minecraftUsername: 'TestRig',
    minecraftUuid: '0123456789abcdef0123456789abcdef',
    platform: 'darwin',
    event: { type: 'launcher_update_completed' }
  })
}), env, {});
const invalidUpdateBody = await invalidUpdateResponse.json();
if (
  invalidUpdateResponse.status !== 400
  || !/Launcher version is required/i.test(invalidUpdateBody.error || '')
  || objects.get('accounts/usernames/testrig.json') !== testRigAccountBeforeInvalidUpdate
) {
  throw new Error(`Invalid launcher update partially mutated an account: ${invalidUpdateResponse.status} ${JSON.stringify(invalidUpdateBody)}`);
}

const workerIndexResponse = await worker.fetch(new Request('https://packs.example.com/'), env, {});
const workerIndex = await workerIndexResponse.json();
if (workerIndexResponse.status !== 200 || !Array.isArray(workerIndex.endpoints)) {
  throw new Error(`Worker discovery root changed unexpectedly: ${workerIndexResponse.status} ${JSON.stringify(workerIndex)}`);
}
for (const endpoint of ['/api/launcher-proof/status', '/admin/player-records', '/admin/launcher-updates']) {
  if (!workerIndex.endpoints.includes(endpoint)) {
    throw new Error(`Worker discovery root is missing ${endpoint}: ${JSON.stringify(workerIndex.endpoints)}`);
  }
}
const poisonedAdminRoute = await worker.fetch(new Request('https://packs.example.com/ptb/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'secret' })
}), env, {});
const poisonedProofRoute = await worker.fetch(new Request('https://packs.example.com/ptb/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ minecraftUsername: 'TestRig', installId: 'install-b' })
}), env, {});
if (poisonedAdminRoute.status !== 404 || poisonedProofRoute.status !== 404) {
  throw new Error(`Unknown PTB-prefixed control routes must fail closed: ${poisonedAdminRoute.status}/${poisonedProofRoute.status}`);
}

const limitedLogin = await worker.fetch(new Request('https://worker.test/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'secret' })
}), {
  ...env,
  AHT_ADMIN_RATE_LIMITER: { async limit() { return { success: false }; } }
}, {});
if (limitedLogin.status !== 429 || limitedLogin.headers.get('Retry-After') !== '60') {
  throw new Error(`Configured admin login rate limiting did not fail closed: ${limitedLogin.status}`);
}
const eventCountBeforeRateLimit = [...objects.keys()].filter((key) => key.startsWith('telemetry/events/')).length;
const limitedEvent = await worker.fetch(new Request('https://worker.test/api/events', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.201' },
  body: JSON.stringify({ installId: 'rate-limited', event: { type: 'install_completed' } })
}), {
  ...env,
  AHT_PLAYER_API_RATE_LIMITER: { async limit() { return { success: false }; } }
}, {});
if (limitedEvent.status !== 429
    || limitedEvent.headers.get('Retry-After') !== '60'
    || [...objects.keys()].filter((key) => key.startsWith('telemetry/events/')).length !== eventCountBeforeRateLimit) {
  throw new Error(`Configured player API rate limiting did not fail closed before storage: ${limitedEvent.status}`);
}

const login = await jsonRequest('/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'secret' })
});
const auth = { Authorization: `Bearer ${login.token}` };
const firstDownloadPage = await jsonRequest('/admin/launcher-downloads?limit=1', { headers: auth });
if (firstDownloadPage.downloads.length !== 1 || !firstDownloadPage.hasMore || !firstDownloadPage.cursor) {
  throw new Error(`Launcher download pagination failed: ${JSON.stringify(firstDownloadPage)}`);
}
const allDownloadRecords = [...firstDownloadPage.downloads];
let downloadCursor = firstDownloadPage.cursor;
while (downloadCursor) {
  const page = await jsonRequest(`/admin/launcher-downloads?limit=2&cursor=${encodeURIComponent(downloadCursor)}`, { headers: auth });
  allDownloadRecords.push(...page.downloads);
  downloadCursor = page.hasMore ? page.cursor : '';
}
if (
  allDownloadRecords.length !== 6
  || allDownloadRecords.some((item) => String(item.ipv4 || '').includes(':'))
  || allDownloadRecords.some((item) => item.minecraftUsername && item.minecraftUsername !== 'DownloadUser')
  || allDownloadRecords.some((item) => !['Windows', 'Mac', 'Linux'].includes(item.platform))
) {
  throw new Error(`Launcher download history must preserve explicit player identity without inventing it: ${JSON.stringify(allDownloadRecords)}`);
}
const namedDownload = allDownloadRecords.find((item) => item.minecraftUsername === 'DownloadUser');
if (!namedDownload || namedDownload.minecraftUuid !== '01234567-89ab-cdef-0123-456789abcdef') {
  throw new Error(`Launcher download history did not preserve the download-link player identity: ${JSON.stringify(namedDownload)}`);
}
const pseudoIpv4Download = allDownloadRecords.find((item) => item.platformKey === 'macos-arm64');
if (
  !pseudoIpv4Download
  || pseudoIpv4Download.ip !== '2001:db8::10'
  || pseudoIpv4Download.ipVersion !== 6
  || pseudoIpv4Download.ipv4
  || pseudoIpv4Download.ipv4Source !== 'cloudflare-connecting-ip'
  || pseudoIpv4Download.pseudoIpv4 !== true
) {
  throw new Error(`Cloudflare pseudo IPv4 must be rejected while preserving the native player IPv6: ${JSON.stringify(pseudoIpv4Download)}`);
}
const ipv6OnlyDownload = allDownloadRecords.find((item) => item.platformKey === 'macos-x64');
if (
  !ipv6OnlyDownload
  || ipv6OnlyDownload.ip !== '2001:db8::20'
  || ipv6OnlyDownload.ipVersion !== 6
  || ipv6OnlyDownload.ipv4
  || ipv6OnlyDownload.ipv4Source !== 'cloudflare-connecting-ip'
  || ipv6OnlyDownload.pseudoIpv4 !== false
) {
  throw new Error(`IPv6-only visitors must retain their native IP without inventing an IPv4: ${JSON.stringify(ipv6OnlyDownload)}`);
}
const allPlayers = [];
let playerCursor = '';
do {
  const page = await jsonRequest(`/admin/player-records?limit=2${playerCursor ? `&cursor=${encodeURIComponent(playerCursor)}` : ''}`, { headers: auth });
  allPlayers.push(...page.players);
  playerCursor = page.hasMore ? page.cursor : '';
} while (playerCursor);
const testRigPlayer = allPlayers.find((player) => player.minecraftUsername === 'TestRig');
const sharedOnePlayer = allPlayers.find((player) => player.minecraftUsername === 'SharedOne');
const forwardedOnlyPlayer = allPlayers.find((player) => player.minecraftUsername === 'ForwardedOnly');
if (
  !testRigPlayer
  || testRigPlayer.minecraftUuid !== '01234567-89ab-cdef-0123-456789abcdef'
  || testRigPlayer.ipv4 !== '203.0.113.42'
  || testRigPlayer.platform !== 'Mac'
  || testRigPlayer.launcherVersion !== '0.1.81'
) {
  throw new Error(`Launcher update telemetry mutated the canonical player record: ${JSON.stringify(testRigPlayer)}`);
}
if (!sharedOnePlayer || sharedOnePlayer.ipv4 !== '198.51.100.88' || sharedOnePlayer.minecraftUuid !== '11111111-1111-1111-1111-111111111111') {
  throw new Error(`Moved player did not retain one current canonical association: ${JSON.stringify(sharedOnePlayer)}`);
}
if (!forwardedOnlyPlayer || forwardedOnlyPlayer.ipv4) {
  throw new Error(`Spoofable X-Forwarded-For value was presented as a native IPv4: ${JSON.stringify(forwardedOnlyPlayer)}`);
}
if (allPlayers.some((player) => player.minecraftUsername === 'AHTProofCheck')) {
  throw new Error(`Synthetic readiness proof leaked into player records: ${JSON.stringify(allPlayers)}`);
}
if (!objects.has('accounts/ipv4/203.0.113.99/sharedone.json')) {
  throw new Error('Historical account/IP index was deleted instead of being preserved outside current associations.');
}

const firstUpdatePage = await jsonRequest('/admin/launcher-updates?limit=1', { headers: auth });
const allLauncherUpdates = [...firstUpdatePage.updates];
let updateCursor = firstUpdatePage.hasMore ? firstUpdatePage.cursor : '';
while (updateCursor) {
  const page = await jsonRequest(`/admin/launcher-updates?limit=2&cursor=${encodeURIComponent(updateCursor)}`, { headers: auth });
  allLauncherUpdates.push(...page.updates);
  updateCursor = page.hasMore ? page.cursor : '';
}
if (allLauncherUpdates.length < 2 || !firstUpdatePage.hasMore || !firstUpdatePage.cursor) {
  throw new Error(`Launcher update pagination/idempotency failed: ${JSON.stringify({ firstUpdatePage, allLauncherUpdates })}`);
}
const testRigUpdate = allLauncherUpdates.find((update) => update.minecraftUsername === 'TestRig');
if (
  !testRigUpdate
  || testRigUpdate.minecraftUuid !== '01234567-89ab-cdef-0123-456789abcdef'
  || testRigUpdate.platform !== 'Windows'
  || testRigUpdate.ipv4 !== '192.0.2.55'
  || testRigUpdate.launcherVersion !== '0.1.82'
) {
  throw new Error(`Launcher update history lost canonical fields: ${JSON.stringify(testRigUpdate)}`);
}
const canonicalFallbackUpdate = allLauncherUpdates.find((update) => update.minecraftUsername === 'SharedOne' && update.source === 'canonical-account');
if (!canonicalFallbackUpdate || canonicalFallbackUpdate.launcherVersion !== '0.1.81') {
  throw new Error(`Launcher update history did not include the current canonical player fallback: ${JSON.stringify(canonicalFallbackUpdate)}`);
}
const playerIpv4Groups = await jsonRequest('/admin/player-ipv4-groups', { headers: auth });
const formerlySharedIpv4 = playerIpv4Groups.groups.find((group) => group.ipv4 === '203.0.113.99');
if (
  !playerIpv4Groups.currentOnly
  || !formerlySharedIpv4
  || formerlySharedIpv4.playerCount !== 1
  || formerlySharedIpv4.players.join(',') !== 'SharedTwo'
  || playerIpv4Groups.sharedGroups.some((group) => group.ipv4 === '203.0.113.99')
) {
  throw new Error(`Historical IP indexes contaminated current player associations: ${JSON.stringify(playerIpv4Groups)}`);
}
const developerLauncherProof = await jsonRequest('/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify(withTestRigProofDevice({
    protocol: 'aht-launcher-attestation-v2',
    minecraftUsername: 'TestRig',
    minecraftUuid: '01234567-89ab-cdef-0123-456789abcdef',
    installId: 'developer-install-not-registered',
    launcherChannel: 'developer',
    developerClient: true,
    developerClientBypass: true,
    modIntegrityBypass: true,
    packId: 'a-hard-time-dregora',
    launcherVersion: '0.1.0',
    appVersion: '0.1.0',
    installedVersion: '2.8.2'
  }))
});
if (
  developerLauncherProof.payload.launcherChannel !== 'developer'
  || !developerLauncherProof.payload.developerClientBypass
  || !developerLauncherProof.payload.modIntegrityBypass
  || developerLauncherProof.payload.installId !== 'developer-install-not-registered'
) {
  throw new Error(`Authenticated developer proof did not include bypass flags: ${JSON.stringify(developerLauncherProof)}`);
}
const developerSocialResponse = await worker.fetch(new Request('https://worker.test/api/social', {
  headers: { Authorization: `Bearer ${developerLauncherProof.token}` }
}), env, {});
const developerSocial = await developerSocialResponse.json();
if (developerSocialResponse.status !== 200 || developerSocial.username !== 'TestRig') {
  throw new Error(`Signed developer proof was rejected by the downstream Worker proof verifier: ${developerSocialResponse.status} ${JSON.stringify(developerSocial)}`);
}
const wrongKidHeader = { alg: 'RS256', typ: 'AHT-LAUNCHER-ATTESTATION', kid: 'wrong-key-id' };
const wrongKidInput = `${Buffer.from(JSON.stringify(wrongKidHeader)).toString('base64url')}.${Buffer.from(JSON.stringify(developerLauncherProof.payload)).toString('base64url')}`;
const wrongKidToken = `${wrongKidInput}.${crypto.sign('RSA-SHA256', Buffer.from(wrongKidInput), TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8).toString('base64url')}`;
const wrongKidSocialResponse = await worker.fetch(new Request('https://worker.test/api/social', {
  headers: { Authorization: `Bearer ${wrongKidToken}` }
}), env, {});
if (wrongKidSocialResponse.status !== 401) {
  throw new Error(`Downstream Worker proof verifier accepted the wrong anti-cheat key ID: ${wrongKidSocialResponse.status}`);
}
const wrongConfiguredKidResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-AHT-Launcher-Recovery': 'test_rig_recovery_secret_123456789012345' },
  body: JSON.stringify(withTestRigProofDevice({ protocol: 'aht-launcher-attestation-v2', minecraftUsername: 'TestRig', installId: 'install-b', launcherVersion: '0.1.0', appVersion: '0.1.0' }))
}), { ...env, LAUNCHER_ATTESTATION_KEY_ID: 'wrong-key-id' }, {});
const wrongConfiguredKid = await wrongConfiguredKidResponse.json();
if (wrongConfiguredKidResponse.status !== 500
    || wrongConfiguredKid.error !== 'Internal service error.'
    || !wrongConfiguredKid.requestId) {
  throw new Error(`Worker issued a proof with a key ID rejected by anti-cheat: ${wrongConfiguredKidResponse.status} ${JSON.stringify(wrongConfiguredKid)}`);
}
const emptyLogs = await jsonRequest('/api/update-logs?limit=3');
if (emptyLogs.logs.length !== 0) {
  throw new Error(`Expected no update logs before publish, got ${JSON.stringify(emptyLogs)}`);
}
const publishedLog = await jsonRequest('/admin/update-logs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify({
    version: '2.8.2',
    title: 'AHT Update Feed',
    subtitle: 'Exact client ZIP installs and launcher proof telemetry.',
    text: '# Launcher Patch\nExact AHT client ZIP installs and launcher proof telemetry are now visible in the launcher.\n- Full log modal ready\n- Optional videos ready',
    image: { type: 'image', url: 'https://packs.example.com/update-media/banner.webp', path: 'update-media/banner.webp' },
    media: { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Patch video' }
  })
});
const publicLogs = await jsonRequest('/api/update-logs?limit=3');
const adminLogs = await jsonRequest('/admin/update-logs?limit=10', { headers: auth });
if (
  publishedLog.log.title !== 'AHT Update Feed'
  || publishedLog.log.subtitle !== 'Exact client ZIP installs and launcher proof telemetry.'
  || publishedLog.log.image?.url !== 'https://packs.example.com/update-media/banner.webp'
  || publishedLog.log.media?.type !== 'youtube'
  || !publishedLog.log.text.includes('Full log modal ready')
  || publicLogs.logs.length !== 1
  || publicLogs.logs[0].media?.type !== 'youtube'
  || adminLogs.logs.length !== 1
) {
  throw new Error(`Update log publish/list failed: ${JSON.stringify({ publishedLog, publicLogs, adminLogs })}`);
}
const likeCredential = createDeviceCredential();
const likeUsername = 'NewsLiker';
const likeRegistrationBinding = {
  username: likeUsername.toLowerCase(),
  minecraftUuid: '11111111-2222-4333-8444-555555555555',
  installId: 'news-like-install',
  deviceId: likeCredential.deviceId
};
await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-AHT-Launcher-Recovery': 'news_liker_recovery_secret_123456789012345'
  },
  body: JSON.stringify({
    username: likeUsername,
    minecraftUuid: likeRegistrationBinding.minecraftUuid,
    installId: likeRegistrationBinding.installId,
    deviceId: likeCredential.deviceId,
    devicePublicKey: likeCredential.publicKey,
    deviceAssertion: createDeviceAssertion(likeCredential, {
      purpose: 'account-registration',
      binding: likeRegistrationBinding
    })
  })
});
const likeBinding = {
  logId: publishedLog.log.id,
  username: likeUsername.toLowerCase(),
  deviceId: likeCredential.deviceId
};
const likePayload = {
  ...likeBinding,
  devicePublicKey: likeCredential.publicKey,
  deviceAssertion: createDeviceAssertion(likeCredential, {
    purpose: 'update-log-like',
    binding: likeBinding
  })
};
const firstLike = await jsonRequest(`/api/update-logs/${publishedLog.log.id}/like`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(likePayload)
});
likePayload.deviceAssertion = createDeviceAssertion(likeCredential, {
  purpose: 'update-log-like',
  binding: likeBinding
});
const repeatedLike = await jsonRequest(`/api/update-logs/${publishedLog.log.id}/like`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(likePayload)
});
const likedLogs = await jsonRequest('/api/update-logs?limit=3');
if (firstLike.likes !== 1 || repeatedLike.likes !== 1 || likedLogs.logs[0]?.likes !== 1) {
  throw new Error(`Update-log likes were not idempotent: ${JSON.stringify({ firstLike, repeatedLike, likedLogs })}`);
}
const rogueCredential = createDeviceCredential();
const rogueBinding = { ...likeBinding, deviceId: rogueCredential.deviceId };
const rogueLikeResponse = await worker.fetch(new Request(`https://worker.test/api/update-logs/${publishedLog.log.id}/like`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ...rogueBinding,
    devicePublicKey: rogueCredential.publicKey,
    deviceAssertion: createDeviceAssertion(rogueCredential, {
      purpose: 'update-log-like',
      binding: rogueBinding
    })
  })
}), env, {});
if (rogueLikeResponse.status !== 403) {
  throw new Error(`Unregistered launcher device liked news: ${rogueLikeResponse.status}`);
}
const summary = await jsonRequest('/admin/summary', { headers: auth });
const events = await jsonRequest('/admin/events?limit=10', { headers: auth });

if (summary.counts.installs !== 1 || summary.counts.changeReports !== 1 || summary.counts.uniqueIps !== 4) {
  throw new Error(`Unexpected summary counts: ${JSON.stringify(summary.counts)}`);
}
if (events.events.length !== 5) {
  throw new Error(`Expected 5 events, got ${events.events.length}`);
}
const changeEvent = events.events.find((item) => item.event?.type === 'local_changes');
if (!changeEvent?.ip || changeEvent.event.changes.counts.changed !== 2 || changeEvent.playerLabel !== 'TestRig') {
  throw new Error(`Local change event lost detail: ${JSON.stringify(changeEvent)}`);
}

const recoveredInstallResponse = await worker.fetch(new Request('https://worker.test/api/events', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.56' },
  body: JSON.stringify({
    ...launcherUpdatePayload,
    installId: 'install-new-after-reinstall',
    appVersion: '0.1.83',
    event: { type: 'launcher_update_completed', fromVersion: '0.1.82', toVersion: '0.1.83' }
  })
}), env, {});
const recoveredInstallUpdate = await recoveredInstallResponse.json();
if (recoveredInstallResponse.status !== 403
    || recoveredInstallUpdate.error !== 'Launcher update identity does not match the registered player.'
    || JSON.parse(objects.get('accounts/usernames/testrig.json')).installId !== 'install-b') {
  throw new Error(`Public UUID telemetry rotated a registered install identity: ${recoveredInstallResponse.status} ${JSON.stringify(recoveredInstallUpdate)}`);
}

const installerRecordCount = () => [...objects.keys()].filter((key) => key.startsWith('launcher-downloads/')).length;
const limitUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const limitIdentityDigest = crypto.createHash('sha256')
  .update(`minecraft-uuid\0${limitUuid}`)
  .digest('hex');
const limitObjectId = `launcher-installer-download:${limitIdentityDigest}`;
const limitPath = `/launcher/download/windows-x64?aht_uuid=${limitUuid}`;
const limitHeaders = {
  'CF-Connecting-IP': '198.51.100.70',
  'User-Agent': 'AHT installer limit test'
};
const headDownload = await worker.fetch(new Request(`https://worker.test${limitPath}`, {
  method: 'HEAD',
  headers: limitHeaders
}), env, {});
if (headDownload.status !== 302 || durableObjectStorage.has(limitObjectId)) {
  throw new Error('HEAD installer checks must neither fail nor consume a download slot.');
}

const downloadsBeforeLimitProof = installerRecordCount();
const acceptedResetHeaders = new Set();
for (let attempt = 1; attempt <= 7; attempt += 1) {
  const response = await worker.fetch(new Request(`https://worker.test${limitPath}`, {
    headers: limitHeaders
  }), env, {});
  const expectedRemaining = String(7 - attempt);
  if (response.status !== 302
      || response.headers.get('X-AHT-Download-Limit') !== '7'
      || response.headers.get('X-AHT-Download-Remaining') !== expectedRemaining) {
    throw new Error(`Installer download ${attempt} was not accepted with the correct quota: ${response.status} ${JSON.stringify([...response.headers])}`);
  }
  acceptedResetHeaders.add(response.headers.get('X-AHT-Download-Reset'));
}
if (acceptedResetHeaders.size !== 1 || installerRecordCount() !== downloadsBeforeLimitProof + 7) {
  throw new Error('The seven accepted downloads did not retain one anchored window or exactly seven telemetry records.');
}
const storedLimitWindow = durableObjectStorage.get(limitObjectId)?.get('launcherInstallerDownloadWindow');
if (Object.keys(storedLimitWindow || {}).sort().join(',') !== 'count,firstDownloadAt,schemaVersion'
    || storedLimitWindow.count !== 7
    || JSON.stringify(storedLimitWindow).includes(limitUuid)
    || JSON.stringify(storedLimitWindow).includes(limitHeaders['CF-Connecting-IP'])) {
  throw new Error(`Installer quota storage retained more than the anonymous window counter: ${JSON.stringify(storedLimitWindow)}`);
}
const eighthDownload = await worker.fetch(new Request(`https://worker.test${limitPath}`, {
  headers: limitHeaders
}), env, {});
const eighthDownloadBody = await eighthDownload.json();
const eighthRetryAfter = Number(eighthDownload.headers.get('Retry-After'));
if (eighthDownload.status !== 429
    || eighthDownloadBody.code !== 'LAUNCHER_INSTALLER_DOWNLOAD_LIMIT'
    || eighthDownloadBody.limit !== 7
    || !Number.isInteger(eighthRetryAfter)
    || eighthRetryAfter < 1
    || eighthRetryAfter > 86_400
    || installerRecordCount() !== downloadsBeforeLimitProof + 7) {
  throw new Error(`The eighth installer download was not rejected cleanly: ${eighthDownload.status} ${JSON.stringify(eighthDownloadBody)}`);
}

const expiredState = durableObjectStorage.get(limitObjectId);
expiredState.set('launcherInstallerDownloadWindow', {
  schemaVersion: 1,
  firstDownloadAt: Date.now() - (24 * 60 * 60 * 1000) - 1,
  count: 7
});
const firstDownloadAfterExpiry = await worker.fetch(new Request(`https://worker.test${limitPath}`, {
  headers: limitHeaders
}), env, {});
if (firstDownloadAfterExpiry.status !== 302
    || firstDownloadAfterExpiry.headers.get('X-AHT-Download-Remaining') !== '6'
    || installerRecordCount() !== downloadsBeforeLimitProof + 8) {
  throw new Error('The first download after the anchored 24-hour expiry did not start a fresh window.');
}

const beforeUpdaterExemption = installerRecordCount();
for (let attempt = 0; attempt < 9; attempt += 1) {
  const updateResponse = await worker.fetch(new Request(
    `https://worker.test/launcher/files/win32-x64/AHT-Windows.exe?aht_uuid=${limitUuid}`,
    { headers: limitHeaders }
  ), env, {});
  if (updateResponse.status !== 200) {
    throw new Error(`Untagged launcher self-update ${attempt + 1} was incorrectly limited: ${updateResponse.status}`);
  }
}
const updaterExempt = installerRecordCount() === beforeUpdaterExemption;
if (!updaterExempt) {
  throw new Error('Untagged launcher self-updates must stay unlimited and uncounted.');
}
if (durableObjectStorage.get(limitObjectId)?.get('launcherInstallerDownloadWindow')?.count !== 1) {
  throw new Error('Untagged launcher self-updates changed the installer quota counter.');
}

const concurrentUuid = '11111111-aaaa-4bbb-8ccc-222222222222';
const concurrentPath = `/launcher/download/windows-x64?aht_uuid=${concurrentUuid}`;
const beforeConcurrentProof = installerRecordCount();
const concurrentResponses = await Promise.all(Array.from({ length: 12 }, () => worker.fetch(new Request(
  `https://worker.test${concurrentPath}`,
  { headers: { 'CF-Connecting-IP': '198.51.100.71' } }
), env, {})));
const concurrentAccepted = concurrentResponses.filter((response) => response.status === 302).length;
const concurrentDenied = concurrentResponses.filter((response) => response.status === 429).length;
if (concurrentAccepted !== 7 || concurrentDenied !== 5 || installerRecordCount() !== beforeConcurrentProof + 7) {
  throw new Error(`Concurrent installer limit was not atomic: ${JSON.stringify({ concurrentAccepted, concurrentDenied })}`);
}

const taggedLimitUuid = '33333333-aaaa-4bbb-8ccc-444444444444';
const taggedLimitPath = `/launcher/files/win32-x64/AHT-Windows.exe?aht_download=windows-x64&aht_uuid=${taggedLimitUuid}`;
for (let attempt = 1; attempt <= 7; attempt += 1) {
  const response = await worker.fetch(new Request(`https://worker.test${taggedLimitPath}`, {
    headers: { 'CF-Connecting-IP': '198.51.100.72' }
  }), env, {});
  if (response.status !== 200 || response.headers.get('X-AHT-Download-Remaining') !== String(7 - attempt)) {
    throw new Error(`Tagged direct installer ${attempt} was not authorized correctly: ${response.status}`);
  }
}
const taggedEighth = await worker.fetch(new Request(`https://worker.test${taggedLimitPath}`, {
  headers: { 'CF-Connecting-IP': '198.51.100.72' }
}), env, {});
if (taggedEighth.status !== 429) {
  throw new Error(`Tagged direct installer bypassed the seven-download limit: ${taggedEighth.status}`);
}

const downloadLimitProof = {
  limit: 7,
  windowHours: 24,
  anchoredReset: acceptedResetHeaders.size === 1,
  eighthStatus: eighthDownload.status,
  retryAfterSeconds: eighthRetryAfter,
  concurrentAccepted,
  concurrentDenied,
  updaterExempt
};

console.log(JSON.stringify({ registration, launcherDownloads: allDownloadRecords, launcherUpdates: allLauncherUpdates, players: allPlayers, playerIpv4Groups, launcherProof: { source: launcherProof.source, trusted: launcherProof.trusted, tokenParts: launcherProof.token.split('.').length }, developerLauncherProof: { bypass: developerLauncherProof.payload.modIntegrityBypass, channel: developerLauncherProof.payload.launcherChannel, downstreamVerified: developerSocialResponse.status === 200 }, publishedLog, publicLogs, summary, events, downloadLimitProof }, null, 2));
