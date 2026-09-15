import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = process.env.AHT_PACKAGED_RESOURCES || path.join(root, 'release-builds/windows/win-unpacked/resources');
const asar = path.join(resources, 'app.asar');
const modules = [
  'desktop/main.js', 'desktop/preload.cjs', 'desktop/renderer/app.js',
  ...['accountRegistrationCoordinator', 'launcherIdentityStore', 'accountIdentityState', 'accountStatusRefresh',
    'minecraftInteractiveRecovery', 'minecraftRecoveryProfile', 'recoveryResultChannel', 'minecraftAccountRecovery',
    'minecraftRegistrationService', 'windowsMinecraftSession', 'serviceTransport', 'boundedJson', 'launcherProof', 'launcherProofTransactions',
    'nativeGuard', 'nativeGuardTransport', 'nativeGuardSessions', 'phoenixInstallation', 'phoenixMonitor',
    'developerAdminService', 'forgeInstaller', 'minecraftSessionIdentity', 'runtimeRepair'].map(name => `src/${name}.js`)
];
for (const file of modules) {
  assert.deepEqual(extractFile(asar, file.split('/').join(path.sep)), await fs.readFile(path.join(root, file)),
    `Packaged backend differs from the tested source: ${file}`);
}
const files = listPackage(asar);
const packagedZipVersion = JSON.parse(extractFile(asar, ['node_modules', 'adm-zip', 'package.json'].join(path.sep))).version;
const expectedZipVersion = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8')).packages['node_modules/adm-zip'].version;
assert.equal(packagedZipVersion, expectedZipVersion, 'Packaged archive dependency differs from the tested lockfile');
for (const forbidden of ['releaseBuilder.js', 'serverTransfer.js', 'githubActions.js', 'r2DirectUpload.js',
  'r2StorageBudget.js', 'r2RollbackArchive.js', 'modpackPublication.js', 'Guard.cs', 'PhoenixProbeServer.cs']) {
  assert(!files.some(file => file.endsWith(`/${forbidden}`) || file.endsWith(`\\${forbidden}`)), `Private/build source packaged: ${forbidden}`);
}
console.log(JSON.stringify({ passed: true, exactBackendModules: modules.length, archiveDependency: packagedZipVersion, privateBuildSourcesExcluded: true }));
