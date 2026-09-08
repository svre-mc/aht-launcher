import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashFile, normalizeRelPath, pathExists, readJsonFile, safeJoin } from './utils.js';

const MODS_ONLY_MONITORED_ROOTS = Object.freeze(['mods']);
const LAUNCH_CRITICAL_MONITORED_ROOTS = Object.freeze([
  'fancymenu_data',
  'mods',
  'resourcepacks',
  'resources',
  'scripts',
  'structures'
]);
const ALLOWED_UNMANAGED_MOD_DIRECTORIES = new Set(['openterraingenerator']);
const PLAYER_MUTABLE_MANAGED_ROOTS = new Set(['config']);
const PLAYER_MUTABLE_MANAGED_FILES = new Set([
  'options.txt',
  'optionsof.txt',
  'optionsshaders.txt',
  'servers.dat',
  'servers.dat_old'
]);

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function progressEmitter(options = {}, defaultPhase = 'Scanning files') {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  if (!onProgress) {
    return () => {};
  }
  return (phase = defaultPhase, completed = 0, total = 0, currentPath = '') => {
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCompleted = Math.max(0, Number(completed) || 0);
    onProgress({
      phase,
      currentPath,
      completed: safeCompleted,
      total: safeTotal,
      percent: safeTotal ? Math.max(0, Math.min(100, Math.round((safeCompleted / safeTotal) * 100))) : 0
    });
  };
}

function normalizeManagedFiles(managed = []) {
  return managed
    .map((item) => ({
      ...item,
      relativePath: normalizeRelPath(String(item?.relativePath || ''))
    }))
    .filter((item) => item.relativePath);
}

function normalizeManagedModFiles(managed = []) {
  return normalizeManagedFiles(managed)
    .filter((item) => item.relativePath.startsWith('mods/'));
}

function managedFiles(managed = [], requiredManaged = []) {
  const byPath = new Map();
  for (const item of normalizeManagedFiles(managed)) {
    byPath.set(item.relativePath, item);
  }
  for (const item of normalizeManagedFiles(requiredManaged)) {
    byPath.set(item.relativePath, item);
  }
  return [...byPath.values()];
}

export function isLaunchCriticalManagedPath(relativePath = '') {
  const normalized = normalizeRelPath(String(relativePath || '')).toLowerCase();
  if (!normalized || PLAYER_MUTABLE_MANAGED_FILES.has(normalized)) return false;
  const [root] = normalized.split('/');
  return !PLAYER_MUTABLE_MANAGED_ROOTS.has(root);
}

export function launchCriticalManagedFiles(managed = []) {
  return managedFiles(managed, []).filter((item) => isLaunchCriticalManagedPath(item.relativePath));
}

function managedModFiles(managed = [], requiredManaged = []) {
  const byPath = new Map();
  for (const item of normalizeManagedModFiles(managed)) {
    byPath.set(item.relativePath, item);
  }
  for (const item of normalizeManagedModFiles(requiredManaged)) {
    byPath.set(item.relativePath, item);
  }
  return [...byPath.values()];
}

function isAllowedUnmanagedModPath(relPath = '') {
  const normalized = normalizeRelPath(relPath).toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  return parts.length >= 2
    && parts[0] === 'mods'
    && ALLOWED_UNMANAGED_MOD_DIRECTORIES.has(parts[1]);
}

async function walkFiles(root, rel = '', options = {}) {
  const state = options.state || { visited: 0, yieldEvery: Math.max(1, Number(options.yieldEvery) || 100) };
  const files = [];
  const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Math.max(0, Number(options.maxFiles)) : Infinity;
  const pending = [rel];

  while (pending.length && files.length < maxFiles) {
    const currentRel = pending.pop();
    const target = path.join(root, currentRel);
    if (!(await pathExists(target))) {
      continue;
    }
    const stat = await fs.stat(target);
    if (stat.isFile()) {
      files.push({ abs: target, rel: currentRel.replaceAll(path.sep, '/'), size: stat.size });
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    const entries = await fs.readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      state.visited += 1;
      if (state.visited % state.yieldEvery === 0) {
        await yieldToEventLoop();
      }
      if (entry.name === '.aht-launcher') {
        continue;
      }
      const childRel = currentRel ? path.join(currentRel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        pending.push(childRel);
      } else if (entry.isFile()) {
        const childAbs = path.join(root, childRel);
        const childStat = await fs.stat(childAbs);
        files.push({ abs: childAbs, rel: childRel.replaceAll(path.sep, '/'), size: childStat.size });
        if (files.length >= maxFiles) {
          break;
        }
      }
    }
  }
  return files;
}
function managedDirectoryPrefixes(managedSet) {
  const prefixes = new Set();
  for (const relPath of managedSet) {
    const parts = normalizeRelPath(relPath).split('/').filter(Boolean);
    let prefix = '';
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
      prefixes.add(`${prefix}/`.toLowerCase());
    }
  }
  return prefixes;
}

async function scanAddedModFiles(instanceDir, managedSet, limit, options = {}) {
  const added = [];
  const yieldEvery = Math.max(1, Number(options.yieldEvery) || 25);
  let visited = 0;

  const addFileIssue = async (abs, rel, size) => {
    if (managedSet.has(rel) || isAllowedUnmanagedModPath(rel)) {
      return;
    }
    added.push({
      path: rel,
      size,
      sha256: await hashFile(abs, 'sha256')
    });
  };

  const monitoredRoots = Array.isArray(options.monitoredRoots) && options.monitoredRoots.length
    ? options.monitoredRoots
    : MODS_ONLY_MONITORED_ROOTS;
  for (const root of monitoredRoots) {
    const rootPath = safeJoin(instanceDir, root);
    const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.aht-launcher') {
        continue;
      }
      visited += 1;
      if (visited % yieldEvery === 0) {
        await yieldToEventLoop();
      }
      const rel = normalizeRelPath(`${root}/${entry.name}`);
      if (isAllowedUnmanagedModPath(rel)) {
        continue;
      }
      if (entry.isDirectory()) {
        for (const file of await walkFiles(rootPath, entry.name, { yieldEvery, maxFiles: Math.max(0, limit - added.length + managedSet.size) })) {
          const fileRel = normalizeRelPath(`${root}/${file.rel}`);
          visited += 1;
          await addFileIssue(file.abs, fileRel, file.size);
          if (visited % yieldEvery === 0) {
            await yieldToEventLoop();
          }
          if (added.length >= limit) {
            break;
          }
        }
      } else if (entry.isFile()) {
        const stat = await fs.stat(path.join(rootPath, entry.name));
        await addFileIssue(path.join(rootPath, entry.name), rel, stat.size);
      }
      if (added.length >= limit) {
        break;
      }
    }
    if (added.length >= limit) {
      break;
    }
  }
  return added;
}

async function loadManaged(instanceDir, options = {}) {
  if (Array.isArray(options.managedFiles)) {
    return options.managedFiles;
  }
  if (options.ignoreLocalManaged === true && !options.managedPath) {
    return [];
  }
  const managedPath = options.managedPath
    ? path.resolve(options.managedPath)
    : path.join(instanceDir, '.aht-launcher', 'managed-files.json');
  if (!(await pathExists(managedPath))) {
    return [];
  }
  return readJsonFile(managedPath);
}

function statNanoseconds(stat, field) {
  const nanoseconds = stat?.[`${field}Ns`];
  if (typeof nanoseconds === 'bigint') return nanoseconds;
  return BigInt(Math.round(Number(stat?.[`${field}Ms`] || 0) * 1_000_000));
}

async function mapWithConcurrency(items = [], concurrency = 32, mapper = async (value) => value) {
  const values = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(items.length || 1, Number(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      values[index] = await mapper(items[index], index);
    }
  }));
  return values;
}

async function captureFingerprintFromManaged(instanceDir, managed = [], options = {}) {
  const managedSet = new Set(managed.map((item) => item.relativePath));
  const actualEntries = [];
  const actualFiles = new Set();
  const pending = [];
  let visited = 0;
  let latestChangeMs = 0;

  const managedManifestPath = options.managedPath
    ? path.resolve(options.managedPath)
    : (options.ignoreLocalManaged === true ? '' : path.join(instanceDir, '.aht-launcher', 'managed-files.json'));
  if (managedManifestPath) {
    try {
      const manifestStat = await fs.lstat(managedManifestPath, { bigint: true });
      const manifestMtimeNs = statNanoseconds(manifestStat, 'mtime');
      const manifestCtimeNs = statNanoseconds(manifestStat, 'ctime');
      latestChangeMs = Math.max(
        latestChangeMs,
        Number(manifestMtimeNs / 1_000_000n),
        Number(manifestCtimeNs / 1_000_000n)
      );
      actualEntries.push({
        path: 'managed-manifest-state',
        type: 'manifest',
        size: manifestStat.size.toString(),
        mtimeNs: manifestMtimeNs.toString(),
        ctimeNs: manifestCtimeNs.toString(),
        ino: manifestStat.ino.toString()
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const monitoredRoots = Array.isArray(options.monitoredRoots) && options.monitoredRoots.length
    ? options.monitoredRoots
    : MODS_ONLY_MONITORED_ROOTS;
  for (const root of monitoredRoots) {
    const rootPath = safeJoin(instanceDir, root);
    const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      pending.push({ abs: path.join(rootPath, entry.name), rel: normalizeRelPath(`${root}/${entry.name}`) });
    }
  }

  const traversalConcurrency = Math.max(1, Number(options.fingerprintConcurrency) || 48);
  while (pending.length) {
    const batch = pending.splice(0, traversalConcurrency);
    const outcomes = await mapWithConcurrency(batch, traversalConcurrency, async (current) => {
      if (isAllowedUnmanagedModPath(current.rel)) return null;
      let stat = null;
      try {
        options.onFingerprintPhysicalStat?.(current.rel);
        stat = await fs.lstat(current.abs, { bigint: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      const type = stat.isFile() ? 'file' : (stat.isDirectory() ? 'directory' : 'other');
      const mtimeNs = statNanoseconds(stat, 'mtime');
      const ctimeNs = statNanoseconds(stat, 'ctime');
      const state = {
        path: current.rel,
        type,
        size: stat.size.toString(),
        mtimeNs: mtimeNs.toString(),
        ctimeNs: ctimeNs.toString(),
        ino: stat.ino.toString()
      };
      const children = [];
      if (type === 'directory') {
        const entries = await fs.readdir(current.abs, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          children.push({
            abs: path.join(current.abs, entry.name),
            rel: normalizeRelPath(`${current.rel}/${entry.name}`)
          });
        }
      }
      return { state, children };
    });
    for (const outcome of outcomes) {
      if (!outcome) continue;
      const { state, children } = outcome;
      latestChangeMs = Math.max(
        latestChangeMs,
        Number(BigInt(state.mtimeNs) / 1_000_000n),
        Number(BigInt(state.ctimeNs) / 1_000_000n)
      );
      actualEntries.push(state);
      if (state.type === 'file') actualFiles.add(state.path);
      pending.push(...children);
      visited += 1;
    }
    if (visited && visited % 50 < batch.length) await yieldToEventLoop();
  }

  const expected = [...managed]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((item) => `${item.relativePath}|${item.sha256 || ''}|${item.sha1 || ''}`);
  // Directories are traversal scaffolding, not launchable managed content.
  // Ignore empty directory topology while retaining every file and non-file
  // node so an unmanaged payload or link still invalidates preparation.
  const contentEntries = actualEntries.filter((item) => item.type !== 'directory');
  const actual = contentEntries
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((item) => `${item.path}|${item.type}|${item.size}|${item.mtimeNs}|${item.ctimeNs}|${item.ino}`);
  const digest = createHash('sha256')
    .update(`managed\n${expected.join('\n')}\nactual\n${actual.join('\n')}\n`)
    .digest('hex');
  const unexpectedEntry = contentEntries.some((item) => {
    if (item.type === 'manifest') return false;
    if (item.type === 'file') return !managedSet.has(item.path);
    return true;
  });
  const pathsValid = !unexpectedEntry && managed.every((item) => actualFiles.has(item.relativePath));

  const fingerprint = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    digest,
    managedCount: managed.length,
    entryCount: contentEntries.length,
    pathsValid,
    latestChangeMs
  };
  if (options.includeFileStates === true) {
    fingerprint.fileStates = actualEntries
      .filter((item) => item.type !== 'directory')
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((item) => ({ ...item }));
  }
  return fingerprint;
}

export async function captureManagedModFingerprint(instanceDir, options = {}) {
  const managed = managedModFiles(await loadManaged(instanceDir, options), options.requiredManaged || []);
  return captureFingerprintFromManaged(instanceDir, managed, {
    ...options,
    monitoredRoots: MODS_ONLY_MONITORED_ROOTS
  });
}

async function captureIntegrityFingerprintFromManaged(instanceDir, managed = [], options = {}) {
  const normalizedManaged = managedFiles(managed, []);
  const launchCritical = launchCriticalManagedFiles(normalizedManaged);
  const pathSetFingerprint = await captureFingerprintFromManaged(
    instanceDir,
    launchCritical,
    { ...options, monitoredRoots: LAUNCH_CRITICAL_MONITORED_ROOTS, includeFileStates: true }
  );
  const traversedFileStates = new Map((pathSetFingerprint.fileStates || [])
    .map((item) => [normalizeRelPath(String(item?.path || '')), item]));
  delete pathSetFingerprint.fileStates;
  let latestChangeMs = Number(pathSetFingerprint.latestChangeMs) || 0;
  const actual = await mapWithConcurrency(
    normalizedManaged,
    options.fingerprintConcurrency || 48,
    async (item) => {
      const relativePath = item.relativePath;
      const traversed = traversedFileStates.get(relativePath);
      if (traversed) return { ...traversed };
      const target = safeJoin(instanceDir, relativePath);
      try {
        options.onFingerprintPhysicalStat?.(relativePath);
        const stat = await fs.lstat(target, { bigint: true });
        const mtimeNs = statNanoseconds(stat, 'mtime');
        const ctimeNs = statNanoseconds(stat, 'ctime');
        latestChangeMs = Math.max(
          latestChangeMs,
          Number(mtimeNs / 1_000_000n),
          Number(ctimeNs / 1_000_000n)
        );
        return {
          path: relativePath,
          type: stat.isFile() ? 'file' : (stat.isDirectory() ? 'directory' : 'other'),
          size: stat.size.toString(),
          mtimeNs: mtimeNs.toString(),
          ctimeNs: ctimeNs.toString(),
          ino: stat.ino.toString()
        };
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return { path: relativePath, type: 'missing', size: '0', mtimeNs: '0', ctimeNs: '0', ino: '0' };
        }
        throw error;
      }
    }
  );
  const expected = [...normalizedManaged]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((item) => `${item.relativePath}|${item.sha256 || ''}|${item.sha1 || ''}`);
  const actualRows = [...actual]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((item) => `${item.path}|${item.type}|${item.size}|${item.mtimeNs}|${item.ctimeNs}|${item.ino}`);
  const digest = createHash('sha256')
    .update(`managed\n${expected.join('\n')}\nactual\n${actualRows.join('\n')}\npath-set\n${pathSetFingerprint.digest}\n`)
    .digest('hex');

  const fingerprint = {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    digest,
    managedCount: normalizedManaged.length,
    entryCount: actual.length + Number(pathSetFingerprint.entryCount || 0),
    pathsValid: pathSetFingerprint.pathsValid && actual.every((item) => item.type === 'file'),
    latestChangeMs,
    pathSetDigest: pathSetFingerprint.digest,
    // Retained for schema-v2 cache compatibility; it now covers every
    // launch-critical content root, not only mods.
    modsDigest: pathSetFingerprint.digest
  };
  if (options.includeFileStates === true) {
    fingerprint.fileStates = [...actual]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((item) => ({ ...item }));
  }
  return fingerprint;
}

export async function captureManagedIntegrityFingerprint(instanceDir, options = {}) {
  const managed = managedFiles(await loadManaged(instanceDir, options), options.requiredManaged || []);
  return captureIntegrityFingerprintFromManaged(instanceDir, managed, options);
}

function fingerprintFileStateChanged(current = null, previous = null) {
  if (!current || !previous) return true;
  return ['type', 'size', 'mtimeNs', 'ctimeNs', 'ino']
    .some((field) => String(current[field] ?? '') !== String(previous[field] ?? ''));
}

function fingerprintStateChangedAfter(state = null, sinceMs = Number.NaN) {
  if (!state || !Number.isFinite(sinceMs)) return true;
  const cutoffNs = BigInt(Math.max(0, Math.floor(sinceMs))) * 1_000_000n;
  return BigInt(state.mtimeNs || '0') > cutoffNs || BigInt(state.ctimeNs || '0') > cutoffNs;
}

export async function verifyManagedIntegritySnapshot(instanceDir, options = {}) {
  const managed = launchCriticalManagedFiles(await loadManaged(instanceDir, options));
  const fingerprintWithStates = await captureIntegrityFingerprintFromManaged(instanceDir, managed, {
    ...options,
    includeFileStates: true
  });
  const fileStates = Array.isArray(fingerprintWithStates.fileStates)
    ? fingerprintWithStates.fileStates
    : [];
  const fingerprint = { ...fingerprintWithStates };
  delete fingerprint.fileStates;

  const previousStates = Array.isArray(options.previousFileStates) ? options.previousFileStates : [];
  const previousByPath = new Map(previousStates.map((item) => [normalizeRelPath(String(item?.path || '')), item]));
  const currentByPath = new Map(fileStates.map((item) => [normalizeRelPath(String(item?.path || '')), item]));
  const legacySinceMs = Date.parse(String(options.legacySince || ''));
  const hasPreviousStates = previousByPath.size > 0;
  const forcedPaths = new Set((Array.isArray(options.forcePaths) ? options.forcePaths : [])
    .map((item) => normalizeRelPath(String(item || '')))
    .filter(Boolean));
  const forceAll = options.forceAll === true;
  const onlyForced = options.onlyForced === true && (forceAll || forcedPaths.size > 0);
  const candidates = managed.filter((item) => {
    const current = currentByPath.get(item.relativePath);
    const forced = forceAll || [...forcedPaths]
      .some((forcedPath) => item.relativePath === forcedPath || item.relativePath.startsWith(`${forcedPath}/`));
    if (forced) return true;
    if (onlyForced) return false;
    if (!current || current.type !== 'file') return true;
    if (hasPreviousStates) {
      return fingerprintFileStateChanged(current, previousByPath.get(item.relativePath));
    }
    return fingerprintStateChangedAfter(current, legacySinceMs);
  });
  const issues = [];
  await mapWithConcurrency(candidates, options.hashConcurrency || 8, async (item) => {
    const state = currentByPath.get(item.relativePath);
    if (!state || state.type !== 'file') {
      issues.push({ path: item.relativePath, reason: state?.type || 'missing' });
      return;
    }
    const algorithm = item.sha256 ? 'sha256' : (item.sha1 ? 'sha1' : '');
    const expected = String(item[algorithm] || '').toLowerCase();
    if (!algorithm || !expected) {
      issues.push({ path: item.relativePath, reason: 'missing-trusted-hash' });
      return;
    }
    const actual = String(await hashFile(safeJoin(instanceDir, item.relativePath), algorithm)).toLowerCase();
    if (actual !== expected) {
      issues.push({ path: item.relativePath, reason: 'content-changed' });
    }
  });
  if (!fingerprint.pathsValid && !issues.length) {
    issues.push({ path: 'launch-critical-roots', reason: 'managed-path-set-changed' });
  }
  issues.sort((left, right) => left.path.localeCompare(right.path));
  return {
    valid: fingerprint.pathsValid === true && issues.length === 0,
    fingerprint,
    fileStates,
    managedFiles: managed,
    metadataChanges: candidates.length,
    hashedFiles: candidates.length,
    issues
  };
}

export async function scanLocalChanges(instanceDir, options = {}) {
  const limit = options.limit || 500;
  const managed = managedModFiles(await loadManaged(instanceDir, options), options.requiredManaged || []);
  const managedToCheck = managed.filter((item) => item.relativePath);
  const managedSet = new Set(managed.map((item) => item.relativePath));
  const changed = [];
  const missing = [];
  const added = [];
  const progressPhase = 'Scanning managed mods';
  const reportProgress = progressEmitter(options, progressPhase);
  let scanned = 0;
  reportProgress('Scanning managed mods', 0, managedToCheck.length);

  for (const item of managedToCheck) {
    if (!item.relativePath) {
      continue;
    }
    const target = safeJoin(instanceDir, item.relativePath);
    if (!(await pathExists(target))) {
      missing.push({ path: item.relativePath, source: item.source || 'managed' });
      scanned += 1;
      reportProgress(progressPhase, scanned, managedToCheck.length, item.relativePath);
      if (scanned % 10 === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    if (item.sha256) {
      const currentSha256 = await hashFile(target, 'sha256');
      if (currentSha256 !== item.sha256) {
        const stat = await fs.stat(target);
        changed.push({
          path: item.relativePath,
          source: item.source || 'managed',
          expectedSha256: item.sha256,
          currentSha256,
          size: stat.size
        });
      }
    }
    scanned += 1;
    reportProgress('Scanning managed mods', scanned, managedToCheck.length, item.relativePath);
    if (scanned % 10 === 0) {
      await yieldToEventLoop();
    }
  }

  reportProgress('Scanning extra mods', managedToCheck.length, managedToCheck.length);
  added.push(...await scanAddedModFiles(instanceDir, managedSet, limit, {
    yieldEvery: 25,
    monitoredRoots: MODS_ONLY_MONITORED_ROOTS
  }));
  reportProgress('Scan complete', managedToCheck.length, managedToCheck.length);

  return {
    generatedAt: new Date().toISOString(),
    instanceDir,
    counts: {
      managed: managed.length,
      changed: changed.length,
      missing: missing.length,
      added: added.length
    },
    changed: changed.slice(0, limit),
    missing: missing.slice(0, limit),
    added: added.slice(0, limit),
    truncated: changed.length > limit || missing.length > limit || (limit > 0 && added.length >= limit)
  };
}

export async function scanManagedIntegrity(instanceDir, options = {}) {
  const limit = options.limit || 500;
  const loadedManaged = await loadManaged(instanceDir, options);
  const managed = managedFiles(loadedManaged, options.requiredManaged || []);
  const launchCritical = launchCriticalManagedFiles(managed);
  const managedToCheck = managed.filter((item) => item.relativePath);
  const launchCriticalSet = new Set(launchCritical.map((item) => item.relativePath));
  const changed = [];
  const missing = [];
  const progressPhase = 'Verifying installed files';
  const reportProgress = progressEmitter(options, progressPhase);
  let checked = 0;
  let scanned = 0;
  reportProgress('Verifying installed files', 0, managedToCheck.length);

  for (const item of managedToCheck) {
    if (!item.relativePath) {
      continue;
    }
    const target = safeJoin(instanceDir, item.relativePath);
    if (!(await pathExists(target))) {
      missing.push({ path: item.relativePath, source: item.source || 'managed' });
      scanned += 1;
      reportProgress(progressPhase, scanned, managedToCheck.length, item.relativePath);
      if (scanned % 10 === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    checked += 1;
    if (item.sha256) {
      const currentSha256 = await hashFile(target, 'sha256');
      if (currentSha256 !== item.sha256) {
        const stat = await fs.stat(target);
        changed.push({
          path: item.relativePath,
          source: item.source || 'managed',
          expectedSha256: item.sha256,
          currentSha256,
          size: stat.size
        });
      }
    }
    scanned += 1;
    reportProgress('Verifying installed files', scanned, managedToCheck.length, item.relativePath);
    if (scanned % 10 === 0) {
      await yieldToEventLoop();
    }
  }

  reportProgress('Scanning extra launch content', managedToCheck.length, managedToCheck.length);
  const added = await scanAddedModFiles(instanceDir, launchCriticalSet, limit, {
    yieldEvery: 25,
    monitoredRoots: LAUNCH_CRITICAL_MONITORED_ROOTS
  });
  reportProgress('Integrity scan complete', managedToCheck.length, managedToCheck.length);
  const corruptCount = changed.length + missing.length + added.length;
  const fingerprint = await captureIntegrityFingerprintFromManaged(instanceDir, managed, options);
  return {
    generatedAt: new Date().toISOString(),
    instanceDir,
    valid: managed.length > 0 && corruptCount === 0,
    counts: {
      managed: managed.length,
      checked,
      ok: Math.max(0, checked - changed.length),
      changed: changed.length,
      missing: missing.length,
      added: added.length,
      corrupted: corruptCount
    },
    changed: changed.slice(0, limit),
    missing: missing.slice(0, limit),
    added: added.slice(0, limit),
    fingerprint,
    truncated: changed.length > limit || missing.length > limit || (limit > 0 && added.length >= limit)
  };
}
