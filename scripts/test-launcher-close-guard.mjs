import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const main = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('function armCloseLauncherWhenGameStarts('), main.indexOf('\nasync function manualLaunchDiagnostic('));
async function run({ required = true, fresh = true, states = [] } = {}) {
  const attempt = {};
  const guards = new WeakMap();
  if (required) guards.set(attempt, {});
  let clock = 0, closed = 0, checked = 0;
  const context = {
    closeOnGameStartWatchGeneration: 0, launchNativeGuards: guards,
    process: { env: { AHT_TEST_HOOKS: '1' } }, Date: { now: () => clock },
    sleep: async ms => { clock += ms; },
    minecraftLaunchDiagnostic: async () => ({}), minecraftSignalsForLaunch: () => [],
    minecraftLauncherSignalStartsConfiguredModpack: () => false,
    minecraftInstanceSignalDiagnostic: async () => ({}),
    minecraftInstanceLogAdvancedAfterBaseline: () => fresh,
    nativeGuardReadyForLauncherExit: async () => states[checked++] === true,
    app: { quit: () => { closed++; } }, recordErrorDiagnostic: () => assert.fail('Unexpected close watcher error')
  };
  vm.runInNewContext(source + '\nthis.arm = armCloseLauncherWhenGameStarts;', context);
  context.arm({ minecraftLauncher: { closeLauncherWhenGameStarts: true } }, attempt);
  for (let i = 0; i < 1000 && !closed && clock < 15000; i++) await new Promise(resolve => setImmediate(resolve));
  return { closed, checked };
}
assert.deepEqual(await run({ states: [false, false, true] }), { closed: 1, checked: 3 });
assert.equal((await run()).closed, 0, 'A startup log without measured coverage must keep the launcher alive');
assert.equal((await run({ fresh: false, states: [true] })).closed, 0);
assert.equal((await run({ required: false })).closed, 1, 'Platforms without Phoenix retain their close preference');
console.log('PASS: actual close-on-start watcher waits for clean game coverage; stale signals and unavailable guard cannot close it.');
