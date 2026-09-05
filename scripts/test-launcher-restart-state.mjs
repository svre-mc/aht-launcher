import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
const start = source.indexOf('async function hydratePendingLauncherUpdateState(');
const declaration = source.slice(start, source.indexOf('\nasync function shouldExitForPendingLauncherInstall(', start));
let reads = 0, clears = 0, finishValidation, validationStarted;
const started = new Promise((resolve) => { validationStarted = resolve; });
const pending = { version: '0.2.07', status: 'ready-to-relaunch' };
const context = vm.createContext({
  launcherUpdateState: { running: true, lastResult: { version: '0.2.07', restartRequired: true } },
  readPendingLauncherUpdate: async () => { reads++; return pending; },
  isDeveloperMode: () => false, LOCAL_REINSTALL_PURPOSE: 'local-reinstall',
  launcherVersion: () => '0.2.06', compareVersions: () => -1,
  validatePendingLauncherUpdate: () => new Promise((_resolve, reject) => { finishValidation = () => reject(new Error('payload hash changed during arm')); validationStarted(); }),
  clearPendingLauncherUpdate: async () => { clears++; }
});
vm.runInContext(declaration, context);
await context.hydratePendingLauncherUpdateState();
assert.equal(reads, 0, 'An active handoff must not rehydrate the staged metadata');
context.launcherUpdateState.running = false;
const poll = context.hydratePendingLauncherUpdateState();
await started;
context.launcherUpdateState.running = true;
finishValidation();
await poll;
assert.equal(clears, 0, 'A status poll with the old payload hash must not delete the pending update');
assert.equal(context.launcherUpdateState.running, true);
assert.equal(context.launcherUpdateState.lastResult.restartRequired, true);
assert.equal(context.launcherUpdateState.error, undefined);
console.log('PASS: status polling cannot reset Restart or discard a re-armed updater payload.');
