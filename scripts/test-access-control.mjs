import worker from '../cloudflare/curseforge-proxy-worker.js';
import { createDeviceAssertion, createDeviceCredential } from '../src/deviceIdentity.js';
import { buildLauncherProofPayload, launcherProofDeviceBinding } from '../src/launcherProof.js';
import {
  TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8,
  TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI,
  workerLauncherProofFixture
} from './helpers/launcher-proof-fixture.mjs';

const objects = new Map();
const releaseObjects = new Map();
const dataBucket = {
  async put(key, value) { objects.set(key, value); },
  async get(key) {
    const value = objects.get(key);
    if (value === undefined) return null;
    return { async json() { return JSON.parse(value); } };
  },
  async list({ prefix = '', limit = 1000, cursor = '' } = {}) {
    const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = Number(cursor || 0);
    const page = keys.slice(start, start + limit);
    const next = start + page.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated: next < keys.length,
      cursor: next < keys.length ? String(next) : ''
    };
  }
};
const releaseBucket = {
  async get(key) {
    const value = releaseObjects.get(key);
    if (value === undefined) return null;
    return { async json() { return JSON.parse(value); } };
  }
};

const env = {
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'test-admin-password',
  ADMIN_TOKEN_SECRET: 'test-admin-token-secret-at-least-32-bytes',
  AHT_REQUIRE_DEVICE_ATTESTATION: 'true',
  AHT_REQUIRED_LAUNCHER_VERSION: '0.1.86',
  AHT_VPN_ASNS: '64512',
  LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8: TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8,
  LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI: TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI,
  LAUNCHER_ATTESTATION_KEY_ID: 'aht-launcher-attestation-v2',
  AHT_DATA: dataBucket,
  AHT_RELEASES: releaseBucket
};

function request(pathname, options = {}, cf = null) {
  const value = new Request(`https://worker.test${pathname}`, options);
  if (cf) Object.defineProperty(value, 'cf', { value: cf, configurable: true });
  return value;
}

async function workerJson(pathname, options = {}, cf = null) {
  const response = await worker.fetch(request(pathname, options, cf), env, {});
  return { response, body: await response.json() };
}

const username = 'DeviceRig';
const minecraftUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const installId = 'device-install-test';
const device = createDeviceCredential();
const registration = {
  username,
  minecraftUuid,
  installId,
  deviceId: device.deviceId,
  devicePublicKey: device.publicKey,
  appVersion: '0.1.86',
  platform: 'win32',
  arch: 'x64',
  packId: 'a-hard-time-dregora'
};
registration.deviceAssertion = createDeviceAssertion(device, {
  purpose: 'account-registration',
  binding: {
    username: username.toLowerCase(),
    minecraftUuid,
    installId,
    deviceId: device.deviceId
  }
});

const registered = await workerJson('/api/users/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-AHT-Launcher-Recovery': 'device_test_recovery_secret_123456789012345',
    'CF-Connecting-IP': '203.0.113.77'
  },
  body: JSON.stringify(registration)
}, { asn: 64512, asOrganization: 'Test VPN Network', country: 'US', colo: 'LAX' });
if (!registered.response.ok || registered.body.deviceId !== device.deviceId) {
  throw new Error(`Device registration failed: ${registered.response.status} ${JSON.stringify(registered.body)}`);
}

const missingDevice = await workerJson('/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-AHT-Launcher-Recovery': 'another_test_recovery_secret_123456789012' },
  body: JSON.stringify({ username: 'NoDeviceRig', minecraftUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', installId: 'missing-device' })
});
if (missingDevice.response.status !== 403 || missingDevice.body.code !== 'DEVICE_ATTESTATION_REQUIRED') {
  throw new Error(`Required device assertion was bypassed: ${missingDevice.response.status} ${JSON.stringify(missingDevice.body)}`);
}

const login = await workerJson('/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'test-admin-password' })
});
if (!login.response.ok || !login.body.token) throw new Error(`Admin login failed: ${JSON.stringify(login.body)}`);
const auth = { Authorization: `Bearer ${login.body.token}` };

const players = await workerJson('/admin/player-records', { headers: auth });
const player = players.body.players?.find((item) => item.minecraftUsername === username);
if (!player || player.ipv4 !== '203.0.113.77' || player.deviceId !== device.deviceId
    || player.network?.status !== 'likely' || player.network?.asn !== 64512) {
  throw new Error(`Player network/device data was incomplete: ${JSON.stringify(player)}`);
}

const ipv6Device = createDeviceCredential();
const ipv6Registration = {
  username: 'Ipv6Rig',
  minecraftUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  installId: 'ipv6-install-test',
  deviceId: ipv6Device.deviceId,
  devicePublicKey: ipv6Device.publicKey,
  appVersion: '0.1.86',
  platform: 'win32',
  arch: 'x64',
  packId: 'a-hard-time-dregora'
};
ipv6Registration.deviceAssertion = createDeviceAssertion(ipv6Device, {
  purpose: 'account-registration',
  binding: {
    username: 'ipv6rig',
    minecraftUuid: ipv6Registration.minecraftUuid,
    installId: ipv6Registration.installId,
    deviceId: ipv6Device.deviceId
  }
});
const ipv6Registered = await workerJson('/api/users/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-AHT-Launcher-Recovery': 'ipv6_test_recovery_secret_123456789012345',
    'CF-Connecting-IP': '2001:db8::77'
  },
  body: JSON.stringify(ipv6Registration)
});
if (!ipv6Registered.response.ok) throw new Error(`IPv6 registration failed: ${JSON.stringify(ipv6Registered.body)}`);
const playersWithIpv6 = await workerJson('/admin/player-records', { headers: auth });
const ipv6Player = playersWithIpv6.body.players?.find((item) => item.minecraftUsername === 'Ipv6Rig');
if (ipv6Player?.ip !== '2001:db8::77' || ipv6Player.ipVersion !== 6 || ipv6Player.ipv4) {
  throw new Error(`Native IPv6 was not preserved: ${JSON.stringify(ipv6Player)}`);
}

async function setDecision(action, scope, value, reason = '') {
  return workerJson('/admin/access-decisions', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, scope, value, reason })
  });
}

const deviceBan = await setDecision('deny', 'device', device.deviceId, 'Device access test restriction');
if (!deviceBan.response.ok || !deviceBan.body.decision?.active) {
  throw new Error(`Device restriction failed: ${JSON.stringify(deviceBan.body)}`);
}

function proofRequestPayload() {
  const payload = buildLauncherProofPayload({
    config: { instanceDir: 'C:/AHT/RLCraft Dregora', packId: 'a-hard-time-dregora' },
    identity: {
      minecraftUsername: username,
      minecraftUuid,
      installId,
      appVersion: '0.1.86',
      platform: 'win32',
      arch: 'x64',
      launcherChannel: 'player'
    },
    latest: { packId: 'a-hard-time-dregora', version: '2.9.0' },
    installed: { packId: 'a-hard-time-dregora', version: '2.9.0' }
  });
  payload.deviceId = device.deviceId;
  payload.devicePublicKey = device.publicKey;
  payload.deviceAssertion = createDeviceAssertion(device, {
    purpose: 'launcher-proof',
    binding: launcherProofDeviceBinding(payload)
  });
  return payload;
}

const blockedProof = await workerJson('/api/launcher-proof', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-AHT-Launcher-Recovery': 'device_test_recovery_secret_123456789012345',
    'CF-Connecting-IP': '203.0.113.77'
  },
  body: JSON.stringify(proofRequestPayload())
}, { asn: 64512, asOrganization: 'Test VPN Network', country: 'US', colo: 'LAX' });
if (blockedProof.response.status !== 403 || blockedProof.body.code !== 'ACCESS_DENIED') {
  throw new Error(`Device restriction did not block proof issuance: ${blockedProof.response.status} ${JSON.stringify(blockedProof.body)}`);
}

const deviceRestore = await setDecision('allow', 'device', device.deviceId, 'Device access restored after test');
if (!deviceRestore.response.ok || deviceRestore.body.decision?.active) {
  throw new Error(`Device restore failed: ${JSON.stringify(deviceRestore.body)}`);
}

const allowedProof = await workerJson('/api/launcher-proof', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-AHT-Launcher-Recovery': 'device_test_recovery_secret_123456789012345',
    'CF-Connecting-IP': '203.0.113.77'
  },
  body: JSON.stringify(proofRequestPayload())
}, { asn: 64512, asOrganization: 'Test VPN Network', country: 'US', colo: 'LAX' });
if (!allowedProof.response.ok || allowedProof.body.payload?.deviceId !== device.deviceId
    || allowedProof.body.payload?.networkStatus !== 'likely'
    || !allowedProof.body.payload?.reconnectExpiresAt) {
  throw new Error(`Restored device could not obtain proof: ${allowedProof.response.status} ${JSON.stringify(allowedProof.body)}`);
}
const verifiedSession = await workerJson('/api/launcher-proof/verify', {
  headers: { Authorization: `Bearer ${allowedProof.body.token}` }
});
if (!verifiedSession.response.ok || verifiedSession.body.session?.deviceId !== device.deviceId
    || verifiedSession.body.session?.minecraftUsername !== username
    || verifiedSession.body.policy?.necessaryLauncherVersion !== '0.1.86') {
  throw new Error(`Server-facing proof verification failed: ${verifiedSession.response.status} ${JSON.stringify(verifiedSession.body)}`);
}
const limitedVerification = await worker.fetch(request('/api/launcher-proof/verify', {
  headers: {
    Authorization: `Bearer ${allowedProof.body.token}`,
    'CF-Connecting-IP': '198.51.100.42'
  }
}), {
  ...env,
  AHT_PROOF_VERIFY_RATE_LIMITER: { async limit() { return { success: false }; } }
}, {});
if (limitedVerification.status !== 429 || limitedVerification.headers.get('Retry-After') !== '60') {
  throw new Error(`Configured proof verification rate limiting did not fail closed: ${limitedVerification.status}`);
}
const oversizedLogin = await worker.fetch(request('/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'x'.repeat(5000) })
}), env, {});
if (oversizedLogin.status !== 413) {
  throw new Error(`Oversized admin request was not rejected before parsing: ${oversizedLogin.status}`);
}
const reconnectProof = workerLauncherProofFixture({
  minecraftUsername: username,
  minecraftUuid,
  installId,
  deviceId: device.deviceId,
  launcherVersion: '0.1.86',
  launcherChannel: 'player',
  issuedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
  reconnectExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
});
const reconnectSession = await workerJson('/api/launcher-proof/verify', {
  headers: { Authorization: `Bearer ${reconnectProof.token}` }
});
if (!reconnectSession.response.ok || reconnectSession.body.session?.launcherVersion !== '0.1.86') {
  throw new Error(`Signed reconnect window was rejected after the short proof window: ${reconnectSession.response.status} ${JSON.stringify(reconnectSession.body)}`);
}
env.AHT_REQUIRED_LAUNCHER_VERSION = '0.1.87';
const staleSession = await workerJson('/api/launcher-proof/verify', {
  headers: { Authorization: `Bearer ${allowedProof.body.token}` }
});
if (staleSession.response.status !== 426
    || staleSession.body.code !== 'LAUNCHER_UPDATE_REQUIRED'
    || staleSession.body.currentLauncherVersion !== '0.1.86'
    || staleSession.body.necessaryLauncherVersion !== '0.1.87') {
  throw new Error(`A published launcher floor did not invalidate an old reconnect: ${staleSession.response.status} ${JSON.stringify(staleSession.body)}`);
}
const staleIssuance = await workerJson('/api/launcher-proof', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-AHT-Launcher-Recovery': 'device_test_recovery_secret_123456789012345',
    'CF-Connecting-IP': '203.0.113.77'
  },
  body: JSON.stringify(proofRequestPayload())
});
if (staleIssuance.response.status !== 426 || staleIssuance.body.code !== 'LAUNCHER_UPDATE_REQUIRED') {
  throw new Error(`An outdated launcher obtained a new proof: ${staleIssuance.response.status} ${JSON.stringify(staleIssuance.body)}`);
}
delete env.AHT_REQUIRED_LAUNCHER_VERSION;
releaseObjects.set('launcher/latest.json', JSON.stringify({
  schemaVersion: 1,
  product: 'aht-launcher',
  version: '0.1.88',
  required: true
}));
const manifestPolicySession = await workerJson('/api/launcher-proof/verify', {
  headers: { Authorization: `Bearer ${allowedProof.body.token}` }
});
if (manifestPolicySession.response.status !== 426
    || manifestPolicySession.body.currentLauncherVersion !== '0.1.86'
    || manifestPolicySession.body.necessaryLauncherVersion !== '0.1.88') {
  throw new Error(`launcher/latest.json did not become the live reconnect policy: ${manifestPolicySession.response.status} ${JSON.stringify(manifestPolicySession.body)}`);
}
env.AHT_REQUIRED_LAUNCHER_VERSION = '0.1.86';
const invalidNetworkProof = workerLauncherProofFixture({
  minecraftUsername: username,
  minecraftUuid,
  installId,
  deviceId: device.deviceId,
  launcherChannel: 'player',
  developerClient: false,
  developerClientBypass: false,
  modIntegrityBypass: false,
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
}, { networkStatus: 'untrusted-client-value' });
const invalidNetworkSession = await workerJson('/api/launcher-proof/verify', {
  headers: { Authorization: `Bearer ${invalidNetworkProof.token}` }
});
if (invalidNetworkSession.response.status !== 401 || invalidNetworkSession.body.accessGranted !== false) {
  throw new Error(`Invalid network claim was accepted: ${invalidNetworkSession.response.status} ${JSON.stringify(invalidNetworkSession.body)}`);
}

const accountBan = await setDecision('deny', 'account', username, 'Account access test restriction');
if (!accountBan.response.ok) throw new Error(`Account restriction failed: ${JSON.stringify(accountBan.body)}`);
const downstream = await workerJson('/api/launcher-proof/verify', {
  headers: { Authorization: `Bearer ${allowedProof.body.token}` }
});
if (downstream.response.status !== 403) {
  throw new Error(`Existing launcher proof ignored a new account restriction: ${downstream.response.status}`);
}
await setDecision('allow', 'account', username, 'Account access restored after test');

const ipBan = await setDecision('deny', 'ip', '2001:db8::77', 'IPv6 access test restriction');
if (!ipBan.response.ok) throw new Error(`IPv6 restriction failed: ${JSON.stringify(ipBan.body)}`);
ipv6Registration.deviceAssertion = createDeviceAssertion(ipv6Device, {
  purpose: 'account-registration',
  binding: {
    username: 'ipv6rig',
    minecraftUuid: ipv6Registration.minecraftUuid,
    installId: ipv6Registration.installId,
    deviceId: ipv6Device.deviceId
  }
});
const blockedIpv6 = await workerJson('/api/users/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-AHT-Launcher-Recovery': 'ipv6_test_recovery_secret_123456789012345',
    'CF-Connecting-IP': '2001:db8::77'
  },
  body: JSON.stringify(ipv6Registration)
});
if (blockedIpv6.response.status !== 403 || blockedIpv6.body.code !== 'ACCESS_DENIED') {
  throw new Error(`IPv6 restriction was not enforced: ${blockedIpv6.response.status} ${JSON.stringify(blockedIpv6.body)}`);
}
await setDecision('allow', 'ip', '2001:db8::77', 'IPv6 access restored after test');

const tampered = proofRequestPayload();
tampered.deviceAssertion.bindingHash = '0'.repeat(64);
const tamperedResponse = await workerJson('/api/launcher-proof', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-AHT-Launcher-Recovery': 'device_test_recovery_secret_123456789012345'
  },
  body: JSON.stringify(tampered)
});
if (tamperedResponse.response.status !== 403 || tamperedResponse.body.code !== 'DEVICE_ATTESTATION_REQUIRED') {
  throw new Error(`Tampered device assertion was accepted: ${tamperedResponse.response.status} ${JSON.stringify(tamperedResponse.body)}`);
}

const decisions = await workerJson('/admin/access-decisions?history=true', { headers: auth });
const auditKeys = [...objects.keys()].filter((key) => key.startsWith('access/audit/'));
if (!decisions.response.ok
    || decisions.body.decisions?.length !== 3
    || decisions.body.audit?.length !== 6
    || decisions.body.auditCount !== 6
    || auditKeys.length !== 6) {
  throw new Error(`Access audit trail is incomplete: decisions=${JSON.stringify(decisions.body)} audit=${auditKeys.length}`);
}

console.log(JSON.stringify({
  deviceId: device.deviceId,
  ipv4: player.ipv4,
  ipv6: ipv6Player.ip,
  networkStatus: player.network.status,
  networkAsn: player.network.asn,
  deviceBanBlockedProof: blockedProof.response.status === 403,
  serverFacingProofVerified: verifiedSession.response.ok,
  proofVerificationRateLimited: limitedVerification.status === 429,
  oversizedBodyRejected: oversizedLogin.status === 413,
  expiredShortProofReconnectAccepted: reconnectSession.response.ok,
  publishedLauncherFloorInvalidatedReconnect: staleSession.response.status === 426,
  launcherManifestAutomaticallyControlsReconnects: manifestPolicySession.response.status === 426,
  invalidNetworkClaimRejected: invalidNetworkSession.response.status === 401,
  accountBanInvalidatedExistingProof: downstream.response.status === 403,
  ipv6BanBlockedRegistration: blockedIpv6.response.status === 403,
  tamperedAssertionRejected: tamperedResponse.response.status === 403,
  currentDecisions: decisions.body.decisions.length,
  auditEvents: auditKeys.length
}, null, 2));
