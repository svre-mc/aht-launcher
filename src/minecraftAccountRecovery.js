import fs from 'node:fs/promises';
import path from 'node:path';
import { readWindowsMinecraftSession } from './windowsMinecraftSession.js';

const uuid = value => String(value || '').replaceAll('-', '').toLowerCase();
const JOIN_URL = 'https://sessionserver.mojang.com/session/minecraft/join';

// Credentials remain local and are submitted only to Mojang's fixed HTTPS
// endpoint. They never enter identity state, diagnostics, or AHT requests.
export async function proveMinecraftAccountOwnership({ roots, username, minecraftUuid,
  serverId, fetchImpl = fetch, readWindowsSession = readWindowsMinecraftSession }) {
  if (!/^[a-f0-9]{40}$/.test(String(serverId || '')) || !/^[a-f0-9]{32}$/.test(uuid(minecraftUuid))) {
    throw new Error('Minecraft account verification returned an invalid challenge.');
  }
  const tokens = new Set();
  const protectedSessions = [];
  for (const root of [...new Set((roots || []).filter(Boolean).map(root => path.resolve(root)))]) {
    for (const name of ['launcher_accounts.json', 'launcher_accounts_microsoft_store.json', 'launcher_profiles.json']) {
      const file = await fs.readFile(path.join(root, name), 'utf8').then(JSON.parse).catch(() => null);
      for (const account of Object.values(file?.accounts || {})) {
        const profile = account?.minecraftProfile;
        if (String(profile?.name || '').toLowerCase() === username.toLowerCase()
            && uuid(profile?.id || profile?.uuid) === uuid(minecraftUuid)) {
          if (account.accessToken) tokens.add(account.accessToken);
          if (account.remoteId) protectedSessions.push({ remoteId: account.remoteId,
            file: path.join(root, name.includes('microsoft_store') ? 'launcher_msa_credentials_microsoft_store.bin' : 'launcher_msa_credentials.bin') });
        }
      }
      for (const account of Object.values(file?.authenticationDatabase || {})) {
        const matches = Object.entries(account?.profiles || {}).some(([id, profile]) =>
          String(profile?.displayName || profile?.name || '').toLowerCase() === username.toLowerCase()
          && uuid(profile?.id || profile?.uuid || id) === uuid(minecraftUuid));
        if (matches && account.accessToken) tokens.add(account.accessToken);
      }
    }
  }
  for (const session of protectedSessions) {
    const credential = await readWindowsSession(session);
    if (!credential) continue;
    try {
      const response = await fetchImpl('https://api.minecraftservices.com/authentication/login_with_xbox', {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: `XBL3.0 x=${credential.userHash};${credential.token}`, ensureLegacyEnabled: true })
      });
      if (response.status >= 500 || response.status === 429) throw new Error('Minecraft service is temporarily unavailable.');
      if (!response.ok) continue;
      const login = await response.json();
      if (typeof login.access_token !== 'string' || login.access_token.length > 32_768) continue;
      const profileResponse = await fetchImpl('https://api.minecraftservices.com/minecraft/profile', {
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${login.access_token}` }
      });
      if (profileResponse.status >= 500 || profileResponse.status === 429) throw new Error('Minecraft service is temporarily unavailable.');
      if (!profileResponse.ok) continue;
      const profile = await profileResponse.json();
      if (String(profile.name || '').toLowerCase() === username.toLowerCase() && uuid(profile.id) === uuid(minecraftUuid)) {
        tokens.add(login.access_token);
      }
    } catch { throw new Error('Minecraft ownership verification could not reach Mojang. Try account sync again shortly.'); }
  }
  for (const accessToken of tokens) {
    if (typeof accessToken !== 'string' || accessToken.length > 32_768) continue;
    let response;
    try {
      response = await fetchImpl(JOIN_URL, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, selectedProfile: uuid(minecraftUuid), serverId })
      });
    } catch { throw new Error('Minecraft ownership verification could not reach Mojang. Try account sync again shortly.'); }
    if (response.status === 204) return { verified: true };
    if (response.status >= 500 || response.status === 429) {
      throw new Error('Minecraft ownership verification is temporarily unavailable. Try account sync again shortly.');
    }
  }
  throw new Error('Your older AHT account needs a fresh Minecraft session. Open Minecraft Launcher, sign out and back in to the matching account, then retry account sync in AHT.');
}
