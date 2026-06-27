import { Client } from 'ssh2';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_INCLUDED_DIRS = ['mods', 'scripts', 'config', 'ForgeEssentials'];
const DEFAULT_EXCLUDED_DIRS = ['DregoraRL'];

function excludedSet(excludeDirs = DEFAULT_EXCLUDED_DIRS) {
  return new Set(excludeDirs.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
}

function includedSet(includeDirs = DEFAULT_INCLUDED_DIRS) {
  return new Set(includeDirs.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
}

function toRemotePath(value = '') {
  return String(value || '').replaceAll('\\', '/').replace(/\/+/g, '/');
}

function remoteJoin(root, relPath) {
  const cleanRoot = toRemotePath(root).replace(/\/+$/, '');
  const cleanRel = toRemotePath(relPath).replace(/^\/+/, '');
  return `${cleanRoot}/${cleanRel}`;
}

function remoteDirName(remotePath) {
  const normalized = toRemotePath(remotePath);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function clampConcurrency(value, fallback = 6, max = 16) {
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

export async function collectServerTransferFiles(sourceDir, options = {}) {
  if (!sourceDir) {
    throw new Error('Server source folder is required.');
  }
  const root = path.resolve(sourceDir);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Server source is not a folder: ${root}`);
  }

  const excluded = excludedSet(options.excludeDirs || DEFAULT_EXCLUDED_DIRS);
  const includedRootDirs = includedSet(options.includeDirs || DEFAULT_INCLUDED_DIRS);
  const includeRootFiles = options.includeRootFiles !== false;
  const files = [];
  const excludedDirs = [];
  let totalBytes = 0;

  async function walk(current, rel = '') {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const childAbs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name.toLowerCase())) {
          excludedDirs.push(childRel.replaceAll(path.sep, '/'));
          continue;
        }
        if (!rel && includedRootDirs.size && !includedRootDirs.has(entry.name.toLowerCase())) {
          excludedDirs.push(childRel.replaceAll(path.sep, '/'));
          continue;
        }
        await walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!rel && !includeRootFiles) {
        continue;
      }
      const stat = await fs.stat(childAbs);
      totalBytes += stat.size;
      files.push({
        localPath: childAbs,
        relativePath: childRel.replaceAll(path.sep, '/'),
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }
  }

  await walk(root);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  excludedDirs.sort((a, b) => a.localeCompare(b));
  return {
    sourceDir: root,
    files,
    fileCount: files.length,
    totalBytes,
    excludedDirs,
    excludeDirs: [...excluded],
    includeDirs: [...includedRootDirs],
    includeRootFiles
  };
}

function connectSftp({ host, port = 22, username, password }) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(error);
    };
    client.once('ready', () => {
      client.sftp((error, sftp) => {
        if (error) {
          fail(error);
          return;
        }
        settled = true;
        resolve({ client, sftp });
      });
    });
    client.once('error', fail);
    client.connect({
      host,
      port: Number(port) || 22,
      username,
      password,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000
    });
  });
}

function sftpStat(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) reject(error);
      else resolve(stats);
    });
  });
}

function sftpMkdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpFastPut(sftp, localPath, remotePath, options = {}) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpSetstat(sftp, remotePath, attrs) {
  return new Promise((resolve, reject) => {
    sftp.setstat(remotePath, attrs, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createRemoteDirEnsurer(sftp) {
  const checked = new Set();
  return async function ensureRemoteDir(remoteDir) {
    const clean = toRemotePath(remoteDir).replace(/\/+$/, '');
    if (!clean.startsWith('/')) {
      throw new Error(`Remote folder must be an absolute remote path: ${remoteDir}`);
    }
    if (clean === '') {
      return;
    }
    const parts = clean.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = `${current}/${part}`;
      if (checked.has(current)) {
        continue;
      }
      try {
        const stats = await sftpStat(sftp, current);
        if (!stats.isDirectory()) {
          throw new Error(`Remote path exists but is not a folder: ${current}`);
        }
      } catch (error) {
        if (error.code === 2 || /no such file/i.test(error.message || '')) {
          await sftpMkdir(sftp, current);
        } else {
          throw error;
        }
      }
      checked.add(current);
    }
  };
}

async function ensureRemoteDir(sftp, remoteDir) {
  const clean = toRemotePath(remoteDir).replace(/\/+$/, '');
  if (!clean.startsWith('/')) {
    throw new Error(`Remote folder must be an absolute remote path: ${remoteDir}`);
  }
  const parts = clean.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = `${current}/${part}`;
    try {
      const stats = await sftpStat(sftp, current);
      if (!stats.isDirectory()) {
        throw new Error(`Remote path exists but is not a folder: ${current}`);
      }
    } catch (error) {
      if (error.code === 2 || /no such file/i.test(error.message || '')) {
        await sftpMkdir(sftp, current);
      } else {
        throw error;
      }
    }
  }
}

async function remoteFileIsCurrent(sftp, file, remotePath) {
  try {
    const stats = await sftpStat(sftp, remotePath);
    if (!stats.isFile() || stats.size !== file.size) {
      return false;
    }
    const remoteMtimeMs = Number(stats.mtime || 0) * 1000;
    return remoteMtimeMs >= Number(file.mtimeMs || 0) - 2000;
  } catch (error) {
    if (error.code === 2 || /no such file/i.test(error.message || '')) {
      return false;
    }
    throw error;
  }
}

export async function uploadServerFiles(options = {}, hooks = {}) {
  const {
    sourceDir,
    remoteDir,
    host,
    port = 22,
    username,
    password,
    excludeDirs = DEFAULT_EXCLUDED_DIRS,
    includeDirs = DEFAULT_INCLUDED_DIRS,
    includeRootFiles = true,
    concurrency = 6,
    fastPutConcurrency = 64,
    chunkSize = 256 * 1024
  } = options;

  if (!host) throw new Error('Server host/IP is required.');
  if (!username) throw new Error('Server username is required.');
  if (!password) throw new Error('Server password is required.');
  if (!remoteDir) throw new Error('Remote destination folder is required.');

  const plan = await collectServerTransferFiles(sourceDir, { excludeDirs, includeDirs, includeRootFiles });
  hooks.onProgress?.({
    phase: 'Connecting',
    completed: 0,
    total: plan.fileCount,
    completedBytes: 0,
    totalBytes: plan.totalBytes,
    uploaded: 0,
    skipped: 0,
    percent: 0
  });
  hooks.logger?.log?.(`Connecting to ${username}@${host}:${port}`);
  const { client, sftp } = await connectSftp({ host, port, username, password });
  const ensureRemoteDirCached = createRemoteDirEnsurer(sftp);
  let uploaded = 0;
  let skipped = 0;
  let uploadedBytes = 0;
  let skippedBytes = 0;
  let completedBytes = 0;
  const activeBytes = new Map();
  const fileConcurrency = clampConcurrency(concurrency);
  const putConcurrency = Math.max(1, Math.min(Number(fastPutConcurrency) || 64, 128));
  const putChunkSize = Math.max(32 * 1024, Math.min(Number(chunkSize) || 256 * 1024, 1024 * 1024));
  let lastStepEmit = 0;
  const emitProgress = (phase, currentPath = '') => {
    const inFlightBytes = [...activeBytes.values()].reduce((sum, value) => sum + value, 0);
    const byteDone = Math.min(plan.totalBytes, completedBytes + inFlightBytes);
    hooks.onProgress?.({
      phase,
      currentPath,
      completed: uploaded + skipped,
      total: plan.fileCount,
      completedBytes: byteDone,
      totalBytes: plan.totalBytes,
      uploaded,
      skipped,
      percent: plan.totalBytes ? Math.round((byteDone / plan.totalBytes) * 100) : plan.fileCount ? Math.round(((uploaded + skipped) / plan.fileCount) * 100) : 100
    });
  };

  try {
    await ensureRemoteDirCached(remoteDir);
    const remoteDirs = [...new Set(plan.files.map((file) => remoteDirName(remoteJoin(remoteDir, file.relativePath))))]
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const dir of remoteDirs) {
      await ensureRemoteDirCached(dir);
    }
    hooks.logger?.log?.(`Prepared ${remoteDirs.length} remote folders. Uploading up to ${fileConcurrency} files at once.`);
    emitProgress('Checking remote files');

    await runConcurrent(plan.files, fileConcurrency, async (file) => {
      const remotePath = remoteJoin(remoteDir, file.relativePath);
      if (await remoteFileIsCurrent(sftp, file, remotePath)) {
        skipped += 1;
        skippedBytes += file.size;
        completedBytes += file.size;
        hooks.logger?.log?.(`Skipping unchanged ${file.relativePath}`);
        emitProgress('Skipping unchanged files', file.relativePath);
        return { relativePath: file.relativePath, skipped: true };
      }

      hooks.logger?.log?.(`Uploading ${file.relativePath}`);
      activeBytes.set(file.relativePath, 0);
      await sftpFastPut(sftp, file.localPath, remotePath, {
        concurrency: putConcurrency,
        chunkSize: putChunkSize,
        step: (transferred) => {
          activeBytes.set(file.relativePath, Math.min(Number(transferred || 0), file.size));
          const now = Date.now();
          if (now - lastStepEmit > 250) {
            lastStepEmit = now;
            emitProgress('Uploading server files', file.relativePath);
          }
        }
      });
      activeBytes.delete(file.relativePath);
      const mtime = Math.floor(Number(file.mtimeMs || Date.now()) / 1000);
      await sftpSetstat(sftp, remotePath, { atime: mtime, mtime }).catch(() => {});
      uploaded += 1;
      uploadedBytes += file.size;
      completedBytes += file.size;
      emitProgress('Uploading server files', file.relativePath);
      return { relativePath: file.relativePath, skipped: false };
    });
    hooks.logger?.log?.(`Uploaded ${uploaded} changed files and skipped ${skipped} unchanged files to ${remoteDir}`);
    return {
      ok: true,
      sourceDir: plan.sourceDir,
      remoteDir,
      host,
      username,
      uploaded,
      skipped,
      uploadedBytes,
      skippedBytes,
      fileCount: plan.fileCount,
      totalBytes: plan.totalBytes,
      concurrency: fileConcurrency,
      fastPutConcurrency: putConcurrency,
      chunkSize: putChunkSize,
      excludedDirs: plan.excludedDirs,
      includeDirs: plan.includeDirs,
      includeRootFiles: plan.includeRootFiles
    };
  } finally {
    client.end();
  }
}

export { DEFAULT_EXCLUDED_DIRS, DEFAULT_INCLUDED_DIRS };
