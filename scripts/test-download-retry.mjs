import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { downloadToFile } from '../src/utils.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-download-retry-'));
const dest = path.join(root, 'pack.zip');
await fs.writeFile(dest, 'old-safe-bytes', 'utf8');
let hits = 0;
let forbiddenHits = 0;
const server = http.createServer((request, response) => {
  if (request.url === '/forbidden.zip') {
    forbiddenHits += 1;
    response.statusCode = 403;
    response.end('forbidden');
    return;
  }
  hits += 1;
  if (hits < 3) {
    response.statusCode = 503;
    response.end('temporary edge failure');
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/zip');
  response.end('new-pack-bytes');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  await downloadToFile(`http://127.0.0.1:${port}/pack.zip`, dest, {
    retries: 3,
    retryDelayMs: 5,
    timeoutMs: 5000
  });
  const content = await fs.readFile(dest, 'utf8');
  let denied = false;
  try {
    await downloadToFile(`http://127.0.0.1:${port}/forbidden.zip`, dest, {
      retries: 3,
      retryDelayMs: 5,
      timeoutMs: 5000
    });
  } catch (error) {
    denied = /403 Forbidden/.test(error.message);
  }
  assert(denied, 'hard 403 download did not fail with the original status');
  assert(forbiddenHits === 1, `hard 403 download was retried instead of falling through immediately: ${forbiddenHits}`);
  assert(hits === 3, `expected two failed attempts plus one success, got ${hits}`);
  assert(content === 'new-pack-bytes', `download did not replace destination atomically: ${content}`);
  const leftovers = (await fs.readdir(root)).filter((name) => name.endsWith('.download'));
  assert(leftovers.length === 0, `temporary download files were left behind: ${leftovers.join(', ')}`);
  console.log(JSON.stringify({ ok: true, root, hits, forbiddenHits, content }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}