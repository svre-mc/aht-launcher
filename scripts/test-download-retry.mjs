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
const multipartDest = path.join(root, 'range-pack.zip');
const fallbackDest = path.join(root, 'fallback-pack.zip');
const brokenRangeFallbackDest = path.join(root, 'broken-range-fallback-pack.zip');
await fs.writeFile(dest, 'old-safe-bytes', 'utf8');
let hits = 0;
let forbiddenHits = 0;
let rangeHits = 0;
let ignoredRangeHits = 0;
let brokenRangeHits = 0;
let brokenRangeStreamHits = 0;
const packBytes = 'new-pack-bytes';
const multipartBytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
const fallbackBytes = Buffer.from('server ignored range request but normal download worked', 'utf8');
const brokenRangeBytes = Buffer.from('range looked supported but chunk response broke, stream recovered', 'utf8');
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/range.zip') {
    const rangeHeader = String(request.headers.range || '');
    if (!rangeHeader) {
      response.statusCode = 500;
      response.end('range required for this test endpoint');
      return;
    }
    const match = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) {
      response.statusCode = 416;
      response.end('invalid range');
      return;
    }
    rangeHits += 1;
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), multipartBytes.length - 1);
    const body = multipartBytes.subarray(start, end + 1);
    response.statusCode = 206;
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Length', body.length);
    response.setHeader('Content-Range', `bytes ${start}-${end}/${multipartBytes.length}`);
    response.end(body);
    return;
  }
  if (url.pathname === '/no-range.zip') {
    ignoredRangeHits += 1;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Length', fallbackBytes.length);
    response.end(fallbackBytes);
    return;
  }
  if (url.pathname === '/broken-range.zip') {
    const rangeHeader = String(request.headers.range || '');
    if (rangeHeader === 'bytes=0-0') {
      brokenRangeHits += 1;
      const body = brokenRangeBytes.subarray(0, 1);
      response.statusCode = 206;
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Content-Length', body.length);
      response.setHeader('Content-Range', `bytes 0-0/${brokenRangeBytes.length}`);
      response.end(body);
      return;
    }
    if (rangeHeader) {
      brokenRangeHits += 1;
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Length', brokenRangeBytes.length);
      response.end(brokenRangeBytes);
      return;
    }
    brokenRangeStreamHits += 1;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Length', brokenRangeBytes.length);
    response.end(brokenRangeBytes);
    return;
  }
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
  response.setHeader('Content-Length', Buffer.byteLength(packBytes));
  response.end(packBytes);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  const progressEvents = [];
  await fs.writeFile(`${dest}.download`, 'stale partial bytes from killed process', 'utf8');
  await downloadToFile(`http://127.0.0.1:${port}/pack.zip`, dest, {
    retries: 3,
    retryDelayMs: 5,
    timeoutMs: 5000,
    onProgress: (progress) => progressEvents.push(progress)
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
  assert(content === packBytes, `download did not replace destination atomically: ${content}`);
  assert(progressEvents.length >= 2, 'download did not report byte progress');
  assert(progressEvents.some((event) => event.total === Buffer.byteLength(packBytes) && event.percent === 100), `download did not report final byte progress: ${JSON.stringify(progressEvents)}`);
  assert(progressEvents.every((event) => Number.isFinite(event.speedBytesPerSecond)), `download progress did not include speed: ${JSON.stringify(progressEvents)}`);
  assert(!(await fs.stat(`${dest}.download`).then(() => true).catch(() => false)), 'stale partial download file was not removed after successful retry');
  const deniedDest = path.join(root, 'denied-pack.zip');
  await fs.writeFile(deniedDest, 'known-good-before-denied-download', 'utf8');
  await fs.writeFile(`${deniedDest}.download`, 'stale denied partial bytes', 'utf8');
  let deniedProtectedExisting = false;
  try {
    await downloadToFile(`http://127.0.0.1:${port}/forbidden.zip`, deniedDest, {
      retries: 3,
      retryDelayMs: 5,
      timeoutMs: 5000
    });
  } catch (error) {
    deniedProtectedExisting = /403 Forbidden/.test(error.message)
      && await fs.readFile(deniedDest, 'utf8') === 'known-good-before-denied-download'
      && !(await fs.stat(`${deniedDest}.download`).then(() => true).catch(() => false));
  }
  assert(deniedProtectedExisting, 'failed hard download did not preserve existing file and clean stale temp data');
  const multipartProgress = [];
  await downloadToFile(`http://127.0.0.1:${port}/range.zip`, multipartDest, {
    multipart: true,
    multipartThresholdBytes: 16,
    multipartPartSizeBytes: 257,
    multipartConcurrency: 4,
    timeoutMs: 5000,
    onProgress: (progress) => multipartProgress.push(progress)
  });
  const multipartContent = await fs.readFile(multipartDest);
  assert(Buffer.compare(multipartContent, multipartBytes) === 0, 'multipart range download bytes did not match source');
  assert(rangeHits > 2, `multipart range endpoint was not split into parallel chunks: ${rangeHits}`);
  assert(multipartProgress.some((event) => event.method === 'multipart-range' && event.percent === 100), `multipart progress was not reported: ${JSON.stringify(multipartProgress)}`);
  const fallbackProgress = [];
  await downloadToFile(`http://127.0.0.1:${port}/no-range.zip`, fallbackDest, {
    multipart: true,
    multipartThresholdBytes: 16,
    multipartPartSizeBytes: 10,
    multipartConcurrency: 3,
    timeoutMs: 5000,
    onProgress: (progress) => fallbackProgress.push(progress)
  });
  const fallbackContent = await fs.readFile(fallbackDest);
  assert(Buffer.compare(fallbackContent, fallbackBytes) === 0, 'fallback stream download bytes did not match source');
  assert(ignoredRangeHits >= 2, `fallback endpoint should have been probed and then streamed: ${ignoredRangeHits}`);
  assert(!fallbackProgress.some((event) => event.method === 'multipart-range'), 'fallback stream was incorrectly reported as multipart');
  const brokenRangeLogs = [];
  await downloadToFile(`http://127.0.0.1:${port}/broken-range.zip`, brokenRangeFallbackDest, {
    multipart: true,
    multipartThresholdBytes: 16,
    multipartPartSizeBytes: 10,
    multipartConcurrency: 3,
    timeoutMs: 5000,
    logger: { log: (line) => brokenRangeLogs.push(String(line)) }
  });
  const brokenRangeContent = await fs.readFile(brokenRangeFallbackDest);
  assert(Buffer.compare(brokenRangeContent, brokenRangeBytes) === 0, 'broken range fallback bytes did not match source');
  assert(brokenRangeHits >= 2, `broken range endpoint did not attempt probe plus a chunk: ${brokenRangeHits}`);
  assert(brokenRangeStreamHits === 1, `broken range endpoint did not fall back to one full stream: ${brokenRangeStreamHits}`);
  assert(brokenRangeLogs.some((line) => line.includes('falling back to single stream')), `broken range fallback was not logged: ${brokenRangeLogs.join('\n')}`);
  const leftovers = (await fs.readdir(root)).filter((name) => name.endsWith('.download'));
  assert(leftovers.length === 0, `temporary download files were left behind: ${leftovers.join(', ')}`);
  console.log(JSON.stringify({ ok: true, root, hits, forbiddenHits, rangeHits, ignoredRangeHits, brokenRangeHits, brokenRangeStreamHits, content }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
