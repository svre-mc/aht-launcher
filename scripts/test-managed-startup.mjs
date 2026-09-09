import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createLaunchAttempt, setLaunchRequirement } from '../src/launchDiagnostics.js';
import { verifyRepairedJava } from '../src/runtimeRepair.js';

const source = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
const startupSource = source.slice(source.indexOf('async function prepareStartupPrerequisiteEntry('), source.indexOf('async function hydrateLaunchPreparationFromSnapshot('));
const config = { instanceDir: 'C:\\AHT\\Client', minecraftLauncher: { rootDir: 'C:\\Minecraft', javaPath: 'C:\\OldJava\\java.exe' } };
const target = { id: 'stable', name: 'A Hard Time' };
const installed = { packId: 'aht', version: '2.8.62' };
const profile = { profileId: 'aht', versionId: '1.12.2-forge-14.23.5.2860', profileExists: true, loaderInstalled: true };
const policy = source.match(/const STARTUP_PREREQUISITE_POLICY = '([^']+)'/)[1];
const managedPolicy = source.match(/const LAUNCH_PREPARATION_MANAGED_POLICY = '([^']+)'/)[1];

async function scenario({ cached = true, healthy = false, failRepair = false, missingJava = false, developer = false } = {}) {
  let repairs = 0;
  let javaChecks = 0;
  let profileChecks = 0;
  let runtimeChecks = 0;
  const context = {
    process: { platform: 'win32' }, Date,
    developerClientBypassAllowed: () => developer,
    STARTUP_PREREQUISITE_POLICY: policy,
    LAUNCH_PREPARATION_MANAGED_POLICY: managedPolicy,
    createLaunchDiagnosticAttempt: createLaunchAttempt, launcherLegalStatus: async () => ({ required: false }),
    installedPackMatchesReleaseTarget: () => true, launchPreparationConfigSignature: () => 'config',
    samePath: (a, b) => a === b, launcherConfigFromPreparedPaths: () => structuredClone(config),
    preparedLauncherRouteForSnapshot: (route) => route,
    preparedLauncherRouteAvailable: async (route) => Boolean(route?.kind),
    minecraftLauncherRuntimeConfig: async () => structuredClone(config),
    resolveMinecraftLauncherRoute: async () => ({ kind: 'desktop', executablePath: 'C:\\Minecraft\\MinecraftLauncher.exe' }),
    preparedJava8RuntimeAvailable: async (runtime) => Boolean(runtime?.usable && runtime?.path),
    java8RuntimeStatus: async () => {
      javaChecks++;
      return missingJava ? { usable: false, reason: 'Java executable was not found.' }
        : { usable: true, path: 'C:\\AHT\\runtime\\temurin8\\bin\\java.exe', bundled: true };
    },
    minecraftJavaExecutable: async (file) => file.replace('java.exe', 'javaw.exe'),
    preparedProfileForSnapshot: (value) => value,
    inspectMinecraftLauncherProfile: async () => { profileChecks++; return { ...profile, loaderInstalled: healthy }; },
    inspectMinecraftLauncherRuntime: async () => { runtimeChecks++; return { usable: healthy }; },
    repairMinecraftRuntime: async ({ config: runtimeConfig }) => {
      repairs++;
      assert.equal(runtimeConfig.minecraftLauncher.javaPath, 'C:\\AHT\\runtime\\temurin8\\bin\\javaw.exe');
      if (failRepair) throw new Error('asset checksum failed');
      return { profile: { ...profile }, minecraftAssets: { repaired: true } };
    },
    cachedLatestRelease: () => installed,
    loadIdentity: async () => ({ installId: 'test' }),
    preparedIntegritySummaryForSnapshot: (value) => value ? { valid: true, counts: { corrupted: 0 } } : null,
    preparedManagedSnapshotFromEntry: () => ({
      complete: false,
      managedFiles: [],
      fileStates: [],
      fingerprint: null
    }),
    setLaunchRequirement, launchPreparationCache: new Map(), persistPreparedLaunchEntry: async () => {},
    markFailedLaunchRequirement: () => {}, completeLaunchAttempt: () => {},
    blockedLaunchPreparation: (_target, error, { attempt }) => ({ state: 'blocked', error: error.message, attempt })
  };
  vm.createContext(context);
  vm.runInContext(`${startupSource}\nglobalThis.prepare = prepareStartupPrerequisiteEntry;`, context);
  const cachedEntry = cached ? {
    targetId: target.id, prerequisitePolicy: policy, configSignature: 'config', installed, latest: installed,
    launcherRoute: { kind: 'desktop', executablePath: 'C:\\Minecraft\\MinecraftLauncher.exe' },
    launcherPaths: { javaPath: 'C:\\OldJava\\javaw.exe' },
    minecraftProfile: { ...profile }, java8Runtime: { usable: true, path: config.minecraftLauncher.javaPath },
    identity: { installId: 'test' }, integrity: { valid: true, counts: { corrupted: 0 } }
  } : null;
  const result = await context.prepare({ target, config, installed }, cachedEntry);
  assert.equal(javaChecks, cached ? 0 : 1,
    'Warm startup must reuse the existing Java executable instead of re-hashing or re-probing its runtime.');
  assert.equal(profileChecks, missingJava ? 0 : (cached ? 0 : 1),
    'Warm startup must reuse complete profile metadata; first initialization must inspect it.');
  assert.equal(runtimeChecks, missingJava ? 0 : (cached || developer ? 0 : 1),
    'Warm and developer startup must not scan Minecraft assets; first player initialization must validate them.');
  assert.equal(repairs, cached || developer || healthy || missingJava ? 0 : 1);
  if (missingJava) {
    assert.equal(result.state, 'blocked');
    assert.equal(result.attempt.requirements.java8.status, 'FAIL');
    assert.match(result.attempt.requirements.java8.detail, /Java executable was not found/);
  } else if (failRepair) {
    assert.equal(result.state, 'blocked');
    assert.match(result.error, /checksum/);
  } else {
    assert.equal(result.state, 'ready');
    assert.equal(result.launcherConfig.minecraftLauncher.javaPath, cached
      ? 'C:\\OldJava\\javaw.exe'
      : 'C:\\AHT\\runtime\\temurin8\\bin\\javaw.exe');
    assert.equal(result.launcherProof, null, 'startup must not bypass the fresh Play authorization');
    if (developer) {
      assert.equal(result.developerLocalFastPath, true);
      assert.equal(result.attempt.requirements.minecraftRuntime.status, 'NOT CHECKED');
    } else if (cached) {
      assert.equal(result.attempt.requirements.minecraftRuntime.status, 'NOT CHECKED');
      assert.match(result.attempt.requirements.minecraftRuntime.detail, /without rescanning game files/i);
    }
  }
}
await scenario();
await scenario({ cached: false, healthy: true });
await scenario({ cached: false });
await scenario({ cached: false, failRepair: true });
await scenario({ cached: false, missingJava: true });
await scenario({ developer: true });

const finalizationSource = source.slice(source.indexOf('async function publishCompletedUpdatePreparation('), source.indexOf('function launchPreparationKey('));
for (const missingAtDetection of [true, false]) {
  const previous = { state: 'blocked' };
  const finalContext = {
    clearLaunchPreparationResources: () => {},
    developerClientBypassAllowed: () => true,
    resolveMinecraftLauncherRoute: async () => ({ kind: 'desktop' }),
    java8RuntimeStatus: async (_config, options) => {
      assert.equal(options.refresh, true, 'Repair must discard cached Java detection at its final gate');
      return { usable: !missingAtDetection, path: 'C:\\Java\\java.exe', reason: 'Java executable was not found.' };
    },
    selectPreparedMinecraftLauncherProfile: async (value) => value,
    verifyRepairedJava, DEFAULT_MINECRAFT_MEMORY_MB: 4096,
    preflightJava8Runtime: async () => { throw new Error('Java disappeared after the earlier successful probe'); },
    launchPreparationCache: new Map([['stable', previous]])
  };
  vm.createContext(finalContext);
  vm.runInContext(`${finalizationSource}\nglobalThis.finalize = publishCompletedUpdatePreparation;`, finalContext);
  await assert.rejects(finalContext.finalize({
    target, config, launcherConfig: config, latest: installed, installed,
    integrity: { valid: true, counts: { corrupted: 0 } },
    minecraftProfile: { ...profile, javaRuntime: { usable: true } }, launcherProof: { trusted: true }
  }), missingAtDetection ? /Repair could not verify Java/ : /Java disappeared/);
  assert.equal(finalContext.launchPreparationCache.get('stable'), previous,
    'Repair must not publish a ready state based on stale profile Java metadata');
}

const events = [];
const queueContext = {
  ensureMinecraftLauncherProfile: async ({ installed }) => { events.push(`profile:${installed.version}`); return { version: installed.version }; },
  ensureMinecraftLauncherAssets: async ({ installed, includeObjects }) => {
    assert.equal(includeObjects, true);
    events.push(`assets:${installed.version}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {};
  },
  installMinecraftProfileLoaders: async (profile) => { events.push(`forge:${profile.version}`); return profile; }
};
vm.createContext(queueContext);
const queueSource = source.slice(source.indexOf('let minecraftRuntimeRepairQueue ='), source.indexOf('function useBundledJava8('));
vm.runInContext(`${queueSource}\nglobalThis.repair = repairMinecraftRuntime;`, queueContext);
await Promise.all(['stable', 'ptb'].map((version) => queueContext.repair({ config, installed: { version } })));
assert.deepEqual(events, ['profile:stable', 'assets:stable', 'forge:stable', 'profile:ptb', 'assets:ptb', 'forge:ptb']);
console.log('Managed startup passed: warm player/developer launches reuse signed Java and profile paths without cold-disk scans, first initialization repairs or blocks broken prerequisites, stable/PTB writes serialize, Play authorization preserved.');
