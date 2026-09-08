import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { inspectMinecraftLauncherAuth, ensureMinecraftLauncherProfile } from '../src/minecraftLauncherProfile.js';

const source = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
function declaration(start, end) {
  const offset = source.indexOf(start);
  assert(offset >= 0);
  return source.slice(offset, source.indexOf(end, offset));
}
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-linux-account-'));
const nativeRoot = path.join(directory, '.minecraft');
const curseForgeRoot = path.join(directory, 'Documents', 'curseforge', 'minecraft', 'Install');
const uuid = '12345678-1234-1234-1234-123456789abc';
async function account(root, name) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'launcher_accounts.json'), JSON.stringify({
    activeAccountLocalId: 'active', accounts: { active: { minecraftProfile: { name, id: uuid.replaceAll('-', '') } } }
  }));
}
await account(nativeRoot, 'NativePlayer');
await account(curseForgeRoot, 'OldPackPlayer');
let savedIdentity = { installId: 'fixture-install' };
let signedIdentity = null;
let registrationError = '';
const cache = new Map();
const context = vm.createContext({
  process: { platform: 'linux', env: {} }, path,
  app: { getPath: () => directory }, launcherProofStorageDir: (value) => value,
  trustedMinecraftOpenCommandAllowed: () => false, defaultMinecraftRoot: () => nativeRoot,
  firstExistingCurseForgeMinecraftRoot: () => { throw new Error('Linux must not auto-select a CurseForge root'); },
  minecraftRootCandidates: () => [nativeRoot], samePath: (a, b) => path.resolve(a) === path.resolve(b),
  inspectMinecraftLauncherAuth, loadIdentity: async () => ({ ...savedIdentity }),
  normalizeMinecraftUsername: (value) => String(value || '').trim(),
  normalizeMinecraftUuid: (value) => value || '',
  registerMinecraftUsernameInFlight: async (_config, identity, username, options) => {
    if (registrationError) throw new Error(registrationError);
    assert.equal(options.minecraftUuid, uuid, 'Keep the UUID when importing the signed-in account');
    savedIdentity = { ...identity, minecraftUsername: username, minecraftUuid: options.minecraftUuid };
    return { username };
  },
  writeJsonFile: async (_file, identity) => { savedIdentity = identity; }, identityPath: () => 'identity-fixture',
  refreshRemoteMinecraftRegistration: async (_config, identity) => identity,
  publicDeviceIdentity: async () => ({ deviceId: 'fixture-device' }), launcherVersion: () => '0.2.07',
  launchPreparationCache: cache, LAUNCH_PREPARATION_PROOF_MIN_VALIDITY_MS: 1000,
  writeSerializedRegisteredLauncherProof: async ({ identity }) => { signedIdentity = identity; return { usable: true, trusted: true }; },
  scheduleLaunchPreparationProofRefresh: () => {}
});
vm.runInContext(
  declaration('async function minecraftLauncherRuntimeConfig(', '\nfunction localReleaseCandidates(')
  + declaration('async function identityPayload(', '\nfunction normalizeMinecraftUsername(')
  + declaration('async function refreshPreparedLauncherProof(', '\nfunction scheduleLaunchPreparationProofRefresh('), context
);
const configured = { instanceDir: path.join(directory, 'Published AHT'), minecraftLauncher: { rootDir: curseForgeRoot, rootSelection: 'automatic', profileId: 'a-hard-time-dregora' } };
const config = await context.minecraftLauncherRuntimeConfig(configured);
assert.equal(config.minecraftLauncher.rootDir, nativeRoot);
assert.equal((await context.minecraftLauncherRuntimeConfig({ ...configured, minecraftLauncher: { ...configured.minecraftLauncher, rootSelection: 'manual' } })).minecraftLauncher.rootDir, curseForgeRoot);
const entry = { state: 'ready', launcherConfig: config, identity: { installId: 'fixture-install' }, latest: {}, installed: {} };
cache.set('stable', entry);
await context.refreshPreparedLauncherProof('stable', entry);
assert.equal(signedIdentity.minecraftUsername, 'NativePlayer', 'A username-free startup snapshot must import the active standalone account before signing');
assert.equal(signedIdentity.minecraftUuid, uuid);

// Create the published profile in the same folder that supplied the identity.
const latest = { packId: 'a-hard-time-dregora', minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }] } };
await ensureMinecraftLauncherProfile({ config: { ...config, minecraftLauncher: { ...config.minecraftLauncher, syncDefaultRoots: false } }, latest, selectForPlay: true });
const profiles = JSON.parse(await fs.readFile(path.join(nativeRoot, 'launcher_profiles.json'), 'utf8'));
assert.equal(profiles.profiles['a-hard-time-dregora'].gameDir, configured.instanceDir);
assert.match(profiles.profiles['a-hard-time-dregora'].lastVersionId, /1\.12\.2.*14\.23\.5\.2860/);
assert.equal((await inspectMinecraftLauncherAuth(nativeRoot)).preferredUsername, 'NativePlayer');

savedIdentity = { installId: 'fixture-install' }; signedIdentity = null; registrationError = 'Account registration was rejected';
await assert.rejects(context.refreshPreparedLauncherProof('stable', entry), /Account registration was rejected/);
assert.equal(signedIdentity, null, 'Registration failure must never bypass the server proof gate');
registrationError = ''; config.minecraftLauncher.autoImportAccount = false; savedIdentity = { installId: 'fixture-install' };
await assert.rejects(context.refreshPreparedLauncherProof('stable', entry), /Sign in to your Minecraft account/);
console.log('PASS: Linux automatic root migration, manual roots, uncached active account/UUID import, published profile path, and fail-closed registration.');
