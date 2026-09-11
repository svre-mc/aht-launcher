import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as runtimeRepair from '../src/runtimeRepair.js';

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
