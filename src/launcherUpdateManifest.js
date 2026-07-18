import path from 'node:path';

export const REQUIRED_DOWNLOAD_KEYS = ['windows-x64', 'macos-arm64', 'macos-x64'];
export const REQUIRED_PLATFORM_KEYS = [
  'win32-x64',
  'win32',
  'windows',
  'windows-x64',
  'darwin-arm64',
  'macos-arm64',
  'darwin-x64',
  'macos-x64',
  'darwin',
  'macos'
];

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isLocalhostUrl(url) {
  return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

function isAllowedArtifactUrl(value = '', options = {}) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol === 'https:') return true;
    return Boolean(options.allowInsecureLocalhost && url.protocol === 'http:' && isLocalhostUrl(url));
  } catch {
    return false;
  }
}

function launcherRootUrl(latestUrl = '') {
  if (!latestUrl) return '';
  try {
    return new URL('../', new URL(latestUrl)).toString();
  } catch {
    return '';
  }
}

function hasLauncherFileUrl(urlText = '', expectedRootUrl = '', options = {}) {
  if (!isAllowedArtifactUrl(urlText, options)) return false;
  const url = new URL(urlText);
  if (!url.pathname.includes('/launcher/files/')) return false;
  if (expectedRootUrl && !urlText.startsWith(expectedRootUrl)) return false;
  return true;
}

function hasTrackedLauncherDownloadUrl(urlText = '', downloadKey = '', expectedRootUrl = '', options = {}) {
  if (!isAllowedArtifactUrl(urlText, options)) return false;
  const url = new URL(urlText);
  if (url.pathname !== `/launcher/download/${downloadKey}`) return false;
  if (expectedRootUrl && !urlText.startsWith(expectedRootUrl)) return false;
  return true;
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fileNameMatchesVersion(fileName = '', version = '') {
  if (!version) return true;
  return new RegExp(`-${escapeRegExp(version)}\\.[^.]+$`, 'i').test(String(fileName || ''));
}

function validateCommonEntry(errors, entry, key, expectedRootUrl = '', expectedVersion = '', options = {}) {
  if (!isObject(entry)) {
    errors.push(`${key} entry is missing or not an object`);
    return;
  }
  if (!entry.fileName) errors.push(`${key} fileName is missing`);
  if (entry.fileName && !fileNameMatchesVersion(entry.fileName, expectedVersion)) {
    errors.push(`${key} fileName must include launcher version ${expectedVersion}`);
  }
  if (!entry.path) errors.push(`${key} path is missing`);
  if (entry.path && !String(entry.path).startsWith('launcher/files/')) {
    errors.push(`${key} path must be under launcher/files/`);
  }
  if (entry.fileName && entry.path && path.posix.basename(String(entry.path).replaceAll('\\', '/')) !== entry.fileName) {
    errors.push(`${key} path basename must match fileName`);
  }
  const downloadKey = key.startsWith('downloads.') ? key.slice('downloads.'.length) : '';
  const directFileUrl = hasLauncherFileUrl(entry.url || '', expectedRootUrl, options);
  const trackedDownloadUrl = downloadKey
    ? hasTrackedLauncherDownloadUrl(entry.url || '', downloadKey, expectedRootUrl, options)
    : false;
  if (downloadKey) {
    if (!directFileUrl && !trackedDownloadUrl) {
      errors.push(`${key} url must point at launcher/download/${downloadKey} or launcher/files/`);
    }
    if (options.requireTrackedDownloads && !trackedDownloadUrl) {
      errors.push(`${key} url must use launcher/download/${downloadKey}`);
    }
  } else if (!directFileUrl) {
    errors.push(`${key} url must point at launcher/files/`);
  }
  if (entry.fileName && directFileUrl && path.posix.basename(new URL(entry.url).pathname) !== entry.fileName) {
    errors.push(`${key} url basename must match fileName`);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) {
    errors.push(`${key} sha256 must be a 64-character hex digest`);
  }
  if (!(Number(entry.size) > 0)) {
    errors.push(`${key} size must be greater than zero`);
  }
}

function validateKindAndExtension(errors, entry, key, expectedKind, expectedExt) {
  if (!isObject(entry)) return;
  if (entry.kind !== expectedKind) {
    errors.push(`${key} kind must be ${expectedKind}`);
  }
  const fileName = String(entry.fileName || '').toLowerCase();
  if (!fileName.endsWith(expectedExt)) {
    errors.push(`${key} fileName must end with ${expectedExt}`);
  }
}

function validateWindowsSilentInstall(errors, entry, key) {
  if (!Array.isArray(entry?.installArgs) || !entry.installArgs.includes('/S')) {
    errors.push(`${key} must include /S silent install args`);
  }
}

function validateKnownEntryShape(errors, entry, key) {
  if (!isObject(entry)) return;
  const entryKey = String(key || '').replace(/^(?:downloads|platforms)\./, '');
  if (/^(?:win32|windows)/i.test(entryKey)) {
    validateKindAndExtension(errors, entry, key, 'nsis', '.exe');
    validateWindowsSilentInstall(errors, entry, key);
  }
  if (/^(?:darwin|macos)/i.test(entryKey)) {
    const isManualDownload = key.startsWith('downloads.macos-');
    validateKindAndExtension(errors, entry, key, isManualDownload ? 'dmg' : 'zip', isManualDownload ? '.dmg' : '.zip');
  }
}

export function launcherPlatformKeys(platform = process.platform, arch = process.arch) {
  const keys = [`${platform}-${arch}`, platform];
  if (platform === 'win32') keys.push('windows', 'windows-x64');
  if (platform === 'darwin') keys.push(arch === 'arm64' ? 'macos-arm64' : 'macos-x64', 'macos');
  return [...new Set(keys)];
}

export function selectLauncherArtifact(manifest, platform = process.platform, arch = process.arch) {
  const platforms = manifest?.platforms || {};
  for (const key of launcherPlatformKeys(platform, arch)) {
    if (platforms[key]) {
      return { key, ...platforms[key] };
    }
  }
  return null;
}

export function validateLauncherUpdateManifest(manifest = {}, options = {}) {
  const errors = [];
  const expectedRootUrl = launcherRootUrl(String(options.latestUrl || ''));
  const requireDownloads = options.requireDownloads !== false;
  const requireAllPlatforms = options.requireAllPlatforms !== false;

  if (!isObject(manifest)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (manifest.product !== 'aht-launcher') errors.push('product must be aht-launcher');
  const manifestVersion = String(manifest.version || '').trim();
  if (!manifestVersion) errors.push('version is missing');
  if (manifest.required !== true) errors.push('required must be true');
  if (!isObject(manifest.platforms)) errors.push('platforms must be an object');
  if (requireDownloads && !isObject(manifest.downloads)) errors.push('downloads must be an object');

  const platforms = isObject(manifest.platforms) ? manifest.platforms : {};
  const downloads = isObject(manifest.downloads) ? manifest.downloads : {};
  if (requireAllPlatforms) {
    for (const key of REQUIRED_PLATFORM_KEYS) {
      if (!platforms[key]) errors.push(`platform entry missing: ${key}`);
    }
  } else if (!selectLauncherArtifact(manifest, options.platform || process.platform, options.arch || process.arch)) {
    errors.push(`platform entry missing for ${options.platform || process.platform}-${options.arch || process.arch}`);
  }
  if (requireDownloads) {
    for (const key of REQUIRED_DOWNLOAD_KEYS) {
      if (!downloads[key]) errors.push(`manual download entry missing: ${key}`);
    }
  }

  const forbiddenDownloadKeys = Object.keys(downloads).filter((key) => /^darwin|^win32|linux|ubuntu/i.test(key));
  if (forbiddenDownloadKeys.length) {
    errors.push(`manual downloads must use website-facing keys only: ${forbiddenDownloadKeys.join(', ')}`);
  }
  const forbiddenPlatformKeys = Object.keys(platforms).filter((key) => /linux|ubuntu/i.test(key));
  if (forbiddenPlatformKeys.length) {
    errors.push(`platforms must not publish Linux artifacts: ${forbiddenPlatformKeys.join(', ')}`);
  }

  for (const [key, entry] of Object.entries(downloads)) {
    validateCommonEntry(errors, entry, `downloads.${key}`, expectedRootUrl, manifestVersion, options);
    validateKnownEntryShape(errors, entry, `downloads.${key}`);
  }
  for (const [key, entry] of Object.entries(platforms)) {
    validateCommonEntry(errors, entry, `platforms.${key}`, expectedRootUrl, manifestVersion, options);
    validateKnownEntryShape(errors, entry, `platforms.${key}`);
  }

  return { ok: errors.length === 0, errors };
}
