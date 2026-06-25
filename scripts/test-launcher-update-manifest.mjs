import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareLauncherUpdate } from './prepare-launcher-update.mjs';
import { uploadR2Plan } from './upload-r2-plan.mjs';

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
await writeArtifact('AHT-Launcher-macOS-arm64-7.8.9.dmg', 'mac-arm');
await writeArtifact('AHT-Launcher-macOS-x64-7.8.9.dmg', 'mac-x64');

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
assert(uploadScript.includes("process.platform === 'win32' && /\\.cmd$/i.test(command)"), 'Windows R2 upload must shell-wrap npx.cmd');
assert(manifest.version === '7.8.9', 'manifest version mismatch');
assert(manifest.platforms['win32-x64']?.installArgs?.[0] === '/S', 'Windows silent install args missing');
assert(manifest.platforms['darwin-arm64']?.path?.includes('/darwin-arm64/'), 'Apple Silicon path missing');
assert(manifest.platforms['darwin-x64']?.path?.includes('/darwin-x64/'), 'Intel macOS path missing');
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

console.log(JSON.stringify({
  ok: true,
  root,
  uploadCount: result.plan.uploads.length,
  latestLast: result.plan.uploads.at(-1).rel
}, null, 2));
