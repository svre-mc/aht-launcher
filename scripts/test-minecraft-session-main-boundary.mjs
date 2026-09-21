import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { selectedMinecraftSessionState, MINECRAFT_SESSION_AUTHORITY } from '../src/minecraftSessionIdentity.js';
import { sameAccountSnapshot } from '../src/accountIdentityState.js';
import { minecraftProfileReady, minecraftProfileRequiredError } from '../src/minecraftProfileSetup.js';

const main = (await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const declaration = (start, end) => {
  const offset = main.indexOf(start), finish = main.indexOf(end, offset);
  assert(offset >= 0 && finish > offset);
  return main.slice(offset, finish);
};

test('CurseForge session routing follows the selected root and both provider settings', async () => {
  let direct = false;
  let reads = 0;
  const context = vm.createContext({
    isCurseForgeMinecraftRoot: root => root === '/cf/minecraft/Install',
    curseForgeStorageFileCandidates: () => ['/missing', '/cf/storage.json'],
    curseForgeMinecraftSessions: { mode: async file => {
      reads++;
      if (file === '/missing') throw new Error('not installed');
      return direct;
    } }
  });
  vm.runInContext(declaration('async function selectedCurseForgeStorageFile(', '\nasync function minecraftSessionIdentityPayload('), context);
  const config = { minecraftLauncher: { rootDir: '/cf/minecraft/Install' } };
  assert.equal(await context.selectedCurseForgeStorageFile(config), '');
  direct = true;
  assert.equal(await context.selectedCurseForgeStorageFile(config), '/cf/storage.json');
  assert.equal(await context.selectedCurseForgeStorageFile({ minecraftLauncher: { rootDir: '/custom', runtimeCurseForgeRoot: '/cf/custom' } }), '/cf/storage.json');
  reads = 0;
  assert.equal(await context.selectedCurseForgeStorageFile({ minecraftLauncher: { rootDir: '/official' } }), '');
  assert.equal(reads, 0, 'An unrelated selected launcher must not read CurseForge accounts');
});
test('actual player status and Play never enter AHT recovery or decrypt its secret', async () => {
  let identity = { installId: 'fixture', minecraftUsernameSyncWarning: 'legacy account unavailable' };
  let proofCalls = 0;
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const config = { minecraftLauncher: { rootDir: '/minecraft' } };
  const forbidden = () => { throw new Error('Standalone account recovery is forbidden in player Play/status.'); };
  const context = vm.createContext({ process, MINECRAFT_SESSION_AUTHORITY, selectedMinecraftSessionState, sameAccountSnapshot, minecraftProfileReady, minecraftProfileRequiredError,
    isDeveloperMode: () => false, selectedCurseForgeStorageFile: async () => '', loadIdentity: async () => ({ ...identity }),
    updateIdentity: async update => (identity = update(identity)), publicDeviceIdentity: async () => ({}),
    app: { getPath: () => '/fixture' }, minecraftRootCandidates: () => [], samePath: (a,b) => a === b,
    inspectMinecraftLauncherAuth: async () => ({ preferredUsername: 'FixturePlayer', preferredMinecraftUuid: uuid }),
    launcherVersion: () => '0.2.27', normalizeMinecraftUsername: value => value || '', normalizeMinecraftUuid: value => value || '',
    accountRecoverySecret: forbidden, registerMinecraftUsernameInFlight: forbidden, refreshRemoteMinecraftRegistration: forbidden,
    loadDeviceCredential: async () => ({ deviceId: 'key', publicKey: 'public' }),
    launcherProofIdentity: value => value, runtimeIdentity: value => value,
    writeLauncherProofWithDeveloperAuth: async options => {
      proofCalls++;
      assert.equal(options.recoverySecret, undefined);
      assert.equal(options.identity.identityAuthority, MINECRAFT_SESSION_AUTHORITY);
      assert.equal(options.identity.minecraftUuid, uuid);
      assert.equal(options.nativeGuard.keyHash, 'native-session');
      return { trusted: true, payload: { accountLinked: false } };
    }
  });
  vm.runInContext([
    declaration('async function minecraftSessionIdentityPayload(', '\nfunction normalizeMinecraftUsername('),
    declaration('async function writeRegisteredLauncherProof(', '\nasync function writeSerializedRegisteredLauncherProof(')
  ].join('\n'), context);
  const results = await Promise.all([context.identityPayload(config), context.identityPayload(config, { forceAccountSync: true })]);
  for (const result of results) {
    assert.equal(result.minecraftUsername, 'FixturePlayer');
    assert.equal(result.minecraftUsernameSyncWarning, '');
    assert.equal(result.remoteRegistrationConfirmedAt, '');
  }
  await context.writeRegisteredLauncherProof({ config, identity: results[0], nativeGuard: { keyHash: 'native-session' } });
  assert.equal(proofCalls, 1);
  identity = { ...identity, remoteRegistrationConfirmedAt: 'stale', remoteRegistrationWorkerBaseUrl: 'stale' };
  await context.writeRegisteredLauncherProof({ config, identity: { ...identity }, nativeGuard: { keyHash: 'native-session' } });
  assert.equal(identity.remoteRegistrationConfirmedAt, '');
  assert.equal(identity.remoteRegistrationWorkerBaseUrl, '');
  const denied = Object.assign(new Error('Access restricted'), { code: 'ACCESS_RESTRICTED' });
  context.writeLauncherProofWithDeveloperAuth = async () => { throw denied; };
  await assert.rejects(context.writeRegisteredLauncherProof({ config, identity: results[0] }), error => error === denied);
});
