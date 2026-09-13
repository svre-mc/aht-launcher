/** UI status reads local state. Network recovery remains explicit or background work. */
export function createAccountStatusRefresh({ readLocal, refreshRemote, keyFor, shouldRefresh, onChanged = () => {},
  now = Date.now, retryIntervalMs = 5 * 60 * 1000 }) {
  const pending = new Map();
  const attempts = new Map();
  function queue(config, identity) {
    const key = keyFor(config, identity);
    if (!key || pending.has(key) || !shouldRefresh(config, identity)) return;
    const attemptedAt = attempts.get(key);
    if (attemptedAt != null && now() - attemptedAt < retryIntervalMs) return;
    attempts.set(key, now());
    // Only short cooldown metadata is retained, never identity snapshots or credentials.
    for (const [entry, timestamp] of attempts) if (now() - timestamp >= retryIntervalMs) attempts.delete(entry);
    const operation = Promise.resolve().then(() => refreshRemote(config, { allowProtectedStorage: true, forceAccountSync: false }))
      .catch(() => null).finally(() => {
        if (pending.get(key) === operation) pending.delete(key);
        try { onChanged(); } catch {}
      });
    pending.set(key, operation);
  }
  return {
    async read(config, { allowProtectedStorage = true, forceAccountSync = false } = {}) {
      if (forceAccountSync) return refreshRemote(config, { allowProtectedStorage, forceAccountSync: true });
      const identity = await readLocal(config, { allowProtectedStorage, allowRemoteSync: false });
      if (allowProtectedStorage) queue(config, identity);
      return identity;
    },
    idle: () => Promise.all([...pending.values()]),
    pendingCount: () => pending.size
  };
}
