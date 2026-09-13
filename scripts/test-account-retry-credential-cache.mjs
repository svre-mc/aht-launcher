import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

test('explicit account retry reads restored recovery credentials instead of a stale process cache', async () => {
  const source = (await fs.readFile(process.env.AHT_RETRY_CACHE_BASELINE || new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const identity = { installId: 'fixture-install', minecraftUsername: 'AuditAlpha', minecraftUuid: 'a'.repeat(32) };
  let stored = 'old-fixture-credential'; let observed = ''; let reads = 0;
  const context = vm.createContext({ process, accountRecoverySecretPromises: new Map(),
    isDeveloperMode: () => true,
    normalizeMinecraftUsername: value => String(value || '').trim(), normalizeMinecraftUuid: value => value,
    resolveAccountRecoverySecret: async () => { reads++; return stored; }, loadIdentity: async () => ({ ...identity }),
    publicDeviceIdentity: async () => ({}), launcherVersion: () => 'fixture',
    refreshRemoteMinecraftRegistration: async (_config, value) => value,
    recordAccountSyncWarning: async (_identity, _name, error) => { throw error; } });
  const memo = source.indexOf('async function accountRecoverySecret(');
  vm.runInContext(source.slice(memo, source.indexOf('\nfunction minecraftUsernameMatchesAuth(', memo)), context);
  const payload = source.indexOf('async function identityPayload(');
  vm.runInContext(source.slice(payload, source.indexOf('\nfunction normalizeMinecraftUsername(', payload)), context);
  context.registerMinecraftUsernameInFlight = async config => { observed = await context.accountRecoverySecret(config, identity.minecraftUsername); };
  await context.accountRecoverySecret({}, identity.minecraftUsername);
  stored = 'restored-fixture-credential';
  await context.identityPayload({}, { allowProtectedStorage: true, forceAccountSync: true });
  assert.equal(observed, stored);
  assert.equal(reads, 2);
  await context.identityPayload({}, { allowProtectedStorage: true, allowRemoteSync: false });
  await context.accountRecoverySecret({}, identity.minecraftUsername);
  assert.equal(reads, 2, 'Ordinary status must retain the warm credential cache');
});
