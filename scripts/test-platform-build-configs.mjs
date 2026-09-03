import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { launcherPackageVersionForRelease } from '../src/launcherVersion.js';

const require = createRequire(import.meta.url);
const readText = (resource) => fs.readFileSync(resource, 'utf8').replace(/\r\n?/g, '\n');
const packageJson = JSON.parse(readText(new URL('../package.json', import.meta.url)));
const publicReadme = readText(new URL('../README.md', import.meta.url));
const commonBuilder = require('../build/electron-builder.common.cjs');
const windowsInstallerInclude = readText(new URL('../build/windows-installer.nsh', import.meta.url));
const rendererApp = readText(new URL('../desktop/renderer/app.js', import.meta.url));
const preloadScript = readText(new URL('../desktop/preload.cjs', import.meta.url));
const rendererHtml = readText(new URL('../desktop/renderer/index.html', import.meta.url));
const rendererCss = readText(new URL('../desktop/renderer/style.css', import.meta.url));
const rendererPolishCss = readText(new URL('../desktop/renderer/polish.css', import.meta.url));
const benderLicense = readText(new URL('../desktop/renderer/assets/fonts/Bender-OFL-1.1.txt', import.meta.url));
const benderFontFiles = ['Bender-Regular.otf', 'Bender-Light.otf', 'Bender-Bold.otf']
  .map((name) => new URL(`../desktop/renderer/assets/fonts/${name}`, import.meta.url));
const externalLinkIcon = readText(new URL('../desktop/renderer/icons/external-link.svg', import.meta.url));
const desktopMain = readText(new URL('../desktop/main.js', import.meta.url));
const installerSource = readText(new URL('../src/installer.js', import.meta.url));
const localChangesSource = readText(new URL('../src/localChanges.js', import.meta.url));
const socialLinksSource = readText(new URL('../src/socialLinks.js', import.meta.url));
const r2DirectUploadSource = readText(new URL('../src/r2DirectUpload.js', import.meta.url));
const launcherProofSource = readText(new URL('../src/launcherProof.js', import.meta.url));
const launchDiagnosticsSource = readText(new URL('../src/launchDiagnostics.js', import.meta.url));
const clientPackFormatSource = readText(new URL('../src/clientPackFormat.js', import.meta.url));
const utilsSource = readText(new URL('../src/utils.js', import.meta.url));
const githubActionsSource = readText(new URL('../src/githubActions.js', import.meta.url));
const releaseWorkflow = readText(new URL('../.github/workflows/build-macos.yml', import.meta.url));
const verifyLocalScript = readText(new URL('../scripts/verify-local.mjs', import.meta.url));
const verifyInstalledPlayerScript = readText(new URL('../scripts/verify-installed-player.mjs', import.meta.url));
const smokePlayerDefaults = readText(new URL('../scripts/smoke-player-defaults-feed.mjs', import.meta.url));
const smokeSettingsProfile = readText(new URL('../scripts/smoke-settings-profile-save.mjs', import.meta.url));
const smokePlayerLayout = readText(new URL('../scripts/smoke-player-layout.mjs', import.meta.url));
const smokeDeveloperAuthRefresh = readText(new URL('../scripts/smoke-developer-update-log-auth-refresh.mjs', import.meta.url));
const smokeStartupTransition = readText(new URL('../scripts/smoke-startup-sidebar-transition.mjs', import.meta.url));
const smokePlayerUpdateLogs = readText(new URL('../scripts/smoke-player-update-logs.mjs', import.meta.url));
const smokePlayerUpdatePlay = readText(new URL('../scripts/smoke-player-update-play-flow.mjs', import.meta.url));
const smokeR2ReleaseFlow = readText(new URL('../scripts/smoke-r2-release-flow.mjs', import.meta.url));
const smokeR2ReleaseUiFlow = readText(new URL('../scripts/smoke-r2-release-ui-flow.mjs', import.meta.url));
const smokePlayIntegrityGate = readText(new URL('../scripts/smoke-play-integrity-gate.mjs', import.meta.url));
const smokeCloseDuringUpdate = readText(new URL('../scripts/smoke-close-during-update.mjs', import.meta.url));
const smokeLauncherSelfUpdate = readText(new URL('../scripts/smoke-launcher-self-update.mjs', import.meta.url));
const checkProductionReadiness = readText(new URL('../scripts/check-production-readiness.mjs', import.meta.url));
const prepareLauncherUpdateScript = readText(new URL('../scripts/prepare-launcher-update.mjs', import.meta.url));
const launcherUpdateManifestTest = readText(new URL('../scripts/test-launcher-update-manifest.mjs', import.meta.url));
const launcherUpdateManifestValidator = readText(new URL('../scripts/validate-launcher-update-manifest.mjs', import.meta.url));
const launcherReleaseImmutabilityCheck = readText(new URL('../scripts/check-launcher-release-immutability.mjs', import.meta.url));
const launcherUpdateManifestSource = readText(new URL('../src/launcherUpdateManifest.js', import.meta.url));
const launcherUpdateStagingSource = readText(new URL('../src/launcherUpdateStaging.js', import.meta.url));
const launcherUpdateHelper = readText(new URL('../desktop/launcher-update-helper.ps1', import.meta.url));
const launcherUpdateBootstrap = readText(new URL('../desktop/launcher-update-bootstrap.ps1', import.meta.url));
const launcherUpdateTransactionSmoke = readText(new URL('./smoke-windows-launcher-update-transaction.mjs', import.meta.url));
const developerLauncherReinstallSmoke = readText(new URL('./smoke-developer-launcher-reinstall.mjs', import.meta.url));
const workerTelemetryTest = readText(new URL('../scripts/test-worker-telemetry.mjs', import.meta.url));
const socialClientSource = readText(new URL('../src/socialClient.js', import.meta.url));
const workerSource = readText(new URL('../cloudflare/curseforge-proxy-worker.js', import.meta.url));
const friendsPanelSmoke = readText(new URL('../scripts/smoke-friends-panel.mjs', import.meta.url));
const legalConsentSource = readText(new URL('../src/legalConsent.js', import.meta.url));
const legalPanelSmoke = readText(new URL('../scripts/smoke-legal-consent-panel.mjs', import.meta.url));
const termsText = readText(new URL('../legal/TERMS_OF_SERVICE.txt', import.meta.url));
const privacyText = readText(new URL('../legal/PRIVACY_POLICY.txt', import.meta.url));
const electronSmokeIsolationFailures = fs.readdirSync(new URL('./', import.meta.url))
  .filter((name) => name.endsWith('.mjs') && name !== 'test-platform-build-configs.mjs')
  .map((name) => ({ name, source: readText(new URL(name, import.meta.url)) }))
  .filter(({ source }) => source.includes('--user-data-dir') && !source.includes('PACKAGED_PRODUCTION_UPDATE_SMOKE') && (
    !source.includes("AHT_TEST_HOOKS: '1'")
    || (
      !source.includes('AHT_TEST_USER_DATA: userData')
      && !source.includes('AHT_TEST_USER_DATA: developerUserData')
      && !source.includes('AHT_TEST_USER_DATA: targetUserData')
    )
  ))
  .map(({ name }) => name);
const wranglerSmokeIsolationFailures = fs.readdirSync(new URL('./', import.meta.url))
  .filter((name) => name.endsWith('.mjs') && name !== 'test-platform-build-configs.mjs')
  .map((name) => ({ name, source: readText(new URL(name, import.meta.url)) }))
  .filter(({ source }) => source.includes('const fakeWrangler') && (
    !source.includes('AHT_WRANGLER_COMMAND: process.execPath')
    || !source.includes('AHT_WRANGLER_ARGS_PREFIX: JSON.stringify([fakeWrangler])')
  ))
  .map(({ name }) => name);
const packageScripts = packageJson.scripts || {};
const launcherReleaseVersion = String(packageJson.ahtLauncherVersion || packageJson.version || '');
const playerDefaultsStart = desktopMain.indexOf('function playerDefaultsForCloud');
const playerDefaultsEnd = desktopMain.indexOf('function playerDefaultsTargets');
const playerDefaultsFunction = playerDefaultsStart >= 0 && playerDefaultsEnd > playerDefaultsStart
  ? desktopMain.slice(playerDefaultsStart, playerDefaultsEnd)
  : '';
const launcherUpdaterStart = desktopMain.indexOf('function defaultLauncherInstallerArgs');
const launcherUpdaterEnd = desktopMain.indexOf('function serverTransferPrivateKeyPath');
const launcherUpdaterOwner = launcherUpdaterStart >= 0 && launcherUpdaterEnd > launcherUpdaterStart
  ? desktopMain.slice(launcherUpdaterStart, launcherUpdaterEnd)
  : '';

const configs = {
  windows: require('../build/electron-builder.windows.cjs'),
  macos: require('../build/electron-builder.macos.cjs'),
  linux: require('../build/electron-builder.linux.cjs')
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

function pngDimensions(relativePath) {
  const bytes = fs.readFileSync(new URL(`../${relativePath}`, import.meta.url));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function fileSha256(relativePath) {
  return createHash('sha256')
    .update(fs.readFileSync(new URL(`../${relativePath}`, import.meta.url)))
    .digest('hex')
    .toUpperCase();
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
const forbiddenPublicSecurityDocs = [
  'docs/access-control-and-data-security.md',
  'docs/launcher-proof-contract.md',
  'docs/launcher-update-automation.md',
  'docs/macos-signing-and-download-paths.md'
];

assert(configs.windows.productName === 'A Hard Time Launcher Windows', 'Windows product name is not tailored.');
assert(
  forbiddenPublicSecurityDocs.every((relativePath) => !fs.existsSync(new URL(`../${relativePath}`, import.meta.url)))
    && !publicReadme.includes('Security and access-control operations are documented')
    && !publicReadme.includes('Ignores player edits under')
    && !publicReadme.includes('private fallback cache'),
  'Public repository documentation must not disclose security, attestation, operator, fallback-cache, or integrity-bypass internals.'
);
assert(configs.windows.directories?.output === 'release-builds/windows', 'Windows output folder is wrong.');
assert(configs.windows.win?.artifactName?.includes('Windows-10-11'), 'Windows artifact name should target Windows 10/11.');
assert(configs.windows.win?.target?.[0]?.target === 'nsis', 'Windows regular launcher must build NSIS.');
assert(configs.windows.win?.target?.some((target) => target.target === 'zip'), 'Windows regular launcher must also build the R2-only staged update ZIP.');
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
assert(preloadScript.includes('process.isMainFrame === true') && rendererHtml.includes('Content-Security-Policy') && rendererHtml.includes("object-src 'none'") && rendererHtml.includes("script-src 'self'"), 'Launcher IPC must be exposed only to the main frame under a restrictive renderer CSP.');
assert(desktopMain.includes('sandbox: true') && desktopMain.includes('webviewTag: false') && desktopMain.includes("setWindowOpenHandler(() => ({ action: 'deny' }))") && desktopMain.includes("on('will-navigate', (event) => event.preventDefault())"), 'The Electron window must be sandboxed and block untrusted top-level navigation and popup windows.');
assert(rendererHtml.includes('id="newsTab"') && rendererHtml.includes('id="newsFeedGrid"') && rendererApp.includes('els.newsFeedGrid.appendChild(buildUpdateLogCard'), 'Player News must be a real launcher view backed by the player-safe update-log feed.');
assert(
  rendererHtml.includes('polish.css')
    && rendererPolishCss.includes('font-family: "AHT Bender"')
    && rendererPolishCss.includes('--bsg-primary: #fffff3')
    && rendererPolishCss.includes('--bsg-secondary: #aaaaaa')
    && rendererPolishCss.includes('width: 664px')
    && rendererPolishCss.includes('height: 373px')
    && rendererPolishCss.includes('grid-template-columns: 250px minmax(0, 1fr)')
    && benderFontFiles.every((resource) => fs.statSync(resource).size > 0)
    && benderLicense.includes('SIL OPEN FONT LICENSE Version 1.1'),
  'The player shell must package the licensed Bender family and preserve the directly measured BSG typography, colors, and News geometry.'
);
assert(rendererHtml.includes('id="storeTab"') && rendererHtml.includes('data-external-destination="store"') && rendererCss.includes('.icon-external-link') && externalLinkIcon.includes('<svg'), 'The top navigation must expose a polished Store destination with an external-link icon.');
assert(preloadScript.includes("openExternal: (destination) => ipcRenderer.invoke('shell:openExternal', destination)") && desktopMain.includes("store: 'https://ahardtime.net/store'") && desktopMain.includes("ipcMain.handle('shell:openExternal'") && desktopMain.includes('PLAYER_EXTERNAL_DESTINATIONS[key]'), 'External player links must resolve through a main-process destination allowlist containing the official AHT store.');
assert(desktopMain.includes("process.env.AHT_TEST_OPEN_EXTERNAL_ECHO === '1'") && desktopMain.includes("updateLogs = await readUpdateLogs(config, 12, { preferCache: options.preferCache })"), 'Store navigation and the full News feed must have deterministic test coverage without opening a browser.');
const socialMenuHtml = rendererHtml.slice(rendererHtml.indexOf('id="launcherSocialMenu"'), rendererHtml.indexOf('id="profileFriendsButton"') + 'id="profileFriendsButton"'.length);
const socialMenuCss = rendererPolishCss.slice(rendererPolishCss.indexOf('.topbar-social {'), rendererPolishCss.indexOf('.profile-card:hover .profile-copy strong'));
const playerPreloadApi = preloadScript.slice(preloadScript.indexOf('const playerApi = {'), preloadScript.indexOf('const developerApi = {'));
const developerPreloadApi = preloadScript.slice(preloadScript.indexOf('const developerApi = {'), preloadScript.indexOf('contextBridge.exposeInMainWorld'));
assert(
  socialLinksSource.includes("LAUNCHER_SOCIAL_LINKS_OBJECT_KEY = 'update-media/launcher-social-links.json'")
    && socialLinksSource.includes("discord: 'https://discord.com/invite/AUVMekfNfq'")
    && socialLinksSource.includes("youtube: 'https://www.youtube.com/@AHardTime'")
    && socialLinksSource.includes("tiktok: 'https://www.tiktok.com/@ahardtimefr'")
    && socialLinksSource.includes("forum: 'https://ahardtime.net/forum'")
    && socialLinksSource.includes("parsed.protocol !== 'https:'")
    && socialLinksSource.includes('ALLOWED_HOSTS[key].has(hostname)'),
  'Launcher Social Links must retain the exact defaults and fail closed to approved HTTPS hosts and paths.'
);
assert(
  rendererHtml.indexOf('id="launcherSocialMenu"') < rendererHtml.indexOf('id="profileFriendsButton"')
    && (socialMenuHtml.match(/data-external-destination="discord"/g) || []).length === 1
    && socialMenuHtml.indexOf('id="youtubeSocialLink"') < socialMenuHtml.indexOf('id="tiktokSocialLink"')
    && socialMenuHtml.indexOf('id="tiktokSocialLink"') < socialMenuHtml.indexOf('id="forumSocialLink"')
    && socialMenuCss.includes('background: transparent;')
    && socialMenuCss.includes('.topbar-social:hover .social-dropdown')
    && socialMenuCss.includes('.topbar-social:focus-within .social-dropdown')
    && socialMenuCss.includes('visibility: hidden;')
    && socialMenuCss.includes('pointer-events: none;')
    && socialMenuCss.includes('display: grid;'),
  'The top-right community control must be a background-free Discord icon before the profile with a hover/focus-only vertical YouTube, TikTok, Forum dropdown.'
);
assert(
  playerPreloadApi.includes("getSocialLinks: (options = {}) => ipcRenderer.invoke('social-links:get'")
    && !playerPreloadApi.includes('devPublishSocialLinks')
    && developerPreloadApi.includes("devPublishSocialLinks: (payload) => ipcRenderer.invoke('dev:publishSocialLinks'")
    && desktopMain.includes("ipcMain.handle('social-links:get'")
    && desktopMain.includes("ipcMain.handle('dev:publishSocialLinks'")
    && desktopMain.includes('LAUNCHER_SOCIAL_LINK_KEYS.includes(key)')
    && desktopMain.includes("process.env.AHT_TEST_SOCIAL_LINKS_PUBLISH_CAPTURE_PATH")
    && r2DirectUploadSource.includes('export async function uploadR2JsonDirect'),
  'Players may read and open allowlisted Social Links, while only an authenticated developer renderer may publish the fixed R2 object.'
);
assert(
  rendererHtml.includes('id="socialLinkTools"')
    && rendererHtml.includes('id="publishSocialLinksButton"')
    && rendererHtml.includes('id="discordUrlInput"')
    && rendererHtml.includes('id="youtubeUrlInput"')
    && rendererHtml.includes('id="tiktokUrlInput"')
    && rendererHtml.includes('id="forumUrlInput"')
    && smokeDeveloperAuthRefresh.includes("credentialRecoverySource !== 'worker-safe-storage-recovery'")
    && smokeDeveloperAuthRefresh.includes("key !== 'update-media/launcher-social-links.json'")
    && smokePlayerLayout.includes("'vertical Social Links dropdown'")
    && smokePlayerLayout.includes("window.aht.openExternal(destination)"),
  'Developer publishing, Windows safeStorage recovery, player geometry, and exact destination mapping must stay under Electron regression coverage.'
);
assert(rendererApp.includes('iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation")') && rendererApp.includes('url.protocol === "https:"'), 'Remote update media must use validated URLs and a sandboxed iframe.');
assert(preloadScript.includes("devPlayerRecords: (payload) => ipcRenderer.invoke('dev:playerRecords'") && preloadScript.includes("devLauncherUpdates: (payload) => ipcRenderer.invoke('dev:launcherUpdates'"), 'Developer preload must expose current player records and launcher-update history only through developer IPC.');
assert(workerSource.includes("const LAUNCHER_UPDATE_PREFIX = 'launcher-updates/'") && workerSource.includes("'/admin/player-records'") && workerSource.includes("'/admin/launcher-updates'") && workerSource.includes('currentOnly: true'), 'Worker must expose canonical current players and dedicated launcher updates without historical IP joins.');
assert(workerSource.includes('canonicalAccountLauncherUpdate') && workerSource.includes('readAllR2JsonObjects') && workerSource.includes('identitySource') && workerSource.includes('aht_player'), 'Worker player-data reads must retain explicit download identities and surface current canonical launcher versions when dedicated update telemetry is missing.');
assert(
  workerSource.includes("['macos-arm64', 'macos-universal']")
    && workerSource.includes("['macos-x64', 'macos-universal']")
    && workerSource.includes("['linux-x64', 'ubuntu-x64-appimage']")
    && workerSource.includes("['ubuntu-x64', 'ubuntu-x64-appimage']")
    && workerSource.includes("if (platformKey === 'macos-universal') return ['macos-universal', 'macos-arm64', 'macos-x64'];")
    && workerSource.includes("if (platformKey === 'ubuntu-x64') return ['ubuntu-x64-appimage', 'ubuntu-x64', 'linux-x64'];")
    && workerSource.includes('launcherManifestDownload(manifest, platformKey)'),
  'Worker must keep legacy download URLs working across both the split legacy manifest and the consolidated universal manifest.'
);
assert(
  workerSource.includes('const LAUNCHER_INSTALLER_DOWNLOAD_LIMIT = 7;')
  && workerSource.includes('const LAUNCHER_INSTALLER_DOWNLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;')
  && workerSource.includes('launcherInstallerPersonIdentity')
  && workerSource.includes('launcher-installer-download:${identityHash}')
  && workerSource.includes('this.downloadLimitChain')
  && workerSource.includes("code: 'LAUNCHER_INSTALLER_DOWNLOAD_LIMIT'")
  && workerTelemetryTest.includes('concurrentAccepted !== 7 || concurrentDenied !== 5')
  && workerTelemetryTest.includes('Untagged launcher self-updates must stay unlimited and uncounted.')
  && workerTelemetryTest.includes("method: 'HEAD'")
  && workerTelemetryTest.includes('firstDownloadAt: Date.now() - (24 * 60 * 60 * 1000) - 1'),
  'Worker must atomically allow seven installer downloads in one anchored 24-hour window while excluding self-updates and HEAD checks.'
);
assert(desktopMain.includes('preferredMinecraftUuid') && desktopMain.includes('minecraftUuid: detectedMinecraftUuid') && desktopMain.includes("type: 'launcher_update_completed'") && desktopMain.includes('result?.launcherUpdateKey'), 'Regular launcher identity must capture the active Minecraft UUID and record each confirmed launcher version through the dedicated update contract.');
assert(workerSource.includes('recovered && (!existingMinecraftUuid || !minecraftUuid || existingMinecraftUuid !== minecraftUuid)') && desktopMain.includes('launcherVersionTelemetryInFlight.delete(key)') && desktopMain.includes('launcherVersionWasReported(latestIdentity, version)'), 'Account recovery must require the stored Minecraft UUID, and transient launcher-update telemetry failures must be retryable without duplicating a version already persisted by an earlier request.');
assert(desktopMain.includes('remoteRegistrationConfirmedAt') && desktopMain.includes('remoteRegistrationNeedsRefresh') && desktopMain.includes('registerMinecraftUsernameInFlight') && desktopMain.includes('Player data sync unavailable:'), 'Player identities saved before a Worker/API outage must retry remote registration once and preserve a clear sync warning without deleting the local identity.');
assert(desktopMain.includes('The configured Worker is missing the player-data API. Deploy the current AHT Worker before loading Player Data.'), 'Developer Player Data must identify a stale Worker deployment instead of presenting an empty/incomplete history.');
assert(rendererApp.includes('loadAllPlayerDataPages') && rendererApp.includes('window.aht.devLauncherDownloads(payload)') && rendererApp.includes('window.aht.devPlayerRecords(payload)') && rendererApp.includes('window.aht.devLauncherUpdates(payload)') && rendererApp.includes('Player data pagination returned a repeated cursor.'), 'Developer Player Data must safely page through installer downloads, canonical players, and launcher updates.');
assert(rendererHtml.includes('id="playerDownloadsTab"') && rendererHtml.includes('id="playerRecordsTab"') && rendererHtml.includes('id="playerLauncherUpdatesTab"') && !rendererHtml.includes('Selected Download') && !rendererHtml.includes('Raw data') && !rendererApp.includes('JSON.stringify(item, null, 2)'), 'Player Data must use compact Downloads/Players/Launcher Updates tabs without a raw selected-record panel.');
assert(rendererHtml.includes('<span>Date</span><span>User</span><span>IP</span><span>MC UUID</span><span>Platform</span>') && rendererHtml.includes('<span>Last Seen</span><span>User</span><span>IP</span><span>Network</span><span>Device</span><span>MC UUID</span><span>Access</span><span>Action</span>') && rendererApp.includes('if (platform.includes("win")) return "Windows"') && rendererApp.includes('return "Mac";') && rendererApp.includes('return "Linux";'), 'Player Data must show IPv4 or IPv6, device/network/access fields, verified identity fields, and short Windows, macOS, and Linux platform names.');
assert(rendererApp.includes('function playerDataFailureSummary') && rendererApp.includes('setDevLog(failureSummary)') && rendererApp.includes('showToast("Player data partially loaded", failureSummary'), 'Mixed Player Data rollout failures must name each unavailable endpoint while leaving Reload available.');
assert(
  rendererApp.includes('const TOAST_MAX_LIFETIME_MS = 4000;')
  && rendererApp.includes('const TOAST_EXIT_DURATION_MS = 180;')
  && rendererApp.includes('const TOAST_SCHEDULER_HEADROOM_MS = 2000;')
  && rendererApp.includes('const TOAST_MAX_VISIBLE_MS = TOAST_MAX_LIFETIME_MS - TOAST_EXIT_DURATION_MS - TOAST_SCHEDULER_HEADROOM_MS;')
  && rendererApp.includes('const TOAST_DEFAULT_VISIBLE_MS = 1800;')
  && rendererApp.includes('const visibleDurationMs = Math.min(desiredVisibleMs, TOAST_MAX_VISIBLE_MS);')
  && rendererApp.includes('window.setTimeout(() => toast.remove(), TOAST_EXIT_DURATION_MS);')
  && rendererApp.includes('window.setTimeout(remove, visibleDurationMs);')
  && !rendererApp.includes('type === "error" ? 30000')
  && !rendererApp.includes('durationMs: 5200'),
  'Every transient toast must centrally clamp its visible phase with scheduler headroom so the exit animation completes within 4000ms under load, without the former 30000ms error or 5200ms override paths.'
);
assert(rendererCss.includes('max-height: min(68vh, 760px)') && rendererCss.includes('overflow-y: scroll'), 'Developer launcher download history must remain fully scrollable.');
assert(preloadScript.includes("devSaveServerTransfer: (payload) => ipcRenderer.invoke('dev:saveServerTransfer'"), 'Server folder settings must have a dedicated persistence IPC.');
assert(desktopMain.includes('async function persistServerTransferSettings') && rendererApp.includes('await saveServerTransferSettings();') && rendererApp.includes('await planServerTransfer();'), 'Selecting a server folder must persist it and immediately produce an upload plan.');
assert(clientPackFormatSource.includes("'config/jei/bookmarks.ini'") && installerSource.includes('isPlayerUpdatePreservedRelPath') && installerSource.includes('preserveUpdateState'), 'JEI bookmarks must be player-owned after the first install and preserved by updates and repairs.');
assert(rendererHtml.includes('Deploy Latest Launcher') && preloadScript.includes("devDeployLauncher: (payload) => ipcRenderer.invoke('dev:deployLauncher'"), 'Developer launcher must expose a one-click public launcher deploy control.');
assert(rendererHtml.includes('id="testLauncherReinstallButton"') && rendererHtml.includes('Test Local Reinstall') && rendererHtml.includes('id="launcherReinstallStatus"'), 'Developer Launcher Updates must expose a clear local reinstall test control and safety status.');
assert(preloadScript.indexOf('devPrepareLauncherReinstall:') > preloadScript.indexOf('const developerApi = {') && preloadScript.indexOf('devPrepareLauncherReinstall:') < preloadScript.indexOf('const api = { ...playerApi }'), 'Local launcher reinstall IPC must exist only in the developer preload API.');
assert(
  desktopMain.includes("const LOCAL_REINSTALL_REQUEST_SCHEMA = 'aht-launcher-local-reinstall-request/v1';")
  && desktopMain.includes("const LOCAL_REINSTALL_PURPOSE = 'local-reinstall-test';")
  && desktopMain.includes('function localReinstallInboxPath()')
  && desktopMain.includes('function localReinstallRequestRecordKeysAreStrict(request = {})')
  && desktopMain.includes('async function validateLocalReinstallRequestRecord(requestDir, request = {})')
  && desktopMain.includes("const consumedPath = path.join(requestDir, 'request.consumed.json');")
  && desktopMain.includes('async function prepareDeveloperLauncherReinstallBridge()')
  && desktopMain.includes('async function resolveDeveloperLauncherReinstallTarget()')
  && desktopMain.includes("if (process.env.AHT_TEST_HOOKS === '1' && path.isAbsolute(testAppDataRoot))")
  && desktopMain.includes("app.setPath('appData', path.resolve(testAppDataRoot));")
  && desktopMain.includes("'A Hard Time Launcher Windows.exe'")
  && desktopMain.includes("require('original-fs')")
  && desktopMain.includes('spawnDetachedGui(\n      reinstallTarget.targetExe,\n      [],')
  && desktopMain.includes('sanitizedRegularLauncherEnvironment()')
  && desktopMain.includes('await waitForLocalReinstallPromptReady({')
  && desktopMain.includes('setTimeout(() => app.quit(), 250);'),
  'Authenticated Developer Mode must create a strict one-shot same-version request in the fixed player inbox, open the physically validated installed regular launcher with a sanitized environment, and quit only after prompt-ready acknowledgement.'
);
assert(
  desktopMain.indexOf('if (!isDeveloperMode() && activeLocalReinstallRequest)') > desktopMain.indexOf('async function readLauncherUpdate(config = {})')
  && desktopMain.indexOf('if (!isDeveloperMode() && activeLocalReinstallRequest)') < desktopMain.indexOf('const manifest = await fetchRemoteJson(latestUrl);', desktopMain.indexOf('async function readLauncherUpdate(config = {})'))
  && desktopMain.includes("const source = localReinstallTest\n    ? activeLocalReinstallRequest.artifactPath")
  && desktopMain.includes('const descriptor = await readJsonFile(activeLocalReinstallRequest.consumedPath);')
  && desktopMain.includes('await validateLocalReinstallRequestRecord(activeLocalReinstallRequest.requestDir, descriptor);')
  && desktopMain.includes('function launcherUpdateForRenderer(update = {})')
  && desktopMain.includes('function launcherUpdateStateForRenderer(state = {})')
  && desktopMain.includes("app.on('second-instance', () => {")
  && desktopMain.includes('await consumeLocalReinstallRequest().catch((error) => {'),
  'The regular launcher must consume/revalidate the one-shot request at startup or second-instance, bypass the configured live feed only for that local source, and keep nonce/hash/path details out of renderer status.'
);
assert(
  packageScripts['test:developer-launcher-reinstall'] === 'node scripts/smoke-developer-launcher-reinstall.mjs'
  && developerLauncherReinstallSmoke.includes('const developerDefaultsPath')
  && developerLauncherReinstallSmoke.includes('const playerDefaultsPath')
  && developerLauncherReinstallSmoke.includes('playerDefaultsBytes.equals(regularConfigBytes)')
  && developerLauncherReinstallSmoke.includes('closeLauncherWhenGameStarts: false,')
  && !developerLauncherReinstallSmoke.includes('minecraftLauncher: { enabled: false')
  && developerLauncherReinstallSmoke.includes('storedRegularConfig.launcherUpdate?.latestUrl !== forbiddenLiveFeed')
  && developerLauncherReinstallSmoke.includes("method: String(request.method || 'GET').toUpperCase()")
  && developerLauncherReinstallSmoke.includes("url: String(request.url || '')")
  && developerLauncherReinstallSmoke.includes("assertNoFeedRequests('Completed developer-to-regular local reinstall')")
  && developerLauncherReinstallSmoke.includes('function rendererBoundaryViolations')
  && (developerLauncherReinstallSmoke.match(/assertRendererPrivacyBoundary\(\{/g) || []).length >= 2
  && developerLauncherReinstallSmoke.includes('function snapshotFileIdentity')
  && developerLauncherReinstallSmoke.includes("const statFields = ['size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'dev', 'ino'];")
  && developerLauncherReinstallSmoke.includes("assertFileIdentityUnchanged(regularConfigPath, regularConfigIdentityBeforeAction, 'Final local reinstall state')")
  && developerLauncherReinstallSmoke.includes('function validateReceiptTree')
  && developerLauncherReinstallSmoke.includes("validateReceiptTree(prepared.stagingDir, receipt, 'Prepared launcher staging tree')")
  && developerLauncherReinstallSmoke.includes("validateReceiptTree(installDir, receipt, 'Swapped installed launcher tree')")
  && developerLauncherReinstallSmoke.includes('async function observeSwapLifecycle')
  && developerLauncherReinstallSmoke.includes('const lifecyclePromise = observeSwapLifecycle({')
  && developerLauncherReinstallSmoke.includes('signal: swapLifecycleAbortController.signal')
  && developerLauncherReinstallSmoke.includes('validCommitMarker(lifecycle.commit')
  && developerLauncherReinstallSmoke.includes('cleanupDestructiveStartedAt')
  && developerLauncherReinstallSmoke.includes('Launcher update commit accepted at')
  && developerLauncherReinstallSmoke.includes('AHT_DEVELOPER_REINSTALL_FULL_TRANSACTION')
  && developerLauncherReinstallSmoke.includes('AHT_SMOKE_EXE')
  && developerLauncherReinstallSmoke.includes('record.durationMs > 4250')
  && developerLauncherReinstallSmoke.includes('wrongPasswordToastMs')
  && developerLauncherReinstallSmoke.includes('loginSuccessToastMs')
  && developerLauncherReinstallSmoke.includes('acknowledgedPlayerMode'),
  'Developer-to-player reinstall smoke must prove both toast lifetimes, split defaults, zero method/URL feed requests, recursive privacy, config file identity, genuine receipt/tree staging, commit-before-cleanup, helper swap logs, and regular-mode relaunch for source and packaged Developer Launcher variants.'
);
assert(desktopMain.includes('function publicLauncherWorkflow()') && desktopMain.includes("repo: LAUNCHER_WORKFLOW_DEFAULTS.repo") && desktopMain.includes("ref: LAUNCHER_WORKFLOW_DEFAULTS.branch") && desktopMain.includes("workflow: LAUNCHER_WORKFLOW_DEFAULTS.workflow"), 'One-click launcher deployment must ignore stale UI targets and stay locked to the public repository, main branch, and player workflow.');
assert(!rendererApp.slice(rendererApp.indexOf('async function publishLauncherUpdate()'), rendererApp.indexOf('function serverTransferPayload()')).includes('githubRepo:'), 'One-click launcher deployment must not accept a repository override from the renderer.');
assert(desktopMain.includes('function assertPublicLauncherWorkflow') && desktopMain.includes('developerArtifactsUploaded: false') && desktopMain.includes('waitForPublishedLauncherVersion'), 'Launcher deploy must lock to the public workflow and verify the live update feed without developer artifacts.');
assert(!/release_assets=\([^\n]*(?:developer|dev-launcher)/i.test(releaseWorkflow), 'Public GitHub Release workflow must never include a developer launcher asset.');
assert(desktopMain.includes("ipcMain.handle('dialog:folder', async (_event, defaultPath = '')") && desktopMain.includes('options.defaultPath = startingPath'), 'Native folder picker must pass the supplied starting path to Electron defaultPath.');
assert(desktopMain.includes("process.env.AHT_TEST_HOOKS === '1' && process.env.AHT_TEST_DIALOG_ECHO_DEFAULT_PATH === '1'"), 'Dialog test hook must require the explicit AHT_TEST_HOOKS gate.');
assert(desktopMain.includes('function configureTestRemoteDebugPort()') && desktopMain.includes("process.env.AHT_TEST_HOOKS !== '1'") && desktopMain.includes('AHT_TEST_REMOTE_DEBUG_PORT'), 'Packaged smoke remote-debug hook must be gated by AHT_TEST_HOOKS and an explicit port env var.');
assert(desktopMain.includes('function writeTestStartupProbe') && desktopMain.includes('AHT_TEST_STARTUP_PROBE_PATH'), 'Packaged startup diagnostics must be gated behind AHT_TEST_HOOKS and an explicit probe path.');
assert(smokePlayerUpdatePlay.includes('AHT_TEST_REMOTE_DEBUG_PORT: String(port)') && smokePlayerUpdatePlay.includes('AHT_TEST_STARTUP_PROBE_PATH: startupProbePath') && smokePlayerUpdatePlay.includes('? [`--user-data-dir=${userData}`]'), 'Installed player update/play smoke must use the gated main-process remote-debug hook and startup probe.');
assert(smokePlayerDefaults.includes('const minecraftRoot = path.join(root, \'.minecraft\')') && smokePlayerDefaults.includes('enabled: true') && smokePlayerDefaults.includes('rootDir: minecraftRoot'), 'Player defaults smoke must exercise enabled Minecraft Launcher profile integration against an isolated temp root.');
assert(smokePlayerLayout.includes('const minecraftRoot = path.join(root, \'.minecraft\')') && smokePlayerLayout.includes('serializedEnabled') && smokePlayerLayout.includes('closeLauncherWhenGameStartsInput') && smokePlayerLayout.includes('profileToggleAbsent'), 'Player layout smoke must prove Minecraft profile integration is forced and the replacement close setting is present.');
assert(
  !rendererHtml.includes('id="accountOverlay"')
  && !rendererHtml.includes('id="minecraftUsernameInput"')
  && !rendererHtml.includes('id="playerLabelInput"')
  && !preloadScript.includes('accountRegister')
  && !desktopMain.includes("ipcMain.handle('account:register'")
  && rendererHtml.includes('id="closeLauncherWhenGameStartsInput"')
  && rendererHtml.includes('Close launcher when game starts'),
  'The launcher must have no manual Minecraft username surface/API and must replace the profile toggle with the close-on-game-start setting.'
);
const verifyInstalledPlayer = readText(new URL('../scripts/verify-installed-player.mjs', import.meta.url));
for (const installedPlayerCheck of [
  'test:player-defaults',
  'test:player-privacy',
  'test:player-layout',
  'test:settings-profile',
  'test:account-duplicate',
  'test:account-switch',
  'test:update-logs',
  'test:single-instance',
  'test:play-gate',
  'test:player-update-play',
  'test:launcher-self-update',
  'test:developer-launcher-reinstall'
]) {
  assert(verifyInstalledPlayer.includes(`['${installedPlayerCheck}']`), `Installed player verifier must include ${installedPlayerCheck}.`);
}
assert(verifyInstalledPlayer.includes('AHT_INSTALLED_PLAYER_CHECK_TIMEOUT_MS'), 'Installed player verifier must bound each packaged-app check independently.');
assert(verifyInstalledPlayer.includes("import net from 'node:net'") && verifyInstalledPlayer.includes('findAvailablePortBlock') && verifyInstalledPlayer.includes("server.listen({ host: '127.0.0.1', port: basePort + offset, exclusive: true }"), 'Installed player verifier must dynamically probe a free loopback port block for every packaged-app check.');
assert(verifyInstalledPlayer.includes("detached: process.platform !== 'win32'") && verifyInstalledPlayer.includes('terminateOwnedProcessTree') && verifyInstalledPlayer.includes("process.kill(-child.pid, 'SIGKILL')"), 'Installed player verifier must terminate its owned Unix process group before launching the next packaged-app check.');

assert(rendererApp.includes('window.aht.selectFolder(els.instanceInput.value.trim() || currentStatus?.config?.instanceDir || "")'), 'Modpack Folder Browse must open at the folder path currently listed in Game Settings.');
assert(!rendererApp.includes('els.pickInstanceButton.addEventListener("click", async () => {\n    const folder = await window.aht.selectFolder();'), 'Modpack Folder Browse must not call selectFolder without a default path.');
assert(rendererHtml.includes('id="openInstancePathButton"') && rendererHtml.includes('id="openMinecraftRootPathButton"') && rendererApp.includes('async function openFolderPath') && rendererApp.includes('result?.error'), 'Game Settings must provide professional Open controls for both exact folder paths and surface native open failures.');
assert(rendererApp.includes('function renderPrimaryAction(status = currentStatus)') && rendererApp.includes('const installMode = !status?.installed?.version') && rendererApp.includes('const unavailable = packageActionMode') && rendererApp.includes(': actionBusy;') && !rendererApp.includes('!status?.launchReady'), 'The single primary action must distinguish Install from Update while keeping blocked Play clickable for main-process diagnostics.');
assert(!rendererApp.includes('Config error'), 'Renderer must not show the technical Config error label in player or developer UI.');
assert(!rendererApp.includes('packageTarget') && !rendererApp.includes('build - ${platformProfile'), 'Renderer settings subtitle must not expose package/build target jargon in the player UI.');
assert(!rendererApp.includes('server owner') && !desktopMain.includes('server owner'), 'Player-facing update/feed messages must not use internal server-owner wording.');
assert(rendererApp.includes('"Latest Release"') && rendererApp.includes('"Updated"') && rendererApp.includes('"Outdated"') && rendererApp.includes('"Uninstalled"') && rendererApp.includes('status.developerMode') && rendererApp.includes('currentStatus?.developerMode'), 'Renderer must show the latest release and a concise Updated/Outdated/Uninstalled state while keeping release-source diagnostics in developer mode.');
assert(rendererApp.includes('els.sideInstalledVersion.textContent = installedLabel'), 'Sidebar pack tile must show the same v.x installed-version label as the main hero.');
assert(rendererHtml.includes('id="launcherVersionLabel"') && rendererApp.includes('els.launcherVersionLabel.textContent = launcherVersion'), 'Regular launcher sidebar must show the running launcher app version.');
assert(preloadScript.includes("restartLauncherUpdate: () => ipcRenderer.invoke('launcher:updateRestart')") && (desktopMain.includes("ipcMain.handle('launcher:updateRestart', async () => restartLauncherUpdate())") || desktopMain.includes("ipcMain.handle('launcher:updateRestart', diagnosticIpc('launcher:updateRestart'")), 'Launcher self-update must expose a separate explicit restart IPC.');
assert(rendererApp.includes('Update finished') && rendererApp.includes('Restart Launcher') && rendererApp.includes('restartLauncherSelfUpdate'), 'Launcher self-update UI must expose Restart only after the complete payload is staged.');
assert(desktopMain.includes('pending-launcher-update.json') && desktopMain.includes('pending-launcher-update.failed') && desktopMain.includes('shouldExitForPendingLauncherInstall') && desktopMain.includes('launcher-update-install-pending-exit'), 'Launcher self-update must persist handoff state, recover helper failures, and close old copies that reopen while the installer is running.');
assert(!desktopMain.includes('keepOpenUntil') && !desktopMain.includes("mainWindow.on('close', (event)") && !desktopMain.includes('event.preventDefault();\n      focusMainWindow();'), 'Normal play/update operations must not trap the launcher window open with a timed close guard.');
assert(desktopMain.includes('waitForLauncherUpdateHelperStart') && desktopMain.includes('current handoff nonce') && desktopMain.includes('AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY'), 'Launcher restart must verify the current nonce-bound handoff helper starts before quitting.');
assert(desktopMain.includes("launcherUpdateTestHook('AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY')") && !desktopMain.includes('testStartOnly: process.env.AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY') && launcherUpdateHelper.includes('$script:payload.testStartOnly -eq $true') && !launcherUpdateHelper.includes('$env:AHT_TEST_LAUNCHER_UPDATE_HELPER_START_ONLY') && desktopMain.includes("test_start_only=${payload.testStartOnly ? '1' : '0'}"), 'Windows and macOS update helpers must receive test-only startup mode only through an AHT_TEST_HOOKS-gated payload.');
assert(launcherUpdateHelper.includes('for ($attempt = 0; $attempt -lt 40; $attempt += 1)') && launcherUpdateHelper.includes('Start-Sleep -Milliseconds 25'), 'Windows update-helper logging must retry transient sharing collisions while the launcher polls the handoff log.');
assert(desktopMain.includes('function windowsLauncherInstallerArgs') && desktopMain.includes('`/D=${targetDir}`'), 'Windows launcher self-update must install into the current launcher directory.');
assert(desktopMain.includes('prepareWindowsStagedLauncherUpdate') && desktopMain.includes("preparedWindowsPowerShellHandoff(helper, 'windows-staged-helper'") && launcherUpdateStagingSource.includes('stageWindowsLauncherUpdate') && launcherUpdateStagingSource.includes('validateStagedWindowsLauncherUpdate'), 'Windows self-update must fully extract and validate its ZIP before exposing Restart.');
assert(launcherUpdateHelper.includes('[System.IO.Directory]::Move($paths.InstallDir, $paths.BackupDir)') && launcherUpdateHelper.includes('[System.IO.Directory]::Move($paths.StagingDir, $paths.InstallDir)') && launcherUpdateHelper.includes('Wait-ForStartupAcknowledgement') && launcherUpdateHelper.includes('Restore-StagedSwap'), 'Windows restart helper must use an atomic swap, ready-window acknowledgement, and rollback.');
assert(desktopMain.includes('const relaunchDeveloper = isDeveloperMode();') && desktopMain.includes('relaunchDeveloper,'), 'Every hashed handoff payload must bind its actual regular/developer relaunch mode; the local reinstall bridge smoke separately requires false for the regular player.');
assert(desktopMain.includes("String(payload[field] ?? '') !== String(prepared[field])"), 'Launcher update payload validation must preserve a bound false relaunchDeveloper value for ordinary player updates.');
assert(launcherUpdateHelper.includes("EnvironmentVariables['AHT_ALLOW_DEVELOPER'] = '1'") && launcherUpdateHelper.includes('[bool] $ack.developerMode -eq [bool] ($script:payload.relaunchDeveloper -eq $true)') && desktopMain.includes('developerMode: isDeveloperMode()'), 'The hidden helper must grant Developer Mode only to a designated developer relaunch and require every startup acknowledgement to match the requested regular/developer mode exactly.');
assert(
  launcherUpdateHelper.includes('function Write-CommitAccepted')
  && launcherUpdateHelper.includes("schema = 'aht-launcher-update-commit/v1'")
  && launcherUpdateHelper.includes('$commitPath = Write-CommitAccepted $acceptedAck $newTarget')
  && launcherUpdateHelper.includes('Launcher update commit accepted at')
  && launcherUpdateHelper.includes('delegated rollback directory cleanup to the new launcher')
  && desktopMain.includes('async function waitForLauncherUpdateCommitMarker(commit = {}')
  && desktopMain.includes("status: 'waiting-for-helper-commit'")
  && desktopMain.includes('Launcher update backup cleanup requires a complete helper commit contract.')
  && desktopMain.includes('scheduleCompletedLauncherUpdateBackupCleanup(prepared.backupDir, prepared.ackPath, commit);')
  && desktopMain.includes('async function waitForLauncherUpdateBackupCleanup(cleanupStatusPath = \'\'')
  && desktopMain.includes('if (await waitForLauncherUpdateBackupCleanup(`${prepared.ackPath}.cleanup.json`)) {\n          await removeLocalReinstallRequestDirectory(requestDir);')
  && desktopMain.includes('validateCompletedLauncherUpdateCandidate(pending)')
  && desktopMain.includes('removeWindowsLauncherBackupDirectory')
  && launcherUpdateStagingSource.includes("require('original-fs')"),
  'The swapped candidate must validate its bound tree, acknowledge readiness, receive a helper commit marker, and only then allow physical rollback-backup cleanup.'
);
assert(
  launcherUpdateHelper.includes('ExpectedPayloadSha256')
  && launcherUpdateHelper.includes('receiptSha256')
  && launcherUpdateHelper.toLowerCase().includes('ready to quit nonce=')
  && launcherUpdateHelper.includes("EnvironmentVariables['AHT_LAUNCHER_UPDATE_HANDOFF_NONCE'] = $handoffNonce")
  && desktopMain.includes("const LAUNCHER_UPDATE_HANDOFF_NONCE_ENV = 'AHT_LAUNCHER_UPDATE_HANDOFF_NONCE';")
  && desktopMain.includes('function shouldExitForSameVersionLauncherUpdateBeforeLock()')
  && desktopMain.includes('candidateNonce !== expectedNonce')
  && desktopMain.includes('async function validateCompletedLauncherUpdateCandidate(pending = {})')
  && desktopMain.includes("String(process.env[LAUNCHER_UPDATE_HANDOFF_NONCE_ENV] || '').toLowerCase() !== expectedNonce.toLowerCase()")
  && /function launcherUpdateHelperEnvironment\(\) \{\s+const env = sanitizedLauncherEnvironment\(process\.env\);/.test(desktopMain),
  'Windows restart must bind payload/receipt and a one-use handoff nonce, reject unrelated same-version candidates before and after the instance lock, and launch the helper without inherited AHT credentials or test state.'
);
assert(launcherUpdateBootstrap.includes('System.Diagnostics.ProcessStartInfo') && launcherUpdateBootstrap.includes('CreateNoWindow = $true') && launcherUpdateBootstrap.includes('ProcessWindowStyle]::Hidden') && desktopMain.includes('launcher-update-bootstrap.ps1'), 'Windows restart must use a short hidden bootstrap that leaves an independent helper alive after Electron exits.');
assert(!launcherUpdaterOwner.includes('windowsCommandPromptPath') && !launcherUpdaterOwner.includes('apply-launcher-update.cmd') && !launcherUpdaterOwner.includes("'/c', 'start'") && !launcherUpdateHelper.includes('cmd.exe') && !launcherUpdateBootstrap.includes('cmd.exe'), 'Launcher self-update must never open a CMD handoff window.');
assert(!desktopMain.includes("'-EncodedCommand'") && !desktopMain.includes('function encodedPowerShell'), 'Packaged launcher process inspection must not use obfuscated PowerShell command encoding.');
assert(smokeLauncherSelfUpdate.includes('launcher-update-install-pending-exit') && smokeLauncherSelfUpdate.includes('reopened old launcher did not exit during pending install'), 'Launcher self-update smoke must prove reopened old copies exit during an installing handoff.');
assert(packageScripts['test:launcher-update-transaction'] === 'node scripts/smoke-windows-launcher-update-transaction.mjs' && launcherUpdateTransactionSmoke.includes('closeToWindowReadyMs') && launcherUpdateTransactionSmoke.includes('Uninstall A Hard Time Launcher Windows.exe') && launcherUpdateTransactionSmoke.includes('PACKAGED_PRODUCTION_UPDATE_SMOKE'), 'Packaged Windows acceptance must exercise a real older-version atomic swap, ready-window acknowledgement, preserved installer/user data, and close-to-window timing.');
assert(launcherUpdateTransactionSmoke.includes("AHT_TRANSACTION_MODE || 'version-upgrade'") && launcherUpdateTransactionSmoke.includes("same-version-developer-reinstall") && launcherUpdateTransactionSmoke.includes("purpose: 'developer-reinstall'") && launcherUpdateTransactionSmoke.includes("['--developer']") && launcherUpdateTransactionSmoke.includes('relaunchDeveloper: sameVersionDeveloperReinstall') && launcherUpdateTransactionSmoke.includes("AHT_ALLOW_DEVELOPER: ''") && launcherUpdateTransactionSmoke.includes('ack.developerMode !== true'), 'Packaged Windows acceptance must prove a real same-version developer reinstall where the helper itself grants and verifies Developer Mode.');
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
assert(!rendererApp.includes('"Launch is locked."') && rendererApp.includes('"Finish setup before playing."'), 'Play button tooltip must use a specific setup fallback instead of the vague locked label.');
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
assert(desktopMain.includes("const environmentPassword = String(process.env.AHT_DEVELOPER_PASSWORD || '')"), 'Developer credentials must support a local environment secret.');
assert(desktopMain.includes('localCredentials.protectedPassword'), 'Developer credential files must use OS-protected password storage.');
assert(!desktopMain.includes("localCredentials.password || ''"), 'Developer login must not continuously read a plaintext password from app data.');
assert(desktopMain.includes('if (!Array.isArray(managedOptions.managedFiles))'), 'Player Play must fail closed without an authoritative verified client manifest.');
assert(!/DEFAULT_DEVELOPER_PASSWORD|developerPassword\s*=/.test(desktopMain), 'Developer password must not have a public source default.');
for (const key of ['curseforgeApiKey', 'serverSshPassword', 'launcherProofSecret', 'socialServerSecret', 'githubToken']) {
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
assert(rendererCss.includes('assets/launcher-background.png'), 'Launcher background CSS must use the dedicated high-resolution background asset.');
assert(rendererCss.includes('body:not(.dev-mode) .workspace'), 'Player background must be owned by the regular launcher workspace.');
assert(!rendererCss.includes('.hero-panel::before') && !rendererCss.includes('.hero-panel::after') && !rendererCss.includes('.hero-art::after'), 'Player background must not be covered by decorative hero overlays.');
assert(rendererHtml.includes('id="scanButton"') && rendererHtml.includes('icon-wrench') && rendererHtml.includes('Repair') && !rendererHtml.includes('Scan files'), 'Player quick action must be labeled Repair, not Scan files.');
assert(rendererHtml.includes('icon-settings') && rendererHtml.includes('Game Settings'), 'Player settings quick action must use the reference capitalization and gear icon.');
assert(!rendererHtml.includes('id="updateButton"') && rendererHtml.includes('id="playButton"') && rendererHtml.includes('data-action-mode="play"') && rendererApp.includes('els.playButton.dataset.actionMode === "install" || currentStatus?.updateRequired') && rendererApp.includes('openUpdateOptions();'), 'Player footer must expose one action that becomes Install for missing packs, Update for outdated packs, and Play when ready.');
assert(!rendererHtml.includes('<dt>Installed</dt>') && !rendererHtml.includes('<dt>Latest</dt>') && !rendererHtml.includes('<dt>Local Changes</dt>') && rendererHtml.includes('class="launch-game-info"'), 'Player footer must use BSG-style game information instead of the old Installed/Latest/Local Changes dashboard.');
assert(rendererHtml.includes('<strong>Game version:</strong>') && !rendererHtml.includes('id="launchGameEdition"') && !rendererHtml.includes('id="launchServerStatus"') && !rendererApp.includes('launchGameEdition') && !rendererApp.includes('launchServerStatus'), 'Player footer must expose only Game version; Game edition and Server must not be rendered or updated.');
assert(!rendererHtml.includes('id="playerPackTitle"') && !rendererHtml.includes('id="versionLine"') && !rendererApp.includes('playerPackTitle') && !rendererApp.includes('versionLine'), 'Player hero must never restore the removed A Hard Time, A Hard Time PTB, or Not Installed labels.');
assert(rendererHtml.includes('class="footer-game-logo"') && rendererHtml.includes('assets/aht-vine-logo.png') && rendererPolishCss.includes('left: 34px;') && rendererPolishCss.includes('width: 565px;') && rendererPolishCss.includes('height: 190px;') && rendererPolishCss.includes('bottom: 0;') && rendererPolishCss.includes('top: -27px;') && rendererPolishCss.includes('width: 600px;') && rendererPolishCss.includes('padding: 0 12px 0 28px;') && rendererPolishCss.includes('padding: 0 14px 0 28px;'), 'Player footer must use the supplied vine logo at the larger inset/lowered footprint and move Game version/quick actions substantially right.');
assert(rendererHtml.includes('<div class="footer-game-logo">') && rendererHtml.indexOf('<img src="assets/aht-vine-logo.png" alt="A Hard Time">') > rendererHtml.indexOf('<div class="footer-game-logo">') && !rendererPolishCss.includes('.footer-game-logo { background:'), 'The supplied vine logo must remain a dedicated foreground image independent of launcher background artwork.');
assert(rendererPolishCss.includes('.news-card-headline') && rendererPolishCss.includes('.feature-copy strong::after { content: none; }') && rendererPolishCss.includes('background-size: cover, 112% auto, 112% auto;') && rendererPolishCss.includes('url("assets/launcher-background.png") 48% 59% / cover no-repeat;'), 'The dedicated News page must keep its accepted single-column stream, one inline BSG headline chevron, cinematic hero crop, and real-art fallback thumbnails.');
assert(rendererPolishCss.includes('#player #updateLogGrid.update-log-grid') && rendererPolishCss.includes('grid-template-columns: 482px 284px 284px;') && rendererPolishCss.includes('grid-template-rows: 270px;') && rendererPolishCss.includes('#player #updateLogGrid > .home-news-card.large:hover .feature-copy') && smokePlayerUpdateLogs.includes('Game News lead copy must exist only during actual pointer hover') && smokePlayerUpdateLogs.includes('Game News filler artwork must retain the exact side-image box'), 'The Game screen alone must use one 482px full-art lead story plus two equal 284x270 side cards, fixed 158px artwork, and true-hover-only lead copy.');
const downloadsPolishStart = rendererPolishCss.indexOf('/* Downloads keeps the quiet BSG surface');
const downloadsPolishEnd = rendererPolishCss.indexOf('.feature-copy .feature-meta', downloadsPolishStart);
const downloadsPolish = rendererPolishCss.slice(downloadsPolishStart, downloadsPolishEnd);
assert(downloadsPolishStart >= 0 && downloadsPolishEnd > downloadsPolishStart && !downloadsPolish.includes('115deg') && !downloadsPolish.includes('135deg'), 'Downloads final-cascade styling must remove both long diagonal decoration lines.');
assert(rendererPolishCss.includes('width: 575px;') && rendererPolishCss.includes('grid-template-columns: 282px 293px;') && rendererPolishCss.includes('width: 293px;') && rendererPolishCss.includes('height: 68px;') && rendererPolishCss.includes('inset: 0 -36px 0 0;') && rendererPolishCss.includes('#000 72%') && rendererPolishCss.includes('rgba(0, 0, 0, 0.16) 94%') && rendererPolishCss.includes('width: auto;') && rendererPolishCss.includes('border-radius: 2px;') && rendererPolishCss.includes('clip-path: none;') && !rendererPolishCss.includes('.launch-strip::after') && rendererPolishCss.includes('top: -231px;') && rendererPolishCss.includes('right: -252px;') && rendererPolishCss.includes('width: 809px;') && rendererPolishCss.includes('height: 413px;') && rendererPolishCss.includes('assets/bsg-button-huge-light-1.png') && rendererPolishCss.includes('assets/bsg-button-huge-light-2.png') && rendererPolishCss.includes('mix-blend-mode: screen;') && rendererPolishCss.includes('mix-blend-mode: color-dodge;') && rendererPolishCss.includes('.quick-actions .ghost-button') && rendererPolishCss.includes('border: 0;') && rendererPolishCss.includes('#playButton.is-install-action') && !rendererPolishCss.includes('.launch-actions:hover:has(#playButton:not(.is-disabled))'), 'Player footer must preserve the shortened/faded BSG panel, exact static native two-layer bloom, two-pixel primary-action corners, and Install state.');
assert(rendererPolishCss.includes('linear-gradient(180deg, #b89d6b 0%, #987c51 43%, #705a3e 72%, #4d4032 100%)') && rendererPolishCss.includes('linear-gradient(180deg, #a4a681 0%, #858868 43%, #646b50 72%, #414a3b 100%)') && !rendererPolishCss.includes('linear-gradient(180deg, rgba(190, 61, 51, 0.98)') && !rendererPolishCss.includes('linear-gradient(180deg, rgba(116, 164, 88, 0.98)'), 'Update and Install must use the muted launcher ochre/sage palette without the former saturated red/green fills.');
const startupLoaderHtml = rendererHtml.slice(rendererHtml.indexOf('id="startupLoader"'), rendererHtml.indexOf('id="sidebarSwitchLoader"'));
assert(rendererHtml.includes('<body class="is-booting">') && rendererHtml.includes('id="startupLoader"') && rendererHtml.includes('class="app-frame" aria-hidden="true" inert') && rendererApp.includes('async function bootstrapLauncher()') && rendererApp.includes('window.aht.prepareStartup()') && rendererApp.includes('const startupTasks = Promise.allSettled([') && rendererApp.includes('includeUpdateLogs: true') && rendererApp.includes('preloadStartupNewsArtwork') && rendererApp.includes('await startupTasks;') && rendererApp.includes('if (!currentStatus) renderInitialStatusError(error);') && !rendererApp.includes('STARTUP_QUICK_MAX_MS') && rendererPolishCss.includes('body.is-booting .app-frame') && rendererPolishCss.includes('.money-loader-system'), 'Startup must remain fail-closed behind the opaque loading screen until preparation, fully populated last-known-good News, decoded or fallback artwork, status, legal, fonts, window load, and static assets settle.');
assert(rendererApp.includes('STARTUP_MIN_VISIBLE_MS = 0') && rendererApp.includes('STARTUP_NEWS_ART_TIMEOUT_MS = 15_000') && rendererApp.includes('STARTUP_WARM_NEWS_ART_TIMEOUT_MS = 1_200') && !rendererApp.includes('withoutUnavailableNewsArtwork') && rendererApp.includes('A preload miss is only a timing result') && rendererApp.includes('assetUrl(log?.metadata?.image)') && rendererApp.includes('log?.image_url') && smokePlayerUpdateLogs.includes('artworkMetadataProof') && !rendererApp.includes('startupPreparationPending: true') && !rendererApp.includes('Quick startup preparation exceeded the five-second limit'), 'Startup must never impose an artificial loading-screen floor, reveal a partially hydrated shell, send a deadline error, or erase published News image metadata after a transient warm-artwork miss.');
assert(rendererApp.includes('const decodeReady = stallDecodeForTest ? new Promise(() => {}) : image.decode().catch(() => {});') && rendererApp.includes('void decodeReady;') && !rendererApp.includes('await image.decode()') && desktopMain.includes("process.env.AHT_TEST_STALL_IMAGE_DECODE === '1'") && smokePlayIntegrityGate.includes('stallImageDecode: true') && smokePlayIntegrityGate.includes('stalledImageDecode: stalledDecodeTestActive') && smokePlayIntegrityGate.includes("!document.body.classList.contains('is-booting')") && smokePlayIntegrityGate.includes('cached-startup loader fade cleanup'), 'Once packaged images are load-complete with valid dimensions, a Chromium decode promise must remain opportunistic and never hold the visual reveal; the fake-Play smoke must force that race deterministically and separately verify background-throttled fade cleanup.');
assert(!rendererApp.includes('const preparedStatusResults = await Promise.allSettled') && rendererApp.includes('renderPreparedStartupStatuses(preparation, newsStatusResults, { artworkHydrated: true })'), 'Warm startup must reuse the News/status results already hydrated beside preparation instead of performing a second full status pass.');
assert(rendererApp.includes('if (initialState.initialized && !initialState.firstInitialization)') && rendererApp.includes('preparation = await window.aht.prepareStartup();') && rendererApp.indexOf('preparation = await window.aht.prepareStartup();') < rendererApp.indexOf('newsStatusResults = await loadNewsStatusResults(true);') && desktopMain.includes("const usePreparedPrerequisites = prepared?.state === 'ready';") && desktopMain.includes('? prepared.launcherConfig') && desktopMain.includes('? prepared.identity'), 'Warm startup must hydrate its trusted prerequisite entries before status rendering and reuse their launcher route and identity instead of repeating CurseForge/Minecraft discovery.');
assert(rendererApp.includes('{ preserveStatusPackageState: true }') && rendererApp.includes("['latest', 'installed', 'integrity', 'updateBlockedReason', 'updateRequired']"), 'Fresh startup feed state must remain authoritative for Install/Update UI when prepared Java and launcher readiness are merged.');
assert(desktopMain.includes('const updateLogsCache = new Map();') && desktopMain.includes('const updateLogsInFlight = new Map();') && desktopMain.includes("DURABLE_UPDATE_LOGS_CACHE_SCHEMA = 'aht-launcher-update-logs-cache/v1'") && desktopMain.includes('UPDATE_LOGS_NETWORK_TIMEOUT_MS = 8 * 1000') && desktopMain.includes('async function readDurableUpdateLogsCache()') && desktopMain.includes('options.preferCache && Array.isArray(durable?.logs)') && !desktopMain.includes('!safeLogs.length') && desktopMain.includes('const pendingRequest = updateLogsInFlight.get(requestKey);') && desktopMain.includes('async function prepareStartupPrerequisiteEntry') && desktopMain.includes('function startupPackPreparationForRenderer(descriptor, entry = null)') && desktopMain.includes('startupPackPreparationForRenderer(descriptor, results.get(descriptor.target.id))'), 'Warm startup must use durable last-known-good News, coalesce identical requests, prepare only saved Java/launcher prerequisites, and return cached update fields without another status pass.');
const prerequisitePreparationSource = desktopMain.slice(desktopMain.indexOf('async function prepareStartupPrerequisiteEntry'), desktopMain.indexOf('async function hydrateLaunchPreparationFromSnapshot'));
const persistedPreparationSource = desktopMain.slice(desktopMain.indexOf('async function persistPreparedLaunchEntry'), desktopMain.indexOf('async function publishCompletedUpdatePreparation'));
const startupPreparationSource = desktopMain.slice(desktopMain.indexOf('async function prepareAllPacksAtStartup'), desktopMain.indexOf('async function prepareLaunchForPack'));
const playStartSource = desktopMain.slice(desktopMain.indexOf("ipcMain.handle('play:start'"), desktopMain.indexOf("ipcMain.handle('dialog:zip'"));
assert(desktopMain.includes("STARTUP_PREREQUISITE_POLICY = 'java8-and-minecraft-launcher-paths/v2'") && prerequisitePreparationSource.includes('preparedLauncherRouteAvailable') && prerequisitePreparationSource.includes('preparedJava8RuntimeAvailable') && prerequisitePreparationSource.includes('launcherProof: null') && prerequisitePreparationSource.includes('proofPreparedThisSession: false') && !prerequisitePreparationSource.includes('scanCurrentManagedIntegrity') && !prerequisitePreparationSource.includes('scanPlayIntegrity') && !prerequisitePreparationSource.includes('verifyManagedIntegritySnapshot') && !prerequisitePreparationSource.includes('verifyPreparedRuntimeSnapshot') && !prerequisitePreparationSource.includes('createLaunchPreparationMutationMonitor') && !prerequisitePreparationSource.includes('armLaunchPreparationWatcher') && !startupPreparationSource.includes('performLaunchPreparation') && !startupPreparationSource.includes('hydrateLaunchPreparationFromSnapshot') && persistedPreparationSource.includes('launcherPaths: preparedLauncherPathsForSnapshot') && !persistedPreparationSource.includes('managedFiles:') && !persistedPreparationSource.includes('runtimeFiles:'), 'Startup must only reuse or rediscover Java 8 and Minecraft/CurseForge launcher paths; it must not scan, hash, inventory, or watch modpack/runtime files.');
assert(playStartSource.indexOf("'prepared-prerequisites'") < playStartSource.indexOf('const launcherOpening = openMinecraftLauncher') && playStartSource.indexOf('const launcherOpening = openMinecraftLauncher') < playStartSource.indexOf("'prepared-play-attestation'") && playStartSource.includes('managedFilesChecked: 0') && playStartSource.includes('runtimeFilesChecked: 0') && !playStartSource.includes('selectPreparedMinecraftLauncherProfile') && !playStartSource.includes('verifyManagedIntegritySnapshot') && !playStartSource.includes('verifyPreparedRuntimeSnapshot') && playStartSource.includes('proof = await refreshPreparedLauncherProof(key, prepared);'), 'Play must perform zero pack/runtime checks and zero profile metadata writes before immediately opening the saved launcher route, while proof refresh remains concurrent with handoff.');
assert(prerequisitePreparationSource.includes('cacheNeedsPersist') && prerequisitePreparationSource.includes('options.persist !== false && cacheNeedsPersist') && desktopMain.includes("STABLE_INSTALLED_PACK_IDS = new Set(['a-hard-time-dregora', 'a-hard-time'])") && desktopMain.includes('installedPackMatchesReleaseTarget(installed, target, cached?.latest)') && smokePlayerUpdatePlay.includes('warmAfter31Minutes') && smokePlayerUpdatePlay.includes('unrelatedConfigFilesIgnored: 1_500') && smokePlayerUpdatePlay.includes('warmPlayHandoffMs >= 500') && smokePlayerUpdatePlay.includes('launcherMetadataUnchangedByPlay: true'), 'An unchanged prerequisite cache must remain write-free and reusable after 31 minutes, stable pack-id aliases, managed-file metadata churn, and a large unrelated config tree; warm Play must remain sub-500 ms without metadata writes.');
assert(startupLoaderHtml.includes('class="startup-money-system money-loader-system"') && startupLoaderHtml.includes('class="startup-money-logo" src="assets/aht-bill-transparent.png"') && !startupLoaderHtml.includes('news-loader-globe') && (startupLoaderHtml.match(/startup-orbit-star startup-orbit-star-/g) || []).length === 8 && rendererPolishCss.includes('perspective: 260px;') && rendererPolishCss.includes('@keyframes startup-star-orbit-a') && rendererPolishCss.includes('@keyframes startup-star-orbit-b') && rendererPolishCss.includes('@keyframes startup-star-orbit-c'), 'The bottom-right startup indicator must use the AHT money logo with eight independently phased white stars moving on varied 3D planetary paths, never the former globe icon.');
assert(startupLoaderHtml.includes('id="startupLoaderLabel"') && startupLoaderHtml.includes('id="startupLoaderRule"') && startupLoaderHtml.includes('id="startupLoaderProgress"') && rendererApp.includes('? "Initializing"') && rendererApp.includes('els.startupLoaderRule.hidden = !startupFirstInitialization') && rendererPolishCss.includes('.startup-loader-rule') && rendererPolishCss.includes('.startup-loader-progress'), 'Only the persistent first-ever initialization path must show Initializing and a determinate progress rule beneath the AHT logo.');
const sidebarLoaderShowIndex = rendererApp.indexOf('setSidebarSwitchLoader(true, nextPack)');
const sidebarLoaderCommitHideIndex = rendererApp.indexOf('setSidebarSwitchLoader(false);', sidebarLoaderShowIndex);
const sidebarEnterFadeIndex = rendererApp.indexOf('incomingView?.classList.add("sidebar-view-entering-active")', sidebarLoaderShowIndex);
assert(rendererHtml.includes('id="sidebarSwitchLoader"') && rendererHtml.includes('class="sidebar-switch-loader"') && sidebarLoaderShowIndex >= 0 && sidebarLoaderCommitHideIndex > sidebarLoaderShowIndex && sidebarEnterFadeIndex > sidebarLoaderCommitHideIndex && rendererPolishCss.includes('.sidebar-switch-loader') && !rendererApp.includes('SIDEBAR_SWITCH_LOAD_HOLD_MS') && !rendererApp.includes('refreshPrepared(nextPack') && !rendererApp.includes('forcePreparation: nextPack'), 'Sidebar pack switches must show the bottom-right money animation only while status/selection is unresolved, then hide it at commit before the incoming Play action and fade.');
assert(rendererApp.includes('SIDEBAR_SWITCH_EXIT_DELAY_MS = 50') && rendererApp.includes('SIDEBAR_SWITCH_EXIT_MS = 180') && rendererApp.includes('SIDEBAR_SWITCH_ENTER_MS = 330') && rendererApp.includes('packStatusCache.get(nextPack)') && rendererApp.includes('window.aht.selectPreparedPlay(nextPack)') && rendererPolishCss.includes('.workspace > .view.sidebar-view-leaving') && rendererPolishCss.includes('.workspace > .view.sidebar-view-entering.sidebar-view-entering-active'), 'Sidebar switches must preserve the measured BSG opacity transition while using already-prepared status and only the lightweight profile-selection write.');
assert(preloadScript.includes('getStartupPreparationState') && preloadScript.includes('prepareStartup') && preloadScript.includes('onStartupPreparationProgress') && preloadScript.includes('selectPreparedPlay') && desktopMain.includes("ipcMain.handle('startup:get-state'") && desktopMain.includes("ipcMain.handle('startup:prepare'") && desktopMain.includes("ipcMain.handle('play:select-prepared'") && desktopMain.includes('STARTUP_PREPARATION_CACHE_SCHEMA') && desktopMain.includes('safeStorage.encryptString') && desktopMain.includes("createHmac('sha256'"), 'Startup preparation must be owned by main and persisted as an authenticated cache whose key is protected by the operating system.');
assert(packageScripts['test:startup-transition'] === 'node scripts/smoke-startup-sidebar-transition.mjs' && smokeStartupTransition.includes("Input.dispatchMouseEvent', { type: 'mousePressed'") && smokeStartupTransition.includes('statusStillPending') && smokeStartupTransition.includes('The launcher shell was revealed while News artwork was still pending') && smokeStartupTransition.includes('Warm startup waited for the held remote News response instead of using its durable last-known-good feed') && smokeStartupTransition.includes('agedNewsCacheMinutes: 31') && smokeStartupTransition.includes('31 * 60 * 1000') && smokeStartupTransition.includes('Startup fetched the identical News feed more than once') && smokeStartupTransition.includes('const quickSpawnedAt = Date.now()') && smokeStartupTransition.includes('The bottom-right money animation was not shown above the launcher as soon as the pack switch began') && smokeStartupTransition.includes('The loader did not remain visible while the pack switch was genuinely unresolved') && smokeStartupTransition.includes('The bottom-right money animation remained visible after the selected pack and Play action committed') && smokeStartupTransition.includes('The money loader overlapped the incoming pack view or Play action') && smokeStartupTransition.includes('Install and Update palettes were not distinct'), 'The startup/switch contract must have true-pointer source and installed-EXE smoke coverage for a 31-minute-old durable News cache during a held remote refresh, hydration, duplicate-fetch suppression, process-to-reveal timing, partial-load suppression, adaptive money-loader cleanup, transition phases, and both primary-action palettes.');
assert(rendererHtml.indexOf('id="statusBadge"') > rendererHtml.indexOf('class="launch-state-data"') && rendererPolishCss.includes('.launch-state-data { display: none; }'), 'Internal status text must remain available to diagnostics without appearing in the hero top-right.');
assert(rendererPolishCss.includes('-webkit-user-select: none;') && rendererPolishCss.includes('-webkit-user-drag: none;') && rendererApp.includes('document.addEventListener("selectstart"') && rendererApp.includes('document.addEventListener("dragstart"') && rendererApp.includes('String(event.key).toLowerCase() === "a"'), 'The launcher shell must block Ctrl+A, drag selection, and artwork dragging while preserving editable fields.');
assert(desktopMain.includes('CLIENT_GAME_SETTINGS_FILES.map') && desktopMain.includes('gameSettingsPresent') && rendererApp.includes('if (!currentStatus?.setup?.gameSettingsPresent)'), 'First install must skip the preserve-settings prompt when no player settings exist, using main-process filesystem truth.');
assert(localChangesSource.includes('const managed = managedFiles(loadedManaged') && localChangesSource.includes('const launchCritical = launchCriticalManagedFiles(managed)') && localChangesSource.includes('monitoredRoots: LAUNCH_CRITICAL_MONITORED_ROOTS') && !rendererApp.includes('managedFiles(loadedManaged'), 'Managed integrity must validate the full protected manifest and scan every launch-critical content root in the filesystem owner.');
assert(desktopMain.includes("integrity?.valid !== true || corrupted > 0") && desktopMain.includes('the quick startup snapshot was not authorized'), 'Update must never publish a trusted quick-start snapshot unless its full post-install managed-file verification is clean.');
assert(rendererHtml.includes('id="updateLogOverlay" class="news-article-surface"') && rendererHtml.indexOf('id="updateLogOverlay"') > rendererHtml.indexOf('<section id="news"') && rendererApp.includes('activateTab("news");') && rendererApp.includes('card.addEventListener("click", () => openUpdateLog(log))'), 'Home news cards must switch to News and open their exact in-tab article through one full-card action.');
assert(rendererApp.includes('let updateLogReturnContext = null;') && rendererApp.includes('tab: activeTabName === "news" ? "news" : "player"') && rendererApp.includes('packKey: activeSidebarPack') && rendererApp.includes('returnContext.tab === "player"') && rendererApp.includes('activateTab("player", { preserveNewsArticleTransition: true });') && rendererApp.includes('const backDestination = updateLogReturnContext?.tab === "player" ? "Game" : "News";') && rendererApp.includes('if (els.updateLogBottomBackButton) els.updateLogBottomBackButton.addEventListener("click", () => closeUpdateLog());') && smokePlayerUpdateLogs.includes("homeArticleProof.backLabel !== 'Back to Game'") && smokePlayerUpdateLogs.includes("backProof.ariaLabel !== 'Back to News'") && smokePlayerUpdateLogs.includes("'returned from home article to PTB Game home'") && smokePlayerUpdateLogs.includes("'returned from full article to PTB News feed'"), 'Article Back must retain its opening route: Game-card articles return to that selected pack Game home, while News-feed articles return to that selected pack News feed through the shared Back handler.');
assert(!rendererHtml.includes('class="news-view-header"') && !rendererHtml.includes('class="news-feed-state"') && !rendererHtml.includes('id="newsLatestLabel"') && !rendererHtml.includes('id="updateLogWatchButton"') && rendererHtml.includes('id="updateLogHeroPlay"'), 'News must use the restrained article stream without dashboard badges, redundant read buttons, or a separate watch button.');
assert(rendererApp.includes('document.createElement(surface === "news" ? "article" : "button")') && rendererApp.includes('openButton.className = "news-card-open"') && rendererApp.includes('likeButton.className = "news-like-button news-card-like"') && !rendererApp.includes('feature-copy-button') && !rendererApp.includes('feature-art-button') && !rendererApp.includes('feature-cta'), 'News entries must expose separate accessible article and like actions without nested buttons or redundant CTAs.');
assert(rendererApp.includes('function buildNewsFeatureCarousel') && rendererApp.includes('function selectNewsCarouselSlide') && rendererApp.includes('function playNewsCarouselMedia') && rendererApp.includes('function transitionNewsSurface') && rendererHtml.includes('class="news-transition-loader"') && rendererHtml.includes('id="updateLogInlineMedia"') && rendererPolishCss.includes('.news-carousel-caption') && rendererPolishCss.includes('filter: brightness(1.1);') && rendererPolishCss.includes('.news-feed-card:not(.large):focus-within .feature-art') && rendererPolishCss.includes('.news-feed-card:active') && rendererPolishCss.includes('.update-log-article-footer {') && rendererPolishCss.includes('.news-view.is-transitioning:not(.is-transition-entering) .news-transition-loader {\n  opacity: 0.92;\n  transition: none;') && smokePlayerUpdateLogs.includes('fillerGeometryProof') && smokePlayerUpdateLogs.includes('leadHomeRestored') && smokePlayerUpdateLogs.includes('ensurePointerHoverOrFocus') && smokePlayerUpdateLogs.includes("await client.call('CSS.forcePseudoState'") && smokePlayerUpdateLogs.includes("return 'cdp-forced-hover';"), 'News must preserve the accepted dedicated-page carousel, inline media, transition-loader pocket, pointer/keyboard thumbnail lighting, deterministic native hover proof, and the separately scoped Game-card regression proof.');
assert(!rendererApp.includes('installPointerLighting') && !rendererApp.includes('POINTER_LIGHT_SELECTOR') && !rendererCss.includes('.pointer-light-surface') && !rendererCss.includes('--pointer-x') && rendererCss.includes('.game-tile.active::before {\n  content: none;'), 'Launcher chrome must not create a cursor-following spotlight or clipped rectangular bloom.');
assert(desktopMain.includes('width: 1432') && desktopMain.includes('height: 760') && desktopMain.includes('minWidth: 1432') && desktopMain.includes('maxWidth: 1432') && desktopMain.includes('minHeight: 760') && desktopMain.includes('maxHeight: 760') && desktopMain.includes('resizable: false') && desktopMain.includes('maximizable: false') && desktopMain.includes('fullscreenable: false') && desktopMain.includes('frame: false'), 'Player launcher must be a fixed 1432x760 frameless window with no resize, maximize, or fullscreen path.');
const windowControlsIndex = rendererHtml.indexOf('<div class="window-controls"');
assert(
  rendererHtml.includes('id="developerWindowDragRegion"')
    && windowControlsIndex > rendererHtml.indexOf('<main class="app-frame"')
    && windowControlsIndex < rendererHtml.indexOf('<aside class="sidebar"')
    && rendererHtml.includes('id="windowMinimizeButton"')
    && rendererHtml.includes('id="windowCloseButton"')
    && rendererCss.includes('body.dev-mode .developer-window-drag-region')
    && rendererCss.includes('-webkit-app-region: drag;')
    && rendererCss.includes('body.dev-mode .window-controls')
    && rendererCss.includes('body.dev-mode .dev-login-screen,')
    && rendererCss.includes('body.dev-mode .dev-console')
    && /\.topbar\s*\{[\s\S]*?padding:\s*0;/.test(rendererPolishCss)
    && !/\.brand,\s*\.topbar\s*\{[^}]*-webkit-app-region:/.test(rendererCss)
    && !/\.brand,\s*\.topbar\s*\{[^}]*-webkit-app-region:/.test(rendererPolishCss)
    && /\.developer-window-drag-region\s*\{[\s\S]*?right:\s*56px;[\s\S]*?height:\s*28px;[\s\S]*?-webkit-app-region:\s*drag;/.test(rendererPolishCss)
    && /body\.dev-mode \.developer-window-drag-region\s*\{[\s\S]*?right:\s*68px;[\s\S]*?height:\s*34px;/.test(rendererPolishCss)
    && /\.window-controls\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*1001;/.test(rendererPolishCss)
    && preloadScript.includes('windowMinimize')
    && preloadScript.includes('windowClose')
    && desktopMain.includes("ipcMain.handle('window:minimize'")
    && desktopMain.includes("ipcMain.handle('window:close'"),
  'Frameless player and developer launchers must provide persistent custom minimize/close controls plus a dedicated drag strip that ends before their complete hitboxes.'
);
const brandHtml = rendererHtml.slice(rendererHtml.indexOf('<div class="brand">'), rendererHtml.indexOf('<div class="game-list">'));
assert(!brandHtml.includes('<strong>A Hard Time</strong>') && !brandHtml.includes('<span>Launcher</span>') && brandHtml.includes('id="launcherVersionLabel"'), 'Top-left branding must keep only the backlit logo and running Launcher version text.');
assert(!rendererHtml.includes('AHT account') && rendererHtml.includes('id="syncStatus"><span class="online-dot"></span>Online') && rendererCss.includes('.profile-card:focus-visible') && rendererCss.includes('border: 0;'), 'Top-right profile must use borderless player/Online treatment with the adjacent dropdown arrow.');
assert(!rendererCss.includes('.feature-art.aht-art::after') && !rendererCss.includes('content: "A HARD TIME";'), 'The first news-card artwork must never synthesize an A HARD TIME text overlay.');
assert(rendererCss.includes('.feature-art.aht-art::before') && !rendererCss.includes('\n.aht-art::before'), 'AHT cover-art lighting overlay must only apply to large update-log art, not sidebar thumbnails.');
assert(fs.existsSync(new URL('../desktop/renderer/assets/aht-cover.png', import.meta.url)), 'Full cover art asset must exist.');
assert(fs.existsSync(new URL('../desktop/renderer/assets/aht-bill-transparent.png', import.meta.url)), 'Transparent bill art asset must exist.');
assert(fs.existsSync(new URL('../desktop/renderer/assets/launcher-background.png', import.meta.url)), 'Launcher background asset must exist.');
assert(fs.existsSync(new URL('../desktop/renderer/assets/aht-vine-logo.png', import.meta.url)), 'Supplied A Hard Time vine footer logo must exist.');
assert(fs.existsSync(new URL('../desktop/renderer/assets/bsg-button-huge-light-1.png', import.meta.url)) && fs.existsSync(new URL('../desktop/renderer/assets/bsg-button-huge-light-2.png', import.meta.url)), 'The native BSG footer bloom assets must exist.');
const launcherBackgroundSize = pngDimensions('desktop/renderer/assets/launcher-background.png');
assert(launcherBackgroundSize.width === 2240 && launcherBackgroundSize.height === 1520, `Launcher background must be pre-cropped to 2x the default launcher ratio, got ${launcherBackgroundSize.width}x${launcherBackgroundSize.height}.`);
const vineLogoSize = pngDimensions('desktop/renderer/assets/aht-vine-logo.png');
assert(vineLogoSize.width === 2240 && vineLogoSize.height === 1088, `Supplied vine footer logo must retain its original 2240x1088 canvas, got ${vineLogoSize.width}x${vineLogoSize.height}.`);
assert(fileSha256('desktop/renderer/assets/aht-vine-logo.png') === '68F31F78CF0A9B5780CEB92E41DBEED4FD92A532CA2FEC50C1821D323AED3872', 'Supplied vine footer logo must remain byte-identical to the user asset.');
for (const [relativePath, expectedSha256] of [
  ['desktop/renderer/assets/bsg-button-huge-light-1.png', 'A2BF4736D2C80F99602F2507A55F005B542F72E560391A9AE532F48F828AAD1E'],
  ['desktop/renderer/assets/bsg-button-huge-light-2.png', 'BDD12A413444DAB8DA35FAB614DCA3853D9CEB3D40EB08A16F76CAF764E0DC40']
]) {
  const size = pngDimensions(relativePath);
  assert(size.width === 809 && size.height === 413, `${relativePath} must retain the native 809x413 BSG footprint.`);
  assert(fileSha256(relativePath) === expectedSha256, `${relativePath} must remain byte-identical to the native BSG bloom asset.`);
}
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
assert(developerOnlySourceFiles.length === 6, 'Regular player package developer-only source files must be declared.');
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
assert(readText(new URL('../src/releaseBuilder.js', import.meta.url)).includes('process.env.AHT_LAUNCHER_SOURCE_ROOT') && readText(new URL('../src/releaseBuilder.js', import.meta.url)).includes('process.env.INIT_CWD'), 'Packaged developer release builder must find local server helper jars without packaging server-lock-mod.');
assert(!fs.existsSync(new URL('../config/launcher.config.example.json', import.meta.url)), 'Stale developer-shaped launcher.config.example.json must stay removed.');
assert(!releaseWorkflow.includes('public/**'), 'Launcher build workflow must not trigger on removed web UI files.');
for (const stalePath of ['../installer.js', '../main.js', '../clientPackFormat.js', '../src/cli.js', '../src/web.js', '../public/index.html', '../scripts/build-release.sh', '../scripts/serve-release.sh', '../scripts/start-ui.sh', '../src/previewRenderer.js']) {
  assert(!fs.existsSync(new URL(stalePath, import.meta.url)), `${stalePath} must stay removed; use the Electron app and developer UI instead.`);
}
assert(packageScripts['verify:local'] === 'node scripts/verify-local.mjs', 'verify:local must use scripts/verify-local.mjs.');
assert(packageScripts['verify:installed-player'] === 'node scripts/verify-installed-player.mjs', 'verify:installed-player must run the installed player launcher smoke suite.');
assert(packageScripts['test:player-update-play'] === 'node scripts/smoke-player-update-play-flow.mjs', 'Regular player update/play smoke must stay wired as an npm script.');
assert(packageScripts['test:social-client'] === 'node scripts/test-social-client.mjs', 'Authenticated social client contract test must stay wired.');
assert(packageScripts['test:social-worker'] === 'node scripts/test-worker-social.mjs', 'Worker social bridge contract test must stay wired.');
assert(packageScripts['test:friends-panel'] === 'node scripts/smoke-friends-panel.mjs', 'Friends panel Electron smoke must stay wired.');
assert(packageScripts['test:legal-consent'] === 'node scripts/test-legal-consent.mjs' && packageScripts['test:legal-panel'] === 'node scripts/smoke-legal-consent-panel.mjs', 'Legal consent contract and Electron panel smokes must stay wired.');
assert(verifyLocalScript.includes("['test:player-update-play']"), 'verify:local must run the fresh-player update/play smoke.');
assert(verifyLocalScript.includes("['test:download-retry']"), 'verify:local must run the retrying download smoke.');
assert(verifyLocalScript.includes("['test:social-client']") && verifyLocalScript.includes("['test:social-worker']") && verifyLocalScript.includes("['test:friends-panel']"), 'verify:local must cover the social client, Worker bridge, and rendered panel.');
assert(verifyLocalScript.includes("['test:legal-consent']") && verifyLocalScript.includes("['test:legal-panel']"), 'verify:local must cover versioned consent storage and rendered clickwrap.');
assert(rendererHtml.includes('id="profileFriendsButton"') && rendererHtml.includes('aria-controls="friendsOverlay"'), 'Top-right player profile must be a keyboard-accessible friends dialog trigger.');
assert(rendererHtml.includes('id="friendsCount"') && rendererHtml.includes('id="friendsOnlineCount"') && rendererHtml.includes('id="friendsRequestsList"'), 'Friends panel must show friend, online, and request views.');
assert(!rendererApp.includes('runFriendAction("add_friend")') && !rendererApp.includes('"block_player"') && !rendererApp.includes('"unblock_player"'), 'Renderer must not expose launcher add, block, or unblock actions.');
assert(rendererHtml.includes('id="profileFriendsBadge"') && rendererHtml.includes('id="friendsRequestsList"') && !rendererHtml.includes('id="addFriendButton"') && !rendererHtml.includes('id="blockPlayerButton"'), 'Friends UI must expose the unread request badge without mutation inputs.');
assert(preloadScript.includes("ipcRenderer.invoke('social:list')") && preloadScript.includes("ipcRenderer.invoke('social:action'"), 'Preload must expose social IPC without exposing credentials.');
assert(desktopMain.includes("ipcMain.handle('social:list'") && desktopMain.includes("ipcMain.handle('social:action'") && desktopMain.includes('writeRegisteredLauncherProof'), 'Main process must authenticate social reads and actions with a registered launcher proof.');
assert(socialClientSource.includes("'accept_friend'") && socialClientSource.includes("'decline_friend'") && !socialClientSource.includes("'block_player'"), 'Social client action allowlist must be limited to request responses.');
assert(workerSource.includes("'accept_friend'") && workerSource.includes("'decline_friend'") && !workerSource.includes("'block_player'"), 'Worker must enforce request-only launcher actions.');
assert(workerSource.includes("'/server/social/sync'") && workerSource.includes("'/api/social/actions'") && workerSource.includes('aht-linux'), 'Worker must enforce the signed Linux social bridge route.');
assert(friendsPanelSmoke.includes("actionNames !== 'accept_friend,decline_friend'") && friendsPanelSmoke.includes("Object.keys(entry).sort().join(',') !== 'action,target'"), 'Friends panel smoke must prove request-only actions and prevent renderer identity payloads.');
assert(configs.windows.nsis?.license === 'legal/TERMS_OF_SERVICE.txt', 'Windows assisted installer must present the AHT Terms before installation.');
assert(configs.macos.dmg?.license === 'legal/TERMS_OF_SERVICE.txt', 'macOS DMG must present the AHT Terms before installation.');
assert(commonBuilder.regularPlayerConfig({ productName: 'x', output: 'x', target: 'x' }).files.includes('legal/**/*'), 'Regular player packages must include the legal documents used by runtime consent.');
assert(commonBuilder.regularPlayerConfig({ productName: 'x', output: 'x', target: 'x' }).files.includes('build/icon.png') && !commonBuilder.regularPlayerConfig({ productName: 'x', output: 'x', target: 'x' }).files.includes('build/**/*'), 'Player app.asar must include only the runtime icon, not installer/build sources.');
assert(rendererHtml.includes('id="legalOverlay"') && rendererHtml.includes('id="legalAcceptCheckbox"') && rendererHtml.includes('id="legalAcceptButton"'), 'Player UI must contain explicit versioned clickwrap controls.');
assert(preloadScript.includes("ipcRenderer.invoke('legal:status')") && preloadScript.includes("ipcRenderer.invoke('legal:accept'"), 'Preload must expose legal status and acceptance IPC.');
assert(desktopMain.includes("ipcMain.handle('legal:status'") && desktopMain.includes("ipcMain.handle('legal:accept'"), 'Main process must own legal document loading and consent persistence.');
assert(legalConsentSource.includes("TERMS_VERSION = '2026-07-14.1'") && legalConsentSource.includes("PRIVACY_VERSION = '2026-08-23.1'") && legalConsentSource.includes('termsSha256') && legalConsentSource.includes('privacySha256') && !legalConsentSource.includes('&& consent.termsSha256 ===') && !legalConsentSource.includes('&& consent.privacySha256 ==='), 'Consent records must retain document hashes for audit while only explicit legal-version changes can trigger a new acceptance prompt.');
assert(legalPanelSmoke.includes("AHT_TEST_REQUIRE_LEGAL: '1'") && legalPanelSmoke.includes("acceptDisabled"), 'Legal panel smoke must prove the unchecked acceptance gate.');
assert(termsText.includes('not a government fine') && termsText.includes('non-waivable right to defend a claim'), 'Terms must qualify contractual remedies and preserve non-waivable defenses.');
assert(privacyText.includes('IP address') && privacyText.includes('blocked players') && privacyText.includes('does not sell personal information'), 'Privacy Policy must disclose launcher/server/web data and no-sale practice.');
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
assert(checkProductionReadiness.includes('live launcher update feed matches local version') && checkProductionReadiness.includes('liveLauncherVersion === localLauncherVersion'), 'Production readiness must block when the hosted launcher update feed is older than the local package version.');
assert(checkProductionReadiness.includes('live Worker player-data API is current') && checkProductionReadiness.includes('/admin/player-records') && checkProductionReadiness.includes('/admin/launcher-updates'), 'Production readiness must fail when the deployed Worker is missing the current player-data read routes.');
assert(checkProductionReadiness.includes('live launcher Windows download matches local artifact') && checkProductionReadiness.includes('localWindowsLauncherArtifact') && checkProductionReadiness.includes('liveWindowsSha === localWindowsSha') && checkProductionReadiness.includes('liveWindowsSize === localWindowsSize'), 'Production readiness must block when the hosted Windows launcher download hash/size differs from the local artifact.');
assert(checkProductionReadiness.includes('live launcher Windows staged update matches local artifact') && checkProductionReadiness.includes("localWindowsLauncherArtifact(localLauncherVersion, 'zip')") && checkProductionReadiness.includes('liveWindowsUpdateSha === localWindowsUpdateSha'), 'Production readiness must also bind the hosted Windows staged-update ZIP to the local artifact.');
assert(checkProductionReadiness.includes('function windowsAuthenticodeStatus') && checkProductionReadiness.includes('Windows Authenticode: ${label}') && checkProductionReadiness.includes("signature.status === 'Valid'") && checkProductionReadiness.includes("signature.status === 'NotSigned'") && checkProductionReadiness.includes('explicitly unsigned publication policy') && checkProductionReadiness.includes('only Valid or NotSigned is permitted'), 'Production readiness must warn for explicitly unsigned Windows artifacts while blocking invalid signature states.');
assert(checkProductionReadiness.includes('api/launcher-proof/status') && checkProductionReadiness.includes('json.privateKeyConfigured === true') && checkProductionReadiness.includes('json.publicKeyConfigured === true') && checkProductionReadiness.includes('json.algorithm === "RS256"') && checkProductionReadiness.includes('json.signingVerified === true') && workerSource.includes('LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8') && workerSource.includes('LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI') && !checkProductionReadiness.includes('AHTProofCheck') && !checkProductionReadiness.includes('api/users/register'), 'Production readiness must require the Worker read-only external RS256 launcher-attestation self-test without creating synthetic player records.');
assert(checkProductionReadiness.includes('stalePackFeed && staleLauncherFeed') && checkProductionReadiness.includes('publish an exact AHT client ZIP release and a launcher update'), 'Production readiness must report both stale pack and launcher feed blockers when both are present.');
assert(checkProductionReadiness.includes("from './validate-launcher-update-manifest.mjs'") && checkProductionReadiness.includes('function validateLauncherDownloads') && checkProductionReadiness.includes('validateLauncherUpdateManifest(manifest') && checkProductionReadiness.includes('live launcher update feed has one Windows, one universal macOS, and one Linux download'), 'Production readiness must use the reusable strict launcher manifest validator for live launcher update feeds.');
assert(checkProductionReadiness.includes("names.includes('live launcher update feed has one Windows, one universal macOS, and one Linux download')"), 'Production readiness next-step guidance must route missing launcher downloads to a launcher update publish.');
assert(launcherUpdateManifestTest.includes('validateLauncherUpdateManifest(manifest') && launcherUpdateManifestTest.includes('generated launcher manifest failed reusable validation'), 'Launcher update manifest test must reuse the manifest validator.');
assert(launcherUpdateManifestValidator.includes("from '../src/launcherUpdateManifest.js'") && launcherUpdateManifestValidator.includes('validateLauncherUpdateManifestFile'), 'Launcher update manifest CLI must wrap the shared runtime validator.');
assert(launcherUpdateManifestSource.includes("'macos-universal', 'ubuntu-x64-appimage'") && launcherUpdateManifestSource.includes('REQUIRED_STAGED_WINDOWS_KEYS') && launcherUpdateManifestSource.includes('REQUIRED_STAGED_LINUX_KEYS') && launcherUpdateManifestSource.includes('manual downloads contain unexpected keys') && launcherUpdateManifestSource.includes("isPortableDownload ? 'appimage' : 'deb'") && launcherUpdateManifestSource.includes('must include /S silent install args'), 'Launcher update manifest validator must lock one Windows, one universal macOS, and one legacy-readable portable Linux download plus compatibility update formats.');
assert(prepareLauncherUpdateScript.includes('escapeRegExp(version)') && prepareLauncherUpdateScript.includes('AHT-Launcher-Windows-10-11-${artifactVersion}') && prepareLauncherUpdateScript.includes('AHT-Launcher-macOS-universal-${artifactVersion}') && prepareLauncherUpdateScript.includes('AHT-Launcher-Linux-x64-${artifactVersion}'), 'Launcher update prep must only select Windows, universal macOS, and Linux artifacts matching the package version.');
assert(prepareLauncherUpdateScript.includes('function requireHttpsLatestUrl') && prepareLauncherUpdateScript.includes('Launcher update latest URL must be HTTPS'), 'Launcher update prep must reject non-HTTPS latest URLs before generating manifests.');
assert(launcherUpdateManifestSource.includes('fileNameMatchesVersion') && launcherUpdateManifestSource.includes('fileName must include launcher version'), 'Launcher update validator must reject stale artifact filenames that do not match the manifest version.');
assert(launcherUpdateManifestSource.includes('path basename must match fileName') && launcherUpdateManifestSource.includes('url basename must match fileName'), 'Launcher update validator must ensure paths and URLs point to the declared artifact fileName.');
assert(launcherUpdateManifestSource.includes('function isAllowedArtifactUrl') && launcherUpdateManifestSource.includes("url.protocol === 'https:'") && launcherUpdateManifestSource.includes('allowInsecureLocalhost'), 'Launcher update validator must require HTTPS artifact URLs except explicit localhost smoke tests.');
assert(launcherUpdateManifestSource.includes('assertLauncherReleaseAdvance') && launcherUpdateManifestSource.includes('already published') && launcherReleaseImmutabilityCheck.includes('Could not prove launcher release immutability'), 'Launcher publication must fail closed before replacing an existing or newer published version.');
assert(desktopMain.includes('assertWindowsLauncherPublishSignatureState') && desktopMain.includes('Get-AuthenticodeSignature') && desktopMain.includes("status !== 'Valid' && status !== 'NotSigned'") && desktopMain.includes('explicitlyUnsigned') && desktopMain.includes('assertLauncherPublishAdvance'), 'Developer launcher publication must accept only Valid or explicitly NotSigned Windows artifacts and a strictly newer immutable release version.');
assert(launcherUpdateManifestTest.includes('stale launcher artifact filenames') && launcherUpdateManifestTest.includes('path basename must match fileName') && launcherUpdateManifestTest.includes('non-HTTPS launcher artifact URLs') && launcherUpdateManifestTest.includes('non-HTTPS latest URLs') && launcherUpdateManifestTest.includes('artifacts that do not match the manifest/package version'), 'Launcher update manifest test must cover stale artifact filename, path, URL, and HTTPS rejection.');
assert(releaseWorkflow.includes('name: Test launcher update manifest') && releaseWorkflow.includes('npm run test:launcher-update-manifest'), 'GitHub launcher publish workflow must run the launcher update manifest test before publishing release data.');
assert(releaseWorkflow.includes('name: Install publishing dependencies') && releaseWorkflow.includes('run: npm ci'), 'GitHub launcher publish job must install the pinned dependencies needed by manifest upload and Worker deployment scripts.');
assert(releaseWorkflow.includes('name: Validate generated launcher update manifest') && releaseWorkflow.includes('node scripts/validate-launcher-update-manifest.mjs ci-launcher-update/launcher/latest.json --latest-url "$AHT_LAUNCHER_UPDATE_URL"'), 'GitHub launcher publish workflow must validate the generated launcher/latest.json before creating releases or uploading R2.');
assert(releaseWorkflow.includes('WINDOWS_CERTIFICATE_BASE64') && releaseWorkflow.includes('WINDOWS_CERTIFICATE_PASSWORD') && releaseWorkflow.includes('WINDOWS_CERTIFICATE_NAME'), 'Windows public builds must accept dedicated Authenticode certificate secrets.');
assert(
  releaseWorkflow.includes('Get-AuthenticodeSignature')
    && releaseWorkflow.includes('$validSignaturePair')
    && releaseWorkflow.includes('$unsignedSignaturePair')
    && releaseWorkflow.includes('Publishing an explicitly unsigned Windows release')
    && releaseWorkflow.includes('Refusing to publish invalid, untrusted, or inconsistently signed Windows artifacts.'),
  'The public workflow must accept only consistently Valid or consistently NotSigned Windows artifact pairs.'
);
assert(releaseWorkflow.includes('npm run security:audit') && packageScripts['security:audit']?.includes('npm audit signatures'), 'Public builds must pass dependency vulnerability and registry-signature audits.');
assert(
  releaseWorkflow.includes('arch: x64')
    && releaseWorkflow.includes('machine: x86_64')
    && releaseWorkflow.includes('machine: arm64')
    && releaseWorkflow.includes('expected_machine=${{ matrix.machine }}')
    && releaseWorkflow.includes('test "$(uname -m)" = "${{ matrix.machine }}"'),
  'Native macOS validation must distinguish the Intel uname machine value from the x64 Electron artifact label.'
);
assert(releaseWorkflow.includes('Enforce immutable launcher versions') && releaseWorkflow.includes('check-launcher-release-immutability.mjs') && !releaseWorkflow.includes('--clobber'), 'Public launcher releases must reject an existing version and never clobber release assets.');
assert(packageJson.dependencies?.['adm-zip'] === '^0.6.0' && packageJson.devDependencies?.electron === '^42.10.1', 'Launcher ZIP/runtime and Electron dependencies must stay on the audited security baselines.');
assert(releaseWorkflow.includes('"scripts/validate-launcher-update-manifest.mjs"'), 'GitHub workflow path triggers must include the generated-manifest validator.');
assert(!releaseWorkflow.includes('launcher_version') && !releaseWorkflow.includes('set-package-version.mjs'), 'GitHub launcher workflow must not expose or apply a manual launcher version override.');
assert(!githubActionsSource.includes('launcher_version') && !desktopMain.includes('launcherVersion: version'), 'Developer launcher update dispatch must let GitHub Actions read package.json from the selected branch.');
assert(desktopMain.includes('function isFullClientRelease') && desktopMain.includes('function requirePlayerFullClientRelease') && desktopMain.includes('playerUpdateBlockedReason'), 'Regular player update/play must block non-exact client ZIP releases before download or launch.');
assert(desktopMain.includes('updateBlockedReason') && rendererApp.includes('status.updateBlockedReason'), 'Renderer status must expose and honor player update blocks.');
assert(smokePlayerUpdatePlay.includes('Legacy feed should be blocked before player install') && smokePlayerUpdatePlay.includes('Legacy feed started downloading pack files before being blocked'), 'Fresh-player smoke must prove legacy feeds are blocked before download.');
assert(smokePlayerUpdatePlay.includes('function waitForCleanScanUiReset') && smokePlayerUpdatePlay.includes('clean scan UI reset after update') && smokePlayerUpdatePlay.includes("document.querySelector('#scanButton')?.click()") && smokePlayerUpdatePlay.includes("document.querySelector('#sidebarProgress')") && smokePlayerUpdatePlay.includes("last.badge === 'Ready' && last.diff === 'Clean' && last.progressHidden && !last.scanDisabled && !last.playDisabled"), 'Fresh-player smoke must prove a clean Scan returns the UI to Ready/Clean with progress hidden and buttons enabled.');
assert(!installerSource.includes("from './clientModpackZip.js'") && installerSource.includes("from './clientPackFormat.js'"), 'Player installer must import full-client ZIP constants from packaged runtime source, not developer-only clientModpackZip.');
assert(installerSource.includes("'logs/launcher'") && installerSource.includes("'.aht-launcher/account-recovery'"), 'Full and delta install swaps must preserve AHT launch reports and secure account-recovery credentials.');
assert(checkProductionReadiness.includes('function forbiddenRuntimeImportHits') && checkProductionReadiness.includes('src/installer.js') && checkProductionReadiness.includes('clientModpackZip.js') && checkProductionReadiness.includes('includes required player runtime modules') && checkProductionReadiness.includes('src/clientPackFormat.js'), 'Production readiness must catch packaged ASAR runtime imports of missing developer-only modules.');
const verifyScripts = [...verifyLocalScript.matchAll(/\['([^']+)'\]/g)].map((match) => match[1]);
const missingVerifyScripts = verifyScripts.filter((name) => !packageScripts[name]);
assert(missingVerifyScripts.length === 0, `verify:local references missing npm scripts: ${missingVerifyScripts.join(', ')}`);
const missingScriptTargets = Object.entries(packageScripts)
  .flatMap(([name, command]) => scriptTargetExists(String(command)).map((target) => `${name}:${target}`));
assert(missingScriptTargets.length === 0, `Package scripts point at missing node targets: ${missingScriptTargets.join(', ')}`);
assert(wranglerSmokeIsolationFailures.length === 0, `Wrangler smoke fakes must explicitly override the CLI command instead of relying on PATH precedence: ${wranglerSmokeIsolationFailures.join(', ')}`);
const packagedDeveloperSmokeScripts = [
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
  const source = readText(new URL(`../${relativePath}`, import.meta.url));
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
  "../src/githubModpackRelease.js",
  "../src/r2DirectUpload.js"
]) {
  assert(!desktopMain.includes(`from '${developerOnlyImport}'`) && !desktopMain.includes(`from \"${developerOnlyImport}\"`), `${developerOnlyImport} must not be imported at main-process startup.`);
}
assert(desktopMain.includes('async function importDeveloperModule(appRelativePath)') && desktopMain.includes('pathToFileURL'), 'Developer-only modules must resolve from the local source repo when excluded from the public player package.');
assert(desktopMain.includes("function loadReleaseBuilderModule()") && desktopMain.includes("importDeveloperModule('../src/releaseBuilder.js')"), 'Release builder must be lazy-loaded for developer actions.');
assert(desktopMain.includes("function loadClientModpackZipModule()") && desktopMain.includes("importDeveloperModule('../src/clientModpackZip.js')"), 'Exact client ZIP helpers must be lazy-loaded for developer actions.');
assert(desktopMain.includes("function loadR2DirectUploadModule()") && desktopMain.includes("importDeveloperModule('../src/r2DirectUpload.js')"), 'Direct R2 upload must be lazy-loaded for developer actions.');
assert(desktopMain.includes("function loadGithubActionsModule()") && desktopMain.includes("importDeveloperModule('../src/githubActions.js')"), 'GitHub workflow helpers must be lazy-loaded for developer actions.');
assert(desktopMain.includes("function loadGithubModpackReleaseModule()") && desktopMain.includes("importDeveloperModule('../src/githubModpackRelease.js')"), 'GitHub modpack release helpers must be lazy-loaded for developer actions.');
assert(desktopMain.includes("function loadServerTransferModule()") && desktopMain.includes("importDeveloperModule('../src/serverTransfer.js')"), 'Server transfer helpers must be lazy-loaded for developer actions.');
assert(desktopMain.includes("import fsSync from 'node:fs';"), 'Launcher mode detection must import fsSync.');
assert(desktopMain.includes("app.setPath('userData', path.join(app.getPath('appData'), 'aht-launcher-developer'))"), 'Developer mode must use separate local app data.');
assert(desktopMain.includes("app.requestSingleInstanceLock({ mode: launchMode })"), 'Single-instance lock must be split by launch mode.');
assert(desktopMain.includes("legacyDeveloperSecretsPath()"), 'Developer mode must migrate existing local secrets from the old app data folder.');
assert(
  desktopMain.includes('migrateDeveloperEncryptionProfile()')
    && desktopMain.includes("if (fsSync.existsSync(currentLocalState)) return;")
    && desktopMain.includes('localStateEncryptionFingerprintSync')
    && desktopMain.includes('sameStoredDeveloperSecrets(currentSecrets, entry.secrets)')
    && desktopMain.includes('fsSync.constants.COPYFILE_EXCL')
    && desktopMain.includes('storedDeveloperSecretsDecryptable(file)')
    && desktopMain.includes("'developer.credentials.json', 'device-identity.json'")
    && !desktopMain.includes('developerSecretsUseLegacyKey'),
  'Developer encryption migration must never replace a live Local State from ciphertext counts, and vault snapshots must pair only decryptable records with their exact profile companions.'
);
assert(desktopMain.includes("saveDeveloperSecretField(next, secrets, 'launcherProofSecret')"), 'Developer secrets must not be wiped by empty password fields.');
assert(desktopMain.includes("saveDeveloperSecretField(next, secrets, 'socialServerSecret')"), 'The dedicated server social secret must be persisted in the encrypted developer secret store.');
assert(desktopMain.includes('function writeDeveloperSecretVaultSnapshot') && desktopMain.includes("'developer-secret-vault'") && desktopMain.includes("'snapshots'"), 'Developer credentials must have an update-proof encrypted vault outside replaceable app user data.');
assert(!/if \(!value\) \{\s*delete next\.secrets\[key\]/.test(desktopMain), 'Blank developer form values must never delete existing credentials.');
assert(desktopMain.includes("prefix: ['--silent', 'dlx', 'wrangler@4']") && desktopMain.includes('AHT_WRANGLER_COMMAND'), 'Developer cloud tooling must support pnpm Wrangler when global npx is unavailable.');
assert(desktopMain.includes("const name = process.platform === 'win32' ? 'gh.exe' : 'gh';"), 'Windows GitHub CLI fallback must resolve the real gh.exe executable.');
assert(desktopMain.includes('launcherProof: { ...current.launcherProof, ...nextConfig.launcherProof }'), 'Saved settings must merge launcher proof settings instead of replacing them.');
assert(desktopMain.includes('function rendererStatusConfig(config = {})') && desktopMain.includes('const { developer, serverTransfer, ...safeConfig } = config;'), 'Player status must not expose developer or server-transfer config.');
for (const [label, source] of Object.entries({ desktopMain, rendererApp, rendererHtml })) {
  for (const privateFragment of ['C:\\RL CRAFT SERVER LIST', '192.168.1.121', 'notevil', '/home/notevil']) {
    assert(!source.includes(privateFragment), `${label} must not ship private local server-transfer defaults: ${privateFragment}`);
  }
}
assert(desktopMain.includes("openMacMinecraftLauncher(cwd, env)"), 'macOS play must use the macOS Minecraft Launcher opener.');
assert(desktopMain.includes("async function macOpenCommand()") && desktopMain.includes("const absoluteOpen = '/usr/bin/open'") && desktopMain.includes("return await pathExists(absoluteOpen) ? absoluteOpen : 'open';"), 'macOS opener must prefer absolute /usr/bin/open so Finder-launched apps do not depend on PATH.');
assert(desktopMain.includes("'/Applications/Minecraft.app'"), 'macOS opener must try the normal Minecraft.app path.');
assert(desktopMain.includes("'/Applications/Minecraft Launcher.app'"), 'macOS opener must try the legacy Minecraft Launcher.app path.');
assert(desktopMain.includes("['-b', 'com.mojang.minecraftlauncher']") && desktopMain.includes("['-b', 'com.microsoft.minecraftlauncher']"), 'macOS opener must try Mojang and Microsoft Minecraft Launcher bundle IDs.');
assert(desktopMain.includes("['-a', 'Minecraft']") && desktopMain.includes("['-a', 'Minecraft Launcher']"), 'macOS opener must fall back to both Minecraft app names.');
assert(desktopMain.includes("[appPath, '--args', '--workDir', cwd]") && desktopMain.includes("[...args, '--args', '--workDir', cwd]"), 'macOS Minecraft Launcher routes must receive the detected launcher workDir.');
assert(desktopMain.includes('async function existingLaunchCwd'), 'Minecraft Launcher opener must sanitize missing configured cwd before spawning.');
assert(desktopMain.includes('const cwd = await existingLaunchCwd(requestedCwd);'), 'Minecraft Launcher opener must use a verified existing cwd.');
assert(desktopMain.includes('async function openWindowsStoreMinecraftLauncher('), 'Windows Store Minecraft Launcher opener must be isolated.');
assert(desktopMain.includes("process.env.SystemRoot ? path.join(process.env.SystemRoot, 'explorer.exe')"), 'Windows Store opener must use absolute explorer.exe when available.');
assert(desktopMain.includes('openWindowsStoreMinecraftLauncher(cwd, env, options.sessionId, options.storeRoots || [])'), 'Windows play fallback must use the robust Store opener with registered package roots.');
assert(desktopMain.includes('function minecraftProfileInstallTargets(profile = null)'), 'Launcher must gather all synced Minecraft profile roots before installing loaders.');
assert(desktopMain.includes('profile.syncedProfiles'), 'Launcher must inspect synced Minecraft roots for missing loaders.');
assert(desktopMain.includes('installMinecraftProfileLoaders(profile'), 'Update and Play must install Forge into synced launcher roots.');
assert(desktopMain.includes('process.env.AHT_TEST_USER_DATA || explicitUserDataDirArg()'), 'Launcher smoke hooks must honor an explicit --user-data-dir before reading or writing config.');
assert(electronSmokeIsolationFailures.length === 0, `Electron smokes with --user-data-dir must force that exact isolated test path: ${electronSmokeIsolationFailures.join(', ')}`);
assert(desktopMain.includes('function curseForgeStorageMinecraftRootCandidates()') && desktopMain.includes("'CurseForge', 'storage.json'"), 'Launcher must discover the configured CurseForge Minecraft root from storage.json.');
assert(desktopMain.includes('const curseForgeRoot = await firstExistingCurseForgeMinecraftRoot(safeConfig);') && !desktopMain.includes('canAutoSelectCurseForge'), 'A valid CurseForge root must override stale regular and developer launcher roots.');
assert(desktopMain.includes('runtimeCurseForgeRoot: curseForgeRoot') && desktopMain.includes('existingMinecraftLauncherFallbackRoots(safeConfig, curseForgeRoot)'), 'CurseForge-first Play must retain synchronized official fallback profile roots.');
assert(desktopMain.includes("const desktopArgs = ['--workDir', cwd];"), 'Desktop Minecraft Launcher fallback must always receive the verified configured workDir without a command shell.');
assert(desktopMain.includes("['minecraft.exe', 'minecraftlauncher.exe'].includes(captureImage)"), 'Windows handoff smoke capture must cover both root-local and desktop Minecraft Launcher executables.');
assert(desktopMain.includes("ipcMain.handle('play:prepare'") && preloadScript.includes("ipcRenderer.invoke('play:prepare'") && desktopMain.includes('launchPreparationCache'), 'Startup and game-mode transitions must prepare launch state through isolated IPC and retain it only in main-process memory.');
assert(
  desktopMain.includes("STARTUP_PREREQUISITE_POLICY = 'java8-and-minecraft-launcher-paths/v2'")
  && desktopMain.includes("'Reuse initialized Java and launcher paths'")
  && desktopMain.includes('managedFilesChecked: 0')
  && desktopMain.includes('runtimeFilesChecked: 0')
  && desktopMain.includes("'Use initialized Play authorization'")
  && desktopMain.includes('minValidityMs: LAUNCH_PREPARATION_PROOF_MIN_VALIDITY_MS')
  && desktopMain.includes('confirmSpawnedWindowsMinecraftLauncher')
  && desktopMain.includes('A visible responsive launcher is a successful handoff')
  && !desktopMain.includes('A fresh one-time launcher session could not be authorized for this Play attempt.')
  && smokePlayIntegrityGate.includes("AHT_TEST_WINDOWS_LAUNCHER_FOCUS_ALLOWED: '0'")
  && smokePlayIntegrityGate.includes('Prepared Play made a redundant Worker proof request before spawning CurseForge')
  && smokePlayIntegrityGate.includes('curseForgeSpawnLatencyMs >= 500')
  && smokePlayIntegrityGate.includes('cachedRevealMs >= 5_000')
  && smokePlayIntegrityGate.includes('Cached Play waited for the delayed Worker proof before opening CurseForge'),
  'Initialized Play must reuse only saved Java/launcher prerequisites, open within 500 ms even while a cold proof request is pending, verify that proof before confirmed handoff, and tolerate Windows foreground-focus denial for a visible launcher.'
);
assert(
  launcherProofSource.includes('export function launcherProofStorageDir')
  && launcherProofSource.includes("return path.join(path.resolve(storageRoot), 'instances', instanceScope);")
  && desktopMain.includes("launcherProofStorageDir(")
  && smokePlayerUpdatePlay.includes('Stable and PTB Play did not retain distinct instance-bound proof files'),
  'Stable and PTB Play must retain separate launcher-owned, instance-bound proof files so one target cannot invalidate the other.'
);
assert(rendererApp.includes('await refreshPrepared(activeSidebarPack);') && !/await refreshPrepared\(activeSidebarPack, \{ forcePreparation: true \}\);\s*if \(result\?\.profileUpdated\)/.test(rendererApp), 'Saving Game Settings must reuse a ready launch snapshot when preparation paths did not change.');
assert(rendererApp.includes('loadNewsStatusResults(false)') && rendererApp.includes('loadNewsStatusResults(true)') && preloadScript.includes("refreshNews: (packKey = 'aht')") && desktopMain.includes("ipcMain.handle('news:refresh'") && desktopMain.includes('async function refreshNewsStatus') && rendererApp.includes('if (!startupFirstInitialization)') && rendererApp.includes('refreshStartupNewsQuietly("aht")') && rendererApp.includes('refreshStartupNewsQuietly("ptb")') && !rendererApp.includes('void refreshPackQuietly("aht");') && !rendererApp.includes('void refreshPackQuietly("ptb");'), 'First initialization must load fresh News before reveal without re-rendering it, while warm startup refreshes News afterward through a lightweight path without repeating full prerequisite status work.');
assert(desktopMain.includes("if (prepared?.state === 'preparing')") && !desktopMain.includes("if (prepared?.state === 'preparing' || launchPreparationInFlight.has(key))"), 'Play must not reject a ready prepared snapshot while its background persistence promise is finishing.');
assert(localChangesSource.includes("PLAYER_MUTABLE_MANAGED_ROOTS = new Set(['config'])") && localChangesSource.includes('verifyManagedIntegritySnapshot') && desktopMain.includes("ipcMain.handle('files:scan'") && desktopMain.includes('scanCurrentManagedIntegrity(config)') && desktopMain.includes("writeIntegrityState(config, integrity, 'scan')"), 'Managed integrity verification must remain available only through explicit Scan, Update, and Repair ownership, outside startup and Play.');
assert(!launchDiagnosticsSource.includes("lines.push(`Attempt ID:") && !launchDiagnosticsSource.includes("lines.push(`Started:") && !launchDiagnosticsSource.includes("lines.push(`Finished:") && !launchDiagnosticsSource.includes("lines.push('RECOMMENDED ACTION')") && !launchDiagnosticsSource.includes("lines.push('PRIVACY')"), 'Future launch reports must omit attempt timing/ID, recommended-action, and privacy boilerplate.');
assert(desktopMain.includes("new Error('Minecraft not installed. Install Minecraft.')") && desktopMain.includes('resolveMinecraftLauncherRoute') && desktopMain.includes('openPreparedMinecraftLauncherRoute'), 'Minecraft launcher availability and CurseForge/desktop/Store route selection must be resolved before Play, with the exact missing-install message.');
assert(!desktopMain.includes('closeWindowsMinecraftLaunchersForProfileReload') && !desktopMain.includes('prepareMinecraftLauncherForPlay') && !desktopMain.includes('assertMinecraftLauncherStayedClosedForProfileWrite'), 'Play preparation must never close or wait on an existing Minecraft game or launcher process.');
assert(smokeCloseDuringUpdate.includes("javaPath: fakeJavaPath") && smokeCloseDuringUpdate.includes("AHT_TEST_JAVA_RUNTIME_PROBE: 'release-file'") && smokeCloseDuringUpdate.includes("AHT_MINECRAFT_MAC_APP: process.platform === 'darwin' ? macMinecraftApp : ''") && smokeCloseDuringUpdate.includes("AHT_ALLOW_UNENCRYPTED_DEVICE_KEY: '1'") && smokeCloseDuringUpdate.includes("AHT_TEST_QUIT_ON_ALL_WINDOWS_CLOSED: '1'") && desktopMain.includes("process.env.AHT_TEST_QUIT_ON_ALL_WINDOWS_CLOSED === '1'") && desktopMain.includes("process.platform !== 'darwin' || testQuitOnAllWindowsClosed") && smokeCloseDuringUpdate.includes('clearTimeout(timer);') && smokeCloseDuringUpdate.includes("String(target.title || '').trim() === 'A Hard Time Launcher'") && smokeCloseDuringUpdate.includes('async function connectReadyLauncherPage(timeoutMs = 60000)') && smokeCloseDuringUpdate.includes('const deadline = Date.now() + timeoutMs;') && smokeCloseDuringUpdate.includes("document.body.classList.contains('is-launcher-ready')") && smokeCloseDuringUpdate.includes('CDP socket open timed out') && smokeCloseDuringUpdate.includes('closeAllConnections') && smokeCloseDuringUpdate.includes('Pack response stayed open after the launcher exited.'), 'Close-during-update validation must isolate host prerequisites, macOS window lifecycle, and headless secret storage, wait for the stable launcher-ready page, and hard-bound every debugger and HTTP cleanup wait.');
const startupPreparationSecretSource = desktopMain.slice(desktopMain.indexOf('async function startupPreparationSecret'), desktopMain.indexOf('function signStartupPreparationPayload'));
assert(desktopMain.includes('function useUnencryptedDeviceSecretTestFallback()') && desktopMain.includes("process.env.AHT_TEST_HOOKS === '1'") && desktopMain.includes('&& !safeStorageAvailable()') && desktopMain.includes('protectDeviceSecret(created.privateKey)') && startupPreparationSecretSource.includes('const allowTestFallback = useUnencryptedDeviceSecretTestFallback();') && startupPreparationSecretSource.includes('const encrypted = record.encrypted !== false;') && startupPreparationSecretSource.includes('!encrypted && !allowTestFallback') && startupPreparationSecretSource.includes('const protectedKey = protectDeviceSecret(secret);') && startupPreparationSecretSource.includes('encrypted: protectedKey.encrypted') && !startupPreparationSecretSource.includes('Windows protected storage') && verifyLocalScript.includes("AHT_ALLOW_UNENCRYPTED_DEVICE_KEY: '1'") && verifyInstalledPlayerScript.includes("AHT_ALLOW_UNENCRYPTED_DEVICE_KEY: '1'") && releaseWorkflow.includes('AHT_ALLOW_UNENCRYPTED_DEVICE_KEY: "1"'), 'Headless Electron validation must use its plaintext fallback only when OS secure storage is unavailable and only behind explicit test hooks, including the authenticated quick-start cache key.');
assert(desktopMain.includes("'launcher-log-baseline'") && desktopMain.includes('signalsAfterBaseline') && desktopMain.includes('attempt.minecraftSignalBaseline'), 'Launch diagnostics must subtract pre-existing Minecraft Launcher errors from the current Play attempt.');
assert(desktopMain.includes("'instance-log-baseline'") && desktopMain.includes('minecraftInstanceSignalDiagnostic') && desktopMain.includes('attempt.minecraftInstanceSignalBaseline') && smokePlayIntegrityGate.includes('stale.previous.Attempt') && smokePlayIntegrityGate.includes('current.attempt.Signal'), 'Launch diagnostics must subtract pre-existing instance latest.log/crash-report signals while retaining signals appended by the current attempt.');
assert(
  smokePlayIntegrityGate.includes("const desktopLauncherPath = path.join(fakeLocalAppData, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe');")
  && smokePlayIntegrityGate.includes("desktopFallbackPlayResult.result?.kind !== 'desktop'")
  && smokePlayIntegrityGate.includes("JSON.stringify(['--workDir', mcRoot])")
  && smokePlayIntegrityGate.includes("fsp.rm(path.join(mcRoot, 'minecraft.exe'), { force: true })")
  && smokePlayIntegrityGate.includes("'ProgramFiles(x86)': fakeProgramFilesX86"),
  'Play smoke must behaviorally cover an isolated desktop MinecraftLauncher.exe fallback for a configured non-CurseForge root with no root-local launcher.'
);
assert(
  ['APPDATA: fakeAppData', 'LOCALAPPDATA: fakeLocalAppData', 'HOME: fakeHome', 'USERPROFILE: fakeHome']
    .every((fragment) => smokeCloseDuringUpdate.includes(fragment))
  && smokeCloseDuringUpdate.includes('syncDefaultRoots: false'),
  'Close-during-update smoke must never inherit or synchronize real host Minecraft profile roots.'
);
assert(desktopMain.includes('backupConfigBeforeCurseForgeMigration(file)') && desktopMain.includes('fsSync.constants.COPYFILE_EXCL'), 'Persisted CurseForge root self-heal must make a one-time rollback backup first.');
assert(desktopMain.includes("process.env.AHT_TEST_OPEN_PATH_ECHO === '1'") && desktopMain.includes("ipcMain.handle('shell:openPath'") && desktopMain.includes('captured: true'), 'Open-folder IPC must expose a deterministic captured test contract without opening the OS shell.');
assert(desktopMain.includes('const rootDir = config.minecraftLauncher?.rootDir || defaultMinecraftRoot();') && !desktopMain.includes("if (!rootDir || config.minecraftLauncher?.enabled === false)"), 'Minecraft account recovery must inspect signed-in launcher accounts without a user-disable branch.');
const forgeInstaller = readText(new URL('../src/forgeInstaller.js', import.meta.url));
const minecraftLauncherProfileSource = readText(new URL('../src/minecraftLauncherProfile.js', import.meta.url));
const packagedPlayerDefaults = JSON.parse(readText(new URL('../config/app.defaults.json', import.meta.url)));
assert(
  packagedPlayerDefaults.minecraftLauncher?.enabled === true
  && packagedPlayerDefaults.minecraftLauncher?.closeLauncherWhenGameStarts === false
  && desktopMain.includes('merged.minecraftLauncher.enabled = true;')
  && desktopMain.includes('config.minecraftLauncher.enabled = true;')
  && !desktopMain.includes('Minecraft Launcher profile integration is disabled.'),
  'Minecraft profile integration must be forced in defaults, config migration, save normalization, and launch readiness.'
);
assert(
  !desktopMain.includes('assertPreparedProfileFiles')
  && !desktopMain.includes('Minecraft Launcher profile ${item.profileName || item.profileId} changed after initialization.')
  && minecraftLauncherProfileSource.includes('function usesLegacySelectedProfile')
  && !minecraftLauncherProfileSource.includes('if (selectForPlay && !legacySelectionSchema)')
  && minecraftLauncherProfileSource.includes('!usesLegacySelectedProfile(written)'),
  'Quick startup must tolerate foreign launcher profile rewrites, and modern CurseForge schema must not receive the legacy selectedProfile field.'
);
assert(
  minecraftLauncherProfileSource.includes('const selected = await Promise.all(candidates.map((candidate) => ('),
  'Prepared pack selection must update independent Minecraft launcher roots in parallel so sidebar switching is not multiplied by root count.'
);
assert(
  desktopMain.includes('function armCloseLauncherWhenGameStarts')
  && desktopMain.includes('minecraftLauncherSignalStartsConfiguredModpack')
  && desktopMain.includes('minecraftInstanceLogAdvancedAfterBaseline')
  && smokePlayerUpdatePlay.includes('A fresh modpack game-start signal did not close AHT Launcher'),
  'Close-on-game-start must wait for a fresh modpack startup signal and have an end-to-end Play-flow proof.'
);
assert(desktopMain.includes('javaCacheDir') || forgeInstaller.includes('ensureManagedJava8Runtime'), 'Forge installer must have managed Java 8 fallback for stale jre-legacy certificates.');
assert(forgeInstaller.includes('windowsJavaInstallRoots') && forgeInstaller.includes('Eclipse Adoptium'), 'Forge installer must prefer installed Temurin/Adoptium Java 8 before stale bundled Minecraft Java.');
assert(
  forgeInstaller.includes('export async function inspectJavaRuntime')
  && forgeInstaller.includes("['-XshowSettings:properties', '-version']")
  && forgeInstaller.includes('major === 8')
  && forgeInstaller.includes('is64Bit'),
  'Java selection must execute and verify the reported major version and 64-bit architecture instead of trusting a path name.'
);
assert(
  forgeInstaller.includes('export async function detectJava8Runtime')
  && forgeInstaller.includes('await inspectJavaRuntime(candidate, options)')
  && forgeInstaller.includes('if (inspected.usable)'),
  'Java 8 discovery must accept only candidates that pass the executable runtime probe.'
);
assert(
  forgeInstaller.includes('if (options.forceManagedJava8)')
  && forgeInstaller.includes('forceDownloadJava: true')
  && forgeInstaller.includes('options.allowManagedJavaDownload !== false')
  && forgeInstaller.includes('ensureManagedJava8Runtime(plan'),
  'Forge and Minecraft profile setup must support an explicit managed-Java download while retaining automatic fallback.'
);
assert(
  forgeInstaller.includes('WINDOWS_JAVA8_RUNTIME_ASSETS_URL')
  && forgeInstaller.includes('packageInfo?.checksum')
  && forgeInstaller.includes("hashFile(archivePath, 'sha256')")
  && forgeInstaller.includes('actualSha256.toLowerCase() !== downloadPackage.sha256')
  && forgeInstaller.includes("process.env.AHT_TEST_HOOKS === '1'"),
  'The managed Adoptium archive must come from official release metadata, pass SHA-256 verification before extraction, and gate environment overrides behind test hooks.'
);
assert(
  forgeInstaller.includes('export async function resolveMinecraftProfileJavaPath')
  && forgeInstaller.includes('const detected = await detectJava8Runtime(profile')
  && forgeInstaller.includes('if (detected.usable)')
  && forgeInstaller.includes('usable 64-bit Java 8 runtime.'),
  'Minecraft profiles must reuse an executable-probed 64-bit Java 8 runtime and fail closed when none is usable.'
);
assert(
  desktopMain.includes('config.minecraftLauncher?.java8InstallOverride === true')
  && desktopMain.includes('config.minecraftLauncher?.java8InstallOverride !== false')
  && desktopMain.includes('forceManagedJava8,')
  && desktopMain.includes('allowManagedJavaDownload,'),
  'The nullable Java 8 preference must control forced and automatic managed-runtime installation in the main process.'
);
assert(
  packagedPlayerDefaults.minecraftLauncher?.java8InstallOverride === null
  && windowsInstallerInclude.includes('Install Adoptium Java 8 if needed')
  && windowsInstallerInclude.includes('Function AhtDetectJava8')
  && windowsInstallerInclude.includes('Function AhtProbeJava8Executable')
  && windowsInstallerInclude.includes('ReadEnvStr $8 "JAVA8_HOME"')
  && windowsInstallerInclude.includes('ReadEnvStr $8 "JAVA_HOME"')
  && windowsInstallerInclude.includes('Function AhtProbeJava8Path')
  && windowsInstallerInclude.includes('${StrTok} $8 "$6" ";" "$4" "1"')
  && windowsInstallerInclude.includes('$PROGRAMFILES64\\Microsoft')
  && windowsInstallerInclude.includes('$PROGRAMFILES64\\Zulu')
  && windowsInstallerInclude.includes('$PROGRAMFILES64\\BellSoft')
  && windowsInstallerInclude.includes('$AhtJava8Found == "1"')
  && windowsInstallerInclude.includes('installer-java8-selection.json')
  && desktopMain.includes('readPendingInstallerJava8Selection')
  && desktopMain.includes('markInstallerJava8SelectionConsumed')
  && desktopMain.includes('java8InstallOverride: installerJava8Selection.allowManagedJava8')
  && !rendererHtml.includes('id="java8InstallInput"')
  && !rendererHtml.includes('id="java8RuntimeCard"')
  && !rendererApp.includes('renderJava8Runtime'),
  'The Windows installer must own the detection-driven Java 8 checkbox, while Game Settings stays free of Java runtime status UI.'
);
assert(
  windowsInstallerInclude.includes('${If} ${Silent}')
  && windowsInstallerInclude.includes('IfFileExists "$APPDATA\\aht-launcher\\installer-java8-selection.json" AhtJavaSelectionDone 0')
  && windowsInstallerInclude.includes('AhtJavaSelectionDone:'),
  'Silent launcher updates must preserve an existing consumed Java 8 selection instead of resetting player settings.'
);
assert(
  minecraftLauncherProfileSource.includes('export async function ensureMinecraftLauncherAssets')
  && minecraftLauncherProfileSource.includes('inspectMinecraftBaseFile')
  && minecraftLauncherProfileSource.includes("hashFile(file, 'sha1')")
  && minecraftLauncherProfileSource.includes('versionJson.downloads.client')
  && minecraftLauncherProfileSource.includes('minecraftBaseLibraryDownloads(versionJson)')
  && minecraftLauncherProfileSource.includes('versionJson.assetIndex'),
  'Minecraft base bootstrap must integrity-check and repair the client JAR, base libraries, and asset index.'
);
assert(
  desktopMain.includes('safeReleaseIdentifier')
  && desktopMain.includes('unsafe Minecraft version identifier')
  && desktopMain.includes('unsafe mod-loader identifier')
  && minecraftLauncherProfileSource.includes('safeMinecraftIdentifier')
  && minecraftLauncherProfileSource.includes("safeJoin(path.join(rootDir, 'assets', 'indexes')")
  && forgeInstaller.includes('safeForgeIdentifier'),
  'Release, Minecraft, Forge, and asset-index identifiers must be constrained before becoming filesystem paths.'
);
const minecraftBootstrapFlows = {
  settings: desktopMain.slice(desktopMain.indexOf('async function refreshMinecraftLauncherProfile'), desktopMain.indexOf('async function saveSettings')),
  update: desktopMain.slice(desktopMain.indexOf('async function runUpdate'), desktopMain.indexOf('function defaultLauncherInstallerArgs')),
  play: desktopMain.slice(desktopMain.indexOf('async function performLaunchPreparation'), desktopMain.indexOf('function launchPreparationKey'))
};
for (const [flow, source] of Object.entries(minecraftBootstrapFlows)) {
  const assetsIndex = source.indexOf('ensureMinecraftLauncherAssets(');
  const loaderIndex = source.indexOf('installMinecraftProfileLoaders(');
  assert(
    assetsIndex >= 0 && loaderIndex > assetsIndex,
    `${flow} must bootstrap and validate the Minecraft 1.12.2 base runtime before validating or installing Forge.`
  );
}
assert(utilsSource.includes('Download failed after') && utilsSource.includes('replaceFileWithDownload'), 'Player downloads must retry and replace files atomically.');
assert(forgeInstaller.includes("process.env.AHT_TEST_HOOKS !== '1' || process.env.AHT_TEST_FORGE_INSTALLER_SUCCESS !== '1'"), 'Forge installer test hook must require the explicit AHT_TEST_HOOKS gate.');
assert(forgeInstaller.includes('const DEFAULT_FORGE_VERSION_WAIT_MS = 5 * 60_000') && forgeInstaller.includes('options.versionWaitMs ?? DEFAULT_FORGE_VERSION_WAIT_MS'), 'Forge installer must wait long enough for slow PCs to finish writing version metadata.');
assert(desktopMain.includes('installerUrl: target.loaderInstallerUrl'), 'Update and Play must pass release-provided Forge installer mirrors into Forge setup.');
assert(desktopMain.includes('skipLoaderCheck: true') && desktopMain.includes('allowLegacyRelease: developerClientBypass'), 'Status and initial Play gate must allow Play to self-repair missing synced loaders while preserving developer bypass.');
assert(!desktopMain.includes("if (profile.loaderId?.startsWith('forge-') && !profile.loaderInstalled)"), 'Forge install flow must not only check the primary Minecraft root.');
assert(!desktopMain.includes("spawnDetached('explorer.exe', ['shell:AppsFolder\\\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'], cwd, env)"), 'Windows Store fallback must not spawn plain explorer.exe directly.');
assert(rendererApp.includes('els.r2AccountIdInput.addEventListener("input", queueDeveloperSecretSave)'), 'R2 Account ID input must persist in developer mode.');
assert(rendererApp.includes('savedR2AccountId || !els.r2AccountIdInput.value'), 'Settings refresh must not clear an unsaved R2 Account ID before debounce persistence runs.');
assert(/launcherProof:\s*\{[\s\S]*enabled:\s*true[\s\S]*required:\s*true[\s\S]*baseUrl:\s*workerBase/.test(desktopMain), 'Player defaults must require launcher proof against the Worker endpoint.');
assert(playerDefaultsFunction && !playerDefaultsFunction.includes('developer: {'), 'Generated player defaults must not include developer config.');
assert(!Object.hasOwn(JSON.parse(readText(new URL('../config/app.defaults.json', import.meta.url))), 'developer'), 'Packaged player defaults must not include developer config.');
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
assert(macDmgTarget.arch?.length === 1 && macDmgTarget.arch[0] === 'universal', 'macOS regular launcher must build one universal DMG.');
assert(macZipTarget.arch?.length === 1 && macZipTarget.arch[0] === 'universal', 'macOS regular launcher must build one universal ZIP update.');
assert(releaseWorkflow.includes('release-builds/macos/*.zip'), 'GitHub macOS workflow must upload ZIP self-update artifacts.');
assert(releaseWorkflow.includes('release-builds/windows/*.zip'), 'GitHub Windows workflow must upload the staged ZIP update artifact.');
assert(releaseWorkflow.includes('release-builds/linux/*.deb') && releaseWorkflow.includes('release-builds/linux/*.AppImage'), 'GitHub Linux workflow must carry the compatibility DEB and portable AppImage into manifest generation.');
assert(releaseWorkflow.includes('hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT_POINT"') && !releaseWorkflow.includes('-acceptlicense') && releaseWorkflow.includes('trap cleanup_mount EXIT') && releaseWorkflow.includes('trap - EXIT'), 'Native macOS validation must mount DMGs with supported hdiutil options and always detach failed mounts.');
assert(releaseWorkflow.includes('release_assets=(ci-artifacts/*.exe ci-artifacts/*.dmg ci-artifacts/*.AppImage ci-launcher-update/launcher-latest.json)') && releaseWorkflow.includes('one-release Linux DEB compatibility bridge stay in R2') && !releaseWorkflow.includes('ci-artifacts/*.deb ci-artifacts/*.AppImage'), 'GitHub public releases must expose one Windows installer, one universal macOS DMG, and one Linux AppImage while keeping update-only artifacts out of the public asset list.');
assert(desktopMain.includes('launchMacLauncherUpdateHelper'), 'macOS launcher self-update must use the app-bundle restart helper.');
assert(!desktopMain.includes('backup_app="${target_app}.previous-update"') && desktopMain.includes('backup_app="$target_app.previous-update"'), 'macOS launcher self-update must preserve target_app as a shell variable instead of evaluating it as JavaScript.');
assert(smokePlayerUpdatePlay.includes('fs.realpathSync.native(launcherMarker.cwd) !== fs.realpathSync.native(mcRoot)'), 'Cross-platform Play validation must treat macOS /var and /private/var aliases as the same Minecraft launcher directory.');
assert(smokePlayerUpdateLogs.includes('waitForNewsCarouselSettled') && smokePlayerUpdateLogs.includes("label, 20"), 'News carousel validation must wait for bounded transition cleanup instead of assuming an exact runner timer.');
assert([smokeR2ReleaseFlow, smokeR2ReleaseUiFlow].every((source) => source.includes("AHT_MINECRAFT_MAC_APP: process.platform === 'darwin' ? macMinecraftApp : ''") && source.includes("path.join(mcRoot, 'minecraft.exe')")), 'Stable and PTB release smokes must provide deterministic native Minecraft Launcher fixtures before Update validation.');

assert(fs.existsSync(new URL('../build/electron-builder.linux.cjs', import.meta.url)), 'Linux builder config must exist.');
assert(!fs.existsSync(new URL('../build/electron-builder.ubuntu.cjs', import.meta.url)), 'Stale Ubuntu-only builder config must be removed.');
assert(packageJson.scripts['dist:linux'] === 'npm run dist:regular:linux', 'Linux package alias must invoke the portable Linux build.');
assert(packageJson.scripts['dist:regular:linux']?.includes('--linux AppImage deb --x64'), 'Linux build must emit the public AppImage plus the legacy-client DEB bridge.');
assert(!packageJson.build?.linux, 'package.json must not define Linux build targets.');
assert(releaseWorkflow.includes('id: linux') && releaseWorkflow.includes('runner: ubuntu-latest'), 'GitHub workflow must include a native Linux runner.');
assert(releaseWorkflow.includes('dist:regular:linux'), 'GitHub workflow must call the portable Linux build script.');
assert(releaseWorkflow.includes('aht-launcher-linux'), 'GitHub workflow must upload Linux launcher artifacts.');
assert(releaseWorkflow.includes('validate-linux-runtime:') && releaseWorkflow.includes('squashfs-root/AppRun'), 'GitHub validation must extract and exercise the portable AppImage runtime.');
assert(
  releaseWorkflow.includes('AHT_SMOKE_USE_TEMP_DEFAULTS: "1"')
  && [smokePlayerDefaults, smokeSettingsProfile].every((source) => (
    source.includes("const useTempDefaults = process.env.AHT_SMOKE_USE_TEMP_DEFAULTS === '1';")
    && source.includes("const packagedDefaults = smokeExe && process.platform === 'win32' && !useTempDefaults")
    && source.includes("AHT_APP_DEFAULTS: packagedDefaults ? '' : tempDefaults")
  )),
  'Installed macOS and Linux smokes must keep mutable defaults fixtures out of the packaged application directory.'
);
assert(
  [smokePlayerDefaults, readText(new URL('../scripts/test-player-privacy.mjs', import.meta.url))]
    .every((source) => source.includes('await stopElectronChild(child);') && source.includes("child.kill('SIGKILL')"))
  && readText(new URL('../scripts/test-player-privacy.mjs', import.meta.url)).includes('AbortSignal.timeout(2_000)')
  && readText(new URL('../scripts/test-player-privacy.mjs', import.meta.url)).includes('HOME: fakeHome')
  && readText(new URL('../scripts/test-player-privacy.mjs', import.meta.url)).includes('autoImportAccount = false')
  && readText(new URL('../scripts/test-player-privacy.mjs', import.meta.url)).includes("AHT_TEST_JAVA_RUNTIME_PROBE: 'release-file'")
  && readText(new URL('../scripts/test-player-privacy.mjs', import.meta.url)).includes('timeoutMs = 60_000'),
  'The first packaged smokes must wait for their owned Electron process to exit, while privacy startup isolates host launcher prerequisites and hard-bounds DevTools discovery and hydration.'
);
assert(
  smokePlayerLayout.includes('HOME: fakeHome')
  && smokePlayerLayout.includes('autoImportAccount: false')
  && smokePlayerLayout.includes("AHT_TEST_JAVA_RUNTIME_PROBE: 'release-file'")
  && smokePlayerLayout.includes("AHT_TEST_QUIT_ON_ALL_WINDOWS_CLOSED: '1'")
  && smokePlayerLayout.includes("usernameRegistrationMode: 'worker'")
  && smokePlayerLayout.includes('remoteRegistrationConfirmedAt: registeredAt')
  && smokePlayerLayout.includes('remoteRegistrationWorkerBaseUrl: `${workerEndpoint}/`')
  && smokePlayerLayout.includes('AbortSignal.timeout(2_000)')
  && smokePlayerLayout.includes('Math.min(5_000, remainingMs)')
  && smokePlayerLayout.includes("reject(new Error('CDP socket closed'))")
  && smokePlayerLayout.includes('await stopElectronChild(child);')
  && smokePlayerLayout.includes("console.log('[player-layout] debugger ready; waiting for hydrated UI')"),
  'Packaged player layout validation must isolate host launcher prerequisites, avoid unrelated account-recovery/keychain enrollment, retry bounded debugger hydration, expose socket closure, and fully stop its owned native process.'
);
assert(
  verifyInstalledPlayerScript.includes('function createIsolatedCheckEnvironment()')
  && verifyInstalledPlayerScript.includes('...isolatedHost.env')
  && verifyInstalledPlayerScript.includes("AHT_TEST_JAVA_RUNTIME_PROBE: 'release-file'")
  && verifyInstalledPlayerScript.includes("AHT_TEST_QUIT_ON_ALL_WINDOWS_CLOSED: '1'")
  && verifyLocalScript.includes("AHT_TEST_QUIT_ON_ALL_WINDOWS_CLOSED: '1'")
  && verifyInstalledPlayerScript.includes('HOME: fakeHome')
  && verifyInstalledPlayerScript.includes("fs.rmSync(isolatedHost.root, { recursive: true, force: true })"),
  'Every source and packaged native check must quit its macOS application after closing the test window; packaged checks must also use and clean a disposable host profile with deterministic Java discovery.'
);
assert(
  releaseWorkflow.includes('node node_modules/electron/install.js')
  && releaseWorkflow.includes('sudo chown root:root "$ELECTRON_SANDBOX"')
  && releaseWorkflow.includes('sudo chmod 4755 "$ELECTRON_SANDBOX"')
  && releaseWorkflow.includes('electron_sandbox=$ELECTRON_SANDBOX_IDENTITY')
  && releaseWorkflow.includes('test "$ELECTRON_SANDBOX_IDENTITY" = "root:root 4755"')
  && releaseWorkflow.includes('timeout 30s "$APPIMAGE" --appimage-version')
  && !releaseWorkflow.includes('APPIMAGE_EXTRACT_AND_RUN=1 timeout 30s')
  && !releaseWorkflow.includes('"$APPIMAGE" --no-sandbox --version')
  && releaseWorkflow.includes('"$GITHUB_WORKSPACE/$APPIMAGE" --appimage-extract')
  && !releaseWorkflow.includes('sudo apt-get install')
  && !desktopMain.includes('AHT_TEST_DISABLE_CHROMIUM_SANDBOX'),
  'Linux CI must configure Electron\'s SUID test sandbox, probe and extract the AppImage, and exercise its packaged AppRun without installing a distro package.'
);
assert(smokePlayerUpdateLogs.includes('Electron exited before exposing a debugger target') && smokePlayerUpdateLogs.includes("stdio: ['ignore', 'pipe', 'pipe']"), 'The first native Electron smoke must preserve early process diagnostics.');
const platformProfileSource = readText(new URL('../src/platformProfile.js', import.meta.url));
assert(platformProfileSource.includes('Unsupported AHT launcher platform'), 'Platform profile must reject unsupported platforms instead of keeping a generic Linux/Desktop fallback.');
assert(desktopMain.includes("import { defaultInstanceDirForPlatform, platformKey, platformProfile } from '../src/platformProfile.js';"), 'Main process must use the shared platform policy for platform-specific paths.');
assert(desktopMain.includes("if (process.platform === 'linux')") && desktopMain.includes("'PTB Instance'") && desktopMain.includes("'Developer Instance'"), 'Linux stable, PTB, and developer instance paths must be explicitly owned.');
assert(platformProfileSource.includes('XDG_DATA_HOME') && platformProfileSource.includes('Linux x64'), 'Platform profile must use the Linux XDG data path and generic label.');
assert(rendererHtml.includes('one universal macOS package') && rendererHtml.includes('one portable Linux AppImage'), 'Developer launcher update UI must advertise the consolidated public platform matrix.');
assert(!rendererApp.includes('launcherUbuntuPathInput'), 'Renderer must not keep stale Ubuntu launcher artifact inputs.');
assert(packageJson.scripts['dist:regular:windows']?.includes('--win'), 'Windows regular script must force --win.');
assert(packageJson.scripts['dist:regular:macos']?.includes('--mac'), 'macOS regular script must force --mac.');

assert(configs.linux.productName === 'A Hard Time Launcher Linux', 'Linux product name is not generic.');
assert(configs.linux.executableName === 'a-hard-time-launcher', 'Linux executable name must remain stable for runtime validation.');
assert(configs.linux.directories?.output === 'release-builds/linux', 'Linux output folder is wrong.');
const linuxTargets = configs.linux.linux?.target || [];
assert(linuxTargets.some((target) => target.target === 'AppImage' && target.arch?.includes('x64')), 'Linux launcher must build an x64 AppImage.');
assert(linuxTargets.some((target) => target.target === 'deb' && target.arch?.includes('x64')), 'Linux launcher must retain the hidden x64 DEB compatibility bridge.');
assert(/^\d+\.\d+\.\d+$/.test(launcherReleaseVersion), 'Public launcher version must use numeric major.minor.patch notation.');
assert(packageJson.version === launcherPackageVersionForRelease(launcherReleaseVersion), 'Internal npm package version must be the valid SemVer form of the public launcher version.');
assert(configs.linux.linux?.category === 'Game' && configs.linux.linux?.artifactName === `AHT-Launcher-Linux-x64-${launcherReleaseVersion}.\${ext}`, 'Linux package metadata and artifact naming are not stable.');
assert(Object.values(configs).every((config) => config.extraMetadata?.ahtLauncherVersion === launcherReleaseVersion), 'Every packaged launcher must carry the public launcher version.');
assert(configs.windows.win?.artifactName === `AHT-Launcher-Windows-10-11-${launcherReleaseVersion}.\${ext}`, 'Windows artifact must use the public launcher version.');
assert(configs.macos.mac?.artifactName === `AHT-Launcher-macOS-universal-${launcherReleaseVersion}.\${ext}`, 'Universal macOS artifacts must use the public launcher version.');
assert(releaseWorkflow.includes('ahtLauncherVersion || require(\'./package.json\').version'), 'GitHub release workflow must publish the public launcher version.');
assert(desktopMain.includes('launcherReleaseVersionFromPackage') && desktopMain.includes('return publicLauncherVersion || app.getVersion()'), 'Packaged launcher UI and update logic must report the public launcher version.');
assert(launcherUpdateStagingSource.includes('launcherVersionsReferToSameRelease(actual, expected)'), 'Windows staging must accept the npm-compatible product version for a zero-padded public release.');
assert(desktopMain.includes("strategy: 'linux-appimage-helper'") && desktopMain.includes('launcherUpdateInstalledLinuxAppImagePath') && desktopMain.includes('linuxAppImageUpdateHelperScript'), 'Linux launcher updates must atomically replace the verified running AppImage.');
assert(desktopMain.includes('target_appimage.next-update') && desktopMain.includes('target_appimage.previous-update') && desktopMain.includes('nohup "$target_appimage"'), 'Linux AppImage updates must stage, back up, replace, and reopen the portable file.');
assert(smokeLauncherSelfUpdate.includes("launched.strategy !== 'linux-appimage-helper'") && smokeLauncherSelfUpdate.includes("payload.mode !== 'appimage-swap'"), 'Linux self-update smoke must prove the AppImage swap helper contract.');
assert(desktopMain.includes('function linuxMinecraftLauncherCandidates') && desktopMain.includes("commandOnPath('minecraft-launcher')") && desktopMain.includes("args: ['--workDir', cwd]"), 'Linux Play must resolve and open the native Minecraft Launcher with the managed root.');

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
