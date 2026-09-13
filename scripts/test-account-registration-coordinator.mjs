import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const cancelled = () => Object.assign(new Error('Account verification cancelled.'), { code: 'AHT_ACCOUNT_RECOVERY_CANCELLED' });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const uuid = value => String(value || '').replaceAll('-', '').toLowerCase();
const username = value => String(value || '').trim();
const baseUrl = config => config.sync.baseUrl;
const matches = (config, identity, name, id) => identity.installId && identity.confirmed
  && !identity.minecraftUsernameSyncWarning && identity.minecraftUsername.toLowerCase() === name.toLowerCase()
  && (!id || uuid(id) === uuid(identity.minecraftUuid)) && identity.baseUrl === baseUrl(config);
const config = { sync: { baseUrl: 'https://fixture.invalid' } };
const initial = { installId: 'fixture-install', minecraftUsername: 'FixturePlayer', minecraftUuid: 'a'.repeat(32), baseUrl: baseUrl(config) };

async function coordinator({ loadIdentity, register }) {
  if (process.env.AHT_REGISTRATION_BASELINE === '1') {
    const main = (await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    const start = main.indexOf('async function registerMinecraftUsernameInFlight(');
    const end = main.indexOf('\nasync function refreshRemoteMinecraftRegistration(', start);
    const context = vm.createContext({ loadIdentity, registerMinecraftUsername: register,
      remoteRegistrationRefreshes: new Map(), remoteRegistrationsCompletedThisSession: new Map(),
      remoteRegistrationKey: (cfg, identity, name) => `${identity.installId}\0${name.toLowerCase()}\0${baseUrl(cfg)}`,
      remoteRegistrationSatisfiesRequest: matches, normalizeMinecraftUuid: uuid });
    vm.runInContext(main.slice(start, end), context);
    return { run: (...args) => context.registerMinecraftUsernameInFlight(...args) };
  }
  const { createAccountRegistrationCoordinator } = await import('../src/accountRegistrationCoordinator.js');
  return createAccountRegistrationCoordinator({ loadIdentity, register, normalizeUsername: username,
    normalizeUuid: uuid, baseUrl, matches });
}

test('concurrent explicit callers share cancellation instead of opening another recovery automatically', async () => {
  let calls = 0;
  const entered = deferred();
  const gate = deferred();
  const service = await coordinator({ loadIdentity: async () => initial, register: async () => {
    calls++;
    entered.resolve();
    await gate.promise;
    throw cancelled();
  } });
  const options = { allowInteractiveRecovery: true, forceRemoteRegistration: true };
  const first = service.run(config, initial, initial.minecraftUsername, options);
  const second = service.run(config, initial, initial.minecraftUsername, options);
  const outcomes = Promise.allSettled([first, second]);
  await entered.promise;
  gate.resolve();
  for (const outcome of await outcomes) assert.equal(outcome.reason?.code, 'AHT_ACCOUNT_RECOVERY_CANCELLED');
  assert.equal(calls, 1, 'A shared explicit cancellation is not a request to open another prompt');
});

test('every interactive Play/Repair waiter performs its own post-wait integrity check', async () => {
  let calls = 0;
  const checked = [];
  const gate = deferred();
  const service = await coordinator({ loadIdentity: async () => initial, register: async (_name, options) => {
    calls++;
    await gate.promise;
    await options.beforeInteractiveRecoveryCompletes?.();
    return { ok: true, username: initial.minecraftUsername, minecraftUuid: initial.minecraftUuid, remote: { recovered: true } };
  } });
  const first = service.run(config, initial, initial.minecraftUsername, {
    allowInteractiveRecovery: true, beforeInteractiveRecoveryCompletes: async () => { checked.push('stable'); }
  });
  const second = service.run(config, initial, initial.minecraftUsername, {
    allowInteractiveRecovery: true, beforeInteractiveRecoveryCompletes: async () => { checked.push('ptb'); }
  });
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(checked.sort(), ['ptb', 'stable']);
});

test('a forced account revalidation cannot be satisfied by a background cached skip', async () => {
  let calls = 0;
  const read = deferred();
  const confirmed = { ...initial, confirmed: true };
  const service = await coordinator({ loadIdentity: async () => { await read.promise; return confirmed; },
    register: async () => { calls++; return { ok: true, remote: { verified: true } }; } });
  const background = service.run(config, confirmed, confirmed.minecraftUsername);
  const repair = service.run(config, confirmed, confirmed.minecraftUsername, { forceRemoteRegistration: true, allowInteractiveRecovery: true });
  read.resolve();
  await Promise.all([background, repair]);
  assert.equal(calls, 1, 'Repair requires a network revalidation even when background sync is already satisfied');
});

test('a rejected background attempt may be upgraded once by an explicit caller', async () => {
  const calls = [];
  const gate = deferred();
  const service = await coordinator({ loadIdentity: async () => initial, register: async (_name, options) => {
    calls.push(Boolean(options.allowInteractiveRecovery));
    if (!options.allowInteractiveRecovery) { await gate.promise; throw new Error('No cached session'); }
    return { ok: true, remote: { recovered: true } };
  } });
  const background = service.run(config, initial, initial.minecraftUsername).catch(() => null);
  const play = service.run(config, initial, initial.minecraftUsername, { allowInteractiveRecovery: true });
  gate.resolve();
  assert.equal((await play).ok, true);
  await background;
  assert.deepEqual(calls, [false, true]);
});

test('registration never operates under a stale installation identity', async () => {
  let calls = 0;
  const service = await coordinator({ loadIdentity: async () => ({ ...initial, installId: 'changed-installation' }),
    register: async () => { calls++; return { ok: true }; } });
  await assert.rejects(service.run(config, initial, initial.minecraftUsername), { code: 'AHT_ACCOUNT_CHANGED' });
  assert.equal(calls, 0);
});

test('a different account selected while registration completes cannot receive stale success', async () => {
  let current = initial;
  const service = await coordinator({ loadIdentity: async () => current, register: async () => {
    current = { ...initial, minecraftUsername: 'OtherPlayer', minecraftUuid: 'b'.repeat(32) };
    return { ok: true, username: initial.minecraftUsername };
  } });
  await assert.rejects(service.run(config, initial, initial.minecraftUsername, { forceRemoteRegistration: true }),
    { code: 'AHT_ACCOUNT_CHANGED' });
});

test('each waiter rejects an account switch during its final integrity recheck', async () => {
  let current = initial;
  const service = await coordinator({ loadIdentity: async () => current, register: async (_name, options) => {
    await options.beforeInteractiveRecoveryCompletes();
    return { ok: true, username: initial.minecraftUsername };
  } });
  await assert.rejects(service.run(config, initial, initial.minecraftUsername, {
    allowInteractiveRecovery: true, beforeInteractiveRecoveryCompletes: async () => {
      current = { ...initial, minecraftUsername: 'OtherPlayer', minecraftUuid: 'b'.repeat(32) };
    }
  }), { code: 'AHT_ACCOUNT_CHANGED' });
});

test('an intentional newly verified account remains allowed without granting another UUID', async () => {
  let current = initial;
  const service = await coordinator({ loadIdentity: async () => current, register: async name => {
    current = { ...initial, minecraftUsername: name, minecraftUuid: 'b'.repeat(32) };
    return { ok: true, username: name };
  } });
  assert.equal((await service.run(config, initial, 'OtherPlayer', { minecraftUuid: 'b'.repeat(32) })).ok, true);
  current = initial;
  await assert.rejects(service.run(config, initial, initial.minecraftUsername, { minecraftUuid: 'a'.repeat(32) }),
    { code: 'AHT_ACCOUNT_CHANGED' });
});
