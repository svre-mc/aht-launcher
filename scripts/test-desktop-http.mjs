import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { installDesktopHttp } from '../src/desktopHttp.js';
import { fetchJson, downloadToFile } from '../src/utils.js';

if (process.versions.electron) {
  const { app, net, session } = await import('electron');
  app.setPath('userData', process.env.AHT_TEST_USER_DATA);
  await app.whenReady();
  try {
    const base = process.env.AHT_HTTP_TEST_BASE;
    installDesktopHttp({ net });
    assert.equal((await fetchJson(`${base}/feed`)).version, 'fixture');
    assert.deepEqual(await (await fetch(`${base}/proof`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'TestPlayer' }) })).json(), { username: 'TestPlayer' });
    const file = path.join(app.getPath('userData'), 'download.bin');
    await downloadToFile(`${base}/file`, file);
    assert.equal(await fs.readFile(file, 'utf8'), 'fixture-download');
    for (const route of ['headers-stall', 'body-stall']) {
      await assert.rejects(fetchJson(`${base}/${route}`, {}, { timeoutMs: 150 }), /did not respond/);
    }
    await assert.rejects(fetchJson(`${base}/blocked`), (error) => error.code === 'CLOUDFLARE_1010' && error.message.includes('test-ray'));
    await session.defaultSession.setProxy({ proxyRules: base });
    assert.equal((await fetchJson('http://aht-network-fixture.invalid/feed')).version, 'fixture');
    await session.defaultSession.setProxy({ mode: 'direct' });
    await import('./test-download-retry.mjs');
    if (process.env.AHT_TEST_LIVE_HTTP === '1') {
      assert.equal((await fetchJson('https://api.ahardtime.net/latest.json')).packId, 'a-hard-time-dregora');
      const update = await fetchJson('https://api.ahardtime.net/launcher/latest.json');
      assert(update.version);
    }
    console.log('PASS: native desktop HTTP, proxy routing, POST identity, file download, bounded stalls, and edge diagnostics.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
} else {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/headers-stall') return;
    if (url.pathname === '/body-stall') { response.writeHead(200); response.write('{'); return; }
    if (!/Chrome\//.test(request.headers['user-agent'] || '') || url.pathname === '/blocked') {
      response.writeHead(403, { 'cf-ray': 'test-ray' }); response.end('error code: 1010'); return;
    }
    if (url.pathname === '/proof') {
      let body = ''; for await (const chunk of request) body += chunk;
      response.setHeader('Content-Type', 'application/json'); response.end(body); return;
    }
    if (url.pathname === '/file') { response.end('fixture-download'); return; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ version: 'fixture' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-native-http-'));
  const userData = directory;
  try {
    assert.equal((await fetch(`${base}/feed`)).status, 403, 'Reproduce the Node-signature rejection first');
    const executable = process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/.bin/electron';
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'aht-native-http-test', version: '1.0.0', main: 'main.cjs' }));
    await fs.writeFile(path.join(directory, 'main.cjs'), `require('fs').writeFileSync(__dirname + '/started.txt', 'started'); import(${JSON.stringify(import.meta.url)}).catch(error => { console.error(error); require('electron').app.exit(1); });`);
    const child = spawn(path.resolve(executable), ['.', `--user-data-dir=${directory}`], {
      cwd: directory, env: { ...process.env, AHT_HTTP_TEST_BASE: base, AHT_TEST_HOOKS: '1', AHT_TEST_USER_DATA: userData },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    const timer = setTimeout(() => child.kill(), 60000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, `Electron test failed in ${directory}`);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
