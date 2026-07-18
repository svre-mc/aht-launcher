import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareLauncherUpdate } from './prepare-launcher-update.mjs';
import { uploadR2Plan } from './upload-r2-plan.mjs';
import { REQUIRED_DOWNLOAD_KEYS, validateLauncherUpdateManifest } from './validate-launcher-update-manifest.mjs';

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
await writeArtifact('AHT-Launcher-macOS-arm64-7.8.9.zip', 'mac-arm-update');
await writeArtifact('AHT-Launcher-macOS-x64-7.8.9.zip', 'mac-x64-update');
await writeArtifact('AHT-Launcher-macOS-arm64-7.8.9.dmg', 'mac-arm-installer');
await writeArtifact('AHT-Launcher-macOS-x64-7.8.9.dmg', 'mac-x64-installer');

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
  requireTrackedDownloads: true
});
assert(validation.ok, `generated launcher manifest failed reusable validation: ${validation.errors.join('; ')}`);
const requiredDownloadKeys = REQUIRED_DOWNLOAD_KEYS;
assert(uploadScript.includes("process.platform === 'win32' && /\\.cmd$/i.test(command)"), 'Windows R2 upload must shell-wrap npx.cmd');
assert(manifest.version === '7.8.9', 'manifest version mismatch');
assert(manifest.platforms['win32-x64']?.installArgs?.[0] === '/S', 'Windows silent install args missing');
assert(manifest.platforms['darwin-arm64']?.path?.includes('/darwin-arm64/'), 'Apple Silicon path missing');
assert(manifest.platforms['darwin-x64']?.path?.includes('/darwin-x64/'), 'Intel macOS path missing');
assert(manifest.platforms['darwin-arm64']?.kind === 'zip', 'Apple Silicon launcher updates must use ZIP, not DMG');
assert(manifest.platforms['darwin-x64']?.fileName?.endsWith('.zip'), 'Intel macOS launcher updates must use ZIP artifacts');
assert(manifest.downloads?.['macos-arm64']?.kind === 'dmg', 'Apple Silicon manual download must keep DMG installer');
for (const key of requiredDownloadKeys) {
  const entry = manifest.downloads?.[key];
  assert(entry, `manual download entry missing: ${key}`);
  const downloadUrl = new URL(entry.url);
  assert(downloadUrl.pathname.startsWith('/launcher/files/'), `manual download URL is not compatible with installed legacy launchers for ${key}: ${entry.url}`);
  assert(path.posix.basename(downloadUrl.pathname) === entry.fileName, `manual download URL basename does not match ${key}: ${entry.url}`);
  assert(downloadUrl.searchParams.get('aht_download') === key, `manual download URL is not telemetry-tagged for ${key}: ${entry.url}`);
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
assert(manifest.downloads['macos-x64'].kind === 'dmg', 'Intel manual download must keep DMG installer');
assert(!Object.keys(manifest.downloads).some((key) => /^darwin|^win32|linux|ubuntu/i.test(key)), 'manual downloads must use website-facing Windows/macOS keys only');
assert(result.plan.uploads.some((item) => item.rel.endsWith('.dmg')), 'DMG installers must still be uploaded for website/manual downloads');
assert(!Object.keys(manifest.platforms).some((key) => /linux|ubuntu/i.test(key)), 'manifest must not publish Linux artifacts');
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
badManifest.downloads['macos-x64'].path = 'launcher/files/darwin-x64/AHT-Launcher-macOS-x64-7.8.8.dmg';
badManifest.downloads['macos-arm64'].url = 'https://example.test/launcher/files/darwin-arm64/AHT-Launcher-macOS-arm64-7.8.8.dmg';
badManifest.platforms['win32-x64'].url = badManifest.platforms['win32-x64'].url.replace('https://', 'http://');
badManifest.platforms['windows-x64'].installArgs = [];
badManifest.platforms['darwin-arm64'].kind = 'dmg';
const badValidation = validateLauncherUpdateManifest(badManifest, {
  latestUrl: 'https://example.test/launcher/latest.json',
  requireTrackedDownloads: true
});
assert(!badValidation.ok && badValidation.errors.some((error) => error.includes('fileName must include launcher version 7.8.9')), 'manifest validator must reject stale launcher artifact filenames');
assert(badValidation.errors.some((error) => error.includes('path basename must match fileName')), 'manifest validator must reject artifact paths that point at a different fileName');
assert(badValidation.errors.some((error) => error.includes('url basename must match fileName')), 'manifest validator must reject artifact URLs that point at a different fileName');
assert(badValidation.errors.some((error) => error.includes('platforms.win32-x64 url must point at launcher/files/')), 'manifest validator must reject non-HTTPS launcher artifact URLs');
assert(badValidation.errors.some((error) => error.includes('platforms.windows-x64 must include /S silent install args')), 'manifest validator must reject Windows platform artifacts without silent install args');
assert(badValidation.errors.some((error) => error.includes('platforms.darwin-arm64 kind must be zip')), 'manifest validator must reject macOS self-update platform artifacts that are not ZIPs');

const staleArtifacts = path.join(root, 'stale-artifacts');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-Windows-10-11-7.8.8.exe'), 'stale-windows');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-macOS-arm64-7.8.8.zip'), 'stale-mac-arm-update');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-macOS-x64-7.8.8.zip'), 'stale-mac-x64-update');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-macOS-arm64-7.8.8.dmg'), 'stale-mac-arm-installer');
await writeArtifact(path.join('..', path.basename(staleArtifacts), 'AHT-Launcher-macOS-x64-7.8.8.dmg'), 'stale-mac-x64-installer');
let staleRejected = false;
try {
  await prepareLauncherUpdate({
    artifactsDir: staleArtifacts,
    outDir: path.join(root, 'stale-out'),
    version: '7.8.9',
    latestUrl: 'https://example.test/launcher/latest.json'
  });
} catch (error) {
  staleRejected = String(error?.message || error).includes('Missing Windows 10/11 launcher artifact');
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
