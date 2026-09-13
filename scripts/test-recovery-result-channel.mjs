import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openRecoveryResultChannel } from '../src/recoveryResultChannel.js';

async function fixture(t, timeoutMs = 2000) {
  const abort = new AbortController();
  const channel = await openRecoveryResultChannel({ signal: abort.signal, timeoutMs, username: 'FixturePlayer' });
  t.after(channel.close);
  return { ...channel, abort };
}

test('null, arrays, primitives, extra fields and malformed JSON cannot crash or settle verification', async t => {
  const channel = await fixture(t);
  for (const body of ['null', '[]', 'false', '1', '"verified"', '{}', '{',
    '{"result":"verified","token":"do-not-accept"}', '{"result":"unknown"}']) {
    const response = await fetch(channel.url, { method: 'POST', body });
    assert.equal(response.status, 400, body);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const verified = await fetch(channel.url, { method: 'POST', body: '{"result":"verified"}' });
  assert.equal(verified.status, 204);
  assert.equal((await channel.result).verified, true);
  const replay = await fetch(channel.url, { method: 'POST', body: '{"result":"verified"}' });
  assert.equal(replay.status, 404);
});

test('browser-origin traffic, wrong host, wrong secret and GET cannot verify an account', async t => {
  const channel = await fixture(t);
  for (const request of [
    { url: channel.url, method: 'GET' },
    { url: channel.url, headers: { Origin: 'https://attacker.invalid' } },
    { url: channel.url.replace(/.$/, 'z') }
  ]) {
    const { url, method = 'POST', headers } = request;
    assert.equal((await fetch(url, { method, headers, ...(method === 'POST' ? { body: '{"result":"verified"}' } : {}) })).status, 404);
  }
  // fetch may normalize/forbid Host. Use the socket-facing HTTP API for this case.
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.request(channel.url, { method: 'POST', headers: { Host: 'attacker.invalid' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end('{"result":"verified"}');
  });
  assert.equal(wrongHost, 404);
  channel.abort.abort();
  await assert.rejects(channel.result, { code: 'AHT_ACCOUNT_RECOVERY_CANCELLED' });
});

test('oversized notifications are disconnected without crashing the result channel', async t => {
  const channel = await fixture(t);
  await assert.rejects(fetch(channel.url, { method: 'POST', body: 'x'.repeat(257) }));
  assert.equal((await fetch(channel.url, { method: 'POST', body: '{"result":"verified"}' })).status, 204);
  assert.equal((await channel.result).verified, true);
});

test('absolute deadline terminates a slow notification and preserves its timeout error', async t => {
  const channel = await fixture(t, 90);
  const request = http.request(channel.url, { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } });
  request.on('error', () => {});
  request.write('{');
  t.after(() => request.destroy());
  await assert.rejects(channel.result, { code: 'AHT_ACCOUNT_RECOVERY_TIMEOUT' });
  assert.throws(channel.throwIfFailed, { code: 'AHT_ACCOUNT_RECOVERY_TIMEOUT' });
  await channel.close();
});

test('wrong-account and failed results remain failures, even if another notification follows', async t => {
  for (const result of ['wrong-account', 'failed']) {
    const channel = await fixture(t);
    await fetch(channel.url, { method: 'POST', body: JSON.stringify({ result }) });
    await assert.rejects(channel.result, /Select FixturePlayer|could not verify/);
    assert.equal((await fetch(channel.url, { method: 'POST', body: '{"result":"verified"}' })).status, 404);
  }
});
