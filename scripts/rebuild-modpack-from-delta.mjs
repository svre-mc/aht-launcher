#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {
  CLIENT_DELTA_FORMAT,
  CLIENT_DELTA_METADATA_ENTRY,
  CLIENT_MANIFEST_FORMAT,
  CLIENT_PACK_FORMAT,
  CLIENT_PACK_METADATA_ENTRY,
  isManagedClientPackPath
} from '../src/clientPackFormat.js';

export const REMOTE_REBUILD_SCHEMA = 'aht-remote-modpack-rebuild/v1';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function normalizeRelPath(value = '') {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!normalized || normalized === '.' || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Unsafe archive path: ${value}`);
  }
  return normalized;
}

function safeJoin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalizeRelPath(relativePath).split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Archive path escapes the rebuild directory: ${relativePath}`);
  }
  return resolved;
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

async function readEntryText(zip, entry, limit = 16 * 1024 * 1024) {
  const stream = await openEntryStream(zip, entry);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error(`Archive metadata is larger than ${limit} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readUniqueMetadata(zipPath, fileName) {
  const zip = await openZip(zipPath);
  return new Promise((resolve, reject) => {
    const matches = [];
    zip.once('error', reject);
    zip.once('end', () => {
      if (matches.length !== 1) reject(new Error(`${zipPath} must contain exactly one ${fileName}.`));
      else resolve(matches[0]);
    });
    zip.on('entry', async (entry) => {
      try {
        const name = normalizeRelPath(entry.fileName);
        if (!/\/$/.test(name) && (name === fileName || name.endsWith(`/${fileName}`))) {
          matches.push({
            entryName: name,
            rootPrefix: name.slice(0, -fileName.length),
            value: JSON.parse(await readEntryText(zip, entry))
          });
        }
        zip.readEntry();
      } catch (error) {
        zip.close();
        reject(error);
      }
    });
    zip.readEntry();
  });
}

async function extractEntry(zip, entry, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.part`;
  await fs.rm(temporary, { force: true });
  const stream = await openEntryStream(zip, entry);
  await new Promise((resolve, reject) => {
    const output = createWriteStream(temporary, { flags: 'wx' });
    stream.once('error', reject);
    output.once('error', reject);
    output.once('close', resolve);
    stream.pipe(output);
  });
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
  const modified = entry.getLastModDate?.();
  if (modified instanceof Date && Number.isFinite(modified.getTime())) {
    await fs.utimes(target, modified, modified).catch(() => {});
  }
}

async function extractBaseZip(zipPath, destination, rootPrefix) {
  const zip = await openZip(zipPath);
  await new Promise((resolve, reject) => {
    zip.once('error', reject);
    zip.once('end', resolve);
    zip.on('entry', async (entry) => {
      try {
        const name = normalizeRelPath(entry.fileName);
        if (/\/$/.test(name)) {
          zip.readEntry();
          return;
        }
        if (!name.startsWith(rootPrefix)) throw new Error(`Base ZIP entry is outside its pack root: ${name}`);
        const relativePath = name.slice(rootPrefix.length);
        if (relativePath && relativePath !== CLIENT_PACK_METADATA_ENTRY) {
          await extractEntry(zip, entry, safeJoin(destination, relativePath));
        }
        zip.readEntry();
      } catch (error) {
        zip.close();
        reject(error);
      }
    });
    zip.readEntry();
  });
}

function normalizedManifest(manifest, latest) {
  if (manifest?.format !== CLIENT_MANIFEST_FORMAT || !Array.isArray(manifest.files)) {
    throw new Error('Target client manifest is missing or unsupported.');
  }
  if (String(manifest.packId || '') !== String(latest.packId || '') || String(manifest.version || '') !== String(latest.version || '')) {
    throw new Error('Target client manifest does not match the candidate release.');
  }
  const seen = new Set();
  const files = manifest.files.map((raw) => {
    const relativePath = normalizeRelPath(raw.relativePath || raw.path || '');
    const sha256 = String(raw.sha256 || '').trim().toLowerCase();
    const size = Number(raw.size);
    const folded = relativePath.toLowerCase();
    if (seen.has(folded) || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Target client manifest contains an invalid file: ${relativePath}`);
    }
    seen.add(folded);
    return { relativePath, size, sha256, managed: isManagedClientPackPath(relativePath) };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { ...manifest, files };
}

function normalizedDelta(delta, latest, baselineLatest, manifest) {
  if (delta?.format !== CLIENT_DELTA_FORMAT || !Array.isArray(delta.files) || !Array.isArray(delta.deleted)) {
    throw new Error('Changed-files ZIP metadata is missing or unsupported.');
  }
  if (String(delta.packId || '') !== String(latest.packId || '')
      || String(delta.fromVersion || '') !== String(baselineLatest.version || '')
      || String(delta.toVersion || '') !== String(latest.version || '')) {
    throw new Error('Changed-files ZIP does not connect the live release to the candidate release.');
  }
  if (String(delta.targetManifest?.sha256 || '').toLowerCase() !== String(latest.clientManifest?.sha256 || '').toLowerCase()) {
    throw new Error('Changed-files ZIP target manifest hash does not match the candidate release.');
  }
  const target = new Map(manifest.files.map((file) => [file.relativePath, file]));
  const files = delta.files.map((raw) => {
    const relativePath = normalizeRelPath(raw.relativePath || raw.path || '');
    const expected = target.get(relativePath);
    if (!expected || expected.size !== Number(raw.size) || expected.sha256 !== String(raw.sha256 || '').toLowerCase()) {
      throw new Error(`Changed-files metadata does not match the target manifest: ${relativePath}`);
    }
    return expected;
  });
  const deleted = delta.deleted.map(normalizeRelPath);
  return { ...delta, files, deleted };
}

async function applyDeltaZip(zipPath, destination, delta) {
  for (const relativePath of delta.deleted) await fs.rm(safeJoin(destination, relativePath), { recursive: true, force: true });
  const expected = new Map(delta.files.map((file) => [file.relativePath, file]));
  const found = new Set();
  const zip = await openZip(zipPath);
  await new Promise((resolve, reject) => {
    zip.once('error', reject);
    zip.once('end', resolve);
    zip.on('entry', async (entry) => {
      try {
        const name = normalizeRelPath(entry.fileName);
        if (/\/$/.test(name) || name === CLIENT_DELTA_METADATA_ENTRY) {
          zip.readEntry();
          return;
        }
        if (!expected.has(name) || found.has(name)) throw new Error(`Changed-files ZIP contains an undeclared or duplicate file: ${name}`);
        await extractEntry(zip, entry, safeJoin(destination, name));
        found.add(name);
        zip.readEntry();
      } catch (error) {
        zip.close();
        reject(error);
      }
    });
    zip.readEntry();
  });
  const missing = [...expected.keys()].filter((relativePath) => !found.has(relativePath));
  if (missing.length) throw new Error(`Changed-files ZIP is missing ${missing[0]}.`);
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.once('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyTargetFiles(root, manifest) {
  for (const file of manifest.files) {
    const absolute = safeJoin(root, file.relativePath);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size !== file.size || await hashFile(absolute) !== file.sha256) {
      throw new Error(`Rebuilt client file failed verification: ${file.relativePath}`);
    }
  }
}

async function writeFullZip({ root, output, rootPrefix, metadata, manifest }) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.rm(output, { force: true });
  const zip = new yazl.ZipFile();
  const done = new Promise((resolve, reject) => {
    const stream = createWriteStream(output, { flags: 'wx' });
    stream.once('error', reject);
    stream.once('close', resolve);
    zip.outputStream.once('error', reject);
    zip.outputStream.pipe(stream);
  });
  for (const file of manifest.files) {
    const absolute = safeJoin(root, file.relativePath);
    const stat = await fs.stat(absolute);
    zip.addFile(absolute, `${rootPrefix}${file.relativePath}`, { mtime: stat.mtime });
  }
  zip.addBuffer(Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'), `${rootPrefix}${CLIENT_PACK_METADATA_ENTRY}`);
  zip.end();
  await done;
}

export async function rebuildModpackFromDelta({
  baselineLatestPath,
  baselineZipPath,
  candidateLatestPath,
  targetManifestPath,
  deltaZipPath,
  outputZipPath,
  resultPath,
  candidateId = ''
} = {}) {
  const [baselineLatest, candidateLatest, rawManifest] = await Promise.all([
    fs.readFile(baselineLatestPath, 'utf8').then(JSON.parse),
    fs.readFile(candidateLatestPath, 'utf8').then(JSON.parse),
    fs.readFile(targetManifestPath, 'utf8').then(JSON.parse)
  ]);
  if (String(baselineLatest.packId || '') !== String(candidateLatest.packId || '')
      || String(baselineLatest.channel || '') !== String(candidateLatest.channel || '')) {
    throw new Error('Live and candidate releases belong to different channels.');
  }
  const manifest = normalizedManifest(rawManifest, candidateLatest);
  const [baseMetadataRecord, deltaMetadataRecord] = await Promise.all([
    readUniqueMetadata(baselineZipPath, CLIENT_PACK_METADATA_ENTRY),
    readUniqueMetadata(deltaZipPath, CLIENT_DELTA_METADATA_ENTRY)
  ]);
  if (baseMetadataRecord.value?.format !== CLIENT_PACK_FORMAT
      || String(baseMetadataRecord.value?.packId || '') !== String(candidateLatest.packId || '')
      || String(baseMetadataRecord.value?.version || '') !== String(baselineLatest.version || '')) {
    throw new Error('Live full ZIP metadata does not match live latest.json.');
  }
  const delta = normalizedDelta(deltaMetadataRecord.value, candidateLatest, baselineLatest, manifest);
  const rebuildRoot = `${outputZipPath}.work`;
  await fs.rm(rebuildRoot, { recursive: true, force: true });
  await fs.mkdir(rebuildRoot, { recursive: true });
  try {
    await extractBaseZip(baselineZipPath, rebuildRoot, baseMetadataRecord.rootPrefix);
    await applyDeltaZip(deltaZipPath, rebuildRoot, delta);
    await verifyTargetFiles(rebuildRoot, manifest);
    const template = candidateLatest.rebuild?.clientPack || {};
    const metadata = {
      schemaVersion: 1,
      format: CLIENT_PACK_FORMAT,
      packId: candidateLatest.packId,
      name: candidateLatest.name,
      version: candidateLatest.version,
      createdAt: candidateLatest.createdAt || new Date().toISOString(),
      sourceFolderName: String(template.sourceFolderName || candidateLatest.name || 'A Hard Time'),
      minecraft: candidateLatest.minecraft || null,
      includedRoots: Array.isArray(template.includedRoots) ? template.includedRoots : [],
      missingRoots: Array.isArray(template.missingRoots) ? template.missingRoots : [],
      fileCount: manifest.files.length,
      totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
      settingsFiles: Array.isArray(template.settingsFiles) ? template.settingsFiles : [],
      files: manifest.files.map((file) => ({ path: file.relativePath, size: file.size, sha256: file.sha256, managed: file.managed }))
    };
    await writeFullZip({
      root: rebuildRoot,
      output: outputZipPath,
      rootPrefix: String(candidateLatest.rebuild?.rootPrefix || ''),
      metadata,
      manifest
    });
  } finally {
    await fs.rm(rebuildRoot, { recursive: true, force: true });
  }
  const stat = await fs.stat(outputZipPath);
  const zipSha256 = await hashFile(outputZipPath);
  const latest = {
    ...candidateLatest,
    zip: { ...candidateLatest.zip, sha256: zipSha256, size: stat.size },
    remoteBuild: {
      schemaVersion: 1,
      method: 'changed-files',
      fromVersion: baselineLatest.version,
      candidateId
    }
  };
  delete latest.rebuild;
  const result = {
    schemaVersion: 1,
    format: REMOTE_REBUILD_SCHEMA,
    candidateId,
    packId: latest.packId,
    channel: latest.channel,
    version: latest.version,
    fromVersion: baselineLatest.version,
    clientManifestSha256: latest.clientManifest?.sha256 || '',
    deltaSha256: latest.delta?.sha256 || '',
    zip: latest.zip,
    latest
  };
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  rebuildModpackFromDelta({
    baselineLatestPath: args['baseline-latest'],
    baselineZipPath: args['baseline-zip'],
    candidateLatestPath: args['candidate-latest'],
    targetManifestPath: args.manifest,
    deltaZipPath: args.delta,
    outputZipPath: args.output,
    resultPath: args.result,
    candidateId: args['candidate-id'] || ''
  }).then((result) => {
    console.log(JSON.stringify({ ok: true, version: result.version, fromVersion: result.fromVersion, size: result.zip.size, sha256: result.zip.sha256 }));
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
