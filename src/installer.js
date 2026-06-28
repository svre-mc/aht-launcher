import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import yauzl from 'yauzl';
import { CLIENT_PACK_FORMAT, CLIENT_PACK_METADATA_ENTRY } from './clientPackFormat.js';
import { getHash, getModFile, getModFileDownloadUrl } from './curseforge.js';
import {
  downloadToFile,
  ensureDir,
  filePathToSource,
  hashFile,
  isHttpUrl,
  normalizeRelPath,
  pathExists,
  readJsonFile,
  readJsonFromSource,
  removeFileIfExists,
  resolveSource,
  safeJoin,
  writeJsonFile
} from './utils.js';

function isFullClientZipRelease(latest = {}) {
  return latest?.installMode === 'full-client-zip' || latest?.zipFormat === CLIENT_PACK_FORMAT;
}

function isGameSettingsRelPath(relPath = '') {
  const normalized = normalizeRelPath(relPath).toLowerCase();
  return normalized === 'options.txt' || normalized === 'optionsof.txt';
}

function stripClientPackRoot(relPath = '', rootPrefix = '') {
  const normalized = normalizeRelPath(relPath);
  if (!rootPrefix) return normalized;
  return normalized.startsWith(rootPrefix) ? normalizeRelPath(normalized.slice(rootPrefix.length)) : '';
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function zipEntryIsFile(entry) {
  return entry && !String(entry.fileName || '').endsWith('/');
}

function safeClientZipRelPath(entryName = '', rootPrefix = '') {
  const relPath = stripClientPackRoot(entryName, rootPrefix);
  if (!relPath || relPath === CLIENT_PACK_METADATA_ENTRY || relPath.startsWith('../') || relPath.includes('/../') || path.isAbsolute(relPath)) {
    return '';
  }
  return relPath;
}

function openZipFile(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error) reject(error);
      else resolve(zipFile);
    });
  });
}

function openZipEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, readStream) => {
      if (error) reject(error);
      else resolve(readStream);
    });
  });
}

async function forEachZipEntry(filePath, handler) {
  const zipFile = await openZipFile(filePath);
  try {
    await new Promise((resolve, reject) => {
      let stopped = false;
      const fail = (error) => {
        if (stopped) return;
        stopped = true;
        reject(error);
      };
      zipFile.on('entry', (entry) => {
        Promise.resolve(handler(entry, zipFile))
          .then(() => {
            if (!stopped) {
              zipFile.readEntry();
            }
          })
          .catch(fail);
      });
      zipFile.on('end', () => {
        if (!stopped) {
          stopped = true;
          resolve();
        }
      });
      zipFile.on('error', fail);
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
}

async function readZipEntryBuffer(zipFile, entry, maxBytes = 5 * 1024 * 1024) {
  const stream = await openZipEntryStream(zipFile, entry);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`ZIP entry too large to inspect: ${entry.fileName}`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readClientPackMetadataFromFile(packZipPath) {
  const matches = [];
  await forEachZipEntry(packZipPath, async (entry, zipFile) => {
    if (!zipEntryIsFile(entry)) {
      return;
    }
    const entryName = normalizeRelPath(entry.fileName);
    if (entryName !== CLIENT_PACK_METADATA_ENTRY && !entryName.endsWith(`/${CLIENT_PACK_METADATA_ENTRY}`)) {
      return;
    }
    const metadata = JSON.parse((await readZipEntryBuffer(zipFile, entry)).toString('utf8'));
    if (metadata?.format !== CLIENT_PACK_FORMAT) {
      throw new Error(`${CLIENT_PACK_METADATA_ENTRY} has unsupported format: ${metadata?.format || 'missing'}`);
    }
    matches.push({ entryName, metadata });
  });
  if (!matches.length) {
    return null;
  }
  const direct = matches.find((match) => match.entryName === CLIENT_PACK_METADATA_ENTRY);
  if (direct) {
    return { ...direct, rootPrefix: '' };
  }
  if (matches.length > 1) {
    throw new Error(`Found multiple ${CLIENT_PACK_METADATA_ENTRY} files in full client ZIP.`);
  }
  const entryName = matches[0].entryName;
  return {
    ...matches[0],
    rootPrefix: entryName.endsWith(CLIENT_PACK_METADATA_ENTRY) ? entryName.slice(0, -CLIENT_PACK_METADATA_ENTRY.length) : ''
  };
}

async function inspectFullClientZipFile(packZipPath) {
  const metadataRecord = await readClientPackMetadataFromFile(packZipPath);
  if (!metadataRecord) {
    throw new Error(`${CLIENT_PACK_METADATA_ENTRY} missing from full client ZIP.`);
  }
  let fileCount = 0;
  let modFileCount = 0;
  await forEachZipEntry(packZipPath, async (entry) => {
    if (!zipEntryIsFile(entry)) {
      return;
    }
    const relPath = safeClientZipRelPath(entry.fileName, metadataRecord.rootPrefix);
    if (!relPath) {
      return;
    }
    fileCount += 1;
    if (relPath.toLowerCase().startsWith('mods/') && /\.(jar|zip)$/i.test(relPath)) {
      modFileCount += 1;
    }
    if (fileCount % 250 === 0) {
      await yieldToEventLoop();
    }
  });
  return { ...metadataRecord, fileCount, modFileCount };
}

async function extractZipEntryToFile(zipFile, entry, target, shouldHash) {
  const readStream = await openZipEntryStream(zipFile, entry);
  const output = createWriteStream(target);
  if (!shouldHash) {
    try {
      await pipeline(readStream, output);
      return null;
    } catch (error) {
      await removeFileIfExists(target);
      throw error;
    }
  }
  const hash = createHash('sha256');
  const hashStream = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(readStream, hashStream, output);
    return hash.digest('hex');
  } catch (error) {
    await removeFileIfExists(target);
    throw error;
  }
}

async function walkInstanceFiles(root, rel = '') {
  if (!(await pathExists(root))) {
    return [];
  }
  const stat = await fs.stat(root);
  if (stat.isFile()) {
    return [{ abs: root, rel: normalizeRelPath(rel), size: stat.size }];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    const childAbs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkInstanceFiles(childAbs, childRel));
    } else if (entry.isFile()) {
      const childStat = await fs.stat(childAbs);
      files.push({ abs: childAbs, rel: normalizeRelPath(childRel), size: childStat.size });
    }
  }
  return files;
}

async function removeEmptyDirs(root) {
  if (!(await pathExists(root))) {
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await removeEmptyDirs(path.join(root, entry.name));
    }
  }
  const remaining = await fs.readdir(root);
  if (remaining.length === 0) {
    await fs.rmdir(root).catch(() => {});
  }
}

async function removeUnexpectedModFiles(instanceDir, nextManagedSet) {
  const modsDir = safeJoin(instanceDir, 'mods');
  const removed = [];
  for (const file of await walkInstanceFiles(modsDir)) {
    const relPath = normalizeRelPath(`mods/${file.rel}`);
    if (!nextManagedSet.has(relPath)) {
      await removeFileIfExists(file.abs);
      removed.push(relPath);
    }
  }
  await removeEmptyDirs(modsDir);
  return removed;
}

const PLAYER_PRESERVED_DIRS = [
  'saves',
  'screenshots',
  'shaderpacks',
  'journeymap',
  'schematics',
  'replay_videos'
];
const PLAYER_PRESERVED_FILES = [
  'servers.dat',
  'servers.dat_old'
];

function installSiblingPrefix(instanceDir, label) {
  const resolved = path.resolve(instanceDir);
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'instance';
  return `.${base}.aht-${label}-`;
}

function uniqueInstallSiblingDir(instanceDir, label) {
  const resolved = path.resolve(instanceDir);
  const parent = path.dirname(resolved);
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(parent, `${installSiblingPrefix(resolved, label)}${nonce}`);
}

function assertSafeInstanceRoot(instanceDir) {
  const resolved = path.resolve(instanceDir);
  const parsed = path.parse(resolved);
  const forbidden = [
    parsed.root,
    os.homedir(),
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.USERPROFILE,
    process.cwd()
  ]
    .filter(Boolean)
    .map((item) => path.resolve(item));
  const comparable = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  for (const target of forbidden) {
    const forbiddenComparable = process.platform === 'win32' ? target.toLowerCase() : target;
    if (comparable === forbiddenComparable) {
      throw new Error(`Refusing to replace unsafe install directory: ${resolved}`);
    }
  }
  if (!path.basename(resolved) || resolved.length <= parsed.root.length + 1) {
    throw new Error(`Refusing to replace unsafe install directory: ${resolved}`);
  }
  return resolved;
}

function preservedFilesForInstall(replaceGameSettings) {
  return replaceGameSettings
    ? PLAYER_PRESERVED_FILES
    : [...PLAYER_PRESERVED_FILES, 'options.txt', 'optionsof.txt'];
}

async function copyPathIfPresent(source, dest) {
  if (!(await pathExists(source))) {
    return false;
  }
  await ensureDir(path.dirname(dest));
  await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
  await fs.cp(source, dest, { recursive: true, force: true });
  return true;
}

async function copyPreservedPlayerData(instanceDir, stagingDir, replaceGameSettings, logger) {
  const preserved = [];
  for (const relPath of PLAYER_PRESERVED_DIRS) {
    const source = safeJoin(instanceDir, relPath);
    const dest = safeJoin(stagingDir, relPath);
    if (await copyPathIfPresent(source, dest)) {
      preserved.push(relPath);
    }
  }
  for (const relPath of preservedFilesForInstall(replaceGameSettings)) {
    const source = safeJoin(instanceDir, relPath);
    const dest = safeJoin(stagingDir, relPath);
    if (await copyPathIfPresent(source, dest)) {
      preserved.push(relPath);
    }
  }
  if (preserved.length) {
    logger.log(`Preserved player data: ${preserved.join(', ')}`);
  }
  return preserved;
}

async function copyCurrentPackToStagingCache(packZipPath, stagingDir, logger) {
  const dest = path.join(stagingDir, '.aht-launcher', 'downloads', path.basename(packZipPath));
  if (path.resolve(packZipPath) === path.resolve(dest)) {
    return;
  }
  try {
    await ensureDir(path.dirname(dest));
    await fs.copyFile(packZipPath, dest);
  } catch (error) {
    logger.log(`Could not preserve downloaded ZIP cache: ${error?.message || error}`);
  }
}

async function installSiblingDirs(instanceDir, label) {
  const resolved = path.resolve(instanceDir);
  const parent = path.dirname(resolved);
  const prefix = installSiblingPrefix(resolved, label);
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      continue;
    }
    const abs = path.join(parent, entry.name);
    const stat = await fs.stat(abs).catch(() => null);
    matches.push({ name: entry.name, abs, mtimeMs: stat?.mtimeMs || 0 });
  }
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  return matches;
}

async function removeInstallSiblings(items, logger, label) {
  let removed = 0;
  for (const item of items) {
    try {
      await fs.rm(item.abs, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      logger?.log?.(`Could not remove stale ${label} folder ${item.abs}: ${error?.message || error}`);
    }
  }
  return removed;
}

async function recoverInterruptedCleanInstall(instanceDir, logger) {
  const resolvedInstanceDir = assertSafeInstanceRoot(instanceDir);
  await ensureDir(path.dirname(resolvedInstanceDir));
  const stagingDirs = await installSiblingDirs(resolvedInstanceDir, 'staging');
  const backupDirs = await installSiblingDirs(resolvedInstanceDir, 'backup');
  const removedStaging = await removeInstallSiblings(stagingDirs, logger, 'staging');
  let removedBackups = 0;
  let restoredBackup = '';

  if (await pathExists(resolvedInstanceDir)) {
    removedBackups = await removeInstallSiblings(backupDirs, logger, 'backup');
  } else if (backupDirs.length) {
    const [newestBackup, ...olderBackups] = backupDirs;
    await fs.rename(newestBackup.abs, resolvedInstanceDir);
    restoredBackup = newestBackup.abs;
    removedBackups = await removeInstallSiblings(olderBackups, logger, 'backup');
  }

  if (removedStaging || removedBackups || restoredBackup) {
    logger?.log?.(`Recovered clean install state: removed ${removedStaging} staging folder(s), removed ${removedBackups} backup folder(s)${restoredBackup ? `, restored ${restoredBackup}` : ''}.`);
  }
  return { removedStaging, removedBackups, restoredBackup };
}

async function removeBackupAfterSuccessfulSwap(backupDir, { logger = console, simulateFailure = false } = {}) {
  try {
    if (simulateFailure && process.env.AHT_TEST_HOOKS === '1' && process.env.AHT_TEST_BACKUP_CLEANUP_FAILURE === '1') {
      throw new Error('Simulated backup cleanup failure');
    }
    await fs.rm(backupDir, { recursive: true, force: true });
    return { backupRemoved: true, backupDir, backupCleanupWarning: '' };
  } catch (cleanupError) {
    const message = cleanupError?.message || String(cleanupError);
    logger?.log?.(`Install completed, but old install backup cleanup is pending: ${backupDir}. ${message}`);
    return { backupRemoved: false, backupDir, backupCleanupWarning: message };
  }
}

async function replaceInstallWithStaging(instanceDir, stagingDir, options = {}) {
  const resolvedInstanceDir = assertSafeInstanceRoot(instanceDir);
  const resolvedStagingDir = path.resolve(stagingDir);
  const backupDir = uniqueInstallSiblingDir(resolvedInstanceDir, 'backup');
  let oldInstallMoved = false;
  let stagedInstallActive = false;

  await ensureDir(path.dirname(resolvedInstanceDir));
  await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  try {
    if (await pathExists(resolvedInstanceDir)) {
      await fs.rename(resolvedInstanceDir, backupDir);
      oldInstallMoved = true;
    }
    await fs.rename(resolvedStagingDir, resolvedInstanceDir);
    stagedInstallActive = true;
  } catch (error) {
    if (oldInstallMoved && !stagedInstallActive && !(await pathExists(resolvedInstanceDir)) && await pathExists(backupDir)) {
      await fs.rename(backupDir, resolvedInstanceDir).catch(() => {});
    }
    throw error;
  }

  if (!oldInstallMoved) {
    return { backupRemoved: true, backupDir: '', backupCleanupWarning: '' };
  }
  return removeBackupAfterSuccessfulSwap(backupDir, options);
}

async function installFullClientZipFromFile({ packZipPath, latest, instanceDir, previousManaged, forceRepair, replaceGameSettings, logger, onProgress, progressBase = 0, progressSpan = 100 }) {
  const inspection = await inspectFullClientZipFile(packZipPath);
  const filesTotal = inspection.fileCount;
  const nextManaged = [];
  const nextManagedSet = new Set();
  let completedWork = 0;
  const emitProgress = (phase, currentPath = '') => {
    if (onProgress) {
      onProgress({
        phase,
        currentPath,
        completed: completedWork,
        total: filesTotal,
        percent: weightedProgress(filesTotal ? Math.round((completedWork / filesTotal) * 100) : 0, progressBase, progressSpan)
      });
    }
  };

  assertSafeInstanceRoot(instanceDir);
  await recoverInterruptedCleanInstall(instanceDir, logger);
  const stagingDir = uniqueInstallSiblingDir(instanceDir, 'staging');
  await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await ensureDir(stagingDir);
  emitProgress('Preparing');
  try {
    logger.log(`Installing exact client ZIP with ${filesTotal} files into staging`);
    await forEachZipEntry(packZipPath, async (entry, zipFile) => {
      if (!zipEntryIsFile(entry)) {
        return;
      }
      const relPath = safeClientZipRelPath(entry.fileName, inspection.rootPrefix);
      if (!relPath) {
        return;
      }
      const target = safeJoin(stagingDir, relPath);
      const settingsFile = isGameSettingsRelPath(relPath);

      await ensureDir(path.dirname(target));
      const sha256 = await extractZipEntryToFile(zipFile, entry, target, !settingsFile);
      if (!settingsFile) {
        const managed = {
          relativePath: relPath,
          source: 'full-client-zip',
          sha256
        };
        nextManaged.push(managed);
        nextManagedSet.add(managed.relativePath);
      }
      completedWork += 1;
      emitProgress('Full client ZIP', relPath);
      if (completedWork % 25 === 0) {
        await yieldToEventLoop();
      }
    });

    const installed = {
      schemaVersion: 1,
      packId: latest.packId,
      name: latest.name,
      version: latest.version,
      installMode: 'full-client-zip',
      installedAt: new Date().toISOString(),
      latestSource: latest.source || null,
      minecraft: latest.minecraft || inspection.metadata.minecraft || null,
      manifestFileCount: 0,
      overrideFileCount: filesTotal
    };

    await copyPreservedPlayerData(instanceDir, stagingDir, replaceGameSettings, logger);
    await copyCurrentPackToStagingCache(packZipPath, stagingDir, logger);
    await writeJsonFile(path.join(stagingDir, '.aht-launcher', 'installed.json'), installed);
    await writeJsonFile(path.join(stagingDir, '.aht-launcher', 'managed-files.json'), nextManaged);

    const removed = previousManaged
      .filter((item) => item?.relativePath && !isGameSettingsRelPath(item.relativePath) && !nextManagedSet.has(item.relativePath))
      .map((item) => item.relativePath);

    emitProgress('Replacing install');
    const replacement = await replaceInstallWithStaging(instanceDir, stagingDir, {
      logger,
      simulateFailure: true
    });
    if (onProgress) {
      onProgress({
        phase: 'Finalizing',
        completed: filesTotal,
        total: filesTotal,
        percent: Math.min(97, weightedProgress(100, progressBase, progressSpan))
      });
    }

    return {
      dryRun: false,
      installed,
      downloadedModCount: nextManaged.filter((item) => item.relativePath.startsWith('mods/')).length,
      overrideFileCount: filesTotal,
      removedStaleCount: removed.length,
      removedStale: removed,
      cleanInstall: true,
      backupRemoved: replacement.backupRemoved,
      backupDir: replacement.backupDir,
      backupCleanupWarning: replacement.backupCleanupWarning
    };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

function manifestFileKey(file) {
  const projectId = file.projectID ?? file.projectId;
  const fileId = file.fileID ?? file.fileId;
  return `${projectId}:${fileId}`;
}

function readManifest(zip) {
  const entry = zip.getEntry('manifest.json');
  if (!entry) {
    throw new Error('Pack ZIP does not contain manifest.json');
  }
  return JSON.parse(entry.getData().toString('utf8'));
}

async function readOptionalJson(source) {
  if (!source) {
    return null;
  }
  try {
    return await readJsonFromSource(source);
  } catch {
    return null;
  }
}

async function verifyExisting(filePath, expected) {
  if (!(await pathExists(filePath))) {
    return false;
  }
  if (!expected) {
    return true;
  }
  const algo = expected.length === 40 ? 'sha1' : expected.length === 64 ? 'sha256' : null;
  if (!algo) {
    return false;
  }
  return (await hashFile(filePath, algo)).toLowerCase() === expected.toLowerCase();
}

function weightedProgress(percent, base = 0, span = 100) {
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return Math.max(0, Math.min(100, Math.round(base + ((normalizedPercent / 100) * span))));
}

function byteInstallProgress(phase, currentPath, progress, base, span) {
  const completedBytes = Math.max(0, Number(progress.loaded || progress.completed || 0));
  const totalBytes = Math.max(0, Number(progress.total || 0));
  return {
    phase,
    currentPath,
    unit: 'bytes',
    completed: completedBytes,
    total: totalBytes,
    completedBytes,
    totalBytes,
    percent: weightedProgress(progress.percent, base, span),
    currentPercent: Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : 0,
    speedBytesPerSecond: progress.speedBytesPerSecond || 0
  };
}

async function downloadVerified(source, dest, expectedHash, options = {}) {
  const currentPath = options.currentPath || path.basename(dest);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const algo = expectedHash?.length === 40 ? 'sha1' : expectedHash?.length === 64 ? 'sha256' : null;
  if (algo && await pathExists(dest)) {
    try {
      const cachedHash = await hashFile(dest, algo, {
        onProgress: onProgress
          ? (progress) => onProgress(byteInstallProgress(
            options.cacheVerifyPhase || 'Verifying cached download',
            currentPath,
            progress,
            options.cacheVerifyBase ?? options.downloadBase ?? 0,
            options.cacheVerifySpan ?? ((options.downloadSpan || 0) + (options.verifySpan || 0) || 100)
          ))
          : null
      });
      if (cachedHash.toLowerCase() === expectedHash.toLowerCase()) {
        if (options.logger?.log) {
          options.logger.log(`Using cached download ${currentPath}`);
        }
        return { reused: true, verified: true, path: dest };
      }
      await removeFileIfExists(dest);
      if (options.logger?.log) {
        options.logger.log(`Cached download ${currentPath} failed verification; downloading a fresh copy.`);
      }
    } catch (error) {
      await removeFileIfExists(dest).catch(() => {});
      if (options.logger?.log) {
        options.logger.log(`Cached download ${currentPath} could not be verified; downloading a fresh copy. ${error.message || error}`);
      }
    }
  }

  await downloadToFile(source, dest, {
    logger: options.logger,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
    timeoutMs: options.timeoutMs,
    multipart: Boolean(options.multipart),
    multipartConcurrency: options.multipartConcurrency,
    multipartPartSizeBytes: options.multipartPartSizeBytes,
    multipartThresholdBytes: options.multipartThresholdBytes,
    onProgress: onProgress
      ? (progress) => onProgress(byteInstallProgress(
        options.downloadPhase || 'Downloading',
        currentPath,
        progress,
        options.downloadBase ?? 0,
        options.downloadSpan ?? 100
      ))
      : null
  });
  if (expectedHash && algo) {
    const actual = await hashFile(dest, algo, {
      onProgress: onProgress
        ? (progress) => onProgress(byteInstallProgress(
          options.verifyPhase || 'Verifying download',
          currentPath,
          progress,
          options.verifyBase ?? 0,
          options.verifySpan ?? 100
        ))
        : null
    });
    if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
      await removeFileIfExists(dest);
      throw new Error(`Hash mismatch for ${dest}: expected ${expectedHash}, got ${actual}`);
    }
  }
  return { reused: false, verified: Boolean(algo), path: dest };
}

function isZipFileName(fileName = '') {
  return /\.zip$/i.test(fileName);
}

function archiveEntriesLookLikeResourcePack(entries = []) {
  const names = entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName.replaceAll('\\', '/').toLowerCase());
  const hasPackMetadata = names.some((name) => name === 'pack.mcmeta' || name.endsWith('/pack.mcmeta'));
  if (!hasPackMetadata) {
    return false;
  }
  const hasModMarker = names.some((name) => (
    name === 'mcmod.info'
    || name.endsWith('/mcmod.info')
    || name === 'fabric.mod.json'
    || name.endsWith('/fabric.mod.json')
    || name === 'quilt.mod.json'
    || name.endsWith('/quilt.mod.json')
    || name === 'meta-inf/mods.toml'
    || name.endsWith('/meta-inf/mods.toml')
    || name.endsWith('.class')
  ));
  return !hasModMarker;
}

function isResourcePackArchiveBuffer(buffer, fileName = '') {
  if (!isZipFileName(fileName)) {
    return false;
  }
  try {
    return archiveEntriesLookLikeResourcePack(new AdmZip(buffer).getEntries());
  } catch {
    return false;
  }
}

function isResourcePackArchiveFile(filePath, fileName = '') {
  if (!isZipFileName(fileName || filePath)) {
    return false;
  }
  try {
    return archiveEntriesLookLikeResourcePack(new AdmZip(filePath).getEntries());
  } catch {
    return false;
  }
}

function resourcePackRelPath(fileName = '') {
  return normalizeRelPath(`resourcepacks/${path.basename(fileName)}`);
}

function explicitInstallRelPath(candidate) {
  return candidate?.installPath || candidate?.relativePath || '';
}

function defaultInstallRelPath(candidate) {
  const explicit = explicitInstallRelPath(candidate);
  return explicit ? normalizeRelPath(explicit) : normalizeRelPath(`mods/${candidate.fileName}`);
}

async function maybeUseExistingResourcePackTarget({ candidate, instanceDir, forceRepair, logger }) {
  if (forceRepair || explicitInstallRelPath(candidate) || !isZipFileName(candidate?.fileName || '')) {
    return null;
  }
  const relPath = resourcePackRelPath(candidate.fileName);
  const target = safeJoin(instanceDir, relPath);
  if (await verifyExisting(target, candidate.expectedHash)) {
    logger.log(`OK ${relPath}`);
    return { relPath, target };
  }
  return null;
}

async function relocateResourcePackDownload({ candidate, instanceDir, relPath, target, logger }) {
  if (!isZipFileName(candidate?.fileName || '') || !relPath.toLowerCase().startsWith('mods/')) {
    return { relPath, target };
  }
  if (!isResourcePackArchiveFile(target, candidate.fileName)) {
    return { relPath, target };
  }
  const nextRelPath = resourcePackRelPath(candidate.fileName);
  const nextTarget = safeJoin(instanceDir, nextRelPath);
  if (nextRelPath.toLowerCase() === relPath.toLowerCase()) {
    return { relPath, target };
  }
  await ensureDir(path.dirname(nextTarget));
  await removeFileIfExists(nextTarget);
  await fs.rename(target, nextTarget);
  logger.log(`Placed resourcepack ${candidate.fileName} -> ${nextRelPath}`);
  return { relPath: nextRelPath, target: nextTarget };
}

function clampConcurrency(value, fallback = 10, max = 32) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

async function runConcurrent(items, limit, worker) {
  if (!items.length) {
    return [];
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

async function managedSha256(filePath, expectedHash) {
  if (expectedHash && expectedHash.length === 64) {
    return expectedHash.toLowerCase();
  }
  return hashFile(filePath, 'sha256');
}

function getCacheEntry(cacheManifest, key) {
  if (!cacheManifest?.entries) {
    return null;
  }
  return cacheManifest.entries[key] || null;
}

function cacheEntryToDownload({ entry, key, releaseSource, fallbackFileName = '' }) {
  if (!entry?.url) {
    return null;
  }
  return {
    source: 'cache',
    key,
    fileName: entry.fileName || fallbackFileName || `${key.replace(':', '-')}.jar`,
    url: resolveSource(releaseSource, entry.url),
    expectedHash: entry.sha256 || entry.sha1 || null,
    installPath: entry.installPath || entry.relativePath || ''
  };
}

async function resolveCurseForgeDownload(file, cfOptions, cacheManifest, releaseSource) {
  const key = manifestFileKey(file);
  const [projectId, fileId] = key.split(':');
  const cached = cacheEntryToDownload({
    entry: getCacheEntry(cacheManifest, key),
    key,
    releaseSource,
    fallbackFileName: `${projectId}-${fileId}.jar`
  });
  let cfError = null;

  try {
    const metadata = await getModFile(projectId, fileId, cfOptions);
    const fileName = metadata.fileName || `${projectId}-${fileId}.jar`;
    const sha1 = getHash(metadata, 'sha1');
    let url = metadata.downloadUrl || null;
    if (!url) {
      url = await getModFileDownloadUrl(projectId, fileId, cfOptions);
    }
    if (url) {
      return {
        source: 'curseforge',
        key,
        fileName,
        url,
        expectedHash: sha1,
        fallback: cached
      };
    }
  } catch (error) {
    cfError = error;
  }

  if (cached) {
    return cached;
  }

  if (cfError) {
    throw new Error(`Unable to resolve ${key}: ${cfError.message}`);
  }
  throw new Error(`Unable to resolve ${key}: no CurseForge URL and no fallback cache entry`);
}

async function installResolvedDownload({ resolved, instanceDir, forceRepair, logger }) {
  const attempts = [resolved, resolved?.fallback].filter(Boolean);
  let lastError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const candidate = attempts[index];
    let relPath = defaultInstallRelPath(candidate);
    let target = safeJoin(instanceDir, relPath);
    try {
      const existingResourcePack = await maybeUseExistingResourcePackTarget({
        candidate,
        instanceDir,
        forceRepair,
        logger
      });
      if (existingResourcePack) {
        return { candidate, ...existingResourcePack };
      }
      if (!forceRepair && await verifyExisting(target, candidate.expectedHash)) {
        logger.log(`OK ${relPath}`);
      } else {
        logger.log(`Downloading ${candidate.source} ${candidate.key} -> ${relPath}`);
        await downloadVerified(candidate.url, target, candidate.expectedHash);
      }
      ({ relPath, target } = await relocateResourcePackDownload({
        candidate,
        instanceDir,
        relPath,
        target,
        logger
      }));
      return { candidate, relPath, target };
    } catch (error) {
      lastError = error;
      if (index < attempts.length - 1) {
        logger.log(`Download failed from ${candidate.source} ${candidate.key}; trying fallback cache. ${error.message}`);
      }
    }
  }
  throw lastError || new Error(`Unable to download ${resolved?.key || 'mod'}`);
}

function cacheExtraDownloads(cacheManifest, releaseSource) {
  const extraFiles = Array.isArray(cacheManifest?.extraFiles) ? cacheManifest.extraFiles : [];
  return extraFiles
    .map((entry) => cacheEntryToDownload({
      entry,
      key: entry.sha256 ? `extra:${entry.sha256}` : `extra:${entry.fileName || entry.url || 'unknown'}`,
      releaseSource,
      fallbackFileName: entry.fileName || ''
    }))
    .filter(Boolean);
}

function classifyOverrideRelPath(entry, relPath) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized.toLowerCase().startsWith('mods/') || !isZipFileName(normalized)) {
    return { relPath: normalized, data: null };
  }
  const data = entry.getData();
  if (isResourcePackArchiveBuffer(data, path.basename(normalized))) {
    return {
      relPath: resourcePackRelPath(path.basename(normalized)),
      data
    };
  }
  return { relPath: normalized, data };
}

function collectOverrideFiles(zip, overridesDir) {
  const normalizedOverridesDir = normalizeRelPath(overridesDir || 'overrides').replace(/\/+$/, '');
  const prefix = `${normalizedOverridesDir}/`;
  return zip.getEntries()
    .map((entry) => ({ entry, entryName: normalizeRelPath(entry.entryName) }))
    .filter(({ entry, entryName }) => !entry.isDirectory && entryName.startsWith(prefix))
    .map(({ entry, entryName }) => {
      const originalRelPath = normalizeRelPath(entryName.slice(prefix.length));
      const placement = classifyOverrideRelPath(entry, originalRelPath);
      return {
        entry,
        relPath: placement.relPath,
        originalRelPath,
        data: placement.data
      };
    });
}

async function removeStaleManagedFiles(instanceDir, previousManaged, nextManagedSet) {
  const removed = [];
  for (const item of previousManaged) {
    if (!item?.relativePath || isGameSettingsRelPath(item.relativePath) || nextManagedSet.has(item.relativePath)) {
      continue;
    }
    const target = safeJoin(instanceDir, item.relativePath);
    await removeFileIfExists(target);
    removed.push(item.relativePath);
  }
  return removed;
}

export async function installPack(options) {
  const {
    latestSource,
    instanceDir,
    cfApiKey,
    cfProxyBaseUrl,
    dryRun = false,
    forceRepair = false,
    replaceGameSettings = false,
    installConcurrency = process.env.AHT_INSTALL_CONCURRENCY || 10,
    onProgress = null,
    logger = console
  } = options;

  if (!latestSource) {
    throw new Error('--latest is required');
  }
  if (!instanceDir) {
    throw new Error('--instance is required');
  }

  const latest = await readJsonFromSource(latestSource);
  if (!dryRun && isFullClientZipRelease(latest)) {
    await recoverInterruptedCleanInstall(instanceDir, logger);
  }
  const preferLocalPaths = !isHttpUrl(latestSource);
  const packRef = preferLocalPaths ? (latest.zip?.path || latest.zip?.url) : (latest.zip?.url || latest.zip?.path);
  const cacheRef = preferLocalPaths
    ? (latest.cacheManifest?.path || latest.cacheManifest?.url)
    : (latest.cacheManifest?.url || latest.cacheManifest?.path);
  const packSource = resolveSource(latestSource, packRef);
  const cacheSource = resolveSource(latestSource, cacheRef);
  const cacheManifest = await readOptionalJson(cacheSource);
  const stateDir = dryRun
    ? await fs.mkdtemp(path.join(os.tmpdir(), 'aht-launcher-'))
    : path.join(instanceDir, '.aht-launcher');
  const downloadsDir = path.join(stateDir, 'downloads');
  await ensureDir(downloadsDir);

  const packZipPath = path.join(downloadsDir, latest.zip?.fileName || `${latest.packId}-${latest.version}.zip`);
  const packZipSize = Number(latest.zip?.size || 0);
  const packMultipartThresholdBytes = (Number(process.env.AHT_PACK_DOWNLOAD_THRESHOLD_MB) || 16) * 1024 * 1024;
  logger.log(`Fetching pack ${latest.name} ${latest.version}`);
  await downloadVerified(packSource, packZipPath, latest.zip?.sha256 || null, {
    logger,
    currentPath: path.basename(packZipPath),
    onProgress,
    cacheVerifyPhase: 'Verifying cached pack',
    cacheVerifyBase: 3,
    cacheVerifySpan: 42,
    multipart: isHttpUrl(packSource) && (!packZipSize || packZipSize >= packMultipartThresholdBytes),
    multipartConcurrency: process.env.AHT_PACK_DOWNLOAD_CONCURRENCY || 6,
    multipartPartSizeBytes: (Number(process.env.AHT_PACK_DOWNLOAD_PART_MB) || 8) * 1024 * 1024,
    multipartThresholdBytes: packMultipartThresholdBytes,
    downloadPhase: 'Downloading pack',
    downloadBase: 3,
    downloadSpan: 37,
    verifyPhase: 'Verifying pack',
    verifyBase: 40,
    verifySpan: 5
  });

  const previousManagedPath = path.join(instanceDir, '.aht-launcher', 'managed-files.json');
  const previousManaged = !dryRun && await pathExists(previousManagedPath)
    ? await readJsonFile(previousManagedPath)
    : [];

  if (isFullClientZipRelease(latest)) {
    const fullClientInspection = await inspectFullClientZipFile(packZipPath);
    if (dryRun) {
      return {
        dryRun: true,
        latest,
        installMode: 'full-client-zip',
        manifestFileCount: 0,
        overrideFileCount: fullClientInspection.fileCount,
        embeddedModCount: fullClientInspection.modFileCount,
        cacheEntryCount: 0,
        cacheExtraCount: 0
      };
    }
    return installFullClientZipFromFile({
      packZipPath,
      latest: { ...latest, source: latestSource },
      instanceDir,
      previousManaged,
      forceRepair,
      replaceGameSettings,
      logger,
      onProgress,
      progressBase: 45,
      progressSpan: 50
    });
  }

  const zip = new AdmZip(packZipPath);
  const manifest = readManifest(zip);
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const overridesDir = manifest.overrides || latest.overrides || 'overrides';
  const overrideFiles = collectOverrideFiles(zip, overridesDir);
  const cacheExtras = cacheExtraDownloads(cacheManifest, latestSource || filePathToSource(process.cwd()));
  const overrideModBasenames = new Set(
    overrideFiles
      .filter((file) => {
        const relPath = file.relPath.toLowerCase();
        const originalRelPath = (file.originalRelPath || '').toLowerCase();
        return relPath.startsWith('mods/')
          || relPath.startsWith('resourcepacks/')
          || originalRelPath.startsWith('mods/');
      })
      .map((file) => path.basename(file.relPath).toLowerCase())
  );

  if (dryRun) {
    return {
      dryRun: true,
      latest,
      manifestFileCount: manifestFiles.length,
      overrideFileCount: overrideFiles.length,
      embeddedModCount: overrideFiles.filter((file) => file.relPath.startsWith('mods/')).length,
      cacheEntryCount: cacheManifest?.entries ? Object.keys(cacheManifest.entries).length : 0,
      cacheExtraCount: cacheExtras.length
    };
  }

  await ensureDir(instanceDir);
  await ensureDir(path.join(instanceDir, 'mods'));
  await ensureDir(path.join(instanceDir, 'resourcepacks'));

  const cfOptions = {
    apiKey: cfApiKey || process.env.CURSEFORGE_API_KEY || '',
    proxyBaseUrl: cfProxyBaseUrl || ''
  };
  const nextManaged = [];
  const nextManagedSet = new Set();
  const totalWork = manifestFiles.length + cacheExtras.length + overrideFiles.length;
  let completedWork = 0;
  const concurrency = clampConcurrency(installConcurrency);
  const releaseSource = latestSource || filePathToSource(process.cwd());
  const emitProgress = (phase, currentPath = '') => {
    if (onProgress) {
      onProgress({
        phase,
        currentPath,
        completed: completedWork,
        total: totalWork,
        percent: totalWork ? Math.round((completedWork / totalWork) * 100) : 0
      });
    }
  };

  emitProgress('Preparing');

  logger.log(`Installing ${manifestFiles.length} manifest mods with concurrency ${concurrency}`);
  const manifestManaged = await runConcurrent(manifestFiles, concurrency, async (file) => {
    const resolved = await resolveCurseForgeDownload(file, cfOptions, cacheManifest, releaseSource);
    const { candidate, relPath, target } = await installResolvedDownload({
      resolved,
      instanceDir,
      forceRepair,
      logger
    });
    const managed = {
      relativePath: relPath,
      source: candidate.source,
      key: candidate.key,
      sha256: await managedSha256(target, candidate.expectedHash)
    };
    completedWork += 1;
    emitProgress('Mods', relPath);
    return managed;
  });
  for (const managed of manifestManaged) {
    nextManaged.push(managed);
    nextManagedSet.add(managed.relativePath);
  }

  const cacheExtraJobs = [];
  const plannedCacheExtras = new Set();
  for (const extra of cacheExtras) {
    const relPath = defaultInstallRelPath(extra);
    const resourceRelPath = isZipFileName(extra.fileName) ? resourcePackRelPath(extra.fileName) : '';
    const alreadyManaged = nextManagedSet.has(relPath) || (resourceRelPath && nextManagedSet.has(resourceRelPath));
    const alreadyEmbedded = overrideModBasenames.has(path.basename(extra.fileName).toLowerCase());
    const planKey = `${relPath.toLowerCase()}|${resourceRelPath.toLowerCase()}`;
    const alreadyPlanned = plannedCacheExtras.has(planKey);
    if (alreadyManaged || alreadyEmbedded || alreadyPlanned) {
      logger.log(`Skipping cache extra ${extra.fileName}; already provided by ${alreadyManaged ? 'manifest' : alreadyEmbedded ? 'overrides' : 'another cache extra'}`);
      completedWork += 1;
      emitProgress('Cache extras', relPath);
      continue;
    }
    plannedCacheExtras.add(planKey);
    cacheExtraJobs.push({ extra, relPath });
  }

  if (cacheExtraJobs.length) {
    logger.log(`Installing ${cacheExtraJobs.length} cache-only mods with concurrency ${concurrency}`);
  }
  const cacheExtraManaged = await runConcurrent(cacheExtraJobs, concurrency, async ({ extra, relPath }) => {
    const { candidate, target, relPath: installedRelPath } = await installResolvedDownload({
      resolved: extra,
      instanceDir,
      forceRepair,
      logger
    });
    const managed = {
      relativePath: installedRelPath || relPath,
      source: 'cache-extra',
      key: candidate.key,
      sha256: await managedSha256(target, candidate.expectedHash)
    };
    completedWork += 1;
    emitProgress('Cache extras', managed.relativePath);
    return managed;
  });
  for (const managed of cacheExtraManaged) {
    nextManaged.push(managed);
    nextManagedSet.add(managed.relativePath);
  }

  const overrideManaged = await runConcurrent(overrideFiles, Math.min(concurrency, 16), async (override) => {
    const target = safeJoin(instanceDir, override.relPath);
    const settingsFile = isGameSettingsRelPath(override.relPath);
    if (settingsFile && !replaceGameSettings && await pathExists(target)) {
      logger.log(`Preserving local game settings ${override.relPath}`);
      completedWork += 1;
      emitProgress('Overrides', override.relPath);
      return null;
    }
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, override.data || override.entry.getData());
    completedWork += 1;
    emitProgress('Overrides', override.relPath);
    if (settingsFile) {
      return null;
    }
    return {
      relativePath: override.relPath,
      source: 'overrides',
      sha256: await hashFile(target, 'sha256')
    };
  });
  for (const managed of overrideManaged.filter(Boolean)) {
    nextManaged.push(managed);
    nextManagedSet.add(managed.relativePath);
  }

  const removed = [
    ...await removeStaleManagedFiles(instanceDir, previousManaged, nextManagedSet),
    ...await removeUnexpectedModFiles(instanceDir, nextManagedSet)
  ];
  emitProgress('Finalizing');

  const installed = {
    schemaVersion: 1,
    packId: latest.packId,
    name: latest.name,
    version: latest.version,
    installedAt: new Date().toISOString(),
    latestSource,
    minecraft: latest.minecraft || manifest.minecraft || null,
    manifestFileCount: manifestFiles.length,
    overrideFileCount: overrideFiles.length
  };

  await writeJsonFile(path.join(instanceDir, '.aht-launcher', 'installed.json'), installed);
  await writeJsonFile(path.join(instanceDir, '.aht-launcher', 'managed-files.json'), nextManaged);

  return {
    dryRun: false,
    installed,
    downloadedModCount: manifestFiles.length,
    overrideFileCount: overrideFiles.length,
    removedStaleCount: removed.length,
    removedStale: removed
  };
}
