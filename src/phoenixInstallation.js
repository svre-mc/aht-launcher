import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const PHOENIX_ANTI_CHEAT_PROTOCOL = 'AHT-GUARD-1';
export const PHOENIX_ANTI_CHEAT_CONSENT_VERSION = 2;
export const PHOENIX_ANTI_CHEAT_DEVELOPMENT_FILE = 'Phoenix Anti-cheat.exe';
const PHOENIX_STATE_FILE = 'installed.json';
const MAX_ANTI_CHEAT_BYTES = 16 * 1024 * 1024;

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
    if (url.username || url.password || url.search || url.hash) return null;
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
      || fileName !== `Phoenix-Anti-cheat-Windows-x64-${version}.exe`
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

export function phoenixReleaseFromManifest(manifest, origin, requiredVersion, options = {}) {
  if (manifest?.schema !== 1 || manifest?.file !== PHOENIX_ANTI_CHEAT_DEVELOPMENT_FILE
      || manifest?.version !== requiredVersion) {
    throw phoenixError('Phoenix Anti-cheat package metadata is invalid.', 'PHOENIX_RELEASE_INVALID');
  }
  const fileName = `Phoenix-Anti-cheat-Windows-x64-${manifest.version}.exe`;
  const releasePath = `launcher/anticheat/win32-x64/${fileName}`;
  return validatePhoenixAntiCheatRelease({ ...manifest, platform: 'win32-x64', fileName,
    path: releasePath, size: manifest.bytes, url: new URL(releasePath, `${origin}/`).toString() }, { ...options, expectedOrigin: origin });
}

function installedFileName(version = '') {
  if (!validVersion(version)) throw phoenixError('Phoenix Anti-cheat version is invalid.', 'PHOENIX_RELEASE_INVALID');
  return `Phoenix Anti-cheat-${version}.exe`;
}

async function verifyBinary(binaryPath, expectedHash, expectedBytes = 0) {
  const stat = await fs.lstat(binaryPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ANTI_CHEAT_BYTES) {
    throw phoenixError('Phoenix Anti-cheat installation has an invalid size.', 'PHOENIX_INSTALL_INVALID');
  }
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

function consentFrom(record = {}) {
  const acceptedAt = String(record.consentAcceptedAt || '');
  return record.product === 'phoenix-anticheat'
    && record.consentVersion === PHOENIX_ANTI_CHEAT_CONSENT_VERSION
    && Number.isFinite(Date.parse(acceptedAt)) && Date.parse(acceptedAt) > 0
    ? { consented: true, consentAcceptedAt: acceptedAt } : { consented: false };
}

async function atomicPhoenixJson(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

export async function rememberPhoenixConsent(consentFile, status = {}) {
  if (!consentFile || !status.consented || !Number.isFinite(Date.parse(status.consentAcceptedAt))) return;
  try {
    const existing = consentFrom(JSON.parse(await fs.readFile(consentFile, 'utf8')));
    if (existing.consented && existing.consentAcceptedAt === status.consentAcceptedAt) return;
  } catch {}
  await atomicPhoenixJson(consentFile, { schemaVersion: 1, product: 'phoenix-anticheat',
    consentVersion: PHOENIX_ANTI_CHEAT_CONSENT_VERSION, consentAcceptedAt: status.consentAcceptedAt });
}

export async function phoenixAntiCheatStatus({
  installDir,
  consentFile = '',
  developmentRuntimeDir = '',
  developerMode = false,
  requiredVersion = '',
  expectedHash = '',
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
  let consent = { consented: false };
  if (consentFile) {
    try { consent = consentFrom(JSON.parse(await fs.readFile(consentFile, 'utf8'))); } catch {}
  }
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
    if (!consent.consented) consent = consentFrom(record);
    if (expectedHash && record.sha256 !== expectedHash) {
      throw phoenixError('Phoenix Anti-cheat installation does not match this launcher.', 'PHOENIX_INSTALL_INVALID');
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
        ...consent,
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
      ...consent,
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
      ...consent,
      state: missing ? 'missing' : 'repair-required',
      error: missing ? '' : 'Phoenix Anti-cheat needs to be reinstalled.'
    };
  }
}

function beforeAbort(operation, signal, onLateValue = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      signal.removeEventListener('abort', abort);
      if (!settled) { settled = true; reject(signal.reason); }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(operation).then(value => {
      if (settled) { try { onLateValue(value); } catch {} return; }
      settled = true; signal.removeEventListener('abort', abort); resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      if (!settled) { settled = true; reject(error); }
    });
  });
}

async function writeDownloadedBinary(response, destination, descriptor, onProgress = () => {}, signal) {
  const handle = await fs.open(destination, 'wx', 0o700);
  const hash = crypto.createHash('sha256');
  let completed = 0;
  let reader;
  const cancel = () => { reader?.cancel().catch(() => {}); };
  try {
    if (!response.body?.getReader) throw phoenixError('Phoenix Anti-cheat download stream is unavailable.', 'PHOENIX_DOWNLOAD_FAILED');
    reader = response.body.getReader();
    signal?.addEventListener('abort', cancel, { once: true });
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await beforeAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      const chunk = Buffer.from(value);
      completed += chunk.length;
      if (completed > descriptor.size || completed > MAX_ANTI_CHEAT_BYTES) {
        throw phoenixError('Phoenix Anti-cheat download exceeded its verified size.', 'PHOENIX_DOWNLOAD_FAILED');
      }
      hash.update(chunk);
      await handle.writeFile(chunk);
      onProgress({
        phase: 'Downloading Phoenix Anti-cheat',
        completedBytes: completed,
        totalBytes: descriptor.size,
        percent: Math.min(99, Math.floor((completed / descriptor.size) * 100))
      });
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    // Cancellation of a broken adapter must not own installation completion.
    void reader?.cancel().catch(() => {});
    await handle.close();
  }
  if (completed !== descriptor.size || hash.digest('hex') !== descriptor.sha256) {
    throw phoenixError('Phoenix Anti-cheat download failed verification.', 'PHOENIX_DOWNLOAD_FAILED');
  }
}

export async function installPhoenixAntiCheat({
  installDir,
  consentFile = '',
  descriptor,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  allowInsecureLocalhost = false,
  consentAcceptedAt = new Date().toISOString(),
  timeoutMs = 30000,
  platform = process.platform
} = {}) {
  if (platform !== 'win32') return { required: false, installed: false, state: 'not-required' };
  if (typeof fetchImpl !== 'function') throw phoenixError('Phoenix Anti-cheat download service is unavailable.', 'PHOENIX_DOWNLOAD_FAILED');
  const release = validatePhoenixAntiCheatRelease(descriptor, { allowInsecureLocalhost });
  const directory = path.resolve(String(installDir || ''));
  if (!installDir) throw phoenixError('Phoenix Anti-cheat install location is unavailable.', 'PHOENIX_INSTALL_FAILED');
  await fs.mkdir(directory, { recursive: true });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw phoenixError('Phoenix Anti-cheat install location is invalid.', 'PHOENIX_INSTALL_FAILED');
  }
  // The installation receipt still records consent if its optional recovery copy is unwritable.
  await rememberPhoenixConsent(consentFile, { consented: true, consentAcceptedAt }).catch(() => {});
  const finalName = installedFileName(release.version);
  const finalPath = path.join(directory, finalName);
  const temporaryPath = path.join(directory, `.phoenix-download-${crypto.randomUUID()}.tmp`);
  const notify = progress => {
    try { const result = onProgress(progress); if (result?.catch) void result.catch(() => {}); } catch {}
  };
  const commit = async () => {
    const record = {
      schemaVersion: 1, product: 'phoenix-anticheat', version: release.version,
      protocol: release.protocol, fileName: finalName, sourceFileName: release.fileName,
      sha256: release.sha256, size: release.size,
      consentVersion: PHOENIX_ANTI_CHEAT_CONSENT_VERSION, consentAcceptedAt,
      installedAt: new Date().toISOString()
    };
    await atomicPhoenixJson(path.join(directory, PHOENIX_STATE_FILE), record);
    notify({ phase: 'Ready', completedBytes: release.size, totalBytes: release.size, percent: 100 });
    return { required: true, supported: true, installed: true, valid: true, state: 'ready', ...record,
      consented: true, binaryPath: finalPath };
  };
  // Reuse only bytes matching this launcher's trusted release pin. This also
  // repairs an interrupted receipt commit without overwriting an in-use helper.
  let alreadyVerified = false;
  try { await verifyBinary(finalPath, release.sha256, release.size); alreadyVerified = true; } catch {}
  if (alreadyVerified) return commit();
  notify({ phase: 'Connecting', completedBytes: 0, totalBytes: release.size, percent: 0 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(Number(timeoutMs) || 30000, 60000)));
  try {
    const response = await beforeAbort(fetchImpl(release.url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/vnd.microsoft.portable-executable, application/octet-stream' }
    }), controller.signal, response => { void response?.body?.cancel?.().catch(() => {}); });
    controller.signal.throwIfAborted();
    if (!response?.ok) throw phoenixError('Phoenix Anti-cheat download is temporarily unavailable.', 'PHOENIX_DOWNLOAD_FAILED');
    const declaredLength = Number(response.headers?.get?.('content-length') || 0);
    if (declaredLength && declaredLength !== release.size) {
      throw phoenixError('Phoenix Anti-cheat download size did not match its release.', 'PHOENIX_DOWNLOAD_FAILED');
    }
    await writeDownloadedBinary(response, temporaryPath, release, notify, controller.signal);
    controller.signal.throwIfAborted();
    await verifyBinary(temporaryPath, release.sha256, release.size);
    await fs.rename(temporaryPath, finalPath);
    return await commit();
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    if (controller.signal.aborted) throw phoenixError('Phoenix Anti-cheat download timed out. Please retry.', 'PHOENIX_DOWNLOAD_FAILED');
    if (error?.code?.startsWith?.('PHOENIX_')) throw error;
    throw phoenixError('Phoenix Anti-cheat could not be installed.', 'PHOENIX_INSTALL_FAILED');
  } finally { clearTimeout(timer); }
}

/** One recovery per Play; never bypass consent or loop on quarantine/startup failure. */
export async function withPhoenixRecovery({ getStatus, install, start }) {
  let recovered = false;
  let status = await getStatus();
  if (status.required && !status.valid && status.consented) {
    await install(status.consentAcceptedAt); recovered = true;
  }
  try { return await start(); }
  catch (error) {
    if (recovered || !['ENOENT', 'PHOENIX_ANTICHEAT_REQUIRED'].includes(error?.code)) throw error;
    status = await getStatus();
    if (!status.required || status.valid || !status.consented) throw error;
    await install(status.consentAcceptedAt);
    return start();
  }
}
