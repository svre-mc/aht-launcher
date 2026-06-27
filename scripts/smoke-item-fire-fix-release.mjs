import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildRelease } from '../src/releaseBuilder.js';

async function createPackZip({ target, minecraftVersion, loaderId, version }) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: `AHT Smoke ${minecraftVersion}`,
    version,
    author: 'AHT',
    files: [],
    overrides: 'overrides',
    minecraft: {
      version: minecraftVersion,
      modLoaders: [{ id: loaderId, primary: true }]
    }
  }, null, 2)));
  zip.addFile('overrides/config/smoke.txt', Buffer.from('ok\n'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  zip.writeZip(target);
}

function zipEntries(zipPath) {
  return new AdmZip(zipPath).getEntries().map((entry) => entry.entryName.replaceAll('\\', '/'));
}

async function assertInjected({ minecraftVersion, loaderId, version, expectedPattern }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-item-fire-fix-release-'));
  const packZip = path.join(tmp, `pack-${version}.zip`);
  const outDir = path.join(tmp, 'out');
  await createPackZip({ target: packZip, minecraftVersion, loaderId, version });

  const result = await buildRelease({
    packZip,
    outDir,
    baseUrl: 'https://example.test/releases'
  });
  const builtZip = path.join(outDir, result.latest.zip.path);
  const entries = zipEntries(builtZip);
  const injectedEntry = entries.find((entry) => expectedPattern.test(entry));
  if (!injectedEntry) {
    throw new Error(`Missing injected item fire fix in ${builtZip}`);
  }
  if (result.latest.itemFireFix?.clientModPath !== injectedEntry) {
    throw new Error(`latest.json itemFireFix path mismatch: ${result.latest.itemFireFix?.clientModPath}`);
  }
  if (!result.latest.itemFireFix?.injected) {
    throw new Error('latest.json itemFireFix.injected was not true');
  }
  return {
    minecraftVersion,
    loaderId,
    injectedEntry,
    zipPath: builtZip
  };
}

const forge = await assertInjected({
  minecraftVersion: '1.12.2',
  loaderId: 'forge-14.23.5.2860',
  version: '2.8.2',
  expectedPattern: /^overrides\/mods\/aht-item-fire-fix-forge-.*\.jar$/i
});

const fabric = await assertInjected({
  minecraftVersion: '26.1.2',
  loaderId: 'fabric-0.19.2-26.1.2',
  version: '3.0.0',
  expectedPattern: /^overrides\/mods\/aht-item-fire-fix-fabric-.*\.jar$/i
});

console.log(JSON.stringify({ ok: true, forge, fabric }, null, 2));
