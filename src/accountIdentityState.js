const name = value => String(value || '').trim().toLowerCase();
const uuid = value => String(value || '').replaceAll('-', '').toLowerCase();
const changed = () => Object.assign(new Error('The Minecraft account changed. Retry account sync.'), { code: 'AHT_ACCOUNT_CHANGED' });

export function sameAccountSnapshot(current, expected) {
  return current.installId === expected.installId
    && name(current.minecraftUsername) === name(expected.minecraftUsername)
    && uuid(current.minecraftUuid || current.minecraftUUID) === uuid(expected.minecraftUuid || expected.minecraftUUID);
}

/** A late failure cannot erase a newer success or annotate a different account. */
export function accountWarningState(current, expected, { username, message, attemptedAt = new Date().toISOString(), detectedUsername } = {}) {
  if (!sameAccountSnapshot(current, expected)
      || (current.remoteRegistrationConfirmedAt && current.remoteRegistrationConfirmedAt !== expected.remoteRegistrationConfirmedAt)) return current;
  return { ...current, remoteRegistrationAttemptedAt: attemptedAt,
    minecraftUsernameSyncWarning: message, minecraftUsernameSyncWarningUsername: username,
    ...(detectedUsername ? { minecraftLauncherDetectedUsername: detectedUsername } : {}) };
}

/** Registration changes only account-owned fields on the latest durable snapshot. */
export function registeredAccountState(current, expected, { username, minecraftUuid, remote = {}, mode, baseUrl,
  now = new Date().toISOString() }) {
  if (current.installId !== expected.installId) throw changed();
  if (!sameAccountSnapshot(current, expected) && (name(current.minecraftUsername) !== name(username)
      || (minecraftUuid && uuid(current.minecraftUuid || current.minecraftUUID) !== uuid(minecraftUuid)))) throw changed();
  if (remote.username && name(remote.username) !== name(username)) {
    throw Object.assign(new Error('The player service returned a different Minecraft account.'), { code: 'AHT_ACCOUNT_RESPONSE_INVALID' });
  }
  const sameRegisteredAccount = name(current.minecraftUsername) === name(username)
    && uuid(current.minecraftUuid || current.minecraftUUID) === uuid(minecraftUuid);
  return { ...current,
    minecraftUsername: remote.username || username, minecraftUuid,
    usernameRegisteredAt: current.usernameRegisteredAt || now,
    usernameRegistrationMode: mode || (remote.recovered ? 'minecraft-launcher-recovery' : remote.skipped ? 'local' : 'worker'),
    remoteRegistrationAttemptedAt: remote.skipped ? current.remoteRegistrationAttemptedAt || '' : now,
    remoteRegistrationConfirmedAt: remote.skipped ? (sameRegisteredAccount ? current.remoteRegistrationConfirmedAt || '' : '') : now,
    remoteRegistrationWorkerBaseUrl: remote.skipped ? (sameRegisteredAccount ? current.remoteRegistrationWorkerBaseUrl || '' : '') : baseUrl,
    minecraftLauncherDetectedUsername: String(mode || '').startsWith('minecraft-launcher') || remote.recovered
      ? username : current.minecraftLauncherDetectedUsername || '',
    minecraftUsernameUnavailable: '', minecraftUsernameSyncWarning: '', minecraftUsernameSyncWarningUsername: ''
  };
}
