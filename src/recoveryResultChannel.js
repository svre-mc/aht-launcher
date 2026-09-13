import http from 'node:http';
import { randomBytes } from 'node:crypto';

export const recoveryFailure = (message, code = 'AHT_ACCOUNT_RECOVERY_FAILED') =>
  Object.assign(new Error(message), { code });

export function throwIfRecoveryCancelled(signal) {
  if (signal?.aborted) throw recoveryFailure('Account verification cancelled.', 'AHT_ACCOUNT_RECOVERY_CANCELLED');
}

/** Result notification only. The account service independently verifies ownership. */
export async function openRecoveryResultChannel({ signal, timeoutMs, username }) {
  throwIfRecoveryCancelled(signal);
  const secret = randomBytes(32).toString('hex');
  let settled = false;
  let failureReason = null;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Cancellation may occur while profiles are prepared, before the caller awaits us.
  result.catch(() => {});
  const settle = (error, value) => {
    if (settled) return;
    settled = true;
    failureReason = error || null;
    error ? rejectResult(error) : resolveResult(value);
  };
  const onAbort = () => settle(recoveryFailure('Account verification cancelled.', 'AHT_ACCOUNT_RECOVERY_CANCELLED'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (settled || request.method !== 'POST' || request.headers.origin
        || request.headers.host !== `127.0.0.1:${server.address()?.port}`
        || request.url !== `/complete/${secret}`) {
      response.writeHead(404).end();
      return;
    }
    let size = 0;
    const chunks = [];
    const requestDeadline = setTimeout(() => request.destroy(), 5000);
    request.once('close', () => clearTimeout(requestDeadline));
    request.on('error', () => {});
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 256) { request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      clearTimeout(requestDeadline);
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { response.writeHead(400).end(); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'result')
          || !['verified', 'failed', 'wrong-account'].includes(value.result)) {
        response.writeHead(400).end();
        return;
      }
      if (settled) { response.writeHead(409).end(); return; }
      response.writeHead(204).end();
      if (value.result === 'verified') settle(null, { verified: true, source: 'minecraft-launcher-session' });
      else settle(recoveryFailure(value.result === 'wrong-account'
        ? `Select ${username} in Minecraft Launcher, then retry account sync.`
        : 'Minecraft could not verify this account. Retry account sync.'));
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('error', () => settle(recoveryFailure('Account verification connection failed. Retry account sync.')));
  let timer;
  const close = async () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (!settled) onAbort();
  };
  try {
    await new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', listening); reject(error); };
      const listening = () => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', listening);
      server.listen(0, '127.0.0.1');
    });
    throwIfRecoveryCancelled(signal);
    timer = setTimeout(() => settle(recoveryFailure('Account verification timed out. Retry account sync.',
      'AHT_ACCOUNT_RECOVERY_TIMEOUT')), timeoutMs);
    return { result, url: `http://127.0.0.1:${server.address().port}/complete/${secret}`, close,
      throwIfFailed: () => { if (failureReason) throw failureReason; } };
  } catch (error) {
    await close();
    throw error;
  }
}
