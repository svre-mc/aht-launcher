import assert from 'node:assert/strict';
import path from 'node:path';
import {
  MAC_MINECRAFT_BUNDLE_IDS,
  WINDOWS_MINECRAFT_PACKAGE_FAMILY,
  isCurseForgeMinecraftRoot,
  macCurseForgeMinecraftRootCandidates,
  macMinecraftLauncherAppPaths,
  planMacMinecraftLauncherRoutes,
  planWindowsMinecraftLauncherRoutes,
  uniquePaths,
  windowsCurseForgeAppExecutableCandidates,
  windowsStoreMinecraftPackageDir,
  windowsStoreMinecraftRoot
} from '../src/minecraftLauncherRoutes.js';

const env = {
  USERPROFILE: 'C:\\Users\\Player',
  HOME: 'C:\\Users\\Player',
  APPDATA: 'C:\\Users\\Player\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Player\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)'
};
const homePath = env.USERPROFILE;
const documentsPath = 'C:\\Users\\Player\\Documents';
const defaultRoot = path.win32.join(env.APPDATA, '.minecraft');
const storeRoot = windowsStoreMinecraftRoot(env);
const curseForgeRoot = path.win32.join(homePath, 'curseforge', 'minecraft', 'Install');
const desktopLauncher = path.win32.join(env.ProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe');
const localDesktopLauncher = path.win32.join(env.LOCALAPPDATA, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe');
const rootOwnedLauncher = path.win32.join(defaultRoot, 'minecraft.exe');
const curseForgeApp = path.win32.join(env.LOCALAPPDATA, 'Programs', 'CurseForge', 'CurseForge.exe');
const shortcutMinecraftLauncher = 'D:\\Games\\Minecraft Launcher\\MinecraftLauncher.exe';
const shortcutMinecraftExeLauncher = 'E:\\XboxGames\\Minecraft Launcher\\Content\\Minecraft.exe';
const shortcutCurseForgeApp = 'D:\\Games\\CurseForge\\CurseForge.exe';

const macEnv = {
  HOME: '/Users/player'
};
const macHomePath = macEnv.HOME;
const macDocumentsPath = '/Users/player/Documents';
const macDefaultRoot = '/Users/player/Library/Application Support/minecraft';
const macCurseForgeRoot = '/Users/player/curseforge/minecraft/Install';
const macLauncherApp = '/Applications/Minecraft Launcher.app';

function existsSet(paths = []) {
  const normalized = new Set(paths.map((item) => path.win32.normalize(item).toLowerCase()));
  return async (item) => normalized.has(path.win32.normalize(String(item || '')).toLowerCase());
}

function existsPosixSet(paths = []) {
  const normalized = new Set(paths.map((item) => path.posix.normalize(item).toLowerCase()));
  return async (item) => normalized.has(path.posix.normalize(String(item || '')).toLowerCase());
}

async function routes(existing, options = {}) {
  return planWindowsMinecraftLauncherRoutes({
    config: {
      minecraftLauncher: {
        rootDir: options.rootDir || defaultRoot,
        syncRoots: options.syncRoots || []
      }
    },
    env,
    homePath,
    documentsPath,
    pathExists: existsSet(existing),
    storeInstalled: options.storeInstalled === true,
    minecraftLauncherPaths: options.minecraftLauncherPaths || [],
    curseForgeAppPaths: options.curseForgeAppPaths || []
  });
}

async function macRoutes(existing, options = {}) {
  return planMacMinecraftLauncherRoutes({
    config: {
      minecraftLauncher: {
        rootDir: options.rootDir || macDefaultRoot,
        syncRoots: options.syncRoots || []
      }
    },
    env: {
      ...macEnv,
      ...(options.env || {})
    },
    homePath: macHomePath,
    documentsPath: macDocumentsPath,
    pathExists: existsPosixSet(existing)
  });
}

{
  const planned = await routes([
    curseForgeRoot,
    defaultRoot,
    desktopLauncher
  ], { storeInstalled: true });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge', 'desktop', 'store']);
  assert.equal(planned[0].command, desktopLauncher);
  assert.deepEqual(planned[0].args, ['--workDir', curseForgeRoot]);
  assert.equal(planned[0].label, 'Minecraft Launcher (CurseForge root)');
  assert.notEqual(planned[0].command, path.win32.join(curseForgeRoot, 'minecraft.exe'));
  assert.equal(planned[1].args[1], defaultRoot);
}

{
  const planned = await routes([localDesktopLauncher], { storeInstalled: true });
  assert.deepEqual(planned.map((route) => route.kind), ['desktop', 'store']);
  assert.equal(planned[0].command, localDesktopLauncher);
}

{
  const planned = await routes([rootOwnedLauncher], { storeInstalled: true });
  assert.deepEqual(planned.map((route) => route.kind), ['root', 'store']);
  assert.equal(planned[0].command, rootOwnedLauncher);
  assert.equal(planned[0].observeExitMs, 1200);
}

{
  const planned = await routes([], { storeInstalled: true });
  assert.deepEqual(planned.map((route) => route.kind), ['store']);
  assert.equal(planned[0].cwd, storeRoot);
}

{
  const planned = await routes([
    curseForgeRoot,
    desktopLauncher
  ], {
    rootDir: curseForgeRoot,
    syncRoots: [curseForgeRoot, path.win32.join(curseForgeRoot, '..', 'Install')],
    storeInstalled: false
  });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge']);
  assert.equal(planned[0].command, desktopLauncher);
}

{
  const planned = await routes([
    curseForgeRoot,
    curseForgeApp
  ], {
    storeInstalled: true
  });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge-app', 'store']);
  assert.equal(planned[0].command, curseForgeApp);
  assert.equal(planned[1].cwd, storeRoot);
}

{
  const planned = await routes([
    curseForgeRoot,
    curseForgeApp
  ], {
    storeInstalled: false
  });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge-app']);
  assert.equal(planned[0].command, curseForgeApp);
}

{
  const planned = await routes([
    curseForgeRoot,
    defaultRoot,
    shortcutMinecraftLauncher
  ], {
    storeInstalled: true,
    minecraftLauncherPaths: [shortcutMinecraftLauncher]
  });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge', 'desktop', 'store']);
  assert.equal(planned[0].command, shortcutMinecraftLauncher);
  assert.equal(planned[0].source, 'shortcut');
  assert.deepEqual(planned[0].args, ['--workDir', curseForgeRoot]);
  assert.deepEqual(planned[1].args, ['--workDir', defaultRoot]);
}

{
  const planned = await routes([
    curseForgeRoot,
    shortcutMinecraftExeLauncher
  ], {
    storeInstalled: true,
    minecraftLauncherPaths: [shortcutMinecraftExeLauncher]
  });
  assert.equal(planned[0].kind, 'curseforge');
  assert.equal(planned[0].command, shortcutMinecraftExeLauncher);
  assert.equal(planned[0].source, 'shortcut');
  assert.deepEqual(planned[0].args, ['--workDir', curseForgeRoot]);
}

{
  const planned = await routes([
    curseForgeRoot,
    shortcutCurseForgeApp
  ], {
    storeInstalled: true,
    curseForgeAppPaths: [shortcutCurseForgeApp]
  });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge-app', 'store']);
  assert.equal(planned[0].command, shortcutCurseForgeApp);
  assert.equal(planned[0].source, 'shortcut');
}

{
  const planned = await routes([], { storeInstalled: false });
  assert.deepEqual(planned, []);
}

assert.equal(isCurseForgeMinecraftRoot('C:\\Users\\Player\\curseforge\\minecraft\\Install'), true);
assert.equal(isCurseForgeMinecraftRoot('C:\\Users\\Player\\AppData\\Roaming\\.minecraft'), false);
assert.deepEqual(uniquePaths(['C:\\A\\B', 'c:/a/b/', 'C:\\A\\C']).map((item) => path.win32.normalize(item)), ['C:\\A\\B', 'C:\\A\\C']);
assert.equal(windowsStoreMinecraftPackageDir(env), path.win32.join(env.LOCALAPPDATA, 'Packages', WINDOWS_MINECRAFT_PACKAGE_FAMILY));
assert.deepEqual(windowsCurseForgeAppExecutableCandidates(env).map((item) => item.path)[0], curseForgeApp);

{
  const planned = await macRoutes([
    macCurseForgeRoot,
    macLauncherApp
  ]);
  assert.equal(planned[0].kind, 'curseforge');
  assert.equal(planned[0].label, 'Minecraft Launcher (CurseForge root)');
  assert.deepEqual(planned[0].args, [macLauncherApp, '--args', '--workDir', macCurseForgeRoot]);
  assert.equal(planned[0].cwd, macCurseForgeRoot);
  assert.equal(planned.find((route) => route.kind === 'app')?.rootDir, macDefaultRoot);
}

{
  const planned = await macRoutes([
    macCurseForgeRoot
  ]);
  assert.equal(planned[0].kind, 'curseforge-bundle');
  assert.deepEqual(planned[0].args, ['-b', MAC_MINECRAFT_BUNDLE_IDS[0], '--args', '--workDir', macCurseForgeRoot]);
  assert.equal(planned.some((route) => route.kind === 'bundle' && route.rootDir === macDefaultRoot), true);
}

{
  const customApp = '/Users/player/Apps/Minecraft Custom.app';
  const planned = await macRoutes([customApp], { env: { AHT_MINECRAFT_MAC_APP: customApp } });
  assert.equal(planned[0].kind, 'app');
  assert.deepEqual(planned[0].args, [customApp, '--args', '--workDir', macDefaultRoot]);
}

assert.equal(macCurseForgeMinecraftRootCandidates({ homePath: macHomePath, documentsPath: macDocumentsPath })[0], macCurseForgeRoot);
assert.equal(macMinecraftLauncherAppPaths({ env: macEnv, homePath: macHomePath })[1], macLauncherApp);

console.log(JSON.stringify({
  ok: true,
  covered: [
    'curseforge-desktop-store',
    'desktop-store',
    'root-store',
    'store-only',
    'dedupe-curseforge',
    'curseforge-app-before-store',
    'curseforge-app-only',
    'shortcut-minecraft-launcher',
    'shortcut-minecraft-exe-launcher',
    'shortcut-curseforge-app',
    'missing-launcher',
    'macos-curseforge-app-path',
    'macos-curseforge-bundle-fallback',
    'macos-custom-app'
  ]
}, null, 2));
