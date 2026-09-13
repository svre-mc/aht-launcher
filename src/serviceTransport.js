import { readBoundedJsonResponse } from './boundedJson.js';
export { readBoundedJsonResponse } from './boundedJson.js';

/** Bounded JSON transport for authenticated launcher-service requests.
 * Redirects are never followed: recovery headers are scoped to the configured origin.
 * This layer transports results; callers still validate ownership and signed proofs.
 */
export function serviceTransportError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export async function requestServiceJson(url, { fetchImpl = globalThis.fetch, method = 'POST', headers = {},
  body, timeoutMs = 20_000, maxBytes = 32_768, signal } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('The service request limits must be positive.');
  }
  const controller = new AbortController();
  let timer;
  let rejectBoundary;
  const boundary = new Promise((_resolve, reject) => { rejectBoundary = reject; });
  const stop = error => { controller.abort(error); rejectBoundary(error); };
  const cancelled = () => stop(serviceTransportError('AHT_SERVICE_CANCELLED', 'The player service request was cancelled.'));
  const operation = Promise.resolve().then(async () => {
    if (signal?.aborted) throw serviceTransportError('AHT_SERVICE_CANCELLED', 'The player service request was cancelled.');
    const response = await fetchImpl(url, { method, headers, body,
      signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response || typeof response.ok !== 'boolean') {
      throw serviceTransportError('AHT_SERVICE_RESPONSE_INVALID', 'The player service returned an invalid response.');
    }
    // Workers do not implement redirect:'error'. Manual mode must never turn
    // into a retry/follow: reject before parsing a redirect body or its URL.
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      void response.body?.cancel?.().catch(() => {});
      throw serviceTransportError('AHT_SERVICE_REDIRECT_BLOCKED', 'The player service returned an unexpected redirect.');
    }
    const parsed = await readBoundedJsonResponse(response, maxBytes);
    return { ok: response.ok, status: response.status, statusText: response.statusText || '', body: parsed };
  });
  timer = setTimeout(() => stop(serviceTransportError('AHT_SERVICE_TIMEOUT', 'The player service did not respond in time. Retry.')), timeoutMs);
  signal?.addEventListener('abort', cancelled, { once: true });
  try { return await Promise.race([operation, boundary]); }
  catch (error) {
    controller.abort();
    if (String(error?.code || '').startsWith('AHT_SERVICE_')) throw error;
    // Do not attach the fetch cause: it may contain an origin or request detail.
    throw serviceTransportError('AHT_SERVICE_UNAVAILABLE', 'The player service could not be reached. Retry.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelled);
  }
}

export function serviceResponseError(response, fallback = 'The player service could not complete this request.') {
  const suppliedCode = response.body?.code;
  const status = Number(response.status) || 0;
  const code = typeof suppliedCode === 'string' && /^[A-Z][A-Z0-9_]{2,95}$/.test(suppliedCode)
    ? suppliedCode : `AHT_SERVICE_HTTP_${status}`;
  const suppliedMessage = response.body?.error;
  const message = typeof suppliedMessage === 'string' && suppliedMessage.trim()
    ? suppliedMessage.replace(/[\r\n\0]/g, ' ').slice(0, 1024) : fallback;
  return serviceTransportError(code, message, { status });
}
