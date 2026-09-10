import assert from 'node:assert/strict';
import { nativeGuardReadyForLauncherExit } from '../src/nativeGuard.js';

const descriptor = {};
assert.equal(await nativeGuardReadyForLauncherExit(null), false);
assert.equal(await nativeGuardReadyForLauncherExit(descriptor, async () => { throw new Error('dead session'); }), false);
for (const state of ['pending', 'incomplete', 'tampered']) {
  assert.equal(await nativeGuardReadyForLauncherExit(descriptor, async () => ({ live: { gamePid: 123 }, measurement: { gamePid: 123, state } })), false);
}
assert.equal(await nativeGuardReadyForLauncherExit(descriptor, async () => ({ live: { gamePid: 0 }, measurement: { gamePid: 0, state: 'clean' } })), false);
assert.equal(await nativeGuardReadyForLauncherExit(descriptor, async () => ({ live: { gamePid: 123 }, measurement: { gamePid: 456, state: 'clean' } })), false);
assert.equal(await nativeGuardReadyForLauncherExit(descriptor, async () => ({ live: { gamePid: 123 }, measurement: { gamePid: 123, state: 'clean' } })), true);
console.log('PASS: automatic launcher close requires live clean coverage for the exact game; pending, unavailable, tampered and mismatched sessions hold it open.');
