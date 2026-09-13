import { requestServiceJson, serviceResponseError, serviceTransportError } from './serviceTransport.js';

/** One registration/recovery transaction; local session completion is not ownership authority. */
export async function registerMinecraftAccount({ baseUrl, registrationPayload, recoverySecret,
  canRecover, proveOwnership, fetchImpl = globalThis.fetch, signal, timeoutMs = 20_000 }) {
  const url = new URL('api/users/register', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const request = payload => requestServiceJson(url, { fetchImpl, signal, timeoutMs,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-AHT-Launcher-Recovery': recoverySecret },
    body: JSON.stringify(payload) });
  const response = await request(registrationPayload);
  if (response.ok) return response.body;
  const error = serviceResponseError(response);
  // The legacy service has no structured code for this conflict. Keep this
  // compatibility check isolated instead of spreading message matching through Play.
  const recoveryNeeded = error.status === 409 && (['ACCOUNT_RECOVERY_REQUIRED', 'DEVICE_IDENTITY_MISMATCH'].includes(error.code)
    || /username is not available/i.test(error.message));
  if (!recoveryNeeded || !await canRecover()) throw error;
  const recoveryPayload = { ...registrationPayload, recoverExistingUsername: true,
    minecraftAccountMatched: true, supportsMinecraftSessionRecovery: true,
    recoveryReason: 'minecraft-launcher-account-match' };
  let recovery = await request(recoveryPayload);
  if (recovery.status === 409 && recovery.body.code === 'MINECRAFT_OWNERSHIP_REQUIRED') {
    const challenge = recovery.body.minecraftSessionChallenge;
    if (!/^[a-f0-9]{40}$/.test(String(challenge || ''))) {
      throw serviceTransportError('MINECRAFT_RECOVERY_CHALLENGE_INVALID', 'Minecraft account verification returned an invalid challenge.');
    }
    await proveOwnership({ serverId: challenge, expiresAt: recovery.body.expiresAt });
    // Never treat a localhost callback or the Mojang request alone as admission.
    // Only the account service can confirm its independent ownership check.
    recovery = await request({ ...recoveryPayload, minecraftSessionChallenge: challenge });
  }
  if (!recovery.ok) throw serviceResponseError(recovery, error.message);
  return { ...recovery.body, recovered: true };
}
