import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createMinecraftProfileSetup, minecraftProfileReady } from '../src/minecraftProfileSetup.js';
import { inspectMinecraftLauncherAuth } from '../src/minecraftLauncherProfile.js';
import { selectedMinecraftSessionState } from '../src/minecraftSessionIdentity.js';
import { diagnoseLaunchFailure } from '../src/launchDiagnostics.js';

const profile = { minecraftUsername: 'FixturePlayer', minecraftUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
test('the reported 0.2.32 sign-in failure identifies profile setup instead of a generic proof failure', () => {
  const diagnosis = diagnoseLaunchFailure({ result: 'FAILED', steps: [{ key: 'prepared-play-attestation', status: 'FAIL',
    detail: 'Sign in to your Minecraft account in Minecraft Launcher, then return to A Hard Time and click Play again.' }],
    error: { message: 'Sign in to your Minecraft account in Minecraft Launcher' } });
  assert.match(diagnosis.cause, /selected Java Edition profile/);
  assert.match(diagnosis.actions.join(' '), /Play or Repair/);
});
test('existing profile continues without opening account setup; incomplete identities cannot pass', async () => {
  const setup = createMinecraftProfileSetup();
  assert.equal(await setup.run({ readIdentity: async () => profile, openLauncher: () => assert.fail('unexpected handoff') }), profile);
  for (const identity of [{}, { minecraftUsername: 'FixturePlayer' }, { ...profile, minecraftUuid: '0'.repeat(32) }, { ...profile, minecraftUsername: 'x@y.test' }]) {
    assert.equal(minecraftProfileReady(identity), false);
  }
});
test('CurseForge-style credential-only state opens its launcher once and continues on public profile metadata', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-profile-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const credentials = path.join(root, 'launcher_msa_credentials.bin');
  await fs.writeFile(credentials, 'opaque fixture credential');
  const selected = async () => {
    const auth = await inspectMinecraftLauncherAuth(root);
    return selectedMinecraftSessionState({}, {}, { username: auth.preferredUsername, minecraftUuid: auth.preferredMinecraftUuid });
  };
  assert.equal(minecraftProfileReady(await selected()), false);
  const states = [];
  const setup = createMinecraftProfileSetup({ onState: state => states.push(state) });
  let opens = 0;
  const result = await setup.run({ readIdentity: selected, pollMs: 5, openLauncher: async () => {
    opens++;
    await fs.writeFile(path.join(root, 'launcher_profiles_microsoft_store.json'), JSON.stringify({
      selectedUser: { account: 'fixture', profile: profile.minecraftUuid.replaceAll('-', '') },
      authenticationDatabase: { fixture: { profiles: { [profile.minecraftUuid.replaceAll('-', '')]: { displayName: profile.minecraftUsername } } } }
    }));
  } });
  assert.equal(opens, 1);
  assert.equal(result.minecraftUuid, profile.minecraftUuid);
  assert.equal(result.minecraftUsername, profile.minecraftUsername);
  assert.equal(states[0].running, true);
  assert.equal(states.at(-1).running, false);
  assert.equal(await fs.readFile(credentials, 'utf8'), 'opaque fixture credential');
});
test('Cancel and timeout settle even when OS handoff stalls, and permit a fresh retry', async () => {
  for (const cancel of [false, true]) {
    let opened;
    const handoff = new Promise(resolve => { opened = resolve; });
    const setup = createMinecraftProfileSetup();
    const work = setup.run({ readIdentity: async () => ({}), timeoutMs: 30, pollMs: 5,
      openLauncher: () => { opened(); return new Promise(() => {}); } });
    const rejected = assert.rejects(work, { code: cancel ? 'MINECRAFT_PROFILE_SETUP_CANCELLED' : 'MINECRAFT_PROFILE_REQUIRED' });
    await handoff;
    if (cancel) setup.cancel();
    await rejected;
    assert.equal(setup.state().running, false);
    assert.equal(await setup.run({ readIdentity: async () => profile }), profile);
  }
});
test('setup rejects concurrent requests and propagates handoff/read failures without claiming success', async () => {
  const setup = createMinecraftProfileSetup();
  for (const failureAt of ['readIdentity', 'openLauncher']) {
    const error = new Error('fixture unavailable');
    await assert.rejects(setup.run({ readIdentity: async () => ({}), openLauncher: async () => {}, [failureAt]: async () => { throw error; } }), e => e === error);
    assert.equal(setup.state().running, false);
  }
  const work = setup.run({ readIdentity: async () => new Promise(() => {}), timeoutMs: 1000 });
  const rejected = assert.rejects(work, { code: 'MINECRAFT_PROFILE_SETUP_CANCELLED' });
  await assert.rejects(setup.run({}), { code: 'MINECRAFT_PROFILE_SETUP_BUSY' });
  setup.cancel();
  await rejected;
});
test('actual Repair button enters backend recovery even if an independent scan would fail', async () => {
  const source = await fs.readFile(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function scanFilesForRepair(');
  const calls = [];
  const context = vm.createContext({ activeSidebarPack: 'ptb', updatePoll: null, lastUpdateState: null, scanProgressHideTimer: null,
    window: { clearTimeout() {}, aht: { scanFiles: () => assert.fail('preliminary scan must not block repair') } },
    startUpdate: async (repair, options) => calls.push({ repair, ...options }), showToast() {} });
  vm.runInContext(source.slice(start, source.indexOf('\nasync function openFolderPath', start)), context);
  await context.scanFilesForRepair();
  assert.deepEqual(calls, [{ repair: true, runtimeOnly: true, packKey: 'ptb' }]);
});
test('actual Play resolves account setup before protected verification and Phoenix; cancellation stops Play', async () => {
  const main = (await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const start = main.indexOf("  if (!isDeveloperMode()) {\n    prepared.identity = await runLaunchStep(attempt, 'minecraft-account-setup'");
  const end = main.indexOf('  attempt.finalHotIntegrity =', start);
  assert(start > 0 && end > start);
  for (const cancel of [false, true]) {
    const calls = [];
    const prepared = { launcherConfig: {}, launcherRoute: { kind: 'custom' } };
    const context = vm.createContext({ prepared, key: 'stable', target: {}, attempt: {}, isDeveloperMode: () => false,
      launchPreparationCache: new Map([['stable', prepared]]),
      runLaunchStep: async (_a, _key, _title, action) => action(),
      ensurePlayerMinecraftProfile: async () => { calls.push('setup'); if (cancel) throw new Error('cancelled'); return profile; },
      verifyPreparedClientIntegrityAtPlay: async () => { calls.push('integrity'); return {}; }
    });
    vm.runInContext(`async function run() { ${main.slice(start, end)} }`, context);
    if (cancel) await assert.rejects(context.run(), /cancelled/);
    else await context.run();
    assert.deepEqual(calls, cancel ? ['setup'] : ['setup', 'integrity']);
  }
});

test('actual setup adapter cannot accept a cached AHT account after Minecraft profile metadata disappears', async () => {
  const main = (await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const start = main.indexOf('async function ensurePlayerMinecraftProfile(');
  let opens = 0;
  const context = vm.createContext({ isDeveloperMode: () => false, selectedCurseForgeStorageFile: async () => '', minecraftProfileSetup: createMinecraftProfileSetup(),
    minecraftSessionIdentityPayload: async () => opens ? { ...profile, minecraftLauncherDetectedUsername: profile.minecraftUsername,
      minecraftLauncherDetectedUuid: profile.minecraftUuid } : { ...profile, minecraftLauncherDetectedUsername: '', minecraftLauncherDetectedUuid: '' },
    openMinecraftLauncher: async () => { opens++; }, restoreMainWindowAfterMinecraftHandoffFailure() {} });
  vm.runInContext(main.slice(start, main.indexOf('\nasync function identityPayload(', start)), context);
  const identity = await context.ensurePlayerMinecraftProfile({ minecraftLauncher: {} });
  assert.equal(opens, 1);
  assert.equal(identity.minecraftUsername, profile.minecraftUsername);
});

test('actual Play adapter reuses CurseForge login without opening Mojang or exposing tokens in identity', async () => {
  const main = (await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const start = main.indexOf('async function ensurePlayerMinecraftProfile(');
  const context = vm.createContext({ isDeveloperMode: () => false,
    selectedCurseForgeStorageFile: async () => '/fixture/cf/storage.json',
    curseForgeMinecraftSessions: { acquire: async () => ({ username: profile.minecraftUsername,
      minecraftUuid: profile.minecraftUuid, accessToken: 'private-fixture-token' }) },
    minecraftSessionIdentityPayload: async (_config, { selectedProfile }) => {
      assert(!JSON.stringify(selectedProfile).includes('private'));
      assert.deepEqual(Object.keys(selectedProfile).sort(), ['minecraftUuid', 'provider', 'username']);
      assert.equal(selectedProfile.provider, 'curseforge'); return profile;
    },
    minecraftProfileSetup: { run: () => assert.fail('Existing CurseForge login opened account setup') },
    openMinecraftLauncher: () => assert.fail('Existing CurseForge login opened Mojang launcher') });
  vm.runInContext(main.slice(start, main.indexOf('\nasync function identityPayload(', start)), context);
  assert.equal(await context.ensurePlayerMinecraftProfile({ minecraftLauncher: {} }), profile);
});
