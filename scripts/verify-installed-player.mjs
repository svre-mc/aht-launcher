import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checks = [
  ['test:player-defaults'],
  ['test:player-privacy'],
  ['test:player-layout'],
  ['test:friends-panel'],
  ['test:settings-profile'],
  ['test:setup-recovery'],
  ['test:error-details-copy'],
  ['test:account-duplicate'],
  ['test:account-switch'],
  ['test:update-logs'],
  ['test:single-instance'],
  ['test:close-during-update'],
  ['test:play-gate'],
  ['test:repair-missing-managed'],
  ['test:play-missing-launcher'],
  ['test:play-java-setup'],
  ['test:play-service-outage'],
  ['test:play-asset-repair'],
  ['test:play-curseforge-priority'],
  ['test:play-curseforge-fallback'],
  ['test:play-app-alias-fallback'],
  ['test:play-store-fallback'],
  ['test:play-signin-guidance'],
  ['test:player-update-play'],
  ['test:launcher-self-update']
];

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npmRunSpawnArgs(args) {
  const npmExecPath = String(process.env.npm_execpath || '').trim();
  if (npmExecPath.endsWith('.js')) {
    return {
      command: process.env.npm_node_execpath || process.execPath,
      args: [npmExecPath, 'run', ...args],
      shell: false
    };
  }
  return {
    command: npmCommand(),
    args: ['run', ...args],
    shell: process.platform === 'win32'
  };
}

function verifierEnvironment(extra = {}) {
  const nodeDir = path.dirname(process.execPath);
  const currentPath = process.env.PATH || process.env.Path || '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  const hasNodeDir = entries.some((entry) => entry.toLowerCase() === nodeDir.toLowerCase());
  const nextPath = hasNodeDir ? currentPath : `${nodeDir}${path.delimiter}${currentPath}`;
  return {
    ...process.env,
    ...extra,
    PATH: nextPath,
    Path: nextPath
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

function installedPlayerExe() {
  return String(process.env.AHT_INSTALLED_PLAYER_EXE || process.env.AHT_SMOKE_EXE || defaultInstalledPlayerExe()).trim();
}

const checkTimeoutMs = Math.max(30_000, Number(process.env.AHT_VERIFY_CHECK_TIMEOUT_MS || 180_000));
const latestLogPath = path.join(process.cwd(), 'work', 'state', 'verify-installed-player-latest.log');

function appendLatestLog(line = '') {
  fs.mkdirSync(path.dirname(latestLogPath), { recursive: true });
  fs.appendFileSync(latestLogPath, `${line}\n`, 'utf8');
}

function logLine(line = '') {
  console.log(line);
  appendLatestLog(line);
}

function errorLine(line = '') {
  console.error(line);
  appendLatestLog(line);
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    }).on('error', () => {});
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

function runCheck(args, smokeExe) {
  const label = `npm run ${args.join(' ')}`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const npmRun = npmRunSpawnArgs(args);
    const child = spawn(npmRun.command, npmRun.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: npmRun.shell,
      env: verifierEnvironment({
        AHT_SMOKE_EXE: smokeExe,
        ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING || '0'
      })
    });

    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid);
      const error = new Error(`${label} timed out after ${formatMs(checkTimeoutMs)}`);
      error.output = output;
      error.label = label;
      error.elapsed = Date.now() - started;
      reject(error);
    }, checkTimeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error.output = output;
      error.label = label;
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const elapsed = Date.now() - started;
      if (code === 0) {
        logLine(`[PASS] ${label} with installed player app (${formatMs(elapsed)})`);
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
  fs.mkdirSync(path.dirname(latestLogPath), { recursive: true });
  fs.writeFileSync(latestLogPath, `AHT installed-player verification started ${new Date().toISOString()}\n`, 'utf8');
  if (!smokeExe) {
    throw new Error('No installed player launcher path is available. Set AHT_INSTALLED_PLAYER_EXE to the installed launcher executable.');
  }
  if (!fs.existsSync(smokeExe)) {
    throw new Error(`Installed player launcher was not found: ${smokeExe}`);
  }

  logLine(`Running ${checks.length} installed-player checks against: ${smokeExe}`);
  const results = [];
  for (const check of checks) {
    results.push(await runCheck(check, smokeExe));
  }
  logLine(`\nAll ${results.length} installed-player checks passed in ${formatMs(Date.now() - started)}.`);
} catch (error) {
  errorLine(`\n[FAIL] ${error.label || 'installed-player verification'} (${formatMs(error.elapsed || Date.now() - started)})`);
  if (error.output?.trim()) {
    errorLine(error.output.trim());
  }
  errorLine(error.stack || error.message || String(error));
  process.exitCode = 1;
}
