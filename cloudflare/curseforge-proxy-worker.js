const CURSEFORGE_BASE = 'https://api.curseforge.com/v1';
const RELEASE_PATHS = new Set(['latest.json', 'release-report.json', 'launcher/latest.json']);
const RELEASE_PREFIXES = ['packs/', 'cache/', 'server/', 'launcher/files/'];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'private, max-age=60'
  };
}

function json(value, status = 200, origin = '*') {
  return Response.json(value, { status, headers: corsHeaders(origin) });
}

function releaseBucket(env) {
  return env.AHT_RELEASES || env.AHT_DATA || null;
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
  if (key === 'latest.json' || key === 'release-report.json' || key === 'launcher/latest.json') {
    return 'public, max-age=60, must-revalidate';
  }
  return 'public, max-age=31536000, immutable';
}

function objectHttpDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toUTCString();
}

async function serveReleaseObject(pathname, env, origin, method = 'GET') {
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
  const object = await bucket.get(key);
  if (!object) {
    return json({ error: 'Release object not found', key }, 404, origin);
  }
  const headers = corsHeaders(origin);
  headers['Cache-Control'] = cacheControlForKey(key);
  headers['Content-Type'] = object.httpMetadata?.contentType || contentTypeForKey(key);
  if (object.httpEtag) headers.ETag = object.httpEtag;
  if (object.size !== undefined) headers['Content-Length'] = String(object.size);
  const lastModified = objectHttpDate(object.uploaded);
  if (lastModified) headers['Last-Modified'] = lastModified;
  return new Response(method === 'HEAD' ? null : object.body, { status: 200, headers });
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
  if (existingRecord && existingRecord.installId && existingRecord.installId !== installId) {
    return json({ error: 'That username is not available.' }, 409, origin);
  }
  if (existing && !existingRecord) {
    return json({ error: 'That username is not available.' }, 409, origin);
  }

  const now = new Date().toISOString();
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
    ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '',
    userAgent: request.headers.get('User-Agent') || '',
    country: request.cf?.country || ''
  };
  await env.AHT_DATA.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' }
  });
  return json({ ok: true, username, key }, 200, origin);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\r\n/g, '\n').slice(0, maxLength);
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
  const developerClientBypass = Boolean(body.developerClientBypass || body.modIntegrityBypass);
  const developerAuthorized = developerClientBypass ? await verifyToken(request, env) : false;
  if (developerClientBypass && !developerAuthorized) {
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
    launcherChannel: developerAuthorized ? 'developer' : cleanString(body.launcherChannel || 'player', 32),
    developerClient: developerAuthorized || Boolean(body.developerClient),
    developerClientBypass: developerAuthorized && developerClientBypass,
    modIntegrityBypass: developerAuthorized && developerClientBypass,
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
  const text = cleanText(body.text || body.body, 2000);
  const version = cleanText(body.version, 40);
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
    text,
    version,
    publishedAt,
    author: body.author || 'admin'
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
  const record = {
    ...body,
    receivedAt,
    ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '',
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
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const releaseResponse = await serveReleaseObject(url.pathname, env, origin, request.method);
        if (releaseResponse) {
          return releaseResponse;
        }
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
      if (request.method === 'GET' && url.pathname === '/admin/summary') {
        return await summary(env, request, origin);
      }
      return json({
        ok: true,
        endpoints: [
          '/latest.json',
          '/packs/{packZip}',
          '/cache/mod-cache.json',
          '/cache/files/{sha256}.jar',
          '/server/{serverArtifact}',
          '/launcher/latest.json',
          '/launcher/files/{launcherArtifact}',
          '/cf/mods/{projectId}/files/{fileId}',
          '/cf/mods/{projectId}/files/{fileId}/download-url',
          '/api/events',
          '/api/users/register',
          '/api/launcher-proof',
          '/api/update-logs',
          '/admin/login',
          '/admin/summary',
          '/admin/events',
          '/admin/update-logs'
        ]
      }, 200, origin);
    } catch (error) {
      return json({ error: error.message }, 500, origin);
    }
  }
};
