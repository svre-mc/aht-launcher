import fs from 'node:fs/promises';
import os from 'node:os';
import { createDecipheriv, createHash, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { requestServiceJson } from './serviceTransport.js';

const deriveKey = promisify(pbkdf2);
const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
const MAX_ACCOUNT_BYTES = 256 * 1024;
const CLIENT_ID = 'd5b2e079-2c2c-4ade-9dab-1c1eb204162a';
const ENDPOINTS = Object.freeze({
  microsoft: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  xbox: 'https://user.auth.xboxlive.com/user/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  minecraft: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  profile: 'https://api.minecraftservices.com/minecraft/profile'
});
const uuid = value => String(value || '').replaceAll('-', '').toLowerCase();
const validUuid = value => /^[a-f0-9]{32}$/.test(uuid(value)) && !/^0{32}$/.test(uuid(value));
const tokenString = value => typeof value === 'string' && value.length > 0 && value.length <= 32768;
const parseObject = value => typeof value === 'string' ? JSON.parse(value) : value;
export const curseForgeSessionError = (code = 'UNAVAILABLE') => Object.assign(new Error({
  UNAVAILABLE: 'AHT could not read the existing CurseForge Minecraft session. Open CurseForge and retry Play.',
  EXPIRED: 'Microsoft rejected the saved Minecraft session. Reconnect the account in CurseForge, then retry Play.',
  NETWORK: 'Minecraft session validation could not reach Microsoft. Check your connection and retry Play.',
  CHANGED: 'The selected Minecraft account changed during Play. Click Play again.'
}[code] || 'The CurseForge Minecraft session is unavailable.'), { code: `CURSEFORGE_SESSION_${code}` });

// CurseForge standalone 1.321 uses Cryptr 6: base64(hex(salt64, iv16,
// tag16, AES-GCM ciphertext)), PBKDF2-SHA512(100000), keyed to os.userInfo.
// Decode only its game-user-info field; never CF website/app session-tokens.
// No credentials are returned by inspect(), written back, logged or sent to AHT.
async function readSelectedAccount(storage, userInfo) {
  const encoded = storage['game-user-info'];
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_ACCOUNT_BYTES * 3) return null;
  const hex = Buffer.from(encoded, 'base64').toString('utf8');
  if (!/^[a-f0-9]+$/i.test(hex) || hex.length % 2 || hex.length > MAX_ACCOUNT_BYTES * 2) throw curseForgeSessionError();
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length <= 96) throw curseForgeSessionError();
  const key = await deriveKey(`${userInfo.uid}${userInfo.username}`, bytes.subarray(0, 64), 100000, 32, 'sha512');
  let plain;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(64, 80));
    cipher.setAuthTag(bytes.subarray(80, 96));
    plain = Buffer.concat([cipher.update(bytes.subarray(96)), cipher.final()]);
    const entries = JSON.parse(plain.toString('utf8'));
    if (!Array.isArray(entries) || entries.length > 64) throw curseForgeSessionError();
    const selectedId = uuid(storage['game-selected-user-id']);
    const candidates = entries.filter(entry => Array.isArray(entry) && entry.length === 2 && entry[1] && validUuid(entry[1].uuid));
    const entry = selectedId ? candidates.find(([, value]) => uuid(value.uuid) === selectedId) : candidates[0];
    const account = entry?.[1];
    if (!account || !/^[A-Za-z0-9_]{3,16}$/.test(account.username || '') || account.userType !== 'msa') return null;
    return account;
  } catch { throw curseForgeSessionError(); }
  finally { key.fill(0); bytes.fill(0); plain?.fill(0); }
}

function publicProfile(account) {
  if (!account) return null;
  const id = uuid(account.uuid);
  return { username: account.username, minecraftUuid: `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`,
    provider: 'curseforge' };
}

// The caller supplies only known provider-owned storage paths. It owns route
// selection. A missing account must not fall through to another provider/user.
export function createCurseForgeMinecraftSessions({ userInfo = () => os.userInfo(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let cached = null;
  let profileCache = null;
  async function load(file) {
    let bytes;
    try {
      const handle = await fs.open(file, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_STORAGE_BYTES) throw curseForgeSessionError();
        bytes = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > stat.size) throw curseForgeSessionError();
        bytes = bytes.subarray(0, bytesRead);
      } finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw curseForgeSessionError(); }
    try {
      const storage = JSON.parse(bytes.toString('utf8'));
      const settings = parseObject(storage['minecraft-settings'] || {});
      if (settings?.gameLaunchMethod !== 1) { cached = null; return null; }
      const fingerprint = createHash('sha256').update(String(storage['game-user-info'] || '')).update('\0')
        .update(String(storage['game-selected-user-id'] || '')).digest('hex');
      return { storage, fingerprint, settings };
    } catch { throw curseForgeSessionError(); }
    finally { bytes.fill(0); }
  }
  async function request(endpoint, body, signal, bearer = '') {
    const response = await requestServiceJson(ENDPOINTS[endpoint], {
      fetchImpl, signal, timeoutMs: 12000, maxBytes: 65536,
      method: endpoint === 'profile' ? 'GET' : 'POST',
      headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body ? { 'Content-Type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
      body: body ? (body instanceof URLSearchParams ? body.toString() : JSON.stringify(body)) : undefined
    }).catch(() => { throw curseForgeSessionError('NETWORK'); });
    if (!response.ok) {
      if (response.status === 400 || response.status === 401 || response.status === 403) throw curseForgeSessionError('EXPIRED');
      throw curseForgeSessionError('NETWORK');
    }
    return response.body;
  }
  async function refresh(account, signal) {
    const oauth = account.oauthTokens;
    if (!tokenString(oauth?.refreshToken)) throw curseForgeSessionError('EXPIRED');
    const microsoft = await request('microsoft', new URLSearchParams({ client_id: CLIENT_ID,
      scope: 'XboxLive.signin XboxLive.offline_access openid', grant_type: 'refresh_token', refresh_token: oauth.refreshToken }), signal);
    if (!tokenString(microsoft.access_token)) throw curseForgeSessionError();
    const xbox = await request('xbox', { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${microsoft.access_token}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' }, signal);
    if (!tokenString(xbox.Token)) throw curseForgeSessionError();
    const xsts = await request('xsts', { Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' }, signal);
    const hash = xsts.DisplayClaims?.xui?.[0]?.uhs;
    if (!tokenString(xsts.Token) || !tokenString(hash)) throw curseForgeSessionError();
    const minecraft = await request('minecraft', { identityToken: `XBL3.0 x=${hash};${xsts.Token}` }, signal);
    if (!tokenString(minecraft.access_token)) throw curseForgeSessionError();
    return minecraft.access_token;
  }
  return {
    async mode(file) { return Boolean(await load(file)); },
    async inspect(file) {
      const state = await load(file);
      if (!state) return null;
      if (cached?.file === file && cached.fingerprint === state.fingerprint && cached.until > now()) {
        return { username: cached.session.username, minecraftUuid: cached.session.minecraftUuid, provider: 'curseforge' };
      }
      if (profileCache?.file === file && profileCache.fingerprint === state.fingerprint) return profileCache.profile ? { ...profileCache.profile } : null;
      const account = await readSelectedAccount(state.storage, userInfo()).catch(() => null);
      const profile = publicProfile(account);
      profileCache = { file, fingerprint: state.fingerprint, profile };
      return profile ? { ...profile } : null;
    },
    async acquire(file) {
      const state = await load(file);
      if (!state) throw curseForgeSessionError('CHANGED');
      if (cached?.file === file && cached.fingerprint === state.fingerprint && cached.until > now()) return { ...cached.session };
      cached = null;
      const account = await readSelectedAccount(state.storage, userInfo());
      if (!account) throw curseForgeSessionError();
      const signal = AbortSignal.timeout(45000);
      let accessToken = account.minecraftToken?.accessToken;
      let refreshed = false;
      if (!tokenString(accessToken) || Date.parse(account.minecraftToken?.expiresAt || '') <= now() + 60000) {
        accessToken = await refresh(account, signal); refreshed = true;
      }
      let verified;
      try { verified = await request('profile', null, signal, accessToken); }
      catch (error) {
        if (error.code !== 'CURSEFORGE_SESSION_EXPIRED' || refreshed) throw error;
        accessToken = await refresh(account, signal);
        verified = await request('profile', null, signal, accessToken);
      }
      if (uuid(verified?.id) !== uuid(account.uuid) || !/^[A-Za-z0-9_]{3,16}$/.test(verified?.name || '')) throw curseForgeSessionError('CHANGED');
      const latest = await load(file);
      if (!latest || latest.fingerprint !== state.fingerprint) throw curseForgeSessionError('CHANGED');
      const session = { ...publicProfile({ ...account, username: verified.name }), accessToken };
      cached = { file, fingerprint: state.fingerprint, until: now() + 10000, session };
      return { ...session };
    },
    clear() { cached = null; profileCache = null; }
  };
}
