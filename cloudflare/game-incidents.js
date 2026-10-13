import { normalizeIncident, correlateIncidents } from '../src/gameIncidentContract.js';
const PREFIX = 'diagnostics/v1/';
const compactUuid = value => String(value || '').replaceAll('-', '').toLowerCase();
const validUuid = value => /^[a-f0-9]{32}$/.test(compactUuid(value)) && !/^0{32}$/.test(compactUuid(value));
async function slotFor(value) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return String(hash[0] % 32).padStart(2, '0');
}

export async function storeIncident(bucket, identity, source, supplied, now = Date.now()) {
  const event = normalizeIncident(supplied, now);
  if (!validUuid(identity.minecraftUuid) || !['client', 'backend', 'proxy'].includes(source)) throw new Error('Invalid identity.');
  const sessionId = event.launchId || event.connectionId;
  const key = `${PREFIX}${compactUuid(identity.minecraftUuid)}/${source}/${await slotFor(sessionId)}.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const previousObject = await bucket.get(key);
    const previous = previousObject ? await previousObject.json() : null;
    if (previous && !previousObject.etag) throw new Error('Conditional storage unavailable.');
    if (previous?.sessionId !== sessionId && previous?.lastEventAt > event.occurredAt) return { ok: true, retained: false };
    const events = previous?.sessionId === sessionId ? previous.events : [];
    if (events.some(item => item.id === event.id)) return { ok: true, retained: true };
    const nextEvents = [...events, event].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).slice(-32);
    const record = { schemaVersion: 1, source, sessionId, minecraftUuid: compactUuid(identity.minecraftUuid),
      minecraftUsername: /^[A-Za-z0-9_]{3,16}$/.test(identity.minecraftUsername || '') ? identity.minecraftUsername : '',
      launcherVersion: /^\d+\.\d+\.\d+$/.test(identity.launcherVersion || '') ? identity.launcherVersion : '',
      packVersion: /^\d+\.\d+\.\d+$/.test(identity.packVersion || '') ? identity.packVersion : '',
      lastEventAt: nextEvents.at(-1).occurredAt, receivedAt: new Date(now).toISOString(), events: nextEvents };
    const written = await bucket.put(key, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' },
      onlyIf: previousObject ? { etagMatches: previousObject.etag } : { etagDoesNotMatch: '*' } });
    if (written) return { ok: true, retained: true };
  }
  throw new Error('Incident changed concurrently.');
}

export async function gameIncidentEndpoint(request, env, origin, api) {
  const url = new URL(request.url); const client = url.pathname.startsWith('/api/');
  const server = url.pathname.startsWith('/server/');
  const reply = (body, status = 200) => api.privateJson(body, status, origin);
  if (request.method === 'POST') {
    if (client) {
      const limited = await api.rateLimit(request, env, 'game-incidents', origin);
      if (limited) return limited;
    } else if (!server || !await api.serverAuthorized(request, env)) return reply({ error: 'Unauthorized' }, 401);
    if (!env.AHT_DATA) return reply({ error: 'Service unavailable.' }, 503);
    let identity;
    if (client) {
      const verified = await api.verifyProof(request, env);
      if (!verified.ok) return reply({ error: 'Incident report rejected.' }, verified.status);
      identity = verified.payload;
      if (identity.launcherChannel !== 'player' || identity.developerClient || identity.schemaVersion !== 2)
        return reply({ error: 'Incident report rejected.' }, 403);
    }
    let body;
    try { body = await api.readBody(request, 8192); }
    catch { return reply({ error: 'Invalid incident.' }, 400); }
    if (client && body.launchId !== identity.launchId) return reply({ error: 'Invalid incident session.' }, 400);
    if (server) identity = { minecraftUuid: body.minecraftUuid, minecraftUsername: body.minecraftUsername };
    try {
      normalizeIncident(body);
      if (!validUuid(identity.minecraftUuid)) throw new Error();
      if (server && !['backend', 'proxy'].includes(body.source)) throw new Error();
    } catch { return reply({ error: 'Invalid incident.' }, 400); }
    try { return reply(await storeIncident(env.AHT_DATA, identity, client ? 'client' : body.source, body)); }
    catch { return reply({ error: 'Incident storage unavailable.' }, 503); }
  }
  if (request.method !== 'GET') return reply({ error: 'Method unavailable.' }, 405);
  if (!(server ? await api.serverAuthorized(request, env) : await api.adminAuthorized(request, env)))
    return reply({ error: 'Unauthorized' }, 401);
  if (!env.AHT_DATA) return reply({ error: 'Service unavailable.' }, 503);
  let playerUuid = url.searchParams.get('uuid') || '';
  const player = url.searchParams.get('player') || '';
  if (!playerUuid && /^[A-Za-z0-9_]{3,16}$/.test(player)) {
    const account = await env.AHT_DATA.get(`accounts/usernames/${player.toLowerCase()}.json`);
    playerUuid = account ? (await account.json()).minecraftUuid : '';
  }
  if (!validUuid(playerUuid)) return reply({ error: 'A valid player UUID or registered player is required.' }, 400);
  const cursor = url.searchParams.get('cursor') || undefined;
  if (cursor && cursor.length > 2048) return reply({ error: 'Invalid cursor.' }, 400);
  const listed = await env.AHT_DATA.list({ prefix: `${PREFIX}${compactUuid(playerUuid)}/`, limit: 24, ...(cursor ? { cursor } : {}) });
  const records = [];
  // At most 96 small objects. Four reads at a time avoid a subrequest burst.
  for (let index = 0; index < listed.objects.length; index += 4) {
    const page = await Promise.all(listed.objects.slice(index, index + 4).map(async item => {
      const object = await env.AHT_DATA.get(item.key); return object ? object.json() : null;
    }));
    records.push(...page.filter(Boolean));
  }
  return reply({ ...correlateIncidents(records), records, minecraftUuid: compactUuid(playerUuid),
    coveragePartial: Boolean(listed.truncated), cursor: listed.truncated ? listed.cursor : '' });
}
