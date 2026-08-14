import crypto from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { workerServiceBaseUrl } from './releaseTargets.js';
import { pathExists, readJsonFile, writeJsonFile } from './utils.js';

export const LAUNCHER_PROOF_PROTOCOL = 'aht-launcher-attestation-v2';
export const LEGACY_LAUNCHER_PROOF_PROTOCOL = 'aht-launcher-proof-v1';
export const LAUNCHER_ATTESTATION_KEY_ID = 'aht-launcher-attestation-v2';
export const LEGACY_LAUNCHER_PROOF_KEY_ID = 'aht-launcher-proof-v1';
export const LAUNCHER_ATTESTATION_ISSUER = 'aht-launcher-worker';
export const LAUNCHER_ATTESTATION_AUDIENCE = 'aht-minecraft-server';
export const LAUNCHER_ATTESTATION_PACK_ID = 'a-hard-time-dregora';
export const LAUNCHER_PROOF_FILE_NAME = 'launcher-proof.json';
export const DEVELOPER_LAUNCHER_PROOF_FILE_NAME = 'launcher-proof.developer.json';

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

function sha256Hex(value = '') {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function cleanString(value = '', max = 160) {
  return String(value || '').trim().slice(0, max);
}

function normalizeMinecraftUuid(value = '') {
  const compact = cleanString(value, 80).replace(/[{}-]/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact) || /^0{32}$/.test(compact)) return '';
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20)
  ].join('-');
}

function workerProofContractError(message) {
  const error = new Error(message);
  error.code = 'AHT_LAUNCHER_PROOF_RESPONSE_MISMATCH';
  return error;
}

function launcherProofDocumentReasons(proof, {
  expectedSource = '',
  minValidityMs = 0,
  now = Date.now()
} = {}) {
  const reasons = [];
  const payload = proof?.payload || {};
  const tokenText = String(proof?.token || '');
  const tokenParts = tokenText.split('.');
  let tokenHeader = null;
  let tokenPayload = null;
  let tokenHeaderText = '';
  let tokenPayloadText = '';
  const protocol = cleanString(payload.protocol || '', 80);
  const proofProtocol = cleanString(proof?.protocol || '', 80);
  const v2 = protocol === LAUNCHER_PROOF_PROTOCOL && proofProtocol === LAUNCHER_PROOF_PROTOCOL;
  const legacyV1 = protocol === LEGACY_LAUNCHER_PROOF_PROTOCOL
    && proofProtocol === LEGACY_LAUNCHER_PROOF_PROTOCOL;

  if (proof?.trusted !== true) reasons.push('proof is not trusted');
  if (proof?.source !== 'worker') reasons.push('proof source is not trusted');
  if (expectedSource && proof?.source !== expectedSource) reasons.push('proof source mismatch');
  if (!v2 && !legacyV1) reasons.push('protocol mismatch');
  if ((v2 && (proof?.schemaVersion !== 2 || payload.schemaVersion !== 2))
      || (legacyV1 && (proof?.schemaVersion !== 1 || payload.schemaVersion !== 1))) {
    reasons.push('schemaVersion mismatch');
  }
  if (tokenText.length > 8192
      || tokenParts[0]?.length > 1024
      || tokenParts[1]?.length > 6144
      || tokenParts[2]?.length > 1024
      || JSON.stringify(proof?.header || {}).length > 512
      || JSON.stringify(payload).length > 4608) {
    reasons.push('proof exceeds size limit');
  }

  try {
    if (tokenParts.length !== 3 || tokenParts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw new Error('expected three non-empty token parts');
    }
    tokenHeaderText = Buffer.from(tokenParts[0], 'base64url').toString('utf8');
    tokenPayloadText = Buffer.from(tokenParts[1], 'base64url').toString('utf8');
    tokenHeader = JSON.parse(tokenHeaderText);
    tokenPayload = JSON.parse(tokenPayloadText);
  } catch {
    reasons.push('token format mismatch');
  }

  if (tokenHeader && !isDeepStrictEqual(tokenHeader, proof?.header)) reasons.push('token header mismatch');
  if (tokenPayload && !isDeepStrictEqual(tokenPayload, payload)) reasons.push('token payload mismatch');
  if (tokenHeaderText && tokenHeaderText !== JSON.stringify(proof?.header)) reasons.push('token header serialization mismatch');
  if (tokenPayloadText && tokenPayloadText !== JSON.stringify(payload)) reasons.push('token payload serialization mismatch');
  if (v2) {
    if (
      proof?.header?.alg !== 'RS256'
      || proof?.header?.typ !== 'AHT-LAUNCHER-ATTESTATION'
      || proof?.header?.kid !== LAUNCHER_ATTESTATION_KEY_ID
    ) reasons.push('header metadata mismatch');
    if (payload.issuer !== LAUNCHER_ATTESTATION_ISSUER) reasons.push('issuer mismatch');
    if (payload.audience !== LAUNCHER_ATTESTATION_AUDIENCE) reasons.push('audience mismatch');
    if (payload.packId !== LAUNCHER_ATTESTATION_PACK_ID) reasons.push('pack mismatch');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanString(payload.jti || '', 80))) {
      reasons.push('jti mismatch');
    }
    if (payload.jti !== payload.launchId) reasons.push('jti mismatch');
    if (!normalizeMinecraftUuid(payload.minecraftUuid || '')) reasons.push('Minecraft UUID mismatch');
  } else if (legacyV1 && (
    proof?.header?.alg !== 'HS256'
    || proof?.header?.typ !== 'AHT-LAUNCHER-PROOF'
    || proof?.header?.kid !== LEGACY_LAUNCHER_PROOF_KEY_ID
  )) {
    reasons.push('header metadata mismatch');
  }
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
    || expiresAt - issuedAt > (v2 ? 10 * 60 * 1000 : 2 * 60 * 60 * 1000)
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
  const expectedPackId = payload.protocol === LAUNCHER_PROOF_PROTOCOL
    ? LAUNCHER_ATTESTATION_PACK_ID
    : cleanString(latest?.packId || installed?.packId || config.packId || '', 80);
  const expectedInstalledVersion = cleanString(installed?.version || '', 80);
  const expectedLatestVersion = cleanString(latest?.version || '', 80);
  const expectedUsername = cleanString(identity.minecraftUsername || config.sync?.playerLabel || '', 16);
  const expectedMinecraftUuid = normalizeMinecraftUuid(identity.minecraftUuid || identity.minecraftUUID || '');
  const expectedInstallId = cleanString(identity.installId || '', 120);
  const expectedInstanceHash = sha256Hex(path.resolve(config.instanceDir || ''));
  const expectedLauncherChannel = cleanString(identity.launcherChannel || 'player', 32);
  const expectedDeveloperClient = Boolean(identity.developerClient);
  const expectedDeveloperClientBypass = Boolean(identity.developerClientBypass);
  const expectedModIntegrityBypass = Boolean(identity.modIntegrityBypass);
  const expectedProofServiceBaseUrl = proofBaseUrl(config);
  const reasons = launcherProofDocumentReasons(proof, { minValidityMs, now });
  if (expectedPackId && cleanString(payload.packId || '', 80) !== expectedPackId) reasons.push('pack mismatch');
  if (expectedInstalledVersion && cleanString(payload.installedVersion || payload.packVersion || '', 80) !== expectedInstalledVersion) reasons.push('installed version mismatch');
  if (expectedLatestVersion && cleanString(payload.latestVersion || '', 80) !== expectedLatestVersion) reasons.push('latest version mismatch');
  if (expectedUsername && cleanString(payload.minecraftUsername || '', 16).toLowerCase() !== expectedUsername.toLowerCase()) reasons.push('Minecraft username mismatch');
  if (expectedMinecraftUuid && normalizeMinecraftUuid(payload.minecraftUuid || '') !== expectedMinecraftUuid) reasons.push('Minecraft UUID mismatch');
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
  const expectedKeyId = payload.protocol === LEGACY_LAUNCHER_PROOF_PROTOCOL
    ? LEGACY_LAUNCHER_PROOF_KEY_ID
    : LAUNCHER_ATTESTATION_KEY_ID;
  if (cleanString(proof?.header?.kid || '', 120) !== expectedKeyId) reasons.push('proof key mismatch');

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
  const expiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000);
  const minecraft = latest?.minecraft || installed?.minecraft || null;
  return {
    protocol: LAUNCHER_PROOF_PROTOCOL,
    schemaVersion: 2,
    launchId: crypto.randomUUID(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    packId: cleanString(latest?.packId || installed?.packId || config.packId || 'a-hard-time-dregora', 80),
    packVersion: cleanString(installed?.version || latest?.version || '', 80),
    latestVersion: cleanString(latest?.version || '', 80),
    installedVersion: cleanString(installed?.version || '', 80),
    minecraftUsername: cleanString(identity.minecraftUsername || config.sync?.playerLabel || '', 16),
    minecraftUuid: normalizeMinecraftUuid(identity.minecraftUuid || identity.minecraftUUID || ''),
    installId: cleanString(identity.installId || '', 120),
    appVersion: cleanString(identity.appVersion || '', 40),
    launcherVersion: cleanString(identity.appVersion || identity.launcherVersion || '', 40),
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

async function requestWorkerProof({ config = {}, payload, fetchImpl = globalThis.fetch, authToken = '', recoverySecret = '' }) {
  const base = proofBaseUrl(config);
  if (!base || typeof fetchImpl !== 'function') return null;
  const url = new URL('api/launcher-proof', base.endsWith('/') ? base : `${base}/`);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  if (recoverySecret) {
    headers['X-AHT-Launcher-Recovery'] = recoverySecret;
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: globalThis.AbortSignal?.timeout?.(15_000)
  });
  const body = await response.json().catch(() => ({}));
  if (JSON.stringify(body).length > 32_768) {
    throw workerProofContractError('Worker launcher proof response exceeded the 32 KiB size limit.');
  }
  if (!response.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  if (!body?.token || !body?.header || !body?.payload || !body?.signature) {
    const responseFields = Object.keys(body || {}).sort().slice(0, 8).join(', ') || 'none';
    throw workerProofContractError(`Worker launcher proof response from ${url.pathname} was incomplete (response fields: ${responseFields}). Check the Worker API base URL.`);
  }
  const responsePayload = body.payload;
  const responseProtocol = cleanString(responsePayload?.protocol || body?.protocol || '', 80);
  const responseIsV2 = responseProtocol === LAUNCHER_PROOF_PROTOCOL;
  const responseIsLegacyV1 = responseProtocol === LEGACY_LAUNCHER_PROOF_PROTOCOL;
  const mismatches = [];
  if (!responseIsV2 && !responseIsLegacyV1) mismatches.push('protocol');
  const compareString = (field, max = 80, caseInsensitive = false) => {
    const expected = cleanString(payload?.[field] || '', max);
    const actual = cleanString(responsePayload?.[field] || '', max);
    if ((caseInsensitive ? expected.toLowerCase() : expected) !== (caseInsensitive ? actual.toLowerCase() : actual)) {
      mismatches.push(field);
    }
  };
  if (responseIsLegacyV1) compareString('launchId', 80);
  if (responseIsLegacyV1) compareString('packId', 80);
  else if (cleanString(responsePayload?.packId || '', 80) !== LAUNCHER_ATTESTATION_PACK_ID) mismatches.push('packId');
  compareString('packVersion', 80);
  compareString('latestVersion', 80);
  compareString('installedVersion', 80);
  compareString('minecraftUsername', 16, true);
  const requestedMinecraftUuid = normalizeMinecraftUuid(payload?.minecraftUuid || '');
  if (responseIsV2 && requestedMinecraftUuid && normalizeMinecraftUuid(responsePayload?.minecraftUuid || '') !== requestedMinecraftUuid) {
    mismatches.push('minecraftUuid');
  }
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
  const expectedKeyId = responseIsLegacyV1 ? LEGACY_LAUNCHER_PROOF_KEY_ID : LAUNCHER_ATTESTATION_KEY_ID;
  if (cleanString(body.header?.kid || '', 120) !== expectedKeyId) {
    mismatches.push('proof key mismatch');
  }
  if (mismatches.length) {
    throw workerProofContractError(`Worker launcher proof response did not match the request (${[...new Set(mismatches)].join(', ')}).`);
  }
  return {
    ...body,
    protocol: responseProtocol,
    schemaVersion: responseIsV2 ? 2 : 1,
    trusted: true,
    source: 'worker'
  };
}

function unsignedProof(payload, error = '') {
  return {
    protocol: LAUNCHER_PROOF_PROTOCOL,
    schemaVersion: 2,
    trusted: false,
    source: 'unsigned-fallback',
    token: '',
    header: null,
    payload,
    signature: null,
    error
  };
}

export async function writeLauncherProof({ config = {}, identity = {}, latest = null, installed = null, fetchImpl = globalThis.fetch, authToken = '', recoverySecret = '' } = {}) {
  if (config.launcherProof?.enabled === false) {
    return { enabled: false };
  }
  const proofFiles = launcherProofFiles(config, identity);
  const proofFile = proofFiles[0];
  const payload = buildLauncherProofPayload({ config, identity, latest, installed });
  let proof = null;
  let remoteError = '';
  try {
    proof = await requestWorkerProof({ config, payload, fetchImpl, authToken, recoverySecret });
  } catch (error) {
    if (error?.code === 'AHT_LAUNCHER_PROOF_RESPONSE_MISMATCH') throw error;
    remoteError = error.message || String(error);
  }
  if (!proof) {
    proof = unsignedProof(payload, remoteError);
  }
  if (!proof.trusted && config.launcherProof?.required === true) {
    throw new Error(`Launcher proof signing failed: ${proof.error || 'the Worker signing endpoint did not return a trusted attestation'}`);
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
