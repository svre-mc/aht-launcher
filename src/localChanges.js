import fs from 'node:fs/promises';
import path from 'node:path';
import { hashFile, normalizeRelPath, pathExists, readJsonFile, safeJoin } from './utils.js';

const MONITORED_ROOTS = ['mods'];

function managedModFiles(managed = []) {
  return managed
    .map((item) => ({
      ...item,
      relativePath: normalizeRelPath(String(item?.relativePath || ''))
    }))
    .filter((item) => item.relativePath.startsWith('mods/'));
}

async function walkFiles(root, rel = '') {
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
    if (entry.name === '.aht-launcher') {
      continue;
    }
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, childRel));
    } else if (entry.isFile()) {
      const childAbs = path.join(root, childRel);
      const childStat = await fs.stat(childAbs);
      files.push({ abs: childAbs, rel: childRel.replaceAll(path.sep, '/'), size: childStat.size });
    }
  }
  return files;
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
  const managed = managedModFiles(await loadManaged(instanceDir));
  const managedSet = new Set(managed.map((item) => item.relativePath));
  const changed = [];
  const missing = [];
  const added = [];

  for (const item of managed) {
    if (!item.relativePath) {
      continue;
    }
    const target = safeJoin(instanceDir, item.relativePath);
    if (!(await pathExists(target))) {
      missing.push({ path: item.relativePath, source: item.source || 'managed' });
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
  }

  for (const root of MONITORED_ROOTS) {
    const rootPath = safeJoin(instanceDir, root);
    for (const file of await walkFiles(rootPath)) {
      const rel = root.includes('.') ? root : `${root}/${file.rel}`;
      if (!managedSet.has(rel)) {
        added.push({
          path: rel,
          size: file.size,
          sha256: await hashFile(file.abs, 'sha256')
        });
      }
      if (added.length >= limit) {
        break;
      }
    }
    if (added.length >= limit) {
      break;
    }
  }

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
  const managed = managedModFiles(await loadManaged(instanceDir));
  const changed = [];
  const missing = [];
  let checked = 0;

  for (const item of managed) {
    if (!item.relativePath) {
      continue;
    }
    const target = safeJoin(instanceDir, item.relativePath);
    if (!(await pathExists(target))) {
      missing.push({ path: item.relativePath, source: item.source || 'managed' });
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
  }

  const corruptCount = changed.length + missing.length;
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
      corrupted: corruptCount
    },
    changed: changed.slice(0, limit),
    missing: missing.slice(0, limit),
    truncated: changed.length > limit || missing.length > limit
  };
}
