export const AHT_SERVICE_ORIGIN = 'https://api.ahardtime.net';

const LEGACY_WORKER_NAME = 'aht-curseforge-proxy';

export function migrateLegacyAhtServiceUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    const labels = url.hostname.toLowerCase().split('.');
    const legacyWorkerHost = url.hostname.toLowerCase().endsWith('.workers.dev')
      && labels[0] === LEGACY_WORKER_NAME;
    if (!legacyWorkerHost) return raw;
    const branded = new URL(AHT_SERVICE_ORIGIN);
    branded.pathname = url.pathname || '/';
    return branded.toString();
  } catch {
    return raw;
  }
}

export function isBrandedAhtServiceUrl(value = '') {
  try {
    return new URL(String(value || '').trim()).origin === AHT_SERVICE_ORIGIN;
  } catch {
    return false;
  }
}
