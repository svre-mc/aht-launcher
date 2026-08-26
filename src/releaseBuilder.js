import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {
  artifactUrl,
  ensureDir,
  hashFile,
  isFileUrl,
  isHttpUrl,
  normalizeRelPath,
  readJsonFromSource,
  resolveSource,
  slugify,
  writeJsonFile
} from './utils.js';
import {
  CLIENT_DELTA_FORMAT,
  CLIENT_DELTA_METADATA_ENTRY,
  CLIENT_MANIFEST_FORMAT,
  CLIENT_PACK_FORMAT,
  CLIENT_PACK_METADATA_ENTRY,
  isClientGameSettingsPath,
  isClientPackContentPath,
  isManagedClientPackPath
} from './clientPackFormat.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readManifest(zip) {
  const entry = zip.getEntry('manifest.json');
  if (!entry) {
    throw new Error('ZIP does not contain manifest.json');
  }
  return JSON.parse(entry.getData().toString('utf8'));
}

function manifestFileKey(file) {
  const projectId = file.projectID ?? file.projectId;
  const fileId = file.fileID ?? file.fileId;
  return projectId && fileId ? `${projectId}:${fileId}` : '';
}

function normalizedOverridesDir(overridesDir = 'overrides') {
  return normalizeRelPath(overridesDir || 'overrides').replace(/\/+$/, '');
}

function normalizedZipEntryName(entry) {
  return normalizeRelPath(entry.entryName);
}

function summarizeOverrides(zip, overridesDir) {
  const prefix = `${normalizedOverridesDir(overridesDir)}/`;
  const files = zip.getEntries()
    .map((entry) => ({ entry, entryName: normalizedZipEntryName(entry) }))
    .filter(({ entry, entryName }) => !entry.isDirectory && entryName.startsWith(prefix));
  const embeddedModFiles = files.filter(({ entryName }) => entryName.startsWith(`${prefix}mods/`));
  const groupMap = new Map();
  for (const { entry, entryName } of files) {
    const rel = entryName.slice(prefix.length);
    const group = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(root)';
    const current = groupMap.get(group) || { count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += entry.header.size;
    groupMap.set(group, current);
  }
  const groups = Object.fromEntries([...groupMap.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return {
    fileCount: files.length,
    embeddedModCount: embeddedModFiles.length,
    embeddedModBytes: embeddedModFiles.reduce((sum, { entry }) => sum + entry.header.size, 0),
    embeddedMods: embeddedModFiles.map(({ entry, entryName }) => ({
      path: entryName,
      size: entry.header.size
    })),
    groups
  };
}

function isModFileName(fileName = '') {
  return /\.(jar|zip)$/i.test(fileName);
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

function isResourcePackArchive(filePath) {
  if (!isZipFileName(filePath)) {
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

function isDirectModFile(filePath, modsDir) {
  if (!filePath || !isModFileName(filePath)) {
    return false;
  }
  return path.dirname(path.resolve(filePath)).toLowerCase() === path.resolve(modsDir).toLowerCase();
}

function directManagedFileMatch(filePath, { modsDir, resourcepacksDir }) {
  if (!filePath || !isModFileName(filePath)) {
    return null;
  }
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved).toLowerCase();
  if (parent === path.resolve(modsDir).toLowerCase()) {
    return {
      filePath: resolved,
      fileName: path.basename(resolved),
      installPath: '',
      source: 'curseforge-instance'
    };
  }
  if (isZipFileName(resolved) && parent === path.resolve(resourcepacksDir).toLowerCase()) {
    return {
      filePath: resolved,
      fileName: path.basename(resolved),
      installPath: resourcePackRelPath(resolved),
      source: 'curseforge-resourcepack-instance'
    };
  }
  return null;
}

async function listDirectModFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && isModFileName(entry.name)) {
      files.push(path.join(root, entry.name));
    }
  }
  return files;
}

async function listDirectResourcePackFiles(instanceDir) {
  const resourcepacksDir = path.join(instanceDir, 'resourcepacks');
  if (!(await pathExists(resourcepacksDir))) {
    return [];
  }
  const entries = await fs.readdir(resourcepacksDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isZipFileName(entry.name))
    .map((entry) => path.join(resourcepacksDir, entry.name));
}

async function resolveCacheSource(cacheModsDir) {
  if (!cacheModsDir) {
    return null;
  }

  const source = path.resolve(cacheModsDir);
  const sourceStat = await fs.stat(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Cache source is not a directory: ${source}`);
  }

  const directMods = path.basename(source).toLowerCase() === 'mods';
  const nestedMods = path.join(source, 'mods');
  if (directMods) {
    return {
      modsDir: source,
      instanceDir: path.dirname(source)
    };
  }
  if (await pathExists(nestedMods)) {
    return {
      modsDir: nestedMods,
      instanceDir: source
    };
  }

  return {
    modsDir: source,
    instanceDir: path.dirname(source)
  };
}

async function readInstanceAddonMap(instanceDir, modsDir) {
  const addonMap = new Map();
  const instanceJsonPath = path.join(instanceDir, 'minecraftinstance.json');
  if (!(await pathExists(instanceJsonPath))) {
    return { addonMap, instanceJsonPath: null };
  }

  const instanceJson = JSON.parse(await fs.readFile(instanceJsonPath, 'utf8'));
  const resourcepacksDir = path.join(instanceDir, 'resourcepacks');
  const addons = Array.isArray(instanceJson.installedAddons) ? instanceJson.installedAddons : [];
  for (const addon of addons) {
    const installedFile = addon.installedFile || {};
    const projectId = installedFile.projectId ?? installedFile.projectID ?? addon.addonID ?? addon.projectID ?? addon.projectId;
    const fileId = installedFile.id ?? installedFile.fileID ?? installedFile.fileId;
    const key = projectId && fileId ? `${projectId}:${fileId}` : '';
    if (!key) {
      continue;
    }

    const categoryPath = String(addon.categorySection?.path || '').replaceAll('\\', '/').toLowerCase();
    const packageType = Number(addon.packageType || addon.categorySection?.packageType || 0);
    const prefersResourcepacks = categoryPath === 'resourcepacks' || packageType === 3;
    const baseDirs = prefersResourcepacks ? [resourcepacksDir, modsDir] : [modsDir, resourcepacksDir];
    const diskNames = [
      addon.fileNameOnDisk,
      installedFile.fileNameOnDisk,
      installedFile.fileName
    ].filter(Boolean);
    const candidates = [
      ...(Array.isArray(addon.filePaths) ? addon.filePaths : []),
      ...diskNames.flatMap((name) => baseDirs.map((baseDir) => path.join(baseDir, name)))
    ].filter(Boolean);

    for (const candidate of candidates) {
      const match = directManagedFileMatch(candidate, { modsDir, resourcepacksDir });
      if (match && await pathExists(match.filePath)) {
        addonMap.set(key, match);
        break;
      }
    }
  }

  return { addonMap, instanceJsonPath };
}

async function addCachedJar({ outDir, cacheManifest, sourcePath, key, fileName, source, installPath = '' }) {
  const sha256 = await hashFile(sourcePath, 'sha256');
  const stats = await fs.stat(sourcePath);
  const ext = path.extname(sourcePath).toLowerCase() || '.jar';
  const relPath = `cache/files/${sha256}${ext}`;
  const target = path.join(outDir, relPath);
  if (!(await pathExists(target))) {
    await ensureDir(path.dirname(target));
    await fs.copyFile(sourcePath, target);
  }

  const entry = {
    fileName: fileName || path.basename(sourcePath),
    sha256,
    size: stats.size,
    url: relPath,
    redistribution: 'private-cache',
    source
  };

  if (installPath) {
    entry.installPath = normalizeRelPath(installPath);
  }
  if (key) {
    cacheManifest.entries[key] = entry;
  }
  return entry;
}

async function buildFallbackCache({ manifestFiles, outDir, packId, cacheModsDir }) {
  const cacheManifest = {
    schemaVersion: 1,
    packId,
    generatedAt: new Date().toISOString(),
    note: 'Only upload files you are allowed to redistribute. Cache entries are used after CurseForge download resolution fails.',
    entries: {}
  };

  const cacheSummary = {
    sourceDir: cacheModsDir || '',
    modsDir: '',
    minecraftInstanceJson: '',
    localJarCount: 0,
    localJarBytes: 0,
    manifestFileCount: manifestFiles.length,
    matchedManifestFiles: 0,
    missingManifestFiles: [],
    extraLocalFiles: 0,
    resourcepacksDir: '',
    localResourcePackCount: 0,
    localResourcePackBytes: 0,
    copiedCacheFiles: 0,
    copiedCacheBytes: 0
  };

  const cacheSource = await resolveCacheSource(cacheModsDir);
  if (!cacheSource) {
    return { cacheManifest, cacheSummary };
  }

  const { modsDir, instanceDir } = cacheSource;
  cacheSummary.modsDir = modsDir;
  cacheSummary.resourcepacksDir = path.join(instanceDir, 'resourcepacks');
  const jarFiles = await listDirectModFiles(modsDir);
  const resourcePackFiles = await listDirectResourcePackFiles(instanceDir);
  cacheSummary.localJarCount = jarFiles.length;
  cacheSummary.localResourcePackCount = resourcePackFiles.length;
  for (const jarFile of jarFiles) {
    cacheSummary.localJarBytes += (await fs.stat(jarFile)).size;
  }
  for (const resourcePackFile of resourcePackFiles) {
    cacheSummary.localResourcePackBytes += (await fs.stat(resourcePackFile)).size;
  }

  const { addonMap, instanceJsonPath } = await readInstanceAddonMap(instanceDir, modsDir);
  cacheSummary.minecraftInstanceJson = instanceJsonPath || '';
  const localByName = new Map([
    ...jarFiles.map((file) => [path.basename(file).toLowerCase(), {
      filePath: file,
      fileName: path.basename(file),
      source: 'local-mods'
    }]),
    ...resourcePackFiles.map((file) => [path.basename(file).toLowerCase(), {
      filePath: file,
      fileName: path.basename(file),
      source: 'local-resourcepacks',
      installPath: resourcePackRelPath(file)
    }])
  ]);
  const usedLocalFiles = new Set();
  const copiedUrls = new Set();

  for (const file of manifestFiles) {
    const key = manifestFileKey(file);
    if (!key) {
      continue;
    }

    const match = addonMap.get(key) || (file.fileName ? localByName.get(String(file.fileName).toLowerCase()) : null);
    const sourcePath = match?.filePath || '';
    if (!sourcePath) {
      cacheSummary.missingManifestFiles.push(key);
      continue;
    }

    const entry = await addCachedJar({
      outDir,
      cacheManifest,
      sourcePath,
      key,
      fileName: match?.fileName || path.basename(sourcePath),
      source: match?.source || 'local-mods',
      installPath: match?.installPath || ''
    });
    cacheSummary.matchedManifestFiles += 1;
    cacheSummary.copiedCacheFiles += copiedUrls.has(entry.url) ? 0 : 1;
    cacheSummary.copiedCacheBytes += copiedUrls.has(entry.url) ? 0 : entry.size;
    copiedUrls.add(entry.url);
    usedLocalFiles.add(path.resolve(sourcePath).toLowerCase());
  }

  const extraFiles = [];
  const plannedExtraTargets = new Set();
  async function addExtraFile(sourcePath, source, installPath = '') {
    const normalizedInstallPath = installPath ? normalizeRelPath(installPath) : '';
    const installKey = (normalizedInstallPath || `mods/${path.basename(sourcePath)}`).toLowerCase();
    if (plannedExtraTargets.has(installKey)) {
      return;
    }
    const entry = await addCachedJar({
      outDir,
      cacheManifest,
      sourcePath,
      key: '',
      fileName: path.basename(sourcePath),
      source,
      installPath: normalizedInstallPath
    });
    if (!copiedUrls.has(entry.url)) {
      cacheSummary.copiedCacheFiles += 1;
      cacheSummary.copiedCacheBytes += entry.size;
      copiedUrls.add(entry.url);
    }
    plannedExtraTargets.add(installKey);
    extraFiles.push(entry);
  }

  for (const resourcePackFile of resourcePackFiles) {
    if (usedLocalFiles.has(path.resolve(resourcePackFile).toLowerCase())) {
      continue;
    }
    await addExtraFile(resourcePackFile, 'local-resourcepacks-extra', resourcePackRelPath(resourcePackFile));
  }

  for (const jarFile of jarFiles) {
    if (usedLocalFiles.has(path.resolve(jarFile).toLowerCase())) {
      continue;
    }
    const installPath = isResourcePackArchive(jarFile) ? resourcePackRelPath(jarFile) : '';
    await addExtraFile(jarFile, installPath ? 'local-resourcepack-in-mods-extra' : 'local-mods-extra', installPath);
  }

  cacheSummary.extraLocalFiles = extraFiles.length;
  if (extraFiles.length) {
    cacheManifest.extraFiles = extraFiles;
  }

  return { cacheManifest, cacheSummary };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function openZipFile(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error) reject(error);
      else resolve(zipFile);
    });
  });
}

function zipEntryIsFile(entry) {
  return entry && !String(entry.fileName || '').endsWith('/');
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
              setImmediate(() => {
                if (!stopped) {
                  zipFile.readEntry();
                }
              });
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

async function readClientPackMetadataFromFile(filePath) {
  const matches = [];
  await forEachZipEntry(filePath, async (entry, zipFile) => {
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

function safeClientZipRelPath(entryName = '', rootPrefix = '') {
  const relPath = stripClientPackRoot(entryName, rootPrefix);
  if (!relPath || relPath === CLIENT_PACK_METADATA_ENTRY || relPath.startsWith('../') || relPath.includes('/../') || path.isAbsolute(relPath)) {
    return '';
  }
  return relPath;
}

async function inspectFullClientArtifact(filePath, { required = true } = {}) {
  const metadataRecord = await readClientPackMetadataFromFile(filePath);
  if (!metadataRecord) {
    if (!required) return null;
    throw new Error(`${CLIENT_PACK_METADATA_ENTRY} missing from full client ZIP.`);
  }
  const entries = [];
  await forEachZipEntry(filePath, async (entry) => {
    if (!zipEntryIsFile(entry)) {
      return;
    }
    const relPath = safeClientZipRelPath(entry.fileName, metadataRecord.rootPrefix);
    if (relPath) {
      entries.push(relPath);
    }
  });
  const modEntries = entries.filter((entry) => entry.toLowerCase().startsWith('mods/') && /\.(jar|zip)$/i.test(entry));
  return {
    ...metadataRecord,
    entries,
    modEntries,
    versionLockPath: modEntries.find((entry) => /aht-version-lock-.+\.jar$/i.test(path.posix.basename(entry))) || null,
    itemFireFixPath: modEntries.find((entry) => /aht-item-fire-fix-.+\.jar$/i.test(path.posix.basename(entry))) || null
  };
}

function normalizedClientManifestFile(record = {}) {
  const relativePath = normalizeRelPath(record.relativePath || record.path || '');
  const size = Number(record.size);
  const sha256 = String(record.sha256 || '').trim().toLowerCase();
  if (!isClientPackContentPath(relativePath)
    || !Number.isSafeInteger(size) || size < 0
    || !/^[a-f0-9]{64}$/.test(sha256)) {
    return null;
  }
  return {
    relativePath,
    size,
    sha256,
    managed: isManagedClientPackPath(relativePath)
  };
}

function clientManifestMap(files = [], label = 'client manifest') {
  const byPath = new Map();
  const byFoldedPath = new Map();
  for (const raw of files) {
    const file = normalizedClientManifestFile(raw);
    if (!file) {
      throw new Error(`${label} contains an invalid file record: ${JSON.stringify(raw)}`);
    }
    const folded = file.relativePath.toLowerCase();
    if (byPath.has(file.relativePath) || byFoldedPath.has(folded)) {
      throw new Error(`${label} contains a duplicate path: ${file.relativePath}`);
    }
    byPath.set(file.relativePath, file);
    byFoldedPath.set(folded, file);
  }
  return { byPath, byFoldedPath };
}

async function hashClientArtifactEntries(filePath, inspection, wantedPaths) {
  const wanted = new Set(wantedPaths);
  const results = new Map();
  await forEachZipEntry(filePath, async (entry, zipFile) => {
    if (!zipEntryIsFile(entry)) return;
    const relativePath = safeClientZipRelPath(entry.fileName, inspection.rootPrefix);
    if (!wanted.has(relativePath)) return;
    const hash = createHash('sha256');
    const stream = await openZipEntryStream(zipFile, entry);
    let size = 0;
    for await (const chunk of stream) {
      hash.update(chunk);
      size += chunk.length;
    }
    results.set(relativePath, {
      relativePath,
      size,
      sha256: hash.digest('hex'),
      managed: isManagedClientPackPath(relativePath)
    });
  });
  const missing = [...wanted].filter((relativePath) => !results.has(relativePath));
  if (missing.length) {
    throw new Error(`Client ZIP manifest could not hash ${missing.length} file(s), beginning with ${missing[0]}.`);
  }
  return results;
}

async function buildClientManifest(filePath, inspection, { packId, name, version }) {
  const entryPaths = [];
  const foldedEntries = new Set();
  for (const rawPath of inspection.entries) {
    const relativePath = normalizeRelPath(rawPath);
    if (!isClientPackContentPath(relativePath)) {
      throw new Error(`Full client ZIP contains an unsupported managed path: ${relativePath}`);
    }
    const folded = relativePath.toLowerCase();
    if (foldedEntries.has(folded)) {
      throw new Error(`Full client ZIP contains a duplicate path: ${relativePath}`);
    }
    foldedEntries.add(folded);
    entryPaths.push(relativePath);
  }

  const embeddedFiles = Array.isArray(inspection.metadata?.files)
    ? inspection.metadata.files.map(normalizedClientManifestFile).filter(Boolean)
    : [];
  const embeddedByPath = new Map(embeddedFiles.map((file) => [file.relativePath, file]));
  const missingPaths = entryPaths.filter((relativePath) => !embeddedByPath.has(relativePath));
  const computed = missingPaths.length
    ? await hashClientArtifactEntries(filePath, inspection, missingPaths)
    : new Map();
  const files = entryPaths
    .map((relativePath) => embeddedByPath.get(relativePath) || computed.get(relativePath))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    schemaVersion: 1,
    format: CLIENT_MANIFEST_FORMAT,
    packId,
    name,
    version,
    createdAt: new Date().toISOString(),
    fileCount: files.length,
    managedFileCount: files.filter((file) => file.managed).length,
    files
  };
}

function validatePreviousClientManifest(manifest, latest, { packId, channel }) {
  if (!manifest || manifest.format !== CLIENT_MANIFEST_FORMAT || !Array.isArray(manifest.files)) {
    throw new Error('Previous release does not have a supported client manifest.');
  }
  if (String(manifest.packId || '') !== packId || String(latest.packId || '') !== packId) {
    throw new Error('Previous client manifest belongs to another pack.');
  }
  if (channel && latest.channel && String(latest.channel) !== String(channel)) {
    throw new Error('Previous client manifest belongs to another release channel.');
  }
  if (String(manifest.version || '') !== String(latest.version || '')) {
    throw new Error('Previous client manifest version does not match previous latest.json.');
  }
  clientManifestMap(manifest.files, 'previous client manifest');
  return manifest;
}

async function previousClientRelease({ outDir, previousLatestSource = '', packId, version, channel }) {
  const localLatestPath = path.join(outDir, 'latest.json');
  const candidates = [
    await pathExists(localLatestPath) ? localLatestPath : '',
    String(previousLatestSource || '').trim()
  ].filter(Boolean);
  const seen = new Set();
  const errors = [];
  for (const source of candidates) {
    const key = String(source).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const latest = await readJsonFromSource(source);
      if (String(latest.version || '') === String(version)) {
        errors.push(`${source}: release version is already ${version}`);
        continue;
      }
      const manifestRef = latest.clientManifest?.url || latest.clientManifest?.path;
      if (manifestRef) {
        const manifestSource = resolveSource(source, manifestRef);
        const manifest = validatePreviousClientManifest(
          await readJsonFromSource(manifestSource),
          latest,
          { packId, channel }
        );
        return { latest, manifest, latestSource: source, manifestSource, errors };
      }

      const zipRef = latest.zip?.path || latest.zip?.url;
      const zipSource = zipRef ? resolveSource(source, zipRef) : '';
      if (!zipSource || isHttpUrl(zipSource)) {
        errors.push(`${source}: client manifest is unavailable and the previous full ZIP is not local`);
        continue;
      }
      const zipPath = isFileUrl(zipSource) ? fileURLToPath(zipSource) : zipSource;
      if (!(await pathExists(zipPath))) {
        errors.push(`${source}: client manifest is unavailable and the previous full ZIP is missing`);
        continue;
      }
      const inspection = await inspectFullClientArtifact(zipPath);
      const reconstructed = await buildClientManifest(zipPath, inspection, {
        packId,
        name: String(latest.name || inspection.metadata?.name || 'A Hard Time'),
        version: String(latest.version || '')
      });
      const manifest = validatePreviousClientManifest(
        reconstructed,
        latest,
        { packId, channel }
      );
      return {
        latest,
        manifest,
        latestSource: source,
        manifestSource: zipPath,
        reconstructedFromZip: true,
        errors
      };
    } catch (error) {
      errors.push(`${source}: ${error?.message || error}`);
    }
  }
  return { latest: null, manifest: null, latestSource: '', manifestSource: '', errors };
}

function compareClientManifests(previousManifest, currentManifest) {
  const previous = clientManifestMap(previousManifest.files, 'previous client manifest').byFoldedPath;
  const current = clientManifestMap(currentManifest.files, 'current client manifest').byFoldedPath;
  const changed = [];
  const deleted = [];

  for (const file of currentManifest.files) {
    const old = previous.get(file.relativePath.toLowerCase());
    if (!old
      || old.relativePath !== file.relativePath
      || old.size !== file.size
      || old.sha256 !== file.sha256
      || isClientGameSettingsPath(file.relativePath)) {
      changed.push(file);
    }
  }
  for (const file of previousManifest.files) {
    const next = current.get(file.relativePath.toLowerCase());
    if (!next || next.relativePath !== file.relativePath) {
      deleted.push(file.relativePath);
    }
  }
  changed.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  deleted.sort((left, right) => left.localeCompare(right));
  return { changed, deleted };
}

async function writeClientDeltaZip({ sourceZip, sourceInspection, destZip, metadata }) {
  await ensureDir(path.dirname(destZip));
  const temporary = `${destZip}.tmp`;
  await fs.rm(temporary, { force: true }).catch(() => {});
  await fs.rm(destZip, { force: true }).catch(() => {});
  const wanted = new Map(metadata.files.map((file) => [file.relativePath, file]));
  const found = new Set();
  const zipOut = new yazl.ZipFile();
  zipOut.addBuffer(
    Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'),
    CLIENT_DELTA_METADATA_ENTRY
  );
  const outputDone = new Promise((resolve, reject) => {
    const output = createWriteStream(temporary);
    output.on('close', resolve);
    output.on('error', reject);
    zipOut.outputStream.on('error', reject);
    zipOut.outputStream.pipe(output);
  });

  if (wanted.size) {
    const zipIn = await openZipFile(sourceZip);
    await new Promise((resolve, reject) => {
      zipIn.on('entry', (entry) => {
        const relativePath = zipEntryIsFile(entry)
          ? safeClientZipRelPath(entry.fileName, sourceInspection.rootPrefix)
          : '';
        if (!relativePath || !wanted.has(relativePath)) {
          zipIn.readEntry();
          return;
        }
        zipIn.openReadStream(entry, (error, readStream) => {
          if (error) {
            reject(error);
            return;
          }
          found.add(relativePath);
          readStream.on('error', reject);
          readStream.on('end', () => zipIn.readEntry());
          zipOut.addReadStream(readStream, relativePath, {
            mtime: entry.getLastModDate(),
            size: Number(entry.uncompressedSize || wanted.get(relativePath).size)
          });
        });
      });
      zipIn.on('end', resolve);
      zipIn.on('error', reject);
      zipIn.readEntry();
    }).finally(() => zipIn.close());
  }

  const missing = [...wanted.keys()].filter((relativePath) => !found.has(relativePath));
  if (missing.length) {
    zipOut.end();
    await outputDone.catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw new Error(`Delta ZIP is missing ${missing.length} changed file(s), beginning with ${missing[0]}.`);
  }
  zipOut.end();
  await outputDone;
  await fs.rename(temporary, destZip);
}

async function writeZipWithInjectedFiles({ sourceZip, destZip, injections }) {
  await ensureDir(path.dirname(destZip));
  const zipIn = await openZipFile(sourceZip);
  const zipOut = new yazl.ZipFile();
  const normalizedInjections = injections.map((injection) => ({
    ...injection,
    injectAs: injection.injectAs.replaceAll('\\', '/')
  }));
  const alreadyPresent = new Set();

  const outputDone = new Promise((resolve, reject) => {
    const output = createWriteStream(destZip);
    output.on('close', resolve);
    output.on('error', reject);
    zipOut.outputStream.on('error', reject);
    zipOut.outputStream.pipe(output);
  });

  const inputDone = new Promise((resolve, reject) => {
    zipIn.on('entry', (entry) => {
      const entryName = entry.fileName.replaceAll('\\', '/');
      for (const injection of normalizedInjections) {
        if (entryName.toLowerCase() === injection.injectAs.toLowerCase()) {
          alreadyPresent.add(injection.injectAs.toLowerCase());
        }
      }
      if (entryName.endsWith('/')) {
        zipIn.readEntry();
        return;
      }
      zipIn.openReadStream(entry, (error, readStream) => {
        if (error) {
          reject(error);
          return;
        }
        readStream.on('error', reject);
        readStream.on('end', () => zipIn.readEntry());
        zipOut.addReadStream(readStream, entryName, {
          mtime: entry.getLastModDate()
        });
      });
    });
    zipIn.on('end', () => {
      for (const injection of normalizedInjections) {
        if (!alreadyPresent.has(injection.injectAs.toLowerCase())) {
          zipOut.addFile(injection.injectPath, injection.injectAs);
        }
      }
      zipOut.end();
      resolve();
    });
    zipIn.on('error', reject);
  });

  zipIn.readEntry();
  await inputDone;
  await outputDone;
  zipIn.close();
}

async function findBundledJar({ explicitPath = '', dirName, pattern }) {
  if (explicitPath) {
    return await pathExists(explicitPath) ? path.resolve(explicitPath) : null;
  }

  const bundledDir = path.join(appRoot, dirName);
  const unpackedDir = bundledDir.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const sourceRoots = [
    process.env.AHT_LAUNCHER_SOURCE_ROOT,
    process.env.INIT_CWD,
    process.env.npm_config_local_prefix,
    process.cwd()
  ].filter(Boolean);
  const candidates = [
    unpackedDir,
    bundledDir,
    process.resourcesPath ? path.join(process.resourcesPath, dirName) : '',
    ...sourceRoots.map((root) => path.join(root, dirName))
  ].filter(Boolean);

  for (const candidatesDir of [...new Set(candidates)]) {
    try {
      const files = await fs.readdir(candidatesDir);
      const jars = files.filter((file) => pattern.test(file)).sort().reverse();
      if (jars.length) {
        return path.join(candidatesDir, jars[0]);
      }
    } catch {
      // Packaged Electron apps may keep helper assets outside app.asar.
    }
  }

  return null;
}

async function findVersionLockJar(explicitPath = '') {
  return findBundledJar({
    explicitPath,
    dirName: path.join('server-lock-mod', 'build', 'libs'),
    pattern: /^aht-version-lock-(?!.*-sources\.jar$).+\.jar$/i
  });
}

function itemFireFixPattern(manifest) {
  const minecraftVersion = String(manifest.minecraft?.version || '').toLowerCase();
  const modLoaders = Array.isArray(manifest.minecraft?.modLoaders)
    ? manifest.minecraft.modLoaders.map((loader) => String(loader?.id || '').toLowerCase())
    : [];
  const loaderText = modLoaders.join(' ');
  if (minecraftVersion === '1.12.2' || loaderText.includes('forge')) {
    return /^aht-item-fire-fix-forge-.+\.jar$/i;
  }
  if (minecraftVersion === '26.1.2' || loaderText.includes('fabric')) {
    return /^aht-item-fire-fix-fabric-.+\.jar$/i;
  }
  return null;
}

async function findItemFireFixJar(manifest) {
  const pattern = itemFireFixPattern(manifest);
  if (!pattern) {
    return null;
  }
  return findBundledJar({
    dirName: 'pack-fixes',
    pattern
  });
}

function existingVersionLockJar(zip, overridesDir) {
  const prefix = `${normalizedOverridesDir(overridesDir)}/mods/`;
  const entry = zip.getEntries().find((item) => {
    const name = normalizedZipEntryName(item);
    return !item.isDirectory && name.startsWith(prefix) && /aht-version-lock-.+\.jar$/i.test(path.posix.basename(name));
  });
  return entry ? normalizedZipEntryName(entry) : null;
}

function existingItemFireFixJar(zip, overridesDir) {
  const prefix = `${normalizedOverridesDir(overridesDir)}/mods/`;
  const entry = zip.getEntries().find((item) => {
    const name = normalizedZipEntryName(item);
    return !item.isDirectory && name.startsWith(prefix) && /aht-item-fire-fix-.+\.jar$/i.test(path.posix.basename(name));
  });
  return entry ? normalizedZipEntryName(entry) : null;
}

function addInjectedModToOverrideSummary(overrideSummary, modPath, modSize) {
  overrideSummary.fileCount += 1;
  overrideSummary.embeddedModCount += 1;
  overrideSummary.embeddedModBytes += modSize;
  overrideSummary.embeddedMods.push({
    path: modPath,
    size: modSize
  });
  overrideSummary.embeddedMods.sort((a, b) => a.path.localeCompare(b.path));
  const modsGroup = overrideSummary.groups.mods || { count: 0, bytes: 0 };
  modsGroup.count += 1;
  modsGroup.bytes += modSize;
  overrideSummary.groups.mods = modsGroup;
}

function forgeConfigValue(value) {
  return String(value).replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\');
}

function serverLockConfig({ packId }) {
  return [
    '# Generated by A Hard Time Launcher.',
    '# Copy this file to the Minecraft server config folder as aht_version_lock.cfg.',
    '# Keep this server-only config out of every player/client artifact.',
    '# The Worker pushes a signed policy only when launcher/access state changes.',
    'general {',
    '    S:attestationPublicKeySha256=',
    '    S:invalidProofMessage=A valid A Hard Time Launcher session is required. Restart the launcher and reconnect.',
    `    S:requiredPackId=${forgeConfigValue(packId)}`,
    '    I:stateConnectTimeoutMillis=10000',
    '    I:stateHeartbeatMillis=30000',
    '    S:stateServerToken=',
    '    S:stateServerTokenEnvironmentVariable=AHT_LAUNCHER_STATE_TOKEN',
    '    S:stateWebSocketUrl=wss://aht-curseforge-proxy.mysticgamer312.workers.dev/server/launcher-state',
    '    I:timeoutTicks=300',
    '    S:updateRequiredMessage=Current Launcher Version: {current}\\nNecessary Launcher Version: {necessary}\\nUpdate A Hard Time Launcher, restart it, and reconnect.',
    '    S:verificationUnavailableMessage=A Hard Time Launcher policy is temporarily unavailable. Please reconnect shortly.',
    '}',
    ''
  ].join('\n');
}

function clientPackMetadataEntry(zip) {
  const direct = zip.getEntry(CLIENT_PACK_METADATA_ENTRY);
  if (direct) return direct;
  const matches = zip.getEntries()
    .filter((entry) => !entry.isDirectory)
    .filter((entry) => normalizeRelPath(entry.entryName).endsWith(`/${CLIENT_PACK_METADATA_ENTRY}`));
  return matches.length === 1 ? matches[0] : null;
}

function clientPackRootPrefix(zip) {
  const entry = clientPackMetadataEntry(zip);
  if (!entry) return '';
  const name = normalizeRelPath(entry.entryName);
  return name.endsWith(CLIENT_PACK_METADATA_ENTRY) ? name.slice(0, -CLIENT_PACK_METADATA_ENTRY.length) : '';
}

function readClientPackMetadata(zip) {
  const entry = clientPackMetadataEntry(zip);
  if (!entry) return null;
  const metadata = JSON.parse(entry.getData().toString('utf8'));
  if (metadata?.format !== CLIENT_PACK_FORMAT) {
    throw new Error(`${CLIENT_PACK_METADATA_ENTRY} has unsupported format: ${metadata?.format || 'missing'}`);
  }
  return metadata;
}

async function prepareReleaseOutput(outDir) {
  await ensureDir(outDir);
  for (const rel of ['packs', 'patches', 'manifests', 'cache', 'server']) {
    await fs.rm(path.join(outDir, rel), { recursive: true, force: true });
  }
  for (const rel of ['latest.json', 'release-report.json']) {
    await fs.rm(path.join(outDir, rel), { force: true });
  }
}

function stripClientPackRoot(relPath = '', rootPrefix = '') {
  const normalized = normalizeRelPath(relPath);
  if (!rootPrefix) return normalized;
  return normalized.startsWith(rootPrefix) ? normalizeRelPath(normalized.slice(rootPrefix.length)) : '';
}

function zipFileEntries(zip, rootPrefix = '') {
  return zip.getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => stripClientPackRoot(entry.entryName, rootPrefix))
    .filter(Boolean);
}

function findFullClientMod(zip, pattern, rootPrefix = '') {
  return zipFileEntries(zip, rootPrefix).find((name) => name.startsWith('mods/') && pattern.test(path.posix.basename(name))) || null;
}

async function buildFullClientRelease(options, sourceInspection) {
  const {
    packZip,
    outDir,
    baseUrl = '',
    channel = 'stable',
    copyZip = true,
    versionLockJar = '',
    previousLatestSource = ''
  } = options;

  const metadata = sourceInspection.metadata;
  const packId = slugify(metadata.packId || metadata.name || 'a-hard-time');
  const name = String(metadata.name || 'A Hard Time');
  const version = String(metadata.version || '0.0.0');
  const zipFileName = `${packId}-${slugify(version)}.zip`;
  const zipRelPath = `packs/${zipFileName}`;
  const serverLockRelPath = 'server/aht_version_lock.cfg';
  const versionLockJarPath = await findVersionLockJar(versionLockJar);
  const serverLockModRelPath = versionLockJarPath ? `server/mods/${path.basename(versionLockJarPath)}` : null;
  const zipDest = path.join(outDir, zipRelPath);
  const previousRelease = await previousClientRelease({
    outDir,
    previousLatestSource,
    packId,
    version,
    channel
  });

  await prepareReleaseOutput(outDir);
  await ensureDir(path.join(outDir, 'packs'));
  await ensureDir(path.join(outDir, 'patches'));
  await ensureDir(path.join(outDir, 'manifests'));
  await ensureDir(path.join(outDir, 'server'));
  await ensureDir(path.join(outDir, 'server', 'mods'));

  if (versionLockJarPath) {
    await fs.copyFile(versionLockJarPath, path.join(outDir, serverLockModRelPath));
  }

  const rootPrefix = sourceInspection.rootPrefix;
  const existingClientVersionLockPath = sourceInspection.versionLockPath;
  const injectClientVersionLock = Boolean(versionLockJarPath && !existingClientVersionLockPath);
  const clientVersionLockPath = existingClientVersionLockPath || (injectClientVersionLock ? `mods/${path.basename(versionLockJarPath)}` : null);
  const fullClientZipInjections = [
    injectClientVersionLock ? {
      sourceZip: packZip,
      injectPath: versionLockJarPath,
      injectAs: rootPrefix ? `${rootPrefix}${clientVersionLockPath}` : clientVersionLockPath
    } : null
  ].filter(Boolean);

  if (fullClientZipInjections.length) {
    await writeZipWithInjectedFiles({
      sourceZip: packZip,
      destZip: zipDest,
      injections: fullClientZipInjections
    });
  } else if (copyZip) {
    await fs.copyFile(packZip, zipDest);
  }

  const artifactPath = await pathExists(zipDest) ? zipDest : packZip;
  const stats = await fs.stat(artifactPath);
  const sha256 = await hashFile(artifactPath, 'sha256');
  const artifactInspection = artifactPath === packZip ? sourceInspection : await inspectFullClientArtifact(artifactPath);
  const entries = artifactInspection.entries.filter((entry) => entry !== CLIENT_PACK_METADATA_ENTRY);
  const modEntries = artifactInspection.modEntries;
  const clientItemFireFixPath = artifactInspection.itemFireFixPath;
  const clientManifest = await buildClientManifest(artifactPath, artifactInspection, {
    packId,
    name,
    version
  });
  const clientManifestRelPath = `manifests/${packId}-${slugify(version)}.json`;
  const clientManifestPath = path.join(outDir, clientManifestRelPath);
  await writeJsonFile(clientManifestPath, clientManifest);
  const clientManifestStats = await fs.stat(clientManifestPath);
  const clientManifestSha256 = await hashFile(clientManifestPath, 'sha256');
  const clientManifestArtifact = {
    format: CLIENT_MANIFEST_FORMAT,
    fileName: path.basename(clientManifestRelPath),
    path: clientManifestRelPath,
    url: artifactUrl(baseUrl, clientManifestRelPath),
    sha256: clientManifestSha256,
    size: clientManifestStats.size,
    fileCount: clientManifest.fileCount,
    managedFileCount: clientManifest.managedFileCount
  };

  let delta = null;
  let deltaSummary = {
    available: false,
    fromVersion: '',
    toVersion: version,
    changedFileCount: 0,
    deletedFileCount: 0,
    changedBytes: 0,
    reason: previousRelease.errors.join(' | ') || 'No previous client manifest is available yet.'
  };
  if (previousRelease.manifest && previousRelease.latest) {
    const compared = compareClientManifests(previousRelease.manifest, clientManifest);
    const fromVersion = String(previousRelease.latest.version);
    const deltaFileName = `${packId}-${slugify(fromVersion)}-to-${slugify(version)}.zip`;
    const deltaRelPath = `patches/${deltaFileName}`;
    const deltaPath = path.join(outDir, deltaRelPath);
    const deltaMetadata = {
      schemaVersion: 1,
      format: CLIENT_DELTA_FORMAT,
      packId,
      name,
      fromVersion,
      toVersion: version,
      createdAt: new Date().toISOString(),
      targetManifest: {
        format: CLIENT_MANIFEST_FORMAT,
        path: clientManifestRelPath,
        sha256: clientManifestSha256
      },
      files: compared.changed,
      deleted: compared.deleted
    };
    await writeClientDeltaZip({
      sourceZip: artifactPath,
      sourceInspection: artifactInspection,
      destZip: deltaPath,
      metadata: deltaMetadata
    });
    const deltaStats = await fs.stat(deltaPath);
    const deltaSha256 = await hashFile(deltaPath, 'sha256');
    delta = {
      format: CLIENT_DELTA_FORMAT,
      fromVersion,
      toVersion: version,
      fileName: deltaFileName,
      path: deltaRelPath,
      url: artifactUrl(baseUrl, deltaRelPath),
      sha256: deltaSha256,
      size: deltaStats.size,
      changedFileCount: compared.changed.length,
      deletedFileCount: compared.deleted.length
    };
    deltaSummary = {
      available: true,
      fromVersion,
      toVersion: version,
      changedFileCount: compared.changed.length,
      deletedFileCount: compared.deleted.length,
      changedBytes: compared.changed.reduce((sum, file) => sum + file.size, 0),
      size: deltaStats.size,
      fullZipSize: stats.size,
      savingsBytes: Math.max(0, stats.size - deltaStats.size),
      reason: ''
    };
  }

  const latest = {
    schemaVersion: 1,
    packId,
    name,
    version,
    channel,
    createdAt: new Date().toISOString(),
    minecraft: metadata.minecraft || null,
    installMode: 'full-client-zip',
    zipFormat: CLIENT_PACK_FORMAT,
    zip: {
      fileName: zipFileName,
      path: zipRelPath,
      url: artifactUrl(baseUrl, zipRelPath),
      sha256,
      size: stats.size
    },
    curseforge: {
      fileCount: 0,
      disabled: true
    },
    clientZip: {
      metadataPath: CLIENT_PACK_METADATA_ENTRY,
      includedRoots: metadata.includedRoots || [],
      missingRoots: metadata.missingRoots || [],
      fileCount: entries.length,
      modFileCount: modEntries.length
    },
    clientManifest: clientManifestArtifact,
    delta,
    serverLock: {
      configPath: serverLockRelPath,
      modPath: serverLockModRelPath,
      clientModPath: clientVersionLockPath,
      injected: injectClientVersionLock
    },
    itemFireFix: {
      clientModPath: clientItemFireFixPath,
      injected: false
    },
    required: true
  };

  const report = {
    schemaVersion: 1,
    releaseMode: 'full-client-zip',
    packId,
    name,
    version,
    sourceZip: {
      path: packZip,
      fileName: path.basename(packZip),
      versionHint: versionHintFromFileName(packZip)
    },
    minecraft: latest.minecraft,
    clientZipSummary: latest.clientZip,
    clientManifestSummary: clientManifestArtifact,
    deltaSummary,
    output: {
      latest: 'latest.json',
      packZip: zipRelPath,
      clientManifest: clientManifestRelPath,
      deltaPatch: delta?.path || null,
      serverLockConfig: serverLockRelPath,
      serverLockMod: serverLockModRelPath,
      clientVersionLockMod: clientVersionLockPath,
      clientVersionLockInjected: injectClientVersionLock,
      clientItemFireFixMod: clientItemFireFixPath
    }
  };

  await writeJsonFile(path.join(outDir, 'latest.json'), latest);
  await fs.writeFile(path.join(outDir, serverLockRelPath), serverLockConfig({ packId, version }), 'utf8');
  await writeJsonFile(path.join(outDir, 'release-report.json'), report);

  return { latest, report, outDir };
}

function versionHintFromFileName(filePath = '') {
  const name = path.basename(filePath).replace(/\.zip$/i, '');
  const normalizedName = name.replace(/(?:[\s_-](?:aht-client|client-zip|full-client|client))$/i, '');
  const match = normalizedName.match(/(?:^|[\s_-])v?(\d+(?:\.\d+){1,4}(?:[-_+][A-Za-z0-9][A-Za-z0-9._-]*)?)$/i);
  return match?.[1]?.replace(/_/g, '-') || '';
}

export async function buildRelease(options) {
  const {
    packZip,
    outDir,
    baseUrl = '',
    channel = 'stable',
    copyZip = true,
    versionLockJar = '',
    cacheModsDir = '',
    previousLatestSource = ''
  } = options;

  if (!packZip) {
    throw new Error('--pack-zip is required');
  }
  if (!outDir) {
    throw new Error('--out is required');
  }

  const clientPackInspection = await inspectFullClientArtifact(packZip, { required: false });
  if (clientPackInspection) {
    return buildFullClientRelease({
      packZip,
      outDir,
      baseUrl,
      channel,
      copyZip,
      versionLockJar,
      previousLatestSource
    }, clientPackInspection);
  }
  const zip = new AdmZip(packZip);
  const manifest = readManifest(zip);
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const packId = slugify(manifest.name);
  const version = String(manifest.version || '0.0.0');
  const zipFileName = `${packId}-${slugify(version)}.zip`;
  const zipRelPath = `packs/${zipFileName}`;
  const serverLockRelPath = 'server/aht_version_lock.cfg';
  const versionLockJarPath = await findVersionLockJar(versionLockJar);
  const serverLockModRelPath = versionLockJarPath ? `server/mods/${path.basename(versionLockJarPath)}` : null;
  const zipDest = path.join(outDir, zipRelPath);
  const overridesDir = normalizedOverridesDir(manifest.overrides || 'overrides');
  const existingClientVersionLockPath = existingVersionLockJar(zip, overridesDir);
  const clientVersionLockPath = existingClientVersionLockPath || (versionLockJarPath ? `${overridesDir}/mods/${path.basename(versionLockJarPath)}` : null);
  const injectClientVersionLock = Boolean(versionLockJarPath && !existingClientVersionLockPath);
  const itemFireFixJarPath = await findItemFireFixJar(manifest);
  const existingClientItemFireFixPath = existingItemFireFixJar(zip, overridesDir);
  const clientItemFireFixPath = existingClientItemFireFixPath || (itemFireFixJarPath ? `${overridesDir}/mods/${path.basename(itemFireFixJarPath)}` : null);
  const injectClientItemFireFix = Boolean(itemFireFixJarPath && !existingClientItemFireFixPath);
  const overrideSummary = summarizeOverrides(zip, overridesDir);
  if (injectClientVersionLock) {
    const jarStats = await fs.stat(versionLockJarPath);
    addInjectedModToOverrideSummary(overrideSummary, clientVersionLockPath, jarStats.size);
  }
  if (injectClientItemFireFix) {
    const jarStats = await fs.stat(itemFireFixJarPath);
    addInjectedModToOverrideSummary(overrideSummary, clientItemFireFixPath, jarStats.size);
  }

  await prepareReleaseOutput(outDir);
  await ensureDir(path.join(outDir, 'packs'));
  await ensureDir(path.join(outDir, 'cache'));
  await ensureDir(path.join(outDir, 'cache', 'files'));
  await ensureDir(path.join(outDir, 'server'));
  await ensureDir(path.join(outDir, 'server', 'mods'));

  const zipInjections = [
    injectClientVersionLock ? {
      sourceZip: packZip,
      injectPath: versionLockJarPath,
      injectAs: clientVersionLockPath
    } : null,
    injectClientItemFireFix ? {
      sourceZip: packZip,
      injectPath: itemFireFixJarPath,
      injectAs: clientItemFireFixPath
    } : null
  ].filter(Boolean);

  if (zipInjections.length) {
    await writeZipWithInjectedFiles({
      sourceZip: packZip,
      destZip: zipDest,
      injections: zipInjections
    });
  } else if (copyZip) {
    await fs.copyFile(packZip, zipDest);
  }

  if (versionLockJarPath) {
    await fs.copyFile(versionLockJarPath, path.join(outDir, serverLockModRelPath));
  }

  const artifactPath = await pathExists(zipDest) ? zipDest : packZip;
  const stats = await fs.stat(artifactPath);
  const sha256 = await hashFile(artifactPath, 'sha256');

  const latest = {
    schemaVersion: 1,
    packId,
    name: manifest.name,
    version,
    channel,
    createdAt: new Date().toISOString(),
    minecraft: manifest.minecraft,
    overrides: overridesDir,
    zip: {
      fileName: zipFileName,
      path: zipRelPath,
      url: artifactUrl(baseUrl, zipRelPath),
      sha256,
      size: stats.size
    },
    curseforge: {
      fileCount: manifestFiles.length
    },
    cacheManifest: {
      path: 'cache/mod-cache.json',
      url: artifactUrl(baseUrl, 'cache/mod-cache.json')
    },
    serverLock: {
      configPath: serverLockRelPath,
      modPath: serverLockModRelPath,
      clientModPath: clientVersionLockPath,
      injected: injectClientVersionLock
    },
    itemFireFix: {
      clientModPath: clientItemFireFixPath,
      injected: injectClientItemFireFix
    },
    required: true
  };

  const { cacheManifest, cacheSummary } = await buildFallbackCache({
    manifestFiles,
    outDir,
    packId,
    cacheModsDir
  });

  const report = {
    schemaVersion: 1,
    packId,
    name: manifest.name,
    version,
    sourceZip: {
      path: packZip,
      fileName: path.basename(packZip),
      versionHint: versionHintFromFileName(packZip)
    },
    minecraft: manifest.minecraft,
    curseforgeManifestFiles: latest.curseforge.fileCount,
    cacheSummary,
    overrideSummary,
    output: {
      latest: 'latest.json',
      packZip: zipRelPath,
      cacheManifest: 'cache/mod-cache.json',
      serverLockConfig: serverLockRelPath,
      serverLockMod: serverLockModRelPath,
      clientVersionLockMod: clientVersionLockPath,
      clientItemFireFixMod: clientItemFireFixPath
    }
  };

  await writeJsonFile(path.join(outDir, 'latest.json'), latest);
  await writeJsonFile(path.join(outDir, 'cache', 'mod-cache.json'), cacheManifest);
  await fs.writeFile(path.join(outDir, serverLockRelPath), serverLockConfig({ packId, version }), 'utf8');
  await writeJsonFile(path.join(outDir, 'release-report.json'), report);

  return { latest, report, outDir };
}
