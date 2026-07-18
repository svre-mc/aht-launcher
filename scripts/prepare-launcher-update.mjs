#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function listFiles(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function contentType(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (lower.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (lower.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

async function hashFile(file, algorithm = 'sha256') {
  const hash = crypto.createHash(algorithm);
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

function launcherRootUrl(latestUrl) {
  const url = new URL(latestUrl);
  return new URL('../', url).toString();
}

function newestMatch(files, pattern) {
  const matches = files
    .filter((file) => pattern.test(path.basename(file)))
    .map((file) => ({ file, stat: fs.statSync(file) }))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  return matches[0]?.file || '';
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireArtifact(files, pattern, label) {
  const file = newestMatch(files, pattern);
  if (!file) {
    throw new Error(`Missing ${label} launcher artifact matching ${pattern}`);
  }
  return file;
}

async function artifactEntry({ file, key, label, kind, rootUrl, installArgs = [] }) {
  const stat = await fsp.stat(file);
  const fileName = path.basename(file);
  const rel = `launcher/files/${key}/${fileName}`;
  return {
    upload: { rel, file, label, size: stat.size, contentType: contentType(file) },
    entry: {
      label,
      kind,
      fileName,
      path: rel,
      url: new URL(rel, rootUrl).toString(),
      sha256: await hashFile(file, 'sha256'),
      size: stat.size,
      installArgs
    }
  };
}

function trackedInstallerUrl(entryUrl, downloadKey) {
  const url = new URL(entryUrl);
  url.searchParams.set('aht_download', downloadKey);
  return url.toString();
}

function addAliases(platforms, aliases, entry) {
  for (const alias of aliases) {
    platforms[alias] = { ...entry };
  }
}

function defaultLatestUrl(config) {
  return process.env.AHT_LAUNCHER_UPDATE_URL
    || config?.launcherUpdate?.latestUrl
    || 'https://aht-curseforge-proxy.mysticgamer312.workers.dev/launcher/latest.json';
}

function requireHttpsLatestUrl(latestUrl = '') {
  let parsed = null;
  try {
    parsed = new URL(String(latestUrl || ''));
  } catch {
    throw new Error('Launcher update latest URL must be a valid HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Launcher update latest URL must be HTTPS.');
  }
  return parsed.toString();
}

export async function prepareLauncherUpdate(options = {}) {
  const packageJson = await readJson(path.join(repoRoot, 'package.json'), {});
  const config = await readJson(path.join(repoRoot, 'config', 'app.defaults.json'), {});
  const artifactsDir = path.resolve(options.artifactsDir || 'ci-artifacts');
  const outDir = path.resolve(options.outDir || 'ci-launcher-update');
  const version = String(options.version || process.env.AHT_LAUNCHER_VERSION || packageJson.version || '').trim();
  const latestUrl = requireHttpsLatestUrl(String(options.latestUrl || defaultLatestUrl(config)).trim());

  if (!version) throw new Error('Launcher version is required.');
  if (!latestUrl) throw new Error('Launcher update latest URL is required.');
  if (!fs.existsSync(artifactsDir)) throw new Error(`Artifacts directory does not exist: ${artifactsDir}`);

  const rootUrl = launcherRootUrl(latestUrl);
  const files = await listFiles(artifactsDir);
  const artifactVersion = escapeRegExp(version);
  const windowsFile = requireArtifact(files, new RegExp(`^AHT-Launcher-Windows-10-11-${artifactVersion}\\.exe$`, 'i'), 'Windows 10/11');
  const macArmUpdateFile = requireArtifact(files, new RegExp(`^AHT-Launcher-macOS-arm64-${artifactVersion}\\.zip$`, 'i'), 'macOS Apple Silicon update ZIP');
  const macX64UpdateFile = requireArtifact(files, new RegExp(`^AHT-Launcher-macOS-x64-${artifactVersion}\\.zip$`, 'i'), 'macOS Intel update ZIP');
  const macArmInstallerFile = requireArtifact(files, new RegExp(`^AHT-Launcher-macOS-arm64-${artifactVersion}\\.dmg$`, 'i'), 'macOS Apple Silicon DMG');
  const macX64InstallerFile = requireArtifact(files, new RegExp(`^AHT-Launcher-macOS-x64-${artifactVersion}\\.dmg$`, 'i'), 'macOS Intel DMG');

  const platforms = {};
  const uploads = [];

  const windows = await artifactEntry({
    file: windowsFile,
    key: 'win32-x64',
    label: 'Windows 10/11',
    kind: 'nsis',
    rootUrl,
    installArgs: ['/S']
  });
  uploads.push(windows.upload);
  addAliases(platforms, ['win32-x64', 'win32', 'windows', 'windows-x64'], windows.entry);

  const macArm = await artifactEntry({
    file: macArmUpdateFile,
    key: 'darwin-arm64',
    label: 'macOS Apple Silicon',
    kind: 'zip',
    rootUrl
  });
  uploads.push(macArm.upload);
  addAliases(platforms, ['darwin-arm64', 'macos-arm64'], macArm.entry);

  const macX64 = await artifactEntry({
    file: macX64UpdateFile,
    key: 'darwin-x64',
    label: 'macOS Intel',
    kind: 'zip',
    rootUrl
  });
  uploads.push(macX64.upload);
  addAliases(platforms, ['darwin-x64', 'macos-x64', 'darwin', 'macos'], macX64.entry);

  const macArmInstaller = await artifactEntry({
    file: macArmInstallerFile,
    key: 'darwin-arm64',
    label: 'macOS Apple Silicon installer',
    kind: 'dmg',
    rootUrl
  });
  uploads.push(macArmInstaller.upload);

  const macX64Installer = await artifactEntry({
    file: macX64InstallerFile,
    key: 'darwin-x64',
    label: 'macOS Intel installer',
    kind: 'dmg',
    rootUrl
  });
  uploads.push(macX64Installer.upload);

  const downloads = {
    'windows-x64': { ...windows.entry, url: trackedInstallerUrl(windows.entry.url, 'windows-x64') },
    'macos-arm64': { ...macArmInstaller.entry, url: trackedInstallerUrl(macArmInstaller.entry.url, 'macos-arm64') },
    'macos-x64': { ...macX64Installer.entry, url: trackedInstallerUrl(macX64Installer.entry.url, 'macos-x64') }
  };

  const manifest = {
    schemaVersion: 1,
    product: 'aht-launcher',
    name: 'A Hard Time Launcher',
    version,
    required: true,
    createdAt: new Date().toISOString(),
    currentVersion: version,
    source: {
      repository: process.env.GITHUB_REPOSITORY || '',
      commit: process.env.GITHUB_SHA || '',
      runId: process.env.GITHUB_RUN_ID || ''
    },
    platforms,
    downloads
  };

  const manifestPath = path.join(outDir, 'launcher', 'latest.json');
  await writeJson(manifestPath, manifest);
  uploads.push({
    rel: 'launcher/latest.json',
    file: manifestPath,
    label: 'launcher/latest.json',
    size: (await fsp.stat(manifestPath)).size,
    contentType: contentType(manifestPath)
  });

  const plan = {
    schemaVersion: 1,
    latestUrl,
    rootUrl,
    version,
    uploads
  };
  const planPath = path.join(outDir, 'upload-plan.json');
  await writeJson(planPath, plan);

  return { manifestPath, planPath, manifest, plan };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  prepareLauncherUpdate({
    artifactsDir: args.artifacts,
    outDir: args.out,
    version: args.version,
    latestUrl: args['latest-url']
  }).then((result) => {
    console.log(JSON.stringify({
      ok: true,
      version: result.manifest.version,
      latestUrl: result.plan.latestUrl,
      manifestPath: result.manifestPath,
      planPath: result.planPath,
      uploads: result.plan.uploads.map((item) => ({ rel: item.rel, size: item.size }))
    }, null, 2));
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
