import assert from 'node:assert/strict';
import path from 'node:path';
import {
  MAC_MINECRAFT_BUNDLE_IDS,
  WINDOWS_MINECRAFT_PACKAGE_FAMILY,
  isCurseForgeMinecraftRoot,
  isWindowsMinecraftLauncherExecutablePath,
  localMinecraftRootCandidates,
  macCurseForgeMinecraftRootCandidates,
  macMinecraftLauncherAppPaths,
  planMacMinecraftLauncherRoutes,
  planWindowsMinecraftLauncherRoutes,
  uniquePaths,
  windowsMinecraftLauncherDriveRoots,
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
const documentsCurseForgeRoot = path.win32.join(documentsPath, 'CurseForge', 'minecraft', 'Install');
const appDataCurseForgeRoot = path.win32.join(env.APPDATA, 'CurseForge', 'minecraft', 'Install');
const localAppDataCurseForgeRoot = path.win32.join(env.LOCALAPPDATA, 'CurseForge', 'minecraft', 'Install');
const curseForgeInstanceDir = path.win32.join(homePath, 'curseforge', 'minecraft', 'Instances', 'RLCraft Dregora');
const desktopLauncher = path.win32.join(env.ProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe');
const localDesktopLauncher = path.win32.join(env.LOCALAPPDATA, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe');
const xboxGamesLauncher = 'D:\\XboxGames\\Minecraft Launcher\\Content\\Minecraft.exe';
const extraDriveXboxGamesLauncher = 'M:\\XboxGames\\Minecraft Launcher\\Content\\Minecraft.exe';
const nonLocalXboxGamesLauncher = 'Z:\\XboxGames\\Minecraft Launcher\\Content\\Minecraft.exe';
const windowsAppAliasLauncher = path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'MinecraftLauncher.exe');
const rootOwnedLauncher = path.win32.join(defaultRoot, 'minecraft.exe');
const curseForgeApp = path.win32.join(env.LOCALAPPDATA, 'Programs', 'CurseForge', 'CurseForge.exe');
const shortcutMinecraftLauncher = 'D:\\Games\\Minecraft Launcher\\MinecraftLauncher.exe';
const shortcutMinecraftExeLauncher = 'E:\\OtherGames\\Minecraft Launcher\\Content\\Minecraft.exe';
const shortcutBadMinecraftExe = 'E:\\Games\\Minecraft\\minecraft.exe';
const shortcutCurseForgeApp = 'D:\\Games\\CurseForge\\CurseForge.exe';

const macEnv = {
  HOME: '/Users/player'
};
const macHomePath = macEnv.HOME;
const macDocumentsPath = '/Users/player/Documents';
const macDefaultRoot = '/Users/player/Library/Application Support/minecraft';
const macCurseForgeRoot = '/Users/player/curseforge/minecraft/Install';
const macLibraryCurseForgeRoot = '/Users/player/Library/Application Support/CurseForge/minecraft/Install';
const macDocumentsLowerCurseForgeRoot = '/Users/player/Documents/curseforge/minecraft/Install';
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
    env: {
      ...env,
      ...(options.env || {})
    },
    homePath,
    documentsPath,
    pathExists: existsSet(existing),
    storeInstalled: options.storeInstalled === true,
    minecraftLauncherPaths: options.minecraftLauncherPaths || []
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
  const planned = await routes([
    documentsCurseForgeRoot,
    localDesktopLauncher
  ], { storeInstalled: false });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge', 'desktop']);
  assert.equal(planned[0].command, localDesktopLauncher);
  assert.equal(planned[0].rootDir, documentsCurseForgeRoot);
  assert.deepEqual(planned[0].args, ['--workDir', documentsCurseForgeRoot]);
}

{
  const planned = await routes([
    appDataCurseForgeRoot,
    desktopLauncher
  ], { storeInstalled: true });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge', 'desktop', 'store']);
  assert.equal(planned[0].rootDir, appDataCurseForgeRoot);
  assert.deepEqual(planned[0].args, ['--workDir', appDataCurseForgeRoot]);
}

{
  const planned = await routes([
    localAppDataCurseForgeRoot,
    localDesktopLauncher
  ], { storeInstalled: false });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge', 'desktop']);
  assert.equal(planned[0].rootDir, localAppDataCurseForgeRoot);
}

{
  const planned = await routes([
    curseForgeRoot,
    defaultRoot,
    xboxGamesLauncher
  ], { storeInstalled: true });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge', 'desktop', 'store']);
  assert.equal(planned[0].command, xboxGamesLauncher);
  assert.equal(planned[0].source, 'xbox-games');
  assert.deepEqual(planned[0].args, ['--workDir', curseForgeRoot]);
  assert.equal(planned[1].command, xboxGamesLauncher);
  assert.deepEqual(planned[1].args, ['--workDir', defaultRoot]);
}

{
  const planned = await routes([
    curseForgeRoot,
    extraDriveXboxGamesLauncher
  ], { storeInstalled: false });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge', 'desktop']);
  assert.equal(planned[0].command, extraDriveXboxGamesLauncher);
  assert.equal(planned[0].source, 'xbox-games');
  assert.deepEqual(planned[0].args, ['--workDir', curseForgeRoot]);
  assert.equal(planned[1].command, extraDriveXboxGamesLauncher);
  assert.deepEqual(planned[1].args, ['--workDir', defaultRoot]);
}

{
  const planned = await routes([
    curseForgeRoot,
    nonLocalXboxGamesLauncher
  ], {
    storeInstalled: false,
    env: {
      SystemDrive: 'Z:',
      HOMEDRIVE: 'Y:'
    }
  });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge', 'desktop']);
  assert.equal(planned[0].command, nonLocalXboxGamesLauncher);
  assert.equal(planned[0].source, 'xbox-games');
  assert.deepEqual(planned[0].args, ['--workDir', curseForgeRoot]);
  assert.equal(planned[1].command, nonLocalXboxGamesLauncher);
  assert.deepEqual(planned[1].args, ['--workDir', defaultRoot]);
}

{
  const planned = await routes([
    curseForgeRoot,
    windowsAppAliasLauncher
  ], { storeInstalled: true });
  assert.deepEqual(planned.map((route) => route.kind), ['store']);
  assert.equal(planned[0].cwd, storeRoot);
  assert.notEqual(planned[0].command, windowsAppAliasLauncher);
}

{
  const planned = await routes([
    curseForgeRoot,
    shortcutMinecraftLauncher,
    windowsAppAliasLauncher
  ], {
    storeInstalled: true,
    minecraftLauncherPaths: [shortcutMinecraftLauncher]
  });
  assert.deepEqual(planned.map((route) => route.kind), ['curseforge', 'desktop', 'store']);
  assert.equal(planned[0].command, shortcutMinecraftLauncher);
  assert.equal(planned[0].source, 'shortcut');
  assert.deepEqual(planned[0].args, ['--workDir', curseForgeRoot]);
  assert.equal(planned[1].command, shortcutMinecraftLauncher);
  assert.deepEqual(planned[1].args, ['--workDir', defaultRoot]);
  assert.equal(planned.some((route) => route.command === windowsAppAliasLauncher), false);
}

{
  const planned = await routes([rootOwnedLauncher], { storeInstalled: true });
  assert.deepEqual(planned.map((route) => route.kind), ['store']);
  assert.notEqual(planned[0].command, rootOwnedLauncher);
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
  assert.deepEqual(planned.map((route) => route.kind), ['store']);
  assert.notEqual(planned[0].command, curseForgeApp);
  assert.equal(planned[0].cwd, storeRoot);
}

{
  const planned = await routes([
    curseForgeRoot,
    curseForgeApp
  ], {
    storeInstalled: false
  });
  assert.deepEqual(planned, []);
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
    shortcutBadMinecraftExe,
    shortcutMinecraftExeLauncher
  ], {
    storeInstalled: true,
    minecraftLauncherPaths: [shortcutBadMinecraftExe, shortcutMinecraftExeLauncher]
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
    minecraftLauncherPaths: []
  });
  assert.deepEqual(planned.map((route) => route.kind), ['store']);
  assert.notEqual(planned[0].command, shortcutCurseForgeApp);
}

{
  const planned = await routes([], { storeInstalled: false });
  assert.deepEqual(planned, []);
}

assert.equal(isCurseForgeMinecraftRoot('C:\\Users\\Player\\curseforge\\minecraft\\Install'), true);
assert.equal(isCurseForgeMinecraftRoot('C:\\Users\\Player\\CurseForge\\minecraft\\Install\\'), true);
assert.equal(isCurseForgeMinecraftRoot('C:\\Users\\Player\\AppData\\Roaming\\CurseForge\\minecraft\\Install'), true);
assert.equal(isCurseForgeMinecraftRoot(curseForgeInstanceDir), false);
assert.equal(isCurseForgeMinecraftRoot('C:\\Users\\Player\\curseforge\\minecraft\\Install-old'), false);
assert.equal(isCurseForgeMinecraftRoot('C:\\Users\\Player\\AppData\\Roaming\\.minecraft'), false);
assert.equal(isWindowsMinecraftLauncherExecutablePath(desktopLauncher), true);
assert.equal(isWindowsMinecraftLauncherExecutablePath(xboxGamesLauncher), true);
assert.equal(isWindowsMinecraftLauncherExecutablePath(windowsAppAliasLauncher), false);
assert.equal(isWindowsMinecraftLauncherExecutablePath(shortcutMinecraftExeLauncher), true);
assert.equal(isWindowsMinecraftLauncherExecutablePath(shortcutBadMinecraftExe), false);
assert.equal(isWindowsMinecraftLauncherExecutablePath(path.win32.join(curseForgeRoot, 'minecraft.exe')), false);
assert.deepEqual(uniquePaths(['C:\\A\\B', 'c:/a/b/', 'C:\\A\\C']).map((item) => path.win32.normalize(item)), ['C:\\A\\B', 'C:\\A\\C']);
assert.deepEqual(windowsMinecraftLauncherDriveRoots({ ...env, SystemDrive: 'C:', HOMEDRIVE: 'D:' }).slice(0, 4), ['C:\\', 'D:\\', 'E:\\', 'F:\\']);
assert.deepEqual(windowsMinecraftLauncherDriveRoots({ ...env, SystemDrive: 'Z:', HOMEDRIVE: 'Y:' }).slice(0, 4), ['Z:\\', 'Y:\\', 'C:\\', 'D:\\']);
assert.equal(windowsMinecraftLauncherDriveRoots(env).includes('M:\\'), true);
assert.deepEqual(windowsMinecraftLauncherDriveRoots({ ...env, AHT_DISABLE_COMMON_MINECRAFT_LAUNCHER_DRIVES: '1' }), []);
assert.equal(windowsStoreMinecraftPackageDir(env), path.win32.join(env.LOCALAPPDATA, 'Packages', WINDOWS_MINECRAFT_PACKAGE_FAMILY));
const windowsCurseForgeCandidates = localMinecraftRootCandidates({ homePath, documentsPath, env });
assert.equal(windowsCurseForgeCandidates.includes(appDataCurseForgeRoot), true);
assert.equal(windowsCurseForgeCandidates.includes(localAppDataCurseForgeRoot), true);

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
    macLibraryCurseForgeRoot,
    macLauncherApp
  ]);
  assert.equal(planned[0].kind, 'curseforge');
  assert.deepEqual(planned[0].args, [macLauncherApp, '--args', '--workDir', macLibraryCurseForgeRoot]);
  assert.equal(planned[0].cwd, macLibraryCurseForgeRoot);
}

{
  const planned = await macRoutes([
    macDocumentsLowerCurseForgeRoot,
    macLauncherApp
  ]);
  assert.equal(planned[0].kind, 'curseforge');
  assert.equal(isCurseForgeMinecraftRoot(planned[0].cwd), true);
  assert.equal(planned[0].cwd.toLowerCase(), macDocumentsLowerCurseForgeRoot.toLowerCase());
  assert.deepEqual(planned[0].args, [macLauncherApp, '--args', '--workDir', planned[0].cwd]);
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
assert.equal(macCurseForgeMinecraftRootCandidates({ homePath: macHomePath, documentsPath: macDocumentsPath }).some((candidate) => candidate.toLowerCase() === macDocumentsLowerCurseForgeRoot.toLowerCase()), true);
assert.equal(macMinecraftLauncherAppPaths({ env: macEnv, homePath: macHomePath })[1], macLauncherApp);

console.log(JSON.stringify({
  ok: true,
  covered: [
    'curseforge-desktop-store',
    'desktop-store',
    'documents-curseforge-root',
    'appdata-curseforge-root',
    'localappdata-curseforge-root',
    'root-owned-executable-ignored',
    'xbox-games-launcher',
    'extra-drive-xbox-games-launcher',
    'non-local-xbox-games-launcher',
    'windows-app-alias-ignored-store',
    'shortcut-before-ignored-app-alias',
    'store-only',
    'dedupe-curseforge',
    'curseforge-app-ignored-before-store',
    'curseforge-app-ignored-without-store',
    'shortcut-minecraft-launcher',
    'shortcut-minecraft-exe-launcher',
    'shortcut-curseforge-app-ignored',
    'missing-launcher',
    'macos-curseforge-app-path',
    'macos-library-curseforge-root',
    'macos-documents-lower-curseforge-root',
    'macos-curseforge-bundle-fallback',
    'macos-custom-app'
  ]
}, null, 2));
