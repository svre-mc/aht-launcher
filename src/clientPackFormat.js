export const CLIENT_PACK_FORMAT = 'aht-full-client-zip';
export const CLIENT_PACK_METADATA_ENTRY = 'aht-client-pack.json';
export const CLIENT_MANIFEST_FORMAT = 'aht-client-manifest-v1';
export const CLIENT_DELTA_FORMAT = 'aht-client-delta-v1';
export const CLIENT_DELTA_METADATA_ENTRY = 'aht-client-delta.json';

export const CLIENT_GAME_SETTINGS_FILES = ['options.txt', 'optionsof.txt'];
export const CLIENT_UPDATE_PRESERVED_FILES = ['config/jei/bookmarks.ini'];
export const CLIENT_PACK_CONTENT_ROOTS = [
  'config',
  'fancymenu_data',
  'mods',
  'resourcepacks',
  'resources',
  'scripts',
  'structures'
];

function normalizedClientPath(value = '') {
  return String(value).replaceAll('\\', '/').replace(/^\/+/, '');
}

export function isClientGameSettingsPath(value = '') {
  const normalized = normalizedClientPath(value).toLowerCase();
  return CLIENT_GAME_SETTINGS_FILES.some((entry) => normalized === entry.toLowerCase());
}

export function isClientUpdatePreservedPath(value = '') {
  const normalized = normalizedClientPath(value).toLowerCase();
  return CLIENT_UPDATE_PRESERVED_FILES.some((entry) => normalized === entry.toLowerCase());
}

export function isClientPackContentPath(value = '') {
  const normalized = normalizedClientPath(value);
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return false;
  if (isClientGameSettingsPath(normalized)) return true;
  const lower = normalized.toLowerCase();
  if (lower === CLIENT_PACK_METADATA_ENTRY || lower === CLIENT_DELTA_METADATA_ENTRY) return false;
  if (lower === '.aht-launcher' || lower.startsWith('.aht-launcher/')) return false;
  if (lower === 'mods/openterraingenerator' || lower.startsWith('mods/openterraingenerator/')) return false;
  return CLIENT_PACK_CONTENT_ROOTS.some((root) => lower.startsWith(`${root.toLowerCase()}/`));
}

export function isManagedClientPackPath(value = '') {
  return isClientPackContentPath(value)
    && !isClientGameSettingsPath(value)
    && !isClientUpdatePreservedPath(value);
}
