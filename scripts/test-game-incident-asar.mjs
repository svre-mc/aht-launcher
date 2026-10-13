import { createPackage } from '@electron/asar';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-incident-asar-'));
try {
  const source = path.join(root, 'runtime'); await fs.mkdir(source);
  for (const file of ['desktop/game-diagnostics-worker.mjs', 'src/gameIncidentMonitor.js', 'src/gameIncidentContract.js',
    'src/serviceTransport.js', 'src/boundedJson.js']) {
    const target = path.join(source, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(file, target);
  }
  await fs.writeFile(path.join(source, 'package.json'), '{"type":"module"}');
  const archive = path.join(root, 'app.asar'); await createPackage(source, archive);
  const result = spawnSync(process.execPath, ['scripts/test-game-incident-worker-lifecycle.mjs'], {
    windowsHide: true, stdio: 'inherit', timeout: 25000,
    env: { ...process.env, AHT_DIAG_HELPER_SCRIPT: path.join(archive, 'desktop/game-diagnostics-worker.mjs') } });
  if (result.status !== 0 || result.error) throw new Error('Packaged ASAR helper failed');
  console.log('PASS: actual Electron Node runtime loads the reporting helper and imports from app.asar.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
