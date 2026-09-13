import fs from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { recoveryFailure, throwIfRecoveryCancelled, openRecoveryResultChannel } from './recoveryResultChannel.js';
import { RECOVERY_PROFILE_PREFIX, recoveryRoots, cleanRecoveryJournal,
  cleanRecoveryTransaction, prepareRecoveryProfiles } from './minecraftRecoveryProfile.js';

export function createMinecraftInteractiveRecovery({ resourceRoot = new URL('./resources/', import.meta.url), onState = () => {} } = {}) {
  let active = null;
  let publicState = { running: false };
  const publish = state => {
    publicState = state;
    // An observer cannot hold a security transaction open or bypass its cleanup.
    try { onState({ ...state }); } catch {}
  };
  return {
    state: () => ({ ...publicState }),
    cancel: () => active?.abort.abort(),
    cleanup: options => active ? Promise.resolve(false) : cleanRecoveryJournal(options),
    async run({ config, username, minecraftUuid, serverId, expiresAt, openLauncher, journalPath, timeoutMs = 240000 }) {
      const uuid = String(minecraftUuid || '').replaceAll('-', '').toLowerCase();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(username || '') || !/^[a-f0-9]{32}$/.test(uuid)
          || !/^[a-f0-9]{40}$/.test(serverId || '') || !Number.isFinite(timeoutMs) || timeoutMs < 1) {
        throw recoveryFailure('Account verification request is invalid.');
      }
      const roots = recoveryRoots(config);
      const key = JSON.stringify([username.toLowerCase(), uuid, serverId, roots]);
      if (active) {
        if (active.key === key) return active.promise;
        throw recoveryFailure('Another Minecraft account verification is already running.', 'AHT_ACCOUNT_RECOVERY_BUSY');
      }
      const abort = new AbortController();
      const execute = async () => {
        publish({ running: true, phase: 'preparing', username, message: 'Preparing Minecraft account verification.' });
        const pin = JSON.parse(await fs.readFile(new URL('account-recovery.json', resourceRoot), 'utf8'));
        const jar = await fs.readFile(new URL('account-recovery.jar', resourceRoot));
        if (!/^\d{1,8}$/.test(String(pin.version)) || !/^[a-f0-9]{64}$/.test(String(pin.sha256))
            || createHash('sha256').update(jar).digest('hex') !== pin.sha256) {
          throw recoveryFailure('Account verification helper could not be verified. Reinstall AHT Launcher.');
        }
        throwIfRecoveryCancelled(abort.signal);
        const remaining = Math.min(timeoutMs, expiresAt == null ? timeoutMs : Number(expiresAt) - Date.now() - 1000);
        if (!Number.isFinite(remaining) || remaining <= 0) throw recoveryFailure('Account verification expired. Retry account sync.');
        const channel = await openRecoveryResultChannel({ signal: abort.signal, timeoutMs: remaining, username });
        const id = RECOVERY_PROFILE_PREFIX + randomBytes(12).toString('hex');
        const entries = [];
        try {
          const args = ['--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--access-token', '${auth_access_token}',
            '--expected-name', username, '--expected-uuid', uuid, '--challenge', serverId, '--callback', channel.url];
          await prepareRecoveryProfiles({ config, roots, id, pin, jar, args, journalPath, entries, signal: abort.signal });
          throwIfRecoveryCancelled(abort.signal);
          channel.throwIfFailed();
          publish({ running: true, phase: 'waiting', username,
            message: `In Minecraft Launcher, select AHT Account Verification and click Play once as ${username}. AHT will finish automatically.` });
          throwIfRecoveryCancelled(abort.signal);
          // A stalled OS handoff must not own the result/timeout/cancel lifecycle.
          const handoff = Promise.resolve().then(() => {
            throwIfRecoveryCancelled(abort.signal);
            channel.throwIfFailed();
            return openLauncher(config);
          });
          await Promise.race([handoff, channel.result]);
          return await channel.result;
        } finally {
          publish({ running: true, phase: 'cleaning', username, message: 'Finishing Minecraft account verification.' });
          await channel.close();
          await cleanRecoveryTransaction({ id, entries, journalPath });
        }
      };
      // Own the transaction before execution; reentrant UI observers cannot start another one.
      const transaction = { key, abort, promise: null };
      active = transaction;
      transaction.promise = Promise.resolve().then(execute).finally(() => {
        if (active === transaction) active = null;
        publish({ running: false });
      });
      return transaction.promise;
    }
  };
}
