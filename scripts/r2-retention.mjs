#!/usr/bin/env node
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_BUCKET = 'ahtlauncher';
const DEFAULT_BASE_URL = 'https://api.ahardtime.net';
const DEFAULT_MAX_RETAINED_BYTES = 8 * 1024 * 1024 * 1024;
const MANIFEST_PATHS = ['latest.json', 'ptb/latest.json', 'launcher/latest.json'];
const RELEASE_KEY_PREFIXES = [
  'packs/',
  'patches/',
  'manifests/',
  'cache/',
  'client-zips/',
  'server/',
  'ptb/',
  'launcher/',
  'update-media/'
];

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}
function cleanBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_BASE_URL));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('The release base URL must be a plain HTTPS origin or path.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function cleanObjectKey(value) {
  let key = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (key.startsWith('releases/')) key = key.slice('releases/'.length);
  if (!key || key.includes('\0') || key.split('/').includes('..')) return '';
  return RELEASE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) || MANIFEST_PATHS.includes(key)
    ? key
    : '';
}

function referenceFromString(value, manifestPath, baseUrl) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:' || parsed.origin !== baseUrl.origin) return '';
    return cleanObjectKey(parsed.pathname);
  } catch {}

  let key = cleanObjectKey(text);
  if (!key) return '';
  if (manifestPath === 'ptb/latest.json'
      && /^(packs|patches|manifests|cache)\//.test(key)) {
    key = `ptb/${key}`;
  }
  return key;
}

export function extractReferencedKeys(manifests, baseUrlValue = DEFAULT_BASE_URL) {
  const baseUrl = cleanBaseUrl(baseUrlValue);
  const references = new Set(MANIFEST_PATHS);
  for (const manifestPath of MANIFEST_PATHS) {
    const manifest = manifests[manifestPath];
    if (!manifest || typeof manifest !== 'object') {
      throw new Error(`Live manifest ${manifestPath} is missing or invalid.`);
    }
    const visit = (value) => {
      if (typeof value === 'string') {
        const key = referenceFromString(value, manifestPath, baseUrl);
        if (key) references.add(key);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) visit(item);
      }
    };
    visit(manifest);
  }
  return references;
}

export function versionFromKey(key) {
  const fileName = String(key || '').split('/').at(-1) || '';
  const match = fileName.match(/(?:^|[-_])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\.[A-Za-z0-9]+$)/);
  return match?.[1] || '';
}

function normalizedInventory(inventory) {
  const seen = new Set();
  return (inventory || []).map((item) => {
    const key = String(item?.key || '').replaceAll('\\', '/').replace(/^\/+/, '');
    const safeKey = key && !key.includes('\0') && !key.split('/').includes('..') ? key : '';
    if (!safeKey || seen.has(safeKey)) throw new Error(`Inventory contains an invalid or duplicate key: ${String(item?.key || '')}`);
    seen.add(safeKey);
    const size = Number(item?.size || 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Inventory size is invalid for ${safeKey}.`);
    return {
      key: safeKey,
      size,
      etag: String(item?.etag || ''),
      lastModified: String(item?.last_modified || item?.lastModified || '')
    };
  });
}

function versionNumbers(version) {
  const parts = String(version || '').split('-', 1)[0].split('.').map(Number);
  return parts.length === 3 && parts.every((part) => Number.isSafeInteger(part) && part >= 0) ? parts : null;
}

function compareVersions(left, right) {
  const a = versionNumbers(left);
  const b = versionNumbers(right);
  if (!a || !b) return String(left).localeCompare(String(right), undefined, { numeric: true });
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return String(left).localeCompare(String(right));
}

function manifestRollbackHint(manifest, currentVersion) {
  let hint = '';
  const escapedCurrent = currentVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[-_/])(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)-to-${escapedCurrent}(?:\\.|$)`);
  const visit = (value) => {
    if (hint) return;
    if (typeof value === 'string') {
      hint = value.match(pattern)?.[1] || '';
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(manifest);
  return hint;
}

function rollbackVersion(objects, currentVersion, hint = '') {
  const versions = new Set();
  for (const object of objects) {
    const version = versionFromKey(object.key);
    if (!version || version === currentVersion) continue;
    versions.add(version);
  }
  if (hint && versions.has(hint)) return hint;
  return [...versions]
    .filter((version) => compareVersions(version, currentVersion) < 0)
    .sort((left, right) => compareVersions(right, left))
    .at(0) || '';
}

function markOldVersions({ objects, currentVersion, rollbackHint = '', protectedKeys, deletions, reason, failOnUnknown = false }) {
  const selectedRollbackVersion = rollbackVersion(objects, currentVersion, rollbackHint);
  const retainedVersions = new Set([currentVersion, selectedRollbackVersion].filter(Boolean));
  for (const object of objects) {
    if (protectedKeys.has(object.key)) continue;
    const version = versionFromKey(object.key);
    if (!version) {
      if (failOnUnknown) throw new Error(`Refusing to classify versionless managed object ${object.key}.`);
      continue;
    }
    if (!retainedVersions.has(version)) deletions.set(object.key, { ...object, reason });
  }
  return selectedRollbackVersion;
}

export function planR2Retention({
  inventory,
  manifests,
  baseUrl = DEFAULT_BASE_URL,
  maxRetainedBytes = Number.POSITIVE_INFINITY
}) {
  const objects = normalizedInventory(inventory);
  const byKey = new Map(objects.map((object) => [object.key, object]));
  const protectedKeys = extractReferencedKeys(manifests, baseUrl);
  for (const key of protectedKeys) {
    if (!byKey.has(key)) throw new Error(`Live manifest reference is missing from R2 inventory: ${key}`);
  }

  const launcherVersion = String(manifests['launcher/latest.json']?.version || '').trim();
  const stableVersion = String(manifests['latest.json']?.version || '').trim();
  const ptbVersion = String(manifests['ptb/latest.json']?.version || '').trim();
  if (![launcherVersion, stableVersion, ptbVersion].every((version) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))) {
    throw new Error('Every live manifest must contain a valid version.');
  }

  const deletions = new Map();
  const launcherObjects = objects.filter((object) => object.key.startsWith('launcher/files/'));
  const launcherRollbackVersion = rollbackVersion(launcherObjects, launcherVersion);
  const launcherRetainedVersions = new Set([launcherVersion, launcherRollbackVersion].filter(Boolean));
  for (const object of launcherObjects) {
    if (protectedKeys.has(object.key)) continue;
    const version = versionFromKey(object.key);
    if (!version) throw new Error(`Refusing to classify versionless launcher object ${object.key}.`);
    if (!launcherRetainedVersions.has(version)) {
      deletions.set(object.key, { ...object, reason: 'launcher-older-than-rollback-window' });
    }
  }

  for (const object of objects.filter((item) => item.key.startsWith('client-zips/'))) {
    if (protectedKeys.has(object.key)) {
      throw new Error(`Refusing to delete live client ZIP reference ${object.key}.`);
    }
    deletions.set(object.key, { ...object, reason: 'unserved-legacy-client-zip' });
  }

  const stableObjects = objects.filter((object) => /^packs\/[^/]+\.zip$/i.test(object.key));
  const stableRollbackVersion = markOldVersions({
    objects: stableObjects,
    currentVersion: stableVersion,
    protectedKeys,
    deletions,
    reason: 'stable-pack-older-than-rollback-window',
    failOnUnknown: true
  });
  const ptbObjects = objects.filter((object) => /^ptb\/packs\/[^/]+\.zip$/i.test(object.key));
  const ptbRollbackVersion = markOldVersions({
    objects: ptbObjects,
    currentVersion: ptbVersion,
    rollbackHint: manifestRollbackHint(manifests['ptb/latest.json'], ptbVersion),
    protectedKeys,
    deletions,
    reason: 'ptb-pack-older-than-rollback-window',
    failOnUnknown: true
  });

  for (const key of protectedKeys) {
    if (deletions.has(key)) throw new Error(`Planner attempted to delete protected key ${key}.`);
  }

  const deleteObjects = [...deletions.values()].sort((left, right) => left.key.localeCompare(right.key));
  const totalBytes = objects.reduce((sum, object) => sum + object.size, 0);
  const deleteBytes = deleteObjects.reduce((sum, object) => sum + object.size, 0);
  const retainedBytes = totalBytes - deleteBytes;
  if (Number.isFinite(maxRetainedBytes) && retainedBytes > maxRetainedBytes) {
    throw new Error(`Retention plan would leave ${retainedBytes} bytes, above the ${maxRetainedBytes}-byte safety target.`);
  }

  return {
    totalObjects: objects.length,
    totalBytes,
    deleteObjects,
    deleteBytes,
    retainedObjects: objects.length - deleteObjects.length,
    retainedBytes,
    protectedKeys: [...protectedKeys].sort(),
    protectedObjects: [...protectedKeys].sort().map((key) => byKey.get(key)),
    versions: {
      launcher: { current: launcherVersion, rollback: launcherRollbackVersion },
      stable: { current: stableVersion, rollback: stableRollbackVersion },
      ptb: { current: ptbVersion, rollback: ptbRollbackVersion }
    }
  };
}

function apiBase(accountId, bucket) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects`;
}

function apiHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function cloudflareJson(response, operation) {
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const code = body?.errors?.[0]?.code;
    throw new Error(`${operation} failed with HTTP ${response.status}${code ? ` (Cloudflare ${code})` : ''}.`);
  }
  return body;
}

export async function listR2Objects({ accountId, bucket, token, fetchImpl = fetch }) {
  const objects = [];
  const seenCursors = new Set();
  let cursor = '';
  do {
    const url = new URL(apiBase(accountId, bucket));
    url.searchParams.set('per_page', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, { headers: apiHeaders(token) });
    const body = await cloudflareJson(response, 'R2 object listing');
    objects.push(...(body.result || []));
    if (!body.result_info?.is_truncated) break;
    const next = String(body.result_info?.cursor || '');
    if (!next || seenCursors.has(next)) throw new Error('R2 object listing pagination stalled.');
    seenCursors.add(next);
    cursor = next;
  } while (true);
  return objects;
}

function encodedObjectKey(key) {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function deleteR2Object({ accountId, bucket, token, key, fetchImpl = fetch }) {
  const response = await fetchImpl(`${apiBase(accountId, bucket)}/${encodedObjectKey(key)}`, {
    method: 'DELETE',
    headers: apiHeaders(token)
  });
  await cloudflareJson(response, `R2 deletion for ${key}`);
}

async function mapConcurrent(values, limit, worker) {
  let index = 0;
  const failures = [];
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index];
      index += 1;
      try {
        await worker(current);
      } catch (error) {
        failures.push({ key: current.key, error });
      }
    }
  });
  await Promise.all(runners);
  if (failures.length) {
    throw new Error(`${failures.length} R2 deletions failed; first failure: ${failures[0].key}: ${failures[0].error.message}`);
  }
}

async function fetchLiveManifests(baseUrlValue, fetchImpl = fetch) {
  const baseUrl = cleanBaseUrl(baseUrlValue);
  const manifests = {};
  const digests = {};
  for (const manifestPath of MANIFEST_PATHS) {
    const url = new URL(manifestPath, `${baseUrl.toString()}/`);
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Live manifest ${manifestPath} returned HTTP ${response.status}.`);
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Live manifest ${manifestPath} is not valid JSON.`);
    }
    manifests[manifestPath] = parsed;
    digests[manifestPath] = crypto.createHash('sha256').update(text).digest('hex');
  }
  return { manifests, digests };
}

function retentionSummary(plan, bucket, planHash, applied) {
  const byReason = {};
  for (const item of plan.deleteObjects) {
    const entry = byReason[item.reason] || { objects: 0, bytes: 0 };
    entry.objects += 1;
    entry.bytes += item.size;
    byReason[item.reason] = entry;
  }
  return {
    ok: true,
    applied,
    bucket,
    planHash,
    before: { objects: plan.totalObjects, bytes: plan.totalBytes },
    delete: { objects: plan.deleteObjects.length, bytes: plan.deleteBytes, byReason },
    retained: { objects: plan.retainedObjects, bytes: plan.retainedBytes },
    versions: plan.versions,
    protectedObjects: plan.protectedKeys.length
  };
}

export async function runRetention({
  accountId,
  bucket = DEFAULT_BUCKET,
  token,
  baseUrl = DEFAULT_BASE_URL,
  maxRetainedBytes = DEFAULT_MAX_RETAINED_BYTES,
  apply = false,
  fetchImpl = fetch
}) {
  if (bucket !== DEFAULT_BUCKET) throw new Error(`Refusing retention against unexpected bucket ${bucket}.`);
  if (!/^[a-f0-9]{32}$/.test(String(accountId || ''))) throw new Error('CLOUDFLARE_ACCOUNT_ID is missing or invalid.');
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required.');
  if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes <= 0) {
    throw new Error('The retained-byte safety target must be a positive safe integer.');
  }
  const [{ manifests, digests }, inventory] = await Promise.all([
    fetchLiveManifests(baseUrl, fetchImpl),
    listR2Objects({ accountId, bucket, token, fetchImpl })
  ]);
  const plan = planR2Retention({ inventory, manifests, baseUrl, maxRetainedBytes });
  const planHash = crypto.createHash('sha256').update(JSON.stringify({
    bucket,
    manifests: digests,
    protectedObjects: plan.protectedObjects.map(({ key, size, etag }) => ({ key, size, etag })),
    deleteObjects: plan.deleteObjects.map(({ key, size, etag }) => ({ key, size, etag }))
  })).digest('hex');
  const summary = retentionSummary(plan, bucket, planHash, apply);
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) return summary;
  if (plan.deleteObjects.length === 0) return { ...summary, readbackVerified: true };

  const { digests: preDeleteDigests } = await fetchLiveManifests(baseUrl, fetchImpl);
  for (const manifestPath of MANIFEST_PATHS) {
    if (preDeleteDigests[manifestPath] !== digests[manifestPath]) {
      throw new Error(`Live manifest ${manifestPath} changed before deletion; rerun retention with a fresh plan.`);
    }
  }

  await mapConcurrent(plan.deleteObjects, 8, (item) => deleteR2Object({
    accountId,
    bucket,
    token,
    key: item.key,
    fetchImpl
  }));

  const [{ digests: readbackDigests }, readbackInventory] = await Promise.all([
    fetchLiveManifests(baseUrl, fetchImpl),
    listR2Objects({ accountId, bucket, token, fetchImpl })
  ]);
  for (const manifestPath of MANIFEST_PATHS) {
    if (readbackDigests[manifestPath] !== digests[manifestPath]) {
      throw new Error(`Live manifest ${manifestPath} changed during retention; readback cannot be certified.`);
    }
  }
  const readbackKeys = new Set(readbackInventory.map((object) => object.key));
  const undeleted = plan.deleteObjects.filter((object) => readbackKeys.has(object.key));
  if (undeleted.length) throw new Error(`Readback found ${undeleted.length} planned deletions still present.`);
  const missingProtected = plan.protectedKeys.filter((key) => !readbackKeys.has(key));
  if (missingProtected.length) throw new Error(`Readback is missing protected key ${missingProtected[0]}.`);
  const readbackByKey = new Map(readbackInventory.map((object) => [object.key, object]));
  for (const protectedObject of plan.protectedObjects) {
    const current = readbackByKey.get(protectedObject.key);
    if (Number(current?.size || 0) !== protectedObject.size
        || String(current?.etag || '') !== protectedObject.etag) {
      throw new Error(`Protected object changed during retention: ${protectedObject.key}.`);
    }
  }
  const readbackBytes = readbackInventory.reduce((sum, object) => sum + Number(object.size || 0), 0);
  if (readbackBytes > maxRetainedBytes) {
    throw new Error(`Readback bucket size ${readbackBytes} exceeds safety target ${maxRetainedBytes}.`);
  }
  const result = {
    ...summary,
    readbackVerified: true,
    after: { objects: readbackInventory.length, bytes: readbackBytes }
  };
  console.log(JSON.stringify({ readback: result.after, readbackVerified: true, planHash }, null, 2));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  runRetention({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    bucket: args.bucket || process.env.AHT_R2_BUCKET || DEFAULT_BUCKET,
    baseUrl: args['base-url'] || process.env.AHT_RELEASE_BASE_URL || DEFAULT_BASE_URL,
    maxRetainedBytes: Number(args['max-retained-bytes'] || process.env.AHT_R2_MAX_RETAINED_BYTES || DEFAULT_MAX_RETAINED_BYTES),
    apply: Boolean(args.apply)
  }).catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
