import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export function linuxMinecraftLauncherPaths({ rootDir = '', home = '', downloadsDir = '', pathCommand = '', executablePath = '' } = {}) {
  const roots = [rootDir, home && path.posix.join(home, '.minecraft')].filter(Boolean);
  const downloads = downloadsDir || (home && path.posix.join(home, 'Downloads'));
  return [...new Set([
    executablePath,
    ...roots.flatMap((root) => [
      path.posix.join(root, 'minecraft-launcher'),
      path.posix.join(root, 'minecraft-launcher', 'minecraft-launcher'),
      path.posix.join(root, 'launcher', 'minecraft-launcher')
    ]),
    pathCommand,
    '/usr/bin/minecraft-launcher',
    '/usr/local/bin/minecraft-launcher',
    '/opt/minecraft-launcher/minecraft-launcher',
    '/snap/bin/minecraft-launcher',
    home && path.posix.join(home, '.local', 'bin', 'minecraft-launcher'),
    ...[downloads, home, home && path.posix.join(home, 'Games')].filter(Boolean).flatMap((root) => [
      path.posix.join(root, 'minecraft-launcher', 'minecraft-launcher'),
      path.posix.join(root, 'minecraft-launcher')
    ])
  ].filter((file) => file && path.posix.isAbsolute(file)))];
}

export async function isLinuxMinecraftLauncherExecutable(file, fileSystem = fs) {
  if (!file || !path.posix.isAbsolute(file) || path.posix.basename(file) !== 'minecraft-launcher') return false;
  try {
    if (!(await fileSystem.stat(file)).isFile()) return false;
    await fileSystem.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
