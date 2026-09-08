import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHOENIX_ANTI_CHEAT_CONSENT_VERSION } from '../../src/nativeGuard.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function loadDevelopmentPackage(expectedVersion) {
  const packageDir = path.join(repositoryRoot, 'build', 'native-guard');
  const manifestPath = path.join(packageDir, 'manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const binaryPath = path.join(packageDir, String(manifest.file || ''));
    const bytes = fs.readFileSync(binaryPath);
    if (manifest.product !== 'phoenix-anticheat'
        || manifest.version !== expectedVersion
        || manifest.protocol !== 'AHT-GUARD-1'
        || manifest.file !== 'Phoenix Anti-cheat.exe'
        || Number(manifest.bytes) !== bytes.length
        || manifest.sha256 !== sha256(bytes)) return null;
    return { manifest, binaryPath, bytes };
  } catch {
    return null;
  }
}

export async function installPhoenixTestFixture(userData) {
  if (process.platform !== 'win32') return null;
  const packageMetadata = JSON.parse(await fsp.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const version = String(packageMetadata.phoenixAntiCheatVersion || '').trim();
  let developmentPackage = loadDevelopmentPackage(version);
  if (!developmentPackage) {
    execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'build-native-guard.mjs')], {
      cwd: repositoryRoot,
      stdio: 'pipe',
      windowsHide: true
    });
    developmentPackage = loadDevelopmentPackage(version);
  }
  if (!developmentPackage) throw new Error('Could not prepare the verified Phoenix Anti-cheat test fixture.');

  const directory = path.join(userData, 'Phoenix Anti-cheat');
  const fileName = `Phoenix Anti-cheat-${version}.exe`;
  const destination = path.join(directory, fileName);
  const installedAt = new Date().toISOString();
  await fsp.mkdir(directory, { recursive: true });
  await fsp.copyFile(developmentPackage.binaryPath, destination);
  await fsp.writeFile(path.join(directory, 'installed.json'), `${JSON.stringify({
    schemaVersion: 1,
    product: 'phoenix-anticheat',
    version,
    protocol: developmentPackage.manifest.protocol,
    fileName,
    sourceFileName: `Phoenix-Anti-cheat-Windows-x64-${version}.exe`,
    sha256: developmentPackage.manifest.sha256,
    size: developmentPackage.bytes.length,
    consentVersion: PHOENIX_ANTI_CHEAT_CONSENT_VERSION,
    consentAcceptedAt: installedAt,
    installedAt
  }, null, 2)}\n`, 'utf8');
  return destination;
}
