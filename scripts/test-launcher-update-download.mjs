import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { downloadLauncherUpdate } from '../src/launcherUpdateDownload.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-launcher-download-'));
const bytes = Buffer.alloc(24 * 1024 * 1024 + 17);
for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
let active = 0;
let peakActive = 0;
let rangedWholeRequests = 0;
let fallbackWholeRequests = 0;
const server = http.createServer((request, response) => {
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
  if (request.url === '/ranges' && range) {
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), bytes.length - 1);
    response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` });
    if (start === end) { response.end(bytes.subarray(start, end + 1)); return; }
    active += 1;
    peakActive = Math.max(peakActive, active);
    setTimeout(() => { active -= 1; response.end(bytes.subarray(start, end + 1)); }, 50);
    return;
  }
  if (request.url === '/ranges') rangedWholeRequests += 1;
  if (request.url === '/no-ranges' && !range) fallbackWholeRequests += 1;
  response.writeHead(200, { 'Content-Length': bytes.length });
  response.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const events = [];
  const lines = [];
  const target = path.join(root, 'launcher.zip');
  const result = await downloadLauncherUpdate(`${base}/ranges`, target, {
    onProgress: event => events.push(event), logger: { log: line => lines.push(line) }
  });
  assert(peakActive > 1 && peakActive <= 6, `Expected concurrent bounded ranges, saw ${peakActive}`);
  assert.equal(rangedWholeRequests, 0, 'Supported origin must not download the full archive again');
  assert.equal(result.method, 'multipart-range');
  assert.equal(result.bytes, bytes.length);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex'), expectedHash);
  assert.equal(events.at(-1).loaded, bytes.length);
  assert.equal(events.at(-1).percent, 100);
  assert(lines.some(line => line.includes('Launcher download completed:')));
  assert(lines.every(line => !line.includes(base)), 'Timing diagnostics must not expose source URLs');
  const fallback = await downloadLauncherUpdate(`${base}/no-ranges`, target);
  assert.equal(fallback.method, 'stream');
  assert.equal(fallbackWholeRequests, 1);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex'), expectedHash);
  const local = await downloadLauncherUpdate(target, path.join(root, 'local.zip'));
  assert.equal(local.bytes, bytes.length);
  console.log('PASS: launcher ranges overlap, exact bytes/progress/timings, unsupported-origin fallback and local reinstall.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
