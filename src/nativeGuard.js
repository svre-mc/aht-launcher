import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readNativeGuardLine, startNativeGuardProcess } from './nativeGuardTransport.js';
import { nativeGuardSessions, nativeGuardSessionKey } from './nativeGuardSessions.js';
import { PHOENIX_ANTI_CHEAT_PROTOCOL, phoenixAntiCheatStatus } from './phoenixInstallation.js';
export { PHOENIX_ANTI_CHEAT_PROTOCOL, PHOENIX_ANTI_CHEAT_CONSENT_VERSION, PHOENIX_ANTI_CHEAT_DEVELOPMENT_FILE, validatePhoenixAntiCheatRelease, phoenixReleaseFromManifest, rememberPhoenixConsent, phoenixAntiCheatStatus, installPhoenixAntiCheat, withPhoenixRecovery } from './phoenixInstallation.js';

const MAX_PROBE_RESPONSE_BYTES = 16 * 1024;
const { sessions, pending, launcherSessionId: processLauncherSessionId } = nativeGuardSessions;
const phoenixError = (message, code) => Object.assign(new Error(message), { code });

async function removeLegacyDescriptor(directory) {
  const metadataDirectory = path.join(directory, '.aht-launcher');
  try {
    // A redirected metadata parent is not ours to clean. Keep supported aliases
    // of the instance root, but do not traverse a junction inside that instance.
    const metadata = await fs.lstat(metadataDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    const stateFile = path.join(metadataDirectory, 'native-guard.json');
    await Promise.all([fs.rm(stateFile, { force: true }), fs.rm(`${stateFile}.tmp`, { force: true })]);
  } catch {
    // Legacy cleanup is optional; current authentication lives in this process.
  }
}

function reportedGameStillExists(gamePid) {
  if (!gamePid) return true; // A pre-launch helper is waiting for its first game.
  try { process.kill(gamePid, 0); return true; } // Signal zero only queries liveness.
  catch (error) { return error?.code === 'EPERM'; }
}

export function nativeGuardSessionIsActive(descriptor = {}) {
  return [...sessions.values()].some(session => session.keyHash === descriptor.keyHash
    && session.guardPid === descriptor.guardPid && session.launcherSessionId === descriptor.launcherSessionId);
}

export function validateNativeGuardDescriptor(info) {
  if (info?.protocol !== PHOENIX_ANTI_CHEAT_PROTOCOL || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535
    || !/^[a-f0-9]{64}$/.test(info.keyHash || '') || !/^[A-Za-z0-9_-]{342}$/.test(info.modulus || '') || info.exponent !== 'AQAB'
    || !Number.isInteger(info.launcherPid) || info.launcherPid < 1
    || !Number.isInteger(info.guardPid) || info.guardPid < 1
    || !Number.isInteger(info.gamePid) || info.gamePid < 0
    || !/^[A-Za-z0-9_-]{43}$/.test(String(info.sessionKey || ''))
    || !/^[a-f0-9]{32}$/i.test(String(info.launcherSessionId || ''))) throw new Error('Invalid Phoenix Anti-cheat identity');
  const hash = crypto.createHash('sha256').update(`${info.modulus}.${info.exponent}`).digest('hex');
  if (hash !== info.keyHash) throw new Error('Phoenix Anti-cheat key mismatch');
  return {
    protocol: info.protocol,
    port: info.port,
    keyHash: info.keyHash,
    modulus: info.modulus,
    exponent: info.exponent,
    launcherPid: info.launcherPid,
    launcherSessionId: info.launcherSessionId,
    sessionKey: info.sessionKey,
    guardPid: info.guardPid,
    gamePid: info.gamePid
  };
}

function readGuardLine(port, requestLine, maximumBytes = MAX_PROBE_RESPONSE_BYTES) {
  return readNativeGuardLine(port, requestLine, maximumBytes);
}

async function readInfo(descriptor) {
  const expected = validateNativeGuardDescriptor(descriptor);
  return validateNativeGuardDescriptor(JSON.parse(await readGuardLine(expected.port, `${expected.sessionKey}|INFO`, 4096)));
}

function boundedProbeInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^\d+$/.test(String(value || ''))) throw new Error('Phoenix Anti-cheat measurement is invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Phoenix Anti-cheat measurement is invalid');
  }
  return parsed;
}

function verifyNativeGuardProbe(reply, descriptor, nonce, gamePid) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)
      || !/^[A-Za-z0-9_-]{1,8192}$/.test(String(reply.payload || ''))
      || !/^[A-Za-z0-9_-]{342}$/.test(String(reply.signature || ''))
      || reply.modulus !== descriptor.modulus
      || reply.exponent !== descriptor.exponent) {
    throw new Error('Phoenix Anti-cheat signed measurement is invalid');
  }
  const payload = Buffer.from(reply.payload, 'base64url');
  if (!payload.length || payload.length > 6144) throw new Error('Phoenix Anti-cheat signed measurement is invalid');
  const publicKey = crypto.createPublicKey({
    key: { kty: 'RSA', n: descriptor.modulus, e: descriptor.exponent },
    format: 'jwk'
  });
  if (!crypto.verify('sha256', payload, publicKey, Buffer.from(reply.signature, 'base64url'))) {
    throw new Error('Phoenix Anti-cheat measurement signature is invalid');
  }
  const fields = payload.toString('utf8').split('\n');
  if (fields.length !== 11
      || fields[0] !== PHOENIX_ANTI_CHEAT_PROTOCOL
      || fields[1] !== nonce
      || fields[2] !== descriptor.keyHash
      || boundedProbeInteger(fields[3], { minimum: 1, maximum: 0x7fffffff }) !== gamePid
      || !/^\d{10,20}$/.test(fields[4])
      || !['pending', 'clean', 'tampered', 'incomplete'].includes(fields[7])) {
    throw new Error('Phoenix Anti-cheat measurement identity is invalid');
  }
  const sequence = boundedProbeInteger(fields[5]);
  const scannedAt = boundedProbeInteger(fields[6]);
  const checkedModules = boundedProbeInteger(fields[8], { maximum: 8 });
  const checkedBytes = boundedProbeInteger(fields[9], { maximum: 96 * 1024 * 1024 });
  const detailBytes = Buffer.from(fields[10], 'base64url');
  if (detailBytes.length > 4096) throw new Error('Phoenix Anti-cheat measurement detail is invalid');
  const detail = detailBytes.toString('utf8');
  if (detail.includes('\ufffd')) throw new Error('Phoenix Anti-cheat measurement detail is invalid');
  return {
    protocol: fields[0],
    keyHash: fields[2],
    gamePid,
    processBirth: fields[4],
    sequence,
    scannedAt,
    state: fields[7],
    checkedModules,
    checkedBytes,
    detail
  };
}

export async function verifyNativeGuardSession(descriptor = {}) {
  const expected = validateNativeGuardDescriptor(descriptor);
  const live = await readInfo(expected);
  if (live.keyHash !== expected.keyHash
      || live.launcherPid !== expected.launcherPid
      || live.launcherSessionId !== expected.launcherSessionId
      || live.sessionKey !== expected.sessionKey
      || live.guardPid !== expected.guardPid) {
    throw new Error('Phoenix Anti-cheat live session identity changed');
  }
  return live;
}

export async function probeNativeGuard(descriptor = {}) {
  const live = await verifyNativeGuardSession(descriptor);
  if (!live.gamePid) {
    return { live, measurement: { state: 'pending', gamePid: 0 }, signedProbe: null };
  }
  const nonce = crypto.randomBytes(24).toString('hex');
  const signedProbe = JSON.parse(await readGuardLine(live.port, `${live.sessionKey}|${nonce}|${live.gamePid}`));
  const measurement = verifyNativeGuardProbe(signedProbe, live, nonce, live.gamePid);
  return { live, measurement, signedProbe };
}

export async function nativeGuardReadyForLauncherExit(descriptor, probe = probeNativeGuard) {
  if (!descriptor) return false;
  try {
    const result = await probe(descriptor);
    return result.live.gamePid > 0
      && result.measurement.gamePid === result.live.gamePid
      && result.measurement.state === 'clean';
  } catch {
    return false;
  }
}

export async function ensureNativeGuard({
  gameDir,
  javaPath = '',
  installDir = '',
  runtimeDir = '',
  developmentRuntimeDir = '',
  developerMode = false,
  platform = process.platform,
  requiredVersion = '',
  expectedHash = '',
  launcherSessionId = processLauncherSessionId,
  launcherPid = process.pid
}) {
  if (platform !== 'win32') return null;
  const installation = await phoenixAntiCheatStatus({
    installDir,
    developmentRuntimeDir: developmentRuntimeDir || runtimeDir,
    developerMode,
    requiredVersion,
    expectedHash,
    platform
  });
  if (!installation.installed || !installation.valid || !installation.binaryPath) {
    throw phoenixError('Phoenix Anti-cheat is required to play on Windows.', 'PHOENIX_ANTICHEAT_REQUIRED');
  }
  const directory = path.resolve(gameDir);
  const sessionKey = nativeGuardSessionKey({ gameDir: directory, javaPath, binaryPath: installation.binaryPath,
    binaryHash: installation.sha256, launcherPid, launcherSessionId, platform });
  if (pending.has(sessionKey)) return pending.get(sessionKey);
  const operation = (async () => {
    const binary = installation.binaryPath;
    const hash = installation.sha256;
    // Old builds persisted the live descriptor. Remove that exact legacy artifact;
    // current sessions and their authentication material exist in this process only.
    await removeLegacyDescriptor(directory);
    const cached = sessions.get(sessionKey);
    if (cached?.binaryHash === hash && cached?.launcherPid === launcherPid && cached?.launcherSessionId === launcherSessionId) {
      try {
        const live = await verifyNativeGuardSession(cached);
        if (live.keyHash === cached.keyHash && live.launcherPid === launcherPid && live.launcherSessionId === launcherSessionId
            && reportedGameStillExists(live.gamePid)) {
          return live;
        }
      } catch {}
    }
    // INFO can remain responsive briefly after its bound Java exits. Never give
    // that retiring helper to a new Play; it cannot bind a second game process.
    // Independent process group lets the read-only monitor outlive an automatic
    // launcher close. The native lifecycle still ends with its exact game.
    const { descriptor: info, child } = await startNativeGuardProcess({ binary, gameDir: directory, javaPath,
      launcherPid, launcherSessionId, validateDescriptor: validateNativeGuardDescriptor });
    const saved = { ...info, binaryHash: hash };
    sessions.set(sessionKey, saved);
    child.once('exit', () => {
      if (sessions.get(sessionKey)?.guardPid === saved.guardPid) sessions.delete(sessionKey);
    });
    return info;
  })().finally(() => { if (pending.get(sessionKey) === operation) pending.delete(sessionKey); });
  pending.set(sessionKey, operation);
  return operation;
}
