import { spawn } from 'node:child_process';

const pureChecks = [
  ['test:platforms'],
  ['test:platform-builds'],
  ['test:profile'],
  ['test:worker'],
  ['test:telemetry'],
  ['test:launcher-proof'],
  ['test:launcher-update-manifest'],
  ['test:github-workflow'],
  ['test:r2-direct-upload'],
  ['test:server-transfer-plan'],
  ['test:mod-only-changes'],
  ['test:cache-fallback'],
  ['test:full-client-zip'],
  ['test:cache-extra-integrity'],
  ['test:download-retry'],
  ['test:resourcepack-placement'],
  ['test:resourcepack-keyed-cache'],
  ['test:release-builder-default-outdir'],
  ['test:update-repair-state'],
  ['test:item-fire-fix-release']
];

const electronChecks = [
  ['test:player-defaults'],
  ['test:player-layout'],
  ['test:player-privacy'],
  ['test:settings-profile'],
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
  ['test:player-update-play'],
  ['test:account-duplicate'],
  ['test:account-switch'],
  ['test:update-logs'],
  ['test:release-flow'],
  ['test:release-ui-flow'],
  ['test:single-instance']
];

const verbose = process.argv.includes('--verbose') || process.env.AHT_VERIFY_VERBOSE === '1';
const parallel = Math.max(1, Number(process.env.AHT_VERIFY_PARALLEL || 4));

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
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
    const child = spawn(npmCommand(), ['run', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: {
        ...process.env,
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
        console.log(`[PASS] ${label} (${formatMs(elapsed)})`);
        if (verbose && output.trim()) console.log(output.trim());
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
  console.log(`Running ${pureChecks.length} pure checks with concurrency ${parallel}...`);
  const pureResults = await runParallel(pureChecks, parallel);
  console.log(`Running ${electronChecks.length} Electron checks serially...`);
  const electronResults = await runSerial(electronChecks);
  const results = [...pureResults, ...electronResults];
  const elapsed = Date.now() - started;
  console.log(`\nAll ${results.length} local AHT launcher checks passed in ${formatMs(elapsed)}.`);
} catch (error) {
  console.error(`\n[FAIL] ${error.label || 'local verification'} (${formatMs(error.elapsed || Date.now() - started)})`);
  if (error.output?.trim()) {
    console.error(error.output.trim());
  }
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}