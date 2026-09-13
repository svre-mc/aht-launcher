/** Session-scoped reporting. Transport outages never become cheating findings. */
export function createPhoenixDetectionMonitor({ probe, report, fingerprint, isStopping = () => false,
  isSessionAlive = () => true, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs = 2500 }) {
  const sessions = new Map();
  function start(context) {
    const key = context?.nativeGuard?.keyHash;
    if (!key || !context?.launcherProof?.token) return null;
    const current = sessions.get(key);
    if (current) {
      // Reusing a native process must not keep reporting with an expired Play token.
      current.context = context;
      return current.operation;
    }
    const entry = { context, reported: new Set(), operation: null };
    entry.operation = Promise.resolve().then(async () => {
      let failures = 0;
      while (!isStopping() && isSessionAlive(entry.context.nativeGuard)) {
        let result;
        try { result = await probe(entry.context.nativeGuard); failures = 0; }
        catch { failures++; }
        if (isStopping()) break;
        if (result?.measurement?.state === 'tampered' && result.signedProbe) {
          const active = entry.context;
          const id = fingerprint(active.nativeGuard, result.measurement);
          if (!entry.reported.has(id)) {
            try {
              await report(active.config, active.launcherProof, active.nativeGuard, result);
              entry.reported.add(id);
              if (entry.reported.size > 256) entry.reported.delete(entry.reported.values().next().value);
            } catch { /* Keep unacknowledged evidence eligible for the next bounded attempt. */ }
          }
        }
        if (!isStopping() && isSessionAlive(entry.context.nativeGuard)) {
          await wait(Math.min(15000, pollMs * (failures ? 2 ** Math.min(failures, 3) : 1)));
        }
      }
    }).catch(() => {}).finally(() => {
      if (sessions.get(key) === entry) sessions.delete(key);
    });
    sessions.set(key, entry);
    return entry.operation;
  }
  return { start, get activeCount() { return sessions.size; } };
}
