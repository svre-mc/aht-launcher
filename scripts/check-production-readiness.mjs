import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_PACK_FORMAT } from '../src/clientPackFormat.js';
import { validateLauncherUpdateManifest } from './validate-launcher-update-manifest.mjs';

const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const jsonOnly = args.has('--json');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const outputsDir = path.resolve(rootDir, '..', '..', 'outputs');
const releaseDir = path.join(rootDir, 'release-builds');
const checks = [];
const developerOnlyAsarSourcePattern = /^src\/(?:releaseBuilder|clientModpackZip|serverTransfer|githubActions|r2DirectUpload)\.js$/;
const developerOnlyAsarDependencyPattern = /^node_modules\/(?:@aws-sdk|@smithy|@aws-crypto|ssh2|yazl)(?:\/|$)/;
const forbiddenPublicAsarRootPattern = /^(?:cloudflare|server-lock-mod)(?:\/|$)/;
const privateServerTransferFragments = [
  'C:\\RL CRAFT SERVER LIST',
  '192.168.1.121',
  'notevil',
  '/home/notevil'
];
const runtimeTextExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json', '.mjs', '.txt']);
let asarModule = null;

function normalizeAsarEntry(entry = '') {
  return String(entry || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function listAsarEntries(asarPath) {
  try {
    asarModule ||= require('@electron/asar');
    return { ok: true, entries: asarModule.listPackage(asarPath).map(normalizeAsarEntry) };
  } catch (error) {
    return { ok: false, entries: [], error: error?.message || String(error) };
  }
}

function runtimeTextEntry(entry = '') {
  const normalized = normalizeAsarEntry(entry);
  return runtimeTextExtensions.has(path.extname(normalized).toLowerCase())
    || normalized === 'package.json';
}

function forbiddenRuntimeContentHits(label, sourceName, raw = '') {
  const hits = [];
  for (const fragment of privateServerTransferFragments) {
    if (String(raw || '').includes(fragment)) {
      hits.push(`${sourceName} (${label}: ${fragment})`);
    }
  }
  return hits;
}

function forbiddenRuntimeImportHits(sourceName, raw = '') {
  const hits = [];
  if (sourceName === 'src/installer.js' && String(raw || '').includes("clientModpackZip.js")) {
    hits.push(`${sourceName} imports developer-only clientModpackZip.js`);
  }
  return hits;
}

function checkAsarRuntimeContent(label, asarPath, entries) {
  const hits = [];
  asarModule ||= require('@electron/asar');
  for (const entry of entries.filter(runtimeTextEntry)) {
    let raw = '';
    try {
      raw = asarModule.extractFile(asarPath, entry).toString('utf8');
    } catch {
      continue;
    }
    hits.push(...forbiddenRuntimeContentHits('private server-transfer default', entry, raw));
    hits.push(...forbiddenRuntimeImportHits(entry, raw));
  }
  addCheck(`${label} has no forbidden runtime imports or private defaults`, 'blocker', hits.length === 0, hits.slice(0, 10).join(', ') || 'clean');
}

function checkPublicPlayerAsar(label, asarPath) {
  const relative = path.relative(rootDir, asarPath) || asarPath;
  if (!existsNonEmpty(asarPath)) {
    addCheck(`${label} exists`, 'blocker', false, relative);
    return;
  }
  addCheck(`${label} exists`, 'blocker', true, relative);
  const listed = listAsarEntries(asarPath);
  addCheck(`${label} is readable`, 'blocker', listed.ok, listed.ok ? `${listed.entries.length} entries` : listed.error);
  if (!listed.ok) {
    return;
  }
  const hits = listed.entries.filter((entry) => (
    developerOnlyAsarSourcePattern.test(entry)
    || developerOnlyAsarDependencyPattern.test(entry)
    || forbiddenPublicAsarRootPattern.test(entry)
  ));
  addCheck(`${label} excludes developer internals`, 'blocker', hits.length === 0, hits.slice(0, 12).join(', ') || 'clean');
  const requiredRuntimeEntries = ['src/clientPackFormat.js'];
  const missingRuntimeEntries = requiredRuntimeEntries.filter((entry) => !listed.entries.includes(entry));
  addCheck(`${label} includes required player runtime modules`, 'blocker', missingRuntimeEntries.length === 0, missingRuntimeEntries.join(', ') || 'clean');
  checkAsarRuntimeContent(label, asarPath, listed.entries);
}

function addCheck(name, level, ok, detail = '') {
  checks.push({ name, level, ok: Boolean(ok), detail });
}
function nextRequiredStep(blockers = []) {
  const names = blockers.map((check) => check.name);
  const stalePackFeed = names.includes('live pack release is exact AHT client ZIP');
  const staleLauncherFeed = names.includes('live launcher update feed matches local version')
    || names.includes('live launcher update feed has Windows and macOS downloads');
  if (stalePackFeed && staleLauncherFeed) {
    return 'publish an exact AHT client ZIP release and a launcher update for the current package version when ready, then re-run this check.';
  }
  if (stalePackFeed) {
    return 'publish an exact AHT client ZIP release from the Developer launcher when ready, then re-run this check.';
  }
  if (staleLauncherFeed) {
    return 'publish a launcher update for the current package version when ready, then re-run this check.';
  }
  if (names.includes('Cloudflare account authenticated') || names.some((name) => name.startsWith('live R2 ') || name === 'live Worker deployed')) {
    return 'run Developer > Setup Cloud after Cloudflare login, then re-run this check.';
  }
  if (names.some((name) => name.startsWith('artifact:') || name === 'Windows artifact is newer than packaged source')) {
    return 'rebuild and reinstall the Windows launcher locally, then re-run this check.';
  }
  if (names.some((name) => name.includes('ASAR'))) {
    return 'rebuild the public player package and verify the installed ASAR, then re-run this check.';
  }
  return 'fix the blocker(s) listed above, then re-run this check.';
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

function collectFiles(relativePaths) {
  const files = [];
  const visit = (filePath) => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(filePath)) {
        visit(path.join(filePath, child));
      }
      return;
    }
    if (stat.isFile()) {
      files.push(filePath);
    }
  };
  for (const relativePath of relativePaths) {
    visit(path.join(rootDir, relativePath));
  }
  return files;
}

function newestFile(files) {
  let newest = { path: '', mtimeMs: 0 };
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs > newest.mtimeMs) {
        newest = { path: file, mtimeMs: stat.mtimeMs };
      }
    } catch {}
  }
  return newest;
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
    || lines.find((line) => !/wrangler|^-+$|getting user settings/i.test(line))
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
function httpJsonStatus(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return { ok: false, status: 0, detail: 'missing URL', json: null };
  }
  const script = [
    'const url = process.argv[1];',
    'fetch(url, { method: "GET", headers: { Accept: "application/json" } })',
    '  .then(async (response) => {',
    '    const text = await response.text().catch(() => "");',
    '    let json = null;',
    '    let parseError = "";',
    '    try { json = JSON.parse(text); } catch (error) { parseError = error.message || String(error); }',
    '    console.log(JSON.stringify({ status: response.status, responseOk: response.ok, parseError, json, body: text.slice(0, 180) }));',
    '  })',
    '  .catch((error) => {',
    '    console.log(JSON.stringify({ status: 0, responseOk: false, parseError: error.message || String(error), json: null, body: "" }));',
    '    process.exitCode = 1;',
    '  });'
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script, url], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 30000
  });
  const raw = result.stdout?.trim() || '';
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {}
  const status = Number(parsed?.status || 0);
  const ok = result.status === 0 && Boolean(parsed?.responseOk) && Boolean(parsed?.json);
  const parseDetail = parsed?.parseError ? `; JSON parse failed: ${parsed.parseError}` : '';
  return {
    ok,
    status,
    json: parsed?.json || null,
    detail: ok ? `${status} ${url}` : `${status || 'ERR'} ${parsed?.body || result.stderr || result.error || url}${parseDetail}`
  };
}

function validateLauncherDownloads(manifest = {}, latestUrl = '') {
  const result = validateLauncherUpdateManifest(manifest, { latestUrl });
  return result.ok ? [] : result.errors;
}

function liveLauncherProofStatus(baseUrl) {
  if (!/^https?:\/\//i.test(String(baseUrl || ''))) {
    return { ok: false, detail: 'missing launcher proof Worker URL' };
  }
  const script = [
    'const base = process.argv[1];',
    'const username = "AHTProofCheck";',
    'const installId = "aht-production-readiness-proof";',
    'async function post(path, body) {',
    '  const response = await fetch(new URL(path, base), {',
    '    method: "POST",',
    '    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "AHT production readiness" },',
    '    body: JSON.stringify(body)',
    '  });',
    '  const json = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));',
    '  return { response, json };',
    '}',
    '(async () => {',
    '  const registration = await post("api/users/register", { username, installId, platform: process.platform, arch: process.arch, packId: "a-hard-time-dregora", appVersion: "readiness" });',
    '  if (!registration.response.ok) throw new Error(`register ${registration.response.status}: ${registration.json.error || "failed"}`);',
    '  const proof = await post("api/launcher-proof", {',
    '    protocol: "aht-launcher-proof-v1",',
    '    schemaVersion: 1,',
    '    launchId: `readiness-${Date.now()}`,',
    '    packId: "a-hard-time-dregora",',
    '    packVersion: "readiness",',
    '    latestVersion: "readiness",',
    '    installedVersion: "readiness",',
    '    minecraftUsername: username,',
    '    installId,',
    '    appVersion: "readiness",',
    '    platform: process.platform,',
    '    arch: process.arch,',
    '    launcherChannel: "player",',
    '    developerClient: false,',
    '    developerClientBypass: false,',
    '    modIntegrityBypass: false,',
    '    instanceDirHash: "0".repeat(64),',
    '    minecraft: { version: "1.12.2", modLoaders: [{ id: "forge-14.23.5.2860", primary: true }] }',
    '  });',
    '  const tokenParts = String(proof.json.token || "").split(".").length;',
    '  const ok = proof.response.ok && proof.json.trusted === true && proof.json.source === "worker" && tokenParts === 3;',
    '  console.log(JSON.stringify({ ok, status: proof.response.status, source: proof.json.source || "", trusted: Boolean(proof.json.trusted), tokenParts, error: proof.json.error || "" }));',
    '  if (!ok) process.exitCode = 1;',
    '})().catch((error) => { console.log(JSON.stringify({ ok: false, status: 0, error: error.message || String(error) })); process.exitCode = 1; });'
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script, baseUrl], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 30000
  });
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return {
      ok: Boolean(parsed.ok),
      detail: parsed.ok
        ? `signed by ${parsed.source}; token parts ${parsed.tokenParts}`
        : `${parsed.status || 0}: ${parsed.error || 'launcher proof signing failed'}`
    };
  } catch {
    return { ok: false, detail: commandDetail(`${result.stdout || ''}${result.stderr || ''}`, 'launcher proof request failed') };
  }
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
    'pack-fixes/aht-item-fire-fix-fabric-26.1.2-1.0.0.jar',
    'pack-fixes/aht-item-fire-fix-forge-1.0.0.jar'
  ];

  for (const relativePath of files) {
    addCheck(`source file: ${relativePath}`, 'blocker', existsNonEmpty(path.join(rootDir, relativePath)), relativePath);
  }
  const staleRootFiles = ['installer.js', 'main.js', 'clientPackFormat.js'];
  const presentStaleRootFiles = staleRootFiles.filter((file) => fs.existsSync(path.join(rootDir, file)));
  addCheck(
    'stale extracted root runtime files absent',
    'blocker',
    presentStaleRootFiles.length === 0,
    presentStaleRootFiles.length
      ? `${presentStaleRootFiles.join(', ')} must not exist at repo root`
      : 'clean'
  );
}

function checkPackageConfig() {
  const packageJson = readJson(path.join(rootDir, 'package.json'));
  addCheck('package.json is readable', 'blocker', Boolean(packageJson), 'package metadata');
  if (!packageJson) {
    return;
  }

  addCheck('Windows app id is AHT branded', 'blocker', packageJson.build?.appId === 'com.ahardtime.launcher', packageJson.build?.appId || 'missing appId');
  addCheck('Windows installer script exists', 'blocker', Boolean(packageJson.scripts?.['dist:win']), 'npm run dist:win');
  addCheck('macOS package script exists', 'blocker', Boolean(packageJson.scripts?.['dist:mac']), 'npm run dist:mac');
  addCheck('Windows regular launcher script exists', 'blocker', Boolean(packageJson.scripts?.['dist:regular:windows']), 'npm run dist:regular:windows');
  addCheck('macOS regular launcher script exists', 'blocker', Boolean(packageJson.scripts?.['dist:regular:macos']), 'npm run dist:regular:macos');
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
  const packageJson = readJson(path.join(rootDir, 'package.json'));
  const localLauncherVersion = String(packageJson?.version || '').trim();
  const releaseFeed = httpJsonStatus(defaults?.latestUrl || '');
  addCheck(
    'live pack release feed published',
    'warn',
    releaseFeed.ok,
    releaseFeed.ok ? releaseFeed.detail : `${releaseFeed.detail}; publish the first pack update when ready`
  );
  const latest = releaseFeed.json || null;
  const fullClientRelease = latest?.installMode === 'full-client-zip' || latest?.zipFormat === CLIENT_PACK_FORMAT;
  addCheck(
    'live pack release is exact AHT client ZIP',
    'blocker',
    Boolean(releaseFeed.ok && fullClientRelease),
    releaseFeed.ok
      ? (fullClientRelease
        ? `${latest.version || 'unknown version'} ${latest.zip?.fileName || latest.zip?.path || ''}`.trim()
        : `published ${latest?.version || 'unknown version'} is legacy CurseForge/cache format; publish an exact AHT client ZIP before sending players`)
      : 'release feed unavailable'
  );
  const launcherFeed = httpJsonStatus(defaults?.launcherUpdate?.latestUrl || '');
  addCheck(
    'live launcher update feed published',
    'warn',
    launcherFeed.ok,
    launcherFeed.ok ? launcherFeed.detail : `${launcherFeed.detail}; publish a launcher update when ready`
  );
  const liveLauncherVersion = String(launcherFeed.json?.version || launcherFeed.json?.currentVersion || '').trim();
  addCheck(
    'live launcher update feed matches local version',
    'blocker',
    Boolean(launcherFeed.ok && localLauncherVersion && liveLauncherVersion === localLauncherVersion),
    launcherFeed.ok
      ? `live ${liveLauncherVersion || 'missing version'}, local ${localLauncherVersion || 'missing version'}`
      : 'launcher update feed unavailable'
  );
  const launcherDownloadProblems = launcherFeed.ok
    ? validateLauncherDownloads(launcherFeed.json, defaults?.launcherUpdate?.latestUrl || '')
    : ['launcher update feed unavailable'];
  addCheck(
    'live launcher update feed has Windows and macOS downloads',
    'blocker',
    Boolean(launcherFeed.ok && launcherDownloadProblems.length === 0),
    launcherDownloadProblems.join(', ') || 'windows-x64, macos-arm64, macos-x64'
  );
  const proofBaseUrl = defaults?.launcherProof?.baseUrl || defaults?.sync?.baseUrl || '';
  const proofStatus = liveLauncherProofStatus(proofBaseUrl);
  addCheck(
    'live launcher proof signing works',
    'blocker',
    proofStatus.ok,
    proofStatus.detail
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
    const urls = [latestUrl, proxyUrl, syncUrl].filter(Boolean);
    const hasLocalOrExample = textIncludesAny(raw, ['127.0.0.1', 'localhost', 'example.workers.dev', 'aht.local']);

    addCheck(`${label} is valid JSON`, 'blocker', Boolean(defaults), label);
    addCheck(`${label} has latestUrl`, 'blocker', /^https?:\/\//i.test(latestUrl), latestUrl || 'missing latestUrl');
    const launcherProof = defaults?.launcherProof || {};
    const proofBaseUrl = launcherProof.baseUrl || syncUrl;
    addCheck(`${label} has non-local Worker URLs`, 'blocker', urls.length > 0 && !hasLocalOrExample, urls.join(', ') || 'missing worker URLs');
    addCheck(`${label} has neutral install path`, 'blocker', !Object.hasOwn(defaults || {}, 'instanceDir') && !defaults?.minecraftLauncher?.rootDir, 'installer chooses per OS');
    addCheck(`${label} has no developer defaults`, 'blocker', !Object.hasOwn(defaults || {}, 'developer'), Object.hasOwn(defaults || {}, 'developer') ? 'remove developer block from player defaults' : 'player-only defaults');
    addCheck(`${label} default RAM is 4096 MB`, 'blocker', Number(defaults?.minecraftLauncher?.memoryMb) === 4096, String(defaults?.minecraftLauncher?.memoryMb ?? 'missing'));
    addCheck(`${label} launcher proof enabled`, 'blocker', launcherProof.enabled !== false, `enabled=${String(launcherProof.enabled)}`);
    addCheck(`${label} launcher proof required`, 'blocker', launcherProof.required === true, `required=${String(launcherProof.required)}`);
    addCheck(`${label} launcher proof has Worker URL`, 'blocker', /^https?:\/\//i.test(proofBaseUrl) && !textIncludesAny(proofBaseUrl, ['127.0.0.1', 'localhost', 'example.workers.dev', 'aht.local']), proofBaseUrl || 'missing proof Worker URL');
    addCheck(`${label} launcher proof key id`, 'blocker', (launcherProof.keyId || '') === 'aht-launcher-proof-v1', launcherProof.keyId || 'missing key id');
  }
}

function checkArtifacts() {
  const packageJson = readJson(path.join(rootDir, 'package.json')) || {};
  const version = String(packageJson.version || '').trim();
  addCheck('artifact version source', 'blocker', Boolean(version), version || 'missing package version');
  if (!version) {
    return;
  }

  const artifacts = [
    path.join(releaseDir, 'windows', `AHT-Launcher-Windows-10-11-${version}.exe`),
    path.join(releaseDir, 'windows', `AHT-Launcher-Windows-10-11-${version}.exe.blockmap`),
    path.join(releaseDir, 'windows', 'win-unpacked', 'A Hard Time Launcher Windows.exe')
  ];

  for (const artifact of artifacts) {
    const ok = existsDir(artifact) || existsNonEmpty(artifact);
    const label = path.relative(rootDir, artifact);
    addCheck(`artifact: ${label}`, 'blocker', ok, label);
  }

  const sourceFiles = collectFiles([
    'build',
    'cloudflare',
    'config',
    'desktop',
    'pack-fixes',
    'src',
    'package.json',
    'package-lock.json'
  ]);
  const newestSource = newestFile(sourceFiles);
  const primaryArtifact = artifacts[0];
  let artifactFresh = false;
  let artifactFreshDetail = 'missing source or artifact timestamps';
  try {
    const artifactStat = fs.statSync(primaryArtifact);
    artifactFresh = artifactStat.mtimeMs + 1000 >= newestSource.mtimeMs;
    artifactFreshDetail = artifactFresh
      ? `${path.relative(rootDir, primaryArtifact)} is current`
      : `${path.relative(rootDir, primaryArtifact)} is older than ${path.relative(rootDir, newestSource.path)}`;
  } catch {
    artifactFreshDetail = `${path.relative(rootDir, primaryArtifact)} missing`;
  }
  addCheck('Windows artifact is newer than packaged source', 'blocker', artifactFresh, artifactFreshDetail);

  const builtAsar = path.join(releaseDir, 'windows', 'win-unpacked', 'resources', 'app.asar');
  checkPublicPlayerAsar('built Windows ASAR', builtAsar);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installedAsar = path.join(process.env.LOCALAPPDATA, 'Programs', 'A Hard Time Launcher Windows', 'resources', 'app.asar');
    checkPublicPlayerAsar('installed Windows ASAR', installedAsar);
  }

  const staleArtifacts = [];
  for (const dir of [releaseDir, path.join(releaseDir, 'windows'), outputsDir]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/AHT-Launcher-Windows-10-11-\d+\.\d+\.\d+/.test(name) && !name.includes(version)) {
          staleArtifacts.push(path.relative(rootDir, path.join(dir, name)));
        }
      }
    } catch {}
  }
  addCheck('stale launcher artifacts ignored', 'warn', staleArtifacts.length === 0, staleArtifacts.join(', ') || 'none');

  const macOutput = path.join(releaseDir, 'macos');
  addCheck(
    'macOS regular launcher build host',
    'warn',
    process.platform !== 'darwin' || existsDir(macOutput),
    process.platform === 'darwin'
      ? path.relative(rootDir, macOutput)
      : 'macOS DMG and ZIP must be produced on macOS for signing/notarization'
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

  const names = ['AHT Launcher.lnk'];
  const installedExe = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'A Hard Time Launcher Windows', 'A Hard Time Launcher Windows.exe')
    : '';
  const expectedTargets = [
    installedExe,
    path.join(releaseDir, 'windows', 'win-unpacked', 'A Hard Time Launcher Windows.exe'),
    path.join(releaseDir, 'win-unpacked', 'A Hard Time Launcher.exe')
  ].filter(Boolean).map((item) => path.resolve(item).toLowerCase());

  for (const name of names) {
    const found = shortcutCandidates()
      .map((dir) => path.join(dir, name))
      .find((candidate) => fs.existsSync(candidate));
    addCheck(`shortcut exists: ${name}`, 'warn', Boolean(found), found || 'not found on known desktops');
    if (!found) {
      continue;
    }

    const shortcut = inspectShortcut(found);
    const targetRaw = String(shortcut?.TargetPath || '');
    const target = targetRaw ? path.resolve(targetRaw).toLowerCase() : '';
    const argsText = String(shortcut?.Arguments || '');
    const iconText = String(shortcut?.IconLocation || '').toLowerCase();
    const targetOk = expectedTargets.includes(target) || /a hard time launcher(?: windows)?\.exe$/i.test(targetRaw);
    const iconOk = iconText.includes('icon.ico') || (target && iconText.startsWith(target));
    addCheck(`shortcut target: ${name}`, 'warn', targetOk, shortcut?.TargetPath || 'unreadable shortcut target');
    addCheck(`shortcut has no developer flag: ${name}`, 'warn', !argsText.includes('--developer'), argsText || 'no arguments');
    addCheck(`shortcut icon: ${name}`, 'warn', iconOk, shortcut?.IconLocation || 'missing icon');
  }
}

function checkPublicSourceHygiene() {
  const textExtensions = new Set([
    '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.nsh', '.ps1', '.sh', '.toml', '.txt', '.yml', '.yaml'
  ]);
  const files = collectFiles([
    '.github',
    'build',
    'cloudflare',
    'config',
    'desktop',
    'docs',
    'scripts',
    'src',
    'package.json',
    'package-lock.json'
  ]).filter((file) => textExtensions.has(path.extname(file).toLowerCase()) || path.basename(file) === 'package.json' || path.basename(file) === 'package-lock.json');
  const forbidden = [
    { label: 'local Windows user path', pattern: /C:\\\\Users\\\\evil/i },
    { label: 'real developer password', pattern: new RegExp('@' + '312' + 'Princ', 'i') }
  ];
  const hits = [];
  for (const file of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const item of forbidden) {
      if (item.pattern.test(raw)) {
        hits.push(`${path.relative(rootDir, file)} (${item.label})`);
      }
    }
  }
  addCheck('public source has no local user paths or real secrets', 'blocker', hits.length === 0, hits.slice(0, 8).join(', ') || 'clean');

  const runtimeSourceFiles = collectFiles(['desktop', 'config', 'src', 'package.json'])
    .filter((file) => textExtensions.has(path.extname(file).toLowerCase()) || path.basename(file) === 'package.json');
  const runtimeHits = [];
  for (const file of runtimeSourceFiles) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    runtimeHits.push(...forbiddenRuntimeContentHits('private server-transfer default', path.relative(rootDir, file), raw));
  }
  addCheck('public runtime source has no private server-transfer defaults', 'blocker', runtimeHits.length === 0, runtimeHits.slice(0, 10).join(', ') || 'clean');
}

function run() {
  checkRequiredFiles();
  checkPackageConfig();
  checkCloudflareConfig();
  checkPlayerDefaults();
  checkArtifacts();
  checkWindowsShortcuts();
  checkPublicSourceHygiene();
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
    checks,
    nextRequiredStep: nextRequiredStep(blockers)
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
      console.log(`Next required step: ${report.nextRequiredStep}`);
    }
  }

  if (strict && (!report.ok || warnings.length > 0)) {
    process.exitCode = 1;
  }
}

run();
