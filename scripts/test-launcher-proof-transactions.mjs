import assert from 'node:assert/strict';
import test from 'node:test';
import { createLauncherProofTransactions } from '../src/launcherProofTransactions.js';

const identity = { installId: 'fixture-install', minecraftUsername: 'AuditAlpha', minecraftUuid: 'a'.repeat(32) };
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const valid = { write: async () => ({ token: 'fixture' }), inspect: async () => ({ usable: true }) };

test('a failed transaction does not poison queued or future work', async () => {
  const queue = createLauncherProofTransactions({ readIdentity: async () => identity });
  const first = queue.run('proof', identity, { ...valid, write: async () => { throw new Error('fixture failure'); } });
  const second = queue.run('proof', identity, valid);
  await assert.rejects(first, /fixture failure/);
  assert.equal((await second).usable, true);
  assert.equal(queue.pendingFiles, 0);
  assert.equal((await queue.run('proof', identity, valid)).reused, false);
});

test('the queue is bounded and independent proof files do not block each other', async () => {
  const queue = createLauncherProofTransactions({ readIdentity: async () => identity, maximumPending: 2 });
  const blocker = hold();
  const first = queue.run('proof-a', identity, { ...valid, write: () => blocker.promise });
  const second = queue.run('proof-a', identity, valid);
  await assert.rejects(queue.run('proof-a', identity, valid), { code: 'AHT_PROOF_BUSY' });
  assert.equal((await queue.run('proof-b', identity, valid)).usable, true);
  assert.equal(queue.pendingFiles, 1);
  blocker.resolve({});
  await Promise.all([first, second]);
  assert.equal(queue.pendingFiles, 0);
});

test('account changes during inspection invalidate the result', async () => {
  let current = identity;
  const queue = createLauncherProofTransactions({ readIdentity: async () => current });
  await assert.rejects(queue.run('proof', identity, { ...valid, inspect: async () => {
    current = { ...identity, minecraftUuid: 'b'.repeat(32) }; return { usable: true };
  } }), { code: 'AHT_ACCOUNT_CHANGED' });
  assert.equal(queue.pendingFiles, 0);
});

test('first verified UUID enrichment and username case do not invalidate the same account', async () => {
  const queue = createLauncherProofTransactions({ readIdentity: async () => ({ ...identity, minecraftUsername: 'auditalpha' }) });
  const firstIdentity = { ...identity, minecraftUuid: '' };
  assert.equal((await queue.run('proof', firstIdentity, valid)).usable, true);
  await assert.rejects(queue.run('proof', { ...identity, installId: 'other-install' }, valid), { code: 'AHT_ACCOUNT_CHANGED' });
});

test('an unusable file cannot be returned as ready and does not block retry', async () => {
  const queue = createLauncherProofTransactions({ readIdentity: async () => identity });
  await assert.rejects(queue.run('proof', identity, { ...valid, inspect: async () => ({ usable: false }) }), { code: 'AHT_PROOF_CHANGED' });
  assert.equal((await queue.run('proof', identity, valid)).usable, true);
});
