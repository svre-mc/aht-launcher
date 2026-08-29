import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanManagedIntegrity } from '../src/localChanges.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-cache-extra-integrity-'));
const instanceDir = path.join(root, 'instance');
const expected = Buffer.from('expected jar\n');
const oldManaged = Buffer.from('old managed jar\n');
const managedConfig = Buffer.from('managed=true\n');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

await fsp.mkdir(path.join(instanceDir, 'mods'), { recursive: true });
await fsp.mkdir(path.join(instanceDir, 'config'), { recursive: true });
await fsp.mkdir(path.join(instanceDir, '.aht-launcher'), { recursive: true });
await fsp.writeFile(path.join(instanceDir, 'mods', 'old-managed.jar'), oldManaged);
await fsp.writeFile(path.join(instanceDir, 'config', 'managed.cfg'), managedConfig);
await fsp.writeFile(path.join(instanceDir, '.aht-launcher', 'managed-files.json'), JSON.stringify([
  {
    relativePath: 'mods/old-managed.jar',
    source: 'curseforge',
    sha256: sha256(oldManaged)
  },
  {
    relativePath: 'config/managed.cfg',
    source: 'full-client-zip',
    sha256: sha256(managedConfig)
  }
], null, 2));

const missingScan = await scanManagedIntegrity(instanceDir, {
  requiredManaged: [
    {
      relativePath: 'mods/private-extra.jar',
      source: 'cache-extra',
      sha256: sha256(expected)
    }
  ]
});
if (missingScan.valid || missingScan.counts.corrupted !== 1 || missingScan.missing[0]?.path !== 'mods/private-extra.jar') {
  throw new Error(`Missing cache extra was not treated as corrupted: ${JSON.stringify(missingScan)}`);
}

await fsp.writeFile(path.join(instanceDir, 'mods', 'private-extra.jar'), Buffer.from('wrong jar\n'));
const changedScan = await scanManagedIntegrity(instanceDir, {
  requiredManaged: [
    {
      relativePath: 'mods/private-extra.jar',
      source: 'cache-extra',
      sha256: sha256(expected)
    }
  ]
});
if (changedScan.valid || changedScan.counts.corrupted !== 1 || changedScan.changed[0]?.path !== 'mods/private-extra.jar') {
  throw new Error(`Changed cache extra was not treated as corrupted: ${JSON.stringify(changedScan)}`);
}

await fsp.writeFile(path.join(instanceDir, 'mods', 'private-extra.jar'), expected);
const cleanScan = await scanManagedIntegrity(instanceDir, {
  requiredManaged: [
    {
      relativePath: 'mods/private-extra.jar',
      source: 'cache-extra',
      sha256: sha256(expected)
    }
  ]
});
if (!cleanScan.valid || cleanScan.counts.corrupted !== 0 || cleanScan.counts.managed !== 3) {
  throw new Error(`Expected clean scan after cache extra repair: ${JSON.stringify(cleanScan)}`);
}

await fsp.rm(path.join(instanceDir, 'config', 'managed.cfg'));
const missingConfigScan = await scanManagedIntegrity(instanceDir, {
  requiredManaged: [
    {
      relativePath: 'mods/private-extra.jar',
      source: 'cache-extra',
      sha256: sha256(expected)
    }
  ]
});
if (missingConfigScan.valid || missingConfigScan.counts.corrupted !== 1 || missingConfigScan.missing[0]?.path !== 'config/managed.cfg') {
  throw new Error(`Missing managed config was not treated as corrupted: ${JSON.stringify(missingConfigScan)}`);
}

await fsp.writeFile(path.join(instanceDir, 'config', 'managed.cfg'), Buffer.from('changed=true\n'));
const changedConfigScan = await scanManagedIntegrity(instanceDir, {
  requiredManaged: [
    {
      relativePath: 'mods/private-extra.jar',
      source: 'cache-extra',
      sha256: sha256(expected)
    }
  ]
});
if (changedConfigScan.valid || changedConfigScan.counts.corrupted !== 1 || changedConfigScan.changed[0]?.path !== 'config/managed.cfg') {
  throw new Error(`Changed managed config was not treated as corrupted: ${JSON.stringify(changedConfigScan)}`);
}

console.log(JSON.stringify({
  ok: true,
  root,
  missing: missingScan.missing.map((item) => item.path),
  changed: changedScan.changed.map((item) => item.path),
  missingConfig: missingConfigScan.missing.map((item) => item.path),
  changedConfig: changedConfigScan.changed.map((item) => item.path),
  clean: cleanScan.counts
}, null, 2));
