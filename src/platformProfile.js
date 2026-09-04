import os from 'node:os';
import path from 'node:path';

export function platformKey(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported AHT launcher platform: ${platform}. Supported platforms are Windows 10/11, macOS, and Linux x64.`);
}

export function platformDisplayName(platform = process.platform) {
  const key = platformKey(platform);
  if (key === 'windows') return 'Windows 10/11';
  if (key === 'macos') return 'macOS';
  return 'Linux x64';
}

export function defaultInstanceDirForPlatform(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    const root = env.SystemDrive || path.win32.parse(home).root || 'C:';
    const drive = root.endsWith(path.win32.sep) ? root : `${root}${path.win32.sep}`;
    return path.win32.join(drive, 'AHT', 'A Hard Time');
  }

  if (platform === 'darwin') {
    const home = env.HOME || os.homedir();
    return path.posix.join(home, 'Library', 'Application Support', 'A Hard Time', 'Instance');
  }

  if (platform === 'linux') {
    const home = env.HOME || os.homedir();
    const dataHome = env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share');
    return path.posix.join(dataHome, 'A Hard Time', 'Instance');
  }

  platformKey(platform);
}

export function isMacosPrivacyProtectedPath(value = '', env = process.env) {
  const candidate = String(value || '').trim();
  if (!candidate) return false;
  const home = env.HOME || os.homedir();
  const normalized = path.posix.resolve(candidate).toLowerCase();
  const protectedRoots = [
    'Desktop',
    'Documents',
    'Downloads',
    'Movies',
    'Music',
    'Pictures',
    path.posix.join('Library', 'CloudStorage'),
    path.posix.join('Library', 'Mobile Documents')
  ].map((relativePath) => path.posix.resolve(home, relativePath).toLowerCase());
  return normalized === '/volumes'
    || normalized.startsWith('/volumes/')
    || protectedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function platformProfile(platform = process.platform, env = process.env) {
  const key = platformKey(platform);
  const instanceDir = defaultInstanceDirForPlatform(platform, env);
  return {
    key,
    displayName: platformDisplayName(platform),
    instanceDir,
    launcherName: key === 'windows'
      ? 'A Hard Time Launcher Windows'
      : key === 'macos'
        ? 'A Hard Time Launcher macOS'
        : 'A Hard Time Launcher Linux',
    packageTarget: key === 'windows'
      ? 'NSIS installer for Windows 10/11'
      : key === 'macos'
        ? 'DMG app for macOS'
        : 'portable AppImage for Linux x64 distributions'
  };
}
