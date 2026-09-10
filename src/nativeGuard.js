import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';

export const PHOENIX_ANTI_CHEAT_PROTOCOL = 'AHT-GUARD-1';
export const PHOENIX_ANTI_CHEAT_CONSENT_VERSION = 2;
export const PHOENIX_ANTI_CHEAT_DEVELOPMENT_FILE = 'Phoenix Anti-cheat.exe';
const PHOENIX_STATE_FILE = 'installed.json';
const MAX_ANTI_CHEAT_BYTES = 16 * 1024 * 1024;
const MAX_PROBE_RESPONSE_BYTES = 16 * 1024;
const runtimeStateKey = Symbol.for('aht.phoenix.runtime-state.v1');
const runtimeState = globalThis[runtimeStateKey] || {
  sessions: new Map(),
  pending: new Map(),
  launcherSessionId: crypto.randomBytes(16).toString('hex')
};
globalThis[runtimeStateKey] = runtimeState;
const sessions = runtimeState.sessions;
const pending = runtimeState.pending;
const processLauncherSessionId = runtimeState.launcherSessionId;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function phoenixError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validVersion(value = '') {
  return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(String(value || '').trim());
}

function validDownloadUrl(value = '', allowInsecureLocalhost = false) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol === 'https:') return url;
    if (allowInsecureLocalhost && url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return url;
  } catch {}
  return null;
}

export function validatePhoenixAntiCheatRelease(descriptor = {}, options = {}) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw phoenixError('Phoenix Anti-cheat release metadata is unavailable.', 'PHOENIX_RELEASE_INVALID');
  }
  const version = String(descriptor.version || '').trim();
  const protocol = String(descriptor.protocol || '').trim();
  const product = String(descriptor.product || '').trim();
  const platform = String(descriptor.platform || '').trim();
  const fileName = String(descriptor.fileName || '').trim();
  const releasePath = String(descriptor.path || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const digest = String(descriptor.sha256 || '').trim().toLowerCase();
  const size = Number(descriptor.size || descriptor.bytes || 0);
  const url = validDownloadUrl(descriptor.url, options.allowInsecureLocalhost === true);
  if (product !== 'phoenix-anticheat'
      || platform !== 'win32-x64'
      || !validVersion(version)
      || protocol !== PHOENIX_ANTI_CHEAT_PROTOCOL
      || !/^Phoenix-Anti-cheat-Windows-x64-\d+\.\d+\.\d+(?:[-+][A-Za-z0-9][A-Za-z0-9._-]*)?\.exe$/i.test(fileName)
      || !/^[a-f0-9]{64}$/.test(digest)
      || !Number.isInteger(size) || size < 1 || size > MAX_ANTI_CHEAT_BYTES
      || !url) {
    throw phoenixError('Phoenix Anti-cheat release metadata failed validation.', 'PHOENIX_RELEASE_INVALID');
  }
  const expectedPath = `launcher/anticheat/win32-x64/${fileName}`;
  if (releasePath !== expectedPath
      || url.pathname.replace(/^\/+/, '') !== expectedPath
      || path.posix.basename(url.pathname) !== fileName) {
    throw phoenixError('Phoenix Anti-cheat download identity does not match its release metadata.', 'PHOENIX_RELEASE_INVALID');
  }
  if (options.expectedOrigin && url.origin !== String(options.expectedOrigin)) {
    throw phoenixError('Phoenix Anti-cheat download origin does not match the launcher update service.', 'PHOENIX_RELEASE_INVALID');
  }
  return { product, platform, version, protocol, fileName, path: releasePath, sha256: digest, size, url: url.toString() };
}

function installedFileName(version = '') {
  if (!validVersion(version)) throw phoenixError('Phoenix Anti-cheat version is invalid.', 'PHOENIX_RELEASE_INVALID');
  return `Phoenix Anti-cheat-${version}.exe`;
}

async function verifyBinary(binaryPath, expectedHash, expectedBytes = 0) {
  const bytes = await fs.readFile(binaryPath);
  if (bytes.length < 1 || bytes.length > MAX_ANTI_CHEAT_BYTES) {
    throw phoenixError('Phoenix Anti-cheat installation has an invalid size.', 'PHOENIX_INSTALL_INVALID');
  }
  if (expectedBytes && bytes.length !== expectedBytes) {
    throw phoenixError('Phoenix Anti-cheat installation is incomplete.', 'PHOENIX_INSTALL_INVALID');
  }
  const digest = sha256(bytes);
  if (digest !== String(expectedHash || '').toLowerCase()) {
    throw phoenixError('Phoenix Anti-cheat installation failed verification.', 'PHOENIX_INSTALL_INVALID');
  }
  return { binaryPath, sha256: digest, size: bytes.length };
}

async function developmentPackage(runtimeDir = '') {
  if (!runtimeDir) return null;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(runtimeDir, 'manifest.json'), 'utf8'));
    if (manifest.protocol !== PHOENIX_ANTI_CHEAT_PROTOCOL
        || manifest.file !== PHOENIX_ANTI_CHEAT_DEVELOPMENT_FILE
        || !validVersion(manifest.version)
        || !/^[a-f0-9]{64}$/.test(String(manifest.sha256 || ''))
        || !Number.isInteger(Number(manifest.bytes)) || Number(manifest.bytes) < 1) return null;
    const verified = await verifyBinary(path.join(runtimeDir, manifest.file), manifest.sha256, Number(manifest.bytes));
    return { ...verified, version: manifest.version, protocol: manifest.protocol, source: 'development' };
  } catch {
    return null;
  }
}

export async function phoenixAntiCheatStatus({
  installDir,
  developmentRuntimeDir = '',
  developerMode = false,
  requiredVersion = '',
  platform = process.platform
} = {}) {
  if (platform !== 'win32') {
    return { required: false, supported: false, installed: false, valid: false, state: 'not-required' };
  }
  if (developerMode) {
    const development = await developmentPackage(developmentRuntimeDir);
    if (development) {
      if (requiredVersion && development.version !== requiredVersion) {
        return { required: true, supported: true, installed: true, valid: false, state: 'update-required', version: development.version };
      }
      return { required: true, supported: true, installed: true, valid: true, state: 'ready', ...development };
    }
  }
  const directory = path.resolve(String(installDir || ''));
  if (!installDir) return { required: true, supported: true, installed: false, valid: false, state: 'missing' };
  try {
    const record = JSON.parse(await fs.readFile(path.join(directory, PHOENIX_STATE_FILE), 'utf8'));
    if (record.schemaVersion !== 1
        || record.product !== 'phoenix-anticheat'
        || record.consentVersion !== PHOENIX_ANTI_CHEAT_CONSENT_VERSION
        || record.protocol !== PHOENIX_ANTI_CHEAT_PROTOCOL
        || !validVersion(record.version)
        || record.fileName !== installedFileName(record.version)
        || !/^[a-f0-9]{64}$/.test(String(record.sha256 || ''))
        || !Number.isInteger(Number(record.size)) || Number(record.size) < 1) {
      throw phoenixError('Phoenix Anti-cheat installation metadata is invalid.', 'PHOENIX_INSTALL_INVALID');
    }
    const verified = await verifyBinary(path.join(directory, record.fileName), record.sha256, Number(record.size));
    if (requiredVersion && record.version !== requiredVersion) {
      return {
        required: true,
        supported: true,
        installed: true,
        valid: false,
        state: 'update-required',
        version: record.version,
        error: 'Phoenix Anti-cheat needs to be updated.'
      };
    }
    return {
      required: true,
      supported: true,
      installed: true,
      valid: true,
      state: 'ready',
      version: record.version,
      protocol: record.protocol,
      installedAt: String(record.installedAt || ''),
      consentAcceptedAt: String(record.consentAcceptedAt || ''),
      ...verified,
      source: 'installed'
    };
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    return {
      required: true,
      supported: true,
      installed: false,
      valid: false,
      state: missing ? 'missing' : 'repair-required',
      error: missing ? '' : 'Phoenix Anti-cheat needs to be reinstalled.'
    };
  }
}

async function writeDownloadedBinary(response, destination, descriptor, onProgress = () => {}) {
  const handle = await fs.open(destination, 'wx', 0o700);
  const hash = crypto.createHash('sha256');
  let completed = 0;
  try {
    if (!response.body?.getReader) throw phoenixError('Phoenix Anti-cheat download stream is unavailable.', 'PHOENIX_DOWNLOAD_FAILED');
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      completed += chunk.length;
      if (completed > descriptor.size || completed > MAX_ANTI_CHEAT_BYTES) {
        throw phoenixError('Phoenix Anti-cheat download exceeded its verified size.', 'PHOENIX_DOWNLOAD_FAILED');
      }
      hash.update(chunk);
      await handle.write(chunk);
      onProgress({
        phase: 'Downloading Phoenix Anti-cheat',
        completedBytes: completed,
        totalBytes: descriptor.size,
        percent: Math.min(99, Math.floor((completed / descriptor.size) * 100))
      });
    }
  } finally {
    await handle.close();
  }
  if (completed !== descriptor.size || hash.digest('hex') !== descriptor.sha256) {
    throw phoenixError('Phoenix Anti-cheat download failed verification.', 'PHOENIX_DOWNLOAD_FAILED');
  }
}

export async function installPhoenixAntiCheat({
  installDir,
  descriptor,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  allowInsecureLocalhost = false,
  consentAcceptedAt = new Date().toISOString(),
  platform = process.platform
} = {}) {
  if (platform !== 'win32') return { required: false, installed: false, state: 'not-required' };
  if (typeof fetchImpl !== 'function') throw phoenixError('Phoenix Anti-cheat download service is unavailable.', 'PHOENIX_DOWNLOAD_FAILED');
  const release = validatePhoenixAntiCheatRelease(descriptor, { allowInsecureLocalhost });
  const directory = path.resolve(String(installDir || ''));
  if (!installDir) throw phoenixError('Phoenix Anti-cheat install location is unavailable.', 'PHOENIX_INSTALL_FAILED');
  await fs.mkdir(directory, { recursive: true });
  const finalName = installedFileName(release.version);
  const finalPath = path.join(directory, finalName);
  const temporaryPath = path.join(directory, `.phoenix-download-${crypto.randomUUID()}.tmp`);
  onProgress({ phase: 'Connecting', completedBytes: 0, totalBytes: release.size, percent: 0 });
  try {
    const response = await fetchImpl(release.url, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/vnd.microsoft.portable-executable, application/octet-stream' }
    });
    if (!response?.ok) throw phoenixError('Phoenix Anti-cheat download is temporarily unavailable.', 'PHOENIX_DOWNLOAD_FAILED');
    const declaredLength = Number(response.headers?.get?.('content-length') || 0);
    if (declaredLength && declaredLength !== release.size) {
      throw phoenixError('Phoenix Anti-cheat download size did not match its release.', 'PHOENIX_DOWNLOAD_FAILED');
    }
    await writeDownloadedBinary(response, temporaryPath, release, onProgress);
    await verifyBinary(temporaryPath, release.sha256, release.size);
    await fs.rm(finalPath, { force: true });
    await fs.rename(temporaryPath, finalPath);
    const record = {
      schemaVersion: 1,
      product: 'phoenix-anticheat',
      version: release.version,
      protocol: release.protocol,
      fileName: finalName,
      sourceFileName: release.fileName,
      sha256: release.sha256,
      size: release.size,
      consentVersion: PHOENIX_ANTI_CHEAT_CONSENT_VERSION,
      consentAcceptedAt,
      installedAt: new Date().toISOString()
    };
    const statePath = path.join(directory, PHOENIX_STATE_FILE);
    const stateTemporaryPath = `${statePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(stateTemporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await fs.rm(statePath, { force: true });
    await fs.rename(stateTemporaryPath, statePath);
    onProgress({ phase: 'Ready', completedBytes: release.size, totalBytes: release.size, percent: 100 });
    return { required: true, supported: true, installed: true, valid: true, state: 'ready', ...record, binaryPath: finalPath };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    if (error?.code?.startsWith?.('PHOENIX_')) throw error;
    throw phoenixError('Phoenix Anti-cheat could not be installed.', 'PHOENIX_INSTALL_FAILED');
  }
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
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let text = '';
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(1500, () => finish(new Error('Phoenix Anti-cheat unavailable')));
    socket.on('error', (error) => finish(error));
    socket.on('connect', () => socket.write(`${requestLine}\n`));
    socket.on('data', (data) => {
      text += data;
      if (Buffer.byteLength(text, 'utf8') > maximumBytes) return finish(new Error('Phoenix Anti-cheat response too large'));
      if (text.includes('\n')) {
        finish(null, text.slice(0, text.indexOf('\n')));
      }
    });
    socket.on('end', () => finish(new Error('Phoenix Anti-cheat closed')));
  });
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
  launcherSessionId = processLauncherSessionId,
  launcherPid = process.pid
}) {
  if (platform !== 'win32') return null;
  const installation = await phoenixAntiCheatStatus({
    installDir,
    developmentRuntimeDir: developmentRuntimeDir || runtimeDir,
    developerMode,
    requiredVersion,
    platform
  });
  if (!installation.installed || !installation.valid || !installation.binaryPath) {
    throw phoenixError('Phoenix Anti-cheat is required to play on Windows.', 'PHOENIX_ANTICHEAT_REQUIRED');
  }
  const directory = path.resolve(gameDir);
  if (pending.has(directory)) return pending.get(directory);
  const operation = (async () => {
    const binary = installation.binaryPath;
    const hash = installation.sha256;
    const stateFile = path.join(directory, '.aht-launcher', 'native-guard.json');
    // Old builds persisted the live descriptor. Remove that exact legacy artifact;
    // current sessions and their authentication material exist in this process only.
    await Promise.all([
      fs.rm(stateFile, { force: true }),
      fs.rm(`${stateFile}.tmp`, { force: true })
    ]).catch(() => {});
    const cached = sessions.get(directory);
    if (cached?.binaryHash === hash && cached?.launcherPid === launcherPid && cached?.launcherSessionId === launcherSessionId) {
      try {
        const live = await readInfo(validateNativeGuardDescriptor(cached));
        if (live.keyHash === cached.keyHash && live.launcherPid === launcherPid && live.launcherSessionId === launcherSessionId) {
          sessions.set(directory, cached);
          return live;
        }
      } catch {}
    }
    // Independent process group lets the read-only monitor outlive an automatic
    // launcher close. The native lifecycle still ends with its exact game.
    const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    try {
      const info = await new Promise((resolve, reject) => {
        let text = '';
        let errorText = '';
        const timer = setTimeout(() => reject(new Error('Phoenix Anti-cheat startup timed out')), 8000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.stderr.on('data', (data) => { errorText = `${errorText}${data}`.slice(-512); });
        child.once('exit', () => {
          clearTimeout(timer);
          const startupCode = String(errorText || '').includes('PHOENIX_UNAVAILABLE') ? 'Phoenix Anti-cheat is unavailable.' : '';
          reject(new Error(startupCode || 'Phoenix Anti-cheat stopped during startup'));
        });
        child.stdout.on('data', (data) => {
          text += data;
          if (text.length > 4096) {
            clearTimeout(timer);
            return reject(new Error('Phoenix Anti-cheat startup response too large'));
          }
          if (text.includes('\n')) {
            clearTimeout(timer);
            try { resolve(validateNativeGuardDescriptor(JSON.parse(text))); } catch (error) { reject(error); }
          }
        });
        child.stdin.on('error', reject);
        child.stdin.end(`${JSON.stringify({ gameDir: directory, javaPath, launcherPid, launcherSessionId })}\n`);
      });
      if (info.launcherPid !== launcherPid) throw new Error('Phoenix Anti-cheat launcher identity mismatch');
      if (info.launcherSessionId !== launcherSessionId) throw new Error('Phoenix Anti-cheat session identity mismatch');
      const saved = { ...info, binaryHash: hash };
      sessions.set(directory, saved);
      child.once('exit', () => {
        if (sessions.get(directory)?.guardPid === saved.guardPid) sessions.delete(directory);
      });
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      return info;
    } catch (error) {
      child.kill();
      throw error;
    }
  })().finally(() => pending.delete(directory));
  pending.set(directory, operation);
  return operation;
}
