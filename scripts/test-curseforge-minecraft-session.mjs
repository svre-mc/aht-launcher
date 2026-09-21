import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createCurseForgeMinecraftSessions } from '../src/curseforgeMinecraftSession.js';

const user = { uid: -1, username: 'SyntheticUser' };
const id = '12345678123442349234123456789abc';
const otherId = 'aaaaaaaaaaa a4aaa8aaaaaaaaaaaaaaa'.replaceAll(' ', '');
const now = Date.now();
const account = (overrides = {}) => ({ uuid: id, username: 'ExistingPlayer', userType: 'msa',
  minecraftToken: { accessToken: 'fixture-minecraft-private', expiresAt: new Date(now + 3600000).toISOString() },
  oauthTokens: { refreshToken: 'fixture-microsoft-private' }, ...overrides });
function storage(entries = [[id, account()]], selected = id, mode = 1) {
  const salt = randomBytes(64), iv = randomBytes(16);
  const key = pbkdf2Sync(`${user.uid}${user.username}`, salt, 100000, 32, 'sha512');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(entries), 'utf8'), cipher.final()]);
  return { 'minecraft-settings': JSON.stringify({ gameLaunchMethod: mode }), 'game-selected-user-id': selected,
    'game-user-info': Buffer.from(Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]).toString('hex')).toString('base64'),
    'session-tokens': 'CF-website-session-must-never-be-used' };
}
async function fixture(t, value) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-cf-session-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'storage.json');
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('existing CurseForge selected account is read without any login request or token exposure', async t => {
  const file = await fixture(t, storage([[otherId, account({ uuid: otherId, username: 'WrongPlayer' })], [id, account()]]));
  const sessions = createCurseForgeMinecraftSessions({ userInfo: () => user, fetchImpl: () => assert.fail('Profile inspection must not perform authentication') });
  assert.equal(await sessions.mode(file), true);
  assert.deepEqual(await sessions.inspect(file), { username: 'ExistingPlayer', minecraftUuid: '12345678-1234-4234-9234-123456789abc', provider: 'curseforge' });
  assert(!JSON.stringify(await sessions.inspect(file)).includes('private'));
  await fs.writeFile(file, JSON.stringify(storage([], id)));
  assert.equal(await sessions.inspect(file), null, 'Removed account must not be supplied by a stale cache');
});

test('Mojang mode does not decrypt CurseForge credentials; unreadable metadata does not block Repair/status', async t => {
  const file = await fixture(t, { 'minecraft-settings': '{"gameLaunchMethod":0}', 'game-user-info': 'broken' });
  let direct = false;
  const sessions = createCurseForgeMinecraftSessions({ userInfo: () => { assert(direct, 'Mojang mode must not decode CF accounts'); return user; } });
  assert.equal(await sessions.mode(file), false);
  assert.equal(await sessions.inspect(file), null);
  direct = true;
  await fs.writeFile(file, '{"minecraft-settings":"{\\"gameLaunchMethod\\":1}","game-user-info":"broken"}');
  assert.equal(await sessions.inspect(file), null);
  await assert.rejects(sessions.acquire(file), { code: 'CURSEFORGE_SESSION_UNAVAILABLE' });
});

test('valid Minecraft session is reused, verified only with Minecraft, and never written back to either provider', async t => {
  const file = await fixture(t, storage()); const before = await fs.readFile(file);
  const calls = [];
  const sessions = createCurseForgeMinecraftSessions({ userInfo: () => user, now: () => now,
    fetchImpl: async (url, options) => {
      calls.push(url); assert.equal(url, 'https://api.minecraftservices.com/minecraft/profile');
      assert.equal(options.headers.Authorization, 'Bearer fixture-minecraft-private');
      assert.equal(options.redirect, 'manual');
      return response({ id, name: 'ExistingPlayer' });
    } });
  const first = await sessions.acquire(file); const second = await sessions.acquire(file);
  assert.equal(first.accessToken, 'fixture-minecraft-private'); assert.deepEqual(first, second);
  assert.equal(calls.length, 1);
  assert.deepEqual(await fs.readFile(file), before);
  assert(!JSON.stringify(await sessions.inspect(file)).includes('private'));
});

test('expired cached Minecraft token renews through fixed Microsoft/Xbox/Minecraft endpoints with no interactive sign-in', async t => {
  const file = await fixture(t, storage([[id, account({ minecraftToken: { accessToken: 'old-private', expiresAt: new Date(0).toISOString() } })]]));
  const before = await fs.readFile(file); const calls = [];
  const bodies = [ { access_token: 'renewed-ms-private' }, { Token: 'xbox-private' },
    { Token: 'xsts-private', DisplayClaims: { xui: [{ uhs: 'fixture-hash' }] } },
    { access_token: 'renewed-minecraft-private', expires_in: 86400 }, { id, name: 'RenamedPlayer' } ];
  const sessions = createCurseForgeMinecraftSessions({ userInfo: () => user, now: () => now,
    fetchImpl: async (url, options) => {
      calls.push(url); assert.equal(options.redirect, 'manual');
      assert(!url.includes('fixture') && !url.includes('private'));
      if (calls.length === 1) {
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), 'fixture-microsoft-private');
      }
      return response(bodies.shift());
    } });
  const selected = await sessions.acquire(file);
  assert.equal(selected.accessToken, 'renewed-minecraft-private'); assert.equal(selected.username, 'RenamedPlayer');
  assert.equal((await sessions.inspect(file)).username, 'RenamedPlayer');
  assert.deepEqual(calls, ['https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    'https://user.auth.xboxlive.com/user/authenticate', 'https://xsts.auth.xboxlive.com/xsts/authorize',
    'https://api.minecraftservices.com/authentication/login_with_xbox', 'https://api.minecraftservices.com/minecraft/profile']);
  assert.deepEqual(await fs.readFile(file), before);
});

test('provider rejection, redirects, wrong identity and account switches never leak credentials or choose another login', async t => {
  for (const kind of ['reject', 'redirect', 'wrong', 'switch']) {
    const file = await fixture(t, storage());
    const sessions = createCurseForgeMinecraftSessions({ userInfo: () => user, now: () => now,
      fetchImpl: async (url) => {
        if (kind === 'reject') return response({ error: 'private fixture-minecraft-private' }, 401);
        if (kind === 'redirect') return new Response('', { status: 302, headers: { Location: 'https://untrusted.invalid/' } });
        if (kind === 'switch') await fs.writeFile(file, JSON.stringify(storage([[otherId, account({ uuid: otherId })]], otherId)));
        return response({ id: kind === 'wrong' ? otherId : id, name: 'ExistingPlayer' });
      } });
    await assert.rejects(sessions.acquire(file), error => {
      assert(!JSON.stringify(error).includes('private')); assert(!error.message.includes('private'));
      return error.code === ({ reject: 'CURSEFORGE_SESSION_EXPIRED', redirect: 'CURSEFORGE_SESSION_NETWORK',
        wrong: 'CURSEFORGE_SESSION_CHANGED', switch: 'CURSEFORGE_SESSION_CHANGED' })[kind];
    });
  }
});
