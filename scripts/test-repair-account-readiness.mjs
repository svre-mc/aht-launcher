import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import path from 'node:path';
import * as runtimeRepair from '../src/runtimeRepair.js';

const main = fs.readFileSync(process.env.AHT_TEST_MAIN_SOURCE || new URL('../desktop/main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
test('folder replacement errors are actionable and do not expose local paths', () => {
  const publicError = main.slice(main.indexOf('function playerPublicErrorMessage('), main.indexOf('\nfunction errorForRenderer('));
  let developer = false;
  const context = vm.createContext({ isDeveloperMode: () => developer });
  vm.runInContext(publicError, context);
  const error = { code: 'AHT_INSTALL_IN_USE', message: "Windows could not replace the game folder. EPERM rename C:\\private\\instance" };
  const expected = 'Windows could not replace the game folder. Close Minecraft and apps using the game folder, then retry.';
  assert.equal(context.playerPublicErrorMessage(error, 'update:start'), expected);
  assert.equal(context.playerPublicErrorMessage(error.message, 'update:start'), expected);
  assert.equal(context.playerPublicErrorMessage(new Error('Download failed'), 'update:start'), 'Download failed.');
  context.updateResultForRenderer = () => null;
  vm.runInContext(main.slice(main.indexOf('function updateStateForRenderer('), main.indexOf('\nfunction launcherUpdateForRenderer(')), context);
  assert.equal(context.updateStateForRenderer({ error: error.message }).error, expected);
  assert.equal(context.updateStateForRenderer({ kind: 'repair', error: error.message }).error, expected);
  assert.equal(context.updateStateForRenderer({ kind: 'repair', error: 'network failed' }).error, 'Repair failed.');
  developer = true;
  assert.equal(context.playerPublicErrorMessage(error, 'update:start'), error.message);
});
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
function updateHarness({ warning = '', developer = false, confirmed = true, keyFailure = false,
  unreadableKey = false, phoenixBroken = false, launcherMissing = false, publishDuringInstall = false,
  missingProfile = false, setupCancelled = false, installFailures = [], recoveryResults = [] } = {}) {
  const calls = [];
  let feedReads = 0;
  const target = { id: 'stable', sidebarKey: 'stable' };
  const config = { instanceDir: '/fixture/stable', latestUrl: 'https://fixture.invalid/latest.json', launcherProof: { enabled: true } };
  const identity = { minecraftUsername: 'FixturePlayer', minecraftUuid: '12345678-1234-4234-9234-123456789abc', minecraftUsernameSyncWarning: warning };
  const context = vm.createContext({
    ...runtimeRepair, deviceCredentialPromise: null, loadDeviceCredential: async options => { assert.equal(options.allowRepair, true); calls.push('key-repair'); if (keyFailure) throw new Error('Local key unavailable'); unreadableKey = false; }, updateState: {}, releaseTarget: () => target,
    invalidateLaunchPreparation: () => calls.push('invalidate'),
    createOperationState: kind => ({ kind, running: true }), appendOperationLine() {},
    configForPack: value => value, loadConfig: async () => config,
    minecraftLauncherRuntimeConfig: async value => value,
    identityPayload: async (_config, options) => { calls.push(options?.forceAccountSync ? 'account-revalidate' : 'identity'); return identity; },
    ensurePlayerMinecraftProfile: async () => {
      if (missingProfile) {
        calls.push('account-setup');
        if (setupCancelled) throw Object.assign(new Error('Minecraft account setup was cancelled. Run Repair again to finish.'), { code: 'MINECRAFT_PROFILE_SETUP_CANCELLED' });
      }
      return identity;
    },
    currentPhoenixAntiCheatStatus: async () => ({ required: true, valid: !phoenixBroken, consented: true, consentAcceptedAt: '2026-09-01T00:00:00Z' }),
    installCurrentPhoenixAntiCheat: async () => { calls.push('phoenix-repair'); phoenixBroken = false; },
    mainWindow: null, path, samePath: (a, b) => a === b, defaultPlayerInstanceDir: () => '/fixture/stable', app: { getPath: () => '/fixture/userData' }, recoverRepairFailure: async options => {
      calls.push(options.permissionAttempted ? 'permission-already-tried' : 'recovery-check');
      return recoveryResults.shift() || null;
    },
    remoteRegistrationSatisfiesRequest: () => confirmed,
    readLatest: async () => ({ packId: 'fixture', version: publishDuringInstall && ++feedReads > 1 ? '2' : '1' }), developerClientBypassAllowed: () => developer,
    isDeveloperMode: () => developer, requirePlayerFullClientRelease() {}, migrateInstanceSecurityState: async () => {},
    sendLauncherEvent: async (_config, _identity, value) => { if (unreadableKey) calls.push('unrepaired-key-event'); calls.push(value.type); },
    prepareRuntimeOnlyRepair: async () => ({ installed: { version: '1' }, runtimeOnly: true }),
    installPack: async () => { calls.push('install'); const error = installFailures.shift(); if (error) throw error; return { installed: { packId: 'fixture', version: '1' } }; }, managedStatePath: () => '',
    useBundledJava8: () => false, process: { env: {} },
    repairMinecraftRuntime: async ({ latest, installed }) => { assert.equal(latest.version, installed.version, 'Runtime setup switched to a release published during this install'); return { profile: {}, minecraftAssets: {} }; },
    scanCurrentManagedIntegrity: async () => ({ valid: true, counts: { managed: 10, corrupted: 0 } }),
    writeIntegrityState: async (_config, value) => value,
    publishCompletedUpdatePreparation: async value => { if (launcherMissing) throw Object.assign(new Error('Minecraft Launcher is required to play.'), { code: 'AHT_MINECRAFT_NOT_INSTALLED' }); calls.push('ready'); assert.equal(value.launcherProof, null); },
    blockedLaunchPreparation() {}, java8RuntimeStatus: async () => ({}),
    completeOperationState: state => { state.running = false; calls.push('complete'); },
    failOperationState: state => { state.running = false; calls.push('failed'); }
  });
  vm.runInContext(updateSource, context);
  return { calls, run: (repair = true, runtimeOnly = false) => context.runUpdate(repair, { runtimeOnly }),
    setWarning: value => { identity.minecraftUsernameSyncWarning = value; } };
}

test('Repair recovers its local key before identity and signed telemetry work', async () => {
  const h = updateHarness({ unreadableKey: true });
  await h.run();
  assert(h.calls.indexOf('key-repair') < h.calls.indexOf('identity'));
  assert(!h.calls.includes('unrepaired-key-event'));
  assert(h.calls.includes('repair_completed'));
});

test('Install and Repair finish the selected release when publication occurs during download', async () => {
  for (const repair of [false, true]) {
    const h = updateHarness({ publishDuringInstall: true });
    await h.run(repair);
    assert(h.calls.includes('complete'));
    assert(!h.calls.includes('failed'));
  }
});

test('Repair restores a damaged consented Phoenix installation before success', async () => {
  const h = updateHarness({ phoenixBroken: true });
  await h.run();
  assert(h.calls.includes('phoenix-repair'));
  assert(h.calls.indexOf('phoenix-repair') < h.calls.indexOf('ready'));
});

test('actual Repair retries after permission recovery and still fails if the repaired access is insufficient', async () => {
  const denied = () => Object.assign(new Error('fixture denied'), { code: 'EACCES' });
  const recovered = updateHarness({ installFailures: [denied()], recoveryResults: ['permission'] });
  await recovered.run();
  assert.equal(recovered.calls.filter(value => value === 'install').length, 2);
  assert.equal(recovered.calls.filter(value => value === 'repair_completed').length, 1);
  const blocked = updateHarness({ installFailures: [denied(), denied()], recoveryResults: ['permission'] });
  await assert.rejects(blocked.run(), /fixture denied/);
  assert(blocked.calls.includes('permission-already-tried'));
  assert(!blocked.calls.includes('repair_completed'));
});

test('Repair resolves missing Minecraft profile metadata before claiming completion', async () => {
  const h = updateHarness({ missingProfile: true });
  await h.run();
  assert(h.calls.includes('account-setup'));
  assert(h.calls.indexOf('account-setup') < h.calls.indexOf('repair_completed'));
  const cancelled = updateHarness({ missingProfile: true, setupCancelled: true });
  await assert.rejects(cancelled.run(), /setup was cancelled/);
  assert(!cancelled.calls.includes('repair_completed'));
  assert(cancelled.calls.includes('repair_failed'));
});

test('Repair cannot report completion when Minecraft Launcher is absent', async () => {
  const h = updateHarness({ launcherMissing: true });
  await assert.rejects(h.run(), /Minecraft Launcher is required/);
  assert(!h.calls.includes('repair_completed'));
  assert(h.calls.includes('repair_failed'));
  const ordinary = updateHarness({ launcherMissing: true });
  await ordinary.run(false);
  assert(ordinary.calls.includes('install_completed'));
});

test('Repair restores local readiness even when historical account recovery is unavailable', async () => {
  for (const runtimeOnly of [false, true]) {
    const h = updateHarness({ warning: 'Old account unavailable', confirmed: false });
    await h.run(true, runtimeOnly);
    assert(h.calls.includes('repair_completed'));
    assert(!h.calls.includes('account-revalidate'));
    assert(h.calls.indexOf('key-repair') < h.calls.indexOf('ready'));
  }
});

test('a local key failure still fails Repair; update and developer paths remain intact', async () => {
  const h = updateHarness({ keyFailure: true });
  await assert.rejects(h.run(), /Local key unavailable/);
  assert(!h.calls.includes('ready'));
  assert(h.calls.includes('failed'), 'Local failure must set a terminal failed state even before an identity is available for telemetry');
  const ordinary = updateHarness({ confirmed: false });
  await ordinary.run(false);
  assert(ordinary.calls.includes('complete'));
  const developer = updateHarness({ developer: true, keyFailure: true });
  await developer.run();
  assert(!developer.calls.includes('key-repair'));
  assert(developer.calls.includes('complete'));
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
