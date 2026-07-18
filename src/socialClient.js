const SOCIAL_ACTIONS = new Set(['add_friend', 'remove_friend', 'unblock_player']);

export function sanitizeMinecraftUsername(value = '') {
  const username = String(value || '').trim();
  return /^[A-Za-z0-9_]{3,16}$/.test(username) ? username : '';
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function workerBaseFromLatest(latestUrl = '') {
  try {
    const parsed = new URL(String(latestUrl || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function absoluteHttpUrl(value = '', base = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = base ? new URL(raw, base) : new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

export function socialEndpoints(config = {}, latest = null) {
  const fromLatest = latest?.social && typeof latest.social === 'object' ? latest.social : {};
  const fromConfig = config?.social && typeof config.social === 'object' ? config.social : {};
  const baseUrl = firstString(
    fromLatest.baseUrl,
    fromConfig.baseUrl,
    config.launcherProof?.baseUrl,
    config.sync?.baseUrl,
    workerBaseFromLatest(config.latestUrl)
  );
  return {
    enabled: fromLatest.enabled ?? fromConfig.enabled ?? true,
    stateUrl: absoluteHttpUrl(firstString(fromLatest.stateUrl, fromConfig.stateUrl, 'api/social'), baseUrl),
    actionUrl: absoluteHttpUrl(firstString(fromLatest.actionUrl, fromConfig.actionUrl, 'api/social/actions'), baseUrl)
  };
}

function listFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function usernameFrom(item) {
  if (typeof item === 'string') return sanitizeMinecraftUsername(item);
  return sanitizeMinecraftUsername(item?.username || item?.name || item?.player || '');
}

function normalizePeople(value, options = {}) {
  const people = [];
  const seen = new Set();
  for (const item of listFrom(value)) {
    const username = usernameFrom(item);
    const key = username.toLowerCase();
    if (!username || seen.has(key)) continue;
    seen.add(key);
    people.push(options.includeOnline
      ? { username, online: Boolean(item?.online), status: item?.online ? 'Online' : 'Offline' }
      : { username });
  }
  people.sort((left, right) => options.includeOnline
    ? Number(right.online) - Number(left.online) || left.username.localeCompare(right.username)
    : left.username.localeCompare(right.username));
  return people;
}

export function normalizeSocialState(raw = {}, options = {}) {
  const root = raw?.social && typeof raw.social === 'object' ? raw.social : raw;
  const friends = normalizePeople(root?.friends || root?.friendList, { includeOnline: true });
  const blocked = normalizePeople(root?.blockedPlayers || root?.blocked);
  const requests = normalizePeople(root?.requests || root?.incomingFriendRequests, { includeOnline: true });
  const available = options.available ?? root?.available ?? true;
  const actionsAvailable = options.actionsAvailable ?? root?.actionsAvailable ?? false;
  return {
    available: Boolean(available),
    actionsAvailable: Boolean(actionsAvailable),
    username: sanitizeMinecraftUsername(root?.username || options.username || ''),
    updatedAt: String(root?.updatedAt || options.updatedAt || ''),
    counts: {
      friends: Number(root?.counts?.friends) || friends.length,
      online: Number(root?.counts?.online) || friends.filter((friend) => friend.online).length,
      blocked: Number(root?.counts?.blocked) || blocked.length
    },
    friends,
    blocked,
    requests,
    message: String(root?.message || options.message || '')
  };
}

async function responseJson(response) {
  const text = await response.text().catch(() => '');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.trim() };
  }
}

function unavailable(username, message) {
  return normalizeSocialState({}, {
    available: false,
    actionsAvailable: false,
    username,
    message
  });
}

export async function fetchSocialState({
  config = {},
  latest = null,
  identity = {},
  proofToken = '',
  fetchImpl = globalThis.fetch
} = {}) {
  const username = sanitizeMinecraftUsername(identity.minecraftUsername || identity.username || '');
  if (!username) return unavailable('', 'Minecraft username is required before friends can load.');
  const endpoints = socialEndpoints(config, latest);
  if (endpoints.enabled === false) return unavailable(username, 'Friends are disabled for this launcher.');
  if (!endpoints.stateUrl || typeof fetchImpl !== 'function') {
    return unavailable(username, 'Friend service is not connected yet.');
  }
  if (!proofToken) {
    return unavailable(username, 'Open AHT through this launcher before loading friends.');
  }
  try {
    const response = await fetchImpl(endpoints.stateUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${proofToken}`
      }
    });
    const body = await responseJson(response);
    if (!response.ok) throw new Error(body.error || body.message || `${response.status} ${response.statusText}`);
    return normalizeSocialState(body, {
      available: true,
      actionsAvailable: Boolean(endpoints.actionUrl),
      username
    });
  } catch (error) {
    return unavailable(username, error.message || 'Friend service could not be read yet. Try Refresh in a moment.');
  }
}

export async function sendSocialAction({
  config = {},
  latest = null,
  identity = {},
  proofToken = '',
  action = '',
  target = '',
  fetchImpl = globalThis.fetch
} = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!SOCIAL_ACTIONS.has(normalizedAction)) {
    throw new Error('That friend action is not available from the launcher.');
  }
  const username = sanitizeMinecraftUsername(identity.minecraftUsername || identity.username || '');
  const targetUsername = sanitizeMinecraftUsername(target);
  if (!username) throw new Error('Minecraft username is required before friends can be updated.');
  if (!targetUsername) throw new Error('Enter a valid Minecraft username.');
  if (username.toLowerCase() === targetUsername.toLowerCase()) throw new Error('Choose another player.');
  const endpoints = socialEndpoints(config, latest);
  if (endpoints.enabled === false || !endpoints.actionUrl || typeof fetchImpl !== 'function') {
    throw new Error('Friend actions are not connected yet.');
  }
  if (!proofToken) throw new Error('A valid AHT Launcher session is required.');
  const response = await fetchImpl(endpoints.actionUrl, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${proofToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: normalizedAction, target: targetUsername })
  });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new Error(body.error || body.message || `${response.status} ${response.statusText}`);
  }
  return {
    ok: true,
    queued: Boolean(body.queued),
    action: normalizedAction,
    target: targetUsername,
    message: String(body.message || 'Friend action queued.'),
    social: body.social ? normalizeSocialState(body.social, {
      available: true,
      actionsAvailable: true,
      username
    }) : null
  };
}
