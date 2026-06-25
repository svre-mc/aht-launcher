import { Client } from 'ssh2';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_EXCLUDED_DIRS = ['DregoraRL'];

function excludedSet(excludeDirs = DEFAULT_EXCLUDED_DIRS) {
  return new Set(excludeDirs.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
}

function toRemotePath(value = '') {
  return String(value || '').replaceAll('\\', '/').replace(/\/+/g, '/');
}

function remoteJoin(root, relPath) {
  const cleanRoot = toRemotePath(root).replace(/\/+$/, '');
  const cleanRel = toRemotePath(relPath).replace(/^\/+/, '');
  return `${cleanRoot}/${cleanRel}`;
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
        await walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(childAbs);
      totalBytes += stat.size;
      files.push({
        localPath: childAbs,
        relativePath: childRel.replaceAll(path.sep, '/'),
        size: stat.size
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
    excludeDirs: [...excluded]
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

function sftpFastPut(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function ensureRemoteDir(sftp, remoteDir) {
  const clean = toRemotePath(remoteDir).replace(/\/+$/, '');
  if (!clean.startsWith('/')) {
    throw new Error(`Remote folder must be an absolute Linux path: ${remoteDir}`);
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

export async function uploadServerFiles(options = {}, hooks = {}) {
  const {
    sourceDir,
    remoteDir,
    host,
    port = 22,
    username,
    password,
    excludeDirs = DEFAULT_EXCLUDED_DIRS
  } = options;

  if (!host) throw new Error('Linux host/IP is required.');
  if (!username) throw new Error('Linux username is required.');
  if (!password) throw new Error('Linux password is required.');
  if (!remoteDir) throw new Error('Linux destination folder is required.');

  const plan = await collectServerTransferFiles(sourceDir, { excludeDirs });
  hooks.onProgress?.({ phase: 'Connecting', completed: 0, total: plan.fileCount, percent: 0 });
  hooks.logger?.log?.(`Connecting to ${username}@${host}:${port}`);
  const { client, sftp } = await connectSftp({ host, port, username, password });
  let uploaded = 0;
  let uploadedBytes = 0;
  try {
    await ensureRemoteDir(sftp, remoteDir);
    for (const file of plan.files) {
      const remotePath = remoteJoin(remoteDir, file.relativePath);
      await ensureRemoteDir(sftp, remotePath.slice(0, remotePath.lastIndexOf('/')));
      hooks.logger?.log?.(`Uploading ${file.relativePath}`);
      await sftpFastPut(sftp, file.localPath, remotePath);
      uploaded += 1;
      uploadedBytes += file.size;
      hooks.onProgress?.({
        phase: 'Uploading server files',
        currentPath: file.relativePath,
        completed: uploaded,
        total: plan.fileCount,
        percent: plan.fileCount ? Math.round((uploaded / plan.fileCount) * 100) : 100
      });
    }
    hooks.logger?.log?.(`Uploaded ${uploaded}/${plan.fileCount} files to ${remoteDir}`);
    return {
      ok: true,
      sourceDir: plan.sourceDir,
      remoteDir,
      host,
      username,
      uploaded,
      uploadedBytes,
      fileCount: plan.fileCount,
      totalBytes: plan.totalBytes,
      excludedDirs: plan.excludedDirs
    };
  } finally {
    client.end();
  }
}

export { DEFAULT_EXCLUDED_DIRS };
