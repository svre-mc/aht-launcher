import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { probeNativeGuard, validateNativeGuardDescriptor } from '../src/nativeGuard.js';
import { startNativeGuardProcess } from '../src/nativeGuardTransport.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.resolve(process.env.AHT_SOAK_EVIDENCE || path.join(root, 'build/native-guard-soak'));
const durationMs = Number(process.env.AHT_SOAK_DURATION_MS || 60000);
assert(Number.isSafeInteger(durationMs) && durationMs >= 10000 && durationMs <= 3 * 60 * 60 * 1000);
const javaHome = process.env.JAVA_HOME || 'C:/AHTDEV/Toolchains/Java-8';
const javaPath = path.join(javaHome, 'bin/java.exe');
const binary = process.env.AHT_SOAK_GUARD || path.join(root, 'build/native-guard/Phoenix Anti-cheat.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const startedAt = new Date().toISOString();
const started = performance.now();
const latencies = [], resources = [];
const receipt = { status: 'RUNNING', startedAt, requestedDurationMs: durationMs,
  scope: 'Actual read-only Phoenix helper and Java 8 JIT fixture. Not Minecraft, Mojang, player behavior, or a kernel anti-cheat test.',
  measurements: 0, clean: 0, faultRounds: 0, transportErrors: 0 };
let game, child, descriptor, lastSequence = 0, birth = '', nextResource = 0, nextFault = 45000;
const sockets = new Set();
await fs.mkdir(evidence, { recursive: true });
execFileSync(path.join(javaHome, 'bin/javac.exe'), ['-d', evidence, path.join(root, 'native-guard/test/JavaRuntimeFixture.java')], { windowsHide: true });
receipt.binarySha256 = crypto.createHash('sha256').update(await fs.readFile(binary)).digest('hex');
async function writeReceipt() {
  receipt.elapsedMs = Math.round(performance.now() - started);
  const sorted = [...latencies].sort((a, b) => a - b);
  receipt.latencyMs = { p50: sorted[Math.floor(sorted.length * .5)] || 0,
    p95: sorted[Math.floor(sorted.length * .95)] || 0, max: sorted.at(-1) || 0 };
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify({ ...receipt, resources }, null, 2));
}
async function measure() {
  const begin = performance.now();
  let result;
  try { result = await probeNativeGuard(descriptor); }
  catch (error) { receipt.transportErrors++; throw error; }
  latencies.push(Math.round(performance.now() - begin)); receipt.measurements++;
  assert.equal(result.live.gamePid, game.pid);
  assert.equal(result.measurement.state, 'clean');
  assert.equal(result.measurement.gamePid, game.pid);
  assert(result.measurement.checkedModules >= 2);
  assert(result.measurement.checkedBytes > 0);
  assert(result.measurement.sequence >= lastSequence);
  lastSequence = result.measurement.sequence;
  if (birth) assert.equal(result.measurement.processBirth, birth);
  birth = result.measurement.processBirth;
  receipt.clean++;
}
function slowClient() {
  const socket = net.connect({ host: '127.0.0.1', port: descriptor.port });
  sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
  socket.on('connect', () => socket.write('x'));
  return socket;
}
try {
  game = spawn(javaPath, ['-XX:+DisableAttachMechanism', `-Dminecraft.applet.TargetDirectory=${evidence}`,
    '-cp', evidence, 'JavaRuntimeFixture', String(durationMs + 30000)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await Promise.race([once(game.stdout, 'data'), pause(8000).then(() => { throw new Error('Java fixture startup deadline'); })]);
  ({ descriptor, child } = await startNativeGuardProcess({ binary, gameDir: evidence, javaPath,
    launcherPid: process.pid, launcherSessionId: crypto.randomBytes(16).toString('hex'), validateDescriptor: validateNativeGuardDescriptor }));
  receipt.javaPid = game.pid; receipt.guardPid = child.pid;
  const warmUntil = performance.now() + 10000;
  while (true) {
    const probe = await probeNativeGuard(descriptor);
    if (probe.measurement.state === 'clean') break;
    assert(performance.now() < warmUntil, 'Native warmup deadline'); await pause(500);
  }
  while (performance.now() - started < durationMs) {
    await measure();
    const elapsed = performance.now() - started;
    if (elapsed >= nextFault) {
      const stalled = Array.from({ length: 4 }, slowClient);
      try { await Promise.all([measure(), measure(), measure()]); receipt.faultRounds++; }
      finally { for (const socket of stalled) socket.destroy(); }
      nextFault += 90000;
    }
    if (elapsed >= nextResource) {
      const sample = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-Process -Id ${child.pid} | Select-Object Id,HandleCount,WorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress`],
        { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
      resources.push({ elapsedMs: Math.round(elapsed), ...sample });
      await writeReceipt();
      console.log(JSON.stringify({ elapsedSeconds: Math.round(elapsed / 1000), clean: receipt.clean,
        faults: receipt.faultRounds, latencyMs: receipt.latencyMs, handles: sample.HandleCount, privateBytes: sample.PrivateMemorySize64 }));
      nextResource += 60000;
    }
    await pause(2500);
  }
  receipt.status = 'PASSED';
  if (resources.length >= 5) {
    const warm = resources.slice(1, 5);
    const final = resources.slice(-3);
    const growth = Math.max(...final.map(row => row.PrivateMemorySize64)) - Math.max(...warm.map(row => row.PrivateMemorySize64));
    const handles = Math.max(...final.map(row => row.HandleCount)) - Math.max(...warm.map(row => row.HandleCount));
    receipt.resourceGrowth = { privateBytes: growth, handles };
    assert(growth < 64 * 1024 * 1024, 'Unexpected sustained native private-memory growth');
    assert(handles < 64, 'Unexpected sustained native handle growth');
  }
} catch (error) {
  receipt.status = 'FAILED'; receipt.failure = String(error.message || error); process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  game?.kill(); child?.kill();
  await writeReceipt();
  console.log(JSON.stringify({ status: receipt.status, elapsedMs: receipt.elapsedMs,
    measurements: receipt.measurements, faultRounds: receipt.faultRounds, failure: receipt.failure || '' }));
}
