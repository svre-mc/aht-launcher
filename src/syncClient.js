export function launcherTelemetryPlatform(value = '') {
  const platform = String(value || '').trim().toLowerCase();
  if (platform === 'win32' || platform === 'win64' || platform.includes('windows')) return 'Windows';
  if (platform === 'darwin' || platform === 'mac' || platform.startsWith('macos') || platform.includes('mac os')) return 'Mac';
  if (platform === 'linux' || platform === 'ubuntu' || platform.includes('linux') || platform.includes('ubuntu')) return 'Linux';
  return '';
}

export async function sendLauncherEvent(config, identity, event) {
  const baseUrl = config.sync?.baseUrl || config.developer?.adminBaseUrl || '';
  if (!baseUrl || config.sync?.enabled === false) {
    return { skipped: true, reason: 'sync disabled or not configured' };
  }
  const url = new URL('api/events', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const payload = {
    schemaVersion: 1,
    sentAt: new Date().toISOString(),
    installId: identity.installId,
    playerLabel: identity.minecraftUsername || config.sync?.playerLabel || '',
    minecraftUsername: identity.minecraftUsername || '',
    minecraftUuid: identity.minecraftUuid || identity.minecraftUUID || '',
    appVersion: identity.appVersion,
    platform: launcherTelemetryPlatform(identity.platform),
    arch: identity.arch,
    packId: config.packId,
    event
  };
  const headers = { 'Content-Type': 'application/json' };
  if (config.sync?.writeToken) {
    headers.Authorization = `Bearer ${config.sync.writeToken}`;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Sync failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
  }
  return response.json();
}
