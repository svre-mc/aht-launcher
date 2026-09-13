import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { requestServiceJson, serviceResponseError } from '../src/serviceTransport.js';

async function serve(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); server.close(); }
}

test('preserves an actionable recovery challenge without treating it as authorization', async () => {
  const result = await requestServiceJson('https://fixture.invalid', { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    return new Response(JSON.stringify({ code: 'MINECRAFT_OWNERSHIP_REQUIRED', error: 'Verification required.', challenge: 'fixture' }), { status: 409 });
  } });
  assert.equal(result.ok, false); assert.equal(result.status, 409);
  assert.equal(serviceResponseError(result).code, 'MINECRAFT_OWNERSHIP_REQUIRED');
});

test('redirect responses fail before their bodies or locations are consumed', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let cancelled = false;
    await assert.rejects(requestServiceJson('https://fixture.invalid', { fetchImpl: async () => new Response(
      new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { Location: 'https://different.invalid/private' } }
    ) }), { code: 'AHT_SERVICE_REDIRECT_BLOCKED' });
    assert.equal(cancelled, true);
  }
});

test('absolute deadline includes a stalled body, not just response headers', async () => {
  await serve((_request, response) => { response.writeHead(200); response.write('{'); }, async url => {
    const start = Date.now();
    await assert.rejects(requestServiceJson(url, { timeoutMs: 100 }), { code: 'AHT_SERVICE_TIMEOUT' });
    assert(Date.now() - start < 1000);
  });
});

test('a stalled injected transport cannot make cancellation wait for its promise', async () => {
  const controller = new AbortController();
  const request = requestServiceJson('https://fixture.invalid', { signal: controller.signal, fetchImpl: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(request, { code: 'AHT_SERVICE_CANCELLED' });
});

test('oversized declared responses are rejected without reading their bodies', async () => {
  await serve((_request, response) => { response.writeHead(200, { 'Content-Length': '1000000' }); response.write('{'); },
    url => assert.rejects(requestServiceJson(url, { maxBytes: 64 }), { code: 'AHT_SERVICE_RESPONSE_TOO_LARGE' }));
});

test('chunked responses have a decompressed byte limit', async () => {
  await serve((_request, response) => { response.writeHead(200); response.write('{"value":"'); response.write('x'.repeat(100)); },
    url => assert.rejects(requestServiceJson(url, { maxBytes: 64 }), { code: 'AHT_SERVICE_RESPONSE_TOO_LARGE' }));
});

test('split UTF8 remains intact; invalid JSON shapes cannot become successful results', async () => {
  await serve((_request, response) => {
    const bytes = Buffer.from('{"value":"é"}');
    response.write(bytes.subarray(0, 11)); response.end(bytes.subarray(11));
  }, async url => assert.equal((await requestServiceJson(url)).body.value, 'é'));
  for (const body of ['null', '[]', '"OK"', '<html>busy</html>']) {
    await assert.rejects(requestServiceJson('https://fixture.invalid', { fetchImpl: async () => new Response(body) }), { code: 'AHT_SERVICE_RESPONSE_INVALID' });
  }
});

test('transport errors do not include the request address or credentials', async () => {
  await assert.rejects(requestServiceJson('https://fixture.invalid/private', { fetchImpl: async () => {
    throw new Error('https://fixture.invalid/private secret-value');
  } }), error => error.code === 'AHT_SERVICE_UNAVAILABLE' && !JSON.stringify(error).includes('secret-value') && !error.message.includes('fixture.invalid'));
});

test('invalid UTF8 cannot be silently replaced in account fields', async () => {
  const bytes = Buffer.concat([Buffer.from('{"username":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  await assert.rejects(requestServiceJson('https://fixture.invalid', { fetchImpl: async () => new Response(bytes) }),
    { code: 'AHT_SERVICE_RESPONSE_INVALID' });
});
