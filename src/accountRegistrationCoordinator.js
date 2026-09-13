/** Coordinates account registration, not Play proof or client-integrity authority. */
export function createAccountRegistrationCoordinator({ loadIdentity, register, normalizeUsername,
  normalizeUuid, baseUrl, matches }) {
  const pending = new Map();
  const failure = () => Object.assign(new Error('The Minecraft account changed. Retry account sync.'), { code: 'AHT_ACCOUNT_CHANGED' });
  const keyFor = (config, identity, username, options) => JSON.stringify([
    String(identity.installId || ''), normalizeUsername(username).toLowerCase(),
    normalizeUuid(options.minecraftUuid || identity.minecraftUuid || identity.minecraftUUID), baseUrl(config)
  ]);
  const assertInstallation = (identity, current, name, options) => {
    if (String(identity.installId || '') !== String(current.installId || '')) throw failure();
    const supplied = normalizeUuid(options.minecraftUuid);
    const saved = normalizeUuid(current.minecraftUuid || current.minecraftUUID);
    const originalName = normalizeUsername(identity.minecraftUsername).toLowerCase();
    const currentName = normalizeUsername(current.minecraftUsername).toLowerCase();
    const originalUuid = normalizeUuid(identity.minecraftUuid || identity.minecraftUUID);
    const expectedUuid = supplied || (originalName === name.toLowerCase() ? originalUuid : '');
    const unchanged = originalName === currentName && originalUuid === saved;
    // A successful intentional account switch may replace the starting snapshot,
    // but no unrelated account may inherit a completed registration result.
    if (!unchanged && (currentName !== name.toLowerCase() || (expectedUuid && saved !== expectedUuid))) throw failure();
    if (supplied && saved && normalizeUsername(current.minecraftUsername).toLowerCase() === name.toLowerCase()
        && supplied !== saved) throw failure();
  };
  function begin(key, config, identity, username, options) {
    const transaction = { interactive: options.allowInteractiveRecovery === true,
      force: options.forceRemoteRegistration === true, usedInteractiveRecovery: false, promise: null };
    transaction.promise = Promise.resolve().then(async () => {
      const current = await loadIdentity();
      assertInstallation(identity, current, username, options);
      // Durable confirmation is sufficient only for non-forced synchronization.
      // A stale success cache must never override a newer warning or account change.
      if (!transaction.force && matches(config, current, username, options.minecraftUuid)) {
        return { ok: true, username: current.minecraftUsername,
          minecraftUuid: normalizeUuid(current.minecraftUuid || current.minecraftUUID),
          remote: { skipped: true, reason: 'registration already confirmed' } };
      }
      const result = await register(username, { ...options, config, expectedInstallId: identity.installId,
        beforeInteractiveRecoveryCompletes: async () => { transaction.usedInteractiveRecovery = true; } });
      assertInstallation(identity, await loadIdentity(), username, options);
      return result;
    }).finally(() => {
      if (pending.get(key) === transaction) pending.delete(key);
    });
    pending.set(key, transaction);
    return transaction;
  }
  return {
    pendingCount: () => pending.size,
    async run(config = {}, identity = {}, username = '', options = {}) {
      const name = normalizeUsername(username);
      const key = keyFor(config, identity, name, options);
      let upgraded = false;
      for (;;) {
        const transaction = pending.get(key) || begin(key, config, identity, name, options);
        let result;
        try { result = await transaction.promise; }
        catch (error) {
          // One explicit caller can upgrade a failed cache-only attempt. Never
          // turn cancellation of a shared interactive prompt into a new prompt.
          if (!upgraded && options.allowInteractiveRecovery && !transaction.interactive
              && error?.code !== 'AHT_ACCOUNT_CHANGED') {
            upgraded = true;
            continue;
          }
          throw error;
        }
        if (!upgraded && options.forceRemoteRegistration && !transaction.force && result?.remote?.skipped) {
          upgraded = true;
          continue;
        }
        if (options.forceRemoteRegistration && result?.remote?.skipped) {
          throw Object.assign(new Error('Account verification is busy. Retry account sync.'), { code: 'AHT_ACCOUNT_SYNC_BUSY' });
        }
        // Each waiting Play/Repair owns its own client state. Sharing account
        // verification must not drop another caller's post-interaction recheck.
        if (transaction.usedInteractiveRecovery) await options.beforeInteractiveRecoveryCompletes?.();
        await assertInstallation(identity, await loadIdentity(), name, options);
        return result;
      }
    }
  };
}
