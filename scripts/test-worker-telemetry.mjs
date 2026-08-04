import crypto from 'node:crypto';
import worker from '../cloudflare/curseforge-proxy-worker.js';
import { sendLauncherEvent } from '../src/syncClient.js';

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

const objects = new Map();
const env = {
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'secret',
  ADMIN_TOKEN_SECRET: 'test-secret',
  LAUNCHER_PROOF_SECRET: 'proof-secret',
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
  downloads: {
    'windows-x64': { label: 'Windows 10/11', fileName: 'AHT-Windows.exe', path: 'launcher/files/win32-x64/AHT-Windows.exe' },
    'macos-arm64': { label: 'macOS Apple Silicon', fileName: 'AHT-arm64.dmg', path: 'launcher/files/darwin-arm64/AHT-arm64.dmg' },
    'macos-x64': { label: 'macOS Intel', fileName: 'AHT-x64.dmg', path: 'launcher/files/darwin-x64/AHT-x64.dmg' }
  }
}));
objects.set('launcher/files/win32-x64/AHT-Windows.exe', 'windows installer');
objects.set('launcher/files/darwin-arm64/AHT-arm64.dmg', 'mac arm installer');
objects.set('launcher/files/darwin-x64/AHT-x64.dmg', 'mac intel installer');

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

const windowsDownload = await trackedDownload('/launcher/download/windows-x64', {
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
if (!windowsDownload.endsWith('/launcher/files/win32-x64/AHT-Windows.exe')) {
  throw new Error(`Tracked Windows download redirected to the wrong file: ${windowsDownload}`);
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

const registration = await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '203.0.113.42',
    'User-Agent': 'AHT test'
  },
  body: JSON.stringify({
    username: 'TestRig',
    minecraftUuid: '0123456789abcdef0123456789abcdef',
    installId: 'install-b',
    appVersion: '0.1.81',
    platform: 'darwin',
    arch: 'x64',
    packId: 'a-hard-time-dregora'
  })
});

const repeatRegistration = await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'testrig',
    installId: 'install-b'
  })
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
    installedVersion: '2.8.2'
  })
});
if (!recoveredProof.trusted || recoveredProof.payload.installId !== 'install-new') {
  throw new Error(`Recovered username did not produce a proof for the new install: ${JSON.stringify(recoveredProof)}`);
}
const oldRecoveredProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ minecraftUsername: 'RecoveredRig', installId: 'install-old' })
}), env, {});
if (oldRecoveredProofResponse.status !== 403) {
  throw new Error(`Recovered username should reject the old install proof, got ${oldRecoveredProofResponse.status}`);
}

const launcherProof = await jsonRequest('/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    protocol: 'aht-launcher-proof-v1',
    launchId: 'launch-proof-test',
    username: 'TestRig',
    minecraftUsername: 'TestRig',
    installId: 'install-b',
    packId: 'a-hard-time-dregora',
    packVersion: '2.8.2',
    installedVersion: '2.8.2',
    appVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    instanceDirHash: 'abc123'
  })
});
if (
  !launcherProof.trusted
  || launcherProof.source !== 'worker'
  || launcherProof.signature?.alg !== 'HS256'
  || launcherProof.token.split('.').length !== 3
  || launcherProof.payload.minecraftUsername !== 'TestRig'
  || launcherProof.payload.installId !== 'install-b'
) {
  throw new Error(`Launcher proof signing failed: ${JSON.stringify(launcherProof)}`);
}

const fallbackProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-b'
  })
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
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-b'
  })
}), {
  AHT_DATA: env.AHT_DATA,
  CURSEFORGE_API_KEY: 'cf-key-is-not-a-proof-secret'
}, {});
const curseForgeOnlyProof = await curseForgeOnlyProofResponse.json();
if (curseForgeOnlyProofResponse.status !== 500 || !/LAUNCHER_PROOF_SECRET/i.test(curseForgeOnlyProof.error || '')) {
  throw new Error(`CurseForge API key should not sign launcher proofs: ${curseForgeOnlyProofResponse.status} ${JSON.stringify(curseForgeOnlyProof)}`);
}

const objectCountBeforeProofStatus = objects.size;
const proofStatus = await jsonRequest('/api/launcher-proof/status');
if (
  JSON.stringify(Object.keys(proofStatus).sort()) !== JSON.stringify(['configured', 'dedicatedConfigured', 'keyId', 'ok', 'signingVerified'])
  || !proofStatus.ok
  || !proofStatus.configured
  || !proofStatus.dedicatedConfigured
  || !proofStatus.signingVerified
  || proofStatus.keyId !== 'aht-launcher-proof-v1'
  || objects.size !== objectCountBeforeProofStatus
) {
  throw new Error(`Launcher proof status was not read-only/minimal: ${JSON.stringify(proofStatus)}`);
}
let proofStatusStorageTouched = false;
const inMemoryProofStatusResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof/status'), {
  LAUNCHER_PROOF_SECRET: env.LAUNCHER_PROOF_SECRET,
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
  || !adminFallbackProofStatus.configured
  || adminFallbackProofStatus.dedicatedConfigured
  || !adminFallbackProofStatus.signingVerified
) {
  throw new Error(`Admin-only fallback incorrectly passed production launcher proof status: ${adminFallbackProofStatusResponse.status} ${JSON.stringify(adminFallbackProofStatus)}`);
}
const invalidKeyProofStatusResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof/status'), {
  ...env,
  LAUNCHER_PROOF_KEY_ID: 'wrong-key-id'
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
    installId: 'install-c'
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
  if (!updateResult.accountRefreshed || !updateResult.launcherUpdateKey) {
    throw new Error(`Registered launcher update did not refresh its canonical account: ${JSON.stringify(updateResult)}`);
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
    installId: 'install-c'
  })
}), env, {});
const mismatchedUpdateBody = await mismatchedUpdateResponse.json();
if (mismatchedUpdateResponse.status !== 403 || !/does not match/i.test(mismatchedUpdateBody.error || '')) {
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
  allDownloadRecords.length !== 4
  || allDownloadRecords.some((item) => String(item.ipv4 || '').includes(':'))
  || allDownloadRecords.some((item) => item.minecraftUsername || item.minecraftUuid)
  || allDownloadRecords.some((item) => !['Windows', 'Mac'].includes(item.platform))
) {
  throw new Error(`Launcher download history must contain only IPv4 display values: ${JSON.stringify(allDownloadRecords)}`);
}
const pseudoIpv4Download = allDownloadRecords.find((item) => item.platformKey === 'macos-arm64');
if (!pseudoIpv4Download || pseudoIpv4Download.ipv4 || pseudoIpv4Download.ipv4Source !== 'ipv6-only') {
  throw new Error(`Cloudflare pseudo IPv4 must never be presented as a native player IPv4: ${JSON.stringify(pseudoIpv4Download)}`);
}
const ipv6OnlyDownload = allDownloadRecords.find((item) => item.platformKey === 'macos-x64');
if (!ipv6OnlyDownload || ipv6OnlyDownload.ipv4 || ipv6OnlyDownload.ipv4Source !== 'ipv6-only') {
  throw new Error(`IPv6-only visitors must be marked unavailable instead of exposing or inventing an IPv4: ${JSON.stringify(ipv6OnlyDownload)}`);
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
  || testRigPlayer.ipv4 !== '192.0.2.55'
  || testRigPlayer.platform !== 'Windows'
  || testRigPlayer.launcherVersion !== '0.1.82'
) {
  throw new Error(`Launcher update did not refresh the canonical player record: ${JSON.stringify(testRigPlayer)}`);
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
const secondUpdatePage = await jsonRequest(`/admin/launcher-updates?limit=2&cursor=${encodeURIComponent(firstUpdatePage.cursor)}`, { headers: auth });
const allLauncherUpdates = [...firstUpdatePage.updates, ...secondUpdatePage.updates];
if (allLauncherUpdates.length !== 2 || !firstUpdatePage.hasMore || !firstUpdatePage.cursor) {
  throw new Error(`Launcher update pagination/idempotency failed: ${JSON.stringify({ firstUpdatePage, secondUpdatePage })}`);
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
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'developer-install-not-registered',
    launcherChannel: 'developer',
    developerClient: true,
    developerClientBypass: true,
    modIntegrityBypass: true,
    packId: 'a-hard-time-dregora',
    installedVersion: '2.8.2'
  })
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
const wrongKidHeader = { alg: 'HS256', typ: 'AHT-LAUNCHER-PROOF', kid: 'wrong-key-id' };
const wrongKidInput = `${Buffer.from(JSON.stringify(wrongKidHeader)).toString('base64url')}.${Buffer.from(JSON.stringify(developerLauncherProof.payload)).toString('base64url')}`;
const wrongKidToken = `${wrongKidInput}.${crypto.createHmac('sha256', env.LAUNCHER_PROOF_SECRET).update(wrongKidInput).digest('base64url')}`;
const wrongKidSocialResponse = await worker.fetch(new Request('https://worker.test/api/social', {
  headers: { Authorization: `Bearer ${wrongKidToken}` }
}), env, {});
if (wrongKidSocialResponse.status !== 401) {
  throw new Error(`Downstream Worker proof verifier accepted the wrong anti-cheat key ID: ${wrongKidSocialResponse.status}`);
}
const wrongConfiguredKidResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ minecraftUsername: 'TestRig', installId: 'install-b' })
}), { ...env, LAUNCHER_PROOF_KEY_ID: 'wrong-key-id' }, {});
const wrongConfiguredKid = await wrongConfiguredKidResponse.json();
if (wrongConfiguredKidResponse.status !== 500 || !/LAUNCHER_PROOF_KEY_ID/i.test(wrongConfiguredKid.error || '')) {
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

console.log(JSON.stringify({ registration, launcherDownloads: allDownloadRecords, launcherUpdates: allLauncherUpdates, players: allPlayers, playerIpv4Groups, launcherProof: { source: launcherProof.source, trusted: launcherProof.trusted, tokenParts: launcherProof.token.split('.').length }, developerLauncherProof: { bypass: developerLauncherProof.payload.modIntegrityBypass, channel: developerLauncherProof.payload.launcherChannel, downstreamVerified: developerSocialResponse.status === 200 }, publishedLog, publicLogs, summary, events }, null, 2));
