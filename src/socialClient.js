import { isFileUrl, isHttpUrl, readJsonFromSource, resolveSource } from './utils.js';

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

function socialConfig(config = {}, latest = null) {
  const fromLatest = latest?.social && typeof latest.social === 'object' ? latest.social : {};
  const fromConfig = config?.social && typeof config.social === 'object' ? config.social : {};
  return {
    enabled: fromLatest.enabled ?? fromConfig.enabled ?? true,
    feedUrl: firstString(fromLatest.feedUrl, fromLatest.friendsUrl, fromLatest.url, fromConfig.feedUrl, fromConfig.friendsUrl, fromConfig.url),
    actionUrl: firstString(fromLatest.actionUrl, fromConfig.actionUrl)
  };
}

function resolveSocialSource(value = '', config = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isHttpUrl(raw) || isFileUrl(raw)) return raw;
  if (config.latestUrl) return resolveSource(config.latestUrl, raw);
  return raw;
}

function applyTemplate(source = '', identity = {}, extra = {}) {
  const replacements = {
    username: sanitizeMinecraftUsername(identity.minecraftUsername || identity.username || ''),
    installId: String(identity.installId || ''),
    ...extra
  };
  return String(source || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => encodeURIComponent(String(replacements[key] || '')));
}

function sourceForRequest(value = '', config = {}, identity = {}, extra = {}) {
  return resolveSocialSource(applyTemplate(value, identity, extra), config);
}

function socialFeedUnavailableState(username, message = 'Friend service could not be read yet. Try Refresh in a moment.') {
  return normalizeSocialState({}, {
    available: false,
    actionsAvailable: false,
    username,
    message
  });
}

function listFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function nameFrom(item) {
  if (typeof item === 'string') return sanitizeMinecraftUsername(item);
  if (!item || typeof item !== 'object') return '';
  return sanitizeMinecraftUsername(item.username || item.name || item.player || item.minecraftUsername || '');
}

function onlineNameSet(raw = {}) {
  const names = [
    ...listFrom(raw.online),
    ...listFrom(raw.onlineFriends),
    ...listFrom(raw.onlinePlayers)
  ];
  return new Set(names.map(nameFrom).filter(Boolean).map((name) => name.toLowerCase()));
}

function normalizeFriendList(value, onlineNames) {
  const seen = new Set();
  const friends = [];
  for (const item of listFrom(value)) {
    const username = nameFrom(item);
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const itemOnline = typeof item === 'object' && item
      ? Boolean(item.online ?? item.isOnline ?? item.connected)
      : false;
    friends.push({
      username,
      online: itemOnline || onlineNames.has(key),
      status: itemOnline || onlineNames.has(key) ? 'Online' : 'Offline'
    });
  }
  friends.sort((left, right) => Number(right.online) - Number(left.online) || left.username.localeCompare(right.username));
  return friends;
}

function normalizeBlockedList(value) {
  const seen = new Set();
  const blocked = [];
  for (const item of listFrom(value)) {
    const username = nameFrom(item);
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    blocked.push({ username });
  }
  blocked.sort((left, right) => left.username.localeCompare(right.username));
  return blocked;
}

export function normalizeSocialState(raw = {}, options = {}) {
  const root = raw?.social && typeof raw.social === 'object' ? raw.social : raw;
  const onlineNames = onlineNameSet(root);
  const friends = normalizeFriendList(root?.friends || root?.friendList || root?.players?.friends, onlineNames);
  const blocked = normalizeBlockedList(root?.blocked || root?.blockedPlayers || root?.players?.blocked);
  return {
    available: options.available !== false,
    actionsAvailable: Boolean(options.actionsAvailable),
    username: sanitizeMinecraftUsername(root?.username || options.username || ''),
    updatedAt: String(root?.updatedAt || root?.generatedAt || options.updatedAt || ''),
    counts: {
      friends: Number(root?.counts?.friends) || friends.length,
      online: Number(root?.counts?.online) || friends.filter((friend) => friend.online).length,
      blocked: Number(root?.counts?.blocked) || blocked.length
    },
    friends,
    blocked,
    message: String(root?.message || options.message || '')
  };
}

export async function fetchSocialState({ config = {}, latest = null, identity = {}, readJson = readJsonFromSource } = {}) {
  const settings = socialConfig(config, latest);
  const username = sanitizeMinecraftUsername(identity.minecraftUsername || identity.username || '');
  if (!username) {
    return normalizeSocialState({}, {
      available: false,
      actionsAvailable: false,
      message: 'Minecraft username is required before friends can load.'
    });
  }
  if (settings.enabled === false) {
    return normalizeSocialState({}, {
      available: false,
      actionsAvailable: false,
      username,
      message: 'Friends are disabled for this launcher.'
    });
  }
  const feedUrl = sourceForRequest(settings.feedUrl, config, { ...identity, minecraftUsername: username });
  const actionUrl = sourceForRequest(settings.actionUrl, config, { ...identity, minecraftUsername: username });
  if (!feedUrl) {
    return normalizeSocialState({}, {
      available: false,
      actionsAvailable: Boolean(actionUrl),
      username,
      message: 'Friend service is not connected yet.'
    });
  }
  let raw = null;
  try {
    raw = await readJson(feedUrl);
  } catch {
    return socialFeedUnavailableState(username);
  }
  return normalizeSocialState(raw, {
    available: true,
    actionsAvailable: Boolean(actionUrl),
    username
  });
}

export async function sendSocialAction({ config = {}, latest = null, identity = {}, action = '', target = '', fetchImpl = fetch } = {}) {
  const normalizedAction = String(action || '').trim();
  if (!SOCIAL_ACTIONS.has(normalizedAction)) {
    throw new Error('That friend action is not available from the launcher.');
  }
  const username = sanitizeMinecraftUsername(identity.minecraftUsername || identity.username || '');
  const targetUsername = sanitizeMinecraftUsername(target);
  if (!username) {
    throw new Error('Minecraft username is required before friends can be updated.');
  }
  if (!targetUsername) {
    throw new Error('Enter a valid Minecraft username.');
  }
  const settings = socialConfig(config, latest);
  const actionUrl = sourceForRequest(settings.actionUrl, config, { ...identity, minecraftUsername: username }, {
    action: normalizedAction,
    target: targetUsername
  });
  if (settings.enabled === false || !actionUrl) {
    throw new Error('Friend actions are not connected yet.');
  }
  const response = await fetchImpl(actionUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: normalizedAction,
      target: targetUsername,
      username,
      installId: String(identity.installId || '')
    })
  });
  const bodyText = await response.text().catch(() => '');
  let body = {};
  if (bodyText.trim()) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = { message: bodyText.trim() };
    }
  }
  if (!response.ok) {
    throw new Error(body.error || body.message || `${response.status} ${response.statusText}`);
  }
  return {
    ok: true,
    action: normalizedAction,
    target: targetUsername,
    social: body?.friends || body?.blocked || body?.social || body?.state
      ? normalizeSocialState(body.state || body.social || body, {
        available: true,
        actionsAvailable: true,
        username
      })
      : null
  };
}
