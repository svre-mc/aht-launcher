import {
  cleanLauncherReleaseVersion,
  launcherPackageVersionForRelease,
  launcherReleaseVersionFromPackage,
  launcherVersionsReferToSameRelease
} from '../src/launcherVersion.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(cleanLauncherReleaseVersion('0.2.01') === '0.2.01', 'public release version must preserve its leading zero');
assert(launcherPackageVersionForRelease('0.2.01') === '0.2.1', 'public release version must map to valid npm SemVer');
assert(
  launcherReleaseVersionFromPackage({ version: '0.2.1', ahtLauncherVersion: '0.2.01' }) === '0.2.01',
  'public release version must take precedence over npm package metadata'
);
assert(launcherVersionsReferToSameRelease('0.2.1', '0.2.01'), 'npm and public release versions must match');
assert(launcherVersionsReferToSameRelease('0.2.1.0', '0.2.01'), 'Windows product and public release versions must match');
assert(!launcherVersionsReferToSameRelease('0.2.2.0', '0.2.01'), 'different launcher releases must not match');
assert(!launcherVersionsReferToSameRelease('0.2', '0.2.01'), 'incomplete launcher versions must not match');

console.log(JSON.stringify({
  ok: true,
  launcherReleaseVersion: '0.2.01',
  npmPackageVersion: '0.2.1',
  windowsProductVersion: '0.2.1.0'
}, null, 2));
