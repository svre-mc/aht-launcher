import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-copied-game-log-'));
const userData = path.join(root, 'profile'), stable = path.join(root, 'stable'), ptb = path.join(root, 'ptb');
let child, socket, startupOutput = '';
const service = http.createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{"logs":[],"counts":{},"players":[]}'); });
await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = new Map(); let nextId = 0;
async function evaluate(expression) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { calls.delete(id); reject(new Error('Copy fixture timed out: ' + expression.slice(0, 100))); }, 20000);
    calls.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
try {
  for (const directory of [userData, path.join(stable, 'logs'), path.join(ptb, 'logs'),
    path.join(root, 'Documents'), path.join(root, 'Downloads'), path.join(root, 'appData'), path.join(root, 'localAppData')]) await fs.mkdir(directory, { recursive: true });
  const base = `http://127.0.0.1:${service.address().port}/`;
  const config = { packId: 'a-hard-time-dregora', instanceDir: stable, latestUrl: base + 'latest.json',
    packs: { ptb: { packId: 'a-hard-time-ptb', instanceDir: ptb, latestUrl: base + 'ptb/latest.json' } },
    sync: { enabled: false, sendLocalChanges: false, baseUrl: base }, social: { enabled: false, baseUrl: base },
    developer: { adminBaseUrl: base }, launcherUpdate: { enabled: false, latestUrl: base + 'launcher/latest.json' },
    curseforge: { proxyBaseUrl: base }, launcherProof: { enabled: false, baseUrl: base },
    minecraftLauncher: { enabled: false, rootDir: path.join(root, 'minecraft') } };
  await fs.writeFile(path.join(userData, 'launcher.config.json'), JSON.stringify(config));
  const original = '[INFO] stable start\n[ERROR] stable copied packet failure\n  at fixture.Packet.read(Packet.java:54)\naccessToken=copy-private-secret\n';
  await fs.writeFile(path.join(stable, 'logs/latest.log'), original);
  await fs.writeFile(path.join(ptb, 'logs/latest.log'), '[ERROR] PTB copied-log fixture\n');
  const executable = process.env.AHT_SMOKE_EXE || path.resolve('node_modules/electron/dist/electron.exe');
  child = spawn(executable, [...(process.env.AHT_SMOKE_EXE ? [] : ['.']), `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    cwd: process.env.AHT_SMOKE_EXE ? path.dirname(executable) : process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AHT_APP_DEFAULTS: '', AHT_DEVELOPER: '0', AHT_TEST_HOOKS: '1', AHT_TEST_USER_DATA: userData,
      APPDATA: path.join(root, 'appData'), LOCALAPPDATA: path.join(root, 'localAppData'),
      HOME: root, USERPROFILE: root, SystemDrive: root, AHT_DEVELOPER_VAULT_DIR: path.join(root, 'vault') } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { startupOutput = (startupOutput + data.toString()).slice(-2000); });
  const deadline = Date.now() + 30000; let target;
  while (!target && Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl); if (!target) await sleep(150);
  }
  assert(target, 'Isolated launcher did not start: ' + startupOutput);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', ({ data }) => {
    const result = JSON.parse(data), current = calls.get(result.id); if (!current) return;
    calls.delete(result.id); clearTimeout(current.timer);
    if (result.error || result.result?.exceptionDetails) current.reject(new Error(result.error?.message || result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.text));
    else current.resolve(result.result.result?.value);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  while (!await evaluate('Boolean(window.aht?.copyErrorReport)')) { assert(Date.now() < deadline); await sleep(100); }
  await evaluate("window.aht.getStatus('stable')");
  for (const packKey of ['stable', 'ptb']) {
    const result = await evaluate(`window.aht.copyErrorReport({title:'Fixture error',context:'renderer-toast',packKey:${JSON.stringify(packKey)}})`);
    assert.equal(result.copyKind, 'file'); assert.equal(result.fileName, 'AHT Error Report.txt');
    const text = await fs.readFile(result.filePath, 'utf8');
    assert.match(text, /A HARD TIME LAUNCHER ERROR REPORT/); assert.match(text, /MINECRAFT LATEST.LOG/);
    assert(text.includes(packKey === 'stable' ? 'stable copied packet failure' : 'PTB copied-log fixture'), `${packKey}: ${result.filePath}; ${text.slice(text.indexOf('MINECRAFT LATEST.LOG'), text.indexOf('MINECRAFT LATEST.LOG') + 500)}; ${startupOutput}`);
    assert(!text.includes(packKey === 'stable' ? 'PTB copied-log fixture' : 'stable copied packet failure'));
    assert(!text.includes('copy-private-secret')); assert(!text.includes(root));
    if (packKey === 'stable') assert(text.includes('  at fixture.Packet.read'));
    if (process.platform === 'win32') {
      const clipboard = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [Console]::WriteLine([string]$_) }'], { encoding: 'utf8', windowsHide: true });
      assert.equal(clipboard.trim(), result.filePath);
    }
  }
  assert.equal(await fs.readFile(path.join(stable, 'logs/latest.log'), 'utf8'), original);
  await fs.unlink(path.join(ptb, 'logs/latest.log'));
  const missing = await evaluate("window.aht.copyErrorReport({title:'Fixture error',packKey:'ptb'})");
  assert.match(await fs.readFile(missing.filePath, 'utf8'), /No latest.log exists/);
  console.log('PASS: real Electron copy IPC and Windows file clipboard include the selected Stable/PTB latest.log, redact credentials, preserve stack indentation/source and explain missing logs.');
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await evaluate('window.aht.appExit()').catch(() => {}); socket.close(); }
  if (child && child.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  await new Promise(resolve => service.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
