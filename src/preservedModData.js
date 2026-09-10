import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJoin } from './utils.js';

export const PRESERVED_MOD_DATA_ROOT = 'mods/OpenTerrainGenerator';
// OTG owns generated terrain data, not an arbitrary executable search path.
const DATA_EXTENSIONS = new Set(['.ini', '.bc', '.bo2', '.bo3', '.bo4', '.nbt', '.dat', '.png', '.txt']);
const directoryCache = new Map();
const MAX_CACHED_DIRECTORIES = 16_384;
const signature = (stat) => [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':');

async function lstatOrMissing(target) {
  try { return await fs.lstat(target, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function inspectPreservedModData(instanceDir, { fresh = false } = {}) {
  const instance = await lstatOrMissing(path.resolve(instanceDir));
  if (!instance) return [];
  if (!instance.isDirectory() || instance.isSymbolicLink()) {
    throw Object.assign(new Error('Modified client. Repair.'), { code: 'AHT_MANAGED_CLIENT_CHANGED' });
  }
  const mods = await lstatOrMissing(safeJoin(instanceDir, 'mods'));
  if (!mods) return [];
  // Never traverse a linked parent, even if its target contains approved bytes.
  if (!mods.isDirectory() || mods.isSymbolicLink()) return [{ path: 'mods', reason: 'unsafe-mod-root' }];
  const roots = await fs.readdir(safeJoin(instanceDir, 'mods'), { withFileTypes: true });
  const pending = roots.filter((entry) => entry.name.toLowerCase() === PRESERVED_MOD_DATA_ROOT.split('/')[1].toLowerCase())
    .map((entry) => `mods/${entry.name}`);
  const issues = [];
  while (pending.length) {
    const batch = pending.splice(0, 48);
    const results = await Promise.all(batch.map(async (relativePath) => {
      const target = safeJoin(instanceDir, relativePath);
      const stat = await lstatOrMissing(target);
      if (!stat) return { directories: [], issues: [] };
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return { directories: [], issues: [{ path: relativePath, reason: 'unsafe-runtime-data-node' }] };
      }
      const key = signature(stat);
      const cached = fresh ? null : directoryCache.get(target);
      if (cached?.signature === key) return cached;
      const entries = await fs.readdir(target, { withFileTypes: true });
      const after = await lstatOrMissing(target);
      if (!after || !after.isDirectory() || signature(after) !== key) {
        throw Object.assign(new Error('Modified client. Repair.'), { code: 'AHT_MANAGED_CLIENT_CHANGED' });
      }
      const result = { signature: key, directories: [], issues: [] };
      for (const entry of entries) {
        const child = `${relativePath}/${entry.name}`;
        if (entry.isDirectory() && !entry.isSymbolicLink()) result.directories.push(child);
        else if (!entry.isFile() || !DATA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          result.issues.push({ path: child, reason: 'unapproved-runtime-data-file' });
        }
      }
      directoryCache.delete(target);
      directoryCache.set(target, result);
      if (directoryCache.size > MAX_CACHED_DIRECTORIES) directoryCache.delete(directoryCache.keys().next().value);
      return result;
    }));
    for (const result of results) {
      for (const directory of result.directories) pending.push(directory);
      for (const issue of result.issues) issues.push(issue);
    }
  }
  return issues;
}

export async function removeUnapprovedPreservedModData(instanceDir) {
  const issues = await inspectPreservedModData(instanceDir, { fresh: true });
  for (const issue of issues) {
    // Resolve every parent without following links before unlinking one node.
    // Never recursively delete through a runtime-data link or outside the instance.
    const parts = issue.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = await fs.lstat(safeJoin(instanceDir, parts.slice(0, index).join('/')));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Repair stopped: client directory changed.');
    }
    const target = safeJoin(instanceDir, issue.path);
    // A successful unlink need not produce a distinct directory timestamp on
    // every filesystem. Never reuse the findings we just repaired (or attempted).
    directoryCache.delete(path.dirname(target));
    directoryCache.delete(target);
    const stat = await lstatOrMissing(target);
    if (!stat) continue;
    if (stat.isDirectory() && !stat.isSymbolicLink()) throw new Error('Repair stopped: unexpected directory change.');
    await fs.unlink(target);
  }
  return issues.map((issue) => issue.path);
}
