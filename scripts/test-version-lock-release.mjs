import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildRelease } from '../src/releaseBuilder.js';
import { isVersionLockJarPath } from '../src/versionLockJar.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-version-lock-release-'));
const names = ['aht-version-lock-1.1.1.jar', 'AHT Version Lock-1.1.1.jar'];
const bytes = process.argv[2] ? await fs.readFile(process.argv[2]) : Buffer.from('runtime lock fixture');
let releases = 0;
try {
  for (const name of names) {
    assert(isVersionLockJarPath(`mods/${name}`));
    assert(isVersionLockJarPath(`mods\\${name}`));
    for (const suffix of ['sources', 'javadoc', 'dev', 'deobf']) {
      assert(!isVersionLockJarPath(name.replace('.jar', `-${suffix}.jar`)));
    }
  }
  for (const name of ['unrelated.jar', 'fake-aht-version-lock-1.1.1.jar', 'aht-version-lock-.jar', '']) {
    assert(!isVersionLockJarPath(name));
  }
  const helper = path.join(root, 'aht-version-lock-99.0.jar');
  await fs.writeFile(helper, 'fallback must not be injected beside an existing lock');
  for (const name of names) {
    for (const format of ['full', 'wrapped', 'legacy']) {
      const prefix = format === 'wrapped' ? 'A Hard Time Client/' : format === 'legacy' ? 'overrides/' : '';
      const metadata = { name: 'Version Lock Test', version: '2.8.999',
        minecraft: {version: '1.12.2', modLoaders: [{id: 'forge-14.23.5.2860', primary: true}]} };
      const zip = new AdmZip();
      if (format === 'legacy') {
        zip.addFile('manifest.json', Buffer.from(JSON.stringify({...metadata, manifestType: 'minecraftModpack',
          manifestVersion: 1, overrides: 'overrides', files: []})));
      } else {
        zip.addFile(`${prefix}aht-client-pack.json`, Buffer.from(JSON.stringify({...metadata, format: 'aht-full-client-zip'})));
      }
      zip.addFile(`${prefix}mods/${name}`, bytes);
      const packZip = path.join(root, `pack-${releases}.zip`);
      zip.writeZip(packZip);
      const outDir = path.join(root, `release-${releases}`);
      const release = await buildRelease({packZip, outDir, versionLockJar: helper});
      const expected = format === 'legacy' ? `overrides/mods/${name}` : `mods/${name}`;
      assert.equal(release.latest.serverLock.clientModPath, expected, `${format}: ${name}`);
      assert.equal(release.latest.serverLock.injected, false, 'Existing lock must not cause duplicate injection');
      const built = new AdmZip(path.join(outDir, release.latest.zip.path));
      const locks = built.getEntries().filter(entry => !entry.isDirectory && isVersionLockJarPath(entry.entryName));
      assert.equal(locks.length, 1, 'Release must contain exactly one runtime lock');
      assert.deepEqual(locks[0].getData(), bytes, 'Existing runtime lock bytes must be preserved');
      releases++;
    }
  }
  console.log(JSON.stringify({ok: true, releases, namingStyles: names, duplicateInjection: false}));
} finally {
  await fs.rm(root, {recursive: true, force: true});
}
