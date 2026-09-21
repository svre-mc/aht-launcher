import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { downloadToFile, hashFile, safeJoin, writeJsonFile } from './utils.js';
import { renameRuntimeDirectory } from './runtimeFileOps.js';

export const WINDOWS_TEMURIN8 = Object.freeze({
  version: '8u504-b01',
  fileName: 'OpenJDK8U-jre_x64_windows_hotspot_8u504b01.zip',
  url: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u504-b01/OpenJDK8U-jre_x64_windows_hotspot_8u504b01.zip',
  sha256: '82e2cdc6693737c5998445b31f69668fa0da77c7705121053f6508ac84961123',
  size: 40104826,
  sourceUrl: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u504-b01/OpenJDK8U-jdk-sources_8u504b01.tar.gz'
});

export function bundledJava8ArchivePath(resourcesPath = process.resourcesPath || '') {
  return resourcesPath
    ? path.join(resourcesPath, 'java', WINDOWS_TEMURIN8.fileName)
    : fileURLToPath(new URL(`../build/runtime/java/${WINDOWS_TEMURIN8.fileName}`, import.meta.url));
}

export async function verifyJava8Archive(file, descriptor = WINDOWS_TEMURIN8) {
  const stat = await fs.stat(file).catch(() => null);
  return Boolean(stat?.isFile() && stat.size === descriptor.size
    && await hashFile(file, 'sha256') === descriptor.sha256);
}

const inFlight = new Map();
const verified = new Map();

// All runtime files come from the checksum-pinned archive. Checking the whole
// manifest catches missing/corrupt JVM libraries that a java -version probe misses.
async function verifyInstalled(root, descriptor) {
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(root, 'aht-runtime.json'), 'utf8'));
    if (receipt.archiveSha256 !== descriptor.sha256 || !receipt.files?.length) return null;
    for (const item of receipt.files) {
      const file = safeJoin(root, item.path);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size !== item.size || await hashFile(file, 'sha256') !== item.sha256) return null;
    }
    return safeJoin(root, receipt.javaPath);
  } catch { return null; }
}

export async function ensureBundledJava8(options) {
  const key = path.resolve(options.cacheDir);
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = installBundledJava8({ ...options, cacheDir: key }).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

async function installBundledJava8({ cacheDir, archivePath = bundledJava8ArchivePath(), descriptor = WINDOWS_TEMURIN8,
  probe, refresh = false, logger = null, allowDownload = true }) {
  if (typeof probe !== 'function') throw new Error('Bundled Java requires an executable probe.');
  const root = path.join(cacheDir, 'temurin8');
  if (!refresh && verified.get(root)?.sha256 === descriptor.sha256) {
    const cached = verified.get(root).runtime;
    if ((await fs.stat(cached.javaPath).catch(() => null))?.isFile()) return cached;
    verified.delete(root);
  }
  const existing = await verifyInstalled(root, descriptor);
  if (existing) {
    const runtime = await probe(existing);
    if (runtime.usable) {
      const result = { ...runtime, javaPath: existing, managed: true, bundled: true };
      verified.set(root, { sha256: descriptor.sha256, runtime: result });
      return result;
    }
  }
  verified.delete(root);
  await fs.mkdir(cacheDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(cacheDir, '.temurin8-stage-'));
  const extracted = path.join(staging, 'runtime');
  const previous = path.join(staging, 'previous');
  let movedPrevious = false;
  let promoted = false;
  let recovered = true;
  try {
    let source = archivePath;
    if (!(await verifyJava8Archive(source, descriptor))) {
      if (!allowDownload) throw new Error('The bundled Temurin 8 archive is missing or damaged.');
      source = path.join(staging, 'temurin8.zip');
      logger?.log?.('Restoring the pinned Temurin 8 package...');
      await downloadToFile(descriptor.url, source, { timeoutMs: 120_000, retries: 2, logger });
      if (!(await verifyJava8Archive(source, descriptor))) throw new Error('Temurin 8 package checksum verification failed.');
    }
    logger?.log?.('Preparing AHT’s bundled Temurin 8 runtime...');
    await fs.mkdir(extracted);
    const zip = new AdmZip(source);
    const files = [];
    let javaPath = '';
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replaceAll('\\', '/');
      const target = safeJoin(extracted, name);
      if (entry.isDirectory) { await fs.mkdir(target, { recursive: true }); continue; }
      const bytes = entry.getData();
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      files.push({ path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      if (name.endsWith('/bin/java.exe')) javaPath = name;
    }
    if (!javaPath || !files.some((item) => /(?:^|\/)LICENSE$/.test(item.path))) {
      throw new Error('Temurin 8 package is missing its executable or license.');
    }
    // Do not execute Java from staging: Windows may keep its executable or DLLs
    // locked after the probe exits, preventing the final directory move.
    await writeJsonFile(path.join(extracted, 'aht-runtime.json'), {
      schemaVersion: 1, version: descriptor.version, archiveSha256: descriptor.sha256,
      sourceUrl: descriptor.sourceUrl, javaPath, files
    });
    if (await fs.stat(root).catch(() => null)) { await renameRuntimeDirectory(root, previous, { logger }); movedPrevious = true; }
    await renameRuntimeDirectory(extracted, root, { logger });
    promoted = true;
    const installedJava = safeJoin(root, javaPath);
    const runtime = await probe(installedJava);
    if (!runtime.usable) throw new Error(runtime.reason || 'Installed Temurin 8 failed validation.');
    const result = { ...runtime, javaPath: installedJava, managed: true, bundled: true };
    verified.set(root, { sha256: descriptor.sha256, runtime: result });
    return result;
  } catch (error) {
    try {
      if (promoted) await fs.rm(root, { recursive: true, force: true });
      if (movedPrevious) await renameRuntimeDirectory(previous, root, { logger });
    } catch { recovered = false; }
    const advice = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
      ? ' Close Minecraft and Minecraft Launcher, then click Repair again.' : '';
    throw new Error(`AHT could not prepare its Temurin 8 runtime: ${error.message}${advice}${recovered ? '' : ` Recovery files remain in ${staging}.`}`, { cause: error });
  } finally {
    if (recovered) await fs.rm(staging, { recursive: true, force: true });
  }
}
