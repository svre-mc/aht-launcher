import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const jsonOnly = args.has('--json');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const outputsDir = path.resolve(rootDir, '..', '..', 'outputs');
const releaseDir = path.join(rootDir, 'release-builds');
const checks = [];

function addCheck(name, level, ok, detail = '') {
  checks.push({ name, level, ok: Boolean(ok), detail });
}

function existsNonEmpty(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function existsDir(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function textIncludesAny(value, tokens) {
  const lower = String(value || '').toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

function wranglerOutputNeedsLogin(output = '') {
  return /not authenticated|wrangler login|please run [`'"]?wrangler login/i.test(String(output || ''));
}

function stripAnsi(value = '') {
  return String(value || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function commandDetail(output = '', fallback = '') {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /does not exist/i.test(line))
    || lines.find((line) => /failed|error|not authenticated|wrangler login/i.test(line))
    || lines.find((line) => !/wrangler|^-+$|^─+$|getting user settings/i.test(line))
    || lines.find((line) => !/^(⛅️|─|getting user settings)/i.test(line))
    || lines[0]
    || fallback;
}

function command(name, commandName, commandArgs, timeoutMs = 30000, options = {}) {
  const result = spawnSync(commandName, commandArgs, {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: process.platform === 'win32'
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const invalidOutput = options.invalidOutput?.(output) || false;
  const ok = result.status === 0 && !result.error && !invalidOutput;
  const detail = commandDetail(output, String(result.error || 'command failed'));
  addCheck(name, ok ? 'pass' : 'blocker', ok, detail);
  return { ok, output };
}

function runWrangler(args, timeoutMs = 60000) {
  const result = spawnSync('npx', ['--yes', 'wrangler', ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: process.platform === 'win32'
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return {
    ok: result.status === 0 && !result.error && !wranglerOutputNeedsLogin(output),
    output,
    detail: commandDetail(output, String(result.error || 'command failed'))
  };
}

function httpStatus(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return { ok: false, status: 0, detail: 'missing URL' };
  }
  const script = [
    'const url = process.argv[1];',
    'fetch(url, { method: "GET" })',
    '  .then(async (response) => {',
    '    const text = await response.text().catch(() => "");',
    '    console.log(JSON.stringify({ status: response.status, ok: response.ok, body: text.slice(0, 180) }));',
    '  })',
    '  .catch((error) => {',
    '    console.log(JSON.stringify({ status: 0, ok: false, body: error.message || String(error) }));',
    '    process.exitCode = 1;',
    '  });'
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script, url], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 30000
  });
  const raw = result.stdout?.trim() || '';
  const parsed = raw ? JSON.parse(raw) : null;
  const status = Number(parsed?.status || 0);
  const ok = result.status === 0 && Boolean(parsed?.ok);
  return {
    ok,
    status,
    detail: ok ? `${status} ${url}` : `${status || 'ERR'} ${parsed?.body || result.stderr || result.error || url}`
  };
}

function checkRequiredFiles() {
  const files = [
    'desktop/main.js',
    'desktop/preload.cjs',
    'desktop/renderer/app.js',
    'desktop/renderer/index.html',
    'src/releaseBuilder.js',
    'src/installer.js',
    'src/minecraftLauncherProfile.js',
    'cloudflare/curseforge-proxy-worker.js',
    'cloudflare/wrangler.toml',
    'build/icon.ico',
    'build/icon.png',
    'build/electron-builder.windows.cjs',
    'build/electron-builder.macos.cjs',
    'build/electron-builder.ubuntu.cjs',
    'pack-fixes/aht-item-fire-fix-fabric-26.1.2-1.0.0.jar',
    'pack-fixes/aht-item-fire-fix-forge-1.0.0.jar'
  ];

  for (const relativePath of files) {
    addCheck(`source file: ${relativePath}`, 'blocker', existsNonEmpty(path.join(rootDir, relativePath)), relativePath);
  }
}

function checkPackageConfig() {
  const packageJson = readJson(path.join(rootDir, 'package.json'));
  addCheck('package.json is readable', 'blocker', Boolean(packageJson), 'package metadata');
  if (!packageJson) {
    return;
  }

  addCheck('Windows app id is AHT branded', 'blocker', packageJson.build?.appId === 'com.ahardtime.launcher', packageJson.build?.appId || 'missing appId');
  addCheck('Windows installer script exists', 'blocker', Boolean(packageJson.scripts?.['dist:win']), 'npm run dist:win');
  addCheck('Linux package script exists', 'blocker', Boolean(packageJson.scripts?.['dist:linux']), 'npm run dist:linux');
  addCheck('macOS package script exists', 'blocker', Boolean(packageJson.scripts?.['dist:mac']), 'npm run dist:mac');
  addCheck('Windows regular launcher script exists', 'blocker', Boolean(packageJson.scripts?.['dist:regular:windows']), 'npm run dist:regular:windows');
  addCheck('macOS regular launcher script exists', 'blocker', Boolean(packageJson.scripts?.['dist:regular:macos']), 'npm run dist:regular:macos');
  addCheck('Ubuntu regular launcher script exists', 'blocker', Boolean(packageJson.scripts?.['dist:regular:ubuntu']), 'npm run dist:regular:ubuntu');
  addCheck('pack fix jars are packaged', 'blocker', packageJson.build?.files?.includes('pack-fixes/**/*'), 'pack-fixes/**/*');
}

function checkCloudflareConfig() {
  const wranglerPath = path.join(rootDir, 'cloudflare', 'wrangler.toml');
  const text = fs.existsSync(wranglerPath) ? fs.readFileSync(wranglerPath, 'utf8') : '';
  addCheck('R2 release bucket configured', 'blocker', /bucket_name\s*=\s*"ahtlauncher"/.test(text), 'AHT_RELEASES -> ahtlauncher');
  addCheck('R2 data bucket configured', 'blocker', /bucket_name\s*=\s*"ahtlauncher-data"/.test(text), 'AHT_DATA -> ahtlauncher-data');
  addCheck('Worker entry configured', 'blocker', /main\s*=\s*"curseforge-proxy-worker\.js"/.test(text), 'cloudflare/curseforge-proxy-worker.js');
}

function checkLiveCloudflareState(authOk) {
  if (!authOk) {
    addCheck('live R2 release bucket exists', 'blocker', false, 'Cloudflare login required');
    addCheck('live R2 data bucket exists', 'blocker', false, 'Cloudflare login required');
    addCheck('live Worker deployed', 'blocker', false, 'Cloudflare login required');
    return;
  }

  const bucketList = runWrangler(['r2', 'bucket', 'list'], 120000);
  if (!bucketList.ok) {
    addCheck('live R2 bucket list readable', 'blocker', false, bucketList.detail);
    addCheck('live R2 release bucket exists', 'blocker', false, 'Could not list buckets');
    addCheck('live R2 data bucket exists', 'blocker', false, 'Could not list buckets');
  } else {
    const bucketNames = new Set([...bucketList.output.matchAll(/name:\s+([^\r\n]+)/g)].map((match) => match[1].trim()));
    addCheck('live R2 bucket list readable', 'blocker', true, `${bucketNames.size} bucket${bucketNames.size === 1 ? '' : 's'} found`);
    addCheck('live R2 release bucket exists', 'blocker', bucketNames.has('ahtlauncher'), 'ahtlauncher');
    addCheck('live R2 data bucket exists', 'blocker', bucketNames.has('ahtlauncher-data'), 'ahtlauncher-data');
  }

  const worker = runWrangler(['deployments', 'list', '--config', path.join('cloudflare', 'wrangler.toml')], 120000);
  addCheck(
    'live Worker deployed',
    'blocker',
    worker.ok,
    worker.ok ? 'aht-curseforge-proxy' : worker.detail
  );

  const defaults = readJson(path.join(rootDir, 'config', 'app.defaults.json'));
  const releaseFeed = httpStatus(defaults?.latestUrl || '');
  addCheck(
    'live pack release feed published',
    'warn',
    releaseFeed.ok,
    releaseFeed.ok ? releaseFeed.detail : `${releaseFeed.detail}; publish the first pack update when ready`
  );
  const launcherFeed = httpStatus(defaults?.launcherUpdate?.latestUrl || '');
  addCheck(
    'live launcher update feed published',
    'warn',
    launcherFeed.ok,
    launcherFeed.ok ? launcherFeed.detail : `${launcherFeed.detail}; publish a launcher update when ready`
  );
}

function checkPlayerDefaults() {
  const candidates = [
    path.join(rootDir, 'app.defaults.json'),
    path.join(rootDir, 'config', 'app.defaults.json'),
    path.join(releaseDir, 'win-unpacked', 'app.defaults.json'),
    path.join(releaseDir, 'win-unpacked', 'resources', 'app.defaults.json'),
    path.join(releaseDir, 'windows', 'win-unpacked', 'app.defaults.json'),
    path.join(releaseDir, 'windows', 'win-unpacked', 'resources', 'app.defaults.json'),
    path.join(releaseDir, 'linux-unpacked', 'app.defaults.json'),
    path.join(releaseDir, 'linux-unpacked', 'resources', 'app.defaults.json'),
    path.join(releaseDir, 'ubuntu', 'linux-unpacked', 'app.defaults.json'),
    path.join(releaseDir, 'ubuntu', 'linux-unpacked', 'resources', 'app.defaults.json')
  ];

  const present = candidates.filter((candidate) => fs.existsSync(candidate));
  addCheck('player app defaults exist', 'blocker', present.length > 0, present.length ? present.map((file) => path.relative(rootDir, file)).join(', ') : 'run Developer > Setup Cloud after Cloudflare login');

  for (const defaultsPath of present) {
    const raw = fs.readFileSync(defaultsPath, 'utf8');
    const defaults = readJson(defaultsPath);
    const label = `defaults: ${path.relative(rootDir, defaultsPath)}`;
    const latestUrl = defaults?.latestUrl || '';
    const proxyUrl = defaults?.curseforge?.proxyBaseUrl || '';
    const syncUrl = defaults?.sync?.baseUrl || '';
    const adminUrl = defaults?.developer?.adminBaseUrl || '';
    const urls = [latestUrl, proxyUrl, syncUrl, adminUrl].filter(Boolean);
    const hasLocalOrExample = textIncludesAny(raw, ['127.0.0.1', 'localhost', 'example.workers.dev', 'aht.local']);

    addCheck(`${label} is valid JSON`, 'blocker', Boolean(defaults), label);
    addCheck(`${label} has latestUrl`, 'blocker', /^https?:\/\//i.test(latestUrl), latestUrl || 'missing latestUrl');
    addCheck(`${label} has non-local Worker URLs`, 'blocker', urls.length > 0 && !hasLocalOrExample, urls.join(', ') || 'missing worker URLs');
    addCheck(`${label} has neutral install path`, 'blocker', !Object.hasOwn(defaults || {}, 'instanceDir') && !defaults?.minecraftLauncher?.rootDir, 'installer chooses per OS');
    addCheck(`${label} default RAM is 4096 MB`, 'blocker', Number(defaults?.minecraftLauncher?.memoryMb) === 4096, String(defaults?.minecraftLauncher?.memoryMb ?? 'missing'));
  }
}

function checkArtifacts() {
  const artifacts = [
    path.join(releaseDir, 'A Hard Time Launcher Setup 0.1.0.exe'),
    path.join(releaseDir, 'A Hard Time Launcher Setup 0.1.0.exe.blockmap'),
    path.join(releaseDir, 'win-unpacked', 'A Hard Time Launcher.exe'),
    path.join(releaseDir, 'linux-unpacked'),
    path.join(releaseDir, 'windows', 'AHT-Launcher-Windows-10-11-0.1.0.exe'),
    path.join(releaseDir, 'windows', 'AHT-Launcher-Windows-10-11-0.1.0.exe.blockmap'),
    path.join(releaseDir, 'windows', 'win-unpacked', 'A Hard Time Launcher Windows.exe'),
    path.join(releaseDir, 'ubuntu', 'linux-unpacked'),
    path.join(outputsDir, 'A Hard Time Launcher Setup 0.1.0.exe'),
    path.join(outputsDir, 'A Hard Time Launcher Setup 0.1.0.exe.blockmap'),
    path.join(outputsDir, 'A Hard Time Launcher linux-unpacked.zip'),
    path.join(outputsDir, 'aht-launcher-linux-unpacked.tar.gz'),
    path.join(outputsDir, 'AHT-Launcher-Windows-10-11-0.1.0.exe'),
    path.join(outputsDir, 'AHT-Launcher-Windows-10-11-0.1.0.exe.blockmap'),
    path.join(outputsDir, 'AHT-Launcher-Ubuntu-linux-unpacked.zip'),
    path.join(outputsDir, 'aht-launcher-mvp-source.zip')
  ];

  for (const artifact of artifacts) {
    const ok = existsDir(artifact) || existsNonEmpty(artifact);
    const label = path.relative(rootDir, artifact);
    addCheck(`artifact: ${label}`, 'blocker', ok, label);
  }

  const macOutput = path.join(releaseDir, 'macos');
  addCheck(
    'macOS regular launcher build host',
    'warn',
    process.platform !== 'darwin' || existsDir(macOutput),
    process.platform === 'darwin'
      ? path.relative(rootDir, macOutput)
      : 'macOS DMG must be produced on macOS for signing/notarization'
  );
}

function shortcutCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || os.homedir();
    candidates.push(path.join(userProfile, 'Desktop'));
    candidates.push('D:\\sire_\\Desktop');
    candidates.push(path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'));
  }
  return [...new Set(candidates)];
}

function inspectShortcut(shortcutPath) {
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$w = New-Object -ComObject WScript.Shell',
    `$s = $w.CreateShortcut(${JSON.stringify(shortcutPath)})`,
    '[pscustomobject]@{ TargetPath = $s.TargetPath; Arguments = $s.Arguments; IconLocation = $s.IconLocation } | ConvertTo-Json -Compress'
  ].join('; ');

  const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8',
    timeout: 10000
  });
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

function checkWindowsShortcuts() {
  if (process.platform !== 'win32') {
    addCheck('desktop shortcuts', 'warn', true, 'skipped outside Windows');
    return;
  }

  const names = ['AHT Launcher.lnk', 'AHT Developer Launcher.lnk'];
  const expectedExe = path.join(releaseDir, 'win-unpacked', 'A Hard Time Launcher.exe').toLowerCase();

  for (const name of names) {
    const found = shortcutCandidates()
      .map((dir) => path.join(dir, name))
      .find((candidate) => fs.existsSync(candidate));
    addCheck(`shortcut exists: ${name}`, 'warn', Boolean(found), found || 'not found on known desktops');
    if (!found) {
      continue;
    }

    const shortcut = inspectShortcut(found);
    const target = String(shortcut?.TargetPath || '').toLowerCase();
    const argsText = String(shortcut?.Arguments || '');
    const iconText = String(shortcut?.IconLocation || '').toLowerCase();
    addCheck(`shortcut target: ${name}`, 'warn', target === expectedExe, shortcut?.TargetPath || 'unreadable shortcut target');
    if (name.includes('Developer')) {
      addCheck(`shortcut developer flag: ${name}`, 'warn', argsText.includes('--developer'), argsText || 'missing arguments');
    }
    addCheck(`shortcut icon: ${name}`, 'warn', iconText.includes('icon.ico'), shortcut?.IconLocation || 'missing icon');
  }
}

function run() {
  checkRequiredFiles();
  checkPackageConfig();
  checkCloudflareConfig();
  checkPlayerDefaults();
  checkArtifacts();
  checkWindowsShortcuts();
  command('Wrangler CLI available', 'npx', ['--yes', 'wrangler', '--version']);
  const auth = command('Cloudflare account authenticated', 'npx', ['--yes', 'wrangler', 'whoami'], 30000, {
    invalidOutput: wranglerOutputNeedsLogin
  });
  checkLiveCloudflareState(auth.ok);

  const blockers = checks.filter((check) => check.level === 'blocker' && !check.ok);
  const warnings = checks.filter((check) => check.level === 'warn' && !check.ok);
  const report = {
    ok: blockers.length === 0,
    strict,
    rootDir,
    outputsDir,
    totals: {
      checks: checks.length,
      blockers: blockers.length,
      warnings: warnings.length
    },
    blockers,
    warnings,
    checks
  };

  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`AHT Launcher production readiness: ${report.ok ? 'READY' : 'NOT READY'}`);
    console.log(`Checks: ${checks.length}; blockers: ${blockers.length}; warnings: ${warnings.length}`);
    for (const check of checks) {
      const marker = check.ok ? 'PASS' : check.level === 'warn' ? 'WARN' : 'BLOCK';
      console.log(`[${marker}] ${check.name}${check.detail ? ` - ${check.detail}` : ''}`);
    }
    if (!report.ok) {
      console.log('');
      console.log('Next required step: run Developer > Setup Cloud after Cloudflare login, then re-run this check.');
    }
  }

  if (strict && !report.ok) {
    process.exitCode = 1;
  }
}

run();
