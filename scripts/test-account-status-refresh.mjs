import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountStatusRefresh } from '../src/accountStatusRefresh.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('a stalled account service does not delay warm local status or start interactive recovery', async () => {
  const gate = deferred();
  const calls = [];
  const identity = { installId: 'fixture', minecraftUsername: 'FixturePlayer' };
  const service = createAccountStatusRefresh({ readLocal: async (_config, options) => {
    assert.equal(options.allowRemoteSync, false);
    return { ...identity };
  }, refreshRemote: async (_config, options) => { calls.push(options); await gate.promise; },
  keyFor: () => 'fixture', shouldRefresh: () => true });
  const results = await Promise.all(Array.from({ length: 25 }, () => service.read({})));
  assert(results.every(result => result.minecraftUsername === 'FixturePlayer'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].forceAccountSync, false);
  assert.equal(service.pendingCount(), 1, 'Network should still be pending after local status has completed');
  gate.resolve();
  await service.idle();
});

test('background failure has a bounded cooldown, while explicit Retry bypasses it', async () => {
  let clock = 1000;
  let calls = 0;
  let notices = 0;
  const service = createAccountStatusRefresh({ readLocal: async () => ({}),
    refreshRemote: async (_config, options) => {
      calls++;
      if (!options.forceAccountSync) throw new Error('fixture offline');
      return { verified: true };
    }, keyFor: () => 'fixture', shouldRefresh: () => true, now: () => clock, retryIntervalMs: 100,
    onChanged: () => { notices++; } });
  await service.read({}); await service.idle();
  await service.read({}); await service.idle();
  assert.equal(calls, 1);
  assert.equal(notices, 1);
  assert.equal((await service.read({}, { forceAccountSync: true })).verified, true);
  assert.equal(calls, 2);
  clock += 100;
  await service.read({}); await service.idle();
  assert.equal(calls, 3);
});

test('protected-storage restrictions prevent background authentication and current accounts need no network', async () => {
  let calls = 0;
  for (const shouldRefresh of [true, false]) {
    const service = createAccountStatusRefresh({ readLocal: async () => ({ username: 'fixture' }),
      refreshRemote: async () => { calls++; }, keyFor: () => 'fixture', shouldRefresh: () => shouldRefresh });
    await service.read({}, { allowProtectedStorage: false });
    await service.idle();
    if (!shouldRefresh) { await service.read({}); await service.idle(); }
  }
  assert.equal(calls, 0);
});
