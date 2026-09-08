/** Bound both request and response-body stalls, including streaming asset uploads. */
export async function githubPublishRequest(fetchImpl, url, options, consume, {
  label = 'GitHub request', idleTimeoutMs = 30_000, requestTimeoutMs = 30_000,
  onBytes = () => {}, onBodyComplete = () => {}
} = {}) {
  const controller = new AbortController();
  let idleTimer;
  let totalTimer;
  const source = options.body;
  const streaming = Boolean(source && typeof source !== 'string' && source[Symbol.asyncIterator]);
  let expired = false;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const expire = (reason) => {
    expired = true;
    rejectDeadline(new Error(`${label}: ${reason}. GitHub did not finish publishing the mirror.`));
    controller.abort();
    if (streaming) source.destroy?.();
  };
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire(`no progress for ${Math.ceil(idleTimeoutMs / 1000)} seconds`), idleTimeoutMs);
  };
  function body() {
    const iterator = source[Symbol.asyncIterator]();
    let finished = false;
    return new ReadableStream({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done || expired) {
            if (!finished && !expired) {
              finished = true;
              touch();
              onBodyComplete();
            }
            controller.close();
            return;
          }
          const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
          touch();
          onBytes(chunk.byteLength);
          controller.enqueue(chunk);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.();
        source.destroy?.();
      }
    });
  }
  touch();
  totalTimer = setTimeout(() => expire('request time limit reached'), requestTimeoutMs);
  try {
    return await Promise.race([
      (async () => {
        try {
          const response = await fetchImpl(url, { ...options, signal: controller.signal, ...(streaming ? { body: body() } : {}) });
          touch();
          return await consume(response);
        } catch (error) {
          if (expired) throw error;
          const message = error?.message || String(error);
          throw new Error(`${label} failed: ${message}`, { cause: error });
        }
      })(),
      deadline
    ]);
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (streaming) source.destroy?.();
  }
}
