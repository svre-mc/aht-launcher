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

function getCacheEntry(cacheManifest, key) {
  if (!cacheManifest?.entries) {
    return null;
  }
  return cacheManifest.entries[key] || null;
}

async function resolveCurseForgeDownload(file, cfOptions, cacheManifest, releaseSource) {
  const key = manifestFileKey(file);
  const [projectId, fileId] = key.split(':');
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
        expectedHash: sha1
      };
    }
  } catch (error) {
    cfError = error;
  }

  const cached = getCacheEntry(cacheManifest, key);
  if (cached?.url) {
    return {
      source: 'cache',
      key,
      fileName: cached.fileName || `${projectId}-${fileId}.jar`,
      url: resolveSource(releaseSource, cached.url),
      expectedHash: cached.sha256 || cached.sha1 || null
    };
  }

  if (cfError) {
    throw new Error(`Unable to resolve ${key}: ${cfError.message}`);
  }
  throw new Error(`Unable to resolve ${key}: no CurseForge URL and no fallback cache entry`);
}

function collectOverrideFiles(zip, overridesDir) {
  const prefix = `${overridesDir.replace(/\/+$/, '')}/`;
  return zip.getEntries()
    .filter((entry) => !entry.isDirectory && entry.entryName.startsWith(prefix))
    .map((entry) => ({
      entry,
      relPath: normalizeRelPath(entry.entryName.slice(prefix.length))
    }));
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
      cacheEntryCount: cacheManifest?.entries ? Object.keys(cacheManifest.entries).length : 0
    };
  }

  await ensureDir(instanceDir);
  await ensureDir(path.join(instanceDir, 'mods'));

  const cfOptions = {
    apiKey: cfApiKey || process.env.CURSEFORGE_API_KEY || '',
    proxyBaseUrl: cfProxyBaseUrl || ''
  };
  const nextManaged = [];
  const nextManagedSet = new Set();
  const totalWork = manifestFiles.length + overrideFiles.length;
  let completedWork = 0;
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

  for (const file of manifestFiles) {
    const resolved = await resolveCurseForgeDownload(file, cfOptions, cacheManifest, latestSource || filePathToSource(process.cwd()));
    const relPath = normalizeRelPath(`mods/${resolved.fileName}`);
    const target = safeJoin(instanceDir, relPath);
    if (!forceRepair && await verifyExisting(target, resolved.expectedHash)) {
      logger.log(`OK ${relPath}`);
    } else {
      logger.log(`Downloading ${resolved.source} ${resolved.key} -> ${relPath}`);
      await downloadVerified(resolved.url, target, resolved.expectedHash);
    }
    nextManaged.push({
      relativePath: relPath,
      source: resolved.source,
      key: resolved.key,
      sha256: await hashFile(target, 'sha256')
    });
    nextManagedSet.add(relPath);
    completedWork += 1;
    emitProgress('Mods', relPath);
  }

  for (const override of overrideFiles) {
    const target = safeJoin(instanceDir, override.relPath);
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, override.entry.getData());
    nextManaged.push({
      relativePath: override.relPath,
      source: 'overrides',
      sha256: await hashFile(target, 'sha256')
    });
    nextManagedSet.add(override.relPath);
    completedWork += 1;
    emitProgress('Overrides', override.relPath);
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
