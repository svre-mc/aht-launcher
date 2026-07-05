import path from 'node:path';
import { defaultMinecraftRoot, minecraftRootCandidates } from './minecraftLauncherProfile.js';

export const WINDOWS_MINECRAFT_PACKAGE_FAMILY = 'Microsoft.4297127D64EC6_8wekyb3d8bbwe';
export const MAC_MINECRAFT_BUNDLE_IDS = [
  'com.mojang.minecraftlauncher',
  'com.microsoft.minecraftlauncher'
];
export const MAC_MINECRAFT_APP_NAMES = [
  'Minecraft Launcher',
  'Minecraft'
];

export function isCurseForgeMinecraftRoot(value = '') {
  const normalized = String(value || '').replaceAll('\\', '/').toLowerCase();
  return normalized.includes('/curseforge/minecraft/install');
}

function pathKey(value = '') {
  const text = String(value || '').trim();
  return text ? path.win32.normalize(text).replace(/[\\/]+$/, '').toLowerCase() : '';
}

function posixPathKey(value = '') {
  const text = String(value || '').trim();
  return text ? path.posix.normalize(text).replace(/\/+$/, '').toLowerCase() : '';
}

export function uniquePaths(paths = []) {
  const seen = new Set();
  const result = [];
  for (const item of paths) {
    const text = String(item || '').trim();
    const key = pathKey(text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function uniquePosixPaths(paths = []) {
  const seen = new Set();
  const result = [];
  for (const item of paths) {
    const text = String(item || '').trim();
    const key = posixPathKey(text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

export function windowsStoreMinecraftRoot(env = process.env) {
  if (!env.LOCALAPPDATA) {
    return '';
  }
  return path.win32.join(
    env.LOCALAPPDATA,
    'Packages',
    WINDOWS_MINECRAFT_PACKAGE_FAMILY,
    'LocalCache',
    'Roaming',
    '.minecraft'
  );
}

export function windowsStoreMinecraftPackageDir(env = process.env) {
  return env.LOCALAPPDATA
    ? path.win32.join(env.LOCALAPPDATA, 'Packages', WINDOWS_MINECRAFT_PACKAGE_FAMILY)
    : '';
}

export function windowsMinecraftLauncherExecutableCandidates(rootDir = '', env = process.env, extraPaths = []) {
  const workDirArgs = rootDir ? ['--workDir', rootDir] : [];
  const candidates = [
    env['ProgramFiles(x86)'] ? { path: path.win32.join(env['ProgramFiles(x86)'], 'Minecraft Launcher', 'MinecraftLauncher.exe'), args: workDirArgs, kind: 'desktop' } : null,
    env.ProgramFiles ? { path: path.win32.join(env.ProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe'), args: workDirArgs, kind: 'desktop' } : null,
    env.LOCALAPPDATA ? { path: path.win32.join(env.LOCALAPPDATA, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe'), args: workDirArgs, kind: 'desktop' } : null,
    ...uniquePaths(extraPaths)
      .filter((item) => isWindowsMinecraftLauncherExecutablePath(item))
      .map((item) => ({ path: item, args: workDirArgs, kind: 'desktop', source: 'shortcut' }))
  ].filter((item) => item?.path);
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = pathKey(candidate.path);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export function isWindowsMinecraftLauncherExecutablePath(value = '') {
  const normalized = path.win32.normalize(String(value || '')).toLowerCase();
  const fileName = path.win32.basename(normalized);
  return fileName === 'minecraftlauncher.exe'
    || (fileName === 'minecraft.exe' && normalized.includes(`${path.win32.sep}minecraft launcher${path.win32.sep}`));
}

export function localMinecraftRootCandidates({ homePath = '', documentsPath = '' } = {}) {
  return uniquePaths([
    homePath ? path.win32.join(homePath, 'curseforge', 'minecraft', 'Install') : '',
    documentsPath ? path.win32.join(documentsPath, 'CurseForge', 'minecraft', 'Install') : ''
  ]);
}

export function macCurseForgeMinecraftRootCandidates({ homePath = '', documentsPath = '' } = {}) {
  return uniquePosixPaths([
    homePath ? path.posix.join(homePath, 'curseforge', 'minecraft', 'Install') : '',
    documentsPath ? path.posix.join(documentsPath, 'CurseForge', 'minecraft', 'Install') : '',
    homePath ? path.posix.join(homePath, 'Library', 'Application Support', 'CurseForge', 'minecraft', 'Install') : ''
  ]);
}

export function macMinecraftLauncherAppPaths({ env = process.env, homePath = '' } = {}) {
  const home = homePath || env.HOME || '';
  return uniquePosixPaths([
    env.AHT_MINECRAFT_MAC_APP || '',
    '/Applications/Minecraft.app',
    '/Applications/Minecraft Launcher.app',
    home ? path.posix.join(home, 'Applications', 'Minecraft.app') : '',
    home ? path.posix.join(home, 'Applications', 'Minecraft Launcher.app') : ''
  ]);
}

function addRoute(routes, route) {
  if (!route?.command && route?.kind !== 'store') {
    return;
  }
  const key = [
    route.kind || '',
    route.command ? pathKey(route.command) : '',
    JSON.stringify(route.args || []),
    route.cwd ? pathKey(route.cwd) : ''
  ].join('|');
  if (routes.some((item) => item.key === key)) {
    return;
  }
  routes.push({ ...route, key });
}

function addMacRoute(routes, route) {
  if (!Array.isArray(route?.args) || !route.args.length) {
    return;
  }
  const key = [
    route.kind || '',
    JSON.stringify(route.args || []),
    route.cwd ? posixPathKey(route.cwd) : ''
  ].join('|');
  if (routes.some((item) => item.key === key)) {
    return;
  }
  routes.push({ ...route, key });
}

async function existingRoots(roots = [], pathExists = async () => false) {
  const result = [];
  for (const root of uniquePaths(roots)) {
    if (await pathExists(root)) {
      result.push(root);
    }
  }
  return result;
}

async function existingMacRoots(roots = [], pathExists = async () => false) {
  const result = [];
  for (const root of uniquePosixPaths(roots)) {
    if (await pathExists(root)) {
      result.push(root);
    }
  }
  return result;
}

function macOpenArgsForAppPath(appPath = '', rootDir = '') {
  return rootDir
    ? [appPath, '--args', '--workDir', rootDir]
    : [appPath];
}

function macOpenArgsForBundleId(bundleId = '', rootDir = '') {
  return rootDir
    ? ['-b', bundleId, '--args', '--workDir', rootDir]
    : ['-b', bundleId];
}

function macOpenArgsForAppName(appName = '', rootDir = '') {
  return rootDir
    ? ['-a', appName, '--args', '--workDir', rootDir]
    : ['-a', appName];
}

export async function planWindowsMinecraftLauncherRoutes({
  config = {},
  env = process.env,
  homePath = '',
  documentsPath = '',
  pathExists = async () => false,
  storeInstalled = false,
  minecraftLauncherPaths = []
} = {}) {
  const rootDir = config.minecraftLauncher?.rootDir || defaultMinecraftRoot('win32', env);
  const syncRoots = Array.isArray(config.minecraftLauncher?.syncRoots)
    ? config.minecraftLauncher.syncRoots
    : [];
  const defaultRoots = minecraftRootCandidates('win32', {
    ...env,
    HOME: env.HOME || homePath,
    USERPROFILE: env.USERPROFILE || homePath
  });
  const profileRoots = uniquePaths([rootDir, ...syncRoots, ...defaultRoots]);
  const routes = [];
  const existingCurseForgeRoots = await existingRoots([
    ...localMinecraftRootCandidates({ homePath, documentsPath }),
    ...profileRoots.filter((item) => isCurseForgeMinecraftRoot(item))
  ], pathExists);
  const existingNonCurseForgeRoots = await existingRoots([
    ...syncRoots.filter((item) => !isCurseForgeMinecraftRoot(item)),
    ...defaultRoots.filter((item) => !isCurseForgeMinecraftRoot(item))
  ], pathExists);
  const desktopRoots = uniquePaths([
    ...existingCurseForgeRoots,
    rootDir,
    ...existingNonCurseForgeRoots
  ]);

  for (const launchRoot of desktopRoots) {
    for (const candidate of windowsMinecraftLauncherExecutableCandidates(launchRoot, env, minecraftLauncherPaths)) {
      if (candidate.kind !== 'desktop') {
        continue;
      }
      if (await pathExists(candidate.path)) {
        const curseForgeRoot = isCurseForgeMinecraftRoot(launchRoot);
        addRoute(routes, {
          kind: curseForgeRoot ? 'curseforge' : 'desktop',
          label: curseForgeRoot ? 'Minecraft Launcher (CurseForge root)' : 'Minecraft Launcher',
          command: candidate.path,
          args: candidate.args || [],
          cwd: launchRoot,
          rootDir: launchRoot,
          source: candidate.source || 'default-path'
        });
      }
    }
  }

  const storeRoot = windowsStoreMinecraftRoot(env);
  if (storeInstalled && storeRoot) {
    addRoute(routes, {
      kind: 'store',
      label: 'Microsoft Store Minecraft Launcher',
      cwd: storeRoot,
      rootDir: storeRoot,
      source: 'windows-store'
    });
  }
  return routes.map(({ key, ...route }) => route);
}

export async function planMacMinecraftLauncherRoutes({
  config = {},
  env = process.env,
  homePath = '',
  documentsPath = '',
  pathExists = async () => false
} = {}) {
  const home = homePath || env.HOME || '';
  const rootDir = config.minecraftLauncher?.rootDir || defaultMinecraftRoot('darwin', { ...env, HOME: home });
  const syncRoots = Array.isArray(config.minecraftLauncher?.syncRoots)
    ? config.minecraftLauncher.syncRoots
    : [];
  const defaultRoots = minecraftRootCandidates('darwin', { ...env, HOME: home });
  const existingCurseForgeRoots = await existingMacRoots(macCurseForgeMinecraftRootCandidates({ homePath: home, documentsPath }), pathExists);
  const launchRoots = uniquePosixPaths([
    ...existingCurseForgeRoots,
    rootDir,
    ...syncRoots,
    ...defaultRoots
  ]);
  const routes = [];

  for (const launchRoot of launchRoots) {
    for (const appPath of macMinecraftLauncherAppPaths({ env, homePath: home })) {
      if (await pathExists(appPath)) {
        const curseForgeRoot = isCurseForgeMinecraftRoot(launchRoot);
        addMacRoute(routes, {
          kind: curseForgeRoot ? 'curseforge' : 'app',
          label: curseForgeRoot ? 'Minecraft Launcher (CurseForge root)' : 'Minecraft Launcher',
          args: macOpenArgsForAppPath(appPath, launchRoot),
          cwd: launchRoot,
          rootDir: launchRoot
        });
      }
    }
  }

  for (const launchRoot of launchRoots) {
    for (const bundleId of MAC_MINECRAFT_BUNDLE_IDS) {
      const curseForgeRoot = isCurseForgeMinecraftRoot(launchRoot);
      addMacRoute(routes, {
        kind: curseForgeRoot ? 'curseforge-bundle' : 'bundle',
        label: curseForgeRoot ? 'Minecraft Launcher (CurseForge root)' : 'Minecraft Launcher',
        args: macOpenArgsForBundleId(bundleId, launchRoot),
        cwd: launchRoot,
        rootDir: launchRoot
      });
    }
    for (const appName of MAC_MINECRAFT_APP_NAMES) {
      const curseForgeRoot = isCurseForgeMinecraftRoot(launchRoot);
      addMacRoute(routes, {
        kind: curseForgeRoot ? 'curseforge-app-name' : 'app-name',
        label: curseForgeRoot ? 'Minecraft Launcher (CurseForge root)' : 'Minecraft Launcher',
        args: macOpenArgsForAppName(appName, launchRoot),
        cwd: launchRoot,
        rootDir: launchRoot
      });
    }
  }

  return routes.map(({ key, ...route }) => route);
}
