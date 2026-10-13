import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-detached-diagnostics-'));
const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem');
let child, server, workerPid;
const previousCa = process.env.NODE_EXTRA_CA_CERTS;
try {
  execFileSync('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore', windowsHide: true });
  await fs.mkdir(path.join(root, 'logs/aht-diagnostics'), { recursive: true });
  await fs.writeFile(path.join(root, 'logs/latest.log'), '');
  const received = [];
  server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => { assert.equal(request.url, '/api/diagnostics/incidents');
      assert.equal(request.headers.authorization, 'Bearer fixture-only-report-token');
      received.push(JSON.parse(body)); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const launchId = randomUUID();
  process.env.NODE_EXTRA_CA_CERTS = cert;
  child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/game-incident-parent-fixture.mjs', import.meta.url))],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  child.stdin.end(JSON.stringify({ instanceDir: root, launchId, token: 'fixture-only-report-token',
    endpoint: `https://localhost:${server.address().port}/api/diagnostics/incidents` }));
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Detached worker did not finish in 15 seconds')), 15000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exit, 0); workerPid = JSON.parse(output.trim()).pid;
  const parentExitedAt = Date.now();
  const deadline = Date.now() + 10000;
  while (!received.some(item => item.kind === 'process_exit') && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert(received.some(item => item.kind === 'process_exit'));
  assert(Date.parse(received.find(item => item.kind === 'process_exit').occurredAt) >= parentExitedAt);
  assert(received.every(item => item.launchId === launchId));
  console.log('PASS: actual Electron helper survives its parent process exit and uploads the later game-process exit over verified TLS.');
} finally {
  if (child && child.exitCode === null) child.kill();
  if (workerPid) { try { process.kill(workerPid); } catch {} }
  if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = previousCa;
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await fs.rm(root, { recursive: true, force: true });
}
