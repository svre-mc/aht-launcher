import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanLocalChanges, scanManagedIntegrity } from '../src/localChanges.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-mod-only-changes-'));
const instanceDir = path.join(root, 'instance');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

const expected = Buffer.from('expected\n');
const edited = Buffer.from('edited\n');

await write(path.join(instanceDir, '.aht-launcher', 'managed-files.json'), JSON.stringify([
  { relativePath: 'mods/changed.jar', source: 'curseforge', sha256: sha256(expected) },
  { relativePath: 'mods/missing.jar', source: 'curseforge', sha256: sha256(expected) },
  { relativePath: 'config/changed.cfg', source: 'overrides', sha256: sha256(expected) },
  { relativePath: 'scripts/missing.zs', source: 'overrides', sha256: sha256(expected) }
], null, 2));

await write(path.join(instanceDir, 'mods', 'changed.jar'), edited);
await write(path.join(instanceDir, 'mods', 'local-added.jar'), Buffer.from('local mod\n'));
await write(path.join(instanceDir, 'mods', 'OpenTerrainGenerator', 'cache', 'runtime-cache.dat'), Buffer.from('runtime cache\n'));
await write(path.join(instanceDir, 'config', 'changed.cfg'), edited);
await write(path.join(instanceDir, 'config', 'local-added.cfg'), Buffer.from('local config\n'));
await write(path.join(instanceDir, 'shaderpacks', 'local.zip'), Buffer.from('local shaderpack\n'));

const changes = await scanLocalChanges(instanceDir);
const integrity = await scanManagedIntegrity(instanceDir);

const changedPaths = changes.changed.map((item) => item.path).sort();
const missingPaths = changes.missing.map((item) => item.path).sort();
const addedPaths = changes.added.map((item) => item.path).sort();

if (JSON.stringify(changedPaths) !== JSON.stringify(['mods/changed.jar'])) {
  throw new Error(`Changed paths should be mod-only: ${JSON.stringify(changedPaths)}`);
}
if (JSON.stringify(missingPaths) !== JSON.stringify(['mods/missing.jar'])) {
  throw new Error(`Missing paths should be mod-only: ${JSON.stringify(missingPaths)}`);
}
if (JSON.stringify(addedPaths) !== JSON.stringify(['mods/local-added.jar'])) {
  throw new Error(`Added paths should be mod-only: ${JSON.stringify(addedPaths)}`);
}
if (changes.added.some((item) => /openterraingenerator/i.test(item.path)) || integrity.added.some((item) => /openterraingenerator/i.test(item.path))) {
  throw new Error(`OpenTerrainGenerator runtime folder should be ignored by change scans: ${JSON.stringify({ changes: changes.added, integrity: integrity.added })}`);
}
if (changes.counts.managed !== 2 || changes.counts.changed !== 1 || changes.counts.missing !== 1 || changes.counts.added !== 1) {
  throw new Error(`Unexpected local-change counts: ${JSON.stringify(changes.counts)}`);
}
if (
  integrity.counts.managed !== 2
  || integrity.counts.changed !== 1
  || integrity.counts.missing !== 1
  || integrity.counts.added !== 1
  || integrity.counts.corrupted !== 3
  || integrity.changed[0]?.path !== 'mods/changed.jar'
  || integrity.missing[0]?.path !== 'mods/missing.jar'
  || integrity.added[0]?.path !== 'mods/local-added.jar'
) {
  throw new Error(`Unexpected integrity scan: ${JSON.stringify(integrity)}`);
}

console.log(JSON.stringify({
  ok: true,
  root,
  changes: {
    counts: changes.counts,
    changedPaths,
    missingPaths,
    addedPaths
  },
  integrity: {
    counts: integrity.counts,
    changed: integrity.changed.map((item) => item.path),
    missing: integrity.missing.map((item) => item.path),
    added: integrity.added.map((item) => item.path)
  }
}, null, 2));
