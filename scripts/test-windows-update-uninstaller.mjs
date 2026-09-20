import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import finalize from '../build/windows-update-uninstaller.cjs';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-update-uninstaller-'));
try {
  const archive = path.join(root, 'update.zip'), executable = path.join(root, 'uninstaller.exe');
  const zip = new AdmZip(); zip.addFile('A Hard Time Launcher Windows.exe', Buffer.from('unchanged launcher'));
  zip.addFile('resources/app.asar', Buffer.from('unchanged application')); zip.writeZip(archive);
  const bytes = Buffer.alloc(2048); bytes.write('MZ'); bytes.write('new uninstaller fixture', 50);
  await fs.writeFile(executable, bytes);
  await finalize.addUninstallerToUpdate(archive, executable);
  const result = new AdmZip(archive);
  assert.deepEqual(result.readFile('Uninstall A Hard Time Launcher Windows.exe'), bytes);
  assert.equal(result.readAsText('A Hard Time Launcher Windows.exe'), 'unchanged launcher');
  assert.equal(result.readAsText('resources/app.asar'), 'unchanged application');
  await fs.writeFile(executable, 'not an executable');
  await assert.rejects(() => finalize.addUninstallerToUpdate(archive, executable), /generated NSIS uninstaller/);
  await assert.rejects(() => finalize({ artifactPaths: ['AHT-Launcher-Windows-10-11-1.2.3.zip'] }), /both NSIS and ZIP/);
  console.log('PASS: exact generated uninstaller delivered in ZIP; application bytes preserved; incomplete builds rejected.');
} finally {
  assert(path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('aht-update-uninstaller-'));
  await fs.rm(root, { recursive: true, force: true });
}
