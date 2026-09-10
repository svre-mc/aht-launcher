import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { installPhoenixAntiCheat, phoenixAntiCheatStatus, withPhoenixRecovery, rememberPhoenixConsent, phoenixReleaseFromManifest } from '../src/nativeGuard.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-phoenix-recovery-'));
const installDir = path.join(root, 'Phoenix Anti-cheat');
const consentFile = path.join(root, 'phoenix-consent.json');
const bytes = Buffer.from('verified test Phoenix executable');
const fileName = 'Phoenix-Anti-cheat-Windows-x64-1.1.2.exe';
const descriptor = { product: 'phoenix-anticheat', platform: 'win32-x64', version: '1.1.2', protocol: 'AHT-GUARD-1',
  fileName, path: `launcher/anticheat/win32-x64/${fileName}`, url: `https://aht.test/launcher/anticheat/win32-x64/${fileName}`,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
const options = { installDir, consentFile, platform: 'win32' };
const consentAcceptedAt = '2026-09-10T12:00:00.000Z';
const fetchImpl = async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
try {
  const installed = await installPhoenixAntiCheat({ ...options, descriptor, consentAcceptedAt, fetchImpl });
  await fs.rm(installed.binaryPath);
  const missing = await phoenixAntiCheatStatus(options);
  assert.equal(missing.valid, false);
  assert.equal(missing.consented, true, 'Deleting the executable must not erase prior consent or disable recovery');
  assert.equal(missing.consentAcceptedAt, consentAcceptedAt);
  let downloads = 0;
  const install = (accepted) => installPhoenixAntiCheat({ ...options, descriptor, consentAcceptedAt: accepted,
    fetchImpl: async (...args) => { downloads++; return fetchImpl(...args); } });
  const getStatus = () => phoenixAntiCheatStatus(options);
  const start = async () => { assert.equal((await getStatus()).valid, true); return 'started'; };
  assert.equal(await withPhoenixRecovery({ getStatus, install, start }), 'started');
  assert.equal(downloads, 1);
  // A full component-folder removal must retain the separately stored receipt.
  await fs.rm(installDir, { recursive: true, force: true });
  assert.equal(await withPhoenixRecovery({ getStatus, install, start }), 'started');
  assert.equal(downloads, 2);
  // A damaged receipt or binary remains recoverable, but never treated as ready.
  await fs.writeFile(path.join(installDir, 'installed.json'), 'broken');
  assert.equal((await getStatus()).consented, true);
  assert.equal(await withPhoenixRecovery({ getStatus, install, start }), 'started');
  const good = await getStatus();
  await fs.writeFile(good.binaryPath, 'corrupt');
  assert.equal(await withPhoenixRecovery({ getStatus, install, start }), 'started');
  const repaired = await getStatus();
  assert.deepEqual(await fs.readFile(repaired.binaryPath), bytes);
  // Removal between UI readiness and native startup is recovered only once.
  let starts = 0;
  assert.equal(await withPhoenixRecovery({ getStatus, install, start: async () => {
    if (++starts === 1) { await fs.rm(repaired.binaryPath); throw Object.assign(new Error('removed'), { code: 'ENOENT' }); }
    return start();
  } }), 'started');
  assert.equal(starts, 2);
  let unconsentedInstalls = 0;
  await assert.rejects(withPhoenixRecovery({ getStatus: async () => ({ required: true, valid: false, consented: false }),
    install: async () => { unconsentedInstalls++; }, start: async () => { throw Object.assign(new Error('consent required'), { code: 'PHOENIX_ANTICHEAT_REQUIRED' }); } }));
  assert.equal(unconsentedInstalls, 0);
  let repeatedInstalls = 0;
  await assert.rejects(withPhoenixRecovery({ getStatus: async () => ({ required: true, valid: false, consented: true, consentAcceptedAt }),
    install: async () => { repeatedInstalls++; }, start: async () => { throw Object.assign(new Error('blocked'), { code: 'ENOENT' }); } }));
  assert.equal(repeatedInstalls, 1, 'Repeated removal must not create a reinstall loop');
  // A failed replacement never removes previously verified bytes or metadata.
  await assert.rejects(installPhoenixAntiCheat({ ...options, descriptor: { ...descriptor, sha256: '0'.repeat(64) }, fetchImpl }), /verification/i);
  assert.equal((await getStatus()).valid, true);
  let streamCancelled = false;
  const progress = [];
  await assert.rejects(installPhoenixAntiCheat({ ...options, descriptor, timeoutMs: 35, onProgress: p => progress.push(p),
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { streamCancelled = true; } })) }), /timed out/i);
  assert.equal(streamCancelled, true);
  assert(!progress.some(p => p.percent === 100));
  assert.equal((await getStatus()).valid, true);
  assert(!(await fs.readdir(installDir)).some(name => name.endsWith('.tmp')));
  // Legacy consent can migrate; component metadata cannot redefine the expected hash.
  await rememberPhoenixConsent(consentFile, await getStatus());
  assert.equal((await phoenixAntiCheatStatus({ ...options, expectedHash: '0'.repeat(64) })).valid, false);
  const pinned = phoenixReleaseFromManifest({ schema: 1, product: descriptor.product, version: descriptor.version,
    protocol: descriptor.protocol, file: 'Phoenix Anti-cheat.exe', bytes: bytes.length, sha256: descriptor.sha256 }, 'https://aht.test', '1.1.2');
  assert.deepEqual(pinned, descriptor);
  assert.throws(() => phoenixReleaseFromManifest({ version: '9.9.9' }, 'https://aht.test', '1.1.2'));
  console.log(JSON.stringify({ ok: true, cases: ['deleted executable', 'deleted component folder', 'corrupt metadata', 'corrupt executable',
    'startup deletion race', 'consent retained', 'no consent bypass', 'no recovery loop', 'failed replacement preserves install',
    'stalled download timeout', 'partial cleanup', 'no premature 100 percent', 'package-pinned recovery identity'] }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
