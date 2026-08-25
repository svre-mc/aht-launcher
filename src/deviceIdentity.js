import crypto from 'node:crypto';

export const DEVICE_IDENTITY_PROTOCOL = 'aht-device-identity-v1';
export const DEVICE_ASSERTION_PROTOCOL = 'aht-device-assertion-v1';
export const DEVICE_ID_PREFIX = 'ahtd_';

function cleanString(value = '', maxLength = 512) {
  return String(value || '').trim().slice(0, maxLength);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function publicKeyBytes(publicKey = '') {
  const value = cleanString(publicKey, 1024);
  if (!/^[A-Za-z0-9_-]{40,800}$/.test(value)) {
    throw new Error('Device public key is invalid.');
  }
  return Buffer.from(value, 'base64url');
}

export function deviceIdFromPublicKey(publicKey = '') {
  return `${DEVICE_ID_PREFIX}${sha256Hex(publicKeyBytes(publicKey))}`;
}

export function createDeviceCredential(now = new Date()) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyEncoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  return {
    schemaVersion: 1,
    protocol: DEVICE_IDENTITY_PROTOCOL,
    algorithm: 'Ed25519',
    deviceId: deviceIdFromPublicKey(publicKeyEncoded),
    publicKey: publicKeyEncoded,
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    createdAt: (now instanceof Date ? now : new Date(now)).toISOString()
  };
}

export function validateDeviceCredential(credential = {}) {
  const publicKey = cleanString(credential.publicKey, 1024);
  const privateKey = cleanString(credential.privateKey, 2048);
  const deviceId = cleanString(credential.deviceId, 80);
  if (credential.protocol !== DEVICE_IDENTITY_PROTOCOL
      || credential.algorithm !== 'Ed25519'
      || deviceId !== deviceIdFromPublicKey(publicKey)
      || !/^[A-Za-z0-9_-]{40,1600}$/.test(privateKey)) {
    throw new Error('Device identity credential is invalid.');
  }
  const publicKeyObject = crypto.createPublicKey({
    key: publicKeyBytes(publicKey),
    format: 'der',
    type: 'spki'
  });
  const privateKeyObject = crypto.createPrivateKey({
    key: Buffer.from(privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8'
  });
  const challenge = crypto.randomBytes(32);
  const signature = crypto.sign(null, challenge, privateKeyObject);
  if (!crypto.verify(null, challenge, publicKeyObject, signature)) {
    throw new Error('Device identity public and private keys do not match.');
  }
  return {
    ...credential,
    schemaVersion: 1,
    protocol: DEVICE_IDENTITY_PROTOCOL,
    algorithm: 'Ed25519',
    deviceId,
    publicKey,
    privateKey
  };
}

export function deviceBindingHash(binding = {}) {
  return sha256Hex(Buffer.from(canonicalJson(binding), 'utf8'));
}

export function deviceAssertionMessage(assertion = {}) {
  return [
    DEVICE_ASSERTION_PROTOCOL,
    cleanString(assertion.deviceId, 80),
    cleanString(assertion.purpose, 80),
    cleanString(assertion.signedAt, 80),
    cleanString(assertion.nonce, 80),
    cleanString(assertion.bindingHash, 80)
  ].join('\n');
}

export function createDeviceAssertion(credentialInput = {}, {
  purpose = '',
  binding = {},
  now = new Date(),
  nonce = crypto.randomUUID()
} = {}) {
  const credential = validateDeviceCredential(credentialInput);
  const assertion = {
    protocol: DEVICE_ASSERTION_PROTOCOL,
    algorithm: 'Ed25519',
    deviceId: credential.deviceId,
    publicKey: credential.publicKey,
    purpose: cleanString(purpose, 80),
    signedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    nonce: cleanString(nonce, 80),
    bindingHash: deviceBindingHash(binding)
  };
  if (!assertion.purpose || !/^[0-9a-f-]{36}$/i.test(assertion.nonce)) {
    throw new Error('Device assertion purpose or nonce is invalid.');
  }
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(credential.privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8'
  });
  return {
    ...assertion,
    signature: crypto.sign(null, Buffer.from(deviceAssertionMessage(assertion), 'utf8'), privateKey).toString('base64url')
  };
}
