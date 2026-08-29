import { generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';

const testKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

export const TEST_LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8 = testKeys.privateKey;
export const TEST_LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI = testKeys.publicKey;

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function normalizedUuid(value = '') {
  const compact = String(value || '').replace(/[{}-]/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact)) return '';
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function workerLauncherProofFixture(payload, options = {}) {
  const {
    deviceAssertion: _deviceAssertion,
    devicePublicKey: _devicePublicKey,
    accountRecoverySecret: _accountRecoverySecret,
    ...proofSafePayload
  } = payload || {};
  const legacy = options.legacy === true || payload?.protocol === 'aht-launcher-proof-v1';
  const kid = String(options.kid || (legacy ? 'aht-launcher-proof-v1' : 'aht-launcher-attestation-v2'));
  const header = legacy
    ? { alg: 'HS256', typ: 'AHT-LAUNCHER-PROOF', kid }
    : { alg: 'RS256', typ: 'AHT-LAUNCHER-ATTESTATION', kid };
  const launchId = legacy
    ? String(payload?.launchId || randomUUID())
    : String(options.launchId || payload?.launchId || randomUUID());
  const issuedAt = String(payload?.issuedAt || new Date().toISOString());
  const issuedAtMs = Date.parse(issuedAt);
  const workerPayload = legacy
    ? { ...proofSafePayload, protocol: 'aht-launcher-proof-v1', schemaVersion: 1, launchId }
    : {
      ...proofSafePayload,
      protocol: 'aht-launcher-attestation-v2',
      schemaVersion: 2,
      packId: String(options.packId || 'a-hard-time-dregora'),
      jti: String(options.jti || launchId),
      launchId,
      issuer: String(options.issuer || 'aht-launcher-worker'),
      audience: String(options.audience || 'aht-minecraft-server'),
      minecraftUuid: normalizedUuid(options.minecraftUuid || payload?.minecraftUuid) || '01234567-89ab-4def-8123-456789abcdef',
      launcherVersion: String(payload?.launcherVersion || payload?.appVersion || '0.1.86'),
      appVersion: String(payload?.appVersion || payload?.launcherVersion || '0.1.86'),
      launcherVersionAuthority: String(options.launcherVersionAuthority || payload?.launcherVersionAuthority || 'worker-policy-matched-device-assertion'),
      packVersion: String(payload?.packVersion || payload?.installedVersion || '2.9.0'),
      issuedAt,
      expiresAt: String(payload?.expiresAt || new Date((Number.isFinite(issuedAtMs) ? issuedAtMs : Date.now()) + 5 * 60 * 1000).toISOString()),
      reconnectExpiresAt: String(payload?.reconnectExpiresAt || new Date((Number.isFinite(issuedAtMs) ? issuedAtMs : Date.now()) + 24 * 60 * 60 * 1000).toISOString()),
      accessGranted: options.accessGranted !== false,
      networkStatus: String(options.networkStatus || 'unknown')
    };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(workerPayload)}`;
  const signatureValue = String(options.signature || (legacy
    ? 'test-signature'
    : signBytes('RSA-SHA256', Buffer.from(signingInput), testKeys.privateKey).toString('base64url')));
  return {
    protocol: workerPayload.protocol,
    schemaVersion: workerPayload.schemaVersion,
    trusted: true,
    source: 'worker',
    token: `${signingInput}.${signatureValue}`,
    header,
    payload: workerPayload,
    signature: { alg: header.alg, kid, value: signatureValue }
  };
}
