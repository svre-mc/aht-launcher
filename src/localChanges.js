import fs from 'node:fs/promises';
import path from 'node:path';
import { hashFile, normalizeRelPath, pathExists, readJsonFile, safeJoin } from './utils.js';

const MONITORED_ROOTS = ['mods'];
const ALLOWED_UNMANAGED_MOD_DIRECTORIES = new Set(['openterraingenerator']);

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

function normalizeManagedModFiles(managed = []) {
  return managed
    .map((item) => ({
      ...item,
      relativePath: normalizeRelPath(String(item?.relativePath || ''))
    }))
    .filter((item) => item.relativePath.startsWith('mods/'));
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
  const target = path.join(root, rel);
  if (!(await pathExists(target))) {
    return [];
  }
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    return [{ abs: target, rel: rel.replaceAll(path.sep, '/'), size: stat.size }];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const entries = await fs.readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    state.visited += 1;
    if (state.visited % state.yieldEvery === 0) {
      await yieldToEventLoop();
    }
    if (entry.name === '.aht-launcher') {
      continue;
    }
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, childRel, { state }));
    } else if (entry.isFile()) {
      const childAbs = path.join(root, childRel);
      const childStat = await fs.stat(childAbs);
      files.push({ abs: childAbs, rel: childRel.replaceAll(path.sep, '/'), size: childStat.size });
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
  const managedDirs = managedDirectoryPrefixes(managedSet);
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

  const addDirectoryIssue = (rel) => {
    const folderPath = rel.endsWith('/') ? rel : `${rel}/`;
    if (managedSet.has(rel) || managedSet.has(folderPath) || isAllowedUnmanagedModPath(folderPath)) {
      return;
    }
    added.push({
      path: folderPath,
      size: 0,
      source: 'unmanaged-directory',
      entryType: 'directory'
    });
  };

  for (const root of MONITORED_ROOTS) {
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
        const folderPath = `${rel}/`;
        if (!managedDirs.has(folderPath.toLowerCase())) {
          addDirectoryIssue(rel);
        } else {
          for (const file of await walkFiles(rootPath, entry.name, { yieldEvery })) {
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

async function loadManaged(instanceDir) {
  const managedPath = path.join(instanceDir, '.aht-launcher', 'managed-files.json');
  if (!(await pathExists(managedPath))) {
    return [];
  }
  return readJsonFile(managedPath);
}

export async function scanLocalChanges(instanceDir, options = {}) {
  const limit = options.limit || 500;
  const managed = managedModFiles(await loadManaged(instanceDir), options.requiredManaged || []);
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
  added.push(...await scanAddedModFiles(instanceDir, managedSet, limit, { yieldEvery: 25 }));
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
    truncated: changed.length > limit || missing.length > limit || added.length > limit
  };
}

export async function scanManagedIntegrity(instanceDir, options = {}) {
  const limit = options.limit || 500;
  const managed = managedModFiles(await loadManaged(instanceDir), options.requiredManaged || []);
  const managedToCheck = managed.filter((item) => item.relativePath);
  const managedSet = new Set(managed.map((item) => item.relativePath));
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

  reportProgress('Scanning extra mods', managedToCheck.length, managedToCheck.length);
  const added = await scanAddedModFiles(instanceDir, managedSet, limit, { yieldEvery: 25 });
  reportProgress('Integrity scan complete', managedToCheck.length, managedToCheck.length);
  const corruptCount = changed.length + missing.length + added.length;
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
    truncated: changed.length > limit || missing.length > limit || added.length > limit
  };
}
