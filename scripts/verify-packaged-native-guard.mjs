import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(root, 'release-builds/windows/win-unpacked/resources');
const asar = path.join(resources, 'app.asar');
const packagedPaths = listPackage(asar);
const packagedFile = (relativePath) => extractFile(asar, String(relativePath).split('/').join(path.sep));
const metadata = JSON.parse(packagedFile('package.json'));
const antiCheatVersion = String(metadata.phoenixAntiCheatVersion || '');
const releaseFile = path.join(
  root,
  'release-builds/phoenix-anticheat',
  `Phoenix-Anti-cheat-Windows-x64-${antiCheatVersion}.exe`
);
const developmentManifest = JSON.parse(await fs.readFile(path.join(root, 'build/native-guard/manifest.json'), 'utf8'));
const binary = await fs.readFile(releaseFile);
const packagedMain = packagedFile('desktop/main.js').toString();
const packagedRenderer = packagedFile('desktop/renderer/app.js').toString();
const packagedNativeGuardManager = packagedFile('src/nativeGuard.js').toString();
const packagedLauncherProof = packagedFile('src/launcherProof.js').toString();
const monitorSource = packagedMain.slice(packagedMain.indexOf('function phoenixDetectionFingerprint'), packagedMain.indexOf('function phoenixAntiCheatInstallDir'));
const persistedDescriptorSource = packagedLauncherProof.slice(packagedLauncherProof.indexOf('const persistedNativeGuard'), packagedLauncherProof.indexOf('const fileProof'));

assert.equal(metadata.ahtLauncherVersion, metadata.version);
assert.match(antiCheatVersion, /^\d+\.\d+\.\d+$/);
assert(
  !packagedPaths.some((entry) => /native-guard|Phoenix Anti-cheat\.exe|Phoenix-Anti-cheat/i.test(entry)),
  'The public app.asar must not contain the anti-cheat executable or build tree'
);
assert(!packagedPaths.some((entry) => /(?:Guard\.cs|Phoenix[^/\\]*\.pdb)$/i.test(entry)), 'The public launcher must not contain Phoenix source or debug symbols');
await assert.rejects(
  fs.access(path.join(resources, 'native-guard')),
  (error) => error?.code === 'ENOENT',
  'The public launcher resources must not contain an embedded anti-cheat directory'
);
assert(packagedMain.includes("ipcMain.handle('anticheat:install'"));
assert(packagedRenderer.includes('ensurePhoenixAntiCheatBeforePlay'));
assert(packagedFile('src/minecraftLauncherProfile.js').toString().includes('-XX:+DisableAttachMechanism'));
assert(packagedMain.includes("new URL('api/session/report'") && !packagedMain.includes('api/phoenix/detections'));
assert(!monitorSource.includes('console.'), 'Packaged player monitoring must not write probe or reporting details to launcher logs');
assert(packagedNativeGuardManager.includes("Symbol.for('aht.phoenix.runtime-state.v1')"));
assert(!packagedNativeGuardManager.includes('JSON.parse(await fs.readFile(stateFile'));
assert(!packagedNativeGuardManager.includes('fs.writeFile(`${stateFile}.tmp`'));
for (const forbiddenField of ['sessionKey', 'guardPid', 'gamePid', 'modulus', 'exponent']) {
  assert(!persistedDescriptorSource.includes(forbiddenField), `Launcher proof persistence includes forbidden live field: ${forbiddenField}`);
}
assert(!packagedRenderer.includes('module: "jvm.dll"'), 'Packaged renderer fallback data must not disclose a protected-module rule');
assert.equal(developmentManifest.product, 'phoenix-anticheat');
assert.equal(developmentManifest.version, antiCheatVersion);
assert.equal(developmentManifest.file, 'Phoenix Anti-cheat.exe');
assert.equal(crypto.createHash('sha256').update(binary).digest('hex'), developmentManifest.sha256);
assert.equal(binary.length, developmentManifest.bytes);

const result = {
  passed: true,
  launcherVersion: metadata.ahtLauncherVersion,
  antiCheatVersion,
  antiCheatSha256: developmentManifest.sha256,
  antiCheatBytes: binary.length,
  embeddedInLauncher: false,
  firstPlayConsentWired: true,
  attachDisabled: true
};
await fs.mkdir(path.join(root, 'build/native-guard-test'), { recursive: true });
await fs.writeFile(
  path.join(root, 'build/native-guard-test/package-results.json'),
  `${JSON.stringify(result, null, 2)}\n`
);
console.log(JSON.stringify(result));
