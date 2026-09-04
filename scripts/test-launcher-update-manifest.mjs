import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkLauncherReleaseImmutability } from './check-launcher-release-immutability.mjs';
import { prepareLauncherUpdate } from './prepare-launcher-update.mjs';
import { uploadR2Plan } from './upload-r2-plan.mjs';
import {
  assertLauncherReleaseAdvance,
  compareLauncherReleaseVersions,
  KNOWN_LEGACY_DOWNLOAD_KEYS,
  REQUIRED_DOWNLOAD_KEYS,
  selectLauncherArtifact,
  validateLauncherUpdateManifest
} from './validate-launcher-update-manifest.mjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aht-launcher-update-manifest-'));
const artifacts = path.join(root, 'artifacts');
const out = path.join(root, 'out');

async function writeArtifact(name, text) {
  const file = path.join(artifacts, name);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, 'utf8');
  return file;
}

await writeArtifact('AHT-Launcher-Windows-10-11-7.8.9.exe', 'windows');
await writeArtifact('AHT-Launcher-Windows-10-11-7.8.9.zip', 'windows-staged-update');
await writeArtifact('AHT-Launcher-macOS-universal-7.8.9.zip', 'mac-universal-update');
await writeArtifact('AHT-Launcher-macOS-universal-7.8.9.dmg', 'mac-universal-installer');
await writeArtifact('AHT-Launcher-Linux-x64-7.8.9.deb', 'linux-compatibility-deb');
await writeArtifact('AHT-Launcher-Linux-x64-7.8.9.AppImage', 'linux-appimage');

const result = await prepareLauncherUpdate({
  artifactsDir: artifacts,
  outDir: out,
  version: '7.8.9',
  latestUrl: 'https://example.test/launcher/latest.json'
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const uploadScript = await fsp.readFile(new URL('./upload-r2-plan.mjs', import.meta.url), 'utf8');
const manifest = result.manifest;
const validation = validateLauncherUpdateManifest(manifest, {
  latestUrl: 'https://example.test/launcher/latest.json',
  requireTrackedDownloads: true,
  requireStagedWindows: true,
  requireStagedLinux: true
});
assert(validation.ok, `generated launcher manifest failed reusable validation: ${validation.errors.join('; ')}`);
assert(compareLauncherReleaseVersions('7.8.10', '7.8.9') === 1, 'launcher version comparison must be numeric, not lexical');
assert(compareLauncherReleaseVersions('7.8.9', '7.8.9') === 0, 'equal launcher versions must compare equal');
assertLauncherReleaseAdvance({ ...manifest, version: '7.8.10' }, manifest);
for (const candidateVersion of ['7.8.9', '7.8.8']) {
  let immutableRejected = false;
  try {
    assertLauncherReleaseAdvance({ ...manifest, version: candidateVersion }, manifest);
  } catch (error) {
    immutableRejected = String(error?.message || error).includes('already published');
  }
  assert(immutableRejected, `published launcher ${candidateVersion} must not be replaceable`);
}
const legacyManifest = JSON.parse(JSON.stringify(manifest).replaceAll('7.8.9', '7.8.8'));
const legacyDownloads = legacyManifest.downloads;
legacyManifest.downloads = {
  'windows-x64': legacyDownloads['windows-x64'],
  'macos-arm64': legacyDownloads['macos-universal'],
  'macos-x64': legacyDownloads['macos-universal'],
  'ubuntu-x64': legacyManifest.platforms['ubuntu-x64'],
  'ubuntu-x64-appimage': legacyDownloads['ubuntu-x64-appimage']
};
const strictLegacyValidation = validateLauncherUpdateManifest(legacyManifest, {
  latestUrl: 'https://example.test/launcher/latest.json',
  requireStagedWindows: true,
  requireAllPlatforms: false,
  requireDownloads: false
});
assert(
  !strictLegacyValidation.ok && strictLegacyValidation.errors.some((error) => error.includes('manual downloads contain unexpected keys')),
  'Legacy manual-download keys must remain invalid for strict candidate validation'
);
const compatibleLegacyValidation = validateLauncherUpdateManifest(legacyManifest, {
  latestUrl: 'https://example.test/launcher/latest.json',
  requireStagedWindows: true,
  requireAllPlatforms: false,
  requireDownloads: false,
  allowKnownLegacyDownloadKeys: true
});
assert(compatibleLegacyValidation.ok, `Known 0.2.01 download keys must remain readable for an immutability comparison: ${compatibleLegacyValidation.errors.join('; ')}`);
assert(KNOWN_LEGACY_DOWNLOAD_KEYS.slice().sort().join(',') === 'macos-arm64,macos-x64,ubuntu-x64', 'The historical download-key allowance must remain exactly bounded');
const unknownLegacyManifest = JSON.parse(JSON.stringify(legacyManifest));
unknownLegacyManifest.downloads['unexpected-linux'] = unknownLegacyManifest.downloads['ubuntu-x64'];
const unknownLegacyValidation = validateLauncherUpdateManifest(unknownLegacyManifest, {
  latestUrl: 'https://example.test/launcher/latest.json',
  requireStagedWindows: true,
  requireAllPlatforms: false,
  requireDownloads: false,
  allowKnownLegacyDownloadKeys: true
});
assert(!unknownLegacyValidation.ok && unknownLegacyValidation.errors.some((error) => error.includes('unexpected-linux')), 'The legacy comparison allowance must still reject unknown download keys');
const legacyAdvance = await checkLauncherReleaseImmutability({
  candidatePath: result.manifestPath,
  latestUrl: 'https://example.test/launcher/latest.json',
  fetchImpl: async () => ({
    status: 200,
    statusText: 'OK',
    ok: true,
    json: async () => legacyManifest
  })
});
assert(legacyAdvance.ok && legacyAdvance.candidateVersion === '7.8.9' && legacyAdvance.liveVersion === '7.8.8', 'Immutability checking must compare a strict new candidate against the known legacy live shape');
const liveManifestPath = path.join(root, 'current-launcher-latest.json');
await fsp.writeFile(liveManifestPath, JSON.stringify(legacyManifest), 'utf8');
const authenticatedR2Advance = await checkLauncherReleaseImmutability({
  candidatePath: result.manifestPath,
  latestUrl: 'https://example.test/launcher/latest.json',
  liveManifestPath,
  fetchImpl: async () => {
    throw new Error('Authenticated R2 immutability checks must not request the public Worker route');
  }
});
assert(authenticatedR2Advance.ok && authenticatedR2Advance.candidateVersion === '7.8.9' && authenticatedR2Advance.liveVersion === '7.8.8', 'Immutability checking must accept an authenticated R2 copy of the live manifest');
const requiredDownloadKeys = REQUIRED_DOWNLOAD_KEYS;
assert(uploadScript.includes("process.platform === 'win32' && /\\.cmd$/i.test(command)"), 'Windows R2 upload must shell-wrap npx.cmd');
assert(manifest.version === '7.8.9', 'manifest version mismatch');
assert(manifest.platforms['win32-x64']?.installArgs?.[0] === '/S', 'Legacy Windows installer fallback must retain silent install args');
assert(manifest.stagedPlatforms['win32-x64']?.kind === 'zip', 'Windows in-app updates must use a pre-staged ZIP payload');
assert(manifest.stagedPlatforms['windows-x64']?.fileName?.endsWith('.zip'), 'Windows staged update alias must point at the ZIP payload');
assert(manifest.stagedPlatforms['win32-x64']?.sha256 !== manifest.platforms['win32-x64']?.sha256, 'Windows staged ZIP and manual NSIS installer must be distinct artifacts');
assert(manifest.platforms['darwin-arm64']?.path?.includes('/darwin-universal/'), 'Apple Silicon alias must point at the universal macOS artifact');
assert(manifest.platforms['darwin-x64']?.path === manifest.platforms['darwin-arm64']?.path, 'Intel and Apple Silicon must share one universal macOS update ZIP');
assert(manifest.platforms['darwin-arm64']?.kind === 'zip', 'Universal macOS launcher updates must use ZIP, not DMG');
assert(manifest.downloads?.['macos-universal']?.kind === 'dmg', 'macOS must expose exactly one universal DMG download');
assert(manifest.platforms['linux-x64']?.kind === 'deb', 'Legacy Linux clients must retain the one-release DEB update bridge');
assert(manifest.platforms['ubuntu-x64']?.fileName?.endsWith('.deb'), 'Legacy Ubuntu alias must point at the compatibility bridge');
assert(manifest.stagedPlatforms['portable-linux-x64']?.kind === 'appimage', 'Current Linux clients must use the portable AppImage update');
assert(manifest.downloads?.['ubuntu-x64-appimage']?.kind === 'appimage', 'Linux must expose exactly one portable AppImage download through the legacy-compatible manifest key');
assert(selectLauncherArtifact(manifest, 'linux', 'x64')?.key === 'portable-linux-x64', 'Linux x64 runtime must prefer its portable AppImage update artifact');
assert(selectLauncherArtifact(manifest, 'linux', 'arm64') === null, 'Unsupported Linux architectures must not receive the x64 AppImage artifact');
for (const key of requiredDownloadKeys) {
  const entry = manifest.downloads?.[key];
  assert(entry, `manual download entry missing: ${key}`);
  const legacyArtifactUrl = new URL(entry.url);
  const downloadUrl = new URL(entry.downloadUrl);
  assert(legacyArtifactUrl.pathname.startsWith('/launcher/files/'), `manual artifact URL is not compatible with installed legacy launchers for ${key}: ${entry.url}`);
  assert(path.posix.basename(legacyArtifactUrl.pathname) === entry.fileName, `manual artifact URL basename does not match ${key}: ${entry.url}`);
  assert(!legacyArtifactUrl.search && !/[?&](?:aht_player|aht_username|aht_uuid|aht_download)=/i.test(entry.url), `legacy artifact URL leaked a download or player identifier for ${key}: ${entry.url}`);
  assert(downloadUrl.pathname === `/launcher/download/${key}` && !downloadUrl.search, `manual download URL is not the clean tracked route for ${key}: ${entry.downloadUrl}`);
  assert(entry.fileName && entry.path, `manual download fileName/path missing for ${key}`);
  assert(/^[a-f0-9]{64}$/i.test(entry.sha256 || ''), `manual download sha256 missing for ${key}`);
  assert(Number(entry.size) > 0, `manual download size missing for ${key}`);
}
const legacyRuntimeErrors = Object.entries(manifest.downloads || {}).flatMap(([key, entry]) => {
  const url = new URL(entry.url);
  const errors = [];
  if (!url.pathname.includes('/launcher/files/')) errors.push(`${key} is not under launcher/files`);
  if (path.posix.basename(url.pathname) !== entry.fileName) errors.push(`${key} URL basename differs from fileName`);
  return errors;
});
assert(legacyRuntimeErrors.length === 0, `generated feed breaks launcher 0.1.75 and older update discovery: ${legacyRuntimeErrors.join('; ')}`);
assert(manifest.downloads['windows-x64'].kind === 'nsis', 'Windows manual download must use the NSIS installer');
assert(manifest.downloads['windows-x64'].installArgs?.[0] === '/S', 'Windows manual download must preserve silent install args');
assert(manifest.downloads['macos-universal'].kind === 'dmg', 'Universal macOS manual download must use the DMG installer');
assert(Object.keys(manifest.downloads).sort().join(',') === 'macos-universal,ubuntu-x64-appimage,windows-x64', 'manifest must expose one Windows, one universal macOS, and one portable Linux download while remaining readable by 0.2.01');
assert(!Object.keys(manifest.downloads).some((key) => /^(?:darwin|win32|linux)/i.test(key)), '0.2.01 runtime validation must not reject a new manual-download key before selecting its updater artifact');
assert(manifest.downloads['ubuntu-x64-appimage']?.fileName?.endsWith('.AppImage'), '0.2.01 runtime validation must continue recognizing the single Linux download as the portable AppImage entry');
assert(result.plan.uploads.some((item) => item.rel.endsWith('.dmg')), 'DMG installers must still be uploaded for website/manual downloads');
assert(result.plan.uploads.some((item) => item.rel.endsWith('.deb')), 'Linux compatibility DEB must be uploaded for pre-0.2.02 clients');
assert(result.plan.uploads.some((item) => item.rel.endsWith('.AppImage')), 'Portable Linux AppImage must be uploaded');
assert(['linux-x64', 'linux', 'ubuntu-x64', 'ubuntu'].every((key) => manifest.platforms[key]?.kind === 'deb'), 'manifest must retain every legacy Linux runtime alias');
assert(['portable-linux-x64', 'portable-linux'].every((key) => manifest.stagedPlatforms[key]?.kind === 'appimage'), 'manifest must publish every portable Linux runtime alias');
assert(result.plan.uploads.at(-1)?.rel === 'launcher/latest.json', 'launcher/latest.json must upload last');
assert(result.plan.uploads.at(-1)?.contentType === 'application/json', 'launcher/latest.json content type must be shell-safe');
assert(result.plan.uploads.every((item) => path.isAbsolute(item.file)), 'upload plan must use absolute files');

const uploadDryRun = await uploadR2Plan({
  planPath: result.planPath,
  bucket: 'ahtlauncher',
  dryRun: true
});
assert(uploadDryRun.uploaded.length === result.plan.uploads.length, 'dry-run upload count mismatch');

const badManifest = JSON.parse(JSON.stringify(manifest));
badManifest.downloads['windows-x64'].fileName = 'AHT-Launcher-Windows-10-11-7.8.8.exe';
badManifest.downloads['macos-universal'].path = 'launcher/files/darwin-universal/AHT-Launcher-macOS-universal-7.8.8.dmg';
badManifest.downloads['macos-universal'].url = 'https://example.test/launcher/files/darwin-universal/AHT-Launcher-macOS-universal-7.8.8.dmg?aht_download=macos-universal';
badManifest.platforms['win32-x64'].url = badManifest.platforms['win32-x64'].url.replace('https://', 'http://');
badManifest.platforms['windows-x64'].installArgs = [];
badManifest.stagedPlatforms['win32-x64'].kind = 'nsis';
badManifest.platforms['darwin-arm64'].kind = 'dmg';
badManifest.platforms['linux-x64'].kind = 'appimage';
badManifest.stagedPlatforms['portable-linux-x64'].kind = 'deb';
const badValidation = validateLauncherUpdateManifest(badManifest, {
  latestUrl: 'https://example.test/launcher/latest.json',
  requireTrackedDownloads: true
});
assert(!badValidation.ok && badValidation.errors.some((error) => error.includes('fileName must include launcher version 7.8.9')), 'manifest validator must reject stale launcher artifact filenames');
assert(badValidation.errors.some((error) => error.includes('path basename must match fileName')), 'manifest validator must reject artifact paths that point at a different fileName');
assert(badValidation.errors.some((error) => error.includes('url basename must match fileName')), 'manifest validator must reject artifact URLs that point at a different fileName');
assert(badValidation.errors.some((error) => error.includes('platforms.win32-x64 url must point at launcher/files/')), 'manifest validator must reject non-HTTPS launcher artifact URLs');
assert(badValidation.errors.some((error) => error.includes('platforms.windows-x64 must include /S silent install args')), 'manifest validator must reject Windows platform artifacts without silent install args');
assert(badValidation.errors.some((error) => error.includes('stagedPlatforms.win32-x64 kind must be zip')), 'manifest validator must reject a Windows staged update that is not a ZIP');
assert(badValidation.errors.some((error) => error.includes('platforms.darwin-arm64 kind must be zip')), 'manifest validator must reject macOS self-update platform artifacts that are not ZIPs');
assert(badValidation.errors.some((error) => error.includes('platforms.linux-x64 kind must be deb')), 'manifest validator must reject a malformed legacy Linux compatibility bridge');
assert(badValidation.errors.some((error) => error.includes('stagedPlatforms.portable-linux-x64 kind must be appimage')), 'manifest validator must reject portable Linux updates that are not AppImages');

const staleArtifacts = path.join(root, 'stale-artifacts');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-Windows-10-11-7.8.8.exe'), 'stale-windows');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-Windows-10-11-7.8.8.zip'), 'stale-windows-update');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-macOS-universal-7.8.8.zip'), 'stale-mac-universal-update');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-macOS-universal-7.8.8.dmg'), 'stale-mac-universal-installer');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-Linux-x64-7.8.8.deb'), 'stale-linux-compatibility-deb');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-Linux-x64-7.8.8.AppImage'), 'stale-linux-appimage');
let staleRejected = false;
try {
  await prepareLauncherUpdate({
    artifactsDir: staleArtifacts,
    outDir: path.join(root, 'stale-out'),
    version: '7.8.9',
    latestUrl: 'https://example.test/launcher/latest.json'
  });
} catch (error) {
  staleRejected = String(error?.message || error).includes('Missing Windows 10/11');
}
assert(staleRejected, 'launcher update prep must reject artifacts that do not match the manifest/package version');

let insecureLatestUrlRejected = false;
try {
  await prepareLauncherUpdate({
    artifactsDir: artifacts,
    outDir: path.join(root, 'insecure-out'),
    version: '7.8.9',
    latestUrl: 'http://example.test/launcher/latest.json'
  });
} catch (error) {
  insecureLatestUrlRejected = String(error?.message || error).includes('Launcher update latest URL must be HTTPS');
}
assert(insecureLatestUrlRejected, 'launcher update prep must reject non-HTTPS latest URLs before writing a manifest');

console.log(JSON.stringify({
  ok: true,
  root,
  uploadCount: result.plan.uploads.length,
  latestLast: result.plan.uploads.at(-1).rel
}, null, 2));
