import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as runtimeRepair from '../src/runtimeRepair.js';
import path from 'node:path';

const main = fs.readFileSync(process.env.AHT_TEST_MAIN_SOURCE || new URL('../desktop/main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
test('public account warnings stay concise while local diagnostics remain available', () => {
  const publicError = main.slice(main.indexOf('function playerPublicErrorMessage('), main.indexOf('\nfunction errorForRenderer('));
  const publicIdentity = main.slice(main.indexOf('function identityForRenderer('), main.indexOf('\nfunction minecraftLauncherHandoffForRenderer('));
  let developer = false;
  const context = vm.createContext({ isDeveloperMode: () => developer });
  vm.runInContext(`${publicError}\n${publicIdentity}`, context);
  const identity = { minecraftUsernameSyncWarning: 'AHT could not verify Minecraft account ownership using the available session data. Session diagnostics: {"directCandidates":0}' };
  assert.equal(context.identityForRenderer(identity).minecraftUsernameSyncWarning, 'Minecraft account verification failed. Retry account sync.');
  assert.match(identity.minecraftUsernameSyncWarning, /Session diagnostics/);
  developer = true;
  assert.equal(context.identityForRenderer(identity).minecraftUsernameSyncWarning, identity.minecraftUsernameSyncWarning);
});
const updateSource = main.slice(main.indexOf('async function runUpdate('), main.indexOf('\nfunction defaultLauncherInstallerArgs'));
function updateHarness({ warning = '', developer = false, confirmed = true } = {}) {
  const calls = [];
  const target = { id: 'stable', sidebarKey: 'stable' };
  const config = { instanceDir: '/fixture/stable', latestUrl: 'https://fixture.invalid/latest.json', launcherProof: { enabled: true } };
  const identity = { minecraftUsername: 'FixturePlayer', minecraftUuid: '12345678-1234-4234-9234-123456789abc', minecraftUsernameSyncWarning: warning };
  const context = vm.createContext({
    ...runtimeRepair, updateState: {}, releaseTarget: () => target,
    invalidateLaunchPreparation: () => calls.push('invalidate'),
    createOperationState: kind => ({ kind, running: true }), appendOperationLine() {},
    configForPack: value => value, loadConfig: async () => config,
    minecraftLauncherRuntimeConfig: async value => value,
    identityPayload: async (_config, options) => { calls.push(options?.forceAccountSync ? 'account-revalidate' : 'identity'); return identity; },
    remoteRegistrationSatisfiesRequest: () => confirmed,
    readLatest: async () => ({ packId: 'fixture', version: '1' }), developerClientBypassAllowed: () => developer,
    isDeveloperMode: () => developer, requirePlayerFullClientRelease() {}, migrateInstanceSecurityState: async () => {},
    sendLauncherEvent: async (_config, _identity, value) => calls.push(value.type),
    prepareRuntimeOnlyRepair: async () => ({ installed: { version: '1' }, runtimeOnly: true }),
    installPack: async () => ({ installed: { version: '1' } }), managedStatePath: () => '',
    useBundledJava8: () => false, process: { env: {} },
    repairMinecraftRuntime: async () => ({ profile: {}, minecraftAssets: {} }),
    scanCurrentManagedIntegrity: async () => ({ valid: true, counts: { managed: 10, corrupted: 0 } }),
    writeIntegrityState: async (_config, value) => value,
    publishCompletedUpdatePreparation: async value => { calls.push('ready'); assert.equal(value.launcherProof, null); },
    completeOperationState: state => { state.running = false; calls.push('complete'); },
    failOperationState: state => { state.running = false; calls.push('failed'); }
  });
  vm.runInContext(updateSource, context);
  return { calls, run: (repair = true, runtimeOnly = false) => context.runUpdate(repair, { runtimeOnly }),
    setWarning: value => { identity.minecraftUsernameSyncWarning = value; } };
}

test('Repair cannot report success while legacy Minecraft ownership recovery is blocked', async () => {
  for (const runtimeOnly of [false, true]) {
    const h = updateHarness({ warning: 'Your older AHT account needs a fresh Minecraft session.' });
    await assert.rejects(h.run(true, runtimeOnly), /Minecraft session/);
    assert(h.calls.includes('account-revalidate'));
    assert(!h.calls.includes('ready') && !h.calls.includes('complete'));
    assert(h.calls.includes('repair_failed'));
    h.setWarning('');
    await h.run(true, runtimeOnly);
    assert(h.calls.indexOf('account-revalidate') < h.calls.indexOf('ready'));
    assert(h.calls.includes('repair_completed'), 'A later valid session must recover without restarting AHT');
  }
});

test('Repair requires confirmed registration; initial install and developer scope remain separate', async () => {
  await assert.rejects(updateHarness({ confirmed: false }).run(), /account/i);
  for (const h of [updateHarness({ warning: 'unavailable' }), updateHarness({ warning: 'unavailable', developer: true })]) {
    await h.run(false);
    assert(h.calls.includes('complete'));
  }
  const dev = updateHarness({ developer: true, confirmed: false });
  await dev.run();
  assert(!dev.calls.includes('account-revalidate'));
});

test('failed Play authorization never opens Minecraft Launcher; successful proof opens once', async () => {
  const play = main.slice(main.indexOf("ipcMain.handle('play:start'"));
  const start = play.indexOf('  const nativeGuard = await runLaunchStep(');
  const end = play.indexOf('  if (nativeGuard) {\n    // A successful installation/startup check');
  assert(start >= 0 && end > start, 'Missing Play handoff boundaries');
  const section = play.slice(start, end);
  assert(section.includes('const launchResult = await runLaunchStep('));
  for (const fail of [true, false]) {
    const calls = [];
    const prepared = { launcherConfig: {}, identity: {}, latest: {}, installed: {}, proofPreparedThisSession: false };
    const context = vm.createContext({
      prepared, attempt: {}, key: 'stable', launchPreparationCache: new Map([['stable', prepared]]),
      launchNativeGuards: new Map(), launcherNativeGuard: async () => null,
      runLaunchStep: async (_attempt, key, _label, action) => { calls.push(key); return action(); },
      openMinecraftLauncher: async () => { calls.push('opened'); return { visibilityConfirmed: true }; },
      refreshPreparedLauncherProof: async () => {
        if (fail) throw new Error('Minecraft session unavailable');
        calls.push('signed'); return { usable: true, trusted: true, payload: { launchId: 'fixture' } };
      },
      retainActiveLauncherProof() {}, queuePhoenixDetectionMonitor() {}
    });
    vm.runInContext(`async function scenario() { ${section}\n }`, context);
    if (fail) {
      await assert.rejects(context.scenario(), /Minecraft session unavailable/);
      assert(!calls.includes('opened'), 'Authentication failure opened Minecraft without usable proof');
    } else {
      await context.scenario();
      assert.equal(calls.filter(value => value === 'opened').length, 1);
      assert(calls.indexOf('signed') < calls.indexOf('opened'));
    }
  }
});

test('an old confirmation cannot clear a newer unresolved account-sync failure', () => {
  const source = main.slice(main.indexOf('function remoteRegistrationSatisfiesRequest('),
    main.indexOf('\nasync function registerMinecraftUsernameInFlight('));
  const context = vm.createContext({
    normalizeMinecraftUsername: value => String(value || '').trim(),
    normalizeMinecraftUuid: value => String(value || '').replaceAll('-', '').toLowerCase(),
    remoteRegistrationBaseUrl: config => config.sync.baseUrl
  });
  vm.runInContext(source, context);
  const config = { sync: { baseUrl: 'https://fixture.invalid' } };
  const identity = { minecraftUsername: 'FixturePlayer', minecraftUuid: 'a'.repeat(32),
    remoteRegistrationConfirmedAt: '2026-09-01T00:00:00Z',
    remoteRegistrationWorkerBaseUrl: config.sync.baseUrl,
    minecraftUsernameSyncWarning: 'AHT could not verify Minecraft account ownership using the available session data.' };
  assert.equal(context.remoteRegistrationSatisfiesRequest(config, identity, 'FixturePlayer', identity.minecraftUuid), false);
  identity.minecraftUsernameSyncWarning = '';
  assert.equal(context.remoteRegistrationSatisfiesRequest(config, identity, 'FixturePlayer', identity.minecraftUuid), true);
});

function mainDeclaration(start, end) {
  const offset = main.indexOf(start);
  const finish = main.indexOf(end, offset);
  assert(offset >= 0 && finish > offset, `Missing declaration: ${start}`);
  return main.slice(offset, finish);
}

for (const cancel of [false, true]) {
  test(`Play overlapping a failed background account sync reaches recovery (${cancel ? 'cancel' : 'success'})`, async () => {
    const config = { instanceDir: '/fixture', sync: { baseUrl: 'https://fixture.invalid' },
      minecraftLauncher: { rootDir: '/fixture/minecraft' } };
    let identity = { installId: 'fixture', minecraftUsername: 'FixturePlayer', minecraftUuid: 'a'.repeat(32),
      usernameRegistrationMode: 'minecraft-launcher' };
    const entry = { state: 'ready', launcherConfig: config, identity, latest: {}, installed: {} };
    const calls = [];
    const pending = new Map();
    let releaseBackground;
    let releaseRecovery;
    const backgroundFailure = Object.assign(new Error('AHT could not verify Minecraft account ownership using the available session data. Session diagnostics: {"matchedAccounts":1,"directCandidates":0,"protectedCaches":1,"protectedCandidates":0,"joinAttempts":0}'), { code: 'MINECRAFT_SESSION_REQUIRED' });
    const context = vm.createContext({
      path, process, config, entry,
      app: { getPath: () => '/fixture' }, minecraftRootCandidates: () => [], samePath: (a, b) => a === b,
      inspectMinecraftLauncherAuth: async () => ({ preferredUsername: 'FixturePlayer', preferredMinecraftUuid: identity.minecraftUuid }),
      loadIdentity: async () => ({ ...identity }), identityPath: () => '/fixture/identity.json',
      writeJsonFile: async (_file, value) => { identity = { ...value }; },
      loadDeviceCredential: async () => ({ deviceId: 'fixture-device', publicKey: 'fixture-public' }),
      publicDeviceIdentity: async () => ({}), launcherVersion: () => 'fixture',
      isDeveloperMode: () => false, developerAdminSessionAllowed: () => false,
      accountRecoverySecret: async () => 'synthetic-fixture-only',
      runtimeIdentity: value => value, launcherProofIdentity: value => value,
      workerServiceBaseUrl: value => value || '',
      isLauncherProofRegistrationError: error => error.code === 'UNREGISTERED',
      isUsernameUnavailableError: () => false,
      remoteRegistrationRefreshes: pending, remoteRegistrationsCompletedThisSession: new Map(),
      launchPreparationCache: new Map([['stable', entry]]),
      LAUNCH_PREPARATION_PROOF_MIN_VALIDITY_MS: 1000,
      releaseTarget: id => ({ id }),
      verifyPreparedClientIntegrityAtPlay: async () => { calls.push('integrity-rechecked'); },
      registerMinecraftUsername: async (_username, options) => {
        calls.push(options.allowInteractiveRecovery ? 'interactive' : 'background');
        if (!options.allowInteractiveRecovery) {
          return new Promise((_resolve, reject) => { releaseBackground = () => reject(backgroundFailure); });
        }
        await new Promise((resolve, reject) => {
          releaseRecovery = () => cancel
            ? reject(Object.assign(new Error('Account verification cancelled.'), { code: 'MINECRAFT_RECOVERY_CANCELLED' }))
            : resolve();
        });
        await options.beforeInteractiveRecoveryCompletes();
        identity = { ...identity, minecraftUsernameSyncWarning: '', remoteRegistrationConfirmedAt: new Date().toISOString(),
          remoteRegistrationWorkerBaseUrl: config.sync.baseUrl };
        return { ok: true, remote: { recovered: true } };
      },
      writeLauncherProofWithDeveloperAuth: async ({ nativeGuard }) => {
        if (!identity.remoteRegistrationConfirmedAt) throw Object.assign(new Error('Not registered.'), { code: 'UNREGISTERED' });
        calls.push('authorized');
        return { usable: true, trusted: true, payload: { nativeGuardKeyHash: nativeGuard.keyHash }, nativeGuard };
      }
    });
    vm.runInContext([
      mainDeclaration('async function identityPayload(', '\nfunction normalizeMinecraftUsername('),
      mainDeclaration('function normalizeMinecraftUsername(', '\nasync function registerMinecraftUsernameInFlight('),
      mainDeclaration('async function registerMinecraftUsernameInFlight(', '\nfunction accountRecoveryCredentialPath('),
      mainDeclaration('async function writeRegisteredLauncherProof(', '\nasync function writeSerializedRegisteredLauncherProof('),
      mainDeclaration('async function refreshPreparedLauncherProof(', '\nfunction scheduleLaunchPreparationProofRefresh(')
    ].join('\n'), context);
    context.writeSerializedRegisteredLauncherProof = options => context.writeRegisteredLauncherProof(options);
    const background = context.identityPayload(config);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseBackground, 'function');
    const concurrentStatus = context.identityPayload(config);
    const nativeGuard = { keyHash: 'f'.repeat(64), protocol: 'AHT-GUARD-1' };
    const play = context.refreshPreparedLauncherProof('stable', entry, nativeGuard, { allowInteractiveRecovery: true });
    // Attach rejection handlers immediately: the broken path fails all shared waiters.
    const outcome = play.then(value => ({ value }), error => ({ error }));
    const statusOutcome = concurrentStatus.then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setImmediate(resolve));
    releaseBackground();
    await background;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseRecovery, 'function', 'A failed shared background sync aborted Play before its interactive recovery');
    assert.equal((await statusOutcome).error, undefined, 'Background status must return a warning, not reject a shared registration failure');
    assert.match(identity.minecraftUsernameSyncWarning, /available session data/);
    assert.deepEqual(calls, ['background', 'interactive']);
    assert.equal(entry.launcherProof, undefined, 'Recovery UI is not proof of account ownership');
    releaseRecovery();
    const result = await outcome;
    assert.equal(pending.size, 0);
    if (cancel) {
      assert.equal(result.error.code, 'MINECRAFT_RECOVERY_CANCELLED');
      assert(!calls.includes('authorized'));
      assert(identity.minecraftUsernameSyncWarning);
    } else {
      assert.equal(result.error, undefined);
      assert.equal(result.value.payload.nativeGuardKeyHash, nativeGuard.keyHash);
      assert.deepEqual(calls, ['background', 'interactive', 'integrity-rechecked', 'authorized']);
      assert.equal(identity.minecraftUsernameSyncWarning, '');
    }
  });
}
