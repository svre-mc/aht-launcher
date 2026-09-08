import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  installPhoenixAntiCheat,
  phoenixAntiCheatStatus,
  validatePhoenixAntiCheatRelease
} from '../src/nativeGuard.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-phoenix-anticheat-'));
const installDir = path.join(root, 'installed');
const bytes = Buffer.from('separate opt-in Phoenix Anti-cheat test executable');
const descriptor = {
  product: 'phoenix-anticheat',
  version: '1.0.0',
  protocol: 'AHT-GUARD-1',
  platform: 'win32-x64',
  fileName: 'Phoenix-Anti-cheat-Windows-x64-1.0.0.exe',
  path: 'launcher/anticheat/win32-x64/Phoenix-Anti-cheat-Windows-x64-1.0.0.exe',
  url: 'https://downloads.example.test/launcher/anticheat/win32-x64/Phoenix-Anti-cheat-Windows-x64-1.0.0.exe',
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length
};
const progress = [];
const fetchImpl = async () => new Response(bytes, {
  status: 200,
  headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'application/vnd.microsoft.portable-executable' }
});

try {
  assert.equal(validatePhoenixAntiCheatRelease(descriptor).version, '1.0.0');
  const missing = await phoenixAntiCheatStatus({ installDir, platform: 'win32' });
  assert.equal(missing.state, 'missing');

  const installed = await installPhoenixAntiCheat({
    installDir,
    descriptor,
    fetchImpl,
    platform: 'win32',
    consentAcceptedAt: '2026-09-08T12:00:00.000Z',
    onProgress: (entry) => progress.push(entry)
  });
  assert.equal(installed.state, 'ready');
  assert.equal(progress.at(-1)?.percent, 100);
  const ready = await phoenixAntiCheatStatus({ installDir, platform: 'win32' });
  assert.equal(ready.valid, true);
  assert.equal(ready.consentAcceptedAt, '2026-09-08T12:00:00.000Z');
  const upgradeRequired = await phoenixAntiCheatStatus({ installDir, platform: 'win32', requiredVersion: '1.0.1' });
  assert.equal(upgradeRequired.state, 'update-required');
  assert.equal(upgradeRequired.valid, false);

  const statePath = path.join(installDir, 'installed.json');
  const receipt = JSON.parse(await fs.readFile(statePath, 'utf8'));
  await fs.writeFile(statePath, `${JSON.stringify({ ...receipt, product: 'untrusted-component' }, null, 2)}\n`, 'utf8');
  const wrongProduct = await phoenixAntiCheatStatus({ installDir, platform: 'win32' });
  assert.equal(wrongProduct.state, 'repair-required');
  await fs.writeFile(statePath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  await fs.appendFile(ready.binaryPath, 'tampered');
  const tampered = await phoenixAntiCheatStatus({ installDir, platform: 'win32' });
  assert.equal(tampered.state, 'repair-required');

  const rejectedDir = path.join(root, 'rejected');
  await assert.rejects(
    () => installPhoenixAntiCheat({
      installDir: rejectedDir,
      descriptor: { ...descriptor, sha256: '0'.repeat(64) },
      fetchImpl,
      platform: 'win32'
    }),
    /verification/i
  );
  const rejectedFiles = await fs.readdir(rejectedDir);
  assert(!rejectedFiles.some((name) => name.endsWith('.tmp')), 'A failed verified download must not leave a partial executable');
  assert.equal((await phoenixAntiCheatStatus({ installDir: rejectedDir, platform: 'win32' })).installed, false);
  assert.equal((await phoenixAntiCheatStatus({ installDir, platform: 'linux' })).required, false);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'explicit consent receipt persisted',
      'exact size and SHA-256 enforced',
      'component identity is enforced',
      'tampering requires repair',
      'failed download removed atomically',
      'non-Windows platforms are unaffected'
    ]
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
