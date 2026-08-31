import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

function canonicalRuntimePath(file = '') {
  const resolved = path.resolve(String(file || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function statNanoseconds(stat, field) {
  const nanoseconds = stat?.[`${field}Ns`];
  if (typeof nanoseconds === 'bigint') return nanoseconds.toString();
  return String(BigInt(Math.round(Number(stat?.[`${field}Ms`] || 0) * 1_000_000)));
}

function metadataMatches(state = null, stat = null) {
  return Boolean(state && stat
    && String(state.size || '') === String(stat.size)
    && String(state.mtimeNs || '') === statNanoseconds(stat, 'mtime')
    && String(state.ctimeNs || '') === statNanoseconds(stat, 'ctime')
    && String(state.ino || '') === String(stat.ino));
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function normalizedRuntimeFiles(files = []) {
  const unique = new Map();
  for (const candidate of Array.isArray(files) ? files : []) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const resolved = path.resolve(value);
    const key = canonicalRuntimePath(resolved);
    if (!unique.has(key)) unique.set(key, resolved);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, file]) => ({ key, file }));
}

export async function verifyPreparedRuntimeSnapshot(files = [], options = {}) {
  const runtimeFiles = normalizedRuntimeFiles(files);
  const previousStates = new Map((Array.isArray(options.previousFileStates) ? options.previousFileStates : [])
    .map((state) => [canonicalRuntimePath(state?.path || ''), state])
    .filter(([key, state]) => key && state && /^[a-f0-9]{64}$/i.test(String(state.sha256 || ''))));
  const fileStates = [];
  const issues = [];
  const digestRows = [];
  let metadataChanges = 0;
  let hashedFiles = 0;

  for (const { key, file } of runtimeFiles) {
    const previous = previousStates.get(key) || null;
    let stat;
    try {
      stat = await fs.lstat(file, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        issues.push({
          path: file,
          reason: 'missing',
          expectedSha256: String(previous?.sha256 || ''),
          actualSha256: ''
        });
        digestRows.push(`${key}|missing`);
        continue;
      }
      throw error;
    }

    if (!stat.isFile()) {
      issues.push({
        path: file,
        reason: 'not-file',
        expectedSha256: String(previous?.sha256 || ''),
        actualSha256: ''
      });
      digestRows.push(`${key}|not-file`);
      continue;
    }

    const unchangedMetadata = metadataMatches(previous, stat);
    if (previous && !unchangedMetadata) metadataChanges += 1;
    let sha256 = unchangedMetadata ? String(previous.sha256 || '') : '';
    if (!sha256) {
      sha256 = await sha256File(file);
      hashedFiles += 1;
    }
    if (previous?.sha256 && sha256 !== String(previous.sha256).toLowerCase()) {
      issues.push({
        path: file,
        reason: 'content-changed',
        expectedSha256: String(previous.sha256).toLowerCase(),
        actualSha256: sha256
      });
    }
    fileStates.push({
      path: file,
      size: String(stat.size),
      mtimeNs: statNanoseconds(stat, 'mtime'),
      ctimeNs: statNanoseconds(stat, 'ctime'),
      ino: String(stat.ino),
      sha256
    });
    digestRows.push(`${key}|${sha256}`);
  }

  const pathsValid = runtimeFiles.length > 0 && fileStates.length === runtimeFiles.length
    && issues.every((issue) => issue.reason === 'content-changed');
  const fingerprint = {
    schemaVersion: 2,
    algorithm: 'sha256',
    capturedAt: new Date().toISOString(),
    digest: crypto.createHash('sha256').update(digestRows.join('\n'), 'utf8').digest('hex'),
    fileCount: runtimeFiles.length,
    pathsValid
  };
  return {
    valid: pathsValid && issues.length === 0,
    fingerprint,
    fileStates,
    metadataChanges,
    hashedFiles,
    issues
  };
}

export function preparedRuntimeSnapshotCoversFiles(snapshot = null, files = []) {
  if (snapshot?.valid !== true || snapshot?.fingerprint?.schemaVersion !== 2) return false;
  const expected = normalizedRuntimeFiles(files).map(({ key }) => key);
  const actual = normalizedRuntimeFiles((Array.isArray(snapshot.fileStates) ? snapshot.fileStates : [])
    .map((state) => state?.path || '')).map(({ key }) => key);
  return expected.length > 0
    && expected.length === actual.length
    && expected.every((key, index) => key === actual[index]);
}
