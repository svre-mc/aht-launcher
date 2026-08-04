import crypto from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { workerServiceBaseUrl } from './releaseTargets.js';
import { pathExists, readJsonFile, writeJsonFile } from './utils.js';

export const LAUNCHER_PROOF_PROTOCOL = 'aht-launcher-proof-v1';
export const LAUNCHER_PROOF_FILE_NAME = 'launcher-proof.json';
export const DEVELOPER_LAUNCHER_PROOF_FILE_NAME = 'launcher-proof.developer.json';

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
  return workerServiceBaseUrl(config.launcherProof?.baseUrl
    || config.sync?.baseUrl
    || config.developer?.adminBaseUrl
    || '');
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

function workerProofContractError(message) {
  const error = new Error(message);
  error.code = 'AHT_LAUNCHER_PROOF_RESPONSE_MISMATCH';
  return error;
}

function decodeBase64UrlJson(value = '') {
  const segment = String(value || '');
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('invalid base64url segment');
  }
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function launcherProofDocumentReasons(proof, {
  expectedSource = '',
  minValidityMs = 0,
  now = Date.now()
} = {}) {
  const reasons = [];
  const payload = proof?.payload || {};
  const tokenParts = String(proof?.token || '').split('.');
  let tokenHeader = null;
  let tokenPayload = null;

  if (proof?.trusted !== true) reasons.push('proof is not trusted');
  if (!['worker', 'local-hmac'].includes(proof?.source)) reasons.push('proof source is not trusted');
  if (expectedSource && proof?.source !== expectedSource) reasons.push('proof source mismatch');
  if (proof?.protocol !== LAUNCHER_PROOF_PROTOCOL || payload.protocol !== LAUNCHER_PROOF_PROTOCOL) reasons.push('protocol mismatch');
  if (proof?.schemaVersion !== 1 || payload.schemaVersion !== 1) reasons.push('schemaVersion mismatch');

  try {
    if (tokenParts.length !== 3 || tokenParts.some((part) => !part)) {
      throw new Error('expected three non-empty token parts');
    }
    tokenHeader = decodeBase64UrlJson(tokenParts[0]);
    tokenPayload = decodeBase64UrlJson(tokenParts[1]);
  } catch {
    reasons.push('token format mismatch');
  }

  if (tokenHeader && !isDeepStrictEqual(tokenHeader, proof?.header)) reasons.push('token header mismatch');
  if (tokenPayload && !isDeepStrictEqual(tokenPayload, payload)) reasons.push('token payload mismatch');
  if (
    proof?.header?.alg !== 'HS256'
    || proof?.header?.typ !== 'AHT-LAUNCHER-PROOF'
    || !cleanString(proof?.header?.kid || '', 120)
  ) reasons.push('header metadata mismatch');
  if (
    proof?.signature?.alg !== proof?.header?.alg
    || proof?.signature?.kid !== proof?.header?.kid
    || proof?.signature?.value !== tokenParts[2]
    || !/^[A-Za-z0-9_-]+$/.test(String(proof?.signature?.value || ''))
  ) reasons.push('signature metadata mismatch');

  const issuedAt = Date.parse(payload.issuedAt || '');
  const expiresAt = Date.parse(payload.expiresAt || '');
  const minimumExpiry = Number(now) + Math.max(0, Number(minValidityMs) || 0);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanString(payload.launchId || '', 80))) {
    reasons.push('launchId mismatch');
  }
  if (!Number.isFinite(issuedAt) || issuedAt > Number(now) + 120_000) reasons.push('issuedAt mismatch');
  if (
    !Number.isFinite(expiresAt)
    || expiresAt <= minimumExpiry
    || !Number.isFinite(issuedAt)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > 2 * 60 * 60 * 1000
  ) reasons.push('proof expired or expires too soon');

  return [...new Set(reasons)];
}

function launcherProofChannel(identityOrChannel = 'player') {
  const value = typeof identityOrChannel === 'string'
    ? identityOrChannel
    : identityOrChannel?.launcherChannel;
  return cleanString(value || 'player', 32).toLowerCase() === 'developer' ? 'developer' : 'player';
}

export function launcherProofPath(instanceDir = '', identityOrChannel = 'player', options = {}) {
  const fileName = launcherProofChannel(identityOrChannel) === 'developer'
    ? DEVELOPER_LAUNCHER_PROOF_FILE_NAME
    : LAUNCHER_PROOF_FILE_NAME;
  const proofDir = String(options?.proofDir || '').trim();
  return path.join(proofDir || path.join(instanceDir, '.aht-launcher'), fileName);
}

function launcherProofFiles(config = {}, identity = {}) {
  const instanceProof = launcherProofPath(config.instanceDir || '', identity);
  const configuredProof = config.launcherProof?.proofDir
    ? launcherProofPath(config.instanceDir || '', identity, { proofDir: config.launcherProof.proofDir })
    : instanceProof;
  return [...new Set([configuredProof, instanceProof].map((file) => path.resolve(file)))];
}

export function launcherProofJavaArgs(proofFile = '') {
  if (!proofFile) return [];
  return [
    '-Daht.launcher.present=true',
    `-Daht.launcher.protocol=${LAUNCHER_PROOF_PROTOCOL}`,
    `-Daht.launcher.proofFile=${quoteJavaValue(path.resolve(proofFile))}`
  ];
}

export async function inspectLauncherProof({
  config = {},
  identity = {},
  latest = null,
  installed = null,
  minValidityMs = 0,
  now = Date.now()
} = {}) {
  if (config.launcherProof?.enabled === false) {
    return { enabled: false, usable: true, trusted: false, source: 'disabled', reason: '' };
  }

  const proofFiles = launcherProofFiles(config, identity);
  let proofFile = proofFiles[0];
  for (const candidate of proofFiles) {
    if (await pathExists(candidate)) {
      proofFile = candidate;
      break;
    }
  }
  if (!(await pathExists(proofFile))) {
    return { enabled: true, usable: false, trusted: false, proofFile, proofFiles, reason: 'missing proof file' };
  }

  let proof = null;
  try {
    proof = await readJsonFile(proofFile);
  } catch (error) {
    return {
      enabled: true,
      usable: false,
      trusted: false,
      proofFile,
      proofFiles,
      reason: `unreadable proof file: ${error.message || error}`
    };
  }

  const payload = proof?.payload || {};
  const expectedPackId = cleanString(latest?.packId || installed?.packId || config.packId || '', 80);
  const expectedInstalledVersion = cleanString(installed?.version || '', 80);
  const expectedLatestVersion = cleanString(latest?.version || '', 80);
  const expectedUsername = cleanString(identity.minecraftUsername || config.sync?.playerLabel || '', 16);
  const expectedInstallId = cleanString(identity.installId || '', 120);
  const expectedInstanceHash = sha256Hex(path.resolve(config.instanceDir || ''));
  const expectedLauncherChannel = cleanString(identity.launcherChannel || 'player', 32);
  const expectedDeveloperClient = Boolean(identity.developerClient);
  const expectedDeveloperClientBypass = Boolean(identity.developerClientBypass);
  const expectedModIntegrityBypass = Boolean(identity.modIntegrityBypass);
  const expectedProofServiceBaseUrl = proofBaseUrl(config);
  const expectedKeyId = cleanString(config.launcherProof?.keyId || '', 120);
  const reasons = launcherProofDocumentReasons(proof, { minValidityMs, now });
  if (expectedPackId && cleanString(payload.packId || '', 80) !== expectedPackId) reasons.push('pack mismatch');
  if (expectedInstalledVersion && cleanString(payload.installedVersion || payload.packVersion || '', 80) !== expectedInstalledVersion) reasons.push('installed version mismatch');
  if (expectedLatestVersion && cleanString(payload.latestVersion || '', 80) !== expectedLatestVersion) reasons.push('latest version mismatch');
  if (expectedUsername && cleanString(payload.minecraftUsername || '', 16).toLowerCase() !== expectedUsername.toLowerCase()) reasons.push('Minecraft username mismatch');
  if (expectedInstallId && cleanString(payload.installId || '', 120) !== expectedInstallId) reasons.push('launcher install mismatch');
  if (cleanString(payload.instanceDirHash || '', 80) !== expectedInstanceHash) reasons.push('instance path mismatch');
  if (cleanString(payload.launcherChannel || 'player', 32) !== expectedLauncherChannel) reasons.push('launcher channel mismatch');
  if (payload.developerClient !== expectedDeveloperClient) reasons.push('developer client mismatch');
  if (payload.developerClientBypass !== expectedDeveloperClientBypass) reasons.push('developer client bypass mismatch');
  if (payload.modIntegrityBypass !== expectedModIntegrityBypass) reasons.push('mod integrity bypass mismatch');
  if (
    proof?.source === 'worker'
    && expectedProofServiceBaseUrl
    && workerServiceBaseUrl(proof?.proofServiceBaseUrl || '') !== expectedProofServiceBaseUrl
  ) reasons.push('proof signing service mismatch');
  if (
    expectedKeyId
    && cleanString(proof?.header?.kid || '', 120) !== expectedKeyId
  ) reasons.push('proof key mismatch');

  return {
    ...proof,
    enabled: true,
    usable: reasons.length === 0,
    proofFile: path.resolve(proofFile),
    proofFiles,
    reason: reasons.join(', ')
  };
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
    body: JSON.stringify(payload),
    signal: globalThis.AbortSignal?.timeout?.(15_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  if (!body?.token || !body?.header || !body?.payload || !body?.signature) {
    const responseFields = Object.keys(body || {}).sort().slice(0, 8).join(', ') || 'none';
    throw workerProofContractError(`Worker launcher proof response from ${url.pathname} was incomplete (response fields: ${responseFields}). Check the Worker API base URL.`);
  }
  const responsePayload = body.payload;
  const mismatches = [];
  const compareString = (field, max = 80, caseInsensitive = false) => {
    const expected = cleanString(payload?.[field] || '', max);
    const actual = cleanString(responsePayload?.[field] || '', max);
    if ((caseInsensitive ? expected.toLowerCase() : expected) !== (caseInsensitive ? actual.toLowerCase() : actual)) {
      mismatches.push(field);
    }
  };
  compareString('protocol', 80);
  compareString('launchId', 80);
  compareString('packId', 80);
  compareString('packVersion', 80);
  compareString('latestVersion', 80);
  compareString('installedVersion', 80);
  compareString('minecraftUsername', 16, true);
  compareString('installId', 120);
  compareString('instanceDirHash', 80);
  compareString('launcherChannel', 32);
  for (const field of ['developerClient', 'developerClientBypass', 'modIntegrityBypass']) {
    if (responsePayload?.[field] !== payload?.[field]) {
      mismatches.push(field);
    }
  }
  mismatches.push(...launcherProofDocumentReasons(body, {
    expectedSource: 'worker',
    minValidityMs: 2 * 60 * 1000
  }));
  const expectedKeyId = cleanString(config.launcherProof?.keyId || '', 120);
  if (expectedKeyId && cleanString(body.header?.kid || '', 120) !== expectedKeyId) {
    mismatches.push('proof key mismatch');
  }
  if (mismatches.length) {
    throw workerProofContractError(`Worker launcher proof response did not match the request (${[...new Set(mismatches)].join(', ')}).`);
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
  const proofFiles = launcherProofFiles(config, identity);
  const proofFile = proofFiles[0];
  const payload = buildLauncherProofPayload({ config, identity, latest, installed });
  let proof = null;
  let remoteError = '';
  try {
    proof = await requestWorkerProof({ config, payload, fetchImpl, authToken });
  } catch (error) {
    if (error?.code === 'AHT_LAUNCHER_PROOF_RESPONSE_MISMATCH') throw error;
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
    proofServiceBaseUrl: proof.source === 'worker' ? proofBaseUrl(config) : '',
    proofFile: path.resolve(proofFile),
    javaProperties: launcherProofJavaArgs(proofFile),
    generatedAt: new Date().toISOString()
  };
  await writeJsonFile(proofFile, fileProof);
  // Keep the pack-local copy as a compatibility mirror for older profiles and
  // client reporters. The canonical copy lives in launcher user-data so an
  // Electron installer update cannot orphan the proof path.
  for (const compatibilityFile of proofFiles.slice(1)) {
    if (compatibilityFile === proofFile) continue;
    await writeJsonFile(compatibilityFile, {
      ...fileProof,
      proofFile: compatibilityFile,
      javaProperties: launcherProofJavaArgs(compatibilityFile)
    }).catch(() => {});
  }
  return fileProof;
}
