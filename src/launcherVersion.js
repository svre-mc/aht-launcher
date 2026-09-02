const LAUNCHER_RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9][A-Za-z0-9._-]*)?$/;

function numericLauncherVersionIdentity(value = '') {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value || '').trim());
  if (!match) return '';
  const parts = match.slice(1).filter((part) => part !== undefined).map((part) => Number(part));
  while (parts.length > 3 && parts.at(-1) === 0) parts.pop();
  return parts.join('.');
}

export function cleanLauncherReleaseVersion(value = '') {
  const version = String(value || '').trim();
  if (!version) return '';
  if (!LAUNCHER_RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error('Launcher release version must look like 0.2.01.');
  }
  return version;
}

export function launcherPackageVersionForRelease(value = '') {
  const releaseVersion = cleanLauncherReleaseVersion(value);
  if (!releaseVersion) return '';
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(releaseVersion);
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4]}`;
}

export function launcherReleaseVersionFromPackage(packageMetadata = {}) {
  return cleanLauncherReleaseVersion(packageMetadata.ahtLauncherVersion || packageMetadata.version || '');
}

export function launcherVersionsReferToSameRelease(left = '', right = '') {
  const cleanLeft = String(left || '').trim();
  const cleanRight = String(right || '').trim();
  if (!cleanLeft || !cleanRight) return false;
  if (cleanLeft === cleanRight) return true;
  const leftIdentity = numericLauncherVersionIdentity(cleanLeft);
  const rightIdentity = numericLauncherVersionIdentity(cleanRight);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}
