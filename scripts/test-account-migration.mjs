import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import worker from '../cloudflare/curseforge-proxy-worker.js';
import { recoverLegacyMinecraftAccount } from '../cloudflare/minecraft-account-recovery.js';
import { proveMinecraftAccountOwnership } from '../src/minecraftAccountRecovery.js';
import { readWindowsMinecraftSession, readWindowsMinecraftSessions } from '../src/windowsMinecraftSession.js';
import { createDeviceAssertion, createDeviceCredential } from '../src/deviceIdentity.js';
import { createLauncherIdentityStore } from '../src/launcherIdentityStore.js';

const username = 'LegacyRig';
const minecraftUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const secret = 'fixture_recovery_secret_1234567890123456';
const device = createDeviceCredential();
const key = 'accounts/usernames/legacyrig.json';
const original = { username, installId: 'old-install', appVersion: '0.1.48', createdAt: '2026-07-01T00:00:00Z', previousInstallIds: [] };
const records = new Map([[key, structuredClone(original)]]);
const env = { AHT_REQUIRE_DEVICE_ATTESTATION: 'true', AHT_BLOCK_LIKELY_VPN: 'false', AHT_DATA: {
  get: async key => records.has(key) ? { etag: createHash('sha256').update(JSON.stringify(records.get(key))).digest('hex'), json: async () => structuredClone(records.get(key)) } : null,
  put: async (key, value, options = {}) => {
    if (options.onlyIf?.etagMatches && (!records.has(key) || createHash('sha256').update(JSON.stringify(records.get(key))).digest('hex') !== options.onlyIf.etagMatches)) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && records.has(key)) return null;
    records.set(key, JSON.parse(value)); return { etag: createHash('sha256').update(value).digest('hex') };
  },
  delete: async key => records.delete(key),
  list: async ({ prefix = '' } = {}) => ({ objects: [...records.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false })
} };
const payload = () => ({ username, minecraftUuid, installId: 'new-install', appVersion: '0.2.08', platform: 'win32',
  deviceId: device.deviceId, devicePublicKey: device.publicKey });
async function register(extra = {}, signed = true, recoverySecret = secret) {
  const body = { ...payload(), ...extra };
  if (signed) body.deviceAssertion = createDeviceAssertion(device, { purpose: 'account-registration', binding: {
    username: username.toLowerCase(), minecraftUuid, installId: body.installId, deviceId: device.deviceId
  } });
  const response = await worker.fetch(new Request('https://worker.test/api/users/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AHT-Launcher-Recovery': recoverySecret }, body: JSON.stringify(body)
  }), env, {});
  return { status: response.status, body: await response.json() };
}
const recovery = { recoverExistingUsername: true, minecraftAccountMatched: true, supportsMinecraftSessionRecovery: true };
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-account-migration-'));
const originalFetch = globalThis.fetch;
try {
  assert.equal((await register()).status, 409);
  assert.equal((await register(recovery, false)).status, 403);
  const issued = await register(recovery);
  assert.equal(issued.body.code, 'MINECRAFT_OWNERSHIP_REQUIRED');
  const challenge = issued.body.minecraftSessionChallenge;
  assert.match(challenge, /^[a-f0-9]{40}$/);
  assert.deepEqual(records.get(key), original, 'issuing a challenge cannot claim the account');
  let verifiedName = 'WrongPlayer';
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://sessionserver.mojang.com/session/minecraft/hasJoined');
    assert.equal(parsed.searchParams.get('serverId'), challenge);
    return new Response(JSON.stringify({ name: verifiedName, id: minecraftUuid.replaceAll('-', '') }));
  };
  assert.equal((await register({ ...recovery, minecraftSessionChallenge: challenge })).status, 409);
  assert.deepEqual(records.get(key), original);
  const check = { env, record: original, body: { minecraftSessionChallenge: challenge }, username,
    minecraftUuid, deviceId: device.deviceId, installId: 'new-install' };
  assert.equal((await recoverLegacyMinecraftAccount({ ...check, now: Date.now() + 6 * 60_000 })).verified, false);
  assert.equal((await recoverLegacyMinecraftAccount({ ...check, installId: 'attacker' })).verified, false);
  assert.equal((await recoverLegacyMinecraftAccount({ ...check, minecraftUuid: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' })).verified, false);
  assert.equal((await recoverLegacyMinecraftAccount({ ...check, record: { ...original, deviceId: device.deviceId } })).verified, false);
  assert.equal((await recoverLegacyMinecraftAccount({ ...check, fetchImpl: async () => { throw new Error('private transport detail'); } })).status, 503);
  verifiedName = username;
  const result = await register({ ...recovery, minecraftSessionChallenge: challenge });
  assert.equal(result.status, 200);
  const migrated = records.get(key);
  assert.equal(migrated.installId, 'new-install');
  assert.equal(migrated.minecraftUuid, minecraftUuid);
  assert.equal(migrated.deviceId, device.deviceId);
  assert.equal(migrated.accountRecoveryVerifier, createHash('sha256').update(secret).digest('hex'));
  assert.equal(migrated.createdAt, original.createdAt);
  assert.deepEqual(migrated.previousInstallIds, ['old-install']);
  assert.equal([...records.keys()].filter(key => key.startsWith('accounts/recovery-challenges/')).length, 0);
  assert.equal((await register({ ...recovery, installId: 'attacker', minecraftSessionChallenge: challenge }, true,
    'unrelated_recovery_secret_1234567890123456')).status, 409, 'used challenges cannot reclaim secured accounts');
  // A replay without the saved recovery credential must not reuse the old challenge.
  assert.equal((await recoverLegacyMinecraftAccount({ ...check, record: migrated })).verified, false);

  const token = 'private-minecraft-token';
  await fs.writeFile(path.join(root, 'launcher_accounts.json'), JSON.stringify({ accounts: {
    selected: { accessToken: token, minecraftProfile: { name: username, id: minecraftUuid.replaceAll('-', '') } },
    unrelated: { accessToken: 'must-never-send', minecraftProfile: { name: 'OtherPlayer', id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }
  } }));
  let calls = 0;
  const prove = { roots: [root], username, minecraftUuid, serverId: challenge };
  assert.deepEqual(await proveMinecraftAccountOwnership({ ...prove, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://sessionserver.mojang.com/session/minecraft/join');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).accessToken, token);
    assert.equal(JSON.parse(options.body).selectedProfile, minecraftUuid.replaceAll('-', ''));
    return new Response(null, { status: 204 });
  } }), { verified: true });
  assert.equal(calls, 1);
  await fs.writeFile(path.join(root, 'launcher_accounts.json'), JSON.stringify({ accounts: {
    selected: { remoteId: 'selected-xuid', accessToken: token, minecraftProfile: { name: username, id: minecraftUuid } }
  } }));
  assert.equal((await proveMinecraftAccountOwnership({ ...prove,
    readWindowsSession: async () => { throw new Error('Unnecessary protected-cache access'); },
    fetchImpl: async url => { assert.equal(url, 'https://sessionserver.mojang.com/session/minecraft/join'); return new Response(null, { status: 204 }); }
  })).verified, true, 'A valid direct session avoids protected-cache access entirely');
  await assert.rejects(proveMinecraftAccountOwnership({ ...prove, readWindowsSession: async () => [], fetchImpl: async () => new Response('private upstream content', { status: 403 }) }),
    error => error.code === 'MINECRAFT_SESSION_REQUIRED' && error.diagnostics.joinAttempts === 1
      && error.diagnostics.joinRejected === 1 && !error.message.includes(token)
      && !error.message.includes('private upstream content'));
  await assert.rejects(proveMinecraftAccountOwnership({ ...prove, username: 'OtherPlayer' }),
    error => error.code === 'MINECRAFT_SESSION_REQUIRED' && error.diagnostics.matchedAccounts === 0);

  await fs.writeFile(path.join(root, 'launcher_accounts.json'), JSON.stringify({ accounts: {
    active: { remoteId: 'selected-xuid', accessToken: '', minecraftProfile: { name: username, id: minecraftUuid } }
  } }));
  const protectedRequests = [];
  const protectedOptions = { ...prove, readWindowsSession: async session => {
    assert.equal(session.remoteId, 'selected-xuid');
    assert.equal(path.basename(session.file), 'launcher_msa_credentials.bin');
    return { token: 'fixture-xsts', userHash: 'fixture-userhash' };
  }, fetchImpl: async (url, options) => {
    protectedRequests.push(url);
    if (url.endsWith('/authentication/login_with_xbox')) {
      assert.equal(JSON.parse(options.body).identityToken, 'XBL3.0 x=fixture-userhash;fixture-xsts');
      return new Response(JSON.stringify({ access_token: 'fixture-minecraft' }));
    }
    if (url.endsWith('/minecraft/profile')) {
      assert.equal(options.headers.Authorization, 'Bearer fixture-minecraft');
      return new Response(JSON.stringify({ name: username, id: minecraftUuid }));
    }
    assert.equal(url, 'https://sessionserver.mojang.com/session/minecraft/join');
    assert.equal(JSON.parse(options.body).accessToken, 'fixture-minecraft');
    return new Response(null, { status: 204 });
  } };
  assert.equal((await proveMinecraftAccountOwnership(protectedOptions)).verified, true);
  assert.equal(protectedRequests.length, 3);
  assert.equal((await proveMinecraftAccountOwnership({ ...protectedOptions,
    readWindowsSession: async () => [
      { token: 'revoked-xsts', userHash: 'fixture-userhash' },
      { token: 'fixture-xsts', userHash: 'fixture-userhash' }
    ], fetchImpl: async (url, options) => options.body?.includes('revoked-xsts')
      ? new Response(null, { status: 401 }) : protectedOptions.fetchImpl(url, options)
  })).verified, true, 'A rejected Xbox session must not hide a later valid session');
  assert.equal((await proveMinecraftAccountOwnership({ ...protectedOptions,
    readWindowsSession: async () => [
      { token: 'unavailable-xsts', userHash: 'fixture-userhash' },
      { token: 'fixture-xsts', userHash: 'fixture-userhash' }
    ], fetchImpl: async (url, options) => options.body?.includes('unavailable-xsts')
      ? new Response(null, { status: 503 }) : protectedOptions.fetchImpl(url, options)
  })).verified, true, 'A failed exchange must not mask a usable candidate');
  await assert.rejects(proveMinecraftAccountOwnership({ ...protectedOptions, fetchImpl: async () => new Response(null, { status: 503 }) }), /Try account sync again shortly/);
  // An exchange outage in a cached credential must not prevent an explicit
  // action from trying the official launcher's fresh session. Background sync
  // still fails closed, and cancellation must remain cancellation.
  for (const failure of [429, 503, 'network']) {
    for (const stage of ['exchange', 'profile', 'join']) {
      const failingFetch = async (url, options) => {
        const failsHere = stage === 'exchange' ? url.endsWith('/login_with_xbox')
          : stage === 'profile' ? url.endsWith('/minecraft/profile') : url.endsWith('/join');
        if (!failsHere) return protectedOptions.fetchImpl(url, options);
        if (failure === 'network') throw new Error('private upstream transport detail');
        return new Response(null, { status: failure });
      };
      const failedCache = { ...protectedOptions, fetchImpl: failingFetch };
      await assert.rejects(proveMinecraftAccountOwnership(failedCache),
        error => error.code === 'MINECRAFT_OWNERSHIP_UNAVAILABLE');
      let recoveryCalls = 0;
      assert.deepEqual(await proveMinecraftAccountOwnership({ ...failedCache, interactiveRecovery: async request => {
        recoveryCalls++;
        assert.equal(request.username, username);
        assert.equal(request.minecraftUuid, minecraftUuid);
        assert.equal(request.serverId, challenge);
        return { verified: true, interactive: true };
      } }), { verified: true, interactive: true }, `${stage} ${failure} must allow fresh-session recovery`);
      assert.equal(recoveryCalls, 1);
      const cancelled = Object.assign(new Error('Account verification cancelled.'), { code: 'AHT_ACCOUNT_RECOVERY_CANCELLED' });
      await assert.rejects(proveMinecraftAccountOwnership({ ...failedCache, interactiveRecovery: async () => { throw cancelled; } }),
        error => error === cancelled);
    }
  }
  await assert.rejects(proveMinecraftAccountOwnership({ ...protectedOptions, fetchImpl: async url =>
    new Response(JSON.stringify(url.endsWith('/minecraft/profile') ? { name: 'WrongOwner', id: minecraftUuid } : { access_token: 'fixture' })) }),
    error => error.code === 'MINECRAFT_SESSION_REQUIRED' && error.diagnostics.profileMismatch === 1);
  if (process.platform === 'win32') {
    const cacheFile = path.join(root, 'protected-fixture.bin');
    const cache = { credentials: { 'selected-xuid': { 'Xal.test.RETAIL.User.fixture': JSON.stringify({ tokens: [{
      RelyingParty: 'rp://api.minecraftservices.com/', TokenData: { Token: 'fake-dpapi-token',
        NotAfter: new Date(Date.now() + 60_000).toISOString(), DisplayClaims: { xui: [{ uhs: 'fake-userhash' }] } }
    }] }) } } };
    execFileSync(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Security; $r=[Console]::In.ReadToEnd()|ConvertFrom-Json; $b=[Text.Encoding]::UTF8.GetBytes($r.cache); [IO.File]::WriteAllBytes($r.file,[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"],
      { windowsHide: true, input: JSON.stringify({ file: cacheFile, cache: JSON.stringify(cache) }), timeout: 10_000 });
    const credential = await readWindowsMinecraftSession({ file: cacheFile, remoteId: 'selected-xuid' });
    assert.equal(credential?.token, 'fake-dpapi-token');
    assert.equal(credential?.userHash, 'fake-userhash');
    assert.equal(await readWindowsMinecraftSession({ file: cacheFile, remoteId: 'other-account' }), null);
    const validEntry = JSON.parse(cache.credentials['selected-xuid']['Xal.test.RETAIL.User.fixture']).tokens[0];
    const expiredEntry = structuredClone(validEntry);
    expiredEntry.TokenData.Token = 'expired-token';
    expiredEntry.TokenData.NotAfter = new Date(Date.now() - 60_000).toISOString();
    cache.credentials['selected-xuid'] = {
      'Xal.bad.RETAIL.User.fixture': '{broken json',
      'Xal.old.RETAIL.User.fixture': JSON.stringify({ tokens: [expiredEntry,
        { RelyingParty: validEntry.RelyingParty, TokenData: {} }] }),
      'Xal.test.RETAIL.User.fixture': JSON.stringify({ tokens: [expiredEntry, validEntry] })
    };
    execFileSync(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Security; $r=[Console]::In.ReadToEnd()|ConvertFrom-Json; $b=[Text.Encoding]::UTF8.GetBytes($r.cache); [IO.File]::WriteAllBytes($r.file,[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"],
      { windowsHide: true, input: JSON.stringify({ file: cacheFile, cache: JSON.stringify(cache) }), timeout: 10_000 });
    assert.deepEqual((await readWindowsMinecraftSessions({ file: cacheFile, remoteId: 'selected-xuid' })).map(entry => entry.token),
      ['fake-dpapi-token'], 'Malformed fields and expired tokens must not mask the selected account’s valid session');
    assert.equal(await readWindowsMinecraftSession({ file: cacheFile, remoteId: 'other-account' }), null);
  }

  const source = (await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  let diskIdentity = null;
  let writes = 0;
  const context = vm.createContext({ path, crypto: { randomUUID },
    identityPath: () => path.join(root, 'identity.json'), samePath: (a,b) => a === b,
    pathExists: async candidate => candidate === path.join(root, 'identity.json') && Boolean(diskIdentity),
    readJsonFile: async () => structuredClone(diskIdentity), isDeveloperMode: () => false,
    app: { getPath: () => root }, normalizeMinecraftUsername: value => value || '',
    writeJsonFile: async (_file, value) => { await new Promise(resolve => setTimeout(resolve, 5)); diskIdentity = value; writes++; }
  });
  const identityStore = createLauncherIdentityStore({
    file: context.identityPath, legacyFiles: () => [], createId: randomUUID,
    readJson: async () => {
      if (!diskIdentity) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return structuredClone(diskIdentity);
    },
    writeJson: context.writeJsonFile
  });
  context.loadIdentity = () => identityStore.read();
  const identities = await Promise.all(Array.from({ length: 20 }, () => context.loadIdentity()));
  assert.equal(new Set(identities.map(identity => identity.installId)).size, 1);
  assert.equal(writes, 1, 'concurrent startup must not create competing installation IDs');
  const start = source.indexOf('async function refreshRemoteMinecraftRegistration(');
  const refreshCode = source.slice(start, source.indexOf('\n}\n', start) + 3);
  Object.assign(context, { remoteRegistrationNeedsRefresh: () => true, remoteRegistrationKey: () => 'key',
    registerMinecraftUsernameInFlight: async () => ({ ok: true, username }),
    loadIdentity: async () => ({ installId: 'durable', minecraftUsername: username }) });
  vm.runInContext(refreshCode, context);
  assert.equal((await context.refreshRemoteMinecraftRegistration({}, { minecraftUsername: username })).installId, 'durable',
    'coalesced account registration must return identity, never the network response envelope');
  console.log('Account migration passed: signed ownership challenge, wrong owner/UUID/install, expiry, replay, credential privacy, identity initialization and concurrent sync.');
} finally { globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); }
