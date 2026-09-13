// A launcher claim is not Minecraft authentication. Only an authenticated game
// server may attach this installation to an account after verifying the live player.
export const MINECRAFT_SESSION_AUTHORITY = 'minecraft-online-session';

const uuid = value => String(value || '').replaceAll('-', '').toLowerCase();
const name = value => String(value || '').toLowerCase();

export function sessionAccountLinked(record, proof) {
  return Boolean(record && record.minecraftIdentityAuthority === MINECRAFT_SESSION_AUTHORITY
    && uuid(record.minecraftUuid) === uuid(proof.minecraftUuid)
    && name(record.username) === name(proof.minecraftUsername)
    && record.installId === proof.installId && record.deviceId === proof.deviceId
    && record.devicePublicKey === proof.devicePublicKey);
}

/** Called only after server authentication, token verification and access checks. */
export function bindAuthenticatedMinecraftSession(record, proof, authenticated, now = new Date().toISOString()) {
  if (proof.identityAuthority !== MINECRAFT_SESSION_AUTHORITY
      || !/^[A-Za-z0-9_]{3,16}$/.test(authenticated.username || '')
      || !/^[a-f0-9]{32}$/.test(uuid(authenticated.minecraftUuid))
      || /^0{32}$/.test(uuid(authenticated.minecraftUuid))
      || name(proof.minecraftUsername) !== name(authenticated.username)
      || uuid(proof.minecraftUuid) !== uuid(authenticated.minecraftUuid)) {
    throw Object.assign(new Error('Authenticated Minecraft identity mismatch.'), { code: 'SESSION_IDENTITY_MISMATCH' });
  }
  // A recycled name must never transfer another UUID's private account data.
  if (record?.minecraftUuid && uuid(record.minecraftUuid) !== uuid(proof.minecraftUuid)) {
    throw Object.assign(new Error('Account identity conflict.'), { code: 'SESSION_ACCOUNT_CONFLICT' });
  }
  return {
    ...record,
    schemaVersion: Math.max(4, Number(record?.schemaVersion || 0)),
    username: authenticated.username, minecraftUuid: proof.minecraftUuid,
    installId: proof.installId, deviceId: proof.deviceId, devicePublicKey: proof.devicePublicKey,
    minecraftIdentityAuthority: MINECRAFT_SESSION_AUTHORITY,
    minecraftIdentityVerifiedAt: now,
    createdAt: record?.createdAt || now, updatedAt: now,
    launcherStateBindingPending: true
  };
}
