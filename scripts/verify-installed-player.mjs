import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const checks = [
  ['test:player-defaults'],
  ['test:player-privacy'],
  ['test:player-layout'],
  ['test:friends-panel'],
  ['test:legal-panel'],
  ['test:settings-profile'],
  ['test:account-duplicate'],
  ['test:account-switch'],
  ['test:update-logs'],
  ['test:single-instance'],
  ['test:close-during-update'],
  ['test:play-gate'],
  ['test:player-update-play'],
  ['test:launcher-self-update'],
  ['test:developer-launcher-reinstall']
];

const checkTimeoutMs = Number(process.env.AHT_INSTALLED_PLAYER_CHECK_TIMEOUT_MS || 8 * 60 * 1000);
if (!Number.isFinite(checkTimeoutMs) || checkTimeoutMs < 30_000) {
  throw new Error(`Invalid installed-player check timeout: ${process.env.AHT_INSTALLED_PLAYER_CHECK_TIMEOUT_MS}`);
}

function packageManagerInvocation(args) {
  const activePackageManager = String(process.env.npm_execpath || '').trim();
  if (activePackageManager) {
    return {
      command: process.execPath,
      args: [activePackageManager, 'run', ...args],
      shell: false
    };
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', ...args],
    shell: process.platform === 'win32'
  };
}

function defaultInstalledPlayerExe() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Programs', 'A Hard Time Launcher Windows', 'A Hard Time Launcher Windows.exe');
  }
  if (process.platform === 'darwin') {
    return '/Applications/A Hard Time Launcher macOS.app/Contents/MacOS/A Hard Time Launcher macOS';
  }
  return '';
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function closeServers(servers) {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
}

async function findAvailablePortBlock(width = 4) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const basePort = 20_000 + Math.floor(Math.random() * (40_000 - width));
    const servers = [];
    try {
      for (let offset = 0; offset < width; offset += 1) {
        const server = net.createServer();
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen({ host: '127.0.0.1', port: basePort + offset, exclusive: true }, resolve);
        });
        servers.push(server);
      }
      await closeServers(servers);
      return basePort;
    } catch {
      await closeServers(servers);
    }
  }
  throw new Error('Could not reserve a free loopback port block for an installed-player check.');
}

function installedPlayerExe() {
  return String(process.env.AHT_INSTALLED_PLAYER_EXE || process.env.AHT_SMOKE_EXE || defaultInstalledPlayerExe()).trim();
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function terminateOwnedProcessTree(child, initialSignal = 'SIGTERM') {
  if (process.platform === 'win32' || !Number.isInteger(child.pid) || child.pid <= 0) {
    child.kill(initialSignal);
    return;
  }
  if (!processGroupExists(child.pid)) return;
  process.kill(-child.pid, initialSignal);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!processGroupExists(child.pid)) return;
  }
  process.kill(-child.pid, 'SIGKILL');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!processGroupExists(child.pid)) return;
  }
  throw new Error(`Owned installed-player process group ${child.pid} did not exit.`);
}

async function runCheck(check, smokeExe) {
  // Installed checks run after the source suite on the same native runner.
  // Probe a fresh consecutive range so runner-local services or slow-closing
  // Electron processes cannot capture a packaged app's debugger/worker ports.
  const port = await findAvailablePortBlock();
  const args = [...check, '--', String(port)];
  const label = `npm run ${args.join(' ')}`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const invocation = packageManagerInvocation(args);
    let output = '';
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: invocation.shell,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        AHT_SMOKE_EXE: smokeExe,
        AHT_ALLOW_UNENCRYPTED_DEVICE_KEY: '1',
        ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING || '0'
      }
    });

    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await terminateOwnedProcessTree(child).catch(() => {});
      const error = new Error(`${label} exceeded the ${formatMs(checkTimeoutMs)} per-check limit`);
      error.output = output;
      error.label = label;
      error.elapsed = Date.now() - started;
      reject(error);
    }, checkTimeoutMs);

    console.log(`[RUN] ${label} with installed player app`);

    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error.output = output;
      error.label = label;
      reject(error);
    });
    child.on('exit', async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsed = Date.now() - started;
      try {
        await terminateOwnedProcessTree(child);
      } catch (cleanupError) {
        cleanupError.output = output;
        cleanupError.label = `${label} process cleanup`;
        cleanupError.elapsed = elapsed;
        reject(cleanupError);
        return;
      }
      if (code === 0) {
        console.log(`[PASS] ${label} with installed player app (${formatMs(elapsed)})`);
        resolve({ label, elapsed, output });
        return;
      }
      const error = new Error(`${label} failed with ${signal || `exit code ${code}`}`);
      error.output = output;
      error.label = label;
      error.elapsed = elapsed;
      reject(error);
    });
  });
}

const smokeExe = installedPlayerExe();
const started = Date.now();

try {
  if (!smokeExe) {
    throw new Error('No installed player launcher path is available. Set AHT_INSTALLED_PLAYER_EXE to the installed launcher executable.');
  }
  if (!fs.existsSync(smokeExe)) {
    throw new Error(`Installed player launcher was not found: ${smokeExe}`);
  }

  console.log(`Running ${checks.length} installed-player checks against: ${smokeExe}`);
  const results = [];
  for (const check of checks) {
    results.push(await runCheck(check, smokeExe));
  }
  console.log(`\nAll ${results.length} installed-player checks passed in ${formatMs(Date.now() - started)}.`);
} catch (error) {
  console.error(`\n[FAIL] ${error.label || 'installed-player verification'} (${formatMs(error.elapsed || Date.now() - started)})`);
  if (error.output?.trim()) {
    console.error(error.output.trim());
  }
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
