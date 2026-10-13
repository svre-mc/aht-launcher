import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-incident-ui-'));
const evidence = process.env.AHT_DIAGNOSTICS_EVIDENCE || 'C:/AHT Launcher Dev/State/evidence/game-incidents-20261012';
await fs.mkdir(evidence, { recursive: true });
let app, connection;
const at = new Date().toISOString(), launchId = randomUUID();
const sample = source => ({ source, launcherVersion: '0.2.34', packVersion: '2.8.679', events: [{
  schemaVersion: 1, id: randomUUID(), launchId, connectionId: randomUUID(), occurredAt: at, kind: 'disconnected',
  reasonCode: source === 'client' ? 'protocol_error' : 'remote_closed', exceptionClasses: source === 'client'
    ? ['io.netty.handler.codec.DecoderException', 'java.lang.IndexOutOfBoundsException'] : [],
  stackFrames: source === 'client' ? ['com.example.Packet#read:54'] : [], metrics: { playerPingMillis: 31 } }] });
const records = ['client', 'backend', 'proxy'].map(sample);
let requests = 0;
const service = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  const url = new URL(request.url, 'http://fixture');
  if (url.pathname === '/admin/login') { response.end(JSON.stringify({ ok: true, token: 'fixture-admin-token', expiresAt: new Date(Date.now() + 3600000).toISOString() })); return; }
  if (url.pathname === '/admin/diagnostics/incidents') {
    requests++; assert.equal(request.headers.authorization, 'Bearer fixture-admin-token');
    if (url.searchParams.get('player') === 'UnknownPlayer') { response.statusCode = 400; response.end('{"error":"No registered player was found."}'); }
    else response.end(JSON.stringify({ records, cursor: '' }));
    return;
  }
  response.end(JSON.stringify({ counts: {}, logs: [], downloads: [], players: [], detections: [], updates: [], decisions: [], events: [], pagination: { hasMore: false } }));
});
await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
const portProbe = http.createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function cdp(url) {
  const socket = new WebSocket(url); let id = 0; const pending = new Map();
  socket.addEventListener('message', ({ data }) => { const result = JSON.parse(data); const current = pending.get(result.id);
    if (!current) return; pending.delete(result.id); clearTimeout(current.timer);
    result.error ? current.reject(new Error(result.error.message)) : current.resolve(result.result); });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  return { socket, call(method, params = {}) { return new Promise((resolve, reject) => {
    const next = ++id; const timer = setTimeout(() => { pending.delete(next); reject(new Error('Fixture CDP timeout')); }, 8000);
    pending.set(next, { resolve, reject, timer }); socket.send(JSON.stringify({ id: next, method, params })); }); } };
}
async function evaluate(expression) {
  const result = await connection.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Fixture renderer evaluation failed'); return result.result.value;
}
async function until(expression) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await evaluate(expression).catch(() => false)) return; await sleep(150); }
  const status = await evaluate("({classes:document.body?.className, incidentStatus:document.querySelector('#incidentReportStatus')?.textContent})").catch(() => ({}));
  throw new Error('Fixture UI state timeout: ' + JSON.stringify({ expression, status, requests }));
}
try {
  const userData = path.join(root, 'userData'); await fs.mkdir(userData);
  await fs.writeFile(path.join(userData, 'launcher.config.json'), JSON.stringify({
    packId: 'a-hard-time-dregora', instanceDir: path.join(root, 'instance'), latestUrl: `http://127.0.0.1:${service.address().port}/latest.json`,
    packs: { ptb: { latestUrl: `http://127.0.0.1:${service.address().port}/ptb/latest.json` } },
    curseforge: { proxyBaseUrl: '', apiKeyEnv: 'CURSEFORGE_API_KEY' },
    sync: { enabled: false, sendLocalChanges: false, baseUrl: `http://127.0.0.1:${service.address().port}/` },
    developer: { adminBaseUrl: `http://127.0.0.1:${service.address().port}/`, defaultOutDir: path.join(root, 'release') },
    launcherUpdate: { enabled: false, latestUrl: `http://127.0.0.1:${service.address().port}/launcher/latest.json` },
    launcherProof: { baseUrl: `http://127.0.0.1:${service.address().port}/` },
    social: { baseUrl: `http://127.0.0.1:${service.address().port}/`, enabled: false },
    minecraftLauncher: { enabled: false, rootDir: path.join(root, 'minecraft') }
  }));
  app = spawn(path.resolve('node_modules/electron/dist/electron.exe'), ['.', '--developer', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
    { cwd: process.cwd(), windowsHide: true, stdio: 'ignore', env: { ...process.env, AHT_ALLOW_DEVELOPER: '1',
      AHT_LAUNCHER_SOURCE_ROOT: process.cwd(), AHT_TEST_HOOKS: '1', AHT_TEST_USER_DATA: userData,
      APPDATA: path.join(root, 'appData'), SystemDrive: root,
      AHT_DEVELOPER_VAULT_DIR: path.join(root, 'vault'), AHT_DEVELOPER_USERNAME: 'admin',
      AHT_DEVELOPER_PASSWORD: 'test-dev-password', AHT_SKIP_REMOTE_DEVELOPER_LOGIN: '1' } });
  const deadline = Date.now() + 30000;
  while (!connection && Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    const target = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (target) connection = await cdp(target.webSocketDebuggerUrl); else await sleep(200);
  }
  if (!connection) throw new Error('Fixture Electron did not start');
  await until("document.body.classList.contains('is-launcher-ready')");
  await evaluate("document.querySelector('#developerTileButton').click()");
  await until("document.body.classList.contains('dev-locked')");
  await evaluate("document.querySelector('#adminPasswordInput').value='test-dev-password'; document.querySelector('#developerLoginForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));");
  await until("!document.body.classList.contains('dev-locked')");
  await evaluate("document.querySelector('[data-dev-target=playerDataTools]').click(); document.querySelector('[data-player-data-view=diagnostics]').click(); document.querySelector('#incidentPlayerInput').value='FixturePlayer'; document.querySelector('#loadIncidentsButton').click();");
  await until("document.querySelector('#incidentReportStatus').textContent.includes('1 recent incident')");
  await evaluate("document.querySelector('#incidentReportList details').open = true");
  const content = await evaluate("document.querySelector('#playerDiagnosticsPanel').innerText");
  assert(content.includes('client reported')); assert(content.includes('Missing: none'));
  const screen = await connection.call('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(evidence, 'diagnostics-ui.png'), Buffer.from(screen.data, 'base64'));
  const body = await evaluate("document.querySelector('#incidentReportList').textContent");
  assert(body.includes('DecoderException')); assert(body.includes('com.example.Packet#read:54')); assert(body.includes('2.8.679'));
  const previous = requests;
  await evaluate("document.querySelector('#incidentPlayerInput').value='bad/name'; document.querySelector('#loadIncidentsButton').click()");
  assert.equal(await evaluate("document.querySelector('#incidentReportStatus').textContent"), 'Enter a Minecraft player name.');
  assert.equal(requests, previous);
  await evaluate("document.querySelector('#incidentPlayerInput').value='UnknownPlayer'; document.querySelector('#loadIncidentsButton').click()");
  await until("document.querySelector('#incidentReportStatus').textContent.includes('No registered player')");
  await fs.writeFile(path.join(evidence, 'ui-result.json'), JSON.stringify({ passed: true, checks: ['authenticated IPC', 'correlation rendering', 'details/versions', 'invalid name', 'missing player'], screenshot: 'diagnostics-ui.png' }));
  console.log('PASS: real Electron developer UI loads private correlated incidents, renders cause/gaps/versions, and handles invalid or missing players.');
} finally {
  if (connection) { await evaluate('window.aht.appExit()').catch(() => app.kill()); connection.socket.close(); }
  if (app && app.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => { app.kill(); resolve(); }, 3000); app.once('exit', () => { clearTimeout(timer); resolve(); }); });
  await new Promise(resolve => service.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
