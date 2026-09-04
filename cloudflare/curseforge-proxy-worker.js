const CURSEFORGE_BASE = 'https://api.curseforge.com/v1';
const RELEASE_PATHS = new Set([
  'latest.json',
  'release-report.json',
  'ptb/latest.json',
  'ptb/release-report.json',
  'launcher/latest.json'
]);
const SITE_DOCUMENT_PATH_PATTERN = /^pdf[1-9]\d*$/;
const RELEASE_PREFIXES = [
  'packs/',
  'patches/',
  'manifests/',
  'cache/',
  'server/',
  'ptb/packs/',
  'ptb/patches/',
  'ptb/manifests/',
  'ptb/cache/',
  'ptb/server/',
  'launcher/files/',
  'update-media/'
];
const LEGACY_LAUNCHER_WORKER_NAME = 'aht-curseforge-proxy';
const LEGACY_LAUNCHER_UPDATE_PATH = '/launcher/latest.json';
const LEGACY_LAUNCHER_MANIFEST_COLLECTIONS = ['downloads', 'platforms', 'stagedPlatforms'];
const LAUNCHER_SOCIAL_ACTIONS = new Set([
  'accept_friend',
  'decline_friend',
]);
const SOCIAL_ACTION_PREFIX = 'social/actions/';
const SOCIAL_STATE_PREFIX = 'social/state/';
const LAUNCHER_DOWNLOAD_KEY_ALIASES = new Map([
  ['macos-arm64', 'macos-universal'],
  ['macos-x64', 'macos-universal'],
  ['linux-x64', 'ubuntu-x64-appimage'],
  ['ubuntu-x64', 'ubuntu-x64-appimage']
]);
const LAUNCHER_DOWNLOAD_KEYS = new Set([
  'windows-x64',
  'macos-universal',
  'linux-x64',
  'ubuntu-x64-appimage',
  ...LAUNCHER_DOWNLOAD_KEY_ALIASES.keys()
]);
const LAUNCHER_INSTALLER_DOWNLOAD_LIMIT = 7;
const LAUNCHER_INSTALLER_DOWNLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;
const LAUNCHER_INSTALLER_DOWNLOAD_RETRY_GRACE_MS = 10 * 60 * 1000;
export const LAUNCHER_INSTALLER_DOWNLOAD_POLICY_EPOCH = '2026-09-04-privacy-reset-1';
const LAUNCHER_INSTALLER_DOWNLOAD_LIMIT_PATH = '/launcher-installer-download-limit';
const LAUNCHER_INSTALLER_DOWNLOAD_LIMIT_INTERNAL_HEADER = 'X-AHT-Launcher-Installer-Limit-Internal';
const LAUNCHER_INSTALLER_ID_COOKIE = '__Host-AHT-Download-ID';
const LAUNCHER_INSTALLER_ID_COOKIE_PROTOCOL = 'aht-download-id-v1';
const LAUNCHER_INSTALLER_ID_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const RELEASE_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const LAUNCHER_DOWNLOAD_PREFIX = 'launcher-downloads/';
const LAUNCHER_UPDATE_PREFIX = 'launcher-updates/';
const ACCOUNT_USERNAME_PREFIX = 'accounts/usernames/';
const ACCOUNT_IPV4_PREFIX = 'accounts/ipv4/';
const ACCOUNT_UUID_PREFIX = 'accounts/uuids/';
const ACCOUNT_DEVICE_PREFIX = 'accounts/devices/';
const ACCESS_DECISION_PREFIX = 'access/decisions/';
const ACCESS_AUDIT_PREFIX = 'access/audit/';
const ACCESS_SCOPES = new Set(['account', 'minecraft_uuid', 'device', 'ip', 'ipv4']);
const DEVICE_ASSERTION_PROTOCOL = 'aht-device-assertion-v1';
const DEVICE_ID_PREFIX = 'ahtd_';
const LAUNCHER_ATTESTATION_PROTOCOL = 'aht-launcher-attestation-v2';
const LEGACY_LAUNCHER_PROOF_PROTOCOL = 'aht-launcher-proof-v1';
const LAUNCHER_ATTESTATION_KEY_ID = 'aht-launcher-attestation-v2';
const LEGACY_LAUNCHER_PROOF_KEY_ID = 'aht-launcher-proof-v1';
const LAUNCHER_ATTESTATION_ISSUER = 'aht-launcher-worker';
const LAUNCHER_ATTESTATION_AUDIENCE = 'aht-minecraft-server';
const LAUNCHER_ATTESTATION_TTL_MS = 10 * 60 * 1000;
const LAUNCHER_RECONNECT_TTL_MS = 24 * 60 * 60 * 1000;
const LAUNCHER_SERVER_STATE_PROTOCOL = 'aht-server-state-v1';
const LAUNCHER_SERVER_STATE_AUDIENCE = 'aht-minecraft-server-state';
const LAUNCHER_SERVER_STATE_TYPE = 'AHT-SERVER-STATE';
const LAUNCHER_SERVER_STATE_DO_NAME = 'production';
const LAUNCHER_SERVER_STATE_MAX_ACCOUNTS = 2000;
const LAUNCHER_SERVER_STATE_MAX_DENIALS = 2000;
const LAUNCHER_SERVER_STATE_MAX_PAYLOAD_BYTES = 900 * 1024;
const LAUNCHER_SERVER_STATE_MAX_TOKEN_CHARS = 1400 * 1024;
const LAUNCHER_SERVER_STATE_PATH = '/server/launcher-state';
const LAUNCHER_SERVER_STATE_INTERNAL_HEADER = 'X-AHT-Launcher-State-Internal';
const LAUNCHER_SERVER_STATE_AUTHORIZED_HEADER = 'X-AHT-Launcher-State-Authorized';

class RequestPayloadError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestPayloadError';
    this.status = status;
  }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, X-AHT-Launcher-Recovery, X-AHT-Server-Timestamp, X-AHT-Server-Signature',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified',
    'Cache-Control': 'private, max-age=60',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  };
}

function json(value, status = 200, origin = '*') {
  return Response.json(value, { status, headers: corsHeaders(origin) });
}

function privateJson(value, status = 200, origin = '*') {
  return Response.json(value, {
    status,
    headers: { ...corsHeaders(origin), 'Cache-Control': 'private, no-store' }
  });
}

function releaseBucket(env) {
  return env.AHT_RELEASES || env.AHT_DATA || null;
}

function ipv4FromHeader(value = '') {
  for (const rawPart of String(value || '').split(',')) {
    let candidate = rawPart.trim();
    if (candidate.toLowerCase().startsWith('::ffff:')) candidate = candidate.slice(7);
    const match = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) continue;
    const octets = match.slice(1).map(Number);
    if (octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
      return octets.join('.');
    }
  }
  return '';
}

function normalizePlatform(value = '') {
  const platform = String(value || '').trim().toLowerCase();
  if (platform === 'win32' || platform === 'win64' || platform.includes('windows')) return 'Windows';
  if (platform === 'darwin' || platform === 'mac' || platform.startsWith('macos') || platform.includes('mac os')) return 'Mac';
  if (platform === 'linux' || platform === 'ubuntu' || platform.includes('linux') || platform.includes('ubuntu')) return 'Linux';
  return '';
}

function legacyWorkersDevRedirect(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (String(request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') return null;
  const configuredOrigin = cleanString(env.AHT_PUBLIC_ORIGIN || '', 300);
  if (!configuredOrigin) return null;
  try {
    const source = new URL(request.url);
    const targetOrigin = new URL(configuredOrigin);
    if (!source.hostname.toLowerCase().endsWith('.workers.dev')
        || targetOrigin.protocol !== 'https:'
        || targetOrigin.username
        || targetOrigin.password
        || targetOrigin.pathname !== '/'
        || targetOrigin.search
        || targetOrigin.hash) {
      return null;
    }
    const target = new URL(targetOrigin);
    const downloadKey = cleanString(source.searchParams.get('aht_download') || '', 80);
    target.pathname = LAUNCHER_DOWNLOAD_KEYS.has(downloadKey) && source.pathname.startsWith('/launcher/files/')
      ? `/launcher/download/${downloadKey}`
      : source.pathname;
    return new Response(null, {
      status: 308,
      headers: {
        Location: target.toString(),
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch {
    return null;
  }
}

function legacyLauncherUpdateVerificationUrl(request) {
  if (request.method !== 'GET') return null;
  try {
    const source = new URL(request.url);
    const hostParts = source.hostname.toLowerCase().split('.');
    const queryEntries = [...source.searchParams.entries()];
    if (hostParts[0] !== LEGACY_LAUNCHER_WORKER_NAME
        || !source.hostname.toLowerCase().endsWith('.workers.dev')
        || source.pathname !== LEGACY_LAUNCHER_UPDATE_PATH
        || queryEntries.length !== 1
        || queryEntries[0][0] !== 'aht_verify'
        || !/^\d{10,17}$/.test(queryEntries[0][1])) {
      return null;
    }
    return source;
  } catch {
    return null;
  }
}

function legacyLauncherUpdateManifest(manifest, sourceOrigin, publicOrigin) {
  const result = structuredClone(manifest);
  const legacyOrigin = new URL(sourceOrigin);
  const brandedOrigin = new URL(publicOrigin);
  for (const collectionName of LEGACY_LAUNCHER_MANIFEST_COLLECTIONS) {
    const collection = result?.[collectionName];
    if (!collection || typeof collection !== 'object' || Array.isArray(collection)) continue;
    for (const entry of Object.values(collection)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      try {
        const artifact = new URL(String(entry.url || ''));
        if (artifact.origin !== brandedOrigin.origin || !artifact.pathname.startsWith('/launcher/files/')) continue;
        entry.url = new URL(`${artifact.pathname}${artifact.search}`, legacyOrigin).toString();
      } catch {
        // The signed release manifest validator owns malformed artifact handling.
      }
    }
  }
  return result;
}

async function legacyLauncherUpdateManifestResponse(request, env, origin) {
  const source = legacyLauncherUpdateVerificationUrl(request);
  if (!source) return null;
  const configuredOrigin = cleanString(env.AHT_PUBLIC_ORIGIN || '', 300);
  if (!configuredOrigin) return null;
  let targetOrigin;
  try {
    targetOrigin = new URL(configuredOrigin);
    if (targetOrigin.protocol !== 'https:'
        || targetOrigin.username
        || targetOrigin.password
        || targetOrigin.pathname !== '/'
        || targetOrigin.search
        || targetOrigin.hash) {
      return null;
    }
  } catch {
    return null;
  }
  const manifest = legacyLauncherUpdateManifest(
    await readLauncherManifest(env),
    source.origin,
    targetOrigin.origin
  );
  return Response.json(manifest, {
    status: 200,
    headers: { ...corsHeaders(origin), 'Cache-Control': 'private, no-store' }
  });
}

function normalizeMinecraftUuid(value = '') {
  const compact = String(value || '').trim().replace(/[{}-]/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact) || /^0{32}$/.test(compact)) return '';
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20)
  ].join('-');
}

function normalizedConnectionIp(value = '') {
  const raw = cleanString(String(value || '').split(',')[0], 80).toLowerCase();
  const ipv4 = ipv4FromHeader(raw);
  if (ipv4) return ipv4;
  if (raw.length >= 2 && raw.length <= 45 && raw.includes(':') && /^[0-9a-f:.]+$/.test(raw)) {
    try {
      const hostname = new URL(`http://[${raw}]/`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (hostname.includes(':')) return hostname;
    } catch {
      return '';
    }
  }
  return '';
}

function requestIpv4(request) {
  const connecting = request.headers.get('CF-Connecting-IP') || '';
  const connectingV6 = request.headers.get('CF-Connecting-IPv6') || '';
  const pseudo = request.headers.get('CF-Pseudo-IPv4') || '';
  const nativeIpv6 = normalizedConnectionIp(connectingV6);
  if (nativeIpv6 && nativeIpv6.includes(':')) {
    return { ip: nativeIpv6, ipVersion: 6, ipv4: '', source: 'cloudflare-connecting-ipv6', available: true, ipv4Available: false, pseudo: true };
  }
  const connectingIpv4 = ipv4FromHeader(connecting);
  if (connectingIpv4) {
    return {
      ip: connectingIpv4,
      ipVersion: 4,
      ipv4: connectingIpv4,
      source: 'cloudflare-connecting-ip',
      available: true,
      ipv4Available: true,
      pseudo: false
    };
  }
  const connectingIp = normalizedConnectionIp(connecting);
  if (connectingIp && connectingIp.includes(':')) {
    return { ip: connectingIp, ipVersion: 6, ipv4: '', source: 'cloudflare-connecting-ip', available: true, ipv4Available: false, pseudo: Boolean(pseudo) };
  }
  return {
    ip: '',
    ipVersion: 0,
    ipv4: '',
    source: connecting.includes(':') || pseudo ? 'ipv6-only' : 'unavailable',
    available: false,
    ipv4Available: false,
    pseudo: Boolean(pseudo)
  };
}

function configuredNumberSet(value = '') {
  return new Set(String(value || '').split(',')
    .map((item) => Number(String(item).trim().replace(/^AS/i, '')))
    .filter((item) => Number.isSafeInteger(item) && item > 0));
}

function normalizedNetworkAssessment(value = {}, fallback = {}) {
  const status = ['likely', 'not_detected', 'unknown'].includes(value.status) ? value.status : 'unknown';
  const confidence = ['high', 'medium', 'low', 'unknown'].includes(value.confidence) ? value.confidence : 'unknown';
  return {
    status,
    confidence,
    vpn: status === 'likely',
    proxy: Boolean(value.proxy),
    hosting: Boolean(value.hosting),
    source: cleanString(value.source || fallback.source || 'cloudflare-metadata', 80),
    asn: Number.isSafeInteger(Number(fallback.asn)) ? Number(fallback.asn) : 0,
    organization: cleanString(fallback.organization || '', 160),
    country: cleanString(fallback.country || '', 8),
    colo: cleanString(fallback.colo || '', 16),
    checkedAt: new Date().toISOString()
  };
}

async function requestNetworkAssessment(request, env, clientIp = requestIpv4(request)) {
  const metadata = {
    asn: Number(request.cf?.asn || 0),
    organization: cleanString(request.cf?.asOrganization || '', 160),
    country: cleanString(request.cf?.country || '', 8),
    colo: cleanString(request.cf?.colo || '', 16)
  };
  const configuredVpns = configuredNumberSet(env.AHT_VPN_ASNS);
  if (metadata.asn && configuredVpns.has(metadata.asn)) {
    return normalizedNetworkAssessment({
      status: 'likely',
      confidence: 'high',
      vpn: true,
      hosting: true,
      source: 'configured-vpn-asn'
    }, metadata);
  }
  if (env.AHT_NETWORK_INTELLIGENCE?.fetch && clientIp.ip) {
    try {
      const response = await env.AHT_NETWORK_INTELLIGENCE.fetch('https://aht-network-intelligence.internal/assess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: clientIp.ip, ipv4: clientIp.ipv4, ...metadata })
      });
      if (response.ok) {
        const result = JSON.parse(await readRawBody(response, 16_384));
        const status = result.vpn === true || result.proxy === true
          ? 'likely'
          : (result.vpn === false && result.proxy === false ? 'not_detected' : 'unknown');
        return normalizedNetworkAssessment({
          status,
          confidence: cleanString(result.confidence || (status === 'unknown' ? 'unknown' : 'medium'), 20),
          proxy: Boolean(result.proxy),
          hosting: Boolean(result.hosting),
          source: cleanString(result.source || 'network-intelligence-service', 80)
        }, metadata);
      }
    } catch {
      // A lookup outage is represented as unknown; it never becomes a false negative.
    }
  }
  return normalizedNetworkAssessment({ status: 'unknown', confidence: 'unknown' }, metadata);
}

function nativeIpv4FromRecord(record = {}) {
  const source = String(record.ipv4Source || '').toLowerCase();
  if (record.pseudoIpv4 || source.includes('pseudo') || source === 'forwarded-for') return '';
  return ipv4FromHeader(record.ipv4 || record.ip || '');
}

async function enforcePlayerApiRateLimit(request, env, route, origin) {
  if (!env.AHT_PLAYER_API_RATE_LIMITER?.limit) return null;
  const connection = requestIpv4(request);
  const ipKey = connection.ip || 'unavailable';
  let allowed = false;
  try {
    const result = await env.AHT_PLAYER_API_RATE_LIMITER.limit({
      key: `player:${cleanString(route, 24)}:${(await sha256Hex(ipKey)).slice(0, 40)}`
    });
    allowed = result?.success === true;
  } catch {
    allowed = false;
  }
  if (allowed) return null;
  const response = privateJson({ error: 'Too many launcher requests. Try again shortly.' }, 429, origin);
  response.headers.set('Retry-After', '60');
  return response;
}

async function enforceProofVerifyRateLimit(request, env, origin) {
  if (!env.AHT_PROOF_VERIFY_RATE_LIMITER?.limit) return null;
  const connection = requestIpv4(request);
  const ipKey = connection.ip || 'unavailable';
  let allowed = false;
  try {
    const result = await env.AHT_PROOF_VERIFY_RATE_LIMITER.limit({
      key: `proof-verify:${(await sha256Hex(ipKey)).slice(0, 40)}`
    });
    allowed = result?.success === true;
  } catch {
    allowed = false;
  }
  if (allowed) return null;
  const response = privateJson({ error: 'Too many launcher proof verification requests. Try again shortly.' }, 429, origin);
  response.headers.set('Retry-After', '60');
  return response;
}

function launcherDownloadKey(receivedAt = new Date().toISOString(), id = crypto.randomUUID()) {
  const reverseTime = String(Number.MAX_SAFE_INTEGER - Date.parse(receivedAt)).padStart(16, '0');
  return `${LAUNCHER_DOWNLOAD_PREFIX}${reverseTime}-${id}.json`;
}

function isReleaseCandidatePath(pathname) {
  const trimmed = pathname.replace(/^\/+/, '');
  return RELEASE_PATHS.has(trimmed)
    || SITE_DOCUMENT_PATH_PATTERN.test(trimmed)
    || RELEASE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
    || trimmed.startsWith('releases/');
}

function safeReleaseKey(pathname) {
  const trimmed = pathname.replace(/^\/+/, '');
  let key = trimmed.startsWith('releases/') ? trimmed.slice('releases/'.length) : trimmed;
  try {
    key = decodeURIComponent(key);
  } catch {
    return '';
  }
  key = key.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!key || key.includes('\0') || key.split('/').includes('..')) {
    return '';
  }
  if (RELEASE_PATHS.has(key) || SITE_DOCUMENT_PATH_PATTERN.test(key) || RELEASE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return key;
  }
  return '';
}

function contentTypeForKey(key) {
  const lower = key.toLowerCase();
  if (SITE_DOCUMENT_PATH_PATTERN.test(lower)) return 'application/pdf';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.jar')) return 'application/java-archive';
  if (lower.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (lower.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (lower.endsWith('.deb')) return 'application/vnd.debian.binary-package';
  if (lower.endsWith('.appimage')) return 'application/octet-stream';
  if (lower.endsWith('.cfg') || lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function cacheControlForKey(key) {
  if (key.endsWith('latest.json') || key.endsWith('release-report.json')) {
    return 'public, max-age=60, must-revalidate';
  }
  return 'public, max-age=31536000, immutable';
}

function shouldUseReleaseObjectCache(key) {
  return cacheControlForKey(key).includes('immutable');
}

function objectHttpDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toUTCString();
}

function parseHttpRangeHeader(header = '', size = 0) {
  const value = String(header || '').trim();
  if (!value) return { range: null, error: '' };
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return { range: null, error: 'invalid' };
  const total = Number(size);
  if (!Number.isFinite(total) || total < 0) return { range: null, error: 'invalid' };
  const startRaw = match[1];
  const endRaw = match[2];
  if (!startRaw && !endRaw) return { range: null, error: 'invalid' };

  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return { range: null, error: 'invalid' };
    if (total === 0) return { range: null, error: 'unsatisfiable' };
    const length = Math.min(suffix, total);
    const start = Math.max(0, total - length);
    const end = total - 1;
    return { range: { start, end, offset: start, length, total }, error: '' };
  }

  const start = Number(startRaw);
  const requestedEnd = endRaw ? Number(endRaw) : total - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= total) {
    return { range: null, error: 'unsatisfiable' };
  }
  const end = Math.min(requestedEnd, Math.max(0, total - 1));
  return { range: { start, end, offset: start, length: end - start + 1, total }, error: '' };
}

function releaseHeaders(key, origin, object, range = null) {
  const headers = corsHeaders(origin);
  headers['Cache-Control'] = cacheControlForKey(key);
  headers['Content-Type'] = SITE_DOCUMENT_PATH_PATTERN.test(key)
    ? 'application/pdf'
    : (object.httpMetadata?.contentType || contentTypeForKey(key));
  if (SITE_DOCUMENT_PATH_PATTERN.test(key)) {
    const documentNumber = key.slice(3).padStart(3, '0');
    headers['Content-Disposition'] = `inline; filename="A Hard Time Update Log ${documentNumber}.pdf"`;
  } else if (key.startsWith('launcher/files/')) {
    const fileName = key.split('/').pop().replace(/["\\\r\n]/g, '');
    headers['Content-Disposition'] = `attachment; filename="${fileName}"`;
  } else if (object.httpMetadata?.contentDisposition) {
    headers['Content-Disposition'] = object.httpMetadata.contentDisposition;
  }
  headers['Accept-Ranges'] = 'bytes';
  if (object.httpEtag) headers.ETag = object.httpEtag;
  if (range) {
    headers['Content-Length'] = String(range.length);
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${range.total}`;
  } else if (object.size !== undefined) {
    headers['Content-Length'] = String(object.size);
  }
  const lastModified = objectHttpDate(object.uploaded);
  if (lastModified) headers['Last-Modified'] = lastModified;
  return headers;
}

function rangeNotSatisfiable(origin, objectSize) {
  const headers = corsHeaders(origin);
  headers['Content-Range'] = `bytes */${objectSize}`;
  headers['Accept-Ranges'] = 'bytes';
  return new Response(null, { status: 416, headers });
}

function releaseNotFound(key, origin) {
  return json({ error: 'Download not found.' }, 404, origin);
}

async function enforceReleaseRateLimit(request, env, origin, key = '') {
  if (!env.AHT_PLAYER_API_RATE_LIMITER?.limit) return null;
  const connection = requestIpv4(request);
  const ipKey = connection.ip || 'unavailable';
  const rangeKey = cleanString(request.headers.get('Range') || 'whole-object', 160);
  let allowed = false;
  try {
    // A full client ZIP can contain hundreds of valid parallel byte ranges. A
    // single IP-wide counter made the launcher's own range downloader exhaust
    // the bucket and receive 429 responses mid-install. Scope the counter to
    // the immutable object and exact range so repeated abusive requests are
    // still bounded without treating one multipart download as an API burst.
    const requestScope = `${cleanString(key, 512)}\n${rangeKey}`;
    const result = await env.AHT_PLAYER_API_RATE_LIMITER.limit({
      key: `release:${(await sha256Hex(ipKey)).slice(0, 20)}:${(await sha256Hex(requestScope)).slice(0, 20)}`
    });
    allowed = result?.success === true;
  } catch {
    allowed = false;
  }
  if (allowed) return null;
  return new Response(null, {
    status: 429,
    headers: { ...corsHeaders(origin), 'Cache-Control': 'private, no-store' }
  });
}

function releaseCacheRequest(request, key) {
  const url = new URL(request.url);
  url.pathname = `/${key}`;
  url.search = '';
  url.hash = '';
  return new Request(url.toString(), { method: 'GET' });
}

function releaseResponseForOrigin(response, origin, method) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin || '*');
  // Identity headers are always generated per request and must never survive
  // an old or externally populated edge-cache entry.
  headers.delete('Set-Cookie');
  return new Response(method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function readReleaseCache(request, key, origin, method) {
  const cache = globalThis.caches?.default;
  if (!cache?.match) return null;
  try {
    const cached = await cache.match(releaseCacheRequest(request, key));
    return cached ? releaseResponseForOrigin(cached, origin, method) : null;
  } catch {
    return null;
  }
}

async function writeReleaseCache(request, key, response, context) {
  const cache = globalThis.caches?.default;
  if (!cache?.put) return;
  const cacheResponse = response.clone();
  cacheResponse.headers.set('Access-Control-Allow-Origin', '*');
  cacheResponse.headers.delete('Set-Cookie');
  const write = cache.put(releaseCacheRequest(request, key), cacheResponse).catch((error) => {
    console.error(JSON.stringify({
      message: 'release cache put failed',
      key,
      error: error instanceof Error ? error.message : String(error)
    }));
  });
  if (context?.waitUntil) context.waitUntil(write);
  else await write;
}

function launcherManifestDownload(manifest, platformKey = '') {
  const candidates = (() => {
    if (platformKey === 'macos-universal') return ['macos-universal', 'macos-arm64', 'macos-x64'];
    if (platformKey === 'macos-arm64') return ['macos-universal', 'macos-arm64'];
    if (platformKey === 'macos-x64') return ['macos-universal', 'macos-x64'];
    if (platformKey === 'linux-x64') return ['ubuntu-x64-appimage', 'linux-x64'];
    if (platformKey === 'ubuntu-x64-appimage') return ['ubuntu-x64-appimage', 'linux-x64'];
    if (platformKey === 'ubuntu-x64') return ['ubuntu-x64-appimage', 'ubuntu-x64', 'linux-x64'];
    return [LAUNCHER_DOWNLOAD_KEY_ALIASES.get(platformKey) || platformKey];
  })();
  for (const candidate of candidates) {
    const artifact = manifest?.downloads?.[candidate];
    if (artifact) return artifact;
  }
  return null;
}

async function authorizeTaggedLauncherInstallerArtifact(request, env, origin, key, context) {
  const requestUrl = new URL(request.url);
  const platformKey = cleanString(requestUrl.searchParams.get('aht_download') || '', 80);
  if (request.method !== 'GET' || !LAUNCHER_DOWNLOAD_KEYS.has(platformKey) || !key.startsWith('launcher/files/')) {
    return { response: null, counted: false, identityHash: '', setCookie: '' };
  }
  // Historical manifests tagged the immutable file itself. Browsers may issue
  // several Range requests for one download, so those requests must never
  // consume separate daily slots. Current manifests use /launcher/download/.
  if (request.headers.get('Range')) {
    return { response: null, counted: false, identityHash: '', setCookie: '' };
  }

  let manifest;
  try {
    manifest = await readLauncherManifest(env);
  } catch (error) {
    console.error('launcher installer manifest authorization failed', error);
    return { response: launcherInstallerLimitUnavailable(origin), counted: false, identityHash: '', setCookie: '' };
  }
  const artifact = launcherManifestDownload(manifest, platformKey);
  const expectedKey = safeReleaseKey(`/${artifact?.path || ''}`);
  if (!artifact || expectedKey !== key) return { response: null, counted: false, identityHash: '', setCookie: '' };
  return authorizeLauncherInstallerDelivery(request, env, origin, platformKey, manifest, artifact, context);
}

async function serveReleaseObject(request, env, origin, context = null) {
  const requestUrl = new URL(request.url);
  const pathname = requestUrl.pathname;
  const method = request.method;
  if (!isReleaseCandidatePath(pathname)) {
    return null;
  }
  const bucket = releaseBucket(env);
  if (!bucket) {
    return json({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const key = safeReleaseKey(pathname);
  if (!key) {
    return json({ error: 'Invalid download request.' }, 400, origin);
  }

  const rateLimited = await enforceReleaseRateLimit(request, env, origin, key);
  if (rateLimited) return rateLimited;

  const rangeHeader = request.headers.get('Range') || '';
  if (!rangeHeader && shouldUseReleaseObjectCache(key)) {
    const cached = await readReleaseCache(request, key, origin, method);
    if (cached) {
      const authorization = await authorizeTaggedLauncherInstallerArtifact(request, env, origin, key, context);
      if (authorization.response) return authorization.response;
      return withLauncherInstallerIdentity(cached, authorization);
    }
  }
  let range = null;
  let object = null;
  let objectSize = 0;
  if (rangeHeader) {
    const metadata = typeof bucket.head === 'function' ? await bucket.head(key) : await bucket.get(key);
    if (!metadata) {
      return releaseNotFound(key, origin);
    }
    objectSize = Number(metadata.size || 0);
    const parsed = parseHttpRangeHeader(rangeHeader, objectSize);
    if (parsed.error || !parsed.range) {
      return rangeNotSatisfiable(origin, objectSize);
    }
    range = parsed.range;
    object = method === 'HEAD'
      ? metadata
      : await bucket.get(key, { range: { offset: range.offset, length: range.length } });
  } else {
    object = method === 'HEAD' && typeof bucket.head === 'function'
      ? await bucket.head(key)
      : await bucket.get(key);
  }

  if (!object) {
    return releaseNotFound(key, origin);
  }
  const authorization = await authorizeTaggedLauncherInstallerArtifact(request, env, origin, key, context);
  if (authorization.response) return authorization.response;
  const headers = releaseHeaders(key, origin, object, range);
  const response = withLauncherInstallerIdentity(
    new Response(method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers }),
    authorization
  );
  if (!range && method === 'GET' && shouldUseReleaseObjectCache(key)
      && Number(object.size || 0) <= RELEASE_CACHE_MAX_BYTES) {
    await writeReleaseCache(request, key, response, context);
  }
  return response;
}

async function readLauncherManifestWithMetadata(env) {
  const bucket = releaseBucket(env);
  if (!bucket) throw new Error('AHT_RELEASES R2 binding is not configured');
  const object = await bucket.get('launcher/latest.json');
  if (!object) throw new Error('Launcher update manifest is not available');
  if (Number(object.size || 0) > 256 * 1024) throw new Error('Launcher update manifest is too large');
  return {
    manifest: await object.json(),
    etag: cleanString(object.httpEtag || object.etag || '', 160)
  };
}

async function enforceLauncherStateRateLimit(request, env, origin) {
  if (!env.AHT_ADMIN_RATE_LIMITER?.limit) return null;
  const connection = requestIpv4(request);
  const ipKey = connection.ip || 'unavailable';
  let allowed = false;
  try {
    const result = await env.AHT_ADMIN_RATE_LIMITER.limit({
      key: `launcher-state:${(await sha256Hex(ipKey)).slice(0, 40)}`
    });
    allowed = result?.success === true;
  } catch {
    allowed = false;
  }
  if (allowed) return null;
  const response = privateJson({ error: 'Too many launcher-state connection attempts.' }, 429, origin);
  response.headers.set('Retry-After', '60');
  return response;
}

async function readLauncherManifest(env) {
  return (await readLauncherManifestWithMetadata(env)).manifest;
}

function parsedLauncherVersion(value = '') {
  const match = cleanString(value, 40).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 1_000_000)) return null;
  return { text: cleanString(value, 40), numbers, prerelease: match[4] || '' };
}

function compareLauncherVersions(left, right) {
  const a = parsedLauncherVersion(left);
  const b = parsedLauncherVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true, sensitivity: 'base' });
}

async function launcherVersionPolicy(env) {
  const configuredFloor = cleanString(env.AHT_REQUIRED_LAUNCHER_VERSION || '', 40);
  if (configuredFloor) {
    if (!parsedLauncherVersion(configuredFloor)) throw new Error('AHT_REQUIRED_LAUNCHER_VERSION is invalid');
    return { necessaryLauncherVersion: configuredFloor, source: 'configured-floor' };
  }
  const manifest = await readLauncherManifest(env);
  const necessaryLauncherVersion = cleanString(manifest?.version || manifest?.currentVersion || '', 40);
  if (manifest?.schemaVersion !== 1 || manifest?.product !== 'aht-launcher'
      || manifest?.required !== true || !parsedLauncherVersion(necessaryLauncherVersion)) {
    throw new Error('Launcher update manifest is not a required production manifest');
  }
  return { necessaryLauncherVersion, source: 'launcher/latest.json' };
}

async function launcherVersionPolicyState(env) {
  const configuredFloor = cleanString(env.AHT_REQUIRED_LAUNCHER_VERSION || '', 40);
  if (configuredFloor) {
    if (!parsedLauncherVersion(configuredFloor)) throw new Error('AHT_REQUIRED_LAUNCHER_VERSION is invalid');
    return {
      necessaryLauncherVersion: configuredFloor,
      source: 'configured-floor',
      manifestEtag: ''
    };
  }
  const { manifest, etag } = await readLauncherManifestWithMetadata(env);
  const necessaryLauncherVersion = cleanString(manifest?.version || manifest?.currentVersion || '', 40);
  if (manifest?.schemaVersion !== 1 || manifest?.product !== 'aht-launcher'
      || manifest?.required !== true || !parsedLauncherVersion(necessaryLauncherVersion)) {
    throw new Error('Launcher update manifest is not a required production manifest');
  }
  return {
    necessaryLauncherVersion,
    source: 'launcher/latest.json',
    manifestEtag: etag || await sha256Hex(canonicalJson(manifest))
  };
}

function launcherVersionAccepted(currentLauncherVersion, policy) {
  const current = cleanString(currentLauncherVersion || '', 40);
  const necessary = cleanString(policy?.necessaryLauncherVersion || '', 40);
  return Boolean(parsedLauncherVersion(current) && parsedLauncherVersion(necessary) && current === necessary);
}

function launcherVersionFailure(currentLauncherVersion, policy) {
  return {
    ok: false,
    status: 426,
    code: 'LAUNCHER_UPDATE_REQUIRED',
    error: 'A newer AHT Launcher version is required before reconnecting.',
    currentLauncherVersion: cleanString(currentLauncherVersion || '', 40) || 'unknown',
    necessaryLauncherVersion: cleanString(policy?.necessaryLauncherVersion || '', 40) || 'unknown'
  };
}

function requestCookieValue(request, name) {
  const source = String(request.headers.get('Cookie') || '');
  for (const item of source.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1 || item.slice(0, separator).trim() !== name) continue;
    return item.slice(separator + 1).trim();
  }
  return '';
}

function launcherInstallerIdentityCookie(value) {
  return `${LAUNCHER_INSTALLER_ID_COOKIE}=${value}; Max-Age=${LAUNCHER_INSTALLER_ID_COOKIE_MAX_AGE_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

async function launcherInstallerPersonIdentity(request, env) {
  const secret = adminTokenSecret(env);
  const supplied = requestCookieValue(request, LAUNCHER_INSTALLER_ID_COOKIE);
  const parts = supplied.split('.');
  if (parts.length === 2
      && /^[a-f0-9]{32}$/i.test(parts[0])
      && /^[A-Za-z0-9_-]{43}$/.test(parts[1])) {
    const expected = await hmac(`${LAUNCHER_INSTALLER_ID_COOKIE_PROTOCOL}\0${parts[0].toLowerCase()}`, secret);
    if (await secureStringEqual(parts[1], expected)) {
      const value = parts[0].toLowerCase();
      return {
        kind: 'anonymous-cookie',
        value,
        identityHash: await sha256Hex(`anonymous-cookie\0${value}`),
        setCookie: ''
      };
    }
  }

  const value = crypto.randomUUID().replaceAll('-', '').toLowerCase();
  const signature = await hmac(`${LAUNCHER_INSTALLER_ID_COOKIE_PROTOCOL}\0${value}`, secret);
  return {
    kind: 'anonymous-cookie',
    value,
    identityHash: await sha256Hex(`anonymous-cookie\0${value}`),
    setCookie: launcherInstallerIdentityCookie(`${value}.${signature}`)
  };
}

function withLauncherInstallerIdentity(response, authorization) {
  if (!authorization?.setCookie) return response;
  const headers = new Headers(response.headers);
  headers.set('Set-Cookie', authorization.setCookie);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function launcherInstallerBlockedResponse(origin, setCookie = '') {
  const headers = {
    ...corsHeaders(origin),
    'Cache-Control': 'private, no-store'
  };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  // A 204 keeps direct browser navigations on the current page while revealing
  // no quota, reset, infrastructure, or account details to the player.
  return new Response(null, { status: 204, headers });
}

function launcherInstallerLimitUnavailable(origin, setCookie = '') {
  return launcherInstallerBlockedResponse(origin, setCookie);
}

async function enforceLauncherInstallerDownloadLimit(request, env, origin, requestKey = '') {
  let identity;
  try {
    identity = await launcherInstallerPersonIdentity(request, env);
  } catch (error) {
    console.error('launcher installer identity check failed', error);
    return { response: launcherInstallerLimitUnavailable(origin), counted: false, identityHash: '', setCookie: '' };
  }
  const namespace = env.AHT_LAUNCHER_STATE;
  if (!identity || !namespace?.idFromName || !namespace?.get) {
    return {
      response: launcherInstallerLimitUnavailable(origin, identity?.setCookie || ''),
      counted: false,
      identityHash: identity?.identityHash || '',
      setCookie: identity?.setCookie || ''
    };
  }

  let response;
  let result;
  try {
    const identityHash = identity.identityHash || await sha256Hex(`${identity.kind}\0${identity.value}`);
    const requestKeyHash = await sha256Hex(cleanString(requestKey || 'launcher-installer', 512));
    const stub = namespace.get(namespace.idFromName(
      `launcher-installer-download:${LAUNCHER_INSTALLER_DOWNLOAD_POLICY_EPOCH}:${identityHash}`
    ));
    if (!stub?.fetch) {
      return {
        response: launcherInstallerLimitUnavailable(origin, identity.setCookie),
        counted: false,
        identityHash,
        setCookie: identity.setCookie
      };
    }
    response = await stub.fetch(`https://aht-launcher-state.internal${LAUNCHER_INSTALLER_DOWNLOAD_LIMIT_PATH}`, {
      method: 'POST',
      headers: {
        [LAUNCHER_INSTALLER_DOWNLOAD_LIMIT_INTERNAL_HEADER]: '1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ requestKey: requestKeyHash })
    });
    result = await response.json();
  } catch (error) {
    console.error('launcher installer limit check failed', error);
    return {
      response: launcherInstallerLimitUnavailable(origin, identity.setCookie),
      counted: false,
      identityHash: identity.identityHash,
      setCookie: identity.setCookie
    };
  }

  if (response.status === 429 && result?.code === 'LAUNCHER_INSTALLER_DOWNLOAD_LIMIT') {
    return {
      response: launcherInstallerBlockedResponse(origin, identity.setCookie),
      counted: false,
      identityHash: identity.identityHash,
      setCookie: identity.setCookie
    };
  }

  const quota = {
    count: Number(result?.count),
    remaining: Number(result?.remaining),
    resetAt: Number(result?.resetAt)
  };
  if (!response.ok || result?.ok !== true
      || !Number.isInteger(quota.count) || quota.count < 1 || quota.count > LAUNCHER_INSTALLER_DOWNLOAD_LIMIT
      || !Number.isInteger(quota.remaining) || quota.remaining < 0 || quota.remaining >= LAUNCHER_INSTALLER_DOWNLOAD_LIMIT
      || quota.count + quota.remaining !== LAUNCHER_INSTALLER_DOWNLOAD_LIMIT
      || !Number.isFinite(quota.resetAt) || quota.resetAt <= Date.now()) {
    return {
      response: launcherInstallerLimitUnavailable(origin, identity.setCookie),
      counted: false,
      identityHash: identity.identityHash,
      setCookie: identity.setCookie
    };
  }
  return {
    response: null,
    counted: result?.counted !== false,
    identityHash: identity.identityHash,
    setCookie: identity.setCookie
  };
}

async function authorizeLauncherInstallerDelivery(request, env, origin, platformKey, manifest, artifact, context = null) {
  const authorization = await enforceLauncherInstallerDownloadLimit(
    request,
    env,
    origin,
    `${platformKey}\0${cleanString(manifest?.version || '', 80)}\0${cleanString(artifact?.path || '', 512)}`
  );
  if (authorization.response) return authorization;
  if (authorization.counted) {
    const write = recordLauncherInstallerDownload(request, env, platformKey, manifest, artifact)
      .catch((error) => console.error('launcher download telemetry failed', error));
    if (context?.waitUntil) context.waitUntil(write);
    else await write;
  }
  return authorization;
}

async function recordLauncherInstallerDownload(request, env, platformKey, manifest, artifact) {
  if (!env.AHT_DATA) return null;
  const receivedAt = new Date().toISOString();
  const downloadId = crypto.randomUUID();
  const ip = requestIpv4(request);
  const network = await requestNetworkAssessment(request, env, ip);
  const platform = normalizePlatform(artifact?.label || platformKey);
  const record = {
    schemaVersion: 3,
    type: 'launcher_installer_download',
    downloadId,
    receivedAt,
    launcherVersion: cleanString(manifest?.version || '', 80),
    platformKey,
    platform,
    platformLabel: platform,
    fileName: cleanString(artifact?.fileName || '', 260),
    minecraftUsername: '',
    minecraftUuid: '',
    identitySource: 'anonymous-cookie',
    ipv4: ip.ipv4,
    ip: ip.ip,
    ipVersion: ip.ipVersion,
    ipv4Source: ip.source,
    ipv4Available: ip.ipv4Available,
    pseudoIpv4: ip.pseudo,
    country: request.cf?.country || '',
    asn: network.asn,
    asOrganization: network.organization,
    colo: network.colo,
    network,
    userAgent: cleanString(request.headers.get('User-Agent') || '', 600),
    referrer: cleanString(request.headers.get('Referer') || '', 600),
    cfRay: cleanString(request.headers.get('CF-Ray') || '', 120)
  };
  const key = launcherDownloadKey(receivedAt, downloadId);
  await env.AHT_DATA.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' }
  });
  return { key, record };
}

async function launcherInstallerDownload(request, env, origin, platformKey, context = null) {
  if (!LAUNCHER_DOWNLOAD_KEYS.has(platformKey)) {
    return launcherInstallerBlockedResponse(origin);
  }
  let manifest;
  try {
    manifest = await readLauncherManifest(env);
  } catch (error) {
    console.error('launcher installer manifest lookup failed', error);
    return launcherInstallerBlockedResponse(origin);
  }
  const artifact = launcherManifestDownload(manifest, platformKey);
  const key = safeReleaseKey(`/${artifact?.path || ''}`);
  if (!artifact || !key || !key.startsWith('launcher/files/')) {
    return launcherInstallerBlockedResponse(origin);
  }
  const bucket = releaseBucket(env);
  if (!bucket) return launcherInstallerBlockedResponse(origin);
  let exists;
  try {
    exists = typeof bucket.head === 'function' ? await bucket.head(key) : await bucket.get(key);
  } catch (error) {
    console.error('launcher installer object lookup failed', error);
    return launcherInstallerBlockedResponse(origin);
  }
  if (!exists) return launcherInstallerBlockedResponse(origin);

  let authorization = { response: null, counted: false, identityHash: '', setCookie: '' };
  if (request.method === 'GET') {
    authorization = await authorizeLauncherInstallerDelivery(
      request,
      env,
      origin,
      platformKey,
      manifest,
      artifact,
      context
    );
    if (authorization.response) return authorization.response;
  }

  const location = new URL(`/${key}`, request.url).toString();
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(origin),
      'Cache-Control': 'private, no-store',
      ...(authorization.setCookie ? { 'Set-Cookie': authorization.setCookie } : {}),
      Location: location
    }
  });
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256BytesHex(value) {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

async function deviceBindingHash(binding = {}) {
  return sha256Hex(canonicalJson(binding));
}

function deviceAssertionMessage(assertion = {}) {
  return [
    DEVICE_ASSERTION_PROTOCOL,
    cleanString(assertion.deviceId, 80),
    cleanString(assertion.purpose, 80),
    cleanString(assertion.signedAt, 80),
    cleanString(assertion.nonce, 80),
    cleanString(assertion.bindingHash, 80)
  ].join('\n');
}

async function verifyDeviceAssertion(body = {}, purpose = '', binding = {}) {
  const assertion = body.deviceAssertion;
  const required = Boolean(body.deviceId || body.devicePublicKey || assertion);
  if (!required) return { ok: false, missing: true, error: 'Device identity is required.' };
  if (!assertion || typeof assertion !== 'object'
      || assertion.protocol !== DEVICE_ASSERTION_PROTOCOL
      || assertion.algorithm !== 'Ed25519'
      || cleanString(assertion.purpose, 80) !== purpose) {
    return { ok: false, missing: false, error: 'Device assertion is invalid.' };
  }
  const deviceId = cleanString(body.deviceId || assertion.deviceId, 80);
  const publicKey = cleanString(body.devicePublicKey || assertion.publicKey, 1024);
  if (assertion.deviceId !== deviceId || assertion.publicKey !== publicKey
      || !new RegExp(`^${DEVICE_ID_PREFIX}[a-f0-9]{64}$`).test(deviceId)
      || !/^[A-Za-z0-9_-]{40,800}$/.test(publicKey)
      || !/^[A-Za-z0-9_-]{40,200}$/.test(cleanString(assertion.signature, 240))) {
    return { ok: false, missing: false, error: 'Device assertion is invalid.' };
  }
  let publicKeyBytes;
  try {
    publicKeyBytes = decodeBase64UrlBytes(publicKey);
  } catch {
    return { ok: false, missing: false, error: 'Device public key is invalid.' };
  }
  if (`${DEVICE_ID_PREFIX}${await sha256BytesHex(publicKeyBytes)}` !== deviceId) {
    return { ok: false, missing: false, error: 'Device identity does not match its public key.' };
  }
  const signedAt = Date.parse(cleanString(assertion.signedAt, 80));
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > 2 * 60 * 1000
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanString(assertion.nonce, 80))) {
    return { ok: false, missing: false, error: 'Device assertion is expired or invalid.' };
  }
  const expectedBindingHash = await deviceBindingHash(binding);
  if (!(await secureStringEqual(assertion.bindingHash, expectedBindingHash))) {
    return { ok: false, missing: false, error: 'Device assertion does not match this request.' };
  }
  try {
    const key = await crypto.subtle.importKey('spki', publicKeyBytes, { name: 'Ed25519' }, false, ['verify']);
    const signatureValid = await crypto.subtle.verify(
      'Ed25519',
      key,
      decodeBase64UrlBytes(assertion.signature),
      new TextEncoder().encode(deviceAssertionMessage(assertion))
    );
    if (!signatureValid) return { ok: false, missing: false, error: 'Device assertion signature is invalid.' };
  } catch {
    return { ok: false, missing: false, error: 'Device assertion signature is invalid.' };
  }
  return { ok: true, missing: false, deviceId, publicKey, assertion };
}

function base64Url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeBase64UrlJson(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = atob(padded);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (char) => char.charCodeAt(0))));
}

function decodeBase64UrlBytes(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function pemBytes(value, label) {
  const normalized = String(value || '').replace(/\\n/g, '\n').trim();
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  if (!normalized.startsWith(begin) || !normalized.endsWith(end)) {
    throw new Error(`${label} PEM is invalid`);
  }
  const encoded = normalized.slice(begin.length, -end.length).replace(/\s+/g, '');
  if (!encoded) throw new Error(`${label} PEM is empty`);
  const raw = atob(encoded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

let attestationPrivateKeyCache = { source: '', promise: null };
let attestationPublicKeyCache = { source: '', promise: null };

function attestationPrivateKey(env) {
  const source = String(env.LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8 || '').trim();
  if (!source) throw new Error('LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8 is not configured');
  if (attestationPrivateKeyCache.source !== source || !attestationPrivateKeyCache.promise) {
    attestationPrivateKeyCache = {
      source,
      promise: crypto.subtle.importKey(
        'pkcs8',
        pemBytes(source, 'PRIVATE KEY'),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
      ).then((key) => {
        if (Number(key.algorithm?.modulusLength || 0) < 2048) throw new Error('Launcher attestation RSA private key must be at least 2048 bits');
        return key;
      })
    };
  }
  return attestationPrivateKeyCache.promise;
}

function attestationPublicKey(env) {
  const source = String(env.LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI || '').trim();
  if (!source) throw new Error('LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI is not configured');
  if (attestationPublicKeyCache.source !== source || !attestationPublicKeyCache.promise) {
    attestationPublicKeyCache = {
      source,
      promise: crypto.subtle.importKey(
        'spki',
        pemBytes(source, 'PUBLIC KEY'),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      ).then((key) => {
        if (Number(key.algorithm?.modulusLength || 0) < 2048) throw new Error('Launcher attestation RSA public key must be at least 2048 bits');
        return key;
      })
    };
  }
  return attestationPublicKeyCache.promise;
}

async function hmac(input, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))));
}

function cleanString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

async function launcherProofToken(payload, env) {
  if (JSON.stringify(payload || {}).length > 4608) {
    throw new Error('Launcher attestation payload exceeds the 4608-byte JSON size limit');
  }
  if (payload?.protocol === LAUNCHER_ATTESTATION_PROTOCOL) {
    const keyId = cleanString(env.LAUNCHER_ATTESTATION_KEY_ID || LAUNCHER_ATTESTATION_KEY_ID, 120);
    if (keyId !== LAUNCHER_ATTESTATION_KEY_ID) {
      throw new Error(`LAUNCHER_ATTESTATION_KEY_ID must be ${LAUNCHER_ATTESTATION_KEY_ID}`);
    }
    return signRs256Token(payload, env, 'AHT-LAUNCHER-ATTESTATION', 4608, 8192);
  }
  const secret = env.LAUNCHER_PROOF_SECRET || env.AHT_LAUNCHER_PROOF_SECRET;
  if (!secret) {
    throw new Error('LAUNCHER_PROOF_SECRET is not configured');
  }
  const keyId = LEGACY_LAUNCHER_PROOF_KEY_ID;
  const header = { alg: 'HS256', typ: 'AHT-LAUNCHER-PROOF', kid: keyId };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmac(signingInput, secret);
  const token = `${signingInput}.${signature}`;
  if (token.length > 8192) throw new Error('Legacy launcher proof token exceeds the 8 KiB size limit');
  return {
    token,
    header,
    payload,
    signature: { alg: 'HS256', kid: header.kid, value: signature }
  };
}

async function signRs256Token(payload, env, type, maxPayloadBytes, maxTokenChars) {
  const payloadText = JSON.stringify(payload || {});
  if (payloadText.length > maxPayloadBytes) {
    throw new Error(`${type} payload exceeds its size limit`);
  }
  const keyId = cleanString(env.LAUNCHER_ATTESTATION_KEY_ID || LAUNCHER_ATTESTATION_KEY_ID, 120);
  if (keyId !== LAUNCHER_ATTESTATION_KEY_ID) {
    throw new Error(`LAUNCHER_ATTESTATION_KEY_ID must be ${LAUNCHER_ATTESTATION_KEY_ID}`);
  }
  const header = { alg: 'RS256', typ: type, kid: keyId };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64Url(new TextEncoder().encode(payloadText));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await attestationPrivateKey(env);
  const signature = base64Url(new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  )));
  const token = `${signingInput}.${signature}`;
  if (token.length > maxTokenChars) throw new Error(`${type} token exceeds its size limit`);
  return {
    token,
    header,
    payload,
    signature: { alg: 'RS256', kid: header.kid, value: signature }
  };
}

async function launcherProofSigningSelfTest(env) {
  const issuedAtMs = Date.now();
  const launchId = crypto.randomUUID();
  const selfTestLauncherVersion = '0.0.0-self-test';
  const payload = {
    protocol: LAUNCHER_ATTESTATION_PROTOCOL,
    schemaVersion: 2,
    jti: launchId,
    launchId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + 60 * 1000).toISOString(),
    reconnectExpiresAt: new Date(issuedAtMs + LAUNCHER_RECONNECT_TTL_MS).toISOString(),
    issuer: LAUNCHER_ATTESTATION_ISSUER,
    audience: LAUNCHER_ATTESTATION_AUDIENCE,
    packId: cleanString(env.LAUNCHER_PROOF_PACK_ID || 'a-hard-time-dregora', 80),
    minecraftUsername: 'AHTProofCheck',
    minecraftUuid: '01234567-89ab-4def-8123-456789abcdef',
    installId: 'launcher-proof-status-self-test',
    appVersion: selfTestLauncherVersion,
    launcherVersion: selfTestLauncherVersion,
    launcherVersionAuthority: 'worker-policy-matched-device-assertion',
    packVersion: 'self-test',
    launcherChannel: 'developer',
    developerClient: true,
    developerClientBypass: true,
    modIntegrityBypass: true,
    accessGranted: true,
    networkStatus: 'unknown'
  };
  const signed = await launcherProofToken(payload, env);
  const request = new Request('https://launcher-proof-self-test.invalid/', {
    headers: { Authorization: `Bearer ${signed.token}` }
  });
  const verified = await verifyLauncherProofRequest(request, env, { skipVersionPolicy: true });
  return Boolean(
    verified.ok
    && verified.payload?.launchId === payload.launchId
    && verified.payload?.minecraftUsername === payload.minecraftUsername
    && verified.payload?.installId === payload.installId
  );
}

async function launcherProofStatus(env, origin) {
  const privateKeyConfigured = Boolean(String(env.LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8 || '').trim());
  const publicKeyConfigured = Boolean(String(env.LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI || '').trim());
  const keyId = cleanString(env.LAUNCHER_ATTESTATION_KEY_ID || LAUNCHER_ATTESTATION_KEY_ID, 120);
  const configured = privateKeyConfigured && publicKeyConfigured;
  let signingVerified = false;
  if (configured && keyId === LAUNCHER_ATTESTATION_KEY_ID) {
    try {
      signingVerified = await launcherProofSigningSelfTest(env);
    } catch {
      signingVerified = false;
    }
  }
  const ready = configured && keyId === LAUNCHER_ATTESTATION_KEY_ID && signingVerified;
  return privateJson(ready ? {
    ok: true,
    service: 'AHT Proxy',
    protocol: LAUNCHER_ATTESTATION_PROTOCOL,
    algorithm: 'RS256'
  } : {
    ok: false,
    service: 'AHT Proxy'
  }, ready ? 200 : 503, origin);
}

function adminTokenSecret(env) {
  const secret = String(env.ADMIN_TOKEN_SECRET || '');
  if (secret.length < 32) {
    throw new Error('ADMIN_TOKEN_SECRET must be configured with at least 32 characters');
  }
  return secret;
}

async function createToken(username, env) {
  const issuedAt = Date.now();
  const expiresAt = Date.now() + 1000 * 60 * 60 * 12;
  const payload = base64UrlJson({ schemaVersion: 1, username, issuedAt, expiresAt });
  const signature = await hmac(payload, adminTokenSecret(env));
  return { token: `${payload}.${signature}`, expiresAt: new Date(expiresAt).toISOString() };
}

async function adminSession(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  let secret;
  try {
    secret = adminTokenSecret(env);
  } catch {
    return null;
  }
  const expected = await hmac(parts[0], secret);
  if (!(await secureStringEqual(parts[1], expected))) return null;
  let decoded;
  try {
    decoded = decodeBase64UrlJson(parts[0]);
  } catch {
    return null;
  }
  const now = Date.now();
  if (decoded?.schemaVersion !== 1
      || !/^[A-Za-z0-9_.@-]{1,120}$/.test(String(decoded.username || ''))
      || !Number.isFinite(Number(decoded.issuedAt))
      || !Number.isFinite(Number(decoded.expiresAt))
      || decoded.issuedAt > now + 120000
      || decoded.expiresAt <= now
      || decoded.expiresAt - decoded.issuedAt > 12 * 60 * 60 * 1000) return null;
  return decoded;
}

async function verifyToken(request, env) {
  return Boolean(await adminSession(request, env));
}

async function proxyCurseForge(pathname, env, origin) {
  if (!env.CURSEFORGE_API_KEY) {
    return json({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const target = `${CURSEFORGE_BASE}${pathname}`;
  const response = await fetch(target, {
    headers: {
      Accept: 'application/json',
      'x-api-key': env.CURSEFORGE_API_KEY
    }
  });
  const headers = corsHeaders(origin);
  headers['Content-Type'] = response.headers.get('Content-Type') || 'application/json';
  return new Response(response.body, { status: response.status, headers });
}

async function readBody(request, maxBytes = 1024 * 1024) {
  const rawLength = String(request.headers.get('Content-Length') || '').trim();
  if (rawLength && !/^\d+$/.test(rawLength)) {
    throw new RequestPayloadError(400, 'Content-Length is invalid.');
  }
  if (rawLength && Number(rawLength) > maxBytes) {
    throw new RequestPayloadError(413, 'Request body is too large.');
  }
  if (!request.body) return {};

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('request body limit exceeded').catch(() => {});
        throw new RequestPayloadError(413, 'Request body is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestPayloadError(400, 'Request body must be valid JSON.');
  }
}

function normalizeMinecraftUsername(username) {
  return String(username || '').trim();
}

function minecraftUsernameKey(username) {
  return `accounts/usernames/${username.toLowerCase()}.json`;
}

function accountIpv4Key(ipv4, username) {
  return `${ACCOUNT_IPV4_PREFIX}${ipv4}/${username.toLowerCase()}.json`;
}

function accountUuidKey(minecraftUuid) {
  return `${ACCOUNT_UUID_PREFIX}${normalizeMinecraftUuid(minecraftUuid)}.json`;
}

function accountDeviceKey(deviceId, username) {
  return `${ACCOUNT_DEVICE_PREFIX}${cleanString(deviceId, 80)}/${normalizeMinecraftUsername(username).toLowerCase()}.json`;
}

function normalizedAccessValue(scope, value = '') {
  if (scope === 'account') {
    const username = normalizeMinecraftUsername(value).toLowerCase();
    return /^[a-z0-9_]{3,16}$/.test(username) ? username : '';
  }
  if (scope === 'minecraft_uuid') return normalizeMinecraftUuid(value);
  if (scope === 'device') {
    const deviceId = cleanString(value, 80).toLowerCase();
    return new RegExp(`^${DEVICE_ID_PREFIX}[a-f0-9]{64}$`).test(deviceId) ? deviceId : '';
  }
  if (scope === 'ip') return normalizedConnectionIp(value);
  if (scope === 'ipv4') return ipv4FromHeader(value);
  return '';
}

async function accessDecisionKey(scope, value) {
  return `${ACCESS_DECISION_PREFIX}${scope}/${await sha256Hex(`${scope}\0${value}`)}.json`;
}

async function readAccessDecision(env, scope, rawValue) {
  if (!env.AHT_DATA || !ACCESS_SCOPES.has(scope)) return null;
  const value = normalizedAccessValue(scope, rawValue);
  if (!value) return null;
  const object = await env.AHT_DATA.get(await accessDecisionKey(scope, value));
  const decision = object ? await object.json().catch(() => null) : null;
  return decision?.active === true && decision?.effect === 'deny' ? decision : null;
}

async function evaluateAccess(env, identifiers = {}) {
  const checks = [
    ['account', identifiers.username],
    ['minecraft_uuid', identifiers.minecraftUuid],
    ['device', identifiers.deviceId],
    ['ip', identifiers.ip],
    ['ipv4', identifiers.ipv4]
  ];
  for (const [scope, value] of checks) {
    if (!value) continue;
    const decision = await readAccessDecision(env, scope, value);
    if (decision) {
      return {
        allowed: false,
        code: 'ACCESS_DENIED',
        scope,
        decisionId: cleanString(decision.decisionId || '', 120)
      };
    }
  }
  if (env.AHT_BLOCK_LIKELY_VPN === 'true' && identifiers.network?.status === 'likely') {
    return { allowed: false, code: 'NETWORK_POLICY_DENIED', scope: 'network', decisionId: '' };
  }
  return { allowed: true, code: 'ACCESS_GRANTED', scope: '', decisionId: '' };
}

function accessDeniedResponse(access, origin) {
  return privateJson({
    error: 'Access to A Hard Time is restricted for this account or device.',
    code: access?.code || 'ACCESS_DENIED'
  }, 403, origin);
}

async function launcherAttestationPublicMaterial(env) {
  const spki = pemBytes(env.LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI, 'PUBLIC KEY');
  await attestationPublicKey(env);
  return {
    spkiBase64Url: base64Url(spki),
    sha256: await sha256BytesHex(spki)
  };
}

async function launcherProofPublicKey(env, origin) {
  const keyId = cleanString(env.LAUNCHER_ATTESTATION_KEY_ID || LAUNCHER_ATTESTATION_KEY_ID, 120);
  if (keyId !== LAUNCHER_ATTESTATION_KEY_ID) {
    return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  try {
    const material = await launcherAttestationPublicMaterial(env);
    return privateJson({
      ok: true,
      protocol: LAUNCHER_ATTESTATION_PROTOCOL,
      algorithm: 'RS256',
      keyId,
      spkiBase64Url: material.spkiBase64Url,
      sha256: material.sha256
    }, 200, origin);
  } catch {
    return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
}

async function launcherServerAccountBinding(record = {}) {
  const username = normalizeMinecraftUsername(record.username || record.minecraftUsername);
  const normalizedUsername = username.toLowerCase();
  const minecraftUuid = normalizeMinecraftUuid(record.minecraftUuid);
  const installId = cleanString(record.installId || '', 120);
  const deviceId = normalizedAccessValue('device', record.deviceId);
  if (!/^[a-z0-9_]{3,16}$/.test(normalizedUsername)
      || !minecraftUuid || !installId || !deviceId || isSyntheticReadinessAccount(record)) {
    return null;
  }
  return {
    accountDigest: await sha256Hex(`account\0${normalizedUsername}`),
    bindingDigest: await sha256Hex(
      `binding-v1\0${normalizedUsername}\0${minecraftUuid}\0${installId}\0${deviceId}`
    )
  };
}

async function launcherServerAccessDenial(decision = {}) {
  const scope = cleanString(decision.scope || '', 40).toLowerCase();
  const value = normalizedAccessValue(scope, decision.value);
  if (decision.active !== true || decision.effect !== 'deny' || !ACCESS_SCOPES.has(scope) || !value) {
    return null;
  }
  return { scope, digest: await sha256Hex(`${scope}\0${value}`) };
}

async function readLauncherServerStateRecords(env, prefix, maximum) {
  const records = [];
  let cursor = '';
  const seenCursors = new Set();
  do {
    const options = { prefix, limit: Math.min(1000, maximum + 1 - records.length) };
    if (options.limit <= 0) throw new Error(`Launcher server state ${prefix} limit exceeded`);
    if (cursor) options.cursor = cursor;
    const listed = await env.AHT_DATA.list(options);
    const objects = listed.objects || [];
    if (records.length + objects.length > maximum) {
      throw new Error(`Launcher server state ${prefix} limit exceeded`);
    }
    for (let offset = 0; offset < objects.length; offset += 6) {
      records.push(...await readR2JsonObjects(env, objects.slice(offset, offset + 6)));
    }
    if (!listed.truncated) break;
    const nextCursor = String(listed.cursor || '');
    if (!nextCursor || seenCursors.has(nextCursor)) throw new Error(`Launcher server state ${prefix} listing stalled`);
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (true);
  return records;
}

async function buildLauncherServerStatePayload(env) {
  if (!env.AHT_DATA) throw new Error('AHT_DATA R2 binding is not configured');
  const [policy, keyMaterial] = await Promise.all([
    launcherVersionPolicyState(env),
    launcherAttestationPublicMaterial(env)
  ]);
  const accountRecords = await readLauncherServerStateRecords(
    env, ACCOUNT_USERNAME_PREFIX, LAUNCHER_SERVER_STATE_MAX_ACCOUNTS
  );
  const decisionRecords = await readLauncherServerStateRecords(
    env, ACCESS_DECISION_PREFIX, LAUNCHER_SERVER_STATE_MAX_DENIALS
  );
  const eligibleAccounts = accountRecords.filter((record) => !isSyntheticReadinessAccount(record));
  if (eligibleAccounts.length > LAUNCHER_SERVER_STATE_MAX_ACCOUNTS) {
    throw new Error('Launcher server state account limit exceeded');
  }
  if (decisionRecords.length > LAUNCHER_SERVER_STATE_MAX_DENIALS) {
    throw new Error('Launcher server state access-decision limit exceeded');
  }

  const accountMap = new Map();
  for (const binding of (await Promise.all(eligibleAccounts.map(launcherServerAccountBinding))).filter(Boolean)) {
    const existing = accountMap.get(binding.accountDigest);
    if (existing && existing !== binding.bindingDigest) {
      throw new Error('Launcher server state contains conflicting account bindings');
    }
    accountMap.set(binding.accountDigest, binding.bindingDigest);
  }
  const denialMap = new Map();
  for (const denial of (await Promise.all(decisionRecords.map(launcherServerAccessDenial))).filter(Boolean)) {
    denialMap.set(`${denial.scope}:${denial.digest}`, denial);
  }

  const core = {
    protocol: LAUNCHER_SERVER_STATE_PROTOCOL,
    schemaVersion: 1,
    issuer: LAUNCHER_ATTESTATION_ISSUER,
    audience: LAUNCHER_SERVER_STATE_AUDIENCE,
    keyId: LAUNCHER_ATTESTATION_KEY_ID,
    attestationKeySha256: keyMaterial.sha256,
    packId: cleanString(env.LAUNCHER_PROOF_PACK_ID || 'a-hard-time-dregora', 80),
    necessaryLauncherVersion: policy.necessaryLauncherVersion,
    policySource: policy.source,
    manifestEtag: cleanString(policy.manifestEtag || '', 160),
    blockLikelyVpn: env.AHT_BLOCK_LIKELY_VPN === 'true',
    accountBindings: [...accountMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([accountDigest, bindingDigest]) => ({ accountDigest, bindingDigest })),
    accessDenials: [...denialMap.values()]
      .sort((left, right) => left.scope.localeCompare(right.scope) || left.digest.localeCompare(right.digest))
  };
  const revision = await sha256Hex(canonicalJson(core));
  return {
    ...core,
    revision,
    issuedAt: new Date().toISOString()
  };
}

async function signLauncherServerState(payload, env) {
  const signed = await signRs256Token(
    payload,
    env,
    LAUNCHER_SERVER_STATE_TYPE,
    LAUNCHER_SERVER_STATE_MAX_PAYLOAD_BYTES,
    LAUNCHER_SERVER_STATE_MAX_TOKEN_CHARS
  );
  const keyMaterial = await launcherAttestationPublicMaterial(env);
  return {
    schemaVersion: 1,
    protocol: LAUNCHER_SERVER_STATE_PROTOCOL,
    revision: payload.revision,
    issuedAt: payload.issuedAt,
    token: signed.token,
    publicKeySpki: keyMaterial.spkiBase64Url
  };
}

function launcherServerStateStub(env) {
  if (!env.AHT_LAUNCHER_STATE?.idFromName || !env.AHT_LAUNCHER_STATE?.get) return null;
  return env.AHT_LAUNCHER_STATE.get(env.AHT_LAUNCHER_STATE.idFromName(LAUNCHER_SERVER_STATE_DO_NAME));
}

async function notifyLauncherServerState(env, reason, required = false) {
  const stub = launcherServerStateStub(env);
  if (!stub) {
    if (required) throw new Error('AHT_LAUNCHER_STATE Durable Object binding is not configured');
    return { ok: false, skipped: true, revision: '' };
  }
  const response = await stub.fetch('https://aht-launcher-state.internal/refresh', {
    method: 'POST',
    headers: {
      [LAUNCHER_SERVER_STATE_INTERNAL_HEADER]: '1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ reason: cleanString(reason || 'state-change', 80) })
  });
  if (!response.ok) throw new Error(`Launcher server state refresh failed with ${response.status}`);
  const result = await response.json();
  if (result?.ok !== true || !/^[a-f0-9]{64}$/.test(String(result.revision || ''))) {
    throw new Error('Launcher server state refresh returned an invalid revision');
  }
  return result;
}

function launcherServerStateMessage(state) {
  return JSON.stringify({
    type: 'launcher-server-state',
    protocol: LAUNCHER_SERVER_STATE_PROTOCOL,
    schemaVersion: 1,
    revision: state.revision,
    token: state.token,
    publicKeySpki: state.publicKeySpki
  });
}

async function indexAccountIdentity(env, record) {
  const username = normalizeMinecraftUsername(record.username);
  const minecraftUuid = normalizeMinecraftUuid(record.minecraftUuid);
  const deviceId = normalizedAccessValue('device', record.deviceId);
  const indexRecord = {
    username,
    normalizedUsername: username.toLowerCase(),
    minecraftUuid,
    deviceId,
    firstSeenAt: record.createdAt || record.updatedAt || new Date().toISOString(),
    lastSeenAt: record.updatedAt || new Date().toISOString()
  };
  if (minecraftUuid) {
    await env.AHT_DATA.put(accountUuidKey(minecraftUuid), JSON.stringify(indexRecord), {
      httpMetadata: { contentType: 'application/json' }
    });
  }
  if (deviceId && username) {
    await env.AHT_DATA.put(accountDeviceKey(deviceId, username), JSON.stringify(indexRecord), {
      httpMetadata: { contentType: 'application/json' }
    });
  }
}

async function indexAccountIpv4(env, record) {
  const ipv4 = ipv4FromHeader(record.ipv4 || record.ip || '');
  const username = normalizeMinecraftUsername(record.username);
  if (!ipv4 || !username || record.pseudoIpv4) return;
  const key = accountIpv4Key(ipv4, username);
  const existing = await env.AHT_DATA.get(key);
  const previous = existing ? await existing.json().catch(() => null) : null;
  await env.AHT_DATA.put(key, JSON.stringify({
    ipv4,
    username,
    normalizedUsername: username.toLowerCase(),
    minecraftUuid: normalizeMinecraftUuid(record.minecraftUuid) || normalizeMinecraftUuid(previous?.minecraftUuid),
    platform: normalizePlatform(record.platform || previous?.platform),
    ipv4Source: record.ipv4Source || previous?.ipv4Source || 'legacy',
    pseudoIpv4: Boolean(record.pseudoIpv4 || previous?.pseudoIpv4),
    firstSeenAt: previous?.firstSeenAt || record.createdAt || record.updatedAt || new Date().toISOString(),
    lastSeenAt: record.updatedAt || new Date().toISOString(),
    installIds: [...new Set([...(previous?.installIds || []), record.installId].filter(Boolean))].slice(-20)
  }), {
    httpMetadata: { contentType: 'application/json' }
  });
}

async function registerUser(request, env, origin) {
  if (!env.AHT_DATA) {
    return json({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const rateLimited = await enforcePlayerApiRateLimit(request, env, 'register', origin);
  if (rateLimited) return rateLimited;
  const body = await readBody(request, 32_768);
  const username = normalizeMinecraftUsername(body.username);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    return json({ error: 'Enter a valid Minecraft username.' }, 400, origin);
  }
  const installId = String(body.installId || '').trim();
  if (!installId) {
    return json({ error: 'Install ID is required' }, 400, origin);
  }
  const suppliedMinecraftUuid = cleanString(body.minecraftUuid || body.mcUuid || '', 80);
  const minecraftUuid = normalizeMinecraftUuid(suppliedMinecraftUuid);
  if (suppliedMinecraftUuid && !minecraftUuid) {
    return json({ error: 'Minecraft UUID is invalid.' }, 400, origin);
  }
  // New launchers keep this credential out of JSON/proof documents. The body
  // fallback is bounded compatibility for registrations from old launchers.
  const accountRecoverySecret = cleanString(
    request.headers.get('X-AHT-Launcher-Recovery') || body.accountRecoverySecret || '',
    200
  );
  if (accountRecoverySecret && !/^[A-Za-z0-9_-]{32,200}$/.test(accountRecoverySecret)) {
    return json({ error: 'Launcher recovery credential is invalid.' }, 400, origin);
  }
  const accountRecoveryVerifier = accountRecoverySecret ? await sha256Hex(accountRecoverySecret) : '';
  const requestedDeviceId = cleanString(body.deviceId || '', 80).toLowerCase();
  const device = await verifyDeviceAssertion(body, 'account-registration', {
    username: username.toLowerCase(),
    minecraftUuid,
    installId,
    deviceId: requestedDeviceId
  });
  if (!device.ok && (!device.missing || env.AHT_REQUIRE_DEVICE_ATTESTATION === 'true')) {
    return privateJson({ error: device.error, code: 'DEVICE_ATTESTATION_REQUIRED' }, 403, origin);
  }

  const key = minecraftUsernameKey(username);
  const existing = await env.AHT_DATA.get(key);
  const existingRecord = existing ? await existing.json().catch(() => null) : null;
  const existingMinecraftUuid = normalizeMinecraftUuid(existingRecord?.minecraftUuid);
  if (existingMinecraftUuid && minecraftUuid && existingMinecraftUuid !== minecraftUuid) {
    return json({ error: 'Minecraft UUID does not match this registered player.' }, 409, origin);
  }
  const installChanged = Boolean(existingRecord && existingRecord.installId && existingRecord.installId !== installId);
  const recoveryRequested = Boolean(body.recoverExistingUsername && body.minecraftAccountMatched);
  const storedRecoveryVerifier = cleanString(existingRecord?.accountRecoveryVerifier || '', 80);
  const secureRecoveryMatched = Boolean(
    storedRecoveryVerifier
    && accountRecoveryVerifier
    && await secureStringEqual(storedRecoveryVerifier, accountRecoveryVerifier)
  );
  const recovered = Boolean(installChanged && recoveryRequested && secureRecoveryMatched);
  if (installChanged && recoveryRequested && !secureRecoveryMatched) {
    return json({ error: 'Secure launcher recovery could not be verified for this username.' }, 409, origin);
  }
  if (recovered && (!existingMinecraftUuid || !minecraftUuid || existingMinecraftUuid !== minecraftUuid)) {
    return json({ error: 'Minecraft UUID is required and must match this registered player before launcher recovery.' }, 409, origin);
  }
  if (installChanged && !recovered) {
    return json({ error: 'That username is not available.' }, 409, origin);
  }
  if (existing && !existingRecord) {
    return json({ error: 'That username is not available.' }, 409, origin);
  }

  const now = new Date().toISOString();
  const clientIp = requestIpv4(request);
  const network = await requestNetworkAssessment(request, env, clientIp);
  const existingDeviceId = normalizedAccessValue('device', existingRecord?.deviceId);
  const incomingDeviceId = device.ok ? device.deviceId : '';
  if (existingDeviceId && !incomingDeviceId) {
    return privateJson({ error: 'This registered player requires device verification.', code: 'DEVICE_ATTESTATION_REQUIRED' }, 403, origin);
  }
  if (existingDeviceId && incomingDeviceId && existingDeviceId !== incomingDeviceId && !recovered) {
    return privateJson({ error: 'Device identity does not match this registered launcher.', code: 'DEVICE_IDENTITY_MISMATCH' }, 409, origin);
  }
  const existingAccess = await evaluateAccess(env, {
    username,
    minecraftUuid: existingMinecraftUuid || minecraftUuid,
    deviceId: existingDeviceId,
    ip: clientIp.ip,
    ipv4: clientIp.ipv4,
    network
  });
  if (!existingAccess.allowed) return accessDeniedResponse(existingAccess, origin);
  if (incomingDeviceId && incomingDeviceId !== existingDeviceId) {
    const incomingAccess = await evaluateAccess(env, {
      username,
      minecraftUuid: minecraftUuid || existingMinecraftUuid,
      deviceId: incomingDeviceId,
      ip: clientIp.ip,
      ipv4: clientIp.ipv4,
      network
    });
    if (!incomingAccess.allowed) return accessDeniedResponse(incomingAccess, origin);
  }
  const previousInstallIds = Array.isArray(existingRecord?.previousInstallIds) ? existingRecord.previousInstallIds : [];
  const incomingPlatform = normalizePlatform(body.platform);
  const existingPlatform = normalizePlatform(existingRecord?.platform);
  const record = {
    schemaVersion: 3,
    username: existingRecord?.username || username,
    normalizedUsername: username.toLowerCase(),
    minecraftUuid: minecraftUuid || existingMinecraftUuid,
    accountRecoveryVerifier: accountRecoveryVerifier || storedRecoveryVerifier,
    installId,
    deviceId: incomingDeviceId || existingDeviceId,
    devicePublicKey: device.ok ? device.publicKey : cleanString(existingRecord?.devicePublicKey || '', 1024),
    deviceBoundAt: incomingDeviceId && incomingDeviceId !== existingDeviceId ? now : existingRecord?.deviceBoundAt || now,
    packId: cleanString(body.packId || existingRecord?.packId || '', 120),
    appVersion: cleanString(body.appVersion || existingRecord?.appVersion || '', 80),
    platform: incomingPlatform || existingPlatform,
    platformRaw: cleanString(body.platform || existingRecord?.platformRaw || '', 80),
    arch: cleanString(body.arch || existingRecord?.arch || '', 40),
    createdAt: existingRecord?.createdAt || now,
    updatedAt: now,
    recoveredAt: recovered ? now : existingRecord?.recoveredAt || '',
    recoveryReason: recovered ? cleanString(body.recoveryReason || 'launcher-account-match', 80) : existingRecord?.recoveryReason || '',
    previousInstallIds: recovered ? [...new Set([...previousInstallIds, existingRecord.installId].filter(Boolean))].slice(-10) : previousInstallIds,
    ipv4: clientIp.available ? clientIp.ipv4 : cleanString(existingRecord?.ipv4 || '', 80),
    ip: clientIp.available ? clientIp.ip : normalizedConnectionIp(existingRecord?.ip || existingRecord?.ipv4),
    ipVersion: clientIp.available ? clientIp.ipVersion : Number(existingRecord?.ipVersion || 0),
    ipv4Source: clientIp.available ? clientIp.source : cleanString(existingRecord?.ipv4Source || 'unavailable', 80),
    ipv4Available: clientIp.available ? clientIp.ipv4Available : Boolean(existingRecord?.ipv4Available),
    pseudoIpv4: clientIp.available ? clientIp.pseudo : Boolean(existingRecord?.pseudoIpv4),
    userAgent: cleanString(request.headers.get('User-Agent') || '', 600),
    country: clientIp.available ? network.country : cleanString(existingRecord?.country || '', 8),
    asn: clientIp.available ? network.asn : Number(existingRecord?.asn || 0),
    asOrganization: clientIp.available ? network.organization : cleanString(existingRecord?.asOrganization || '', 160),
    colo: clientIp.available ? network.colo : cleanString(existingRecord?.colo || '', 16),
    network: clientIp.available ? network : (existingRecord?.network || network)
  };
  await env.AHT_DATA.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' }
  });
  await indexAccountIpv4(env, record);
  await indexAccountIdentity(env, record);
  await notifyLauncherServerState(env, recovered ? 'account-recovered' : 'account-registered');
  return privateJson({
    ok: true,
    username,
    minecraftUuid: record.minecraftUuid,
    recovered
  }, 200, origin);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\r\n/g, '\n').slice(0, maxLength);
}

function cleanUrl(value, maxLength = 800) {
  const raw = cleanText(value, maxLength);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {}
  return '';
}

function cleanAssetObject(value, allowedTypes = []) {
  const source = value && typeof value === 'object' ? value : {};
  const url = cleanUrl(source.url || source.href || '');
  if (!url) return null;
  const type = cleanText(source.type || '', 24).toLowerCase();
  const safeType = allowedTypes.includes(type) ? type : '';
  return {
    ...(safeType ? { type: safeType } : {}),
    url,
    path: cleanText(source.path || '', 300),
    title: cleanText(source.title || '', 120)
  };
}

async function createLauncherProof(request, env, origin) {
  const rateLimited = await enforcePlayerApiRateLimit(request, env, 'proof', origin);
  if (rateLimited) return rateLimited;
  const body = await readBody(request, 32_768);
  if (JSON.stringify(body || {}).length > 32_768) {
    return privateJson({ error: 'Launcher attestation request is too large.' }, 413, origin);
  }
  const requestedProtocol = cleanString(body.protocol || '', 80);
  const v2Requested = requestedProtocol === LAUNCHER_ATTESTATION_PROTOCOL;
  const legacyV1Requested = !requestedProtocol || requestedProtocol === LEGACY_LAUNCHER_PROOF_PROTOCOL;
  if (!v2Requested && !legacyV1Requested) {
    return privateJson({ error: 'Unsupported launcher attestation protocol.' }, 400, origin);
  }
  const installId = cleanString(body.installId, 120);
  const minecraftUsername = normalizeMinecraftUsername(body.minecraftUsername);
  if (!installId) {
    return privateJson({ error: 'Install ID is required' }, 400, origin);
  }
  if (!/^[A-Za-z0-9_]{3,16}$/.test(minecraftUsername)) {
    return privateJson({ error: 'Minecraft username is required' }, 400, origin);
  }
  const requestedLauncherChannel = cleanString(body.launcherChannel || 'player', 32).toLowerCase();
  const developerModeRequested = Boolean(
    body.developerClient
    || body.developerClientBypass
    || body.modIntegrityBypass
    || requestedLauncherChannel === 'developer'
  );
  const developerAuthorized = developerModeRequested ? await verifyToken(request, env) : false;
  if (developerModeRequested && !developerAuthorized) {
    return privateJson({ error: 'Developer launcher proof requires developer authentication.' }, 401, origin);
  }
  const reportedLauncherVersion = cleanString(body.launcherVersion || '', 40);
  const reportedAppVersion = cleanString(body.appVersion || '', 40);
  if (v2Requested && (!parsedLauncherVersion(reportedLauncherVersion)
      || reportedLauncherVersion !== reportedAppVersion)) {
    return privateJson({
      error: 'Launcher version claims are missing or inconsistent.',
      code: 'LAUNCHER_VERSION_CLAIM_INVALID'
    }, 400, origin);
  }
  const currentLauncherVersion = v2Requested
    ? reportedLauncherVersion : cleanString(body.launcherVersion || body.appVersion || '', 40);
  let versionPolicy;
  try {
    versionPolicy = await launcherVersionPolicy(env);
  } catch {
    return privateJson({
      error: 'Launcher version policy is temporarily unavailable.',
      code: 'LAUNCHER_VERSION_POLICY_UNAVAILABLE'
    }, 503, origin);
  }
  if (!launcherVersionAccepted(currentLauncherVersion, versionPolicy)) {
    const failure = launcherVersionFailure(currentLauncherVersion, versionPolicy);
    return privateJson(failure, failure.status, origin);
  }
  const requestedMinecraftUuid = normalizeMinecraftUuid(body.minecraftUuid);
  const requestedDeviceId = cleanString(body.deviceId || '', 80).toLowerCase();
  const device = await verifyDeviceAssertion(body, 'launcher-proof', {
    protocol: requestedProtocol || LEGACY_LAUNCHER_PROOF_PROTOCOL,
    launchId: cleanString(body.launchId || '', 80),
    minecraftUsername: minecraftUsername.toLowerCase(),
    minecraftUuid: requestedMinecraftUuid,
    installId,
    instanceDirHash: cleanString(body.instanceDirHash || '', 80),
    launcherVersion: currentLauncherVersion,
    deviceId: requestedDeviceId
  });
  // A v2 proof is authoritative only when the claimed launcher version is
  // covered by a fresh device signature. Never issue a v2 token from a bare
  // client version string, even during account-registration compatibility.
  if (v2Requested && !device.ok) {
    return privateJson({ error: device.error, code: 'DEVICE_ATTESTATION_REQUIRED' }, 403, origin);
  }
  let existingRecord = null;
  let accountBindingRefreshRequired = false;
  if (!developerAuthorized && v2Requested && !env.AHT_DATA) {
    return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  if (env.AHT_DATA && !developerAuthorized) {
    const existing = await env.AHT_DATA.get(minecraftUsernameKey(minecraftUsername));
    existingRecord = existing ? await existing.json().catch(() => null) : null;
    if (!existingRecord || existingRecord.installId !== installId) {
      return privateJson({ error: 'Minecraft username is not registered to this launcher install.' }, 403, origin);
    }
    const registeredDeviceId = normalizedAccessValue('device', existingRecord.deviceId);
    if (registeredDeviceId && (!device.ok || device.deviceId !== registeredDeviceId)) {
      return privateJson({ error: 'Device identity does not match this registered launcher.', code: 'DEVICE_IDENTITY_MISMATCH' }, 403, origin);
    }
    accountBindingRefreshRequired = existingRecord.launcherStateBindingPending === true
      || Boolean(v2Requested && device.ok && !registeredDeviceId);
    if (v2Requested) {
      const recoverySecret = cleanString(request.headers.get('X-AHT-Launcher-Recovery') || '', 200);
      const recoveryVerifier = recoverySecret && /^[A-Za-z0-9_-]{32,200}$/.test(recoverySecret)
        ? await sha256Hex(recoverySecret)
        : '';
      const storedVerifier = cleanString(existingRecord.accountRecoveryVerifier || '', 80);
      const registeredMinecraftUuid = normalizeMinecraftUuid(existingRecord.minecraftUuid);
      if (!storedVerifier || !recoveryVerifier || !(await secureStringEqual(storedVerifier, recoveryVerifier)) || !registeredMinecraftUuid) {
        return privateJson({ error: 'Minecraft username is not registered to this launcher install with verified account recovery.' }, 403, origin);
      }
    }
  }

  const clientIp = requestIpv4(request);
  const network = await requestNetworkAssessment(request, env, clientIp);
  const access = await evaluateAccess(env, {
    username: minecraftUsername,
    minecraftUuid: developerAuthorized ? requestedMinecraftUuid : normalizeMinecraftUuid(existingRecord?.minecraftUuid),
    deviceId: device.ok ? device.deviceId : normalizedAccessValue('device', existingRecord?.deviceId),
    ip: clientIp.ip,
    ipv4: clientIp.ipv4,
    network
  });
  if (!access.allowed) return accessDeniedResponse(access, origin);

  if (existingRecord && !developerAuthorized) {
    const connectionAvailable = clientIp.available;
    existingRecord = {
      ...existingRecord,
      schemaVersion: Math.max(3, Number(existingRecord.schemaVersion || 0)),
      deviceId: device.ok ? device.deviceId : existingRecord.deviceId || '',
      devicePublicKey: device.ok ? device.publicKey : existingRecord.devicePublicKey || '',
      updatedAt: new Date().toISOString(),
      ipv4: connectionAvailable ? clientIp.ipv4 : cleanString(existingRecord.ipv4 || '', 80),
      ip: connectionAvailable ? clientIp.ip : normalizedConnectionIp(existingRecord.ip || existingRecord.ipv4),
      ipVersion: connectionAvailable ? clientIp.ipVersion : Number(existingRecord.ipVersion || 0),
      ipv4Source: connectionAvailable ? clientIp.source : cleanString(existingRecord.ipv4Source || 'unavailable', 80),
      ipv4Available: connectionAvailable ? clientIp.ipv4Available : Boolean(existingRecord.ipv4Available),
      pseudoIpv4: connectionAvailable ? clientIp.pseudo : Boolean(existingRecord.pseudoIpv4),
      country: connectionAvailable ? network.country : cleanString(existingRecord.country || '', 8),
      asn: connectionAvailable ? network.asn : Number(existingRecord.asn || 0),
      asOrganization: connectionAvailable ? network.organization : cleanString(existingRecord.asOrganization || '', 160),
      colo: connectionAvailable ? network.colo : cleanString(existingRecord.colo || '', 16),
      network: connectionAvailable ? network : (existingRecord.network || network)
    };
    existingRecord.launcherStateBindingPending = accountBindingRefreshRequired;
    await env.AHT_DATA.put(minecraftUsernameKey(minecraftUsername), JSON.stringify(existingRecord), {
      httpMetadata: { contentType: 'application/json' }
    });
    await indexAccountIpv4(env, existingRecord);
    await indexAccountIdentity(env, existingRecord);
    if (accountBindingRefreshRequired) {
      // The first device binding must reach the server snapshot before its proof
      // can be used. Persisting the pending bit makes a failed refresh retryable
      // instead of leaving an issued proof ahead of server policy.
      await notifyLauncherServerState(env, 'account-device-bound', true);
      existingRecord = { ...existingRecord, launcherStateBindingPending: false };
      await env.AHT_DATA.put(minecraftUsernameKey(minecraftUsername), JSON.stringify(existingRecord), {
        httpMetadata: { contentType: 'application/json' }
      });
    }
  }

  const issuedAtMs = Date.now();
  const launchId = v2Requested ? crypto.randomUUID() : cleanString(body.launchId || crypto.randomUUID(), 80);
  const minecraftUuid = developerAuthorized
    ? normalizeMinecraftUuid(body.minecraftUuid)
    : normalizeMinecraftUuid(existingRecord?.minecraftUuid);
  if (v2Requested && !minecraftUuid) {
    return privateJson({ error: 'A verified Minecraft UUID is required for launcher attestation.' }, 400, origin);
  }
  const payload = {
    protocol: v2Requested ? LAUNCHER_ATTESTATION_PROTOCOL : LEGACY_LAUNCHER_PROOF_PROTOCOL,
    schemaVersion: v2Requested ? 2 : 1,
    ...(v2Requested ? { jti: launchId } : {}),
    launchId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + LAUNCHER_ATTESTATION_TTL_MS).toISOString(),
    ...(v2Requested ? { reconnectExpiresAt: new Date(issuedAtMs + LAUNCHER_RECONNECT_TTL_MS).toISOString() } : {}),
    ...(v2Requested ? {
      issuer: LAUNCHER_ATTESTATION_ISSUER,
      audience: LAUNCHER_ATTESTATION_AUDIENCE
    } : {}),
    packId: cleanString(v2Requested
      ? (env.LAUNCHER_PROOF_PACK_ID || 'a-hard-time-dregora')
      : (body.packId || 'a-hard-time-dregora'), 80),
    packVersion: cleanString(body.packVersion || body.installedVersion || '', 80),
    latestVersion: cleanString(body.latestVersion || '', 80),
    installedVersion: cleanString(body.installedVersion || '', 80),
    minecraftUsername,
    ...(v2Requested ? { minecraftUuid } : {}),
    installId,
    deviceId: device.ok ? device.deviceId : normalizedAccessValue('device', existingRecord?.deviceId),
    appVersion: cleanString(body.appVersion, 40),
    launcherVersion: currentLauncherVersion,
    launcherVersionAuthority: v2Requested && device.ok
      ? 'worker-policy-matched-device-assertion' : 'legacy-client-claim',
    platform: cleanString(body.platform, 32),
    arch: cleanString(body.arch, 32),
    launcherChannel: developerAuthorized ? 'developer' : 'player',
    developerClient: developerAuthorized,
    developerClientBypass: developerAuthorized,
    modIntegrityBypass: developerAuthorized,
    accessGranted: true,
    networkStatus: network.status,
    instanceDirHash: cleanString(body.instanceDirHash, 80),
    minecraft: v2Requested ? null : (body.minecraft && typeof body.minecraft === 'object' ? body.minecraft : null)
  };
  return privateJson({
    protocol: payload.protocol,
    schemaVersion: payload.schemaVersion,
    trusted: true,
    source: 'worker',
    ...(await launcherProofToken(payload, env))
  }, 200, origin);
}

function socialStateKey(username) {
  return `${SOCIAL_STATE_PREFIX}${normalizeMinecraftUsername(username).toLowerCase()}.json`;
}

function socialActionKey(id) {
  return `${SOCIAL_ACTION_PREFIX}${id}.json`;
}

async function secureStringEqual(left, right) {
  const [aBuffer, bBuffer] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(left || ''))),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(right || '')))
  ]);
  const a = new Uint8Array(aBuffer);
  const b = new Uint8Array(bBuffer);
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

function parsedTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100000000000 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value || '').trim()) {
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function verifyLauncherProofRequest(request, env, options = {}) {
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (token.length > 8192) {
    return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)
      || parts[0].length > 1024 || parts[1].length > 6144 || parts[2].length > 1024) {
    return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
  }
  let header;
  let payload;
  try {
    header = decodeBase64UrlJson(parts[0]);
    payload = decodeBase64UrlJson(parts[1]);
  } catch {
    return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
  }
  if (JSON.stringify(header || {}).length > 512 || JSON.stringify(payload || {}).length > 4608) {
    return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
  }
  const v2 = payload?.protocol === LAUNCHER_ATTESTATION_PROTOCOL && payload?.schemaVersion === 2;
  const legacyV1 = payload?.protocol === LEGACY_LAUNCHER_PROOF_PROTOCOL && payload?.schemaVersion === 1;
  if (!v2 && !legacyV1) {
    return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
  }
  const signingInput = `${parts[0]}.${parts[1]}`;
  if (v2) {
    const configuredKeyId = cleanString(env.LAUNCHER_ATTESTATION_KEY_ID || LAUNCHER_ATTESTATION_KEY_ID, 120);
    if (!env.LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI || configuredKeyId !== LAUNCHER_ATTESTATION_KEY_ID) {
      return { ok: false, status: 503, error: 'AHT Proxy is temporarily unavailable.' };
    }
    if (header?.alg !== 'RS256'
        || header?.typ !== 'AHT-LAUNCHER-ATTESTATION'
        || header?.kid !== LAUNCHER_ATTESTATION_KEY_ID) {
      return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
    }
    let signatureValid = false;
    try {
      signatureValid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        await attestationPublicKey(env),
        decodeBase64UrlBytes(parts[2]),
        new TextEncoder().encode(signingInput)
      );
    } catch {
      return { ok: false, status: 503, error: 'Launcher attestation verification key is invalid.' };
    }
    if (!signatureValid) {
      return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
    }
  } else {
    const secret = env.LAUNCHER_PROOF_SECRET || env.AHT_LAUNCHER_PROOF_SECRET;
    if (!secret) return { ok: false, status: 503, error: 'AHT Proxy is temporarily unavailable.' };
    if (header?.alg !== 'HS256'
        || header?.typ !== 'AHT-LAUNCHER-PROOF'
        || header?.kid !== LEGACY_LAUNCHER_PROOF_KEY_ID) {
      return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
    }
    const expected = await hmac(signingInput, secret);
    if (!(await secureStringEqual(parts[2], expected))) {
      return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
    }
  }
  const now = Date.now();
  const issuedAt = parsedTime(payload.issuedAt);
  const expiresAt = parsedTime(payload.expiresAt);
  const reconnectExpiresAt = parsedTime(payload.reconnectExpiresAt);
  const username = normalizeMinecraftUsername(payload.minecraftUsername || payload.username);
  const installId = cleanString(payload.installId, 120);
  const expectedPackId = cleanString(env.LAUNCHER_PROOF_PACK_ID || 'a-hard-time-dregora', 80);
  const developerProof = cleanString(payload.launcherChannel || 'player', 32).toLowerCase() === 'developer'
    && payload.developerClient === true
    && payload.developerClientBypass === true
    && payload.modIntegrityBypass === true;
  const hasAnyDeveloperClaim = cleanString(payload.launcherChannel || 'player', 32).toLowerCase() === 'developer'
    || Boolean(payload.developerClient)
    || Boolean(payload.developerClientBypass)
    || Boolean(payload.modIntegrityBypass);
  const minecraftUuid = normalizeMinecraftUuid(payload.minecraftUuid);
  const deviceId = normalizedAccessValue('device', payload.deviceId);
  const currentLauncherVersion = cleanString(payload.launcherVersion || payload.appVersion || '', 40);
  const validLaunchId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanString(payload.launchId, 80));
  const v2ClaimsValid = !v2 || (
    payload.issuer === LAUNCHER_ATTESTATION_ISSUER
    && payload.audience === LAUNCHER_ATTESTATION_AUDIENCE
    && payload.jti === payload.launchId
    && validLaunchId
    && Boolean(minecraftUuid)
    && payload.accessGranted === true
    && payload.launcherVersionAuthority === 'worker-policy-matched-device-assertion'
    && cleanString(payload.appVersion || '', 40) === currentLauncherVersion
    && ['likely', 'not_detected', 'unknown'].includes(cleanString(payload.networkStatus, 20))
    && expiresAt - issuedAt <= LAUNCHER_ATTESTATION_TTL_MS
    && reconnectExpiresAt > expiresAt
    && reconnectExpiresAt > now
    && reconnectExpiresAt - issuedAt <= LAUNCHER_RECONNECT_TTL_MS
  );
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username) || !installId
      || cleanString(payload.packId, 80) !== expectedPackId
      || !issuedAt || !expiresAt || expiresAt <= issuedAt || (!v2 && expiresAt <= now) || issuedAt > now + 120000
      || (hasAnyDeveloperClaim && !developerProof)
      || !v2ClaimsValid) {
    return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
  }
  let versionPolicy = options.skipVersionPolicy === true
    ? { necessaryLauncherVersion: currentLauncherVersion, source: 'in-memory-self-test' }
    : null;
  if (!versionPolicy) {
    try {
      versionPolicy = await launcherVersionPolicy(env);
    } catch {
      return {
        ok: false,
        status: 503,
        code: 'LAUNCHER_VERSION_POLICY_UNAVAILABLE',
        error: 'Launcher version policy is temporarily unavailable.'
      };
    }
  }
  if (!launcherVersionAccepted(currentLauncherVersion, versionPolicy)) {
    return launcherVersionFailure(currentLauncherVersion, versionPolicy);
  }
  if (env.AHT_DATA && !developerProof) {
    const registration = await env.AHT_DATA.get(minecraftUsernameKey(username));
    const record = registration ? await registration.json().catch(() => null) : null;
    const registeredDeviceId = normalizedAccessValue('device', record?.deviceId);
    if (!record || record.installId !== installId
        || (v2 && normalizeMinecraftUuid(record.minecraftUuid) !== minecraftUuid)
        || (registeredDeviceId && registeredDeviceId !== deviceId)) {
      return { ok: false, status: 403, error: 'This Minecraft username is not registered to this launcher install.' };
    }
    const access = await evaluateAccess(env, {
      username,
      minecraftUuid,
      deviceId: registeredDeviceId || deviceId,
      ip: normalizedConnectionIp(record.ip || record.ipv4),
      ipv4: nativeIpv4FromRecord(record),
      network: record.network || null
    });
    if (!access.allowed) {
      return { ok: false, status: 403, error: 'Access to A Hard Time is restricted for this account or device.' };
    }
  }
  return {
    ok: true,
    payload: { ...payload, minecraftUsername: username, ...(v2 ? { minecraftUuid } : {}), installId, deviceId },
    policy: {
      currentLauncherVersion,
      necessaryLauncherVersion: versionPolicy.necessaryLauncherVersion,
      source: versionPolicy.source
    }
  };
}

async function verifyLauncherProofEndpoint(request, env, origin) {
  const rateLimited = await enforceProofVerifyRateLimit(request, env, origin);
  if (rateLimited) return rateLimited;
  const verified = await verifyLauncherProofRequest(request, env);
  if (!verified.ok) {
    return privateJson({
      ok: false,
      valid: false,
      accessGranted: false,
      code: cleanString(verified.code || '', 80),
      error: verified.error,
      ...(verified.currentLauncherVersion ? { currentLauncherVersion: verified.currentLauncherVersion } : {}),
      ...(verified.necessaryLauncherVersion ? { necessaryLauncherVersion: verified.necessaryLauncherVersion } : {})
    }, verified.status, origin);
  }
  const payload = verified.payload || {};
  const policy = verified.policy || {};
  return privateJson({
    ok: true,
    valid: true,
    accessGranted: true,
    session: {
      protocol: cleanString(payload.protocol, 80),
      launchId: cleanString(payload.launchId, 80),
      minecraftUsername: normalizeMinecraftUsername(payload.minecraftUsername),
      minecraftUuid: normalizeMinecraftUuid(payload.minecraftUuid),
      installId: cleanString(payload.installId, 120),
      deviceId: normalizedAccessValue('device', payload.deviceId),
      packId: cleanString(payload.packId, 80),
      launcherVersion: cleanString(payload.launcherVersion, 40),
      launcherChannel: cleanString(payload.launcherChannel || 'player', 32),
      issuedAt: cleanString(payload.issuedAt, 80),
      expiresAt: cleanString(payload.expiresAt, 80),
      reconnectExpiresAt: cleanString(payload.reconnectExpiresAt, 80)
    },
    policy: {
      currentLauncherVersion: cleanString(policy.currentLauncherVersion, 40),
      necessaryLauncherVersion: cleanString(policy.necessaryLauncherVersion, 40),
      source: cleanString(policy.source, 80)
    }
  }, 200, origin);
}

async function readRawBody(request, maxBytes = 1024 * 1024) {
  const rawLength = String(request.headers.get('Content-Length') || '').trim();
  if (rawLength && !/^\d+$/.test(rawLength)) {
    throw new RequestPayloadError(400, 'Content-Length is invalid.');
  }
  if (rawLength && Number(rawLength) > maxBytes) {
    throw new RequestPayloadError(413, 'Request body is too large.');
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('request body limit exceeded').catch(() => {});
        throw new RequestPayloadError(413, 'Request body is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return text;
}

async function verifyServerSocialRequest(request, env, bodyText) {
  const secret = env.AHT_SOCIAL_SERVER_SECRET;
  if (String(secret || '').length < 32) return false;
  const timestamp = request.headers.get('X-AHT-Server-Timestamp') || '';
  const signature = request.headers.get('X-AHT-Server-Signature') || '';
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 90000 || !signature) {
    return false;
  }
  const url = new URL(request.url);
  const target = `${url.pathname}${url.search}`;
  const bodyHash = await sha256Hex(bodyText);
  const signingInput = `${request.method.toUpperCase()}\n${target}\n${timestamp}\n${bodyHash}`;
  const expected = await hmac(signingInput, secret);
  return secureStringEqual(signature, expected);
}

function normalizeSocialRows(value, includeOnline = false) {
  const rows = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const raw = typeof item === 'string' ? item : item?.username || item?.name;
    const username = normalizeMinecraftUsername(raw);
    const key = username.toLowerCase();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username) || seen.has(key)) continue;
    seen.add(key);
    if (!includeOnline) {
      rows.push({ username });
      continue;
    }
    const row = { username, online: Boolean(item?.online) };
    const server = cleanString(item?.server || item?.serverName || item?.networkServer, 64);
    const onlineSince = cleanString(item?.onlineSince || item?.onlineSinceAt, 40);
    const lastSeenAt = cleanString(item?.lastSeenAt || item?.lastSeen, 40);
    if (server) row.server = server;
    if (onlineSince) row.onlineSince = onlineSince;
    if (lastSeenAt) row.lastSeenAt = lastSeenAt;
    rows.push(row);
  }
  rows.sort((left, right) => includeOnline
    ? Number(right.online) - Number(left.online) || left.username.localeCompare(right.username)
    : left.username.localeCompare(right.username));
  return rows.slice(0, 1000);
}

function normalizeServerSocialSnapshot(value) {
  const username = normalizeMinecraftUsername(value?.username);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return null;
  const friends = normalizeSocialRows(value?.friends, true);
  const requests = normalizeSocialRows(value?.requests, true);
  return {
    schemaVersion: 1,
    username,
    updatedAt: cleanString(value?.updatedAt || new Date().toISOString(), 80),
    counts: {
      friends: friends.length,
      online: friends.filter((friend) => friend.online).length,
      requests: requests.length
    },
    friends,
    requests
  };
}

function allowedSocialServerIds(env) {
  const configured = cleanString(
    env.AHT_SOCIAL_SERVER_IDS || env.AHT_SOCIAL_SERVER_ID || 'aht-linux', 512
  );
  return new Set(configured.split(',').map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9][a-z0-9._-]{1,63}$/.test(value)));
}

function launcherSocialView(state) {
  if (!state || typeof state !== 'object') return null;
  const view = { ...state };
  delete view.blockedPlayers;
  delete view.blocked;
  if (view.counts && typeof view.counts === 'object') {
    view.counts = { ...view.counts };
    delete view.counts.blocked;
  }
  return view;
}

function mergeSocialPresence(previous, next) {
  if (!previous || !Array.isArray(previous.friends)) return next;
  const previousByUsername = new Map(previous.friends.map((friend) => [
    String(friend?.username || '').toLowerCase(), friend
  ]));
  return {
    ...next,
    friends: next.friends.map((friend) => {
      const old = previousByUsername.get(friend.username.toLowerCase());
      if (!old) return friend;
      const merged = { ...friend };
      if (friend.online && !friend.onlineSince && old.onlineSince) merged.onlineSince = old.onlineSince;
      if (!friend.online && !friend.lastSeenAt && old.lastSeenAt) merged.lastSeenAt = old.lastSeenAt;
      return merged;
    })
  };
}

async function readSocialState(env, username) {
  if (!env.AHT_DATA) return null;
  const object = await env.AHT_DATA.get(socialStateKey(username));
  return object ? object.json().catch(() => null) : null;
}

async function launcherSocialState(request, env, origin) {
  if (!env.AHT_DATA) return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  const verified = await verifyLauncherProofRequest(request, env);
  if (!verified.ok) return privateJson({ error: verified.error }, verified.status, origin);
  const username = verified.payload.minecraftUsername;
  const state = await readSocialState(env, username);
  if (!state) {
    return privateJson({
      available: true,
      actionsAvailable: true,
      username,
      updatedAt: '',
      counts: { friends: 0, online: 0, requests: 0 },
      friends: [],
      requests: [],
      message: 'Friends are syncing from the AHT server.'
    }, 200, origin);
  }
  return privateJson({ ...launcherSocialView(state), available: true, actionsAvailable: true }, 200, origin);
}

async function queueLauncherSocialAction(request, env, origin) {
  if (!env.AHT_DATA) return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  const verified = await verifyLauncherProofRequest(request, env);
  if (!verified.ok) return privateJson({ error: verified.error }, verified.status, origin);
  const body = await readBody(request, 8_192);
  const action = cleanString(body.action, 32).toLowerCase();
  const target = normalizeMinecraftUsername(body.target);
  const actor = verified.payload.minecraftUsername;
  if (!LAUNCHER_SOCIAL_ACTIONS.has(action)) {
    return privateJson({ error: 'That social action is unavailable from the launcher.' }, 400, origin);
  }
  if (!/^[A-Za-z0-9_]{3,16}$/.test(target)) {
    return privateJson({ error: 'Enter a valid Minecraft username.' }, 400, origin);
  }
  if (target.toLowerCase() === actor.toLowerCase()) {
    return privateJson({ error: 'Choose another player.' }, 400, origin);
  }
  const id = crypto.randomUUID();
  const record = {
    schemaVersion: 1,
    id,
    actor,
    action,
    target,
    createdAt: new Date().toISOString(),
    installIdHash: await sha256Hex(verified.payload.installId)
  };
  await env.AHT_DATA.put(socialActionKey(id), JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' }
  });
  const current = await readSocialState(env, actor);
  const label = action === 'accept_friend'
    ? 'Friend request acceptance queued.'
    : 'Friend request decline queued.';
  return privateJson({
    ok: true,
    queued: true,
    actionId: id,
    message: label,
    social: current ? { ...launcherSocialView(current), available: true, actionsAvailable: true } : null
  }, 202, origin);
}

async function pendingSocialActions(env, limit = 50) {
  const listed = await env.AHT_DATA.list({ prefix: SOCIAL_ACTION_PREFIX, limit: Math.max(1, limit) });
  const keys = (listed.objects || []).map((item) => item.key).sort().slice(0, limit);
  const actions = [];
  for (const key of keys) {
    const object = await env.AHT_DATA.get(key);
    const action = object ? await object.json().catch(() => null) : null;
    if (action?.id && LAUNCHER_SOCIAL_ACTIONS.has(action.action)) actions.push(action);
  }
  return actions;
}

async function synchronizeServerSocial(request, env, origin) {
  if (!env.AHT_DATA) return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  const bodyText = await readRawBody(request);
  if (!(await verifyServerSocialRequest(request, env, bodyText))) {
    return privateJson({ error: 'Server social authentication failed.' }, 401, origin);
  }
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return privateJson({ error: 'Invalid server social payload.' }, 400, origin);
  }
  const serverId = cleanString(body?.serverId, 64).toLowerCase();
  if (!serverId || !allowedSocialServerIds(env).has(serverId)) {
    return privateJson({ error: 'Social sync must come from the Linux AHT server.' }, 403, origin);
  }
  const snapshots = Array.isArray(body.snapshots) ? body.snapshots.slice(0, 250) : [];
  let storedSnapshots = 0;
  for (const candidate of snapshots) {
    const snapshot = normalizeServerSocialSnapshot(candidate);
    if (!snapshot) continue;
    const previous = await readSocialState(env, snapshot.username);
    const merged = mergeSocialPresence(previous, snapshot);
    await env.AHT_DATA.put(socialStateKey(snapshot.username), JSON.stringify(merged), {
      httpMetadata: { contentType: 'application/json' }
    });
    storedSnapshots += 1;
  }
  const acknowledgements = Array.isArray(body.acknowledgements)
    ? body.acknowledgements.slice(0, 250) : [];
  let acknowledged = 0;
  for (const acknowledgement of acknowledgements) {
    const id = cleanString(acknowledgement?.id, 120);
    if (!/^[A-Za-z0-9-]{16,120}$/.test(id)) continue;
    await env.AHT_DATA.delete(socialActionKey(id));
    acknowledged += 1;
  }
  return privateJson({
    ok: true,
    storedSnapshots,
    acknowledged,
    actions: await pendingSocialActions(env, 50),
    serverTime: new Date().toISOString()
  }, 200, origin);
}

async function listUpdateLogs(env, request, origin, requireAuth = false) {
  if (requireAuth && !(await verifyToken(request, env))) {
    return json({ error: 'Unauthorized' }, 401, origin);
  }
  if (!env.AHT_DATA) {
    return json({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const url = new URL(request.url);
  const limit = Math.max(0, Math.min(Number(url.searchParams.get('limit') || '3'), 50));
  if (limit === 0) {
    return json({ logs: [] }, 200, origin);
  }
  const listed = await env.AHT_DATA.list({ prefix: 'update-logs/', limit: 1000 });
  const objects = listed.objects.sort((a, b) => b.key.localeCompare(a.key)).slice(0, limit);
  const logs = [];
  for (const object of objects) {
    const item = await env.AHT_DATA.get(object.key);
    if (item) logs.push(await item.json());
  }
  return json({ logs }, 200, origin);
}

function updateLogLikePrefix(logId) {
  return `update-log-likes/${logId}/`;
}

function updateLogLikeKey(logId, deviceId) {
  return `${updateLogLikePrefix(logId)}${deviceId}.json`;
}

async function findUpdateLogObject(env, logId) {
  let cursor = '';
  do {
    const options = { prefix: 'update-logs/', limit: 1000 };
    if (cursor) options.cursor = cursor;
    const listed = await env.AHT_DATA.list(options);
    const match = (listed.objects || []).find((object) => object.key.endsWith(`-${logId}.json`));
    if (match) return match;
    if (!listed.truncated) return null;
    cursor = String(listed.cursor || '');
    if (!cursor) return null;
  } while (true);
}

async function countUpdateLogLikes(env, logId) {
  let total = 0;
  let cursor = '';
  do {
    const options = { prefix: updateLogLikePrefix(logId), limit: 1000 };
    if (cursor) options.cursor = cursor;
    const listed = await env.AHT_DATA.list(options);
    total += (listed.objects || []).length;
    if (!listed.truncated) return total;
    cursor = String(listed.cursor || '');
    if (!cursor) throw new Error('Update-log like listing stalled.');
  } while (true);
}

async function reconcileUpdateLogLikeCount(env, objectKey) {
  const idMatch = objectKey.match(/-([0-9a-f-]{36})\.json$/i);
  const logId = idMatch?.[1]?.toLowerCase() || '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const item = await env.AHT_DATA.get(objectKey);
    if (!item) return null;
    const log = await item.json().catch(() => null);
    if (!log) return null;
    const likes = await countUpdateLogLikes(env, logId);
    const updated = { ...log, likes };
    if (Number(log.likes || 0) === likes) return updated;
    const options = { httpMetadata: { contentType: 'application/json' } };
    if (item.etag) options.onlyIf = { etagMatches: item.etag };
    const stored = await env.AHT_DATA.put(objectKey, JSON.stringify(updated), options);
    // R2 returns null only when a conditional write loses a race. Test doubles
    // and older bindings may return undefined after a successful write.
    if (stored !== null) return updated;
  }
  return null;
}

async function likeUpdateLog(request, env, origin, routeLogId) {
  if (!env.AHT_DATA) {
    return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const rateLimited = await enforcePlayerApiRateLimit(request, env, 'news-like', origin);
  if (rateLimited) return rateLimited;
  const logId = cleanString(routeLogId || '', 40).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(logId)) {
    return privateJson({ error: 'That news article is not available.' }, 404, origin);
  }
  const body = await readBody(request, 16_384);
  const username = normalizeMinecraftUsername(body.username);
  const requestedDeviceId = cleanString(body.deviceId || '', 80).toLowerCase();
  const binding = {
    logId,
    username: username.toLowerCase(),
    deviceId: requestedDeviceId
  };
  if (cleanString(body.logId || '', 40).toLowerCase() !== logId || !/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    return privateJson({ error: 'The news like request is invalid.' }, 400, origin);
  }
  const device = await verifyDeviceAssertion(body, 'update-log-like', binding);
  if (!device.ok) {
    return privateJson({ error: device.error, code: 'DEVICE_ATTESTATION_REQUIRED' }, 403, origin);
  }
  const registrationItem = await env.AHT_DATA.get(minecraftUsernameKey(username));
  const registration = registrationItem ? await registrationItem.json().catch(() => null) : null;
  if (!registration
      || cleanString(registration.deviceId || '', 80).toLowerCase() !== device.deviceId
      || cleanString(registration.devicePublicKey || '', 1024) !== device.publicKey) {
    return privateJson({ error: 'This launcher device is not registered to that Minecraft account.' }, 403, origin);
  }
  const logObject = await findUpdateLogObject(env, logId);
  if (!logObject) return privateJson({ error: 'That news article is not available.' }, 404, origin);

  const likeKey = updateLogLikeKey(logId, device.deviceId);
  const existingLike = await env.AHT_DATA.head(likeKey);
  if (existingLike) {
    const item = await env.AHT_DATA.get(logObject.key);
    const log = item ? await item.json().catch(() => null) : null;
    return privateJson({
      ok: true,
      logId,
      liked: true,
      likes: Math.max(0, Number(log?.likes || 0))
    }, 200, origin);
  }
  const stored = await env.AHT_DATA.put(likeKey, JSON.stringify({
    schemaVersion: 1,
    logId,
    username,
    deviceId: device.deviceId,
    likedAt: new Date().toISOString()
  }), {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: { etagDoesNotMatch: '*' }
  });
  // A concurrent identical request can win this conditional write. Either
  // result still represents the same single per-device like object.
  if (stored === null && !(await env.AHT_DATA.head(likeKey))) {
    return privateJson({ error: 'The news like could not be saved.' }, 503, origin);
  }
  const updatedLog = await reconcileUpdateLogLikeCount(env, logObject.key);
  const likes = updatedLog ? Number(updatedLog.likes || 0) : await countUpdateLogLikes(env, logId);
  return privateJson({ ok: true, logId, liked: true, likes }, 200, origin);
}

async function publishUpdateLog(request, env, origin) {
  if (!(await verifyToken(request, env))) {
    return json({ error: 'Unauthorized' }, 401, origin);
  }
  if (!env.AHT_DATA) {
    return json({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const body = await readBody(request, 32_768);
  const title = cleanText(body.title, 120);
  const subtitle = cleanText(body.subtitle, 180);
  const text = cleanText(body.text || body.body, 8000);
  const version = cleanText(body.version, 40);
  const image = cleanAssetObject(body.image || { url: body.imageUrl, path: body.imagePath }, ['image']);
  const media = cleanAssetObject(body.media || {
    type: body.youtubeUrl ? 'youtube' : (body.videoUrl ? 'video' : ''),
    url: body.youtubeUrl || body.videoUrl,
    path: body.videoPath
  }, ['youtube', 'video']);
  if (!title) {
    return json({ error: 'Update log title is required' }, 400, origin);
  }
  if (!text) {
    return json({ error: 'Update log text is required' }, 400, origin);
  }
  const publishedAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const log = {
    id,
    title,
    subtitle,
    text,
    version,
    image,
    media,
    likes: 0,
    publishedAt,
    author: cleanText(body.author || 'admin', 80)
  };
  const safeTimestamp = publishedAt.replaceAll(':', '-');
  const key = `update-logs/${safeTimestamp}-${id}.json`;
  await env.AHT_DATA.put(key, JSON.stringify(log), {
    httpMetadata: { contentType: 'application/json' }
  });
  return json({ ok: true, key, log }, 200, origin);
}

function launcherTelemetryEventType(body = {}) {
  return cleanString(body?.event?.type || '', 80).toLowerCase();
}

async function validateCanonicalAccountForLauncherUpdate(env, body) {
  const username = normalizeMinecraftUsername(body.minecraftUsername);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    return { ok: false, status: 400, error: 'A registered Minecraft username is required for launcher update telemetry.' };
  }
  const installId = cleanString(body.installId || '', 200);
  if (!installId) {
    return { ok: false, status: 400, error: 'Install ID is required for launcher update telemetry.' };
  }
  const key = minecraftUsernameKey(username);
  const item = await env.AHT_DATA.get(key);
  const existing = item ? await item.json().catch(() => null) : null;
  if (!existing) {
    return { ok: false, status: 403, error: 'Launcher update identity does not match the registered player.' };
  }

  const suppliedMinecraftUuid = cleanString(body.minecraftUuid || body.mcUuid || '', 80);
  const incomingMinecraftUuid = normalizeMinecraftUuid(suppliedMinecraftUuid);
  const existingMinecraftUuid = normalizeMinecraftUuid(existing.minecraftUuid);
  if (suppliedMinecraftUuid && !incomingMinecraftUuid) {
    return { ok: false, status: 400, error: 'Minecraft UUID is invalid.' };
  }
  if (existingMinecraftUuid && incomingMinecraftUuid && existingMinecraftUuid !== incomingMinecraftUuid) {
    return { ok: false, status: 409, error: 'Minecraft UUID does not match this registered player.' };
  }
  const installMatches = cleanString(existing.installId || '', 200) === installId;
  // Telemetry is not an account-recovery authority. A public Minecraft UUID is
  // not a secret and must never be enough to rotate the registered install ID.
  // Install changes go only through /api/users/register with the recovery
  // credential, UUID match, and (when bound) device assertion.
  if (!installMatches) {
    return { ok: false, status: 403, error: 'Launcher update identity does not match the registered player.' };
  }

  const launcherVersion = cleanString(body.appVersion || body.event?.toVersion || body.event?.version || '', 80);
  if (!launcherVersion) {
    return { ok: false, status: 400, error: 'Launcher version is required for launcher update telemetry.' };
  }
  // Keep telemetry history separate from the authoritative registration. The
  // registration/proof paths already refresh canonical IP, network, platform,
  // and version data after stronger recovery/device checks.
  return { ok: true, key, record: existing };
}

async function recordLauncherUpdate(env, body, account, clientIp, receivedAt) {
  const launcherVersion = cleanString(body.appVersion || body.event?.toVersion || body.event?.version || '', 80);
  if (!launcherVersion) {
    return { ok: false, status: 400, error: 'Launcher version is required for launcher update telemetry.' };
  }
  const updateId = (await sha256Hex([
    String(account.normalizedUsername || account.username || '').toLowerCase(),
    String(account.installId || ''),
    launcherVersion
  ].join('\0'))).slice(0, 40);
  const key = `${LAUNCHER_UPDATE_PREFIX}${updateId}.json`;
  const previousItem = await env.AHT_DATA.get(key);
  const previous = previousItem ? await previousItem.json().catch(() => null) : null;
  const record = {
    schemaVersion: 1,
    type: 'launcher_update_completed',
    updateId,
    receivedAt: previous?.receivedAt || receivedAt,
    lastReceivedAt: receivedAt,
    minecraftUsername: cleanString(account.username || body.minecraftUsername || '', 16),
    minecraftUuid: normalizeMinecraftUuid(account.minecraftUuid),
    ip: clientIp.ip,
    ipVersion: clientIp.ipVersion,
    ipv4: clientIp.ipv4,
    ipv4Source: clientIp.source,
    ipv4Available: clientIp.ipv4Available,
    pseudoIpv4: clientIp.pseudo,
    platform: normalizePlatform(body.platform || account.platform),
    launcherVersion,
    previousLauncherVersion: cleanString(body.event?.fromVersion || body.event?.previousVersion || '', 80)
  };
  await env.AHT_DATA.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' }
  });
  return { ok: true, key, record };
}

async function writeEvent(request, env, origin) {
  if (!env.AHT_DATA) {
    return json({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const rateLimited = await enforcePlayerApiRateLimit(request, env, 'events', origin);
  if (rateLimited) return rateLimited;
  if (env.LAUNCHER_WRITE_TOKEN) {
    const header = request.headers.get('Authorization') || '';
    if (!(await secureStringEqual(header, `Bearer ${env.LAUNCHER_WRITE_TOKEN}`))) {
      return json({ error: 'Unauthorized' }, 401, origin);
    }
  }
  const body = await readBody(request, 262_144);
  const receivedAt = new Date().toISOString();
  const day = receivedAt.slice(0, 10);
  const clientIp = requestIpv4(request);
  let accountRefresh = null;
  let launcherUpdate = null;
  if (launcherTelemetryEventType(body) === 'launcher_update_completed') {
    accountRefresh = await validateCanonicalAccountForLauncherUpdate(env, body);
    if (!accountRefresh.ok) {
      return privateJson({ error: accountRefresh.error }, accountRefresh.status, origin);
    }
    launcherUpdate = await recordLauncherUpdate(env, body, accountRefresh.record, clientIp, receivedAt);
    if (!launcherUpdate.ok) {
      return privateJson({ error: launcherUpdate.error }, launcherUpdate.status, origin);
    }
  }
  const record = {
    ...body,
    minecraftUuid: normalizeMinecraftUuid(body.minecraftUuid || body.mcUuid),
    platform: normalizePlatform(body.platform),
    receivedAt,
    ipv4: clientIp.ipv4,
    ip: clientIp.ip,
    ipVersion: clientIp.ipVersion,
    ipv4Source: clientIp.source,
    ipv4Available: clientIp.ipv4Available,
    pseudoIpv4: clientIp.pseudo,
    userAgent: cleanString(request.headers.get('User-Agent') || '', 600),
    country: request.cf?.country || ''
  };
  const key = `telemetry/events/${day}/${receivedAt}-${crypto.randomUUID()}.json`;
  await env.AHT_DATA.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' }
  });
  return json({
    ok: true,
    launcherUpdateRecorded: Boolean(launcherUpdate?.key)
  }, 200, origin);
}

async function login(request, env, origin) {
  const body = await readBody(request, 4_096);
  try {
    adminTokenSecret(env);
  } catch {
    return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const submittedUsername = String(body.username || '');
  const submittedPassword = String(body.password || '');
  const credentialsBounded = submittedUsername.length <= 120 && submittedPassword.length <= 512;
  if (env.AHT_ADMIN_RATE_LIMITER?.limit) {
    let allowed = false;
    try {
      const connection = requestIpv4(request);
      const ipKey = connection.ip || 'unavailable';
      const result = await env.AHT_ADMIN_RATE_LIMITER.limit({
        key: `admin-login:${(await sha256Hex(ipKey)).slice(0, 40)}`
      });
      allowed = result?.success === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      const response = privateJson({ error: 'Too many admin login attempts. Try again later.' }, 429, origin);
      response.headers.set('Retry-After', '60');
      return response;
    }
  }
  const usernameOk = Boolean(credentialsBounded && submittedUsername && await secureStringEqual(submittedUsername, env.ADMIN_USERNAME));
  let passwordOk = false;
  if (env.ADMIN_PASSWORD_SHA256) {
    passwordOk = credentialsBounded && await secureStringEqual(await sha256Hex(submittedPassword), String(env.ADMIN_PASSWORD_SHA256 || '').toLowerCase());
  } else {
    passwordOk = Boolean(credentialsBounded && submittedPassword && await secureStringEqual(submittedPassword, env.ADMIN_PASSWORD));
  }
  if (!usernameOk || !passwordOk) {
    return privateJson({ error: 'Invalid username or password' }, 401, origin);
  }
  return privateJson(await createToken(body.username, env), 200, origin);
}

async function listEvents(env, request, origin) {
  if (!(await verifyToken(request, env))) {
    return json({ error: 'Unauthorized' }, 401, origin);
  }
  if (!env.AHT_DATA) {
    return json({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || '50'), 250));
  const day = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const listed = await env.AHT_DATA.list({ prefix: `telemetry/events/${day}/`, limit: 1000 });
  const objects = listed.objects.sort((a, b) => b.key.localeCompare(a.key)).slice(0, limit);
  const events = [];
  for (const object of objects) {
    const item = await env.AHT_DATA.get(object.key);
    if (item) events.push(await item.json());
  }
  return json({ events }, 200, origin);
}

async function readR2JsonObjects(env, objects = []) {
  const records = await Promise.all(objects.map(async (object) => {
    const item = await env.AHT_DATA.get(object.key);
    if (!item) return null;
    return item.json().catch(() => null);
  }));
  return records.filter(Boolean);
}

function launcherDownloadAdminRecord(item = {}) {
  const ipv4 = nativeIpv4FromRecord(item);
  const connectionIp = normalizedConnectionIp(item.ip || ipv4);
  const platform = normalizePlatform(item.platform || item.platformLabel || item.platformKey);
  const network = normalizedNetworkAssessment(item.network || {}, {
    asn: item.asn,
    organization: item.asOrganization,
    country: item.country,
    colo: item.colo
  });
  return {
    schemaVersion: Number(item.schemaVersion || 1),
    type: 'launcher_installer_download',
    downloadId: cleanString(item.downloadId || '', 120),
    receivedAt: cleanString(item.receivedAt || '', 80),
    minecraftUsername: cleanString(item.minecraftUsername || item.username || '', 16),
    minecraftUuid: normalizeMinecraftUuid(item.minecraftUuid),
    identitySource: cleanString(item.identitySource || '', 40),
    ipv4,
    ip: connectionIp,
    ipVersion: connectionIp.includes(':') ? 6 : (connectionIp ? 4 : 0),
    ipv4Source: ipv4
      ? cleanString(item.ipv4Source || 'legacy', 80)
      : cleanString(item.ipv4Source || (connectionIp.includes(':') ? 'cloudflare-connecting-ip' : 'unavailable'), 80),
    ipv4Available: Boolean(ipv4),
    pseudoIpv4: Boolean(item.pseudoIpv4),
    network,
    platform,
    platformLabel: platform,
    platformKey: cleanString(item.platformKey || '', 80),
    launcherVersion: cleanString(item.launcherVersion || '', 80),
    fileName: cleanString(item.fileName || '', 260)
  };
}

function launcherUpdateAdminRecord(item = {}) {
  const ipv4 = nativeIpv4FromRecord(item);
  const connectionIp = normalizedConnectionIp(item.ip || ipv4);
  return {
    type: 'launcher_update_completed',
    updateId: cleanString(item.updateId || '', 120),
    receivedAt: cleanString(item.receivedAt || item.lastReceivedAt || '', 80),
    minecraftUsername: cleanString(item.minecraftUsername || item.username || '', 16),
    minecraftUuid: normalizeMinecraftUuid(item.minecraftUuid),
    ip: connectionIp,
    ipv4,
    platform: normalizePlatform(item.platform),
    launcherVersion: cleanString(item.launcherVersion || item.appVersion || '', 80),
    previousLauncherVersion: cleanString(item.previousLauncherVersion || '', 80),
    source: cleanString(item.source || 'worker-event', 40)
  };
}

function launcherUpdateIdentity(item = {}) {
  const username = normalizeMinecraftUsername(item.minecraftUsername || item.username).toLowerCase();
  const version = cleanString(item.launcherVersion || item.appVersion || '', 80);
  if (username && version) return `${username}\0${version}`;
  return `id:${cleanString(item.updateId || '', 120)}`;
}

function canonicalAccountLauncherUpdate(item = {}) {
  if (isSyntheticReadinessAccount(item)) return null;
  const username = normalizeMinecraftUsername(item.username || item.minecraftUsername);
  const launcherVersion = cleanString(item.appVersion || item.launcherVersion || '', 80);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username) || !launcherVersion) return null;
  return {
    type: 'launcher_update_completed',
    updateId: `canonical-account-${username.toLowerCase()}-${launcherVersion}`,
    receivedAt: cleanString(item.updatedAt || item.createdAt || '', 80),
    minecraftUsername: username,
    minecraftUuid: normalizeMinecraftUuid(item.minecraftUuid),
    ip: normalizedConnectionIp(item.ip || item.ipv4),
    ipv4: nativeIpv4FromRecord(item),
    ipv4Source: cleanString(item.ipv4Source || '', 80),
    platform: normalizePlatform(item.platform),
    launcherVersion,
    previousLauncherVersion: '',
    source: 'canonical-account'
  };
}

async function readAllR2JsonObjects(env, prefix) {
  const records = [];
  let cursor = '';
  do {
    const options = { prefix, limit: 1000 };
    if (cursor) options.cursor = cursor;
    const listed = await env.AHT_DATA.list(options);
    records.push(...await readR2JsonObjects(env, listed.objects || []));
    const nextCursor = listed.truncated ? String(listed.cursor || '') : '';
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  } while (true);
  return records;
}

function isSyntheticReadinessAccount(item = {}) {
  return item.synthetic === true
    || item.recordKind === 'production-readiness-proof'
    || item.installId === 'aht-production-readiness-proof';
}

function decisionMatchesPlayer(decision = {}, item = {}) {
  if (decision.active !== true || decision.effect !== 'deny') return false;
  const values = {
    account: normalizeMinecraftUsername(item.username || item.minecraftUsername).toLowerCase(),
    minecraft_uuid: normalizeMinecraftUuid(item.minecraftUuid),
    device: normalizedAccessValue('device', item.deviceId),
    ip: normalizedConnectionIp(item.ip || item.ipv4),
    ipv4: nativeIpv4FromRecord(item)
  };
  return values[decision.scope] && values[decision.scope] === normalizedAccessValue(decision.scope, decision.value);
}

function playerAdminRecord(item = {}, decisions = []) {
  const ipv4 = nativeIpv4FromRecord(item);
  const connectionIp = normalizedConnectionIp(item.ip || ipv4);
  const activeDecisions = decisions.filter((decision) => decisionMatchesPlayer(decision, item));
  const network = normalizedNetworkAssessment(item.network || {}, {
    asn: item.asn,
    organization: item.asOrganization,
    country: item.country,
    colo: item.colo
  });
  return {
    receivedAt: cleanString(item.updatedAt || item.createdAt || '', 80),
    minecraftUsername: cleanString(item.username || item.minecraftUsername || '', 16),
    minecraftUuid: normalizeMinecraftUuid(item.minecraftUuid),
    deviceId: normalizedAccessValue('device', item.deviceId),
    ip: connectionIp,
    ipVersion: connectionIp.includes(':') ? 6 : (connectionIp ? 4 : 0),
    ipv4,
    platform: normalizePlatform(item.platform),
    launcherVersion: cleanString(item.appVersion || item.launcherVersion || '', 80),
    country: cleanString(item.country || '', 8),
    network,
    access: {
      allowed: activeDecisions.length === 0,
      activeScopes: [...new Set(activeDecisions.map((decision) => decision.scope))],
      decisionIds: activeDecisions.map((decision) => cleanString(decision.decisionId || '', 120))
    }
  };
}

async function listAccessDecisions(env, request, origin) {
  if (!(await verifyToken(request, env))) return privateJson({ error: 'Unauthorized' }, 401, origin);
  if (!env.AHT_DATA) return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  const params = new URL(request.url).searchParams;
  const activeOnly = params.get('active') === 'true';
  const includeHistory = params.get('history') === 'true';
  const [decisionObjects, auditObjects] = await Promise.all([
    readAllR2JsonObjects(env, ACCESS_DECISION_PREFIX),
    includeHistory ? readAllR2JsonObjects(env, ACCESS_AUDIT_PREFIX) : Promise.resolve([])
  ]);
  const decisions = decisionObjects
    .filter((item) => item && (!activeOnly || item.active === true))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, 2000);
  const audit = auditObjects
    .filter((item) => item?.decision && (!activeOnly || item.decision.active === true))
    .sort((left, right) => String(right.receivedAt || '').localeCompare(String(left.receivedAt || '')))
    .slice(0, 2000);
  return privateJson({
    decisions,
    audit,
    activeOnly,
    history: includeHistory,
    count: decisions.length,
    auditCount: audit.length
  }, 200, origin);
}

async function setAccessDecision(request, env, origin) {
  const session = await adminSession(request, env);
  if (!session) return privateJson({ error: 'Unauthorized' }, 401, origin);
  if (!env.AHT_DATA) return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  const body = await readBody(request, 8_192);
  const action = cleanString(body.action || '', 20).toLowerCase();
  const scope = cleanString(body.scope || '', 40).toLowerCase();
  const value = normalizedAccessValue(scope, body.value);
  const reason = cleanText(body.reason || '', 500);
  if (!['deny', 'allow'].includes(action) || !ACCESS_SCOPES.has(scope) || !value) {
    return privateJson({ error: 'A valid access action, scope, and value are required.' }, 400, origin);
  }
  if (action === 'deny' && reason.length < 3) {
    return privateJson({ error: 'A ban reason of at least 3 characters is required.' }, 400, origin);
  }
  const key = await accessDecisionKey(scope, value);
  const existingObject = await env.AHT_DATA.get(key);
  const existing = existingObject ? await existingObject.json().catch(() => null) : null;
  const now = new Date().toISOString();
  const decisionId = existing?.decisionId || (await sha256Hex(`${scope}\0${value}`)).slice(0, 40);
  const decision = {
    schemaVersion: 1,
    decisionId,
    scope,
    value,
    effect: action === 'deny' ? 'deny' : 'allow',
    active: action === 'deny',
    reason: reason || (action === 'allow' ? 'Access restored by administrator.' : ''),
    actor: cleanString(session.username || 'admin', 120),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await env.AHT_DATA.put(key, JSON.stringify(decision), {
    httpMetadata: { contentType: 'application/json' }
  });
  const audit = {
    schemaVersion: 1,
    type: 'access_decision_changed',
    auditId: crypto.randomUUID(),
    action,
    actor: decision.actor,
    decision,
    previous: existing || null,
    receivedAt: now
  };
  const auditKey = `${ACCESS_AUDIT_PREFIX}${now.replaceAll(':', '-')}-${audit.auditId}.json`;
  await env.AHT_DATA.put(auditKey, JSON.stringify(audit), {
    httpMetadata: { contentType: 'application/json' }
  });
  const launcherState = await notifyLauncherServerState(env, `access-${action}`);
  return privateJson({
    ok: true,
    decision,
    auditKey,
    launcherStateRevision: launcherState.revision || ''
  }, 200, origin);
}

async function listLauncherDownloads(env, request, origin) {
  if (!(await verifyToken(request, env))) {
    return privateJson({ error: 'Unauthorized' }, 401, origin);
  }
  if (!env.AHT_DATA) {
    return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || '250'), 250));
  const cursor = cleanString(url.searchParams.get('cursor') || '', 1000);
  const options = { prefix: LAUNCHER_DOWNLOAD_PREFIX, limit };
  if (cursor) options.cursor = cursor;
  const listed = await env.AHT_DATA.list(options);
  const downloads = (await readR2JsonObjects(env, listed.objects || []))
    .filter((item) => item.type === 'launcher_installer_download')
    .map(launcherDownloadAdminRecord)
    .sort((left, right) => String(right.receivedAt || '').localeCompare(String(left.receivedAt || '')));
  return privateJson({
    downloads,
    cursor: listed.truncated ? listed.cursor || '' : '',
    hasMore: Boolean(listed.truncated),
    appendOnly: true
  }, 200, origin);
}

async function listLauncherUpdates(env, request, origin) {
  if (!(await verifyToken(request, env))) {
    return privateJson({ error: 'Unauthorized' }, 401, origin);
  }
  if (!env.AHT_DATA) {
    return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || '250'), 250));
  const cursorText = cleanString(url.searchParams.get('cursor') || '', 40);
  const offset = /^\d+$/.test(cursorText) ? Number(cursorText) : 0;
  const dedicated = (await readAllR2JsonObjects(env, LAUNCHER_UPDATE_PREFIX))
    .filter((item) => item.type === 'launcher_update_completed')
    .map(launcherUpdateAdminRecord);
  const canonical = (await readAllR2JsonObjects(env, ACCOUNT_USERNAME_PREFIX))
    .map(canonicalAccountLauncherUpdate)
    .filter(Boolean);
  const merged = new Map();
  for (const update of dedicated) merged.set(launcherUpdateIdentity(update), update);
  for (const update of canonical) {
    const key = launcherUpdateIdentity(update);
    if (!merged.has(key)) merged.set(key, update);
  }
  const ordered = [...merged.values()].sort((left, right) => (
    String(right.receivedAt || '').localeCompare(String(left.receivedAt || ''))
      || String(right.minecraftUsername || '').localeCompare(String(left.minecraftUsername || ''))
  ));
  const updates = ordered.slice(offset, offset + limit);
  const nextOffset = offset + updates.length;
  const hasMore = nextOffset < ordered.length;
  return privateJson({
    updates,
    cursor: hasMore ? String(nextOffset) : '',
    hasMore,
    appendOnly: true
  }, 200, origin);
}

async function listPlayerRecords(env, request, origin) {
  if (!(await verifyToken(request, env))) {
    return privateJson({ error: 'Unauthorized' }, 401, origin);
  }
  if (!env.AHT_DATA) {
    return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || '250'), 250));
  const cursor = cleanString(url.searchParams.get('cursor') || '', 1000);
  const options = { prefix: ACCOUNT_USERNAME_PREFIX, limit };
  if (cursor) options.cursor = cursor;
  const listed = await env.AHT_DATA.list(options);
  const decisions = (await readAllR2JsonObjects(env, ACCESS_DECISION_PREFIX))
    .filter((item) => item?.active === true && item?.effect === 'deny');
  const players = (await readR2JsonObjects(env, listed.objects || []))
    .filter((item) => !isSyntheticReadinessAccount(item))
    .map((item) => playerAdminRecord(item, decisions))
    .filter((item) => item.minecraftUsername)
    .sort((left, right) => String(right.receivedAt || '').localeCompare(String(left.receivedAt || '')));
  return privateJson({
    players,
    cursor: listed.truncated ? listed.cursor || '' : '',
    hasMore: Boolean(listed.truncated),
    currentOnly: true
  }, 200, origin);
}

async function listAllR2Json(env, prefix) {
  const records = [];
  let cursor = '';
  const seenCursors = new Set();
  do {
    const options = { prefix, limit: 1000 };
    if (cursor) options.cursor = cursor;
    const listed = await env.AHT_DATA.list(options);
    records.push(...await readR2JsonObjects(env, listed.objects || []));
    if (!listed.truncated) break;
    const nextCursor = String(listed.cursor || '');
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (true);
  return records;
}

async function listPlayerIpv4Groups(env, request, origin) {
  if (!(await verifyToken(request, env))) {
    return privateJson({ error: 'Unauthorized' }, 401, origin);
  }
  if (!env.AHT_DATA) {
    return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const accounts = (await listAllR2Json(env, ACCOUNT_USERNAME_PREFIX))
    .filter((item) => !isSyntheticReadinessAccount(item));
  const groups = new Map();
  for (const account of accounts) {
    const ipv4 = nativeIpv4FromRecord(account);
    const username = cleanString(account.username || '', 16);
    if (!ipv4 || !username) continue;
    if (!groups.has(ipv4)) {
      groups.set(ipv4, {
        ipv4,
        ipv4Source: account.ipv4Source || 'legacy',
        pseudoIpv4: false,
        players: [],
        lastSeenAt: ''
      });
    }
    const group = groups.get(ipv4);
    if (!group.players.includes(username)) group.players.push(username);
    const seenAt = String(account.lastSeenAt || account.updatedAt || account.createdAt || '');
    if (seenAt > group.lastSeenAt) group.lastSeenAt = seenAt;
  }
  const result = [...groups.values()]
    .map((group) => ({
      ...group,
      players: group.players.sort((left, right) => left.localeCompare(right)),
      playerCount: group.players.length,
      shared: group.players.length > 1
    }))
    .sort((left, right) => right.playerCount - left.playerCount || right.lastSeenAt.localeCompare(left.lastSeenAt));
  return privateJson({
    groups: result,
    sharedGroups: result.filter((group) => group.shared),
    uniqueIpv4: result.length,
    sharedIpv4: result.filter((group) => group.shared).length,
    currentOnly: true
  }, 200, origin);
}

async function summary(env, request, origin) {
  if (!(await verifyToken(request, env))) {
    return json({ error: 'Unauthorized' }, 401, origin);
  }
  if (!env.AHT_DATA) {
    return json({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const day = new URL(request.url).searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const listed = await env.AHT_DATA.list({ prefix: `telemetry/events/${day}/`, limit: 1000 });
  const ips = new Set();
  const counts = { installs: 0, repairs: 0, changeReports: 0, failures: 0, uniqueIps: 0 };
  for (const object of listed.objects) {
    const item = await env.AHT_DATA.get(object.key);
    if (!item) continue;
    const event = await item.json();
    if (event.ip) ips.add(event.ip);
    const type = event.event?.type || '';
    if (type === 'install_completed') counts.installs += 1;
    if (type === 'repair_completed') counts.repairs += 1;
    if (type === 'local_changes') counts.changeReports += 1;
    if (type.endsWith('_failed')) counts.failures += 1;
  }
  counts.uniqueIps = ips.size;
  return json({ date: day, counts }, 200, origin);
}

export class LauncherStateHub {
  constructor(context, env) {
    this.context = context;
    this.env = env;
    this.refreshChain = Promise.resolve();
    this.downloadLimitChain = Promise.resolve();
  }

  async consumeLauncherInstallerDownload(requestKey = '') {
    const operation = this.downloadLimitChain.catch(() => {}).then(async () => {
      const now = Date.now();
      const storageKey = 'launcherInstallerDownloadWindow';
      const previous = await this.context.storage.get(storageKey);
      let firstDownloadAt = Number(previous?.firstDownloadAt);
      let count = Number(previous?.count);
      let recentDownloads = Array.isArray(previous?.recentDownloads)
        ? previous.recentDownloads
          .filter((item) => /^[a-f0-9]{64}$/i.test(String(item?.requestKey || ''))
            && Number.isFinite(Number(item?.consumedAt))
            && Number(item.consumedAt) <= now
            && now - Number(item.consumedAt) <= LAUNCHER_INSTALLER_DOWNLOAD_RETRY_GRACE_MS)
          .slice(-LAUNCHER_INSTALLER_DOWNLOAD_LIMIT)
        : [];
      const validWindow = previous?.policyEpoch === LAUNCHER_INSTALLER_DOWNLOAD_POLICY_EPOCH
        && Number.isFinite(firstDownloadAt)
        && firstDownloadAt > 0
        && firstDownloadAt <= now
        && Number.isInteger(count)
        && count >= 1
        && count <= LAUNCHER_INSTALLER_DOWNLOAD_LIMIT
        && now < firstDownloadAt + LAUNCHER_INSTALLER_DOWNLOAD_WINDOW_MS;
      if (!validWindow) {
        firstDownloadAt = now;
        count = 0;
        recentDownloads = [];
      }

      const resetAt = firstDownloadAt + LAUNCHER_INSTALLER_DOWNLOAD_WINDOW_MS;
      const repeated = recentDownloads.find((item) => item.requestKey === requestKey);
      if (repeated) {
        return {
          ok: true,
          counted: false,
          count,
          remaining: LAUNCHER_INSTALLER_DOWNLOAD_LIMIT - count,
          resetAt
        };
      }
      if (count >= LAUNCHER_INSTALLER_DOWNLOAD_LIMIT) {
        return {
          ok: false,
          code: 'LAUNCHER_INSTALLER_DOWNLOAD_LIMIT',
          count,
          remaining: 0,
          resetAt,
          retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000))
        };
      }

      const nextCount = count + 1;
      recentDownloads.push({ requestKey, consumedAt: now });
      await this.context.storage.put(storageKey, {
        schemaVersion: 3,
        policyEpoch: LAUNCHER_INSTALLER_DOWNLOAD_POLICY_EPOCH,
        firstDownloadAt,
        count: nextCount,
        recentDownloads: recentDownloads.slice(-LAUNCHER_INSTALLER_DOWNLOAD_LIMIT)
      });
      return {
        ok: true,
        counted: true,
        count: nextCount,
        remaining: LAUNCHER_INSTALLER_DOWNLOAD_LIMIT - nextCount,
        resetAt
      };
    });
    this.downloadLimitChain = operation;
    return operation;
  }

  async refreshState(reason = 'refresh') {
    const operation = this.refreshChain.catch(() => {}).then(async () => {
      const payload = await buildLauncherServerStatePayload(this.env);
      const previous = await this.context.storage.get('signedLauncherServerState');
      if (previous?.revision === payload.revision
          && typeof previous.token === 'string' && typeof previous.publicKeySpki === 'string') {
        return { state: previous, changed: false };
      }
      const state = {
        ...(await signLauncherServerState(payload, this.env)),
        reason: cleanString(reason || 'refresh', 80)
      };
      await this.context.storage.put('signedLauncherServerState', state);
      const message = launcherServerStateMessage(state);
      for (const socket of this.context.getWebSockets()) {
        try {
          socket.send(message);
        } catch {
          try { socket.close(1011, 'state delivery failed'); } catch {}
        }
      }
      return { state, changed: true };
    });
    this.refreshChain = operation;
    return operation;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === LAUNCHER_INSTALLER_DOWNLOAD_LIMIT_PATH) {
      if (request.headers.get(LAUNCHER_INSTALLER_DOWNLOAD_LIMIT_INTERNAL_HEADER) !== '1') {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const body = await request.json().catch(() => ({}));
      const requestKey = cleanString(body?.requestKey || '', 64).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(requestKey)) {
        return Response.json({ error: 'Invalid request' }, { status: 400 });
      }
      const result = await this.consumeLauncherInstallerDownload(requestKey);
      return Response.json(result, {
        status: result.ok ? 200 : 429,
        headers: {
          'Cache-Control': 'private, no-store',
          ...(result.ok ? {} : { 'Retry-After': String(result.retryAfterSeconds) })
        }
      });
    }
    if (request.method === 'POST' && url.pathname === '/refresh') {
      if (request.headers.get(LAUNCHER_SERVER_STATE_INTERNAL_HEADER) !== '1') {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const body = await readBody(request, 4096);
      const result = await this.refreshState(cleanString(body.reason || 'refresh', 80));
      return Response.json({
        ok: true,
        changed: result.changed,
        revision: result.state.revision
      });
    }
    if (request.method === 'GET' && url.pathname === '/connect') {
      if (request.headers.get(LAUNCHER_SERVER_STATE_AUTHORIZED_HEADER) !== '1') {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      if (String(request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('WebSocket upgrade required', { status: 426, headers: { Upgrade: 'websocket' } });
      }
      const result = await this.refreshState('server-connected');
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.context.acceptWebSocket(server);
      server.send(launcherServerStateMessage(result.state));
      return new Response(null, { status: 101, webSocket: client });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  async webSocketMessage(socket, message) {
    if (typeof message === 'string' && message === 'ping') {
      socket.send('pong');
    }
  }

  async webSocketClose(socket, code, reason) {
    try { socket.close(code, reason); } catch {}
  }

  async webSocketError(socket) {
    try { socket.close(1011, 'socket error'); } catch {}
  }
}

async function launcherServerStateWebSocket(request, env, origin) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== LAUNCHER_SERVER_STATE_PATH || url.search || url.hash) {
    return privateJson({ error: 'Not found' }, 404, origin);
  }
  if (String(request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('WebSocket upgrade required', {
      status: 426,
      headers: { ...corsHeaders(origin), Upgrade: 'websocket', 'Cache-Control': 'private, no-store' }
    });
  }
  const rateLimited = await enforceLauncherStateRateLimit(request, env, origin);
  if (rateLimited) return rateLimited;
  const configuredToken = String(env.AHT_LAUNCHER_STATE_SERVER_TOKEN || '');
  if (configuredToken.length < 32) {
    return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  }
  const authorization = request.headers.get('Authorization') || '';
  const suppliedToken = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim() : '';
  if (suppliedToken.length > 512 || !(await secureStringEqual(suppliedToken, configuredToken))) {
    return privateJson({ error: 'Launcher state server authentication failed.' }, 401, origin);
  }
  const stub = launcherServerStateStub(env);
  if (!stub) return privateJson({ error: 'AHT Proxy is temporarily unavailable.' }, 503, origin);
  const forwarded = new Request('https://aht-launcher-state.internal/connect', request);
  forwarded.headers.delete('Authorization');
  forwarded.headers.delete('Cookie');
  forwarded.headers.set(LAUNCHER_SERVER_STATE_AUTHORIZED_HEADER, '1');
  const userAgent = cleanString(request.headers.get('User-Agent') || '', 240);
  if (userAgent) forwarded.headers.set('User-Agent', userAgent);
  return stub.fetch(forwarded);
}

function isLauncherManifestQueueMessage(message) {
  const body = message?.body || {};
  return cleanString(body?.object?.key || body?.key || '', 512) === 'launcher/latest.json';
}

export default {
  async queue(batch, env) {
    const relevant = [];
    for (const message of batch?.messages || []) {
      if (isLauncherManifestQueueMessage(message)) relevant.push(message);
      else if (typeof message?.ack === 'function') message.ack();
    }
    if (!relevant.length) return;
    await notifyLauncherServerState(env, 'launcher-manifest-updated', true);
    for (const message of relevant) {
      if (typeof message?.ack === 'function') message.ack();
    }
  },

  async fetch(request, env, context) {
    const origin = request.headers.get('Origin') || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    try {
      const legacyLauncherManifest = await legacyLauncherUpdateManifestResponse(request, env, origin);
      if (legacyLauncherManifest) return legacyLauncherManifest;
      const brandedRedirect = legacyWorkersDevRedirect(request, env);
      if (brandedRedirect) return brandedRedirect;
      if (url.pathname === LAUNCHER_SERVER_STATE_PATH) {
        return await launcherServerStateWebSocket(request, env, origin);
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const releaseResponse = await serveReleaseObject(request, env, origin, context);
        if (releaseResponse) {
          return releaseResponse;
        }
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/launcher/download/')) {
        const platformKey = cleanString(url.pathname.slice('/launcher/download/'.length), 80);
        return await launcherInstallerDownload(request, env, origin, platformKey, context);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/cf/mods/')) {
        return await proxyCurseForge(url.pathname.slice('/cf'.length), env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/events') {
        return await writeEvent(request, env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/users/register') {
        return await registerUser(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/launcher-proof/status') {
        return await launcherProofStatus(env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/launcher-proof/public-key') {
        return await launcherProofPublicKey(env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/launcher-proof') {
        return await createLauncherProof(request, env, origin);
      }
      if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/api/launcher-proof/verify') {
        return await verifyLauncherProofEndpoint(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/social') {
        return await launcherSocialState(request, env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/social/actions') {
        return await queueLauncherSocialAction(request, env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/server/social/sync') {
        return await synchronizeServerSocial(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/update-logs') {
        return await listUpdateLogs(env, request, origin, false);
      }
      const updateLogLikeMatch = url.pathname.match(/^\/api\/update-logs\/([0-9a-f-]{36})\/like$/i);
      if (request.method === 'POST' && updateLogLikeMatch) {
        return await likeUpdateLog(request, env, origin, updateLogLikeMatch[1]);
      }
      if (request.method === 'POST' && url.pathname === '/admin/login') {
        return await login(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/update-logs') {
        return await listUpdateLogs(env, request, origin, true);
      }
      if (request.method === 'POST' && url.pathname === '/admin/update-logs') {
        return await publishUpdateLog(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/events') {
        return await listEvents(env, request, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/launcher-downloads') {
        return await listLauncherDownloads(env, request, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/launcher-updates') {
        return await listLauncherUpdates(env, request, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/player-records') {
        return await listPlayerRecords(env, request, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/player-ipv4-groups') {
        return await listPlayerIpv4Groups(env, request, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/access-decisions') {
        return await listAccessDecisions(env, request, origin);
      }
      if (request.method === 'POST' && url.pathname === '/admin/access-decisions') {
        return await setAccessDecision(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/summary') {
        return await summary(env, request, origin);
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
        return json({
          ok: true,
          service: 'AHT Proxy'
        }, 200, origin);
      }
      return privateJson({ error: 'Not found' }, 404, origin);
    } catch (error) {
      if (error instanceof RequestPayloadError) {
        return privateJson({ error: error.message }, error.status, origin);
      }
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({
        level: 'error',
        requestId,
        method: request.method,
        pathname: url.pathname,
        error: cleanString(error?.message || String(error), 1000)
      }));
      return privateJson({ error: 'AHT Proxy could not complete the request.' }, 500, origin);
    }
  }
};
