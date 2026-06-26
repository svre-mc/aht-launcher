import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const windowsInstallerInclude = fs.readFileSync(new URL('../build/windows-installer.nsh', import.meta.url), 'utf8');
const rendererApp = fs.readFileSync(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
const desktopMain = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
const releaseWorkflow = fs.readFileSync(new URL('../.github/workflows/build-macos.yml', import.meta.url), 'utf8');

const configs = {
  windows: require('../build/electron-builder.windows.cjs'),
  macos: require('../build/electron-builder.macos.cjs')
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(configs.windows.productName === 'A Hard Time Launcher Windows', 'Windows product name is not tailored.');
assert(configs.windows.directories?.output === 'release-builds/windows', 'Windows output folder is wrong.');
assert(configs.windows.win?.artifactName?.includes('Windows-10-11'), 'Windows artifact name should target Windows 10/11.');
assert(configs.windows.win?.target?.[0]?.target === 'nsis', 'Windows regular launcher must build NSIS.');
assert(configs.windows.nsis?.oneClick === false, 'Windows installer must show installer options.');
assert(configs.windows.nsis?.createDesktopShortcut === true, 'Windows desktop shortcut should be checked by default.');
assert(configs.windows.nsis?.createStartMenuShortcut === true, 'Windows Start Menu shortcut should be enabled.');
assert(configs.windows.nsis?.include === 'build/windows-installer.nsh', 'Windows installer must include the shortcut options page.');
assert(windowsInstallerInclude.includes('Create a desktop shortcut'), 'Windows installer include must expose the desktop shortcut option.');
assert(!/CreateShortCut[\s\S]*--developer/.test(windowsInstallerInclude), 'Public Windows installer must not create private-mode shortcuts.');
assert(!windowsInstallerInclude.includes('"--developer"'), 'Public Windows installer must not expose private-mode args.');
assert(!rendererApp.includes('update.updateRequired && !status?.developerMode'), 'Developer mode must not suppress required launcher update overlay.');
assert(!rendererApp.includes('status.launcherUpdate?.updateRequired && !status.developerMode'), 'Developer mode must not bypass launcher update gating.');
assert(!desktopMain.includes('@312Princ'), 'Developer password must not be hardcoded in public source.');
assert(desktopMain.includes("launcherBuildMode() !== 'player'"), 'Player packaged builds must disable developer mode.');
assert(desktopMain.includes("import fsSync from 'node:fs';"), 'Launcher mode detection must import fsSync.');
assert(desktopMain.includes("app.setPath('userData', path.join(app.getPath('appData'), 'aht-launcher-developer'))"), 'Developer mode must use separate local app data.');
assert(desktopMain.includes("app.requestSingleInstanceLock({ mode: launchMode })"), 'Single-instance lock must be split by launch mode.');
assert(desktopMain.includes("legacyDeveloperSecretsPath()"), 'Developer mode must migrate existing local secrets from the old app data folder.');
assert(desktopMain.includes("migrateDeveloperEncryptionProfile()"), 'Developer mode must migrate the old Electron encryption profile before decrypting old secrets.');
assert(desktopMain.includes("saveDeveloperSecretField(next, secrets, 'launcherProofSecret')"), 'Developer secrets must not be wiped by empty password fields.');
assert(desktopMain.includes("openMacMinecraftLauncher(cwd, env)"), 'macOS play must use the macOS Minecraft Launcher opener.');
assert(desktopMain.includes("'/Applications/Minecraft.app'"), 'macOS opener must try the normal Minecraft.app path.');
assert(desktopMain.includes("['-a', 'Minecraft']"), 'macOS opener must fall back to the Minecraft app name.');
assert(desktopMain.includes('async function existingLaunchCwd'), 'Minecraft Launcher opener must sanitize missing configured cwd before spawning.');
assert(desktopMain.includes('const cwd = await existingLaunchCwd(requestedCwd);'), 'Minecraft Launcher opener must use a verified existing cwd.');
assert(desktopMain.includes('async function openWindowsStoreMinecraftLauncher(cwd, env)'), 'Windows Store Minecraft Launcher opener must be isolated.');
assert(desktopMain.includes("process.env.SystemRoot ? path.join(process.env.SystemRoot, 'explorer.exe')"), 'Windows Store opener must use absolute explorer.exe when available.');
assert(desktopMain.includes('return openWindowsStoreMinecraftLauncher(cwd, env);'), 'Windows play fallback must use the robust Store opener.');
assert(desktopMain.includes('function minecraftProfileInstallTargets(profile = null)'), 'Launcher must gather all synced Minecraft profile roots before installing loaders.');
assert(desktopMain.includes('profile.syncedProfiles'), 'Launcher must inspect synced Minecraft roots for missing loaders.');
assert(desktopMain.includes('installMinecraftProfileLoaders(profile'), 'Update and Play must install Forge into synced launcher roots.');
assert(desktopMain.includes('keepOpenUntil = Date.now() + 5 * 60_000;'), 'Play must keep the launcher open long enough for slow PCs to start Minecraft.');
assert(fs.readFileSync(new URL('../src/launcherProof.js', import.meta.url), 'utf8').includes('60 * 60 * 1000'), 'Launcher proof must last long enough for slow PCs to join.');
assert(fs.readFileSync(new URL('../src/forgeInstaller.js', import.meta.url), 'utf8').includes('options.versionWaitMs || 60000'), 'Forge install detection must wait long enough for slow PCs.');
assert(desktopMain.includes('javaCacheDir') || fs.readFileSync(new URL('../src/forgeInstaller.js', import.meta.url), 'utf8').includes('ensureManagedJava8Runtime'), 'Forge installer must have managed Java 8 fallback for stale jre-legacy certificates.');
assert(desktopMain.includes('{ skipLoaderCheck: true }'), 'Status and initial Play gate must allow Play to self-repair missing synced loaders.');
assert(!desktopMain.includes("if (profile.loaderId?.startsWith('forge-') && !profile.loaderInstalled)"), 'Forge install flow must not only check the primary Minecraft root.');
assert(!desktopMain.includes("spawnDetached('explorer.exe', ['shell:AppsFolder\\\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'], cwd, env)"), 'Windows Store fallback must not spawn plain explorer.exe directly.');
assert(rendererApp.includes('els.r2AccountIdInput.addEventListener("input", queueDeveloperSecretSave)'), 'R2 Account ID input must persist in developer mode.');

assert(configs.macos.productName === 'A Hard Time Launcher macOS', 'macOS product name is not tailored.');
assert(configs.macos.directories?.output === 'release-builds/macos', 'macOS output folder is wrong.');
assert(configs.macos.mac?.target?.[0]?.target === 'dmg', 'macOS regular launcher must build DMG.');
assert(configs.macos.mac?.target?.[0]?.arch?.includes('arm64'), 'macOS regular launcher should include Apple Silicon.');
assert(configs.macos.mac?.target?.[0]?.arch?.includes('x64'), 'macOS regular launcher should include Intel.');

assert(!fs.existsSync(new URL('../build/electron-builder.ubuntu.cjs', import.meta.url)), 'Ubuntu builder config must not exist.');
assert(!packageJson.scripts['dist:linux'], 'Linux package script must not exist.');
assert(!packageJson.scripts['dist:regular:ubuntu'], 'Ubuntu regular launcher script must not exist.');
assert(!packageJson.build?.linux, 'package.json must not define Linux build targets.');
assert(!releaseWorkflow.includes('id: ubuntu'), 'GitHub workflow must not include an Ubuntu/Linux build matrix entry.');
assert(!releaseWorkflow.includes('ubuntu-'), 'GitHub workflow must not use Ubuntu runners.');
assert(!releaseWorkflow.includes('dist:regular:ubuntu'), 'GitHub workflow must not call the Ubuntu build script.');
assert(!releaseWorkflow.includes('aht-launcher-ubuntu'), 'GitHub workflow must not upload Ubuntu launcher artifacts.');
assert(packageJson.scripts['dist:regular:windows']?.includes('--win'), 'Windows regular script must force --win.');
assert(packageJson.scripts['dist:regular:macos']?.includes('--mac'), 'macOS regular script must force --mac.');

for (const [name, config] of Object.entries(configs)) {
  assert(config.extraMetadata?.ahtLauncherMode === 'player', `${name} config should be regular/player mode.`);
  assert(config.files?.includes('pack-fixes/**/*'), `${name} config must include pack-fixes.`);
  assert(config.asarUnpack?.includes('pack-fixes/*.jar'), `${name} config must unpack pack-fix jars.`);
}

console.log(JSON.stringify({
  ok: true,
  targets: Object.fromEntries(Object.entries(configs).map(([name, config]) => [
    name,
    {
      productName: config.productName,
      output: config.directories.output,
      target: config.extraMetadata.ahtLauncherTarget
    }
  ]))
}, null, 2));
