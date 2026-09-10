import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '..');
const out = path.join(root, 'build/native-guard-test/handoff');
const binary = process.env.AHT_HANDOFF_GUARD || path.join(root, 'build/native-guard/Phoenix Anti-cheat.exe');
const javaHome = process.env.JAVA_HOME;
const javaPath = process.env.AHT_HANDOFF_JAVA || path.join(javaHome, 'bin/java.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function line(child) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('startup timeout')), 8000);
    child.once('error', reject);
    child.stdout.on('data', data => {
      text += data;
      if (text.includes('\n')) { clearTimeout(timer); resolve(text.split('\n')[0]); }
    });
  });
}
function request(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let response = '';
    socket.setTimeout(2500, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(text + '\n'));
    socket.on('data', data => {
      response += data;
      if (response.includes('\n')) { socket.destroy(); resolve(JSON.parse(response.split('\n')[0])); }
    });
    socket.on('end', () => { if (!response.includes('\n')) reject(new Error('closed')); });
  });
}
if (process.argv.includes('--launcher')) {
  const diagnostics = openSync(path.join(out, 'guard-stderr.log'), 'w');
  const child = spawn(binary, [], { windowsHide: true, detached: !process.argv.includes('--attached'), stdio: ['pipe', 'pipe', diagnostics] });
  closeSync(diagnostics);
  const ready = line(child);
  child.stdin.end(JSON.stringify({ gameDir: out, javaPath, launcherPid: process.pid, launcherSessionId: '7'.repeat(32) }) + '\n');
  const info = JSON.parse(await ready);
  // Descriptor is passed only through this private parent-child pipe, never a file or test output.
  process.stdout.write(JSON.stringify(info) + '\n');
  child.stdout.destroy(); child.unref();
  process.stdin.once('data', () => process.exit(0));
} else {
  await fs.mkdir(out, { recursive: true });
  execFileSync(path.join(javaHome, 'bin/javac.exe'), ['-d', out, path.join(root, 'native-guard/test/JavaRuntimeFixture.java')], { windowsHide: true });
  let game, launcher, guardPid;
  try {
    launcher = spawn(process.execPath, [self, '--launcher', ...(process.argv.includes('--attached') ? ['--attached'] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    launcher.stderr.pipe(process.stderr);
    const info = JSON.parse(await line(launcher)); guardPid = info.guardPid;
    assert.equal((await request(info.port, info.sessionKey + '|INFO')).gamePid, 0);
    await pause(250); // The guard is in its normal discovery interval.
    game = spawn(javaPath, ['-XX:+DisableAttachMechanism', '-Dminecraft.applet.TargetDirectory=' + out, '-cp', out, 'JavaRuntimeFixture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await line(game);
    const before = await request(info.port, info.sessionKey + '|INFO');
    assert.equal(before.gamePid, 0, 'Fixture must close the launcher before guard binding');
    launcher.stdin.end('exit\n');
    await new Promise(resolve => launcher.once('exit', resolve));
    await pause(2400);
    let reply, failure;
    const nonce = crypto.randomBytes(24).toString('hex');
    try { reply = await request(info.port, `${nonce}|${game.pid}`); } catch (error) { failure = error; }
    if (process.argv.includes('--expect-failure')) {
      assert(failure, 'Published guard should reproduce the lost handoff');
      console.log('REPRODUCED: launcher exit before discovery stops Phoenix while the matching Java game remains alive.');
    } else {
      assert.ifError(failure);
      const payload = Buffer.from(reply.payload, 'base64url');
      assert(crypto.verify('sha256', payload, crypto.createPublicKey({ key: { kty: 'RSA', n: reply.modulus, e: reply.exponent }, format: 'jwk' }), Buffer.from(reply.signature, 'base64url')));
      const fields = payload.toString().split('\n');
      assert.equal(fields[1], nonce); assert.equal(fields[3], String(game.pid)); assert.equal(fields[7], 'clean');
      game.kill(); await new Promise(resolve => game.once('exit', resolve)); await pause(2400);
      await assert.rejects(() => request(info.port, info.sessionKey + '|INFO'));
      console.log('PASS: real Java handoff survives launcher exit, returns signed clean coverage, and stops after game exit.');
    }
  } finally {
    const diagnostics = await fs.readFile(path.join(out, 'guard-stderr.log'), 'utf8').catch(() => '');
    if (diagnostics) process.stderr.write(diagnostics);
    game?.kill(); launcher?.kill();
    if (guardPid) { try { process.kill(guardPid); } catch {} }
  }
}
