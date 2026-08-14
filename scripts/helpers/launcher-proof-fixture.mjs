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
  const legacy = options.legacy === true || payload?.protocol === 'aht-launcher-proof-v1';
  const kid = String(options.kid || (legacy ? 'aht-launcher-proof-v1' : 'aht-launcher-attestation-v2'));
  const header = legacy
    ? { alg: 'HS256', typ: 'AHT-LAUNCHER-PROOF', kid }
    : { alg: 'RS256', typ: 'AHT-LAUNCHER-ATTESTATION', kid };
  const launchId = legacy
    ? String(payload?.launchId || randomUUID())
    : String(options.launchId || payload?.launchId || randomUUID());
  const workerPayload = legacy
    ? { ...payload, protocol: 'aht-launcher-proof-v1', schemaVersion: 1, launchId }
    : {
      ...payload,
      protocol: 'aht-launcher-attestation-v2',
      schemaVersion: 2,
      jti: String(options.jti || launchId),
      launchId,
      issuer: String(options.issuer || 'aht-launcher-worker'),
      audience: String(options.audience || 'aht-minecraft-server'),
      minecraftUuid: normalizedUuid(options.minecraftUuid || payload?.minecraftUuid) || '01234567-89ab-4def-8123-456789abcdef'
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
