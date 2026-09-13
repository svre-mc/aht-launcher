import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedMinecraftSessionState, MINECRAFT_SESSION_AUTHORITY } from '../src/minecraftSessionIdentity.js';
import { bindAuthenticatedMinecraftSession, sessionAccountLinked } from '../cloudflare/minecraft-session-authority.js';

const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
test('profile metadata imports without a recovery secret or a remote registration', () => {
  const old = { installId: 'local', minecraftUsernameSyncWarning: 'old account recovery failed', preferences: { sound: false } };
  const next = selectedMinecraftSessionState(old, old, { username: 'FixturePlayer', minecraftUuid: id });
  assert.equal(next.minecraftUsername, 'FixturePlayer');
  assert.equal(next.minecraftUuid, id);
  assert.equal(next.minecraftUsernameSyncWarning, '');
  assert.equal(next.remoteRegistrationConfirmedAt, '');
  assert.deepEqual(next.preferences, old.preferences);
  assert.equal(next.usernameRegistrationMode, MINECRAFT_SESSION_AUTHORITY);
});
test('same-name stale UUID is replaced locally, never misrepresented as remote ownership', () => {
  const old = { installId: 'local', minecraftUsername: 'FixturePlayer', minecraftUuid: '11111111-2222-4333-8444-555555555555', remoteRegistrationConfirmedAt: 'old' };
  const next = selectedMinecraftSessionState(old, old, { username: 'FixturePlayer', minecraftUuid: id });
  assert.equal(next.minecraftUuid, id);
  assert.equal(next.remoteRegistrationConfirmedAt, '');
});
test('late profile scan cannot overwrite a newly selected account', () => {
  const expected = { installId: 'local', minecraftUsername: 'OldPlayer', minecraftUuid: id };
  const current = { ...expected, minecraftUsername: 'NewPlayer' };
  assert.equal(selectedMinecraftSessionState(current, expected, { username: 'OldPlayer', minecraftUuid: id }), current);
});
test('name-only account switch cannot inherit another accounts UUID', () => {
  const old = { installId: 'local', minecraftUsername: 'OldPlayer', minecraftUuid: id };
  assert.equal(selectedMinecraftSessionState(old, old, { username: 'NewPlayer' }).minecraftUuid, '');
});
test('authenticated linking retains unrelated data and rejects a different Minecraft identity', () => {
  const proof = { identityAuthority: MINECRAFT_SESSION_AUTHORITY, minecraftUsername: 'FixturePlayer', minecraftUuid: id,
    installId: 'new', deviceId: 'new-key', devicePublicKey: 'public' };
  const old = { username: 'FixturePlayer', minecraftUuid: id, installId: 'old', createdAt: '2026-01-01', benefits: { rank: 'test' } };
  const next = bindAuthenticatedMinecraftSession(old, proof, { username: 'FixturePlayer', minecraftUuid: id });
  assert.deepEqual(next.benefits, old.benefits);
  assert.equal(next.createdAt, old.createdAt);
  assert.equal(sessionAccountLinked(next, proof), true);
  assert.throws(() => bindAuthenticatedMinecraftSession(old, proof, { username: 'SomeoneElse', minecraftUuid: id }), { code: 'SESSION_IDENTITY_MISMATCH' });
  assert.throws(() => bindAuthenticatedMinecraftSession({ ...old, minecraftUuid: '11111111-2222-4333-8444-555555555555' }, proof,
    { username: 'FixturePlayer', minecraftUuid: id }), { code: 'SESSION_ACCOUNT_CONFLICT' });
});
