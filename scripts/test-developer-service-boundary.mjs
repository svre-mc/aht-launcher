import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';

async function fixture(fetchImpl = fetch) {
  const source = (await fs.readFile(process.env.AHT_ADMIN_SERVICE_BASELINE || new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const begin = source.indexOf('function remoteAdminBaseUrl(');
  const clear = source.indexOf('function clearRemoteAdminToken(');
  const context = vm.createContext({ URL, Date, Map, Number, String, Error, Set, AbortSignal, fetch: fetchImpl,
    process: { env: { AHT_TEST_HOOKS: '1', AHT_TEST_REMOTE_ADMIN_TIMEOUT_MS: '100' } },
    REMOTE_ADMIN_LOGIN_TIMEOUT_MS: 100, adminToken: '', adminTokenExpiresAt: 0, adminTokenBaseUrl: '', adminLoginPromises: new Map(),
    workerServiceBaseUrl: value => value,
    loadDeveloperCredentials: async () => ({ username: 'fixture', password: 'test-only-not-a-credential' }),
    assertDeveloperAuthenticated: () => {} });
  if (!process.env.AHT_ADMIN_SERVICE_BASELINE) {
    const { createDeveloperAdminService } = await import('../src/developerAdminService.js');
    const { requestServiceJson } = await import('../src/serviceTransport.js');
    context.developerAdminService = createDeveloperAdminService({ baseUrl: config => config.sync.baseUrl,
      loadCredentials: context.loadDeveloperCredentials, loginTimeoutMs: () => 100,
      request: (url, options) => requestServiceJson(url, { ...options, fetchImpl }), assertAuthenticated: () => {} });
  }
  vm.runInContext(source.slice(begin, source.indexOf('\nfunction minecraftLaunchEnv(', begin)), context);
  vm.runInContext(source.slice(clear, source.indexOf('\nasync function launcherProofAuthToken(', clear)), context);
  return context;
}

test('developer login never forwards a password to a redirected origin', async () => {
  let received = false;
  const destination = http.createServer((_request, response) => {
    received = true; response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ token: 'fixture-token', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
  });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  const source = http.createServer((_request, response) => {
    response.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/redirected` }); response.end();
  });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  try {
    const main = await fixture();
    const result = await main.remoteAdminLogin({ sync: { baseUrl: `http://127.0.0.1:${source.address().port}` } });
    assert.equal(result.ok, false);
    assert.equal(received, false, 'The redirected destination received the credential request');
  } finally { for (const server of [source, destination]) { server.closeAllConnections(); server.close(); } }
});

test('clearing a developer session invalidates a login already in flight', async () => {
  let respond; const response = new Promise(resolve => { respond = resolve; });
  let entered; const requestStarted = new Promise(resolve => { entered = resolve; });
  const main = await fixture(async () => { entered(); return response; });
  const login = main.remoteAdminLogin({ sync: { baseUrl: 'https://admin.invalid' } });
  await requestStarted; main.clearRemoteAdminToken();
  respond(new Response(JSON.stringify({ token: 'fixture-token', expiresAt: new Date(Date.now() + 3600000).toISOString() })));
  assert.equal((await login).ok, false, 'A late login result must not restore a cleared session');
});
