import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFile } from './utils.js';

const valid = value => value && typeof value === 'object' && !Array.isArray(value)
  && typeof value.installId === 'string' && value.installId.trim().length > 0;
const fail = (message, code) => Object.assign(new Error(message), { code });
const unreadable = () => fail('Launcher account data could not be read. Your existing data has been preserved.', 'AHT_IDENTITY_UNREADABLE');

/** One process owns identity writes; callers receive snapshots, never the cached object. */
export function createLauncherIdentityStore({ file, legacyFiles = () => [], readJson = readJsonFile,
  writeJson = writeJsonFile, createId = randomUUID }) {
  let tail = Promise.resolve();
  let sharedRead = null;
  const enqueue = work => {
    const operation = tail.then(work);
    tail = operation.catch(() => {});
    return operation;
  };
  async function readOrInitialize() {
    const target = file();
    try {
      const current = await readJson(target);
      if (!valid(current)) throw unreadable();
      return current;
    } catch (error) {
      // Only an absent file permits initialization/migration. Parse errors,
      // permission failures and invalid data must never rotate identity silently.
      if (error.code !== 'ENOENT') throw unreadable();
    }
    for (const candidate of legacyFiles()) {
      if (!candidate || candidate === target) continue;
      const existing = await readJson(candidate).catch(() => null);
      if (!valid(existing)) continue;
      const migrated = structuredClone(existing);
      await writeJson(target, migrated);
      return migrated;
    }
    const identity = { installId: createId(), createdAt: new Date().toISOString() };
    if (!valid(identity)) throw unreadable();
    await writeJson(target, identity);
    return identity;
  }
  return {
    async read() {
      if (!sharedRead) {
        const operation = enqueue(readOrInitialize);
        sharedRead = operation;
        operation.finally(() => { if (sharedRead === operation) sharedRead = null; }).catch(() => {});
      }
      return structuredClone(await sharedRead);
    },
    async mutate(update, { expectedInstallId } = {}) {
      // New readers must wait for this mutation instead of sharing an older read.
      sharedRead = null;
      return enqueue(async () => {
        const current = await readOrInitialize();
        if (expectedInstallId != null && current.installId !== expectedInstallId) {
          throw fail('The Minecraft account changed. Retry account sync.', 'AHT_ACCOUNT_CHANGED');
        }
        const next = await update(structuredClone(current));
        if (next == null) return structuredClone(current);
        if (!valid(next) || next.installId !== current.installId) {
          throw fail('Launcher account identity cannot be replaced by this operation.', 'AHT_IDENTITY_REPLACEMENT_DENIED');
        }
        if (JSON.stringify(next) !== JSON.stringify(current)) await writeJson(file(), next);
        return structuredClone(next);
      });
    }
  };
}
