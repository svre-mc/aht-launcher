import { setTimeout as delay } from 'node:timers/promises';

export function minecraftProfileReady(identity = {}) {
  const uuid = String(identity.minecraftUuid || identity.minecraftUUID || '').replace(/[{}-]/g, '');
  return /^[A-Za-z0-9_]{3,16}$/.test(identity.minecraftUsername || '')
    && /^[a-f0-9]{32}$/i.test(uuid) && !/^0{32}$/.test(uuid);
}

export function minecraftProfileRequiredError() {
  return Object.assign(new Error('AHT could not read the existing Minecraft profile. Open the Minecraft launcher you normally use, then retry Play.'),
    { code: 'MINECRAFT_PROFILE_REQUIRED' });
}

// Reads public profile metadata only. Microsoft authentication stays in Minecraft
// Launcher; device proof and authenticated server admission remain separate.
export function createMinecraftProfileSetup({ onState = () => {} } = {}) {
  let active = null;
  let state = { running: false };
  const publish = next => {
    state = next;
    try { onState({ ...state }); } catch {}
  };
  return {
    state: () => ({ ...state }),
    cancel: () => active?.abort.abort(),
    async run({ readIdentity, openLauncher, timeoutMs = 180000, pollMs = 1000 }) {
      if (active) throw Object.assign(new Error('Minecraft account setup is already running.'), { code: 'MINECRAFT_PROFILE_SETUP_BUSY' });
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid Minecraft account setup timeout.');
      const transaction = { abort: new AbortController() };
      active = transaction;
      const { signal } = transaction.abort;
      let timer;
      let rejectCancelled;
      const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
      const abort = () => rejectCancelled(Object.assign(new Error('Reading the Minecraft session was cancelled. Click Play to retry.'), { code: 'MINECRAFT_PROFILE_SETUP_CANCELLED' }));
      signal.addEventListener('abort', abort, { once: true });
      const bounded = work => Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), cancelled]);
      timer = setTimeout(() => rejectCancelled(minecraftProfileRequiredError()), timeoutMs);
      try {
        let identity = await bounded(readIdentity);
        if (minecraftProfileReady(identity)) return identity;
        publish({ running: true, title: 'Finding your Minecraft session', phase: 'waiting',
          message: 'AHT is opening your Minecraft Launcher to read its existing account selection. Leave it open; AHT will continue automatically when the profile is available.' });
        await bounded(openLauncher);
        while (true) {
          identity = await bounded(readIdentity);
          if (minecraftProfileReady(identity)) return identity;
          await bounded(() => delay(pollMs, undefined, { signal }));
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        transaction.abort.abort();
        if (active === transaction) active = null;
        publish({ running: false });
      }
    }
  };
}
