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
    appVersion: identity.appVersion,
    platform: identity.platform,
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
