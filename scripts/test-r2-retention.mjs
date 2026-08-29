import assert from 'node:assert/strict';
import { extractReferencedKeys, planR2Retention } from './r2-retention.mjs';

const MiB = 1024 * 1024;
const baseUrl = 'https://releases.example.test';

function object(key, size = MiB, day = '2026-08-20T00:00:00Z') {
  return { key, size, etag: `etag-${key}`, last_modified: day };
}

function manifests() {
  return {
    'latest.json': {
      version: '2.8.534',
      zip: { path: 'packs/a-hard-time-dregora-2.8.534.zip', url: `${baseUrl}/packs/a-hard-time-dregora-2.8.534.zip` },
      serverLock: { configPath: 'server/aht_version_lock.cfg' }
    },
    'ptb/latest.json': {
      version: '2.8.6',
      zip: { path: 'packs/a-hard-time-ptb-2.8.6.zip', url: `${baseUrl}/ptb/packs/a-hard-time-ptb-2.8.6.zip` },
      clientManifest: { path: 'manifests/a-hard-time-ptb-2.8.6.json' },
      delta: { path: 'patches/a-hard-time-ptb-2.8.61-to-2.8.6.zip' }
    },
    'launcher/latest.json': {
      version: '0.1.87',
      downloads: {
        windows: { path: 'launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.87.exe' }
      }
    }
  };
}

function inventory() {
  return [
    object('latest.json', 100),
    object('ptb/latest.json', 100),
    object('launcher/latest.json', 100),
    object('server/aht_version_lock.cfg', 100),
    object('packs/a-hard-time-dregora-2.8.534.zip', 700 * MiB, '2026-08-20T00:00:00Z'),
    object('packs/a-hard-time-dregora-2.8.533.zip', 700 * MiB, '2026-08-19T00:00:00Z'),
    object('packs/a-hard-time-dregora-2.8.532.zip', 700 * MiB, '2026-08-18T00:00:00Z'),
    object('ptb/packs/a-hard-time-ptb-2.8.6.zip', 1000 * MiB, '2026-08-20T00:00:00Z'),
    object('ptb/packs/a-hard-time-ptb-2.8.61.zip', 1000 * MiB, '2026-08-19T00:00:00Z'),
    object('ptb/manifests/a-hard-time-ptb-2.8.6.json', 100),
    object('ptb/patches/a-hard-time-ptb-2.8.61-to-2.8.6.zip', 0),
    object('launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.87.exe', 100 * MiB, '2026-08-20T00:00:00Z'),
    object('launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.86.exe', 100 * MiB, '2026-08-19T00:00:00Z'),
    object('launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.85.exe', 100 * MiB, '2026-08-18T00:00:00Z'),
    object('launcher/files/win32-x64/AHT-Launcher-Windows-10-11-9.9.9.exe', 100 * MiB, '2026-08-28T00:00:00Z'),
    object('launcher/files/linux-x64/AHT-Launcher-Ubuntu-0.1.18-x64.AppImage', 100 * MiB, '2026-07-01T00:00:00Z'),
    object('client-zips/a-hard-time-2.8.534.zip', 700 * MiB),
    object('cache/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jar', 4 * MiB)
  ];
}

const refs = extractReferencedKeys(manifests(), baseUrl);
assert(refs.has('ptb/packs/a-hard-time-ptb-2.8.6.zip'));
assert(refs.has('ptb/manifests/a-hard-time-ptb-2.8.6.json'));
assert(refs.has('server/aht_version_lock.cfg'));

const plan = planR2Retention({ inventory: inventory(), manifests: manifests(), baseUrl });
const deleted = new Set(plan.deleteObjects.map((item) => item.key));
assert(deleted.has('launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.85.exe'));
assert(deleted.has('launcher/files/win32-x64/AHT-Launcher-Windows-10-11-9.9.9.exe'));
assert(deleted.has('launcher/files/linux-x64/AHT-Launcher-Ubuntu-0.1.18-x64.AppImage'));
assert(deleted.has('client-zips/a-hard-time-2.8.534.zip'));
assert(deleted.has('packs/a-hard-time-dregora-2.8.532.zip'));
assert(!deleted.has('launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.87.exe'));
assert(!deleted.has('launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.86.exe'));
assert(!deleted.has('packs/a-hard-time-dregora-2.8.533.zip'));
assert(!deleted.has('ptb/packs/a-hard-time-ptb-2.8.61.zip'));
assert(!deleted.has('cache/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jar'));
assert.equal(plan.versions.launcher.rollback, '0.1.86');
assert.equal(plan.versions.stable.rollback, '2.8.533');
assert.equal(plan.versions.ptb.rollback, '2.8.61');

assert.throws(() => planR2Retention({
  inventory: inventory().filter((item) => item.key !== 'packs/a-hard-time-dregora-2.8.534.zip'),
  manifests: manifests(),
  baseUrl
}), /missing from R2 inventory/);

assert.throws(() => planR2Retention({
  inventory: [...inventory(), object('launcher/files/win32-x64/unversioned.exe')],
  manifests: manifests(),
  baseUrl
}), /versionless launcher object/);

assert.throws(() => planR2Retention({
  inventory: inventory(),
  manifests: manifests(),
  baseUrl,
  maxRetainedBytes: 1
}), /above the 1-byte safety target/);

console.log(JSON.stringify({ ok: true, tests: 17, deleted: plan.deleteObjects.length }, null, 2));
