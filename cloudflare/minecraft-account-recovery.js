import { requestServiceJson } from '../src/serviceTransport.js';

const PREFIX = 'accounts/recovery-challenges/';
const TTL_MS = 5 * 60_000;
const compactUuid = value => String(value || '').replaceAll('-', '').toLowerCase();

// Private service diagnostics only. Never log account identifiers, challenge
// values, request/response bodies, headers, URLs, or exception messages here.
const RECOVERY_STAGES = new Set(['input-rejected', 'challenge-issued', 'challenge-reused',
  'challenge-missing', 'challenge-expired', 'challenge-binding-mismatch', 'challenge-value-mismatch',
  'upstream-response-invalid', 'upstream-unavailable', 'upstream-timeout', 'upstream-redirect',
  'upstream-no-profile', 'upstream-profile-mismatch', 'verification-expired', 'upstream-verified']);
function recordRecoveryOutcome(stage, httpStatus = 0) {
  if (!RECOVERY_STAGES.has(stage)) return;
  try {
    console.info(JSON.stringify({ event: 'aht.account-recovery', schema: 1, stage,
      httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : 0 }));
  } catch { /* Diagnostics must never change an authorization decision. */ }
}

export function isLegacyMinecraftAccount(record) {
  return Boolean(record?.installId && !record.minecraftUuid && !record.deviceId
    && !record.devicePublicKey && !record.accountRecoveryVerifier);
}

// Kept for callers that explicitly require a legacy-only migration.
export async function recoverLegacyMinecraftAccount({ env, record, body, username,
  minecraftUuid, deviceId, installId, fetchImpl = fetch, now = Date.now() }) {
  if (!isLegacyMinecraftAccount(record)) return { verified: false, status: 409 };
  return recoverMinecraftAccount({ env, record, body, username, minecraftUuid, deviceId, installId, fetchImpl, now });
}

// Local account hints and possession of an install ID cannot authorize recovery.
// A fresh Mojang challenge can restore lost credentials for the same UUID, even
// for modern accounts, without removing access restrictions or bypassing Phoenix.
export async function recoverMinecraftAccount({ env, record, body, username,
  minecraftUuid, deviceId, installId, fetchImpl = fetch, now = Date.now(), currentTime = Date.now, timeoutMs = 15_000 }) {
  const denied = { verified: false, status: 409, error: 'Minecraft account ownership could not be verified. Sign in to Minecraft Launcher and retry account sync.' };
  if ((!isLegacyMinecraftAccount(record) && compactUuid(record?.minecraftUuid) !== compactUuid(minecraftUuid))
      || !record?.installId || !installId || String(installId).length > 200
      || !/^[a-f0-9]{32}$/.test(compactUuid(minecraftUuid))
      || !/^ahtd_[a-f0-9]{64}$/.test(deviceId) || !/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    recordRecoveryOutcome('input-rejected');
    return denied;
  }
  // Credential state is part of the challenge: a proof issued for an older
  // registration cannot rotate credentials again after another recovery wins.
  const stateBytes = new TextEncoder().encode(JSON.stringify([record.installId, record.minecraftUuid || '',
    record.deviceId || '', record.devicePublicKey || '', record.accountRecoveryVerifier || '']));
  const previousState = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', stateBytes)), b => b.toString(16).padStart(2, '0')).join('');
  const key = `${PREFIX}${username.toLowerCase()}/${deviceId}.json`;
  const binding = { username: username.toLowerCase(), minecraftUuid: compactUuid(minecraftUuid), deviceId,
    installId, previousInstallId: record.installId, previousState };
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
    recordRecoveryOutcome(matches ? 'challenge-reused' : 'challenge-issued');
    return { verified: false, status: 409, code: 'MINECRAFT_OWNERSHIP_REQUIRED',
      error: 'Verify your Minecraft account to restore this launcher installation.',
      minecraftSessionChallenge: challenge.serverId, expiresAt: challenge.expiresAt };
  }
  if (!matches || challenge.serverId !== body.minecraftSessionChallenge) {
    recordRecoveryOutcome(!challenge ? 'challenge-missing' : !(challenge.expiresAt > now && challenge.expiresAt <= now + TTL_MS)
      ? 'challenge-expired' : !matches ? 'challenge-binding-mismatch' : 'challenge-value-mismatch');
    return denied;
  }
  const url = new URL('https://sessionserver.mojang.com/session/minecraft/hasJoined');
  url.searchParams.set('username', username);
  url.searchParams.set('serverId', challenge.serverId);
  let result;
  try { result = await requestServiceJson(url, { method: 'GET', fetchImpl, timeoutMs, maxBytes: 65_536, headers: { Accept: 'application/json' } }); }
  catch (error) {
    recordRecoveryOutcome(error.code === 'AHT_SERVICE_TIMEOUT' ? 'upstream-timeout'
      : error.code === 'AHT_SERVICE_REDIRECT_BLOCKED' ? 'upstream-redirect'
      : error.status ? 'upstream-response-invalid' : 'upstream-unavailable', error.status);
    if (error.status && error.status < 500 && error.status !== 429) return denied;
    return { verified: false, status: 503, code: 'MINECRAFT_VERIFICATION_UNAVAILABLE', error: 'Minecraft ownership verification is temporarily unavailable. Try account sync again shortly.' };
  }
  if (result.status >= 500 || result.status === 429) {
    recordRecoveryOutcome('upstream-unavailable', result.status);
    return { verified: false, status: 503,
      code: 'MINECRAFT_VERIFICATION_UNAVAILABLE', error: 'Minecraft ownership verification is temporarily unavailable. Try account sync again shortly.' };
  }
  const profile = result.status === 200 ? result.body : null;
  if (challenge.expiresAt <= currentTime() || !profile || compactUuid(profile.id) !== binding.minecraftUuid
      || String(profile.name || '').toLowerCase() !== binding.username) {
    recordRecoveryOutcome(challenge.expiresAt <= currentTime() ? 'verification-expired'
      : !profile ? 'upstream-no-profile' : 'upstream-profile-mismatch', result.status);
    return denied;
  }
  recordRecoveryOutcome('upstream-verified', result.status);
  return { verified: true, key, expiresAt: challenge.expiresAt };
}
