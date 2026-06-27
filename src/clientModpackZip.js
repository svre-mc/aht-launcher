import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import yazl from 'yazl';
import { CLIENT_PACK_FORMAT, CLIENT_PACK_METADATA_ENTRY } from './clientPackFormat.js';
import { ensureDir, pathExists, readJsonFile, slugify } from './utils.js';

export { CLIENT_PACK_FORMAT, CLIENT_PACK_METADATA_ENTRY } from './clientPackFormat.js';
export const CLIENT_PACK_DIRS = [
  'config',
  'fancymenu_data',
  'mods',
  'resourcepacks',
  'resources',
  'scripts',
  'structures'
];
export const CLIENT_PACK_FILES = ['options.txt', 'optionsof.txt'];

const JUNK_FILE_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

function normalizeZipPath(value = '') {
  return String(value).replaceAll('\\', '/').replace(/^\/+/, '');
}

function safeZipPath(value = '') {
  const normalized = normalizeZipPath(value);
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe ZIP path: ${value}`);
  }
  return normalized;
}

function defaultMinecraftFallback(fallback = {}) {
  const version = fallback.version || fallback.minecraftVersion || '1.12.2';
  const modLoaders = Array.isArray(fallback.modLoaders) && fallback.modLoaders.length
    ? fallback.modLoaders
    : [{ id: 'forge-14.23.5.2860', primary: true }];
  return { ...fallback, version, modLoaders };
}

function loaderFromCurseForgeInstance(instance = {}) {
  const base = instance.baseModLoader || instance.modLoader || instance.loader || null;
  if (!base || typeof base !== 'object') return null;
  const forgeVersion = base.forgeVersion || base.version || '';
  const id = base.id || base.name || base.filename || '';
  if (forgeVersion && !String(forgeVersion).startsWith('forge-')) {
    return { id: `forge-${forgeVersion}`, primary: true };
  }
  if (id) {
    return { id: String(id).startsWith('forge-') ? String(id) : `forge-${id}`, primary: true };
  }
  return null;
}

async function detectMinecraft(sourceDir, fallback = {}) {
  const fallbackMinecraft = defaultMinecraftFallback(fallback);
  const instancePath = path.join(sourceDir, 'minecraftinstance.json');
  if (!(await pathExists(instancePath))) {
    return fallbackMinecraft;
  }
  try {
    const instance = await readJsonFile(instancePath);
    const version = instance.gameVersion || instance.minecraftVersion || instance.baseModLoader?.gameVersion || fallbackMinecraft.version;
    const detectedLoader = loaderFromCurseForgeInstance(instance);
    return {
      ...fallbackMinecraft,
      version,
      modLoaders: detectedLoader ? [detectedLoader] : fallbackMinecraft.modLoaders
    };
  } catch {
    return fallbackMinecraft;
  }
}

function shouldSkipFile(relPath = '') {
  const normalized = normalizeZipPath(relPath).toLowerCase();
  const parts = normalized.split('/');
  if (parts.includes('.aht-launcher')) return true;
  if (parts.includes('.git')) return true;
  return JUNK_FILE_NAMES.has(parts.at(-1));
}

async function walkFiles(root, rel = '') {
  const target = path.join(root, rel);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (shouldSkipFile(childRel)) continue;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, childRel));
    } else if (entry.isFile()) {
      files.push(childRel);
    }
  }
  return files.sort((left, right) => normalizeZipPath(left).localeCompare(normalizeZipPath(right)));
}

async function addFile(zip, absPath, relPath, report) {
  const zipPath = safeZipPath(relPath);
  const stat = await fs.stat(absPath);
  zip.addFile(absPath, zipPath, { mtime: stat.mtime });
  report.fileCount += 1;
  report.totalBytes += stat.size;
  report.files.push({ path: zipPath, size: stat.size });
}

export async function createClientModpackZip(options = {}) {
  const sourceDir = path.resolve(String(options.sourceDir || '').trim());
  if (!sourceDir || !(await pathExists(sourceDir))) {
    throw new Error('Client modpack folder is required.');
  }
  const stat = await fs.stat(sourceDir);
  if (!stat.isDirectory()) {
    throw new Error(`Client modpack folder is not a directory: ${sourceDir}`);
  }
  const version = String(options.version || '').trim();
  if (!version) {
    throw new Error('Pack version is required to create a client ZIP.');
  }
  const name = String(options.name || 'A Hard Time').trim() || 'A Hard Time';
  const packId = slugify(options.packId || name);
  const outDir = path.resolve(String(options.outDir || path.join(sourceDir, '.aht-launcher', 'client-zips')));
  await ensureDir(outDir);
  const zipPath = path.join(outDir, `${packId}-${slugify(version)}-client.zip`);
  const tmpPath = `${zipPath}.tmp`;
  await fs.rm(tmpPath, { force: true }).catch(() => {});
  await fs.rm(zipPath, { force: true }).catch(() => {});

  const report = {
    schemaVersion: 1,
    format: CLIENT_PACK_FORMAT,
    sourceDir,
    sourceFolderName: path.basename(sourceDir),
    zipPath,
    name,
    packId,
    version,
    includedRoots: [],
    missingRoots: [],
    fileCount: 0,
    totalBytes: 0,
    files: []
  };

  const zip = new yazl.ZipFile();
  const output = createWriteStream(tmpPath);
  const done = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
  });
  zip.outputStream.pipe(output);

  for (const dirName of CLIENT_PACK_DIRS) {
    const absDir = path.join(sourceDir, dirName);
    if (!(await pathExists(absDir)) || !(await fs.stat(absDir)).isDirectory()) {
      report.missingRoots.push(dirName);
      continue;
    }
    report.includedRoots.push(dirName);
    for (const relFile of await walkFiles(absDir)) {
      await addFile(zip, path.join(absDir, relFile), path.posix.join(dirName, normalizeZipPath(relFile)), report);
    }
  }

  for (const fileName of CLIENT_PACK_FILES) {
    const absFile = path.join(sourceDir, fileName);
    if (!(await pathExists(absFile)) || !(await fs.stat(absFile)).isFile()) {
      report.missingRoots.push(fileName);
      continue;
    }
    report.includedRoots.push(fileName);
    await addFile(zip, absFile, fileName, report);
  }

  const minecraft = await detectMinecraft(sourceDir, options.minecraft || {});
  const metadata = {
    schemaVersion: 1,
    format: CLIENT_PACK_FORMAT,
    packId,
    name,
    version,
    createdAt: new Date().toISOString(),
    sourceFolderName: path.basename(sourceDir),
    minecraft,
    includedRoots: report.includedRoots,
    missingRoots: report.missingRoots,
    fileCount: report.fileCount,
    totalBytes: report.totalBytes,
    settingsFiles: CLIENT_PACK_FILES
  };
  zip.addBuffer(Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'), CLIENT_PACK_METADATA_ENTRY);
  zip.end();
  await done;
  await fs.rename(tmpPath, zipPath);

  return { ...report, minecraft, metadata };
}