import { fetchJson } from './utils.js';

const CURSEFORGE_BASE = 'https://api.curseforge.com/v1';

function requireApiAccess(options) {
  if (options.proxyBaseUrl) {
    return;
  }
  if (!options.apiKey) {
    throw new Error('CurseForge API access is not configured. Set CURSEFORGE_API_KEY or configure curseforge.proxyBaseUrl.');
  }
}

function headersFor(options) {
  return options.proxyBaseUrl ? {} : { 'x-api-key': options.apiKey };
}

function endpoint(options, path) {
  if (options.proxyBaseUrl) {
    const base = options.proxyBaseUrl.endsWith('/') ? options.proxyBaseUrl : `${options.proxyBaseUrl}/`;
    return new URL(path.replace(/^\/+/, ''), base).toString();
  }
  return `${CURSEFORGE_BASE}${path}`;
}

export async function getModFile(projectId, fileId, options = {}) {
  requireApiAccess(options);
  const url = endpoint(options, `/mods/${projectId}/files/${fileId}`);
  const response = await fetchJson(url, headersFor(options));
  return response.data || response;
}

export async function getModFileDownloadUrl(projectId, fileId, options = {}) {
  requireApiAccess(options);
  const url = endpoint(options, `/mods/${projectId}/files/${fileId}/download-url`);
  const response = await fetchJson(url, headersFor(options));
  return response.data || response;
}

export function getHash(file, algorithm) {
  const desiredLength = algorithm === 'sha1' ? 40 : algorithm === 'sha256' ? 64 : 0;
  const hashes = Array.isArray(file?.hashes) ? file.hashes : [];
  const match = hashes.find((hash) => typeof hash.value === 'string' && hash.value.length === desiredLength);
  return match?.value?.toLowerCase() || null;
}
