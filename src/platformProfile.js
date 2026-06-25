import os from 'node:os';
import path from 'node:path';

export function platformKey(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'ubuntu-linux';
  return 'desktop';
}

export function platformDisplayName(platform = process.platform) {
  const key = platformKey(platform);
  if (key === 'windows') return 'Windows 10/11';
  if (key === 'macos') return 'macOS';
  if (key === 'ubuntu-linux') return 'Ubuntu/Linux';
  return 'Desktop';
}

export function defaultInstanceDirForPlatform(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    const root = env.SystemDrive || path.win32.parse(home).root || 'C:';
    const drive = root.endsWith(path.win32.sep) ? root : `${root}${path.win32.sep}`;
    return path.win32.join(drive, 'AHT', 'A Hard Time');
  }

  const home = env.HOME || os.homedir();
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'A Hard Time', 'Instance');
  }

  const dataHome = env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share');
  return path.posix.join(dataHome, 'aht-launcher', 'A Hard Time');
}

export function platformProfile(platform = process.platform, env = process.env) {
  const key = platformKey(platform);
  const instanceDir = defaultInstanceDirForPlatform(platform, env);
  return {
    key,
    displayName: platformDisplayName(platform),
    instanceDir,
    launcherName:
      key === 'windows' ? 'A Hard Time Launcher Windows'
        : key === 'macos' ? 'A Hard Time Launcher macOS'
          : key === 'ubuntu-linux' ? 'A Hard Time Launcher Ubuntu'
            : 'A Hard Time Launcher',
    packageTarget:
      key === 'windows' ? 'NSIS installer for Windows 10/11'
        : key === 'macos' ? 'DMG app for macOS'
          : key === 'ubuntu-linux' ? 'AppImage and .deb for Ubuntu/Linux'
            : 'Desktop package'
  };
}
