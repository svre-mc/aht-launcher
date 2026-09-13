import { sameAccountSnapshot } from './accountIdentityState.js';

export const MINECRAFT_SESSION_AUTHORITY = 'minecraft-online-session';

function normalizedUuid(value) {
  const compact = String(value || '').replace(/[{}-]/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact) || /^0{32}$/.test(compact)) return '';
  return `${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}`;
}

// Import profile metadata, not credentials or an ownership assertion. The game
// connection must authenticate this exact UUID before any world access is given.
export function selectedMinecraftSessionState(current, expected, { username, minecraftUuid } = {}) {
  if (!sameAccountSnapshot(current, expected)) return current;
  const selectedName = String(username || current.minecraftUsername || '').trim();
  const selectedUuid = normalizedUuid(minecraftUuid || (!username
    || selectedName.toLowerCase() === String(current.minecraftUsername || '').toLowerCase()
    ? current.minecraftUuid || current.minecraftUUID : ''));
  const same = selectedName.toLowerCase() === String(current.minecraftUsername || '').toLowerCase()
    && selectedUuid === normalizedUuid(current.minecraftUuid || current.minecraftUUID);
  return {
    ...current,
    minecraftUsername: /^[A-Za-z0-9_]{3,16}$/.test(selectedName) ? selectedName : '',
    minecraftUuid: selectedUuid,
    minecraftLauncherDetectedUsername: username || current.minecraftLauncherDetectedUsername || '',
    usernameRegistrationMode: MINECRAFT_SESSION_AUTHORITY,
    remoteRegistrationConfirmedAt: same ? current.remoteRegistrationConfirmedAt || '' : '',
    remoteRegistrationWorkerBaseUrl: same ? current.remoteRegistrationWorkerBaseUrl || '' : '',
    minecraftUsernameUnavailable: '', minecraftUsernameSyncWarning: '', minecraftUsernameSyncWarningUsername: ''
  };
}
