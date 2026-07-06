import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const pureChecks = [
  ['test:platforms'],
  ['test:platform-builds'],
  ['test:profile'],
  ['test:worker'],
  ['test:telemetry'],
  ['test:launcher-proof'],
  ['test:launcher-update-manifest'],
  ['test:production-readiness'],
  ['test:github-workflow'],
  ['test:github-push-auth'],
  ['test:r2-direct-upload'],
  ['test:server-transfer-plan'],
  ['test:mod-only-changes'],
  ['test:local-changes-large-tree'],
  ['test:cache-fallback'],
  ['test:full-client-zip'],
  ['test:cache-extra-integrity'],
  ['test:download-retry'],
  ['test:resourcepack-placement'],
  ['test:resourcepack-keyed-cache'],
  ['test:release-builder-default-outdir'],
  ['test:update-repair-state'],
  ['test:minecraft-service-status'],
  ['test:minecraft-launcher-routes'],
  ['test:social-client'],
  ['test:item-fire-fix-release']
];

const electronChecks = [
  ['test:player-defaults'],
  ['test:player-layout'],
  ['test:friends-panel'],
  ['test:player-privacy'],
  ['test:settings-profile'],
  ['test:setup-recovery'],
  ['test:error-details-copy'],
  ['test:write-defaults'],
  ['test:developer-secret'],
  ['test:developer-update-log-auth'],
  ['test:developer-client-bypass'],
  ['test:developer-instance-dir'],
  ['test:developer-modpack-zip'],
  ['test:cloud-login'],
  ['test:cache-only-cloud'],
  ['test:launcher-self-update'],
  ['test:launcher-update-publish'],
  ['test:play-gate'],
  ['test:repair-missing-managed'],
  ['test:play-missing-launcher'],
  ['test:play-missing-custom'],
  ['test:play-java-setup'],
  ['test:play-service-outage'],
  ['test:play-asset-repair'],
  ['test:play-curseforge-priority'],
  ['test:play-curseforge-fallback'],
  ['test:play-custom-fallback'],
  ['test:play-desktop-start-retry'],
  ['test:play-app-alias-ignored'],
  ['test:play-store-fallback'],
  ['test:play-signin-guidance'],
  ['test:player-update-play'],
  ['test:account-duplicate'],
  ['test:account-switch'],
  ['test:update-logs'],
  ['test:release-flow'],
  ['test:release-ui-flow'],
  ['test:single-instance'],
  ['test:close-during-update']
];

const verbose = process.argv.includes('--verbose') || process.env.AHT_VERIFY_VERBOSE === '1';
const parallel = Math.max(1, Number(process.env.AHT_VERIFY_PARALLEL || 4));
const checkTimeoutMs = Math.max(30_000, Number(process.env.AHT_VERIFY_CHECK_TIMEOUT_MS || 180_000));
const latestLogPath = path.join(process.cwd(), 'work', 'state', 'verify-local-latest.log');

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

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function runCheck(args) {
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
        logLine(`[PASS] ${label} (${formatMs(elapsed)})`);
        if (verbose && output.trim()) logLine(output.trim());
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

async function runParallel(checks, limit) {
  let index = 0;
  const results = [];
  async function worker() {
    while (index < checks.length) {
      const current = checks[index];
      index += 1;
      results.push(await runCheck(current));
    }
  }
  const workers = Array.from({ length: Math.min(limit, checks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function runSerial(checks) {
  const results = [];
  for (const check of checks) {
    results.push(await runCheck(check));
  }
  return results;
}

const started = Date.now();
try {
  fs.mkdirSync(path.dirname(latestLogPath), { recursive: true });
  fs.writeFileSync(latestLogPath, `AHT local verification started ${new Date().toISOString()}\n`, 'utf8');
  logLine(`Running ${pureChecks.length} pure checks with concurrency ${parallel}...`);
  const pureResults = await runParallel(pureChecks, parallel);
  logLine(`Running ${electronChecks.length} Electron checks serially...`);
  const electronResults = await runSerial(electronChecks);
  const results = [...pureResults, ...electronResults];
  const elapsed = Date.now() - started;
  logLine(`\nAll ${results.length} local AHT launcher checks passed in ${formatMs(elapsed)}.`);
} catch (error) {
  errorLine(`\n[FAIL] ${error.label || 'local verification'} (${formatMs(error.elapsed || Date.now() - started)})`);
  if (error.output?.trim()) {
    errorLine(error.output.trim());
  }
  errorLine(error.stack || error.message || String(error));
  process.exitCode = 1;
}
