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
  return /\/curseforge\/minecraft\/install(?:\/|$)/.test(normalized);
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

function windowsDriveRootFromPath(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (/^[a-z]:$/i.test(text)) {
    return `${text}\\`;
  }
  return path.win32.parse(path.win32.normalize(text)).root || '';
}

const WINDOWS_MINECRAFT_LAUNCHER_SOURCE_PRIORITY = {
  'program-files-x86': 10,
  'program-files': 20,
  localappdata: 30,
  'xbox-games': 40,
  shortcut: 50
};

function windowsMinecraftLauncherSourcePriority(source = '') {
  return WINDOWS_MINECRAFT_LAUNCHER_SOURCE_PRIORITY[String(source || '').trim().toLowerCase()] ?? 80;
}

function windowsXboxGamesDriveRoots() {
  const roots = [];
  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    roots.push(`${String.fromCharCode(code)}:\\`);
  }
  return roots;
}

export function windowsMinecraftLauncherDriveRoots(env = process.env) {
  if (env.AHT_DISABLE_COMMON_MINECRAFT_LAUNCHER_DRIVES === '1') {
    return [];
  }
  return uniquePaths([
    windowsDriveRootFromPath(env.SystemDrive || ''),
    windowsDriveRootFromPath(env.HOMEDRIVE || ''),
    windowsDriveRootFromPath(env.SystemRoot || ''),
    windowsDriveRootFromPath(env.ProgramW6432 || ''),
    ...windowsXboxGamesDriveRoots()
  ]);
}

export function isWindowsAppAliasMinecraftLauncherPath(value = '') {
  const normalized = path.win32.normalize(String(value || '')).toLowerCase();
  return normalized.endsWith(`${path.win32.sep}microsoft${path.win32.sep}windowsapps${path.win32.sep}minecraftlauncher.exe`);
}

function windowsMinecraftLauncherKnownCandidates(env = process.env) {
  const xboxGamesCandidates = windowsMinecraftLauncherDriveRoots(env).map((driveRoot) => ({
    path: path.win32.join(driveRoot, 'XboxGames', 'Minecraft Launcher', 'Content', 'Minecraft.exe'),
    source: 'xbox-games'
  }));
  return [
    env['ProgramFiles(x86)'] ? { path: path.win32.join(env['ProgramFiles(x86)'], 'Minecraft Launcher', 'MinecraftLauncher.exe'), source: 'program-files-x86' } : null,
    env.ProgramFiles ? { path: path.win32.join(env.ProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe'), source: 'program-files' } : null,
    env.LOCALAPPDATA ? { path: path.win32.join(env.LOCALAPPDATA, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe'), source: 'localappdata' } : null,
    ...xboxGamesCandidates
  ].filter((item) => item?.path && isWindowsMinecraftLauncherExecutablePath(item.path));
}

export function windowsMinecraftLauncherExecutableCandidates(rootDir = '', env = process.env, extraPaths = []) {
  const workDirArgs = rootDir ? ['--workDir', rootDir] : [];
  const candidates = [
    ...windowsMinecraftLauncherKnownCandidates(env)
      .map((item) => ({ ...item, args: workDirArgs, kind: 'desktop' })),
    ...uniquePaths(extraPaths)
      .filter((item) => isWindowsMinecraftLauncherExecutablePath(item))
      .map((item) => ({ path: item, args: workDirArgs, kind: 'desktop', source: 'shortcut' }))
  ]
    .filter((item) => item?.path)
    .map((item, index) => ({
      ...item,
      priority: windowsMinecraftLauncherSourcePriority(item.source),
      order: index
    }))
    .sort((a, b) => a.priority - b.priority || a.order - b.order);
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = pathKey(candidate.path);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const { order, ...cleanCandidate } = candidate;
    result.push(cleanCandidate);
  }
  return result;
}

export function isWindowsMinecraftLauncherExecutablePath(value = '') {
  const normalized = path.win32.normalize(String(value || '')).toLowerCase();
  if (isWindowsAppAliasMinecraftLauncherPath(normalized)) {
    return false;
  }
  const fileName = path.win32.basename(normalized);
  return fileName === 'minecraftlauncher.exe'
    || (fileName === 'minecraft.exe' && normalized.includes(`${path.win32.sep}minecraft launcher${path.win32.sep}`));
}

export function localMinecraftRootCandidates({ homePath = '', documentsPath = '', env = process.env } = {}) {
  return uniquePaths([
    homePath ? path.win32.join(homePath, 'curseforge', 'minecraft', 'Install') : '',
    homePath ? path.win32.join(homePath, 'CurseForge', 'minecraft', 'Install') : '',
    documentsPath ? path.win32.join(documentsPath, 'CurseForge', 'minecraft', 'Install') : '',
    documentsPath ? path.win32.join(documentsPath, 'curseforge', 'minecraft', 'Install') : '',
    env.APPDATA ? path.win32.join(env.APPDATA, 'CurseForge', 'minecraft', 'Install') : '',
    env.APPDATA ? path.win32.join(env.APPDATA, 'curseforge', 'minecraft', 'Install') : '',
    env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'CurseForge', 'minecraft', 'Install') : '',
    env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'curseforge', 'minecraft', 'Install') : ''
  ]);
}

export function macCurseForgeMinecraftRootCandidates({ homePath = '', documentsPath = '' } = {}) {
  return uniquePosixPaths([
    homePath ? path.posix.join(homePath, 'curseforge', 'minecraft', 'Install') : '',
    homePath ? path.posix.join(homePath, 'CurseForge', 'minecraft', 'Install') : '',
    documentsPath ? path.posix.join(documentsPath, 'CurseForge', 'minecraft', 'Install') : '',
    documentsPath ? path.posix.join(documentsPath, 'curseforge', 'minecraft', 'Install') : '',
    homePath ? path.posix.join(homePath, 'Library', 'Application Support', 'CurseForge', 'minecraft', 'Install') : '',
    homePath ? path.posix.join(homePath, 'Library', 'Application Support', 'curseforge', 'minecraft', 'Install') : ''
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
  ]).filter((item) => !isMacCurseForgeAppPath(item));
}

export function isMacCurseForgeAppPath(value = '') {
  const normalized = path.posix.normalize(String(value || '')).toLowerCase();
  return normalized.endsWith('/curseforge.app')
    || normalized.includes('/curseforge/')
    || normalized.includes('/curseforge.app/');
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
    ...localMinecraftRootCandidates({ homePath, documentsPath, env }),
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
  const launcherCandidates = [];
  for (const candidate of windowsMinecraftLauncherExecutableCandidates('', env, minecraftLauncherPaths)) {
    if (await pathExists(candidate.path)) {
      launcherCandidates.push(candidate);
    }
  }

  for (const launchRoot of desktopRoots) {
    for (const candidate of launcherCandidates) {
      const curseForgeRoot = isCurseForgeMinecraftRoot(launchRoot);
      addRoute(routes, {
        kind: curseForgeRoot ? 'curseforge' : 'desktop',
        label: curseForgeRoot ? 'Minecraft Launcher (CurseForge root)' : 'Minecraft Launcher',
        command: candidate.path,
        args: launchRoot ? ['--workDir', launchRoot] : [],
        cwd: launchRoot,
        rootDir: launchRoot,
        source: candidate.source || 'default-path'
      });
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
