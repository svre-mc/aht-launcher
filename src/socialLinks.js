export const LAUNCHER_SOCIAL_LINKS_SCHEMA = 'aht-launcher-social-links/v1';
export const LAUNCHER_SOCIAL_LINKS_OBJECT_KEY = 'update-media/launcher-social-links.json';

export const DEFAULT_LAUNCHER_SOCIAL_LINKS = Object.freeze({
  discord: 'https://discord.com/invite/AUVMekfNfq',
  youtube: 'https://www.youtube.com/@AHardTime',
  tiktok: 'https://www.tiktok.com/@ahardtimefr',
  forum: 'https://ahardtime.net/forum'
});

const LINK_LABELS = Object.freeze({
  discord: 'Discord',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  forum: 'Forum'
});

const ALLOWED_HOSTS = Object.freeze({
  discord: new Set(['discord.com', 'www.discord.com', 'discord.gg']),
  youtube: new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']),
  tiktok: new Set(['tiktok.com', 'www.tiktok.com']),
  forum: new Set(['ahardtime.net', 'www.ahardtime.net'])
});

export const LAUNCHER_SOCIAL_LINK_KEYS = Object.freeze(Object.keys(DEFAULT_LAUNCHER_SOCIAL_LINKS));

function normalizeSocialUrl(key, value = '') {
  const raw = String(value || '').trim() || DEFAULT_LAUNCHER_SOCIAL_LINKS[key];
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${LINK_LABELS[key]} must be a valid HTTPS URL.`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/[.]$/, '');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw new Error(`${LINK_LABELS[key]} must use a standard HTTPS URL without embedded credentials or a custom port.`);
  }
  if (!ALLOWED_HOSTS[key].has(hostname)) {
    throw new Error(`${LINK_LABELS[key]} must stay on an approved ${LINK_LABELS[key]} destination.`);
  }
  if (key === 'discord') {
    const validInvite = hostname === 'discord.gg'
      ? /^\/[A-Za-z0-9-]+\/?$/.test(parsed.pathname)
      : /^\/invite\/[A-Za-z0-9-]+\/?$/.test(parsed.pathname);
    if (!validInvite) throw new Error('Discord must point to a Discord invite.');
  }
  if (key === 'forum' && !/^\/forum(?:\/|$)/i.test(parsed.pathname)) {
    throw new Error('Forum must point to ahardtime.net/forum.');
  }
  parsed.hostname = hostname;
  parsed.hash = '';
  return parsed.toString();
}

export function validateLauncherSocialLinks(value = {}) {
  const source = value?.links && typeof value.links === 'object' ? value.links : value;
  const links = {};
  const errors = [];
  for (const key of LAUNCHER_SOCIAL_LINK_KEYS) {
    try {
      links[key] = normalizeSocialUrl(key, source?.[key]);
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }
  return { ok: errors.length === 0, links: errors.length ? { ...DEFAULT_LAUNCHER_SOCIAL_LINKS } : links, errors };
}

export function normalizeLauncherSocialLinks(value = {}) {
  const result = validateLauncherSocialLinks(value);
  if (!result.ok) throw new Error(result.errors.join(' '));
  return result.links;
}

export function createLauncherSocialLinksManifest(value = {}, options = {}) {
  return {
    schema: LAUNCHER_SOCIAL_LINKS_SCHEMA,
    links: normalizeLauncherSocialLinks(value),
    publishedAt: String(options.publishedAt || new Date().toISOString()),
    publishedBy: String(options.publishedBy || 'AHT Developer Launcher')
  };
}

export function parseLauncherSocialLinksManifest(value = {}) {
  if (value?.schema && value.schema !== LAUNCHER_SOCIAL_LINKS_SCHEMA) {
    throw new Error('The published launcher social-links schema is not supported.');
  }
  return {
    schema: LAUNCHER_SOCIAL_LINKS_SCHEMA,
    links: normalizeLauncherSocialLinks(value),
    publishedAt: String(value?.publishedAt || ''),
    publishedBy: String(value?.publishedBy || '')
  };
}
