import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installPhoenixAntiCheat, phoenixAntiCheatStatus } from '../src/nativeGuard.js';

const bytes = Buffer.from('verified non-executed lifecycle fixture');
const descriptor = { product: 'phoenix-anticheat', platform: 'win32-x64', version: '1.2.3', protocol: 'AHT-GUARD-1',
  fileName: 'Phoenix-Anti-cheat-Windows-x64-1.2.3.exe', path: 'launcher/anticheat/win32-x64/Phoenix-Anti-cheat-Windows-x64-1.2.3.exe',
  url: 'https://fixture.invalid/launcher/anticheat/win32-x64/Phoenix-Anti-cheat-Windows-x64-1.2.3.exe',
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

async function fixture(t) {
  const installDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phoenix-install-lifecycle-'));
  t.after(() => fs.rm(installDir, { recursive: true, force: true }));
  return { installDir, descriptor, platform: 'win32', fetchImpl: async () => new Response(bytes) };
}

test('reinstalling an already verified helper is offline and leaves its executable untouched', async t => {
  const options = await fixture(t);
  const first = await installPhoenixAntiCheat(options);
  const before = await fs.stat(first.binaryPath);
  const second = await installPhoenixAntiCheat({ ...options, fetchImpl: async () => { throw new Error('No download is needed'); } });
  assert.equal(second.valid, true); assert.equal((await fs.stat(first.binaryPath)).mtimeMs, before.mtimeMs);
});

test('a missing receipt can be reconstructed from the exact trusted bytes after explicit consent', async t => {
  const options = await fixture(t);
  await installPhoenixAntiCheat(options);
  await fs.rm(path.join(options.installDir, 'installed.json'));
  const repaired = await installPhoenixAntiCheat({ ...options, fetchImpl: async () => { throw new Error('Verified bytes must be reused'); } });
  assert.equal(repaired.valid, true);
  assert.equal((await phoenixAntiCheatStatus(options)).valid, true);
});

test('a progress observer failure cannot fail an otherwise verified installation', async t => {
  const options = await fixture(t);
  const result = await installPhoenixAntiCheat({ ...options, onProgress: () => { throw new Error('Window was destroyed'); } });
  assert.equal(result.valid, true);
  assert.equal((await phoenixAntiCheatStatus(options)).valid, true);
});

test('a stalled download adapter cannot leave installation pending beyond its deadline', async t => {
  const options = await fixture(t);
  let lateResponse;
  const download = new Promise(resolve => { lateResponse = resolve; });
  const installation = installPhoenixAntiCheat({ ...options, timeoutMs: 25, fetchImpl: () => download });
  let timer;
  try {
    await assert.rejects(Promise.race([installation,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Deadline did not settle installation')), 500); })
    ]), { code: 'PHOENIX_DOWNLOAD_FAILED' });
  } finally { clearTimeout(timer); lateResponse(new Response(bytes)); await installation.catch(() => {}); }
  await assert.rejects(fs.access(path.join(options.installDir, 'installed.json')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(options.installDir), []);
});

test('a stalled body and cancellation adapter cannot hold the temporary file open forever', async t => {
  const options = await fixture(t);
  let finishRead, finishCancel;
  const reading = new Promise(resolve => { finishRead = resolve; });
  const cancelling = new Promise(resolve => { finishCancel = resolve; });
  const response = { ok: true, headers: new Headers(), body: { getReader: () => ({
    read: () => reading, cancel: () => cancelling
  }) } };
  const installation = installPhoenixAntiCheat({ ...options, timeoutMs: 25, fetchImpl: async () => response });
  let timer;
  try {
    await assert.rejects(Promise.race([installation,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Body deadline did not settle')), 500); })
    ]), { code: 'PHOENIX_DOWNLOAD_FAILED' });
  } finally { clearTimeout(timer); finishRead({ done: true }); finishCancel(); await installation.catch(() => {}); }
  assert.deepEqual(await fs.readdir(options.installDir), []);
});
