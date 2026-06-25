import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJsonFile(filePath) {
  return JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function writeJsonFile(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function hashFile(filePath, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'pack';
}

export function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

export function normalizeRelPath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\/+/, '');
}

export function safeJoin(root, relPath) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relPath);
  if (!isPathInside(rootResolved, target)) {
    throw new Error(`Refusing to write outside target directory: ${relPath}`);
  }
  return target;
}

export function isPathInside(root, target) {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const rootComparable = process.platform === 'win32' ? rootResolved.toLowerCase() : rootResolved;
  const targetComparable = process.platform === 'win32' ? targetResolved.toLowerCase() : targetResolved;
  return targetComparable === rootComparable || targetComparable.startsWith(`${rootComparable}${path.sep}`);
}

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value));
}

export function isFileUrl(value) {
  return /^file:\/\//i.test(String(value));
}

export function isUrl(value) {
  return isHttpUrl(value) || isFileUrl(value);
}

export function sourceToDisplay(source) {
  return isFileUrl(source) ? fileURLToPath(source) : source;
}

export function resolveSource(baseSource, value) {
  if (!value) {
    return null;
  }
  const raw = String(value);
  if (isUrl(raw)) {
    return raw;
  }
  if (isHttpUrl(baseSource) || isFileUrl(baseSource)) {
    const base = new URL(baseSource);
    if (!base.pathname.endsWith('/')) {
      base.pathname = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
    }
    return new URL(raw.replaceAll('\\', '/'), base).toString();
  }
  return path.resolve(path.dirname(path.resolve(baseSource)), raw);
}

export function filePathToSource(filePath) {
  return pathToFileURL(path.resolve(filePath)).toString();
}

export async function readJsonFromSource(source, headers = {}) {
  if (isHttpUrl(source)) {
    const response = await fetch(source, { headers: { Accept: 'application/json', ...headers } });
    if (!response.ok) {
      throw new Error(`GET ${source} failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
  const localPath = isFileUrl(source) ? fileURLToPath(source) : source;
  return readJsonFile(localPath);
}

export async function fetchJson(source, headers = {}) {
  const response = await fetch(source, { headers: { Accept: 'application/json', ...headers } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET ${source} failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`);
  }
  return response.json();
}

export async function downloadToFile(source, dest, options = {}) {
  await ensureDir(path.dirname(dest));
  const tmp = `${dest}.download`;
  if (isHttpUrl(source)) {
    const response = await fetch(source, { headers: options.headers || {} });
    if (!response.ok) {
      throw new Error(`Download failed ${source}: ${response.status} ${response.statusText}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
  } else {
    const localPath = isFileUrl(source) ? fileURLToPath(source) : source;
    await fs.copyFile(localPath, tmp);
  }
  await fs.rename(tmp, dest);
}

export async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

export function pickArg(args, name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1];
}

export function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

export function artifactUrl(baseUrl, relPath) {
  const normalized = normalizeRelPath(relPath);
  if (!baseUrl) {
    return normalized;
  }
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(normalized, base).toString();
}
