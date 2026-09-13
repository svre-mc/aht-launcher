import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ensureNativeGuard, probeNativeGuard } from '../src/nativeGuard.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-phoenix-session-'));
  const pin = JSON.parse(await fs.readFile(new URL('../native-guard/release.json', import.meta.url), 'utf8'));
  const binaryFile = process.env.AHT_HANDOFF_GUARD || fileURLToPath(new URL(`../native-guard/releases/Phoenix-Anti-cheat-Windows-x64-${pin.version}.exe`, import.meta.url));
  const version = path.basename(binaryFile).match(/-(\d+\.\d+\.\d+)\.exe$/)?.[1]
    || JSON.parse(await fs.readFile(path.join(path.dirname(binaryFile), 'manifest.json'), 'utf8')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const binary = await fs.readFile(binaryFile);
  const hash = createHash('sha256').update(binary).digest('hex');
  if (!process.env.AHT_HANDOFF_GUARD) {
    assert.equal(version, JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).phoenixAntiCheatVersion,
      'Finalize the current candidate pin before running the default release lifecycle check');
    assert.equal(hash, pin.sha256); assert.equal(binary.length, pin.size);
  }
  await fs.writeFile(path.join(root, 'Phoenix Anti-cheat.exe'), binary);
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version,
    file: 'Phoenix Anti-cheat.exe', protocol: 'AHT-GUARD-1', sha256: hash, bytes: binary.length }));
  const children = new Set();
  t.after(async () => {
    for (const pid of children) { try { process.kill(pid); } catch {} }
    // Allow only these test-owned child image handles to close before removing the fixture.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const options = { gameDir: path.join(root, 'pack'), javaPath: path.join(root, 'java-8', 'java.exe'),
    developmentRuntimeDir: root, developerMode: true, requiredVersion: version, expectedHash: hash,
    launcherPid: process.pid, launcherSessionId: 'a'.repeat(32), platform: 'win32' };
  return { root, options, async ensure(overrides = {}) {
    const descriptor = await ensureNativeGuard({ ...options, ...overrides });
    children.add(descriptor.guardPid);
    return descriptor;
  } };
}

test('a changed Java executable cannot reuse a Phoenix session bound to the old executable', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const first = await f.ensure();
  const unchanged = await f.ensure();
  assert.equal(unchanged.guardPid, first.guardPid, 'Unchanged verified launch context should reuse its live helper');
  const changed = await f.ensure({ javaPath: path.join(f.root, 'java-8', 'javaw.exe') });
  assert.notEqual(changed.guardPid, first.guardPid, 'Java repair must not keep a helper that can never bind the new game');
  assert.notEqual(changed.keyHash, first.keyHash);
});

test('overlapping different Java bindings must not share one in-flight native startup', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const [first, changed] = await Promise.all([f.ensure(), f.ensure({ javaPath: path.join(f.root, 'different-java', 'javaw.exe') })]);
  assert.notEqual(first.guardPid, changed.guardPid);
});

test('legacy descriptor cleanup removes only its two owned files', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const metadata = path.join(f.options.gameDir, '.aht-launcher');
  await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(metadata, 'native-guard.json'), 'old descriptor');
  await fs.writeFile(path.join(metadata, 'native-guard.json.tmp'), 'old transaction');
  await fs.writeFile(path.join(metadata, 'settings.json'), 'preserve unrelated settings');
  await f.ensure();
  assert.deepEqual(await fs.readdir(metadata), ['settings.json']);
  assert.equal(await fs.readFile(path.join(metadata, 'settings.json'), 'utf8'), 'preserve unrelated settings');
});

test('legacy descriptor cleanup does not traverse a redirected metadata directory', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const unrelated = path.join(f.root, 'unrelated-fixture-data');
  await fs.mkdir(unrelated); await fs.mkdir(f.options.gameDir);
  const sentinel = path.join(unrelated, 'native-guard.json');
  await fs.writeFile(sentinel, 'preserve unrelated data');
  await fs.symlink(unrelated, path.join(f.options.gameDir, '.aht-launcher'), 'junction');
  await f.ensure();
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve unrelated data');
});

test('Play immediately after game exit cannot reuse a helper still bound to the dead game', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const f = await fixture(t);
  const javaHome = process.env.JAVA_HOME || 'C:/AHTDEV/Toolchains/Java-8';
  const javaPath = path.join(javaHome, 'bin/java.exe');
  await fs.mkdir(f.options.gameDir, { recursive: true });
  execFileSync(path.join(javaHome, 'bin/javac.exe'), ['-d', f.options.gameDir,
    fileURLToPath(new URL('../native-guard/test/JavaRuntimeFixture.java', import.meta.url))], { windowsHide: true, timeout: 10000 });
  const game = spawn(javaPath, ['-XX:+DisableAttachMechanism', `-Dminecraft.applet.TargetDirectory=${f.options.gameDir}`,
    '-cp', f.options.gameDir, 'JavaRuntimeFixture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(game, 'exit');
  try {
    await once(game.stdout, 'data');
    const first = await f.ensure({ javaPath });
    const deadline = Date.now() + 8000;
    while (true) {
      const result = await probeNativeGuard(first);
      if (result.measurement.state === 'clean') break;
      assert(Date.now() < deadline, 'The real Java fixture must acquire clean native coverage');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    game.kill(); await exited;
    const next = await f.ensure({ javaPath });
    assert.notEqual(next.guardPid, first.guardPid, 'The old helper can still answer INFO during its native shutdown interval');
    assert.equal(next.gamePid, 0, 'A fresh launch must wait for its own new Java process');
  } finally { game.kill(); await exited; }
});
