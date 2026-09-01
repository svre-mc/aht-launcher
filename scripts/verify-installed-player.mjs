import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

function installedPlayerExe() {
  return String(process.env.AHT_INSTALLED_PLAYER_EXE || process.env.AHT_SMOKE_EXE || defaultInstalledPlayerExe()).trim();
}

function runCheck(args, smokeExe) {
  const label = `npm run ${args.join(' ')}`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const invocation = packageManagerInvocation(args);
    let output = '';
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: invocation.shell,
      env: {
        ...process.env,
        AHT_SMOKE_EXE: smokeExe,
        AHT_ALLOW_UNENCRYPTED_DEVICE_KEY: '1',
        ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING || '0'
      }
    });

    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (error) => {
      error.output = output;
      error.label = label;
      reject(error);
    });
    child.on('exit', (code, signal) => {
      const elapsed = Date.now() - started;
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
