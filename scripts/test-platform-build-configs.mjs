import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const commonBuilder = require('../build/electron-builder.common.cjs');
const windowsInstallerInclude = fs.readFileSync(new URL('../build/windows-installer.nsh', import.meta.url), 'utf8');
const rendererApp = fs.readFileSync(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
const preloadScript = fs.readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
const rendererHtml = fs.readFileSync(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');
const rendererCss = fs.readFileSync(new URL('../desktop/renderer/style.css', import.meta.url), 'utf8');
const desktopMain = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
const installerSource = fs.readFileSync(new URL('../src/installer.js', import.meta.url), 'utf8');
const localChangesSource = fs.readFileSync(new URL('../src/localChanges.js', import.meta.url), 'utf8');
const utilsSource = fs.readFileSync(new URL('../src/utils.js', import.meta.url), 'utf8');
const minecraftProfileSource = fs.readFileSync(new URL('../src/minecraftLauncherProfile.js', import.meta.url), 'utf8');
const minecraftServiceStatus = fs.readFileSync(new URL('../src/minecraftServiceStatus.js', import.meta.url), 'utf8');
const minecraftLauncherRoutesSource = fs.readFileSync(new URL('../src/minecraftLauncherRoutes.js', import.meta.url), 'utf8');
const socialClientSource = fs.readFileSync(new URL('../src/socialClient.js', import.meta.url), 'utf8');
const githubActionsSource = fs.readFileSync(new URL('../src/githubActions.js', import.meta.url), 'utf8');
const releaseWorkflow = fs.readFileSync(new URL('../.github/workflows/build-macos.yml', import.meta.url), 'utf8');
const launcherUpdateAutomationDoc = fs.readFileSync(new URL('../docs/launcher-update-automation.md', import.meta.url), 'utf8');
const macosDownloadPathsDoc = fs.readFileSync(new URL('../docs/macos-signing-and-download-paths.md', import.meta.url), 'utf8');
const verifyLocalScript = fs.readFileSync(new URL('../scripts/verify-local.mjs', import.meta.url), 'utf8');
const smokePlayerDefaults = fs.readFileSync(new URL('../scripts/smoke-player-defaults-feed.mjs', import.meta.url), 'utf8');
const playerPrivacySmoke = fs.readFileSync(new URL('../scripts/test-player-privacy.mjs', import.meta.url), 'utf8');
const smokePlayerLayout = fs.readFileSync(new URL('../scripts/smoke-player-layout.mjs', import.meta.url), 'utf8');
const friendsPanelSmoke = fs.readFileSync(new URL('../scripts/smoke-friends-panel.mjs', import.meta.url), 'utf8');
const smokePlayerUpdatePlay = fs.readFileSync(new URL('../scripts/smoke-player-update-play-flow.mjs', import.meta.url), 'utf8');
const smokePlayIntegrityGate = fs.readFileSync(new URL('../scripts/smoke-play-integrity-gate.mjs', import.meta.url), 'utf8');
const smokeLauncherSelfUpdate = fs.readFileSync(new URL('../scripts/smoke-launcher-self-update.mjs', import.meta.url), 'utf8');
const smokeRepairMissingManaged = fs.readFileSync(new URL('../scripts/smoke-repair-missing-managed-manifest.mjs', import.meta.url), 'utf8');
const developerInstanceDirSmoke = fs.readFileSync(new URL('../scripts/smoke-developer-instance-dir.mjs', import.meta.url), 'utf8');
const setupRecoverySmoke = fs.readFileSync(new URL('../scripts/smoke-setup-recovery-actions.mjs', import.meta.url), 'utf8');
const checkProductionReadiness = fs.readFileSync(new URL('../scripts/check-production-readiness.mjs', import.meta.url), 'utf8');
const prepareLauncherUpdateScript = fs.readFileSync(new URL('../scripts/prepare-launcher-update.mjs', import.meta.url), 'utf8');
const launcherUpdateManifestTest = fs.readFileSync(new URL('../scripts/test-launcher-update-manifest.mjs', import.meta.url), 'utf8');
const launcherUpdateManifestValidator = fs.readFileSync(new URL('../scripts/validate-launcher-update-manifest.mjs', import.meta.url), 'utf8');
const launcherUpdateManifestSource = fs.readFileSync(new URL('../src/launcherUpdateManifest.js', import.meta.url), 'utf8');
const workerTelemetryTest = fs.readFileSync(new URL('../scripts/test-worker-telemetry.mjs', import.meta.url), 'utf8');
const verifyInstalledScript = fs.readFileSync(new URL('../scripts/verify-installed-player.mjs', import.meta.url), 'utf8');
const packageScripts = packageJson.scripts || {};
const playerDefaultsStart = desktopMain.indexOf('function playerDefaultsForCloud');
const playerDefaultsEnd = desktopMain.indexOf('function playerDefaultsTargets');
const playerDefaultsFunction = playerDefaultsStart >= 0 && playerDefaultsEnd > playerDefaultsStart
  ? desktopMain.slice(playerDefaultsStart, playerDefaultsEnd)
  : '';

const configs = {
  windows: require('../build/electron-builder.windows.cjs'),
  macos: require('../build/electron-builder.macos.cjs')
};
const developerOnlySourceFiles = commonBuilder.developerOnlySourceFiles || [];
const developerOnlyNodeModules = commonBuilder.developerOnlyNodeModules || [];
const developerOnlyRuntimeDependencies = [
  '@aws-sdk/client-s3',
  '@aws-sdk/lib-storage',
  'ssh2',
  'yazl'
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function collectFiles(target, extensions) {
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) {
    return extensions.has(path.extname(target).toLowerCase()) ? [target] : [];
  }
  if (!stat.isDirectory()) return [];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    files.push(...collectFiles(path.join(target, entry.name), extensions));
  }
  return files;
}

function repoPath(...segments) {
  return path.resolve(new URL('..', import.meta.url).pathname, ...segments);
}

function scriptTargetExists(command) {
  const missing = [];
  for (const match of command.matchAll(/\bnode\s+((?:scripts|src)\/[^\s]+?\.(?:mjs|js))/g)) {
    const target = new URL(`../${match[1]}`, import.meta.url);
    if (!fs.existsSync(target)) {
      missing.push(match[1]);
    }
  }
  return missing;
}

function pngColorType(relativePath) {
  const bytes = fs.readFileSync(new URL(`../${relativePath}`, import.meta.url));
  return bytes[25];
}

function icoLayers(relativePath) {
  const bytes = fs.readFileSync(new URL(`../${relativePath}`, import.meta.url));
  const count = bytes.readUInt16LE(4);
  const layers = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + (index * 16);
    layers.push({
      width: bytes[offset] === 0 ? 256 : bytes[offset],
      height: bytes[offset + 1] === 0 ? 256 : bytes[offset + 1],
      bytes: bytes.readUInt32LE(offset + 8)
    });
  }
  return layers;
}

const sensitiveExtensions = new Set(['.cjs', '.html', '.js', '.json', '.md', '.mjs', '.toml', '.yml']);
const sensitiveRoots = ['desktop', 'src', 'config', 'docs', 'scripts', 'cloudflare', '.github'];
const sensitiveFiles = ['README.md', 'package.json'];

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
assert(preloadScript.includes("selectFolder: (defaultPath = '') => ipcRenderer.invoke('dialog:folder', defaultPath)"), 'Folder picker preload API must accept a starting folder path.');
assert(preloadScript.includes('function developerApiAllowed()') && preloadScript.includes("new URLSearchParams(window.location.search || '').get('mode') === 'developer'"), 'Preload developer APIs must be gated by the main-controlled developer window mode.');
assert(preloadScript.includes('const developerApi = {') && preloadScript.includes('if (developerApiAllowed())'), 'Preload must keep developer IPC methods out of the default player API.');
assert(desktopMain.includes("ipcMain.handle('dialog:folder', async (_event, defaultPath = '')") && desktopMain.includes('options.defaultPath = startingPath'), 'Native folder picker must pass the supplied starting path to Electron defaultPath.');
assert(desktopMain.includes("process.env.AHT_TEST_HOOKS === '1' && process.env.AHT_TEST_DIALOG_ECHO_DEFAULT_PATH === '1'"), 'Dialog test hook must require the explicit AHT_TEST_HOOKS gate.');
assert(desktopMain.includes('function configureTestRemoteDebugPort()') && desktopMain.includes("process.env.AHT_TEST_HOOKS !== '1'") && desktopMain.includes('AHT_TEST_REMOTE_DEBUG_PORT'), 'Packaged smoke remote-debug hook must be gated by AHT_TEST_HOOKS and an explicit port env var.');
assert(desktopMain.includes('function writeTestStartupProbe') && desktopMain.includes('AHT_TEST_STARTUP_PROBE_PATH'), 'Packaged startup diagnostics must be gated behind AHT_TEST_HOOKS and an explicit probe path.');
assert(smokePlayerUpdatePlay.includes('AHT_TEST_REMOTE_DEBUG_PORT: String(port)') && smokePlayerUpdatePlay.includes('AHT_TEST_STARTUP_PROBE_PATH: startupProbePath') && smokePlayerUpdatePlay.includes('? [`--user-data-dir=${userData}`]'), 'Installed player update/play smoke must use the gated main-process remote-debug hook and startup probe.');
assert(smokePlayerDefaults.includes('const minecraftRoot = path.join(root, \'.minecraft\')') && smokePlayerDefaults.includes('enabled: true') && smokePlayerDefaults.includes('rootDir: minecraftRoot'), 'Player defaults smoke must exercise enabled Minecraft Launcher profile integration against an isolated temp root.');
assert(smokePlayerLayout.includes('const minecraftRoot = path.join(root, \'.minecraft\')') && smokePlayerLayout.includes('enabled: true') && smokePlayerLayout.includes('minecraftProfileEnabledInput') && smokePlayerLayout.includes('Player layout did not render Minecraft profile integration as enabled'), 'Player layout smoke must visually prove Minecraft Launcher profile integration is enabled.');
const verifyInstalledPlayer = fs.readFileSync(new URL('../scripts/verify-installed-player.mjs', import.meta.url), 'utf8');
for (const installedPlayerCheck of [
  'test:player-defaults',
  'test:player-privacy',
  'test:player-layout',
  'test:settings-profile',
  'test:setup-recovery',
  'test:error-details-copy',
  'test:account-duplicate',
  'test:account-switch',
  'test:update-logs',
  'test:single-instance',
  'test:play-gate',
  'test:repair-missing-managed',
  'test:play-missing-launcher',
  'test:play-missing-custom',
  'test:play-java-setup',
  'test:play-service-outage',
  'test:play-curseforge-priority',
  'test:play-curseforge-fallback',
  'test:play-curseforge-auth-import',
  'test:play-localappdata-launcher',
  'test:play-shortcut-launcher',
  'test:play-generic-shortcut-launcher',
  'test:play-custom-fallback',
  'test:play-store-fallback',
  'test:player-update-play',
  'test:launcher-self-update'
]) {
  assert(verifyInstalledPlayer.includes(`['${installedPlayerCheck}']`), `Installed player verifier must include ${installedPlayerCheck}.`);
}

assert(rendererApp.includes('window.aht.selectFolder(els.instanceInput.value.trim() || currentStatus?.config?.instanceDir || "")'), 'Modpack Folder Browse must open at the folder path currently listed in Game Settings.');
assert(!rendererApp.includes('els.pickInstanceButton.addEventListener("click", async () => {\n    const folder = await window.aht.selectFolder();'), 'Modpack Folder Browse must not call selectFolder without a default path.');
assert(!rendererApp.includes('Config error'), 'Renderer must not show the technical Config error label in player or developer UI.');
assert(!rendererApp.includes('packageTarget') && !rendererApp.includes('build - ${platformProfile'), 'Renderer settings subtitle must not expose package/build target jargon in the player UI.');
assert(!rendererApp.includes('server owner') && !desktopMain.includes('server owner'), 'Player-facing update/feed messages must not use internal server-owner wording.');
assert(rendererApp.includes('"Verified AHT package ready."') && rendererApp.includes('status.developerMode') && rendererApp.includes('currentStatus?.developerMode'), 'Renderer must show simple verified-package feed wording to players while keeping release-source diagnostics in developer mode.');
assert(rendererApp.includes('els.sideInstalledVersion.textContent = installedLabel'), 'Sidebar pack tile must show the same v.x installed-version label as the main hero.');
assert(rendererHtml.includes('id="launcherVersionLabel"') && rendererApp.includes('els.launcherVersionLabel.textContent = launcherVersion'), 'Regular launcher sidebar must show the running launcher app version.');
assert(preloadScript.includes("restartLauncherUpdate: () => ipcRenderer.invoke('launcher:updateRestart')") && (desktopMain.includes("ipcMain.handle('launcher:updateRestart', async () => restartLauncherUpdate())") || desktopMain.includes("ipcMain.handle('launcher:updateRestart', diagnosticIpc('launcher:updateRestart'")), 'Launcher self-update must expose a separate explicit restart IPC.');
assert(rendererApp.includes('Ready to Install') && rendererApp.includes('Install and Restart') && rendererApp.includes('restartLauncherSelfUpdate'), 'Launcher self-update UI must stage the update and require an explicit install/restart button.');
assert(desktopMain.includes('pending-launcher-update.json') && desktopMain.includes('pending-launcher-update.failed') && desktopMain.includes('shouldExitForPendingLauncherInstall') && desktopMain.includes('launcher-update-install-pending-exit'), 'Launcher self-update must persist handoff state, recover helper failures, and close old copies that reopen while the installer is running.');
assert(!desktopMain.includes('keepOpenUntil') && !desktopMain.includes("mainWindow.on('close', (event)") && !desktopMain.includes('event.preventDefault();\n      focusMainWindow();'), 'Normal play/update operations must not trap the launcher window open with a timed close guard.');
assert(desktopMain.includes('waitForLauncherUpdateHelperStart') && desktopMain.includes('Launcher update helper did not start') && desktopMain.includes('AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY'), 'Launcher restart must verify the handoff helper starts before quitting.');
assert(desktopMain.includes('requiresTestConfirmation') && desktopMain.includes("text.includes('Test mode helper startup confirmed.') || (!requiresTestConfirmation && text.includes('Waiting for old launcher PID'))"), 'Launcher self-update test mode must wait for the helper startup confirmation, not only the first waiting log line.');
assert(desktopMain.includes('testHelperStartOnly: process.env.AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY ===') && desktopMain.includes('$payload.testHelperStartOnly -eq $true') && desktopMain.includes('test_helper_start_only=${payload.testHelperStartOnly'), 'Launcher restart helper test mode must be carried in payload JSON, not only inherited environment.');
assert(desktopMain.includes('function windowsLauncherInstallerArgs') && desktopMain.includes('`/D=${targetDir}`'), 'Windows launcher self-update must install into the current launcher directory.');
assert(smokeLauncherSelfUpdate.includes('launcher-update-install-pending-exit') && smokeLauncherSelfUpdate.includes('reopened old launcher did not exit during pending install'), 'Launcher self-update smoke must prove reopened old copies exit during an installing handoff.');
assert(!desktopMain.includes('/usr/bin/open "$zip_path"'), 'macOS self-update helper must not open the update ZIP on failure.');
assert(desktopMain.includes('function macAppPathLooksTransient') && desktopMain.includes("normalized.startsWith('/volumes/')") && desktopMain.includes("normalized.includes('/apptranslocation/')"), 'macOS launcher update must detect DMG/App Translocation paths.');
assert(desktopMain.includes("path.join(app.getPath('home'), 'Applications'") && desktopMain.includes('fallback_app') && desktopMain.includes('Primary install target failed'), 'macOS launcher update must fall back to the user Applications folder when app replacement fails.');
const gameTileButtonStart = rendererHtml.indexOf('id="gameTileButton"');
const gameTileButtonEnd = rendererHtml.indexOf('coming-soon', gameTileButtonStart);
const gameTileButtonHtml = gameTileButtonStart >= 0 && gameTileButtonEnd > gameTileButtonStart
  ? rendererHtml.slice(gameTileButtonStart, gameTileButtonEnd)
  : '';
assert(gameTileButtonHtml.includes('sidebar-version-dot') && !gameTileButtonHtml.includes('icon-download'), 'Sidebar installed-version label must use a neutral status dot, not a download icon.');
assert(!rendererApp.includes('Launch locked'), 'Renderer must use specific player-facing status labels instead of the vague Launch locked badge.');
assert(!rendererApp.includes('"Launch is locked."') && rendererApp.includes('"Launch Minecraft"'), 'Play button tooltip must stay direct and the backend must own setup failure details.');
assert(rendererApp.includes('function launchBlockedBadge') && rendererApp.includes('function setLaunchStatusBadge'), 'Renderer must classify non-ready launch states into specific player-facing badge labels.');
assert(rendererApp.includes('developerMode: bootDeveloperMode,'), 'Renderer fallback mock must not boot as developer mode by default.');
assert(rendererApp.includes('delete mockStatus.config.developer') && rendererApp.includes('delete mockStatus.serverTransfer'), 'Renderer fallback mock must strip private developer/server-transfer config outside developer preview mode.');
assert(rendererApp.includes('key.startsWith("dev")') && rendererApp.includes('delete window.aht[key]'), 'Renderer fallback mock must not expose developer APIs outside developer preview mode.');
assert(!rendererHtml.includes('Launcher Log') && !rendererHtml.includes('id="activityPanel"') && !rendererHtml.includes('id="instanceDir"'), 'Regular launcher must not ship the stale Instance/Launcher Log panel.');
assert(rendererApp.includes('function logIsEmpty()') && rendererApp.includes('if (!els.activityPanel) return;'), 'Renderer must tolerate the removed stale activity panel.');
assert(rendererApp.includes('function playerSafeErrorMessage') && rendererApp.includes('const message = playerSafeErrorMessage(error);'), 'Renderer must sanitize player-facing launch/feed errors before showing logs or toasts.');
assert(!rendererApp.includes('setLog(status.launchBlockedReason || "Launch is locked until setup is complete.")'), 'Renderer must not write raw launchBlockedReason for normal player lock messages.');
assert(!rendererApp.includes('update.updateRequired && !status?.developerMode'), 'Developer mode must not suppress required launcher update overlay.');
assert(!rendererApp.includes('status.launcherUpdate?.updateRequired && !status.developerMode'), 'Developer mode must not bypass launcher update gating.');
assert(rendererHtml.includes('id="profileFriendsButton"') && rendererHtml.includes('aria-controls="friendsOverlay"') && rendererHtml.includes('id="friendsOverlay"') && rendererHtml.includes('id="friendsList"') && rendererHtml.includes('id="blockedList"'), 'Top-right profile card must open the launcher friends panel.');
assert(/id="profileFriendsButton"[^>]*hidden/.test(rendererHtml) && rendererApp.includes('els.profileFriendsButton.hidden = false'), 'Profile/friends card must stay hidden until real status replaces placeholder Player/Sync text.');
assert(rendererHtml.includes('>Repair</button>') && !rendererHtml.includes('>Scan files</button>'), 'Player quick action must be labeled Repair, not Scan files.');
assert(rendererHtml.includes('id="setupOpenMinecraftButton"') && rendererHtml.includes('id="setupDownloadMinecraftButton"') && rendererHtml.includes('id="setupJavaHelpButton"'), 'Setup assistant must expose actionable recovery buttons for launcher/sign-in/Java setup.');
assert(preloadScript.includes("setupAction: (action) => ipcRenderer.invoke('setup:action', action)") && desktopMain.includes("ipcMain.handle('setup:action'"), 'Setup recovery buttons must route through main-process IPC.');
assert(desktopMain.includes("download-minecraft-launcher") && desktopMain.includes("open-minecraft-launcher") && desktopMain.includes("open-java-help"), 'Setup action handler must support Minecraft Launcher download/open and Java help actions.');
assert(desktopMain.includes("process.env.AHT_TEST_HOOKS !== '1'") && desktopMain.includes('AHT_TEST_OPEN_EXTERNAL_CAPTURE_PATH') && desktopMain.includes('AHT_TEST_SETUP_JAVA_MODE'), 'Setup action test hooks must require the broad AHT_TEST_HOOKS gate.');
assert(desktopMain.includes('AHT_TEST_LOCAL_INSTANCE_DIR') && desktopMain.includes("process.env.AHT_TEST_HOOKS === '1'"), 'Local instance test candidate must require the broad AHT_TEST_HOOKS gate.');
assert(desktopMain.includes('function localUserHomePath()') && desktopMain.includes('function localDocumentsPath()') && desktopMain.includes('const home = localUserHomePath();') && desktopMain.includes('const documents = localDocumentsPath();'), 'Local path detection smokes must not leak the real host home/Documents paths when AHT_TEST_HOOKS is active.');
assert(packageScripts['test:setup-recovery'] === 'node scripts/smoke-setup-recovery-actions.mjs' && verifyLocalScript.includes("['test:setup-recovery']"), 'Setup recovery smoke must be wired into local verification.');
assert(desktopMain.includes('const installPresence = instanceExists') && desktopMain.includes('instanceHasPack: Boolean(installPresence.filesPresent)') && rendererApp.includes('const instanceEmpty = hasInstance && setup.instanceExists === true && setup.instanceHasPack === false') && rendererApp.includes('Install folder: ${instanceMissing ? "missing" : (instanceEmpty ? "empty" : "ready")}'), 'Setup assistant must distinguish an empty created install folder from a pack-shaped installed modpack.');
assert(desktopMain.includes('async function firstPackShapedInstanceDir') && desktopMain.includes('const recommendedInstanceDir = current.instanceDir || defaultInstanceDir();') && desktopMain.includes('const instanceDir = setup.recommendedInstanceDir || defaultInstanceDir();') && setupRecoverySmoke.includes('old detected instance'), 'Auto setup must preserve the configured managed AHT install folder instead of adopting an old CurseForge-style detected instance or forcing the platform default.');
assert(desktopMain.includes('function oldUserDataInstancesRoot()') && !desktopMain.includes("path.join(app.getPath('userData'), 'instances', 'RLCraft Dregora')"), 'Old app-data instance migration must not hardcode the stale RLCraft Dregora instance name.');
assert(/function defaultCacheModsDir\(\)\s*\{\s*return '';\s*\}/.test(desktopMain) && desktopMain.includes('const detectedInstanceDir = await firstPackShapedInstanceDir(localInstanceCandidates());'), 'Developer cache mods must default empty and only use detected local pack paths when they actually exist.');
assert(desktopMain.includes('async function recoverDamagedConfig') && desktopMain.includes('damagedConfigBackupPath') && desktopMain.includes('Recovered damaged launcher config') && setupRecoverySmoke.includes('launcher\\.config\\.json\\.corrupt-') && setupRecoverySmoke.includes('Damaged launcher config was not backed up'), 'Damaged launcher.config.json must be backed up and recovered from defaults instead of breaking startup/status.');
assert(setupRecoverySmoke.includes("AHT_TEST_USER_DATA: userData"), 'Setup recovery smoke must write damaged launcher.config.json into the same app userData path used by Electron.');
assert(verifyLocalScript.includes('function npmRunSpawnArgs') && verifyLocalScript.includes("npmExecPath.endsWith('.js')") && verifyLocalScript.includes('shell: false'), 'Local verifier should avoid shell-based npm spawning when npm exposes its JS CLI.');
assert(verifyInstalledScript.includes('function npmRunSpawnArgs') && verifyInstalledScript.includes("npmExecPath.endsWith('.js')") && verifyInstalledScript.includes('shell: false'), 'Installed-player verifier should avoid shell-based npm spawning when npm exposes its JS CLI.');
assert(verifyLocalScript.includes('function verifierEnvironment') && verifyLocalScript.includes('path.dirname(process.execPath)') && verifyLocalScript.includes('env: verifierEnvironment({'), 'Local verifier must prepend the active Node directory to subprocess PATH.');
assert(verifyInstalledScript.includes('function verifierEnvironment') && verifyInstalledScript.includes('path.dirname(process.execPath)') && verifyInstalledScript.includes('env: verifierEnvironment({'), 'Installed-player verifier must prepend the active Node directory to subprocess PATH.');
assert(verifyLocalScript.includes('verify-local-latest.log') && verifyLocalScript.includes('AHT_VERIFY_CHECK_TIMEOUT_MS') && verifyLocalScript.includes('function killProcessTree') && verifyLocalScript.includes("child.on('close'"), 'Local verifier must write a durable latest log and kill/report hung child checks.');
assert(verifyInstalledScript.includes('verify-installed-player-latest.log') && verifyInstalledScript.includes('AHT_VERIFY_CHECK_TIMEOUT_MS') && verifyInstalledScript.includes('function killProcessTree') && verifyInstalledScript.includes("child.on('close'"), 'Installed-player verifier must write a durable latest log and kill/report hung child checks.');
assert(checkProductionReadiness.includes('function commandSpawnArgs') && checkProductionReadiness.includes('npx-cli.js') && checkProductionReadiness.includes('spawnCommandSync'), 'Production readiness checker should avoid shell-based npm/npx spawning when npm exposes JS CLIs.');
assert(checkProductionReadiness.includes('function commandEnvironment') && checkProductionReadiness.includes('path.dirname(process.execPath)') && checkProductionReadiness.includes('env: commandEnvironment()'), 'Production readiness checker must prepend the active Node directory to subprocess PATH so Wrangler does not fail when Codex Node is bundled.');
assert(rendererApp.includes('Microsoft account: checked after install') && setupRecoverySmoke.includes('Missing-launcher setup should not claim Microsoft account readiness'), 'Missing Minecraft Launcher setup must not claim the Microsoft account is already saved.');
assert(desktopMain.includes('minecraftAccountProfileKnown: Boolean(detectedMinecraftAuth.profileKnown)') && desktopMain.includes('minecraftAccountCredentialOnly: Boolean(detectedMinecraftAuth.credentialOnly)') && rendererApp.includes('Microsoft account: open Minecraft once') && setupRecoverySmoke.includes('credential-only setup state'), 'Setup assistant must distinguish credential-only Minecraft auth from a known saved profile.');
assert(preloadScript.includes("copyErrorReport: (payload) => ipcRenderer.invoke('diagnostics:copyErrorReport'") && desktopMain.includes("ipcMain.handle('diagnostics:copyErrorReport'"), 'Error detail copy must route through preload and main-process diagnostics IPC.');
assert(desktopMain.includes('AHT_TEST_ERROR_REPORT_CAPTURE_PATH') && desktopMain.includes("process.env.AHT_TEST_HOOKS !== '1'"), 'Error report capture hook must be gated behind AHT_TEST_HOOKS.');
assert(!desktopMain.includes('developerModeEnabled()'), 'Error diagnostics must not call the removed developerModeEnabled helper.');
assert(desktopMain.includes('function minecraftRuntimeDiagnostic') && desktopMain.includes('launcherLogTail') && desktopMain.includes('executableCandidates') && desktopMain.includes('assetIndexFound'), 'Error diagnostics must include Minecraft runtime root/profile/executable/assets/log health.');
assert(desktopMain.includes('const discovered = await windowsDiscoveredLauncherPaths(process.env);') && desktopMain.includes('windowsMinecraftLauncherExecutableCandidates(rootDir, process.env, discovered.minecraftLauncherPaths)') && desktopMain.includes('source: candidate.source ||'), 'Minecraft runtime diagnostics must use the same shortcut-discovered Minecraft Launcher candidates as Play and include each candidate source.');
assert(desktopMain.includes('message: route.message ||'), 'Minecraft route diagnostics must preserve route-planning failure messages.');
assert(rendererApp.includes('Copy full error details') && rendererApp.includes('copyErrorReportFromToast'), 'Error toasts must expose a clickable full-detail copy action.');
assert(rendererApp.includes('type === "error" || options.enableDiagnostics') && rendererApp.includes('{ context: "play-start", enableDiagnostics: true }'), 'Play setup/service failure toasts must stay clickable for full diagnostics even when they are warning-styled.');
assert(!rendererApp.includes('setUnavailable(els.playButton, launcherUpdateRequired || !status.launchReady') && !rendererApp.includes('setUnavailable(els.playButton, !currentStatus.launchReady'), 'Renderer must not silently disable Play from launchReady; Play IPC owns the real launch/setup failure.');
assert(packageScripts['test:error-details-copy'] === 'node scripts/smoke-error-details-copy.mjs' && verifyLocalScript.includes("['test:error-details-copy']"), 'Error-details copy smoke must be wired into local verification.');
const errorDetailsCopySmoke = fs.readFileSync(new URL('../scripts/smoke-error-details-copy.mjs', import.meta.url), 'utf8');
assert(errorDetailsCopySmoke.includes('AHT_TEST_ERROR_REPORT_CAPTURE_PATH') && errorDetailsCopySmoke.includes('Copy full error details') && errorDetailsCopySmoke.includes('diagnostic-smoke') && errorDetailsCopySmoke.includes('minecraftRuntime') && errorDetailsCopySmoke.includes('plannedRoutes') && desktopMain.includes('plannedMinecraftLauncherRouteDiagnostics'), 'Error-details copy smoke must prove the clickable copy action writes the full diagnostic report, including the Minecraft Launcher route plan.');
assert(errorDetailsCopySmoke.includes("startUpdate(false)") && errorDetailsCopySmoke.includes("'Update failed'") && errorDetailsCopySmoke.includes('updateReport.operations?.update') && errorDetailsCopySmoke.includes('Reading release feed from 127'), 'Error-details copy smoke must prove real update failure toasts copy operation diagnostics.');
assert(packageScripts['test:repair-missing-managed'] === 'node scripts/smoke-repair-missing-managed-manifest.mjs' && verifyLocalScript.includes("['test:repair-missing-managed']") && verifyInstalledScript.includes("['test:repair-missing-managed']"), 'Missing managed-manifest repair smoke must be wired into source and installed-player verification.');
assert(rendererApp.includes('function repairUnavailableDetail') && rendererApp.includes('Click Update to install the latest pack') && rendererApp.includes('point Modpack folder at the existing AHT install'), 'Repair unavailable must tell players the configured install folder is empty and what to do next.');
assert(smokeRepairMissingManaged.includes('Empty install folder with a valid latest release should be repairable') && smokeRepairMissingManaged.includes('empty install clean repair prompt') && smokeRepairMissingManaged.includes('detectedMismatchBeforeInstall'), 'Missing managed-manifest smoke must prove empty selected folders can clean-repair from latest even when another install is detected.');
assert(smokeRepairMissingManaged.includes('repairInstallFromLatest') && smokeRepairMissingManaged.includes('clean copy of the latest pack') && smokeRepairMissingManaged.includes('selected modpack folder'), 'Missing managed-manifest smoke must prove Repair can clean-install from the latest release when no existing install is detected.');
assert(smokeRepairMissingManaged.includes("'mods', 'OpenTerrainGenerator'") && smokeRepairMissingManaged.includes("'config', 'stale-client.cfg'") && smokeRepairMissingManaged.includes("'resourcepacks', 'stale-pack.zip'") && !smokeRepairMissingManaged.includes("await writeJson(path.join(instanceDir, '.aht-launcher', 'managed-files.json'"), 'Missing managed-manifest smoke must simulate a pack-shaped install without initially writing managed-files.json.');
assert(localChangesSource.includes('managedManifestError') && localChangesSource.includes('Installed file manifest is damaged') && rendererApp.includes('scan?.managedManifestError') && smokeRepairMissingManaged.includes('Damaged managed manifest should still report a repairable installed pack'), 'Damaged managed-files.json must stay repairable instead of throwing raw JSON errors or telling installed players to install first.');
assert(desktopMain.includes('async function readInstalledPackState') && desktopMain.includes('installedManifestError') && rendererApp.includes('scan?.installedManifestError') && smokePlayIntegrityGate.includes('Damaged installed manifest did not become a repair-required status') && smokePlayIntegrityGate.includes('repair prompt for damaged installed manifest'), 'Damaged installed.json must become a repair-required state in status, Play, and Repair UI instead of making installed packs look missing.');
assert(smokeRepairMissingManaged.includes('Repair UI still told an installed pack to install first') && smokeRepairMissingManaged.includes('#repairPromptOverlay') && smokeRepairMissingManaged.includes('repairable'), 'Missing managed-manifest smoke must fail on the old Repair unavailable behavior and require the repair prompt.');
assert(smokeRepairMissingManaged.includes("document.querySelector('#repairPromptRepairButton').click()") && smokeRepairMissingManaged.includes('Repair did not write the expected managed file manifest') && smokeRepairMissingManaged.includes('Repair left stale pack files'), 'Missing managed-manifest smoke must click Repair and prove the full-client repair rewrites managed files.');
assert(packageScripts['test:play-missing-launcher'] === 'node scripts/smoke-play-missing-launcher.mjs' && verifyLocalScript.includes("['test:play-missing-launcher']") && verifyInstalledScript.includes("['test:play-missing-launcher']"), 'Missing Minecraft Launcher Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-missing-custom'] === 'node scripts/smoke-play-missing-launcher.mjs --missing-custom' && verifyLocalScript.includes("['test:play-missing-custom']") && verifyInstalledScript.includes("['test:play-missing-custom']"), 'Stale custom launcher missing-Minecraft smoke must be wired into local and installed-player verification.');
const playMissingLauncherSmoke = fs.readFileSync(new URL('../scripts/smoke-play-missing-launcher.mjs', import.meta.url), 'utf8');
assert(playMissingLauncherSmoke.includes('AHT_TEST_OPEN_EXTERNAL_CAPTURE_PATH') && playMissingLauncherSmoke.includes('Minecraft Launcher is not installed') && playMissingLauncherSmoke.includes('official Minecraft Launcher download page') && playMissingLauncherSmoke.includes('ENOENT') && playMissingLauncherSmoke.includes('--missing-custom') && playMissingLauncherSmoke.includes('Stale custom launcher config should be rendered as a normal missing Minecraft Launcher state'), 'Missing Minecraft Launcher Play smoke must prove setup wording, stale custom config handling, and block low-level spawn errors.');
assert(packageScripts['test:play-java-setup'] === 'node scripts/smoke-play-java-setup.mjs' && verifyLocalScript.includes("['test:play-java-setup']"), 'Missing Java Play smoke must be wired into local verification.');
const playJavaSetupSmoke = fs.readFileSync(new URL('../scripts/smoke-play-java-setup.mjs', import.meta.url), 'utf8');
assert(playJavaSetupSmoke.includes('missingJavaPath') && playJavaSetupSmoke.includes('AHT_JAVA8_DOWNLOAD_URL') && playJavaSetupSmoke.includes('managed Java 8 runtime') && playJavaSetupSmoke.includes('Install Eclipse Temurin JDK 8') && playJavaSetupSmoke.includes('Copy full error details') && playJavaSetupSmoke.includes('AHT_TEST_ERROR_REPORT_CAPTURE_PATH') && playJavaSetupSmoke.includes('AHT_TEST_SPAWN_DETACHED_CAPTURE_PATH') && playJavaSetupSmoke.includes('Minecraft Launcher was opened even though Forge Java setup failed'), 'Missing Java Play smoke must prove managed-Java setup wording, clickable diagnostics, no launcher spawn, and block low-level spawn errors.');
assert(packageScripts['test:play-service-outage'] === 'node scripts/smoke-play-service-outage.mjs' && verifyLocalScript.includes("['test:play-service-outage']"), 'Minecraft service outage Play smoke must be wired into local verification.');
const playServiceOutageSmoke = fs.readFileSync(new URL('../scripts/smoke-play-service-outage.mjs', import.meta.url), 'utf8');
assert(playServiceOutageSmoke.includes('/assets/1.12.json') && playServiceOutageSmoke.includes('Minecraft service unavailable') && playServiceOutageSmoke.includes('instead of opening Minecraft into REQUEST_FAILED') && playServiceOutageSmoke.includes('AHT_TEST_SPAWN_DETACHED_CAPTURE_PATH') && playServiceOutageSmoke.includes('Minecraft Launcher was opened even though asset preparation detected service outage') && playServiceOutageSmoke.includes('Copy full error details'), 'Minecraft service outage Play smoke must prove Play detects asset-service failure, shows friendly service wording, exposes diagnostics, and does not open Minecraft into REQUEST_FAILED.');
assert(desktopMain.includes('AHT_TEST_MINECRAFT_ASSET_BASE_URL') && desktopMain.includes("process.env.AHT_TEST_HOOKS !== '1'"), 'Minecraft asset object test hook must require the broad AHT_TEST_HOOKS gate.');
assert(packageScripts['test:play-asset-repair'] === 'node scripts/smoke-play-asset-repair.mjs' && verifyLocalScript.includes("['test:play-asset-repair']"), 'Minecraft asset repair Play smoke must be wired into local verification.');
const playAssetRepairSmoke = fs.readFileSync(new URL('../scripts/smoke-play-asset-repair.mjs', import.meta.url), 'utf8');
assert(playAssetRepairSmoke.includes('AHT_TEST_MINECRAFT_ASSET_BASE_URL') && playAssetRepairSmoke.includes('asset-objects') && playAssetRepairSmoke.includes('assetObjectRequestCount !== 2') && playAssetRepairSmoke.includes('Play did not fully repair and verify the Minecraft asset object before launch') && playAssetRepairSmoke.includes('AHT_TEST_SPAWN_DETACHED_CAPTURE_PATH') && playAssetRepairSmoke.includes("['--workDir', mcRoot]") && playAssetRepairSmoke.includes('desktopMinecraftLauncher') && !playAssetRepairSmoke.includes('root-owned Minecraft Launcher executable') && playAssetRepairSmoke.includes('windowsHide === true') && playAssetRepairSmoke.includes('DISABLE_RTSS_LAYER'), 'Minecraft asset Play smoke must prove Play repairs and verifies missing/corrupt asset objects before opening a real Minecraft Launcher visibly with --workDir.');
assert(packageScripts['test:play-curseforge-priority'] === 'node scripts/smoke-play-curseforge-priority.mjs' && verifyLocalScript.includes("['test:play-curseforge-priority']") && verifyInstalledScript.includes("['test:play-curseforge-priority']"), 'CurseForge-first Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-curseforge-fallback'] === 'node scripts/smoke-play-curseforge-priority.mjs --fallback' && verifyLocalScript.includes("['test:play-curseforge-fallback']") && verifyInstalledScript.includes("['test:play-curseforge-fallback']"), 'CurseForge fallback Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-curseforge-auth-import'] === 'node scripts/smoke-play-curseforge-priority.mjs --curseforge-auth-import' && verifyLocalScript.includes("['test:play-curseforge-auth-import']") && verifyInstalledScript.includes("['test:play-curseforge-auth-import']"), 'CurseForge account import Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-localappdata-launcher'] === 'node scripts/smoke-play-curseforge-priority.mjs --localappdata-launcher' && verifyLocalScript.includes("['test:play-localappdata-launcher']") && verifyInstalledScript.includes("['test:play-localappdata-launcher']"), 'Per-user LocalAppData Minecraft Launcher Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-shortcut-launcher'] === 'node scripts/smoke-play-curseforge-priority.mjs --shortcut-launcher' && verifyLocalScript.includes("['test:play-shortcut-launcher']") && verifyInstalledScript.includes("['test:play-shortcut-launcher']"), 'Start Menu shortcut Minecraft Launcher Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-generic-shortcut-launcher'] === 'node scripts/smoke-play-curseforge-priority.mjs --generic-shortcut-launcher' && verifyLocalScript.includes("['test:play-generic-shortcut-launcher']") && verifyInstalledScript.includes("['test:play-generic-shortcut-launcher']"), 'Generic-name Start Menu shortcut Minecraft Launcher Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-custom-fallback'] === 'node scripts/smoke-play-curseforge-priority.mjs --custom-fallback' && verifyLocalScript.includes("['test:play-custom-fallback']") && verifyInstalledScript.includes("['test:play-custom-fallback']"), 'Custom-command fallback Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-desktop-start-retry'] === 'node scripts/smoke-play-curseforge-priority.mjs --desktop-start-retry' && verifyLocalScript.includes("['test:play-desktop-start-retry']") && verifyInstalledScript.includes("['test:play-desktop-start-retry']"), 'Windows desktop executable start-retry Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-app-alias-ignored'] === 'node scripts/smoke-play-curseforge-priority.mjs --no-desktop --app-alias-ignored' && verifyLocalScript.includes("['test:play-app-alias-ignored']") && verifyInstalledScript.includes("['test:play-app-alias-ignored']"), 'Windows app-alias ignored Store fallback Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-store-fallback'] === 'node scripts/smoke-play-curseforge-priority.mjs --no-desktop --store-fallback' && verifyLocalScript.includes("['test:play-store-fallback']") && verifyInstalledScript.includes("['test:play-store-fallback']"), 'Store fallback Play smoke must be wired into local and installed-player verification.');
assert(packageScripts['test:play-store-no-process'] === 'node scripts/smoke-play-curseforge-priority.mjs --no-desktop --store-no-process' && verifyLocalScript.includes("['test:play-store-no-process']") && verifyInstalledScript.includes("['test:play-store-no-process']"), 'Store fallback no-process Play smoke must be wired into local and installed-player verification.');
const playCurseForgePrioritySmoke = fs.readFileSync(new URL('../scripts/smoke-play-curseforge-priority.mjs', import.meta.url), 'utf8');
assert(packageScripts['test:minecraft-launcher-routes'] === 'node scripts/test-minecraft-launcher-routes.mjs' && verifyLocalScript.includes("['test:minecraft-launcher-routes']"), 'Pure Minecraft Launcher route planner test must be wired into local verification.');
const minecraftLauncherRoutesTest = fs.readFileSync(new URL('../scripts/test-minecraft-launcher-routes.mjs', import.meta.url), 'utf8');
assert(desktopMain.includes('function minecraftLauncherRouteSummary') && desktopMain.includes('minecraftLauncherRouteKinds') && playerPrivacySmoke.includes('minecraftLauncherRouteKinds'), 'Regular player status must expose a safe route summary without raw launcher paths.');
assert(!desktopMain.includes('customMinecraftLauncherRoute') && !desktopMain.includes('customMinecraftLauncherRouteIsAvailable') && !desktopMain.includes('minecraftLauncherOpenRoutes') && !desktopMain.includes('config.minecraftLauncher?.openCommand') && !desktopMain.includes('missing-custom'), 'Regular player Play/status must ignore stale custom launcher commands and use only platform Minecraft Launcher routes.');
assert(desktopMain.includes('planWindowsMinecraftLauncherRoutes({') && desktopMain.includes('readWindowsLauncherShortcutTargets') && desktopMain.includes('shell.readShortcutLink') && desktopMain.includes('windowsDiscoveredLauncherPaths') && desktopMain.includes('OneDriveConsumer') && !desktopMain.includes("lowerName.includes('minecraft')") && desktopMain.includes('isWindowsMinecraftLauncherExecutablePath(target)') && desktopMain.includes('const identity = await identityPayload(launcherConfig);') && !desktopMain.includes('function addWindowsLauncherRoute') && !desktopMain.includes('curseForgeAppPaths') && !desktopMain.includes("targetName === 'curseforge.exe'") && minecraftLauncherRoutesSource.includes('export async function planWindowsMinecraftLauncherRoutes') && minecraftLauncherRoutesSource.includes('export function isWindowsMinecraftLauncherExecutablePath') && minecraftLauncherRoutesSource.includes('minecraftLauncherPaths = []') && !minecraftLauncherRoutesSource.includes("kind: 'curseforge-app'") && !minecraftLauncherRoutesSource.includes("kind: 'root'") && !minecraftLauncherRoutesSource.includes('root-owned') && minecraftLauncherRoutesSource.includes("'curseforge'") && minecraftLauncherRoutesSource.includes("kind: 'desktop'") && minecraftLauncherRoutesSource.includes("kind: 'store'") && minecraftLauncherRoutesTest.includes('curseforge-desktop-store') && minecraftLauncherRoutesTest.includes('curseforge-app-ignored-before-store') && minecraftLauncherRoutesTest.includes('shortcut-minecraft-launcher') && minecraftLauncherRoutesTest.includes('shortcut-minecraft-exe-launcher') && minecraftLauncherRoutesTest.includes('shortcut-curseforge-app-ignored') && minecraftLauncherRoutesTest.includes('curseforge-app-ignored-without-store') && minecraftLauncherRoutesTest.includes('root-owned-executable-ignored') && minecraftLauncherRoutesTest.includes('shortcutBadMinecraftExe') && minecraftLauncherRoutesTest.includes('missing-launcher') && minecraftLauncherRoutesTest.includes("assert.notEqual(planned[0].command, path.win32.join(curseForgeRoot, 'minecraft.exe'))") && playCurseForgePrioritySmoke.includes("const expectedOpenState = (expectStoreFallback || expectAppAliasIgnored || expectStoreNoProcess) ? 'store-fallback' : 'preferred'") && playCurseForgePrioritySmoke.includes('minecraftLauncherRouteKinds') && playCurseForgePrioritySmoke.includes('minecraftLauncherHasCurseForgeRoute') && playCurseForgePrioritySmoke.includes('forced-failure') && playCurseForgePrioritySmoke.includes('Fallback smoke did not open the normal Minecraft Launcher after the CurseForge-root route failed') && playCurseForgePrioritySmoke.includes('Play opened CurseForge.exe') && playCurseForgePrioritySmoke.includes('Play did not import the Minecraft username from the CurseForge launcher root') && playCurseForgePrioritySmoke.includes('createWindowsShortcut') && playCurseForgePrioritySmoke.includes('Launcher.lnk') && playCurseForgePrioritySmoke.includes('Play did not use the discovered Start Menu shortcut route') && playCurseForgePrioritySmoke.includes('localAppDataMinecraftLauncher') && playCurseForgePrioritySmoke.includes('desktopMinecraftLauncher') && playCurseForgePrioritySmoke.includes('Play did not repair the Minecraft asset object'), 'Windows Play must use a pure route planner with shortcut target discovery, prepare CurseForge first without spawning raw CurseForge minecraft.exe, root-owned .minecraft executables, or CurseForge.exe, then fall back through desktop/Store routes.');
assert(desktopMain.includes('async function spawnWindowsMinecraftLauncherRoute') && desktopMain.includes('windowsStartArgs(route.command, route.args || [])') && desktopMain.includes('shouldRetryWindowsLauncherWithStart(error)') && desktopMain.includes('waitForWindowsMinecraftLauncherProcess') && desktopMain.includes('Windows app execution did not start Minecraft Launcher') && !desktopMain.includes("route.source === 'windows-app-alias'") && playCurseForgePrioritySmoke.includes('AHT_TEST_SPAWN_DETACHED_FAIL_SOURCES') && playCurseForgePrioritySmoke.includes('AHT_TEST_STORE_PROCESS_STATE') && playCurseForgePrioritySmoke.includes('--desktop-start-retry') && playCurseForgePrioritySmoke.includes('--store-no-process') && playCurseForgePrioritySmoke.includes('Windows start retry did not preserve the CurseForge --workDir handoff'), 'Windows Play must retry real official Minecraft Launcher path spawn failures through Windows start, verify Store/AppX fallback actually starts a launcher process, and preserve --workDir without treating WindowsApps aliases as desktop routes.');
assert(playCurseForgePrioritySmoke.includes('availablePortPair') && playCurseForgePrioritySmoke.includes('portIsAvailable') && playCurseForgePrioritySmoke.includes("listen(portNumber, '127.0.0.1')"), 'Play route smoke must avoid fixed-port collisions by selecting an available local port pair.');
assert(minecraftLauncherRoutesTest.includes('documents-curseforge-root') && minecraftLauncherRoutesTest.includes('appdata-curseforge-root') && minecraftLauncherRoutesTest.includes('localappdata-curseforge-root') && minecraftLauncherRoutesTest.includes('macos-library-curseforge-root') && minecraftLauncherRoutesTest.includes('macos-documents-lower-curseforge-root'), 'Route planner tests must cover alternate Windows and macOS CurseForge install locations, not only this host path.');
assert(minecraftLauncherRoutesSource.includes('windowsMinecraftLauncherDriveRoots') && minecraftLauncherRoutesSource.includes("'XboxGames', 'Minecraft Launcher', 'Content', 'Minecraft.exe'") && minecraftLauncherRoutesSource.includes('isWindowsAppAliasMinecraftLauncherPath') && minecraftLauncherRoutesTest.includes('xbox-games-launcher') && minecraftLauncherRoutesTest.includes('windows-app-alias-ignored-store'), 'Windows route planner must cover official Xbox/Game Pass installs and reject fragile Windows app-execution aliases as desktop executables.');
assert(minecraftLauncherRoutesSource.includes('WINDOWS_MINECRAFT_LAUNCHER_SOURCE_PRIORITY') && !minecraftLauncherRoutesSource.includes("'windows-app-alias': 90") && minecraftLauncherRoutesSource.includes('.sort((a, b) => a.priority - b.priority') && minecraftLauncherRoutesTest.includes('shortcut-before-ignored-app-alias'), 'Windows launcher executable candidates must use explicit source priority so stronger shortcut/desktop routes win while app aliases are ignored.');
assert(packageScripts['test:play-signin-guidance'] === 'node scripts/smoke-play-signin-guidance.mjs' && verifyLocalScript.includes("['test:play-signin-guidance']") && verifyInstalledScript.includes("['test:play-signin-guidance']"), 'Credential-only Minecraft sign-in guidance smoke must be wired into source and installed-player verification.');
const playSigninGuidanceSmoke = fs.readFileSync(new URL('../scripts/smoke-play-signin-guidance.mjs', import.meta.url), 'utf8');
assert(playSigninGuidanceSmoke.includes('no Minecraft account evidence') && playSigninGuidanceSmoke.includes('Sign in with Microsoft inside Minecraft Launcher') && playSigninGuidanceSmoke.includes('launcher_msa_credentials.bin') && playSigninGuidanceSmoke.includes('accountCredentialOnly') && playSigninGuidanceSmoke.includes('#playButton') && playSigninGuidanceSmoke.includes('finish Microsoft sign-in') && playSigninGuidanceSmoke.includes('AHT_TEST_SPAWN_DETACHED_CAPTURE_PATH') && playSigninGuidanceSmoke.includes('official Minecraft Launcher placeholder'), 'Sign-in guidance smoke must click Play, open the official launcher route, and prove both no-account and credential-only Microsoft guidance without treating cached credentials as a known profile.');
assert(packageScripts['test:minecraft-service-status'] === 'node scripts/test-minecraft-service-status.mjs' && verifyLocalScript.includes("['test:minecraft-service-status']"), 'Minecraft service outage classifier test must be wired into local verification.');
const minecraftServiceStatusTest = fs.readFileSync(new URL('../scripts/test-minecraft-service-status.mjs', import.meta.url), 'utf8');
assert(minecraftServiceStatusTest.includes("new SyntaxError('Unexpected end of JSON input')") && minecraftServiceStatusTest.includes('REQUEST_FAILED') && minecraftServiceStatusTest.includes('jvm.cfg') && minecraftServiceStatusTest.includes('PKIX'), 'Minecraft service outage test must cover raw Play JSON errors, launcher asset failures, runtime cfg failures, and certificate false positives.');
assert(preloadScript.includes("socialList: () => ipcRenderer.invoke('social:list')") && preloadScript.includes("socialAction: (payload) => ipcRenderer.invoke('social:action'"), 'Player preload must expose friends list/action IPC.');
assert(desktopMain.includes("ipcMain.handle('social:list'") && desktopMain.includes("ipcMain.handle('social:action'"), 'Main process must serve friends list/action IPC.');
assert(rendererApp.includes('runFriendAction("add_friend"') && rendererApp.includes('runFriendAction("remove_friend"') && rendererApp.includes('runFriendAction("unblock_player"') && !rendererHtml.includes('Block Player'), 'Friends panel must support add/unadd/unblock only, with no launcher-side block action.');
assert(socialClientSource.includes("new Set(['add_friend', 'remove_friend', 'unblock_player'])") && !socialClientSource.includes("'block_player'"), 'Social client must reject launcher-side player blocking.');
assert(packageScripts['test:social-client'] === 'node scripts/test-social-client.mjs' && verifyLocalScript.includes("['test:social-client']"), 'Social client contract test must be wired into local verification.');
assert(packageScripts['test:friends-panel'] === 'node scripts/smoke-friends-panel.mjs' && verifyLocalScript.includes("['test:friends-panel']") && verifyInstalledScript.includes("['test:friends-panel']"), 'Friends panel smoke must be wired into local and installed-player verification.');
assert(friendsPanelSmoke.includes('FriendOnline') && friendsPanelSmoke.includes('FriendOffline') && friendsPanelSmoke.includes('BlockedOne') && friendsPanelSmoke.includes('add_friend,remove_friend,unblock_player') && friendsPanelSmoke.includes('hasBlockButton'), 'Friends panel smoke must prove counts, online/offline rows, blocked players, and no launcher-side block action.');
assert(packageScripts['test:local-changes-large-tree'] === 'node scripts/test-local-changes-large-tree.mjs' && verifyLocalScript.includes("['test:local-changes-large-tree']"), 'Large-tree local-change scan test must be wired into local verification.');
assert(desktopMain.includes("password: String(process.env.AHT_DEVELOPER_PASSWORD || localCredentials.password || '')"), 'Developer credentials must come from local env or local app-data credentials only.');
assert(!/DEFAULT_DEVELOPER_PASSWORD|developerPassword\s*=/.test(desktopMain), 'Developer password must not have a public source default.');
for (const key of ['curseforgeApiKey', 'serverSshPassword', 'launcherProofSecret', 'githubToken']) {
  assert(!new RegExp(`${key}:\\s*["'](?!["'])[^"']+["']`).test(rendererApp), `Renderer fallback mock must not ship a fake ${key} secret literal.`);
}
assert(rendererHtml.includes('class="brand-mark bill-art"'), 'Brand mark must use the transparent bill asset.');
assert(rendererHtml.includes('class="profile-avatar bill-art"'), 'Player avatar must use the transparent bill asset.');
assert(!rendererHtml.includes('class="brand-mark aht-art"'), 'Brand mark must not use the full cover art.');
assert(!rendererHtml.includes('class="profile-avatar aht-art"'), 'Player avatar must not use the full cover art.');
assert(rendererHtml.includes('class="game-thumb bill-art"'), 'AHT modpack tile must use the clean transparent bill asset.');
assert(rendererHtml.includes('class="game-thumb alt bill-art"'), 'AHT 3.0 tile must use the clean transparent bill asset.');
assert(rendererHtml.includes('class="game-thumb download-thumb aht-art"'), 'Downloads tile must keep the full cover art.');
assert(rendererCss.includes('assets/aht-cover.png'), 'Full cover art CSS must stay available for modpack tiles.');
assert(rendererCss.includes('assets/aht-bill-transparent.png'), 'Transparent bill art CSS must stay available for app/profile marks.');
assert(rendererCss.includes('.feature-art.aht-art::after') && !rendererCss.includes('\n.aht-art::after'), 'AHT cover-art title overlay must only apply to large update-log art, not sidebar thumbnails.');
assert(rendererCss.includes('.feature-art.aht-art::before') && !rendererCss.includes('\n.aht-art::before'), 'AHT cover-art lighting overlay must only apply to large update-log art, not sidebar thumbnails.');
assert(fs.existsSync(new URL('../desktop/renderer/assets/aht-cover.png', import.meta.url)), 'Full cover art asset must exist.');
assert(fs.existsSync(new URL('../desktop/renderer/assets/aht-bill-transparent.png', import.meta.url)), 'Transparent bill art asset must exist.');
assert(pngColorType('build/icon.png') === 6, 'Windows app icon PNG must preserve alpha transparency.');
assert(pngColorType('build/icon-mac.png') === 6, 'macOS app icon PNG must preserve alpha transparency.');
assert(pngColorType('desktop/renderer/assets/aht-bill-transparent.png') === 6, 'Transparent bill art must be an alpha PNG.');
const iconLayers = icoLayers('build/icon.ico');
assert(iconLayers.length >= 6, 'Windows ICO must contain multiple icon sizes.');
assert(iconLayers.some((layer) => layer.width === 256 && layer.height === 256 && layer.bytes > 50000), 'Windows ICO must include a real 256px alpha layer.');
const packageWorkRefs = Object.entries(packageScripts)
  .filter(([, command]) => String(command).includes('work/') || String(command).includes('work\\'))
  .map(([name]) => name);
assert(packageWorkRefs.length === 0, `Package scripts must not depend on local work/ files: ${packageWorkRefs.join(', ')}`);
for (const staleScript of ['build-release', 'install-pack', 'serve-release', 'preview:renderer', 'start:web']) {
  assert(!packageScripts[staleScript], `${staleScript} terminal/web launcher script must not be exposed.`);
}
assert(!configs.windows.files?.includes('public/**/*') && !configs.macos.files?.includes('public/**/*'), 'Regular launcher builds must not package the removed web UI.');
assert(!configs.windows.files?.includes('cloudflare/**/*') && !configs.macos.files?.includes('cloudflare/**/*'), 'Regular player builds must not package Cloudflare Worker source.');
assert(!configs.windows.files?.some((item) => String(item).startsWith('server-lock-mod/')) && !configs.macos.files?.some((item) => String(item).startsWith('server-lock-mod/')), 'Regular player builds must not package server-lock-mod artifacts.');
assert(!configs.windows.asarUnpack?.some((item) => String(item).startsWith('server-lock-mod/')) && !configs.macos.asarUnpack?.some((item) => String(item).startsWith('server-lock-mod/')), 'Regular player builds must not unpack server-lock-mod artifacts.');
assert(configs.windows.files?.includes('config/app.defaults.json') && configs.macos.files?.includes('config/app.defaults.json'), 'Regular launcher builds must package only the player app defaults file.');
assert(!configs.windows.files?.includes('config/**/*') && !configs.macos.files?.includes('config/**/*'), 'Regular launcher builds must not package every config file.');
assert(!packageJson.build?.files?.includes('config/**/*'), 'Legacy package build config must not package every config file.');
assert(!packageJson.build?.files?.includes('cloudflare/**/*'), 'Legacy package build config must not package Cloudflare Worker source.');
assert(!packageJson.build?.files?.some((item) => String(item).startsWith('server-lock-mod/')), 'Legacy package build config must not package server-lock-mod artifacts.');
assert(!packageJson.build?.asarUnpack?.some((item) => String(item).startsWith('server-lock-mod/')), 'Legacy package build config must not unpack server-lock-mod artifacts.');
assert(developerOnlySourceFiles.length === 5, 'Regular player package developer-only source files must be declared.');
for (const relativePath of developerOnlySourceFiles) {
  const exclusion = `!${relativePath}`;
  assert(configs.windows.files?.includes(exclusion), `Windows regular player package must exclude ${relativePath}.`);
  assert(configs.macos.files?.includes(exclusion), `macOS regular player package must exclude ${relativePath}.`);
  assert(packageJson.build?.files?.includes(exclusion), `Legacy package build config must exclude ${relativePath}.`);
}
assert(developerOnlyNodeModules.length === 5, 'Regular player package developer-only node modules must be declared.');
for (const moduleGlob of developerOnlyNodeModules) {
  const exclusion = `!${moduleGlob}`;
  assert(configs.windows.files?.includes(exclusion), `Windows regular player package must exclude ${moduleGlob}.`);
  assert(configs.macos.files?.includes(exclusion), `macOS regular player package must exclude ${moduleGlob}.`);
  assert(packageJson.build?.files?.includes(exclusion), `Legacy package build config must exclude ${moduleGlob}.`);
}
assert(packageJson.dependencies?.['adm-zip'], 'adm-zip must remain a player runtime dependency for legacy ZIP install and Forge Java extraction.');
assert(packageJson.dependencies?.yauzl, 'yauzl must remain a player runtime dependency for streaming full-client ZIP installs.');
for (const dependency of developerOnlyRuntimeDependencies) {
  assert(!packageJson.dependencies?.[dependency], `${dependency} must stay out of dependencies; it is developer-only and excluded from player packages.`);
  assert(packageJson.devDependencies?.[dependency], `${dependency} must be available as a devDependency for local developer tooling/tests.`);
}
assert(desktopMain.includes('async function resolveWorkerSourceFile()') && desktopMain.includes('process.env.AHT_LAUNCHER_SOURCE_ROOT') && desktopMain.includes('process.env.INIT_CWD'), 'Packaged developer cloud setup must find Worker source from the local repo without packaging cloudflare files.');
assert(fs.readFileSync(new URL('../src/releaseBuilder.js', import.meta.url), 'utf8').includes('process.env.AHT_LAUNCHER_SOURCE_ROOT') && fs.readFileSync(new URL('../src/releaseBuilder.js', import.meta.url), 'utf8').includes('process.env.INIT_CWD'), 'Packaged developer release builder must find local server helper jars without packaging server-lock-mod.');
assert(!fs.existsSync(new URL('../config/launcher.config.example.json', import.meta.url)), 'Stale developer-shaped launcher.config.example.json must stay removed.');
assert(!releaseWorkflow.includes('public/**'), 'Launcher build workflow must not trigger on removed web UI files.');
for (const stalePath of ['../installer.js', '../main.js', '../clientPackFormat.js', '../src/cli.js', '../src/web.js', '../public/index.html', '../scripts/build-release.sh', '../scripts/serve-release.sh', '../scripts/start-ui.sh', '../src/previewRenderer.js']) {
  assert(!fs.existsSync(new URL(stalePath, import.meta.url)), `${stalePath} must stay removed; use the Electron app and developer UI instead.`);
}
assert(packageScripts['verify:local'] === 'node scripts/verify-local.mjs', 'verify:local must use scripts/verify-local.mjs.');
assert(packageScripts['verify:installed-player'] === 'node scripts/verify-installed-player.mjs', 'verify:installed-player must run the installed player launcher smoke suite.');
assert(packageScripts['test:player-update-play'] === 'node scripts/smoke-player-update-play-flow.mjs', 'Regular player update/play smoke must stay wired as an npm script.');
assert(verifyLocalScript.includes("['test:player-update-play']"), 'verify:local must run the fresh-player update/play smoke.');
assert(verifyLocalScript.includes("['test:download-retry']"), 'verify:local must run the retrying download smoke.');
assert(!rendererHtml.includes('legacy CurseForge export ZIP'), 'Release Builder UI must not advertise legacy CurseForge ZIPs for normal player releases.');
assert(!rendererApp.includes('legacy CurseForge ZIP first'), 'Release Builder publish lock must require an exact AHT client ZIP.');
assert(!workerTelemetryTest.includes('CurseForge-style installs'), 'Worker telemetry update-log fixture must describe exact AHT client ZIP installs, not the legacy CurseForge flow.');
assert(!desktopMain.includes("name: 'CurseForge exports'") && desktopMain.includes("name: 'Exact AHT client ZIPs'"), 'Pack ZIP picker must request exact AHT client ZIPs, not legacy CurseForge exports.');
assert(rendererApp.includes('Legacy CurseForge export ZIPs are blocked for normal player releases.'), 'Renderer must block legacy CurseForge ZIP publishes before build.');
assert(desktopMain.includes('allowLegacyCurseForge') && desktopMain.includes('assertFullClientReleaseAllowed'), 'Main process must block legacy CurseForge releases by default with an explicit test/tooling allow flag.');
assert(desktopMain.includes("add('error', 'legacy CurseForge release blocked'"), 'Release validation must block legacy CurseForge artifacts before R2 upload.');
assert(checkProductionReadiness.includes('live pack release is exact AHT client ZIP') && checkProductionReadiness.includes("from '../src/clientPackFormat.js'") && !checkProductionReadiness.includes("const CLIENT_PACK_FORMAT = 'aht-full-client-zip';"), 'Production readiness must import the shared client pack format instead of duplicating the full-client ZIP string.');
assert(checkProductionReadiness.includes('function httpRangeStatus') && checkProductionReadiness.includes('Range: "bytes=0-0"') && checkProductionReadiness.includes('live pack ZIP supports parallel range downloads'), 'Production readiness must verify live Worker/R2 pack ZIP Range support for fast multipart downloads.');
assert(desktopMain.includes("from '../src/clientPackFormat.js'") && !desktopMain.includes("const CLIENT_PACK_FORMAT = 'aht-full-client-zip';") && !desktopMain.includes("const CLIENT_PACK_METADATA_ENTRY = 'aht-client-pack.json';"), 'Main process must import shared client pack constants instead of duplicating them.');
assert(checkProductionReadiness.includes('function nextRequiredStep') && checkProductionReadiness.includes('publish an exact AHT client ZIP release') && checkProductionReadiness.includes('report.nextRequiredStep'), 'Production readiness must print blocker-specific next steps instead of generic cloud setup guidance.');
assert(!checkProductionReadiness.includes("console.log('Next required step: run Developer > Setup Cloud after Cloudflare login, then re-run this check.');"), 'Production readiness must not always print the cloud setup next step for unrelated blockers.');
assert(checkProductionReadiness.includes('function gitTrackedRelativePaths') && checkProductionReadiness.includes("git', ['ls-files']") && checkProductionReadiness.includes('required source files tracked by git') && checkProductionReadiness.includes('add the required source/smoke files to git before publishing from GitHub'), 'Production readiness must block GitHub publishing when required source/smoke files are present locally but not tracked by git.');
assert(checkProductionReadiness.includes('function checkGitPublishState') && checkProductionReadiness.includes('githubLauncherWorkflowPaths') && checkProductionReadiness.includes('localReadinessPaths') && checkProductionReadiness.includes('server-lock-mod/build/libs') && checkProductionReadiness.includes('scripts/upload-r2-plan.mjs') && checkProductionReadiness.includes('scripts/verify-installed-player.mjs') && checkProductionReadiness.includes('scripts/check-github-push-auth.mjs') && checkProductionReadiness.includes("git', ['status', '--porcelain=v1'") && checkProductionReadiness.includes('publish-relevant source changes committed to git') && checkProductionReadiness.includes('local HEAD is pushed to origin branch') && checkProductionReadiness.includes('GitHub push auth preflight') && checkProductionReadiness.includes('function githubPushAuthStatus') && checkProductionReadiness.includes('log in to GitHub for this repo with Git Credential Manager or a PAT') && checkProductionReadiness.includes('commit the publish-relevant launcher source changes before using GitHub Actions') && checkProductionReadiness.includes('push the committed launcher changes to origin/main before using GitHub Actions'), 'Production readiness must block GitHub publishing when the verified local source/readiness files are dirty, not pushed to origin, or missing GitHub push auth.');
assert(checkProductionReadiness.includes('live launcher update feed matches local version') && checkProductionReadiness.includes('liveLauncherVersion === localLauncherVersion'), 'Production readiness must block when the hosted launcher update feed is older than the local package version.');
assert(checkProductionReadiness.includes('launcher package version is bumped for changed artifacts') && checkProductionReadiness.includes('sameVersionChangedWindowsArtifact') && checkProductionReadiness.includes('localLauncherVersion === liveLauncherVersion') && checkProductionReadiness.includes('bump package.json so installed launchers detect the update') && checkProductionReadiness.includes('bump the launcher package version and rebuild the launcher artifacts before publishing') && desktopMain.includes('compareVersions(latestVersion, currentVersion) > 0'), 'Production readiness must block changed launcher artifacts under the already-live version because installed launchers only update when the manifest version increases.');
assert(checkProductionReadiness.includes('live launcher Windows download matches local artifact') && checkProductionReadiness.includes('localWindowsLauncherArtifact') && checkProductionReadiness.includes('liveWindowsSha === localWindowsSha') && checkProductionReadiness.includes('liveWindowsSize === localWindowsSize'), 'Production readiness must block when the hosted Windows launcher download hash/size differs from the local artifact.');
assert(checkProductionReadiness.includes('stalePackFeed && staleLauncherFeed') && checkProductionReadiness.includes('publish an exact AHT client ZIP release and a launcher update'), 'Production readiness must report both stale pack and launcher feed blockers when both are present.');
assert(checkProductionReadiness.includes("from './validate-launcher-update-manifest.mjs'") && checkProductionReadiness.includes('function validateLauncherDownloads') && checkProductionReadiness.includes('validateLauncherUpdateManifest(manifest') && checkProductionReadiness.includes('live launcher update feed has Windows and macOS downloads'), 'Production readiness must use the reusable strict launcher manifest validator for live launcher update feeds.');
assert(checkProductionReadiness.includes("names.includes('live launcher update feed has Windows and macOS downloads')"), 'Production readiness next-step guidance must route missing launcher downloads to a launcher update publish.');
assert(launcherUpdateManifestTest.includes('validateLauncherUpdateManifest(manifest') && launcherUpdateManifestTest.includes('generated launcher manifest failed reusable validation'), 'Launcher update manifest test must reuse the manifest validator.');
assert(launcherUpdateManifestValidator.includes("from '../src/launcherUpdateManifest.js'") && launcherUpdateManifestValidator.includes('validateLauncherUpdateManifestFile'), 'Launcher update manifest CLI must wrap the shared runtime validator.');
assert(launcherUpdateManifestSource.includes("REQUIRED_DOWNLOAD_KEYS = ['windows-x64', 'macos-arm64', 'macos-x64']") && launcherUpdateManifestSource.includes('manual downloads must use website-facing keys only') && launcherUpdateManifestSource.includes('platforms must not publish Linux artifacts') && launcherUpdateManifestSource.includes('must include /S silent install args'), 'Launcher update manifest validator must lock website-facing download keys, hashes, silent install args, and no-Linux artifacts.');
assert(prepareLauncherUpdateScript.includes('escapeRegExp(version)') && prepareLauncherUpdateScript.includes('AHT-Launcher-Windows-10-11-${artifactVersion}') && prepareLauncherUpdateScript.includes('AHT-Launcher-macOS-arm64-${artifactVersion}'), 'Launcher update prep must only select artifacts matching the package version.');
assert(prepareLauncherUpdateScript.includes('function requireHttpsLatestUrl') && prepareLauncherUpdateScript.includes('Launcher update latest URL must be HTTPS'), 'Launcher update prep must reject non-HTTPS latest URLs before generating manifests.');
assert(launcherUpdateManifestSource.includes('fileNameMatchesVersion') && launcherUpdateManifestSource.includes('fileName must include launcher version'), 'Launcher update validator must reject stale artifact filenames that do not match the manifest version.');
assert(launcherUpdateManifestSource.includes('path basename must match fileName') && launcherUpdateManifestSource.includes('url basename must match fileName'), 'Launcher update validator must ensure paths and URLs point to the declared artifact fileName.');
assert(launcherUpdateManifestSource.includes('function isAllowedArtifactUrl') && launcherUpdateManifestSource.includes("url.protocol === 'https:'") && launcherUpdateManifestSource.includes('allowInsecureLocalhost'), 'Launcher update validator must require HTTPS artifact URLs except explicit localhost smoke tests.');
assert(launcherUpdateManifestTest.includes('stale launcher artifact filenames') && launcherUpdateManifestTest.includes('path basename must match fileName') && launcherUpdateManifestTest.includes('non-HTTPS launcher artifact URLs') && launcherUpdateManifestTest.includes('non-HTTPS latest URLs') && launcherUpdateManifestTest.includes('artifacts that do not match the manifest/package version'), 'Launcher update manifest test must cover stale artifact filename, path, URL, and HTTPS rejection.');
assert(releaseWorkflow.includes('name: Test launcher update manifest') && releaseWorkflow.includes('npm run test:launcher-update-manifest'), 'GitHub launcher publish workflow must run the launcher update manifest test before publishing release data.');
assert(releaseWorkflow.includes('name: Validate generated launcher update manifest') && releaseWorkflow.includes('node scripts/validate-launcher-update-manifest.mjs ci-launcher-update/launcher/latest.json --latest-url "$AHT_LAUNCHER_UPDATE_URL"'), 'GitHub launcher publish workflow must validate the generated launcher/latest.json before creating releases or uploading R2.');
assert(releaseWorkflow.includes('"scripts/validate-launcher-update-manifest.mjs"'), 'GitHub workflow path triggers must include the generated-manifest validator.');
assert(!releaseWorkflow.includes('launcher_version') && !releaseWorkflow.includes('set-package-version.mjs'), 'GitHub launcher workflow must not expose or apply a manual launcher version override.');
assert(!githubActionsSource.includes('launcher_version') && !desktopMain.includes('launcherVersion: version'), 'Developer launcher update dispatch must let GitHub Actions read package.json from the selected branch.');
assert(desktopMain.includes('function isFullClientRelease') && desktopMain.includes('function requirePlayerFullClientRelease') && desktopMain.includes('playerUpdateBlockedReason'), 'Regular player update/play must block non-exact client ZIP releases before download or launch.');
assert(desktopMain.includes('updateBlockedReason') && rendererApp.includes('status.updateBlockedReason'), 'Renderer status must expose and honor player update blocks.');
assert(smokePlayerUpdatePlay.includes('Legacy feed should be blocked before player install') && smokePlayerUpdatePlay.includes('Legacy feed started downloading pack files before being blocked'), 'Fresh-player smoke must prove legacy feeds are blocked before download.');
assert(smokePlayerUpdatePlay.includes('function waitForCleanScanUiReset') && smokePlayerUpdatePlay.includes('clean scan UI reset after update') && smokePlayerUpdatePlay.includes("document.querySelector('#scanButton')?.click()") && smokePlayerUpdatePlay.includes("document.querySelector('#sidebarProgress')") && smokePlayerUpdatePlay.includes("last.badge === 'Ready' && last.diff === 'Clean' && last.progressHidden && !last.scanDisabled && !last.playDisabled"), 'Fresh-player smoke must prove a clean Scan returns the UI to Ready/Clean with progress hidden and buttons enabled.');
assert(!installerSource.includes("from './clientModpackZip.js'") && installerSource.includes("from './clientPackFormat.js'"), 'Player installer must import full-client ZIP constants from packaged runtime source, not developer-only clientModpackZip.');
assert(developerInstanceDirSmoke.includes('process.env.AHT_SMOKE_EXE') && developerInstanceDirSmoke.includes("AHT_ALLOW_DEVELOPER: '1'") && developerInstanceDirSmoke.includes('AHT_LAUNCHER_SOURCE_ROOT: process.cwd()'), 'Developer instance-dir smoke must support installed packaged EXE developer mode, not only source Electron.');
assert(checkProductionReadiness.includes('function forbiddenRuntimeImportHits') && checkProductionReadiness.includes('src/installer.js') && checkProductionReadiness.includes('clientModpackZip.js') && checkProductionReadiness.includes('includes required player runtime modules') && checkProductionReadiness.includes('src/clientPackFormat.js'), 'Production readiness must catch packaged ASAR runtime imports of missing developer-only modules.');
const verifyScripts = [...verifyLocalScript.matchAll(/\['([^']+)'\]/g)].map((match) => match[1]);
const missingVerifyScripts = verifyScripts.filter((name) => !packageScripts[name]);
assert(missingVerifyScripts.length === 0, `verify:local references missing npm scripts: ${missingVerifyScripts.join(', ')}`);
const missingScriptTargets = Object.entries(packageScripts)
  .flatMap(([name, command]) => scriptTargetExists(String(command)).map((target) => `${name}:${target}`));
assert(missingScriptTargets.length === 0, `Package scripts point at missing node targets: ${missingScriptTargets.join(', ')}`);
const duplicateTestCommands = Object.entries(
  Object.entries(packageScripts)
    .filter(([name]) => name.startsWith('test:'))
    .reduce((groups, [name, command]) => {
      const key = String(command);
      groups[key] = [...(groups[key] || []), name];
      return groups;
    }, {})
).filter(([, names]) => names.length > 1);
assert(duplicateTestCommands.length === 0, `Duplicate test script commands hide verifier gaps: ${duplicateTestCommands.map(([command, names]) => `${names.join(',')} -> ${command}`).join('; ')}`);
const packagedDeveloperSmokeScripts = [
  'scripts/smoke-developer-instance-dir.mjs',
  'scripts/smoke-cache-only-cloud-setup.mjs',
  'scripts/smoke-cloud-login-required.mjs',
  'scripts/smoke-developer-modpack-zip-ui.mjs',
  'scripts/smoke-developer-secret-persistence.mjs',
  'scripts/smoke-developer-update-log-auth-refresh.mjs',
  'scripts/test-developer-client-bypass.mjs',
  'scripts/smoke-launcher-update-publish.mjs',
  'scripts/smoke-r2-release-flow.mjs',
  'scripts/smoke-r2-release-ui-flow.mjs',
  'scripts/smoke-write-player-defaults-button.mjs'
];
for (const relativePath of packagedDeveloperSmokeScripts) {
  const source = fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
  assert(
    source.includes("AHT_ALLOW_DEVELOPER: '1'"),
    `${relativePath} must set AHT_ALLOW_DEVELOPER for packaged developer smoke runs.`
  );
  assert(
    source.includes('AHT_LAUNCHER_SOURCE_ROOT: process.cwd()'),
    `${relativePath} must set AHT_LAUNCHER_SOURCE_ROOT for packaged developer module fallback.`
  );
}
assert(desktopMain.includes("launcherBuildMode() !== 'player'"), 'Player packaged builds must disable developer mode.');
for (const developerOnlyImport of [
  "../src/releaseBuilder.js",
  "../src/clientModpackZip.js",
  "../src/serverTransfer.js",
  "../src/githubActions.js",
  "../src/r2DirectUpload.js"
]) {
  assert(!desktopMain.includes(`from '${developerOnlyImport}'`) && !desktopMain.includes(`from \"${developerOnlyImport}\"`), `${developerOnlyImport} must not be imported at main-process startup.`);
}
assert(desktopMain.includes('async function importDeveloperModule(appRelativePath)') && desktopMain.includes('pathToFileURL'), 'Developer-only modules must resolve from the local source repo when excluded from the public player package.');
assert(desktopMain.includes("function loadReleaseBuilderModule()") && desktopMain.includes("importDeveloperModule('../src/releaseBuilder.js')"), 'Release builder must be lazy-loaded for developer actions.');
assert(desktopMain.includes("function loadClientModpackZipModule()") && desktopMain.includes("importDeveloperModule('../src/clientModpackZip.js')"), 'Exact client ZIP helpers must be lazy-loaded for developer actions.');
assert(desktopMain.includes("function loadR2DirectUploadModule()") && desktopMain.includes("importDeveloperModule('../src/r2DirectUpload.js')"), 'Direct R2 upload must be lazy-loaded for developer actions.');
assert(desktopMain.includes("function loadGithubActionsModule()") && desktopMain.includes("importDeveloperModule('../src/githubActions.js')"), 'GitHub workflow helpers must be lazy-loaded for developer actions.');
assert(desktopMain.includes("function loadServerTransferModule()") && desktopMain.includes("importDeveloperModule('../src/serverTransfer.js')"), 'Server transfer helpers must be lazy-loaded for developer actions.');
assert(desktopMain.includes("import fsSync from 'node:fs';"), 'Launcher mode detection must import fsSync.');
assert(desktopMain.includes("app.setPath('userData', path.join(app.getPath('appData'), 'aht-launcher-developer'))"), 'Developer mode must use separate local app data.');
assert(desktopMain.includes("app.requestSingleInstanceLock({ mode: launchMode })"), 'Single-instance lock must be split by launch mode.');
assert(desktopMain.includes("legacyDeveloperSecretsPath()"), 'Developer mode must migrate existing local secrets from the old app data folder.');
assert(desktopMain.includes("migrateDeveloperEncryptionProfile()"), 'Developer mode must migrate the old Electron encryption profile before decrypting old secrets.');
assert(desktopMain.includes("saveDeveloperSecretField(next, secrets, 'launcherProofSecret')"), 'Developer secrets must not be wiped by empty password fields.');
assert(desktopMain.includes('launcherProof: { ...current.launcherProof, ...nextConfig.launcherProof }'), 'Saved settings must merge launcher proof settings instead of replacing them.');
assert(desktopMain.includes('function rendererStatusConfig(config = {})') && desktopMain.includes('const { developer, serverTransfer, ...safeConfig } = config;'), 'Player status must not expose developer or server-transfer config.');
for (const [label, source] of Object.entries({ desktopMain, rendererApp, rendererHtml })) {
  for (const privateFragment of ['C:\\RL CRAFT SERVER LIST', '192.168.1.121', 'notevil', '/home/notevil']) {
    assert(!source.includes(privateFragment), `${label} must not ship private local server-transfer defaults: ${privateFragment}`);
  }
}
assert(desktopMain.includes('async function openMinecraftLauncherRoute(route, cwd, env)') && desktopMain.includes('const routes = await minecraftLauncherPlatformRoutes(config, env);') && desktopMain.includes('planMacMinecraftLauncherRoutes({'), 'Play must use one shared platform route planner/executor for macOS and Windows.');
assert(!desktopMain.includes('config.minecraftLauncher.openCommand') && !desktopMain.includes('config.minecraftLauncher?.openCommand') && !desktopMain.includes("'custom'"), 'Public player Play must not use custom launcher commands; stale custom settings are ignored.');
assert(desktopMain.includes("async function macOpenCommand()") && desktopMain.includes("const absoluteOpen = '/usr/bin/open'") && desktopMain.includes("return await pathExists(absoluteOpen) ? absoluteOpen : 'open';"), 'macOS opener must prefer absolute /usr/bin/open so Finder-launched apps do not depend on PATH.');
assert(minecraftLauncherRoutesSource.includes("'/Applications/Minecraft.app'") && minecraftLauncherRoutesSource.includes("'/Applications/Minecraft Launcher.app'"), 'macOS route planner must cover both current and legacy Minecraft Launcher app paths.');
assert(minecraftLauncherRoutesSource.includes("'com.mojang.minecraftlauncher'") && minecraftLauncherRoutesSource.includes("'com.microsoft.minecraftlauncher'"), 'macOS route planner must try Mojang and Microsoft Minecraft Launcher bundle IDs.');
assert(minecraftLauncherRoutesSource.includes("'Minecraft'") && minecraftLauncherRoutesSource.includes("'Minecraft Launcher'"), 'macOS route planner must fall back to both Minecraft app names.');
assert(minecraftLauncherRoutesSource.includes('function isMacCurseForgeAppPath') && minecraftLauncherRoutesSource.includes('.filter((item) => !isMacCurseForgeAppPath(item))'), 'macOS route planner must reject CurseForge.app as a launcher target.');
assert(minecraftLauncherRoutesTest.includes('macos-curseforge-app-path') && minecraftLauncherRoutesTest.includes('macos-curseforge-bundle-fallback') && minecraftLauncherRoutesTest.includes('macos-curseforge-app-ignored') && minecraftLauncherRoutesTest.includes('macos-curseforge-app-name-fallback') && minecraftLauncherRoutesTest.includes('macos-custom-app') && minecraftLauncherRoutesTest.includes("'--args', '--workDir'"), 'macOS route planner tests must prove CurseForge root preference, app-name fallback, CurseForge.app rejection, and --workDir handoff.');
assert(desktopMain.includes('async function existingLaunchCwd'), 'Minecraft Launcher opener must sanitize missing configured cwd before spawning.');
assert(desktopMain.includes('const cwd = await existingLaunchCwd(requestedCwd);'), 'Minecraft Launcher opener must use a verified existing cwd.');
assert(desktopMain.includes('async function openWindowsStoreMinecraftLauncher(cwd, env)'), 'Windows Store Minecraft Launcher opener must be isolated.');
assert(desktopMain.includes("env.SystemRoot ? path.join(env.SystemRoot, 'explorer.exe')"), 'Windows Store opener must use absolute explorer.exe from the launcher environment when available.');
assert(desktopMain.includes("const MINECRAFT_LAUNCHER_DOWNLOAD_URL = 'https://www.minecraft.net/download'") && desktopMain.includes('async function windowsStoreMinecraftLauncherInstalled') && desktopMain.includes('openMinecraftLauncherInstallHelp'), 'Windows play must route missing Store/AtlasOS launcher setups to the official Minecraft Launcher download page.');
assert(desktopMain.includes("if (process.platform === 'darwin')") && desktopMain.includes('return openMinecraftLauncherInstallHelp(message);') && desktopMain.includes("return openMinecraftLauncherInstallHelp('Minecraft Launcher could not be opened on macOS.');"), 'macOS Play must route exhausted launcher-open attempts to official Minecraft Launcher setup guidance.');
assert(desktopMain.includes('windowsStoreMinecraftPackageDir(env)') && minecraftLauncherRoutesSource.includes('WINDOWS_MINECRAFT_PACKAGE_FAMILY') && minecraftLauncherRoutesSource.includes("path.win32.join(env.LOCALAPPDATA, 'Packages', WINDOWS_MINECRAFT_PACKAGE_FAMILY)"), 'Windows Store fallback must verify the Minecraft package exists before reporting launch success.');
assert(desktopMain.includes('storeOwnedMarkers') && desktopMain.includes("'LocalState'") && desktopMain.includes("'SystemAppData'") && !/return Boolean\(packageDir && await firstExistingDirectory\(\[packageDir\]\)\)/.test(desktopMain), 'Windows Store fallback must not treat an AHT-created LocalCache-only package folder as an installed Minecraft Launcher.');
assert(desktopMain.includes("route.kind === 'store'") && desktopMain.includes('launch = await openWindowsStoreMinecraftLauncher(cwd, env);') && desktopMain.includes('return minecraftLauncherRouteResult(route, launch, cwd);'), 'Windows play fallback must use the robust Store opener through the shared normalized route executor.');
assert(minecraftLauncherRoutesSource.includes("label: 'Microsoft Store Minecraft Launcher'") && desktopMain.includes('cannot guarantee --workDir'), 'Windows Store fallback must be labeled clearly and warn about the degraded workDir route.');
assert(rendererApp.includes('function launchFailureToastTitle') && rendererApp.includes('"Setup needed"') && rendererApp.includes('Sign in with Microsoft inside Minecraft Launcher') && rendererApp.includes('finish Microsoft sign-in'), 'Renderer must show setup-focused play messages for missing launcher/sign-in cases.');
assert(desktopMain.includes('accountProfileKnown: Boolean(profile.accountProfileKnown)') && desktopMain.includes('accountCredentialOnly: Boolean(profile.accountCredentialOnly)'), 'Renderer-safe Minecraft profile must expose only boolean account confidence, not usernames.');
assert(minecraftProfileSource.includes('function ensureMinecraftAssetObjects') && minecraftProfileSource.includes('https://resources.download.minecraft.net/') && minecraftProfileSource.includes("hashFile(file, 'sha1'") && minecraftProfileSource.includes('downloadFileImpl(source, dest'), 'Minecraft Launcher asset preflight must repair missing/corrupt asset object files, not only indexes.');
assert(minecraftProfileSource.includes('function validDownloadMetadata') && minecraftProfileSource.includes('function hasUsableLibraryMetadata') && minecraftProfileSource.includes('function assetIndexTotalObjectSize') && minecraftProfileSource.includes('validAssetIndexJson(assetIndex, assetExpected)'), 'Minecraft Launcher asset preflight must reject syntactically valid but stale/incomplete base version JSON and asset indexes.');
assert((desktopMain.match(/ensureAssetObjects: true/g) || []).length >= 2 && (desktopMain.match(/verifyAssetHashes: true/g) || []).length >= 2 && !desktopMain.includes('Play does not block on Mojang asset downloads'), 'Modpack Update finalization and Play must repair missing/corrupt Minecraft asset objects before handing off to Minecraft Launcher.');
assert(minecraftProfileSource.includes("PLAYER_MINECRAFT_PROFILE_ID = 'a-hard-time'") && minecraftProfileSource.includes("DEVELOPER_MINECRAFT_PROFILE_ID = 'a-hard-time-developer'") && desktopMain.includes('normalizeMinecraftProfileIdForMode'), 'Regular and developer Minecraft Launcher profile IDs must be separate and migrated.');
assert(minecraftProfileSource.includes('config.minecraftLauncher?.syncDefaultRoots === true') && minecraftProfileSource.includes('cleanupStaleAhtProfiles'), 'Minecraft profile writes must avoid blind root sync and clean stale AHT profiles.');
assert(desktopMain.includes('function minecraftProfileInstallTargets(profile = null)'), 'Launcher must gather all synced Minecraft profile roots before installing loaders.');
assert(desktopMain.includes('profile.syncedProfiles'), 'Launcher must inspect synced Minecraft roots for missing loaders.');
assert(desktopMain.includes('installMinecraftProfileLoaders(profile'), 'Update and Play must install Forge into synced launcher roots.');
assert(
  minecraftLauncherRoutesSource.includes('export function isCurseForgeMinecraftRoot')
    && desktopMain.includes('b.score - a.score || Number(a.fallback) - Number(b.fallback)')
    && !desktopMain.includes("isCurseForgeMinecraftRoot(config.minecraftLauncher?.rootDir) && !isCurseForgeMinecraftRoot(defaults.minecraftLauncher?.rootDir)")
    && minecraftLauncherRoutesSource.includes("const workDirArgs = rootDir ? ['--workDir', rootDir] : []")
    && minecraftLauncherRoutesSource.includes("args: workDirArgs, kind: 'desktop'"),
  'Regular player setup must keep a working CurseForge Minecraft root and pass --workDir to desktop Minecraft Launcher executables.'
);
assert(desktopMain.includes('function isTemporaryTestMinecraftRoot') && desktopMain.includes("normalized.endsWith('/.minecraft')") && desktopMain.includes('!explicitUserDataDir && isTemporaryTestMinecraftRoot(config.minecraftLauncher?.rootDir)'), 'Regular player config migration must reset leaked temp smoke-test Minecraft roots without breaking explicit user-data-dir smokes.');
assert(desktopMain.includes('const rootDir = config.minecraftLauncher?.rootDir || defaultMinecraftRoot();') && !desktopMain.includes("if (!rootDir || config.minecraftLauncher?.enabled === false)"), 'Minecraft account recovery must still inspect signed-in launcher accounts when the profile toggle is disabled or stale.');
const forgeInstaller = fs.readFileSync(new URL('../src/forgeInstaller.js', import.meta.url), 'utf8');
assert(desktopMain.includes('javaCacheDir') || forgeInstaller.includes('ensureManagedJava8Runtime'), 'Forge installer must have managed Java 8 fallback for stale jre-legacy certificates.');
assert(forgeInstaller.includes('windowsJavaInstallRoots') && forgeInstaller.includes('Eclipse Adoptium'), 'Forge installer must prefer installed Temurin/Adoptium Java 8 before stale bundled Minecraft Java.');
assert(forgeInstaller.includes("resolved === 'java' || isLegacyJavaPath(resolved) || !(await isJava8Candidate(resolved))"), 'Forge installer must use managed Java 8 when bare java would spawn ENOENT or a non-Java-8 runtime would be selected.');
assert(utilsSource.includes('Download failed after') && utilsSource.includes('replaceFileWithDownload'), 'Player downloads must retry and replace files atomically.');
assert(utilsSource.includes('function renameFileWithRetry') && utilsSource.includes("['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']") && utilsSource.includes('.previous-') && utilsSource.includes('Could not restore previous download'), 'Player downloads must retry transient Windows file-replacement locks and preserve the previous known-good file on failure.');
assert(forgeInstaller.includes("process.env.AHT_TEST_HOOKS !== '1' || process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS !== '1'"), 'Forge installer test hook must require the explicit AHT_TEST_HOOKS gate.');
assert(forgeInstaller.includes('const DEFAULT_FORGE_VERSION_WAIT_MS = 5 * 60_000') && forgeInstaller.includes('options.versionWaitMs ?? DEFAULT_FORGE_VERSION_WAIT_MS'), 'Forge installer must wait long enough for slow PCs to finish writing version metadata.');
assert(forgeInstaller.includes('function validForgeVersionJson') && forgeInstaller.includes('function missingForgeLibraryArtifacts') && forgeInstaller.includes('incomplete Forge launcher version metadata') && forgeInstaller.includes('metadata or libraries were invalid') && minecraftProfileSource.includes("import { findInstalledForgeVersion } from './forgeInstaller.js';") && minecraftProfileSource.includes('loaderInstalled = Boolean(forgeInstall.installed)') && desktopMain.includes('verifyLibraries: true'), 'Forge profile detection and Play handoff must validate Forge version JSON and required library files instead of treating any existing file as launchable.');
assert(minecraftProfileSource.includes('function ensureMinecraftLibraries') && minecraftProfileSource.includes('function minecraftLibraryArtifactEntries') && minecraftProfileSource.includes('downloads.classifiers') && minecraftProfileSource.includes('MINECRAFT_LIBRARY_BASE_URL') && minecraftProfileSource.includes('libraries: {') && minecraftServiceStatus.includes('Minecraft (?:asset|library'), 'Minecraft Launcher asset prep must also verify and repair base Minecraft libraries/native classifiers before handoff.');
assert(minecraftProfileSource.includes('function ensureMinecraftRuntimeArtifacts') && minecraftProfileSource.includes('downloads?.client') && minecraftProfileSource.includes("path.join('assets', 'log_configs'") && minecraftProfileSource.includes('runtimeArtifacts: {') && minecraftServiceStatus.includes('client jar|logging config|runtime file'), 'Minecraft Launcher preflight must repair base client jar and logging config files before handoff.');
assert(desktopMain.includes('installerUrl: target.loaderInstallerUrl'), 'Update and Play must pass release-provided Forge installer mirrors into Forge setup.');
assert(desktopMain.includes('skipLoaderCheck: true') && desktopMain.includes('allowLegacyRelease: developerClientBypass'), 'Status and initial Play gate must allow Play to self-repair missing synced loaders while preserving developer bypass.');
assert(!desktopMain.includes("if (profile.loaderId?.startsWith('forge-') && !profile.loaderInstalled)"), 'Forge install flow must not only check the primary Minecraft root.');
assert(!desktopMain.includes("spawnDetached('explorer.exe', ['shell:AppsFolder\\\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'], cwd, env)"), 'Windows Store fallback must not spawn plain explorer.exe directly.');
assert(rendererApp.includes('els.r2AccountIdInput.addEventListener("input", queueDeveloperSecretSave)'), 'R2 Account ID input must persist in developer mode.');
assert(rendererApp.includes('savedR2AccountId || !els.r2AccountIdInput.value'), 'Settings refresh must not clear an unsaved R2 Account ID before debounce persistence runs.');
assert(/launcherProof:\s*\{[\s\S]*enabled:\s*true[\s\S]*required:\s*true[\s\S]*baseUrl:\s*workerBase/.test(desktopMain), 'Player defaults must require launcher proof against the Worker endpoint.');
assert(playerDefaultsFunction && !playerDefaultsFunction.includes('developer: {'), 'Generated player defaults must not include developer config.');
assert(!Object.hasOwn(JSON.parse(fs.readFileSync(new URL('../config/app.defaults.json', import.meta.url), 'utf8')), 'developer'), 'Packaged player defaults must not include developer config.');
assert(desktopMain.includes('function validateLatestReleaseFeed') && desktopMain.includes('zip.url or zip.path'), 'Live latest.json reads must reject malformed release feeds.');
assert(rendererApp.includes('if (currentStatus?.developerMode) {') && rendererApp.includes('next.serverTransfer = {'), 'Renderer settings must only serialize developer/server-transfer fields in developer mode.');
assert(/launcherProof:\s*\{[\s\S]*enabled:\s*true[\s\S]*required:\s*true[\s\S]*baseUrl:/.test(rendererApp), 'Renderer settings must preserve required launcher proof in regular player settings.');

assert(configs.macos.productName === 'A Hard Time Launcher macOS', 'macOS product name is not tailored.');
assert(configs.macos.directories?.output === 'release-builds/macos', 'macOS output folder is wrong.');
const macTargets = configs.macos.mac?.target || [];
const macDmgTarget = macTargets.find((target) => target.target === 'dmg');
const macZipTarget = macTargets.find((target) => target.target === 'zip');
assert(macDmgTarget, 'macOS regular launcher must build DMG installers.');
assert(macZipTarget, 'macOS regular launcher must build ZIP update artifacts.');
assert(macDmgTarget.arch?.includes('arm64') && macZipTarget.arch?.includes('arm64'), 'macOS regular launcher should include Apple Silicon.');
assert(macDmgTarget.arch?.includes('x64') && macZipTarget.arch?.includes('x64'), 'macOS regular launcher should include Intel.');
assert(releaseWorkflow.includes('release-builds/macos/*.zip'), 'GitHub macOS workflow must upload ZIP self-update artifacts.');
assert(releaseWorkflow.includes('release_assets=(ci-artifacts/*.exe ci-artifacts/*.dmg ci-launcher-update/launcher-latest.json)') && releaseWorkflow.includes('macOS ZIP artifacts are kept in the R2 launcher update feed for in-app updates only.') && !releaseWorkflow.includes('for asset in ci-artifacts/* ci-launcher-update/launcher-latest.json'), 'GitHub public releases must expose only manual installers while keeping macOS ZIPs for R2 self-update.');
assert(launcherUpdateAutomationDoc.includes('Uploads public launcher installers and `launcher-latest.json` to that GitHub Release.') && launcherUpdateAutomationDoc.includes('macOS ZIP files are generated by the workflow for in-app self-updates and uploaded through the R2 launcher update plan.') && !launcherUpdateAutomationDoc.includes('AHT-Launcher-macOS-arm64-<version>.zip') && !launcherUpdateAutomationDoc.includes('AHT-Launcher-macOS-x64-<version>.zip'), 'Launcher update docs must not advertise macOS ZIPs as public GitHub Release assets.');
assert(macosDownloadPathsDoc.includes('The workflow also builds macOS ZIPs for in-app launcher self-updates') && macosDownloadPathsDoc.includes('uploaded through the R2 launcher update feed instead of being exposed as manual-download assets') && !macosDownloadPathsDoc.includes('AHT-Launcher-macOS-arm64-<version>.zip') && !macosDownloadPathsDoc.includes('AHT-Launcher-macOS-x64-<version>.zip'), 'macOS download docs must keep ZIPs updater-only and manual downloads as DMGs.');
assert(desktopMain.includes('launchMacLauncherUpdateHelper'), 'macOS launcher self-update must use the app-bundle restart helper.');

assert(!fs.existsSync(new URL('../build/electron-builder.ubuntu.cjs', import.meta.url)), 'Ubuntu builder config must not exist.');
assert(!packageJson.scripts['dist:linux'], 'Linux package script must not exist.');
assert(!packageJson.scripts['dist:regular:ubuntu'], 'Ubuntu regular launcher script must not exist.');
assert(!packageJson.build?.linux, 'package.json must not define Linux build targets.');
assert(!releaseWorkflow.includes('id: ubuntu'), 'GitHub workflow must not include an Ubuntu/Linux build matrix entry.');
assert(!releaseWorkflow.includes('ubuntu-'), 'GitHub workflow must not use Ubuntu runners.');
assert(!releaseWorkflow.includes('dist:regular:ubuntu'), 'GitHub workflow must not call the Ubuntu build script.');
assert(!releaseWorkflow.includes('aht-launcher-ubuntu'), 'GitHub workflow must not upload Ubuntu launcher artifacts.');
const platformProfileSource = fs.readFileSync(new URL('../src/platformProfile.js', import.meta.url), 'utf8');
assert(platformProfileSource.includes('Unsupported AHT launcher platform'), 'Platform profile must reject unsupported platforms instead of keeping a generic Linux/Desktop fallback.');
assert(desktopMain.includes("import { defaultInstanceDirForPlatform, platformKey, platformProfile } from '../src/platformProfile.js';"), 'Main process must use the shared platform policy for platform-specific paths.');
assert(desktopMain.includes('platformKey(process.platform);') && !desktopMain.includes("return path.join(app.getPath('userData'), 'A Hard Time Developer');"), 'Developer playable instance must reject unsupported platforms instead of keeping a generic Linux fallback.');
assert(!platformProfileSource.includes('XDG_DATA_HOME'), 'Platform profile must not keep an XDG/Linux instance path after Linux build removal.');
assert(!platformProfileSource.includes('Desktop package'), 'Platform profile must not advertise a generic desktop/Linux package target.');
assert(!rendererHtml.includes('Actions builds Windows, macOS, and Ubuntu'), 'Developer launcher update UI must not advertise Ubuntu/Linux builds.');
assert(!rendererApp.includes('launcherUbuntuPathInput'), 'Renderer must not keep stale Ubuntu launcher artifact inputs.');
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
