const CURSEFORGE_BASE = 'https://api.curseforge.com/v1';
const RELEASE_PATHS = new Set([
  'latest.json',
  'release-report.json',
  'ptb/latest.json',
  'ptb/release-report.json',
  'launcher/latest.json'
]);
const RELEASE_PREFIXES = [
  'packs/',
  'cache/',
  'server/',
  'ptb/packs/',
  'ptb/cache/',
  'ptb/server/',
  'launcher/files/',
  'update-media/'
];
const LAUNCHER_SOCIAL_ACTIONS = new Set(['add_friend', 'remove_friend', 'unblock_player']);
const SOCIAL_ACTION_PREFIX = 'social/actions/';
const SOCIAL_STATE_PREFIX = 'social/state/';
const LAUNCHER_DOWNLOAD_KEYS = new Set(['windows-x64', 'macos-arm64', 'macos-x64']);
const LAUNCHER_DOWNLOAD_PREFIX = 'launcher-downloads/';
const ACCOUNT_USERNAME_PREFIX = 'accounts/usernames/';
const ACCOUNT_IPV4_PREFIX = 'accounts/ipv4/';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, X-AHT-Server-Timestamp, X-AHT-Server-Signature',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified',
    'Cache-Control': 'private, max-age=60'
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

function requestIpv4(request) {
  const connecting = request.headers.get('CF-Connecting-IP') || '';
  const connectingV6 = request.headers.get('CF-Connecting-IPv6') || '';
  const pseudo = request.headers.get('CF-Pseudo-IPv4') || '';
  const forwarded = request.headers.get('X-Forwarded-For') || '';
  const connectingIpv4 = ipv4FromHeader(connecting);
  if (connectingIpv4) {
    return {
      ipv4: connectingIpv4,
      source: connectingV6 ? 'cloudflare-pseudo' : 'cloudflare-connecting-ip',
      available: true,
      pseudo: Boolean(connectingV6)
    };
  }
  const pseudoIpv4 = ipv4FromHeader(pseudo);
  if (pseudoIpv4) {
    return { ipv4: pseudoIpv4, source: 'cloudflare-pseudo', available: true, pseudo: true };
  }
  const forwardedIpv4 = ipv4FromHeader(forwarded);
  if (forwardedIpv4) {
    return { ipv4: forwardedIpv4, source: 'forwarded-for', available: true, pseudo: false };
  }
  return {
    ipv4: '',
    source: connecting.includes(':') || connectingV6 ? 'ipv6-only' : 'unavailable',
    available: false,
    pseudo: false
  };
}

function launcherDownloadKey(receivedAt = new Date().toISOString(), id = crypto.randomUUID()) {
  const reverseTime = String(Number.MAX_SAFE_INTEGER - Date.parse(receivedAt)).padStart(16, '0');
  return `${LAUNCHER_DOWNLOAD_PREFIX}${reverseTime}-${id}.json`;
}

function isReleaseCandidatePath(pathname) {
  const trimmed = pathname.replace(/^\/+/, '');
  return RELEASE_PATHS.has(trimmed)
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
  if (RELEASE_PATHS.has(key) || RELEASE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return key;
  }
  return '';
}

function contentTypeForKey(key) {
  const lower = key.toLowerCase();
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
  headers['Content-Type'] = object.httpMetadata?.contentType || contentTypeForKey(key);
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
  return json({ error: 'Release object not found', key }, 404, origin);
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
    return json({ error: 'AHT_RELEASES R2 binding is not configured' }, 500, origin);
  }
  const key = safeReleaseKey(pathname);
  if (!key) {
    return json({ error: 'Invalid release path' }, 400, origin);
  }

  const rangeHeader = request.headers.get('Range') || '';
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
    object = await bucket.get(key);
  }

  if (!object) {
    return releaseNotFound(key, origin);
  }
  const installerDownloadKey = cleanString(requestUrl.searchParams.get('aht_download') || '', 80);
  if (method === 'GET' && LAUNCHER_DOWNLOAD_KEYS.has(installerDownloadKey) && key.startsWith('launcher/files/')) {
    const write = readLauncherManifest(env)
      .then((manifest) => {
        const artifact = manifest?.downloads?.[installerDownloadKey];
        const expectedKey = safeReleaseKey(`/${artifact?.path || ''}`);
        if (!artifact || expectedKey !== key) return null;
        return recordLauncherInstallerDownload(request, env, installerDownloadKey, manifest, artifact);
      })
      .catch((error) => console.error('launcher download telemetry failed', error));
    if (context?.waitUntil) context.waitUntil(write);
    else await write;
  }
  const headers = releaseHeaders(key, origin, object, range);
  return new Response(method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers });
}

async function readLauncherManifest(env) {
  const bucket = releaseBucket(env);
  if (!bucket) throw new Error('AHT_RELEASES R2 binding is not configured');
  const object = await bucket.get('launcher/latest.json');
  if (!object) throw new Error('Launcher update manifest is not available');
  return object.json();
}

async function recordLauncherInstallerDownload(request, env, platformKey, manifest, artifact) {
  if (!env.AHT_DATA) return null;
  const receivedAt = new Date().toISOString();
  const downloadId = crypto.randomUUID();
  const ip = requestIpv4(request);
  const record = {
    schemaVersion: 1,
    type: 'launcher_installer_download',
    downloadId,
    receivedAt,
    launcherVersion: cleanString(manifest?.version || '', 80),
    platformKey,
    platformLabel: cleanString(artifact?.label || platformKey, 120),
    fileName: cleanString(artifact?.fileName || '', 260),
    ipv4: ip.ipv4,
    ip: ip.ipv4,
    ipv4Source: ip.source,
    ipv4Available: ip.available,
    pseudoIpv4: ip.pseudo,
    country: request.cf?.country || '',
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
    return json({ error: 'Unknown launcher download platform' }, 404, origin);
  }
  const manifest = await readLauncherManifest(env);
  const artifact = manifest?.downloads?.[platformKey];
  const key = safeReleaseKey(`/${artifact?.path || ''}`);
  if (!artifact || !key || !key.startsWith('launcher/files/')) {
    return json({ error: `Launcher installer is not available for ${platformKey}` }, 404, origin);
  }
  const bucket = releaseBucket(env);
  const exists = typeof bucket.head === 'function' ? await bucket.head(key) : await bucket.get(key);
  if (!exists) return releaseNotFound(key, origin);

  if (request.method === 'GET') {
    const write = recordLauncherInstallerDownload(request, env, platformKey, manifest, artifact)
      .catch((error) => console.error('launcher download telemetry failed', error));
    if (context?.waitUntil) context.waitUntil(write);
    else await write;
  }

  const location = new URL(`/${key}`, request.url).toString();
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(origin),
      'Cache-Control': 'private, no-store',
      Location: location
    }
  });
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
  const secret = env.LAUNCHER_PROOF_SECRET || env.AHT_LAUNCHER_PROOF_SECRET || env.ADMIN_TOKEN_SECRET || env.ADMIN_PASSWORD;
  if (!secret) {
    throw new Error('LAUNCHER_PROOF_SECRET is not configured');
  }
  const header = { alg: 'HS256', typ: 'AHT-LAUNCHER-PROOF', kid: env.LAUNCHER_PROOF_KEY_ID || 'aht-launcher-proof-v1' };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmac(signingInput, secret);
  return {
    token: `${signingInput}.${signature}`,
    header,
    payload,
    signature: { alg: 'HS256', kid: header.kid, value: signature }
  };
}

async function createToken(username, env) {
  const expiresAt = Date.now() + 1000 * 60 * 60 * 12;
  const payload = base64UrlJson({ username, expiresAt });
  const signature = await hmac(payload, env.ADMIN_TOKEN_SECRET || env.ADMIN_PASSWORD || env.CURSEFORGE_API_KEY);
  return { token: `${payload}.${signature}`, expiresAt: new Date(expiresAt).toISOString() };
}

async function verifyToken(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = await hmac(payload, env.ADMIN_TOKEN_SECRET || env.ADMIN_PASSWORD || env.CURSEFORGE_API_KEY);
  if (signature !== expected) return false;
  const decoded = decodeBase64UrlJson(payload);
  return decoded.expiresAt > Date.now();
}

async function proxyCurseForge(pathname, env, origin) {
  if (!env.CURSEFORGE_API_KEY) {
    return json({ error: 'CURSEFORGE_API_KEY is not configured' }, 500, origin);
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

async function readBody(request) {
  const text = await request.text();
  if (text.length > 1024 * 1024) {
    throw new Error('Request body is too large');
  }
  return text ? JSON.parse(text) : {};
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

async function indexAccountIpv4(env, record) {
  const ipv4 = ipv4FromHeader(record.ipv4 || record.ip || '');
  const username = normalizeMinecraftUsername(record.username);
  if (!ipv4 || !username) return;
  const key = accountIpv4Key(ipv4, username);
  const existing = await env.AHT_DATA.get(key);
  const previous = existing ? await existing.json().catch(() => null) : null;
  await env.AHT_DATA.put(key, JSON.stringify({
    ipv4,
    username,
    normalizedUsername: username.toLowerCase(),
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
    return json({ error: 'AHT_DATA R2 binding is not configured' }, 500, origin);
  }
  const body = await readBody(request);
  const username = normalizeMinecraftUsername(body.username);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    return json({ error: 'Enter a valid Minecraft username.' }, 400, origin);
  }
  const installId = String(body.installId || '').trim();
  if (!installId) {
    return json({ error: 'Install ID is required' }, 400, origin);
  }

  const key = minecraftUsernameKey(username);
  const existing = await env.AHT_DATA.get(key);
  const existingRecord = existing ? await existing.json().catch(() => null) : null;
  const recoveryRequested = Boolean(body.recoverExistingUsername && body.minecraftAccountMatched);
  const recovered = Boolean(existingRecord && existingRecord.installId && existingRecord.installId !== installId && recoveryRequested);
  if (existingRecord && existingRecord.installId && existingRecord.installId !== installId && !recovered) {
    return json({ error: 'That username is not available.' }, 409, origin);
  }
  if (existing && !existingRecord) {
    return json({ error: 'That username is not available.' }, 409, origin);
  }

  const now = new Date().toISOString();
  const clientIp = requestIpv4(request);
  const previousInstallIds = Array.isArray(existingRecord?.previousInstallIds) ? existingRecord.previousInstallIds : [];
  const record = {
    username,
    normalizedUsername: username.toLowerCase(),
    installId,
    packId: body.packId || '',
    appVersion: body.appVersion || '',
    platform: body.platform || '',
    arch: body.arch || '',
    createdAt: existingRecord?.createdAt || now,
    updatedAt: now,
    recoveredAt: recovered ? now : existingRecord?.recoveredAt || '',
    recoveryReason: recovered ? cleanString(body.recoveryReason || 'launcher-account-match', 80) : existingRecord?.recoveryReason || '',
    previousInstallIds: recovered ? [...new Set([...previousInstallIds, existingRecord.installId].filter(Boolean))].slice(-10) : previousInstallIds,
    ipv4: clientIp.ipv4,
    ip: clientIp.ipv4,
    ipv4Source: clientIp.source,
    pseudoIpv4: clientIp.pseudo,
    userAgent: request.headers.get('User-Agent') || '',
    country: request.cf?.country || ''
  };
  await env.AHT_DATA.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' }
  });
  await indexAccountIpv4(env, record);
  return json({ ok: true, username, key, recovered }, 200, origin);
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
  const body = await readBody(request);
  const installId = cleanString(body.installId, 120);
  const minecraftUsername = normalizeMinecraftUsername(body.minecraftUsername);
  if (!installId) {
    return json({ error: 'Install ID is required' }, 400, origin);
  }
  if (!/^[A-Za-z0-9_]{3,16}$/.test(minecraftUsername)) {
    return json({ error: 'Minecraft username is required' }, 400, origin);
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
    return json({ error: 'Developer launcher proof requires developer authentication.' }, 401, origin);
  }
  if (env.AHT_DATA) {
    const existing = await env.AHT_DATA.get(minecraftUsernameKey(minecraftUsername));
    const existingRecord = existing ? await existing.json().catch(() => null) : null;
    if (!existingRecord || existingRecord.installId !== installId) {
      return json({ error: 'Minecraft username is not registered to this launcher install.' }, 403, origin);
    }
  }

  const issuedAtMs = Date.now();
  const payload = {
    protocol: 'aht-launcher-proof-v1',
    schemaVersion: 1,
    launchId: cleanString(body.launchId || crypto.randomUUID(), 80),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + 10 * 60 * 1000).toISOString(),
    packId: cleanString(body.packId || 'a-hard-time-dregora', 80),
    packVersion: cleanString(body.packVersion || body.installedVersion || '', 80),
    latestVersion: cleanString(body.latestVersion || '', 80),
    installedVersion: cleanString(body.installedVersion || body.packVersion || '', 80),
    minecraftUsername,
    installId,
    appVersion: cleanString(body.appVersion, 40),
    platform: cleanString(body.platform, 32),
    arch: cleanString(body.arch, 32),
    launcherChannel: developerAuthorized ? 'developer' : 'player',
    developerClient: developerAuthorized,
    developerClientBypass: developerAuthorized,
    modIntegrityBypass: developerAuthorized,
    instanceDirHash: cleanString(body.instanceDirHash, 80),
    minecraft: body.minecraft && typeof body.minecraft === 'object' ? body.minecraft : null
  };
  return json({
    protocol: payload.protocol,
    schemaVersion: 1,
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

function secureStringEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
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

async function verifyLauncherProofRequest(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
  }
  const secret = env.LAUNCHER_PROOF_SECRET || env.AHT_LAUNCHER_PROOF_SECRET
    || env.ADMIN_TOKEN_SECRET || env.ADMIN_PASSWORD;
  if (!secret) return { ok: false, status: 503, error: 'Launcher proof service is not configured.' };
  const expected = await hmac(`${parts[0]}.${parts[1]}`, secret);
  if (!secureStringEqual(parts[2], expected)) {
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
  if (String(header?.alg || '').toUpperCase() !== 'HS256'
      || payload?.protocol !== 'aht-launcher-proof-v1') {
    return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
  }
  const now = Date.now();
  const issuedAt = parsedTime(payload.issuedAt);
  const expiresAt = parsedTime(payload.expiresAt);
  const username = normalizeMinecraftUsername(payload.minecraftUsername || payload.username);
  const installId = cleanString(payload.installId, 120);
  const expectedPackId = cleanString(env.LAUNCHER_PROOF_PACK_ID || 'a-hard-time-dregora', 80);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username) || !installId
      || cleanString(payload.packId, 80) !== expectedPackId
      || !expiresAt || expiresAt <= now || issuedAt > now + 120000) {
    return { ok: false, status: 401, error: 'A valid AHT Launcher session is required.' };
  }
  if (env.AHT_DATA) {
    const registration = await env.AHT_DATA.get(minecraftUsernameKey(username));
    const record = registration ? await registration.json().catch(() => null) : null;
    if (!record || record.installId !== installId) {
      return { ok: false, status: 403, error: 'This Minecraft username is not registered to this launcher install.' };
    }
  }
  return { ok: true, payload: { ...payload, minecraftUsername: username, installId } };
}

async function readRawBody(request, maxBytes = 1024 * 1024) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error('Request body is too large');
  }
  return text;
}

async function verifyServerSocialRequest(request, env, bodyText) {
  const secret = env.LAUNCHER_PROOF_SECRET || env.AHT_LAUNCHER_PROOF_SECRET
    || env.ADMIN_TOKEN_SECRET || env.ADMIN_PASSWORD;
  if (!secret) return false;
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
    rows.push(includeOnline ? { username, online: Boolean(item?.online) } : { username });
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
  const blockedPlayers = normalizeSocialRows(value?.blockedPlayers || value?.blocked, false);
  const requests = normalizeSocialRows(value?.requests, true);
  return {
    schemaVersion: 1,
    username,
    updatedAt: cleanString(value?.updatedAt || new Date().toISOString(), 80),
    counts: {
      friends: friends.length,
      online: friends.filter((friend) => friend.online).length,
      blocked: blockedPlayers.length
    },
    friends,
    blockedPlayers,
    requests
  };
}

async function readSocialState(env, username) {
  if (!env.AHT_DATA) return null;
  const object = await env.AHT_DATA.get(socialStateKey(username));
  return object ? object.json().catch(() => null) : null;
}

async function launcherSocialState(request, env, origin) {
  if (!env.AHT_DATA) return privateJson({ error: 'AHT_DATA R2 binding is not configured' }, 503, origin);
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
      counts: { friends: 0, online: 0, blocked: 0 },
      friends: [],
      blockedPlayers: [],
      requests: [],
      message: 'Friends are syncing from the AHT server.'
    }, 200, origin);
  }
  return privateJson({ ...state, available: true, actionsAvailable: true }, 200, origin);
}

async function queueLauncherSocialAction(request, env, origin) {
  if (!env.AHT_DATA) return privateJson({ error: 'AHT_DATA R2 binding is not configured' }, 503, origin);
  const verified = await verifyLauncherProofRequest(request, env);
  if (!verified.ok) return privateJson({ error: verified.error }, verified.status, origin);
  const body = await readBody(request);
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
  const label = action === 'add_friend' ? 'Friend request queued.'
    : action === 'remove_friend' ? 'Friend removal queued.' : 'Unblock queued.';
  return privateJson({
    ok: true,
    queued: true,
    actionId: id,
    message: label,
    social: current ? { ...current, available: true, actionsAvailable: true } : null
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
  if (!env.AHT_DATA) return privateJson({ error: 'AHT_DATA R2 binding is not configured' }, 503, origin);
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
  const snapshots = Array.isArray(body.snapshots) ? body.snapshots.slice(0, 250) : [];
  let storedSnapshots = 0;
  for (const candidate of snapshots) {
    const snapshot = normalizeServerSocialSnapshot(candidate);
    if (!snapshot) continue;
    await env.AHT_DATA.put(socialStateKey(snapshot.username), JSON.stringify(snapshot), {
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
  if (!env.AHT_DATA) {
    return json({ error: 'AHT_DATA R2 binding is not configured' }, 500, origin);
  }
  if (requireAuth && !(await verifyToken(request, env))) {
    return json({ error: 'Unauthorized' }, 401, origin);
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

async function publishUpdateLog(request, env, origin) {
  if (!env.AHT_DATA) {
    return json({ error: 'AHT_DATA R2 binding is not configured' }, 500, origin);
  }
  if (!(await verifyToken(request, env))) {
    return json({ error: 'Unauthorized' }, 401, origin);
  }
  const body = await readBody(request);
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

async function writeEvent(request, env, origin) {
  if (!env.AHT_DATA) {
    return json({ error: 'AHT_DATA R2 binding is not configured' }, 500, origin);
  }
  if (env.LAUNCHER_WRITE_TOKEN) {
    const header = request.headers.get('Authorization') || '';
    if (header !== `Bearer ${env.LAUNCHER_WRITE_TOKEN}`) {
      return json({ error: 'Unauthorized' }, 401, origin);
    }
  }
  const body = await readBody(request);
  const receivedAt = new Date().toISOString();
  const day = receivedAt.slice(0, 10);
  const clientIp = requestIpv4(request);
  const record = {
    ...body,
    receivedAt,
    ipv4: clientIp.ipv4,
    ip: clientIp.ipv4,
    ipv4Source: clientIp.source,
    pseudoIpv4: clientIp.pseudo,
    userAgent: request.headers.get('User-Agent') || '',
    country: request.cf?.country || ''
  };
  const key = `telemetry/events/${day}/${receivedAt}-${crypto.randomUUID()}.json`;
  await env.AHT_DATA.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' }
  });
  return json({ ok: true, key }, 200, origin);
}

async function login(request, env, origin) {
  const body = await readBody(request);
  const usernameOk = body.username && body.username === env.ADMIN_USERNAME;
  let passwordOk = false;
  if (env.ADMIN_PASSWORD_SHA256) {
    passwordOk = await sha256Hex(body.password || '') === env.ADMIN_PASSWORD_SHA256;
  } else {
    passwordOk = body.password && body.password === env.ADMIN_PASSWORD;
  }
  if (!usernameOk || !passwordOk) {
    return json({ error: 'Invalid username or password' }, 401, origin);
  }
  return json(await createToken(body.username, env), 200, origin);
}

async function listEvents(env, request, origin) {
  if (!env.AHT_DATA) {
    return json({ error: 'AHT_DATA R2 binding is not configured' }, 500, origin);
  }
  if (!(await verifyToken(request, env))) {
    return json({ error: 'Unauthorized' }, 401, origin);
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

async function listLauncherDownloads(env, request, origin) {
  if (!env.AHT_DATA) {
    return privateJson({ error: 'AHT_DATA R2 binding is not configured' }, 500, origin);
  }
  if (!(await verifyToken(request, env))) {
    return privateJson({ error: 'Unauthorized' }, 401, origin);
  }
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || '250'), 250));
  const cursor = cleanString(url.searchParams.get('cursor') || '', 1000);
  const options = { prefix: LAUNCHER_DOWNLOAD_PREFIX, limit };
  if (cursor) options.cursor = cursor;
  const listed = await env.AHT_DATA.list(options);
  const downloads = (await readR2JsonObjects(env, listed.objects || []))
    .filter((item) => item.type === 'launcher_installer_download')
    .sort((left, right) => String(right.receivedAt || '').localeCompare(String(left.receivedAt || '')));
  return privateJson({
    downloads,
    cursor: listed.truncated ? listed.cursor || '' : '',
    hasMore: Boolean(listed.truncated),
    appendOnly: true
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
  if (!env.AHT_DATA) {
    return privateJson({ error: 'AHT_DATA R2 binding is not configured' }, 500, origin);
  }
  if (!(await verifyToken(request, env))) {
    return privateJson({ error: 'Unauthorized' }, 401, origin);
  }
  const indexedAccounts = await listAllR2Json(env, ACCOUNT_IPV4_PREFIX);
  const legacyAccounts = await listAllR2Json(env, ACCOUNT_USERNAME_PREFIX);
  const accounts = [...indexedAccounts, ...legacyAccounts];
  const groups = new Map();
  for (const account of accounts) {
    const ipv4 = ipv4FromHeader(account.ipv4 || account.ip || '');
    const username = cleanString(account.username || '', 16);
    if (!ipv4 || !username) continue;
    if (!groups.has(ipv4)) {
      groups.set(ipv4, {
        ipv4,
        ipv4Source: account.ipv4Source || 'legacy',
        pseudoIpv4: Boolean(account.pseudoIpv4),
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
    sharedIpv4: result.filter((group) => group.shared).length
  }, 200, origin);
}

async function summary(env, request, origin) {
  if (!env.AHT_DATA) {
    return json({ error: 'AHT_DATA R2 binding is not configured' }, 500, origin);
  }
  if (!(await verifyToken(request, env))) {
    return json({ error: 'Unauthorized' }, 401, origin);
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

export default {
  async fetch(request, env, context) {
    const origin = request.headers.get('Origin') || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    try {
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
      if (request.method === 'POST' && url.pathname === '/api/launcher-proof') {
        return await createLauncherProof(request, env, origin);
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
      if (request.method === 'GET' && url.pathname === '/admin/player-ipv4-groups') {
        return await listPlayerIpv4Groups(env, request, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/summary') {
        return await summary(env, request, origin);
      }
      return json({
        ok: true,
        endpoints: [
          '/latest.json',
          '/packs/{packZip}',
          '/ptb/latest.json',
          '/ptb/packs/{packZip}',
          '/cache/mod-cache.json',
          '/cache/files/{sha256}.jar',
          '/server/{serverArtifact}',
          '/launcher/latest.json',
          '/launcher/files/{launcherArtifact}',
          '/launcher/download/{windows-x64|macos-arm64|macos-x64}',
          '/cf/mods/{projectId}/files/{fileId}',
          '/cf/mods/{projectId}/files/{fileId}/download-url',
          '/api/events',
          '/api/users/register',
          '/api/launcher-proof',
          '/api/social',
          '/api/social/actions',
          '/server/social/sync',
          '/api/update-logs',
          '/admin/login',
          '/admin/summary',
          '/admin/events',
          '/admin/launcher-downloads',
          '/admin/player-ipv4-groups',
          '/admin/update-logs'
        ]
      }, 200, origin);
    } catch (error) {
      return json({ error: error.message }, 500, origin);
    }
  }
};
