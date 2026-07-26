import fs from 'node:fs';
import fsp from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { collectServerTransferFiles, uploadServerFiles } from '../src/serverTransfer.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-server-transfer-plan-'));
const source = path.join(root, 'New folder - Copy');

await fsp.mkdir(path.join(source, 'mods'), { recursive: true });
await fsp.mkdir(path.join(source, 'config'), { recursive: true });
await fsp.mkdir(path.join(source, 'DregoraRL', 'region'), { recursive: true });
await fsp.writeFile(path.join(source, 'server.properties'), 'motd=AHT\n', 'utf8');
await fsp.writeFile(path.join(source, 'mods', 'example.jar'), 'jar\n', 'utf8');
await fsp.writeFile(path.join(source, 'config', 'example.cfg'), 'cfg\n', 'utf8');
await fsp.writeFile(path.join(source, 'DregoraRL', 'level.dat'), 'world\n', 'utf8');
await fsp.writeFile(path.join(source, 'DregoraRL', 'region', 'r.0.0.mca'), 'region\n', 'utf8');

const plan = await collectServerTransferFiles(source, { excludeDirs: ['DregoraRL'] });
const files = plan.files.map((file) => file.relativePath);
if (files.some((file) => file.toLowerCase().includes('dregorarl'))) {
  throw new Error(`DregoraRL files were included in server transfer plan: ${JSON.stringify(files)}`);
}
for (const expected of ['server.properties', 'mods/example.jar', 'config/example.cfg']) {
  if (!files.includes(expected)) {
    throw new Error(`Expected ${expected} in transfer plan: ${JSON.stringify(files)}`);
  }
}
if (!plan.excludedDirs.includes('DregoraRL')) {
  throw new Error(`DregoraRL exclusion was not reported: ${JSON.stringify(plan)}`);
}

const renderer = fs.readFileSync(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const main = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const transferSource = fs.readFileSync(new URL('../src/serverTransfer.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
if (!main.includes("return normalized.split(/[\\\\/]/).pop() || '';") || !main.includes('remoteDir: serverTransferDestinationDir(remoteParentDir, sourceDir)')) {
  throw new Error('Developer server upload must derive the remote child folder from the exact selected source folder name.');
}
if (!main.includes("path.join(sshDir, 'aht_ubuntu_deploy')") || !main.includes('privateKeyPath: serverTransferPrivateKeyPath(')) {
  throw new Error('Developer server upload must automatically resolve the dedicated AHT SSH key.');
}
if (!transferSource.includes('if (privateKey) authentication.privateKey = privateKey;') || !transferSource.includes("authentication: privateKey ? 'public-key' : 'password'")) {
  throw new Error('SFTP upload must support public-key authentication with password fallback.');
}
await assert.rejects(
  uploadServerFiles({
    sourceDir: source,
    remoteDir: '/home/notevil/Desktop',
    host: '127.0.0.1',
    username: 'smoke',
    password: 'unused'
  }),
  /dedicated server folder under Desktop/,
  'Server upload must reject a bare Desktop destination before connecting.'
);
if (!renderer.includes('setUnavailable(els.planServerTransferButton, true);')) {
  throw new Error('Server upload must disable Plan while an upload is running.');
}
const rendererHtml = fs.readFileSync(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');
if (!rendererHtml.includes('Remote Parent Folder') || !rendererHtml.includes('Creates a folder matching the selected server folder name')) {
  throw new Error('Server Upload must describe the remote path as a parent that receives a dynamically named child folder.');
}
if (!renderer.includes('setUnavailable(els.uploadServerFilesButton, false);\n    setUnavailable(els.planServerTransferButton, false);\n  }\n}')) {
  throw new Error('Server upload buttons must be re-enabled only when polling sees the transfer finish.');
}
if (renderer.includes('} finally {\n    setUnavailable(els.uploadServerFilesButton, false);')) {
  throw new Error('Server upload must not immediately re-enable Upload in a finally block.');
}

console.log(JSON.stringify({
  ok: true,
  root,
  fileCount: plan.fileCount,
  files,
  excludedDirs: plan.excludedDirs
}, null, 2));
