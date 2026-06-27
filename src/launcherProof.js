import crypto from 'node:crypto';
import path from 'node:path';
import { writeJsonFile } from './utils.js';

export const LAUNCHER_PROOF_PROTOCOL = 'aht-launcher-proof-v1';
export const LAUNCHER_PROOF_FILE_NAME = 'launcher-proof.json';

function base64Url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlJson(value) {
  return base64Url(JSON.stringify(value));
}

function quoteJavaValue(value = '') {
  const text = String(value || '');
  return text.includes(' ') ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function proofBaseUrl(config = {}) {
  return config.launcherProof?.baseUrl
    || config.sync?.baseUrl
    || config.developer?.adminBaseUrl
    || '';
}

function proofSecret(config = {}, env = process.env) {
  return env.AHT_LAUNCHER_PROOF_SECRET
    || config.launcherProof?.localSecret
    || config.launcherProof?.secret
    || '';
}

function sha256Hex(value = '') {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function cleanString(value = '', max = 160) {
  return String(value || '').trim().slice(0, max);
}

export function launcherProofPath(instanceDir = '') {
  return path.join(instanceDir, '.aht-launcher', LAUNCHER_PROOF_FILE_NAME);
}

export function launcherProofJavaArgs(proofFile = '') {
  if (!proofFile) return [];
  return [
    '-Daht.launcher.present=true',
    `-Daht.launcher.protocol=${LAUNCHER_PROOF_PROTOCOL}`,
    `-Daht.launcher.proofFile=${quoteJavaValue(path.resolve(proofFile))}`
  ];
}

export function buildLauncherProofPayload({ config = {}, identity = {}, latest = null, installed = null, now = new Date() }) {
  const issuedAt = now instanceof Date ? now : new Date(now);
  const expiresAt = new Date(issuedAt.getTime() + 60 * 60 * 1000);
  const minecraft = latest?.minecraft || installed?.minecraft || null;
  return {
    protocol: LAUNCHER_PROOF_PROTOCOL,
    schemaVersion: 1,
    launchId: crypto.randomUUID(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    packId: cleanString(latest?.packId || installed?.packId || config.packId || 'a-hard-time-dregora', 80),
    packVersion: cleanString(installed?.version || latest?.version || '', 80),
    latestVersion: cleanString(latest?.version || '', 80),
    installedVersion: cleanString(installed?.version || '', 80),
    minecraftUsername: cleanString(identity.minecraftUsername || config.sync?.playerLabel || '', 16),
    installId: cleanString(identity.installId || '', 120),
    appVersion: cleanString(identity.appVersion || '', 40),
    platform: cleanString(identity.platform || process.platform, 32),
    arch: cleanString(identity.arch || process.arch, 32),
    launcherChannel: cleanString(identity.launcherChannel || 'player', 32),
    developerClient: Boolean(identity.developerClient),
    developerClientBypass: Boolean(identity.developerClientBypass),
    modIntegrityBypass: Boolean(identity.modIntegrityBypass),
    instanceDirHash: sha256Hex(path.resolve(config.instanceDir || '')),
    minecraft: minecraft ? {
      version: cleanString(minecraft.version || '', 40),
      modLoaders: Array.isArray(minecraft.modLoaders)
        ? minecraft.modLoaders.map((loader) => ({
          id: cleanString(loader?.id || '', 80),
          primary: Boolean(loader?.primary)
        }))
        : []
    } : null
  };
}

export function signLauncherProofPayload(payload, secret, keyId = 'aht-launcher-proof-v1') {
  const header = {
    alg: 'HS256',
    typ: 'AHT-LAUNCHER-PROOF',
    kid: keyId
  };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const value = crypto.createHmac('sha256', secret).update(signingInput).digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return {
    protocol: LAUNCHER_PROOF_PROTOCOL,
    schemaVersion: 1,
    trusted: true,
    source: 'local-hmac',
    token: `${signingInput}.${value}`,
    header,
    payload,
    signature: { alg: 'HS256', kid: keyId, value }
  };
}

async function requestWorkerProof({ config = {}, payload, fetchImpl = globalThis.fetch, authToken = '' }) {
  const base = proofBaseUrl(config);
  if (!base || typeof fetchImpl !== 'function') return null;
  const url = new URL('api/launcher-proof', base.endsWith('/') ? base : `${base}/`);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  if (!body?.token || !body?.payload || !body?.signature) {
    throw new Error('Worker did not return a launcher proof token.');
  }
  return {
    ...body,
    protocol: LAUNCHER_PROOF_PROTOCOL,
    schemaVersion: 1,
    trusted: true,
    source: 'worker'
  };
}

function unsignedProof(payload, error = '') {
  return {
    protocol: LAUNCHER_PROOF_PROTOCOL,
    schemaVersion: 1,
    trusted: false,
    source: 'unsigned-fallback',
    token: '',
    header: null,
    payload,
    signature: null,
    error
  };
}

export async function writeLauncherProof({ config = {}, identity = {}, latest = null, installed = null, fetchImpl = globalThis.fetch, authToken = '' } = {}) {
  if (config.launcherProof?.enabled === false) {
    return { enabled: false };
  }
  const proofFile = launcherProofPath(config.instanceDir || '');
  const payload = buildLauncherProofPayload({ config, identity, latest, installed });
  let proof = null;
  let remoteError = '';
  try {
    proof = await requestWorkerProof({ config, payload, fetchImpl, authToken });
  } catch (error) {
    remoteError = error.message || String(error);
  }
  if (!proof) {
    const secret = proofSecret(config);
    proof = secret
      ? signLauncherProofPayload(payload, secret, config.launcherProof?.keyId || 'aht-local-dev')
      : unsignedProof(payload, remoteError);
  }
  if (!proof.trusted && config.launcherProof?.required === true) {
    throw new Error(`Launcher proof signing failed: ${proof.error || 'no signing endpoint or local secret configured'}`);
  }

  const fileProof = {
    ...proof,
    proofFile: path.resolve(proofFile),
    javaProperties: launcherProofJavaArgs(proofFile),
    generatedAt: new Date().toISOString()
  };
  await writeJsonFile(proofFile, fileProof);
  return fileProof;
}
