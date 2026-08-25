import crypto from 'node:crypto';
import nodeFsSync from 'node:fs';
import nodeFs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const require = createRequire(import.meta.url);
let fsSync = nodeFsSync;
try {
  fsSync = require('original-fs');
} catch {
  // original-fs exists only inside Electron. Plain Node tests use node:fs.
}
const fs = fsSync.promises || nodeFs;

const STAGING_RECEIPT_SCHEMA = 'aht-launcher-staged-update/v1';
const MAX_ARCHIVE_FILES = 20_000;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error) reject(error);
      else resolve(zipFile);
    });
  });
}

function openEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function zipEntryIsSymlink(entry) {
  const unixMode = (Number(entry.externalFileAttributes || 0) >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function safeArchivePath(rawName = '') {
  const original = String(rawName || '');
  if (!original || original.includes('\0')) {
    throw new Error('Launcher update ZIP contains an empty or invalid path.');
  }
  const slashPath = original.replaceAll('\\', '/');
  if (slashPath.startsWith('/') || /^[a-z]:/i.test(slashPath)) {
    throw new Error(`Launcher update ZIP contains an absolute path: ${original}`);
  }
  const segments = slashPath.split('/');
  if (segments.at(-1) === '') segments.pop();
  const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (!segments.length || segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || /[<>:"|?*]/.test(segment)
    || /[. ]$/.test(segment)
    || reservedWindowsName.test(segment)
  ))) {
    throw new Error(`Launcher update ZIP contains an unsafe path: ${original}`);
  }
  const normalized = segments.map((segment) => segment.normalize('NFC')).join('/');
  if (normalized.length > 1024) {
    throw new Error(`Launcher update ZIP path is too long: ${original}`);
  }
  return normalized;
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function extractLauncherZip(archivePath, extractRoot, onProgress = () => {}) {
  const zipFile = await openZip(archivePath);
  const seen = new Set();
  let fileCount = 0;
  let declaredBytes = 0;
  let extractedBytes = 0;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zipFile.on('entry', (entry) => {
        Promise.resolve().then(async () => {
          const relPath = safeArchivePath(entry.fileName);
          const duplicateKey = relPath.toLowerCase();
          if (seen.has(duplicateKey)) {
            throw new Error(`Launcher update ZIP contains a duplicate path: ${relPath}`);
          }
          seen.add(duplicateKey);
          if (zipEntryIsSymlink(entry)) {
            throw new Error(`Launcher update ZIP contains a symbolic link: ${relPath}`);
          }
          fileCount += 1;
          declaredBytes += Math.max(0, Number(entry.uncompressedSize || 0));
          if (fileCount > MAX_ARCHIVE_FILES || declaredBytes > MAX_ARCHIVE_BYTES) {
            throw new Error('Launcher update ZIP exceeds the safe extraction limits.');
          }
          const target = path.resolve(extractRoot, ...relPath.split('/'));
          if (!pathInside(extractRoot, target)) {
            throw new Error(`Launcher update ZIP escapes the staging directory: ${relPath}`);
          }
          if (/\/$/.test(entry.fileName)) {
            await fs.mkdir(target, { recursive: true });
            return;
          }
          await fs.mkdir(path.dirname(target), { recursive: true });
          const source = await openEntryStream(zipFile, entry);
          const output = fsSync.createWriteStream(target, { flags: 'wx' });
          source.on('data', (chunk) => {
            extractedBytes += chunk.length;
            onProgress({ completed: extractedBytes, total: declaredBytes, currentPath: relPath });
          });
          await pipeline(source, output);
        }).then(() => {
          if (!settled) zipFile.readEntry();
        }, fail);
      });
      zipFile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zipFile.on('error', fail);
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
  return { fileCount, declaredBytes, extractedBytes };
}

async function listTreeFiles(root) {
  const files = [];
  async function visit(current, prefix = '') {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`Launcher update staging contains a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        files.push({ absolute, relative: relative.replaceAll('\\', '/') });
      } else {
        throw new Error(`Launcher update staging contains an unsupported entry: ${relative}`);
      }
    }
  }
  await visit(root);
  return files;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fsSync.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function versionMatches(actual = '', expected = '') {
  const cleanActual = String(actual || '').trim();
  const cleanExpected = String(expected || '').trim();
  return Boolean(cleanActual && cleanExpected && (cleanActual === cleanExpected || cleanActual.startsWith(`${cleanExpected}.`)));
}

async function copyInstallerOwnedFiles(installDir, payloadRoot) {
  let entries = [];
  try {
    entries = await fs.readdir(installDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const preserved = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^(?:uninstall .+\.exe|uninstall.*\.(?:dat|json))$/i.test(entry.name)) continue;
    const destination = path.join(payloadRoot, entry.name);
    try {
      await fs.copyFile(path.join(installDir, entry.name), destination, fsSync.constants.COPYFILE_EXCL);
      preserved.push(entry.name);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return preserved;
}

async function buildReceipt(stagingDir, options = {}) {
  const files = [];
  for (const entry of await listTreeFiles(stagingDir)) {
    const stat = await fs.stat(entry.absolute);
    files.push({
      path: entry.relative,
      size: stat.size,
      sha256: await sha256File(entry.absolute)
    });
  }
  const treeHash = crypto.createHash('sha256');
  for (const file of files) {
    treeHash.update(file.path.toLowerCase());
    treeHash.update('\0');
    treeHash.update(String(file.size));
    treeHash.update('\0');
    treeHash.update(file.sha256);
    treeHash.update('\0');
  }
  return {
    schema: STAGING_RECEIPT_SCHEMA,
    expectedVersion: String(options.expectedVersion || ''),
    productVersion: String(options.productVersion || ''),
    targetExeRelativePath: String(options.targetExeRelativePath || '').replaceAll('\\', '/'),
    archiveSha256: String(options.archiveSha256 || '').toLowerCase(),
    createdAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    treeSha256: treeHash.digest('hex'),
    preservedInstallerFiles: options.preservedInstallerFiles || [],
    files
  };
}

export async function stageWindowsLauncherUpdate(options = {}) {
  const archivePath = path.resolve(String(options.archivePath || ''));
  const installDir = path.resolve(String(options.installDir || ''));
  const stagingDir = path.resolve(String(options.stagingDir || ''));
  const extractRoot = path.resolve(String(options.extractRoot || `${stagingDir}.extracting`));
  const targetExeName = String(options.targetExeName || '').trim();
  const expectedVersion = String(options.expectedVersion || '').trim();
  const readProductVersion = options.readProductVersion;

  if (!archivePath || !installDir || !stagingDir || !targetExeName || !expectedVersion) {
    throw new Error('Launcher update staging requires archive, install, target, staging, and version inputs.');
  }
  if (path.dirname(stagingDir).toLowerCase() !== path.dirname(installDir).toLowerCase()) {
    throw new Error('Launcher update staging must be a same-volume sibling of the installed launcher.');
  }
  if (stagingDir.toLowerCase() === installDir.toLowerCase() || extractRoot.toLowerCase() === installDir.toLowerCase()) {
    throw new Error('Launcher update staging paths must not replace the installed launcher before Restart.');
  }
  if (typeof readProductVersion !== 'function') {
    throw new Error('Launcher update staging requires an executable version reader.');
  }

  await fs.rm(extractRoot, { recursive: true, force: true });
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(extractRoot, { recursive: true });
  try {
    const extraction = await extractLauncherZip(archivePath, extractRoot, options.onProgress);
    const extractedFiles = await listTreeFiles(extractRoot);
    const matchingExecutables = extractedFiles.filter((entry) => path.basename(entry.relative).toLowerCase() === targetExeName.toLowerCase());
    if (matchingExecutables.length !== 1) {
      throw new Error(`Launcher update ZIP must contain exactly one ${targetExeName}; found ${matchingExecutables.length}.`);
    }
    const payloadRoot = path.dirname(matchingExecutables[0].absolute);
    if (extractedFiles.some((entry) => !pathInside(payloadRoot, entry.absolute))) {
      throw new Error('Launcher update ZIP contains files outside the packaged application root.');
    }
    const stagedAsar = path.join(payloadRoot, 'resources', 'app.asar');
    const stagedAsarStat = await fs.stat(stagedAsar).catch(() => null);
    if (!stagedAsarStat?.isFile() || stagedAsarStat.size <= 0) {
      throw new Error('Launcher update ZIP is missing resources/app.asar.');
    }
    const candidateExe = path.join(payloadRoot, targetExeName);
    const productVersion = String(await readProductVersion(candidateExe) || '').trim();
    if (!versionMatches(productVersion, expectedVersion)) {
      throw new Error(`Launcher update executable version ${productVersion || 'unknown'} does not match ${expectedVersion}.`);
    }
    const preservedInstallerFiles = await copyInstallerOwnedFiles(installDir, payloadRoot);
    await fs.rename(payloadRoot, stagingDir);
    if (path.resolve(payloadRoot).toLowerCase() !== path.resolve(extractRoot).toLowerCase()) {
      await fs.rm(extractRoot, { recursive: true, force: true });
    }
    const receipt = await buildReceipt(stagingDir, {
      expectedVersion,
      productVersion,
      targetExeRelativePath: targetExeName,
      archiveSha256: options.archiveSha256,
      preservedInstallerFiles
    });
    return { stagingDir, targetExe: path.join(stagingDir, targetExeName), receipt, extraction };
  } catch (error) {
    await fs.rm(extractRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function validateStagedWindowsLauncherUpdate(options = {}) {
  const stagingDir = path.resolve(String(options.stagingDir || ''));
  const receipt = options.receipt;
  if (!receipt || receipt.schema !== STAGING_RECEIPT_SCHEMA || !Array.isArray(receipt.files)) {
    throw new Error('Launcher update staging receipt is missing or invalid.');
  }
  if (String(receipt.expectedVersion || '') !== String(options.expectedVersion || receipt.expectedVersion || '')) {
    throw new Error('Launcher update staging receipt version does not match the pending update.');
  }
  const actualFiles = await listTreeFiles(stagingDir);
  const actualByPath = new Map(actualFiles.map((entry) => [entry.relative.toLowerCase(), entry]));
  if (actualByPath.size !== receipt.files.length) {
    throw new Error(`Launcher update staging file count changed: expected ${receipt.files.length}, found ${actualByPath.size}.`);
  }
  for (const expected of receipt.files) {
    const actual = actualByPath.get(String(expected.path || '').toLowerCase());
    if (!actual) throw new Error(`Launcher update staging file is missing: ${expected.path}`);
    const stat = await fs.stat(actual.absolute);
    if (stat.size !== Number(expected.size)) {
      throw new Error(`Launcher update staging file size changed: ${expected.path}`);
    }
    if (options.verifyHashes !== false) {
      const actualSha256 = await sha256File(actual.absolute);
      if (actualSha256.toLowerCase() !== String(expected.sha256 || '').toLowerCase()) {
        throw new Error(`Launcher update staging file hash changed: ${expected.path}`);
      }
    }
  }
  const targetExe = path.join(stagingDir, ...String(receipt.targetExeRelativePath || '').split('/'));
  const appAsar = path.join(stagingDir, 'resources', 'app.asar');
  const [targetStat, asarStat] = await Promise.all([
    fs.stat(targetExe).catch(() => null),
    fs.stat(appAsar).catch(() => null)
  ]);
  if (!targetStat?.isFile() || !asarStat?.isFile()) {
    throw new Error('Launcher update staging no longer contains a runnable launcher payload.');
  }
  if (typeof options.readProductVersion === 'function') {
    const productVersion = String(await options.readProductVersion(targetExe) || '').trim();
    if (!versionMatches(productVersion, receipt.expectedVersion)) {
      throw new Error(`Launcher update staged executable version ${productVersion || 'unknown'} no longer matches ${receipt.expectedVersion}.`);
    }
  }
  return {
    ok: true,
    stagingDir,
    targetExe,
    fileCount: receipt.files.length,
    totalBytes: receipt.totalBytes,
    treeSha256: receipt.treeSha256
  };
}

export async function removeWindowsLauncherBackupDirectory(backupDir) {
  const target = path.resolve(String(backupDir || ''));
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return { removed: false, alreadyMissing: true };
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Launcher update backup is not a normal directory: ${target}`);
  }
  await listTreeFiles(target);
  await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  return { removed: true, alreadyMissing: false };
}

export { STAGING_RECEIPT_SCHEMA, safeArchivePath, versionMatches };
