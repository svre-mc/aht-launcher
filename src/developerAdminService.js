import { requestServiceJson, serviceResponseError } from './serviceTransport.js';

const error = (message, code) => Object.assign(new Error(message), { code });
const changed = () => error('The developer session changed. Sign in again.', 'AHT_ADMIN_SESSION_CHANGED');

/** Process-local developer authority, separate from player identity and recovery. */
export function createDeveloperAdminService({ baseUrl, loadCredentials, assertAuthenticated = () => {},
  request = requestServiceJson, now = Date.now, loginTimeoutMs = () => 15000 }) {
  let session = null;
  let generation = 0;
  const pending = new Map();
  function endpoint(config, route) {
    const base = baseUrl(config);
    if (!base) throw error('Developer admin URL is not configured', 'AHT_ADMIN_NOT_CONFIGURED');
    const origin = new URL(base.endsWith('/') ? base : `${base}/`);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
    if (origin.username || origin.password || origin.hash || origin.search
        || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local))) {
      throw error('The developer service address is invalid.', 'AHT_ADMIN_ADDRESS_INVALID');
    }
    const relative = String(route || '').replace(/^\/+/, '');
    const url = new URL(relative, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith(`${origin.pathname}admin/`) || url.hash
        || !relative.startsWith('admin/')) {
      throw error('The developer service route is invalid.', 'AHT_ADMIN_ADDRESS_INVALID');
    }
    return { base, url, relative };
  }
  function clear(expectedBase = '', expectedToken = '') {
    if (expectedBase && session?.base !== expectedBase && !pending.has(expectedBase)) return;
    if (expectedToken && session?.token !== expectedToken) return;
    generation++;
    session = null;
    pending.clear();
  }
  async function performLogin(config, username = '', password = '') {
    const epoch = generation;
    try {
      const { base, url } = endpoint(config, 'admin/login');
      const suppliedUsername = String(username || '').trim();
      const suppliedPassword = String(password || '');
      const saved = suppliedUsername && suppliedPassword ? null : await loadCredentials();
      const loginUsername = String(suppliedUsername || saved?.username || '').trim();
      const loginPassword = String(suppliedPassword || saved?.password || '');
      if (!loginUsername || !loginPassword) return { ok: false, error: 'Developer credentials are not configured on this machine' };
      if (epoch !== generation) throw changed();
      const response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword }), timeoutMs: loginTimeoutMs(), maxBytes: 16384 });
      if (epoch !== generation) throw changed();
      if (!response.ok) throw serviceResponseError(response, 'Developer sign-in failed.');
      const body = response.body;
      const token = typeof body.token === 'string' ? body.token : '';
      const expiresAt = Date.parse(body.expiresAt || '');
      if (!token || token.length > 4096 || /[\s\0]/.test(token)) {
        throw error('Worker admin login response did not include a token.', 'AHT_ADMIN_RESPONSE_INVALID');
      }
      if (!Number.isFinite(expiresAt) || expiresAt <= now() + 30000) {
        throw error('Worker admin login response did not include a valid future expiresAt value.', 'AHT_ADMIN_RESPONSE_INVALID');
      }
      session = { token, expiresAt, base };
      return { ok: true, token, baseUrl: base, expiresAt: body.expiresAt, error: '' };
    } catch (cause) {
      return { ok: false, code: cause?.code || 'AHT_ADMIN_LOGIN_FAILED', error: cause?.code === 'AHT_SERVICE_TIMEOUT'
        ? 'Worker admin login timed out. Retry.' : cause?.message || 'Developer sign-in failed.' };
    }
  }
  function login(config, username = '', password = '') {
    // An explicit new sign-in is an authority change, unlike refreshing an
    // expired token for already-authorized panels. Older replies cannot win.
    clear();
    return performLogin(config, username, password);
  }
  async function ensure(config, { username = '', password = '', force = false } = {}) {
    const { base } = endpoint(config, 'admin/login');
    if (!force && session?.base === base && session.expiresAt > now() + 30000) return session.token;
    if (force) clear();
    if (pending.has(base)) return pending.get(base);
    const operation = performLogin(config, username, password).then(result => {
      if (!result.ok) throw error(`Worker admin login failed: ${result.error}`, result.code || 'AHT_ADMIN_LOGIN_FAILED');
      return result.token;
    }).finally(() => { if (pending.get(base) === operation) pending.delete(base); });
    pending.set(base, operation);
    return operation;
  }
  async function fetch(config, route, options = {}) {
    assertAuthenticated();
    const epoch = generation;
    const assertCurrent = () => { if (epoch !== generation) throw changed(); assertAuthenticated(); };
    const { base, url, relative } = endpoint(config, route);
    const loginRoute = relative.split('?')[0] === 'admin/login';
    let token = loginRoute ? '' : await ensure(config);
    assertCurrent();
    const send = currentToken => request(url, { method: options.method || 'GET',
      headers: { ...(options.headers || {}), ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}) },
      body: options.body, signal: options.signal, timeoutMs: 30000, maxBytes: 8 * 1024 * 1024 });
    let response = await send(token);
    assertCurrent();
    if (response.status === 401 && !loginRoute) {
      // Invalidate only the rejected token. Advancing the authority generation
      // here would cancel every other panel whose same token also expired.
      if (session?.base === base && session.token === token) session = null;
      assertCurrent();
      token = await ensure(config);
      assertCurrent();
      response = await send(token);
      assertCurrent();
    }
    if (!response.ok) {
      const playerDataRoutes = new Set(['admin/launcher-downloads', 'admin/player-records', 'admin/launcher-updates',
        'admin/session-reports', 'admin/player-ipv4-groups', 'admin/access-decisions']);
      if (response.status === 404 && playerDataRoutes.has(relative.split('?')[0])) {
        throw error('The configured Worker is missing the player-data API. Deploy the current AHT Worker before loading Player Data.', 'AHT_ADMIN_API_MISSING');
      }
      throw serviceResponseError(response, 'The developer service could not complete this request.');
    }
    return response.body;
  }
  return { login, ensure, fetch, clear, expiresAt: () => session?.expiresAt || 0 };
}
