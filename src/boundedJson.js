/** Web-standard bounded JSON reader, shared by Electron and the account Worker. */
export async function readBoundedJsonResponse(response, maxBytes = 32_768) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('JSON size limit must be positive.');
  const failure = (code, message) => Object.assign(new Error(message), { code, status: response.status });
  const tooLarge = () => failure('AHT_SERVICE_RESPONSE_TOO_LARGE', 'The player service response exceeded its size limit.');
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  let text;
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const decode = (value, options) => {
      try { return decoder.decode(value, options); }
      catch {
        // Browsers/Workers do not expose Node's encoding-specific error code.
        throw failure('AHT_SERVICE_RESPONSE_INVALID', 'The player service returned an invalid response.');
      }
    };
    let bytes = 0;
    text = '';
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > maxBytes) throw tooLarge();
        text += decode(item.value, { stream: true });
      }
      text += decode();
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  } else {
    // Injected test transports only; real fetch uses the streamed path.
    text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    if (new TextEncoder().encode(text || '').byteLength > maxBytes) throw tooLarge();
  }
  let body;
  try { body = JSON.parse(text); } catch {
    throw failure('AHT_SERVICE_RESPONSE_INVALID', 'The player service returned an invalid response.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw failure('AHT_SERVICE_RESPONSE_INVALID', 'The player service returned an invalid response.');
  }
  return body;
}
