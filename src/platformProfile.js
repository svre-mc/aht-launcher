import os from 'node:os';
import path from 'node:path';

export function platformKey(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  throw new Error(`Unsupported AHT launcher platform: ${platform}. Supported platforms are Windows 10/11 and macOS.`);
}

export function platformDisplayName(platform = process.platform) {
  const key = platformKey(platform);
  if (key === 'windows') return 'Windows 10/11';
  return 'macOS';
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

  platformKey(platform);
}

export function platformProfile(platform = process.platform, env = process.env) {
  const key = platformKey(platform);
  const instanceDir = defaultInstanceDirForPlatform(platform, env);
  return {
    key,
    displayName: platformDisplayName(platform),
    instanceDir,
    launcherName: key === 'windows' ? 'A Hard Time Launcher Windows' : 'A Hard Time Launcher macOS',
    packageTarget: key === 'windows' ? 'NSIS installer for Windows 10/11' : 'DMG app for macOS'
  };
}
