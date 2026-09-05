import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchJson } from '../src/utils.js';

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/headers-stall') return;
  if (url.pathname === '/body-stall') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
    return;
  }
  if (url.pathname === '/unavailable') {
    response.writeHead(503);
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ authorization: request.headers.authorization, fresh: url.searchParams.has('aht_cache_bust') }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const route of ['headers-stall', 'body-stall']) {
    await assert.rejects(fetchJson(`${base}/${route}`, {}, { timeoutMs: 100 }), /did not respond/);
  }
  await assert.rejects(fetchJson(`${base}/unavailable`), /503/);
  assert.deepEqual(await fetchJson(`${base}/ready`, { Authorization: 'Bearer fixture' }), { authorization: 'Bearer fixture', fresh: true });
  console.log('PASS: stalled headers/body time out; service errors surface; retry succeeds with auth and cache busting intact.');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
