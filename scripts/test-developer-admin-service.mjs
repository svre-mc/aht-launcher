import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeveloperAdminService } from '../src/developerAdminService.js';
import { requestServiceJson } from '../src/serviceTransport.js';

const config = { base: 'https://admin.invalid/api/' };
const credentials = { username: 'fixture', password: 'test-only-not-a-credential' };
const result = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, body });
const login = token => result({ token, expiresAt: new Date(Date.now() + 3600000).toISOString() });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const service = options => createDeveloperAdminService({ baseUrl: c => c.base, loadCredentials: async () => credentials, ...options });

test('concurrent player-data panels share a login and cache only a valid session', async () => {
  let logins = 0; let requests = 0;
  const api = service({ request: async (url, options) => {
    if (url.pathname.endsWith('/login')) { logins++; return login('fixture-token'); }
    assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    requests++; return result({ rows: [] });
  } });
  await Promise.all(Array.from({ length: 8 }, () => api.fetch(config, 'admin/player-records')));
  assert.equal(logins, 1); assert.equal(requests, 8);
});

test('one rejected token is refreshed once; permanent rejection cannot loop', async () => {
  let logins = 0; let requests = 0;
  const api = service({ request: async url => url.pathname.endsWith('/login') ? (logins++, login(`fixture-${logins}`))
    : (requests++, result({ error: 'Unauthorized' }, 401)) });
  await assert.rejects(api.fetch(config, 'admin/player-records'), { status: 401 });
  assert.equal(logins, 2); assert.equal(requests, 2);
});

test('a stale request cannot clear a newer token', async () => {
  let logins = 0;
  const api = service({ request: async () => login(`fixture-${++logins}`) });
  const old = await api.ensure(config);
  const fresh = await api.ensure(config, { force: true });
  api.clear(config.base, old);
  assert.equal(await api.ensure(config), fresh); assert.equal(logins, 2);
});

test('logout during a data request prevents returning its data to the old session', async () => {
  const gate = deferred(), entered = deferred();
  const api = service({ request: async url => {
    if (url.pathname.endsWith('/login')) return login('fixture-token');
    entered.resolve(); return gate.promise;
  } });
  const request = api.fetch(config, 'admin/player-records');
  await entered.promise; api.clear(); gate.resolve(result({ rows: ['private-fixture'] }));
  await assert.rejects(request, { code: 'AHT_ADMIN_SESSION_CHANGED' });
});

test('route validation prevents origin escapes, encoded traversal, and insecure credential destinations', async () => {
  let calls = 0;
  const api = service({ request: async () => { calls++; return login('fixture'); } });
  for (const route of ['https://other.invalid/admin/login', 'admin/../../outside', 'admin/%2e%2e/outside']) {
    await assert.rejects(api.fetch(config, route), { code: 'AHT_ADMIN_ADDRESS_INVALID' });
  }
  const bad = await api.login({ base: 'http://admin.invalid' });
  assert.equal(bad.code, 'AHT_ADMIN_ADDRESS_INVALID'); assert.equal(calls, 0);
});

test('invalid login contracts cannot be cached', async () => {
  for (const body of [{}, { token: 'fixture' }, { token: 'fixture', expiresAt: new Date(0).toISOString() },
    { token: 'fixture\nheader', expiresAt: new Date(Date.now() + 3600000).toISOString() }]) {
    const api = service({ request: async () => result(body) });
    assert.equal((await api.login(config)).ok, false); assert.equal(api.expiresAt(), 0);
  }
});

test('a stalled response body is included in the login deadline', async () => {
  const api = service({ loginTimeoutMs: () => 20, request: (url, options) => requestServiceJson(url,
    { ...options, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }) });
  const result = await api.login(config);
  assert.equal(result.code, 'AHT_SERVICE_TIMEOUT'); assert.match(result.error, /timed out/);
});

test('base changes never reuse authority for a different service', async () => {
  const origins = [];
  const api = service({ request: async url => { origins.push(url.origin); return login(`fixture-${origins.length}`); } });
  const first = await api.ensure(config);
  const second = await api.ensure({ base: 'https://second.invalid/' });
  assert.notEqual(first, second); assert.deepEqual(origins, ['https://admin.invalid', 'https://second.invalid']);
});

test('the newest explicit developer sign-in supersedes an older pending sign-in', async () => {
  const oldReply = deferred(), oldEntered = deferred();
  const api = service({ request: async (_url, options) => {
    if (JSON.parse(options.body).username === 'old-fixture') { oldEntered.resolve(); return oldReply.promise; }
    return login('newer-fixture-token');
  } });
  const old = api.login(config, 'old-fixture', 'fixture-password');
  await oldEntered.promise;
  assert.equal((await api.login(config, 'new-fixture', 'fixture-password')).ok, true);
  oldReply.resolve(login('old-fixture-token'));
  assert.equal((await old).code, 'AHT_ADMIN_SESSION_CHANGED');
  assert.equal(await api.ensure(config), 'newer-fixture-token');
});

test('simultaneous expired-token panel requests share refresh without invalidating one another', async () => {
  const oldReplies = deferred();
  let logins = 0, oldRequests = 0, newRequests = 0;
  const api = service({ request: async (url, options) => {
    if (url.pathname.endsWith('/login')) return login(`fixture-${++logins}`);
    if (options.headers.Authorization === 'Bearer fixture-1') {
      if (++oldRequests === 8) oldReplies.resolve();
      await oldReplies.promise;
      return result({ error: 'Expired' }, 401);
    }
    assert.equal(options.headers.Authorization, 'Bearer fixture-2');
    newRequests++;
    return result({ rows: [] });
  } });
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => api.fetch(config, 'admin/player-records')));
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 8);
  assert.equal(logins, 2); assert.equal(oldRequests, 8); assert.equal(newRequests, 8);
});
