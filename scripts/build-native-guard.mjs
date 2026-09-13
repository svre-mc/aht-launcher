import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reusePhoenixRelease, phoenixBuildSources, readPhoenixBuildSource, phoenixSourceHash } from './phoenix-release-artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const version = String(packageMetadata.phoenixAntiCheatVersion || '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(version)) {
  throw new Error('package.json phoenixAntiCheatVersion must be a numeric release version.');
}

const pin = JSON.parse(await fs.readFile(path.join(root, 'native-guard', 'release.json'), 'utf8'));
const sourceFiles = phoenixBuildSources;
const source = await readPhoenixBuildSource(root);
// Published binaries are immutable build inputs. Do not depend on public edge
// access from CI runners or regenerate an already released executable.
const publishedBytes = await reusePhoenixRelease(pin, version, source, async () => new Response(
  await fs.readFile(path.join(root, 'native-guard', 'releases', `Phoenix-Anti-cheat-Windows-x64-${version}.exe`))
));

const buildDir = path.join(root, 'build', 'native-guard');
const releaseDir = path.join(root, 'release-builds', 'phoenix-anticheat');
await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(releaseDir, { recursive: true });

const compiler = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const developmentBinary = path.join(buildDir, 'Phoenix Anti-cheat.exe');
const releaseBinary = path.join(releaseDir, `Phoenix-Anti-cheat-Windows-x64-${version}.exe`);
await fs.copyFile(path.join(root, 'native-guard', 'NOTICE.txt'), path.join(buildDir, 'NOTICE.txt'));
if (publishedBytes) {
  await fs.writeFile(developmentBinary, publishedBytes);
} else execFileSync(compiler, [
  '/nologo',
  '/target:exe',
  '/platform:x64',
  '/optimize+',
  '/debug-',
  `/out:${developmentBinary}`,
  '/reference:System.Management.dll',
  '/reference:System.Web.Extensions.dll',
  ...sourceFiles.map(file => path.join(root, 'native-guard', file))
], { stdio: 'pipe', windowsHide: true });

const bytes = await fs.readFile(developmentBinary);
const manifest = {
  schema: 1,
  product: 'phoenix-anticheat',
  version,
  protocol: 'AHT-GUARD-1',
  file: path.basename(developmentBinary),
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length
};
await fs.copyFile(developmentBinary, releaseBinary);
await fs.writeFile(path.join(buildDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// Local-only build provenance. It is not copied into the player helper manifest.
await fs.writeFile(path.join(buildDir, 'build-receipt.json'), `${JSON.stringify({
  version, sourceSha256: phoenixSourceHash(source), sha256: manifest.sha256, sources: sourceFiles
}, null, 2)}\n`);
console.log(JSON.stringify({ ...manifest, releaseFile: releaseBinary }));
