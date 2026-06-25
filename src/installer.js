import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
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

async function downloadVerified(source, dest, expectedHash) {
  await downloadToFile(source, dest);
  if (expectedHash) {
    const algo = expectedHash.length === 40 ? 'sha1' : expectedHash.length === 64 ? 'sha256' : null;
    if (algo) {
      const actual = await hashFile(dest, algo);
      if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
        await removeFileIfExists(dest);
        throw new Error(`Hash mismatch for ${dest}: expected ${expectedHash}, got ${actual}`);
      }
    }
  }
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
  const prefix = `${overridesDir.replace(/\/+$/, '')}/`;
  return zip.getEntries()
    .filter((entry) => !entry.isDirectory && entry.entryName.startsWith(prefix))
    .map((entry) => {
      const originalRelPath = normalizeRelPath(entry.entryName.slice(prefix.length));
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
    if (!item?.relativePath || nextManagedSet.has(item.relativePath)) {
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
  logger.log(`Fetching pack ${latest.name} ${latest.version}`);
  await downloadVerified(packSource, packZipPath, latest.zip?.sha256 || null);

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

  const previousManagedPath = path.join(instanceDir, '.aht-launcher', 'managed-files.json');
  const previousManaged = !dryRun && await pathExists(previousManagedPath)
    ? await readJsonFile(previousManagedPath)
    : [];

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
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, override.data || override.entry.getData());
    const managed = {
      relativePath: override.relPath,
      source: 'overrides',
      sha256: await hashFile(target, 'sha256')
    };
    completedWork += 1;
    emitProgress('Overrides', override.relPath);
    return managed;
  });
  for (const managed of overrideManaged) {
    nextManaged.push(managed);
    nextManagedSet.add(managed.relativePath);
  }

  const removed = await removeStaleManagedFiles(instanceDir, previousManaged, nextManagedSet);
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
