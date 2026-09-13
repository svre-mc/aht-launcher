import assert from 'node:assert/strict';
import test from 'node:test';
import { registerMinecraftAccount } from '../src/minecraftRegistrationService.js';

const challenge = 'a'.repeat(40);
const conflict = [409, { error: 'Username is not available.' }];
const ownership = [409, { code: 'MINECRAFT_OWNERSHIP_REQUIRED', minecraftSessionChallenge: challenge, expiresAt: Date.now() + 120000 }];
function harness(replies, options = {}) {
  const requests = [];
  const actions = [];
  return { requests, actions, run: () => registerMinecraftAccount({
    baseUrl: 'https://fixture.invalid/ptb/', registrationPayload: { username: 'FixturePlayer', installId: 'fixture', minecraftUuid: 'b'.repeat(32) },
    recoverySecret: 'fixture-recovery-value',
    canRecover: async () => { actions.push('match'); return options.matches !== false; },
    proveOwnership: async value => { actions.push('prove'); assert.equal(value.serverId, challenge); if (options.error) throw options.error; },
    fetchImpl: async (url, request) => {
      requests.push(JSON.parse(request.body));
      assert.equal(url.pathname, '/ptb/api/users/register');
      assert.equal(request.redirect, 'manual');
      const reply = replies.shift(); assert(reply, 'registration issued an unexpected retry');
      return new Response(JSON.stringify(reply[1]), { status: reply[0] });
    }
  }) };
}

test('confirmed registration takes one request and does not enter recovery', async () => {
  const fixture = harness([[200, { ok: true }]]);
  assert.equal((await fixture.run()).ok, true); assert.deepEqual(fixture.actions, []); assert.equal(fixture.requests.length, 1);
});

test('ownership recovery is bounded and requires the final independent service confirmation', async () => {
  const fixture = harness([conflict, ownership, [200, { ok: true }]]);
  assert.equal((await fixture.run()).recovered, true);
  assert.deepEqual(fixture.actions, ['match', 'prove']);
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.requests[2].minecraftSessionChallenge, challenge);
  assert.equal('minecraftSessionChallenge' in fixture.requests[0], false);
});

test('local verification success cannot override service rejection', async () => {
  const fixture = harness([conflict, ownership, [403, { code: 'OWNERSHIP_NOT_CONFIRMED', error: 'Verification incomplete.' }]]);
  await assert.rejects(fixture.run(), { code: 'OWNERSHIP_NOT_CONFIRMED', status: 403 });
  assert.equal(fixture.requests.length, 3);
});

test('cancelling recovery neither retries nor submits a completion claim', async () => {
  const error = Object.assign(new Error('Cancelled.'), { code: 'AHT_ACCOUNT_RECOVERY_CANCELLED' });
  const fixture = harness([conflict, ownership], { error });
  await assert.rejects(fixture.run(), error); assert.equal(fixture.requests.length, 2);
});

test('account mismatch and service outage are not invitations to recover another account', async () => {
  for (const [replies, options] of [[[conflict], { matches: false }], [[[503, { error: 'Busy.' }]], {}]]) {
    const fixture = harness(replies, options);
    await assert.rejects(fixture.run()); assert.equal(fixture.requests.length, 1); assert(!fixture.actions.includes('prove'));
  }
});

test('malformed challenge never opens interactive verification', async () => {
  const fixture = harness([conflict, [409, { code: 'MINECRAFT_OWNERSHIP_REQUIRED', minecraftSessionChallenge: 'invalid' }]]);
  await assert.rejects(fixture.run(), { code: 'MINECRAFT_RECOVERY_CHALLENGE_INVALID' });
  assert.deepEqual(fixture.actions, ['match']);
});

test('structured recovery and changed-device conflicts enter the same bounded ownership transaction', async () => {
  for (const code of ['ACCOUNT_RECOVERY_REQUIRED', 'DEVICE_IDENTITY_MISMATCH']) {
    const fixture = harness([[409, { code, error: 'Restore this account.' }], ownership, [200, { ok: true }]]);
    assert.equal((await fixture.run()).recovered, true);
    assert.deepEqual(fixture.actions, ['match', 'prove']); assert.equal(fixture.requests.length, 3);
  }
});
