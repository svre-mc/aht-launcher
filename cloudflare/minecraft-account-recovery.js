const PREFIX = 'accounts/recovery-challenges/';
const TTL_MS = 5 * 60_000;
const compactUuid = value => String(value || '').replaceAll('-', '').toLowerCase();

export function isLegacyMinecraftAccount(record) {
  return Boolean(record?.installId && !record.minecraftUuid && !record.deviceId
    && !record.devicePublicKey && !record.accountRecoveryVerifier);
}

// A local username/UUID is only a hint. Mojang must confirm a fresh session
// challenge before a legacy installation can acquire modern credentials.
export async function recoverLegacyMinecraftAccount({ env, record, body, username,
  minecraftUuid, deviceId, installId, fetchImpl = fetch, now = Date.now() }) {
  const denied = { verified: false, status: 409, error: 'Minecraft account ownership could not be verified. Sign in to Minecraft Launcher and retry account sync.' };
  if (!isLegacyMinecraftAccount(record) || !/^[a-f0-9]{32}$/.test(compactUuid(minecraftUuid))
      || !/^ahtd_[a-f0-9]{64}$/.test(deviceId) || !/^[A-Za-z0-9_]{3,16}$/.test(username)) return denied;
  const key = `${PREFIX}${username.toLowerCase()}/${deviceId}.json`;
  const binding = { username: username.toLowerCase(), minecraftUuid: compactUuid(minecraftUuid), deviceId,
    installId, previousInstallId: record.installId };
  const stored = await env.AHT_DATA.get(key);
  let challenge = stored ? await stored.json().catch(() => null) : null;
  const matches = challenge && Object.entries(binding).every(([k, v]) => challenge[k] === v)
    && challenge.expiresAt > now && challenge.expiresAt <= now + TTL_MS;
  if (!body.minecraftSessionChallenge) {
    if (!matches) {
      const bytes = crypto.getRandomValues(new Uint8Array(20));
      // Positive, signed-SHA1-compatible server ID accepted by Mojang.
      bytes[0] &= 0x7f;
      const serverId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      challenge = { ...binding, serverId, expiresAt: now + TTL_MS };
      await env.AHT_DATA.put(key, JSON.stringify(challenge), { httpMetadata: { contentType: 'application/json' } });
    }
    return { verified: false, status: 409, code: 'MINECRAFT_OWNERSHIP_REQUIRED',
      error: 'This older AHT account needs Minecraft ownership verification. Update AHT Launcher and sign in to Minecraft Launcher.',
      minecraftSessionChallenge: challenge.serverId, expiresAt: challenge.expiresAt };
  }
  if (!matches || challenge.serverId !== body.minecraftSessionChallenge) return denied;
  const url = new URL('https://sessionserver.mojang.com/session/minecraft/hasJoined');
  url.searchParams.set('username', username);
  url.searchParams.set('serverId', challenge.serverId);
  let response;
  try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { return { verified: false, status: 503, error: 'Minecraft ownership verification is temporarily unavailable. Try account sync again shortly.' }; }
  if (response.status >= 500 || response.status === 429) {
    return { verified: false, status: 503, error: 'Minecraft ownership verification is temporarily unavailable. Try account sync again shortly.' };
  }
  const profile = response.status === 200 ? await response.json().catch(() => null) : null;
  if (!profile || compactUuid(profile.id) !== binding.minecraftUuid
      || String(profile.name || '').toLowerCase() !== binding.username) return denied;
  return { verified: true, key };
}
