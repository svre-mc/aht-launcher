import test from 'node:test';
import assert from 'node:assert/strict';
import { accountWarningState, registeredAccountState } from '../src/accountIdentityState.js';

const initial = { installId: 'fixture', minecraftUsername: 'FixturePlayer', minecraftUuid: 'a'.repeat(32),
  remoteRegistrationConfirmedAt: '2026-09-01T00:00:00Z', remoteRegistrationWorkerBaseUrl: 'https://fixture.invalid',
  reportedLauncherVersions: ['0.2.26'], preferences: { keep: true } };
const registration = { username: initial.minecraftUsername, minecraftUuid: initial.minecraftUuid,
  remote: { username: initial.minecraftUsername, recovered: true }, baseUrl: 'https://fixture.invalid' };

test('a late sync failure cannot overwrite a newer successful registration', () => {
  const current = { ...initial, remoteRegistrationConfirmedAt: '2026-09-13T00:00:00Z', minecraftUsernameSyncWarning: '' };
  assert.equal(accountWarningState(current, initial, { username: initial.minecraftUsername, message: 'stale failure' }), current);
});

test('a late sync failure cannot target a different installation, account or UUID', () => {
  for (const change of [{ installId: 'different' }, { minecraftUsername: 'OtherPlayer' }, { minecraftUuid: 'b'.repeat(32) }]) {
    const current = { ...initial, ...change };
    assert.equal(accountWarningState(current, initial, { username: initial.minecraftUsername, message: 'stale failure' }), current);
  }
});

test('current failures remain visible and preserve unrelated fields and identity', () => {
  const current = { ...initial, preferences: { changedWhileWaiting: true } };
  const result = accountWarningState(current, initial, { username: initial.minecraftUsername,
    message: 'session unavailable', attemptedAt: 'fixture time', detectedUsername: 'FixturePlayer' });
  assert.equal(result.installId, initial.installId);
  assert.equal(result.minecraftUsernameSyncWarning, 'session unavailable');
  assert.equal(result.remoteRegistrationAttemptedAt, 'fixture time');
  assert.deepEqual(result.preferences, current.preferences);
});

test('successful registration merges only account fields onto the latest snapshot', () => {
  const current = { ...initial, reportedLauncherVersions: ['0.2.26', 'fixture'], minecraftUsernameSyncWarning: 'old failure' };
  const result = registeredAccountState(current, initial, registration);
  assert.deepEqual(result.reportedLauncherVersions, current.reportedLauncherVersions);
  assert.equal(result.minecraftUsernameSyncWarning, '');
  assert.equal(result.minecraftUuid, initial.minecraftUuid);
  assert.notEqual(result.remoteRegistrationConfirmedAt, initial.remoteRegistrationConfirmedAt);
});

test('a stale registration response cannot restore an account the user switched away from', () => {
  for (const change of [{ installId: 'different' }, { minecraftUsername: 'OtherPlayer', minecraftUuid: 'b'.repeat(32) }]) {
    assert.throws(() => registeredAccountState({ ...initial, ...change }, initial, registration), { code: 'AHT_ACCOUNT_CHANGED' });
  }
  assert.throws(() => registeredAccountState(initial, initial, {
    ...registration, remote: { username: 'OtherPlayer' }
  }), { code: 'AHT_ACCOUNT_RESPONSE_INVALID' });
});

test('a local-only account switch cannot inherit another account’s remote confirmation', () => {
  const result = registeredAccountState(initial, initial, {
    username: 'OtherPlayer', minecraftUuid: 'b'.repeat(32), remote: { skipped: true }, mode: 'local'
  });
  assert.equal(result.remoteRegistrationConfirmedAt, '');
  assert.equal(result.remoteRegistrationWorkerBaseUrl, '');
});
