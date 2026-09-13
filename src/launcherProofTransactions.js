const name = value => String(value || '').trim().toLowerCase();
const uuid = value => String(value || '').replaceAll('-', '').toLowerCase();
const failure = (code, message) => Object.assign(new Error(message), { code });

/** One proof-file transaction includes account validation, writing and inspection. */
export function createLauncherProofTransactions({ readIdentity, maximumPending = 8 }) {
  const queues = new Map();
  async function assertAccount(expected) {
    const current = await readIdentity();
    const expectedUuid = uuid(expected.minecraftUuid || expected.minecraftUUID);
    const currentUuid = uuid(current.minecraftUuid || current.minecraftUUID);
    if (current.installId !== expected.installId || name(current.minecraftUsername) !== name(expected.minecraftUsername)
        || (expectedUuid && currentUuid && expectedUuid !== currentUuid)) {
      throw failure('AHT_ACCOUNT_CHANGED', 'The Minecraft account changed. Retry Play.');
    }
  }
  function run(key, identity, { write, inspect }) {
    let queue = queues.get(key);
    if (!queue) { queue = { tail: Promise.resolve(), pending: 0 }; queues.set(key, queue); }
    if (queue.pending >= maximumPending) return Promise.reject(failure('AHT_PROOF_BUSY', 'Account verification is busy. Retry shortly.'));
    queue.pending++;
    const previous = queue.tail;
    const operation = previous.catch(() => {}).then(async () => {
      await assertAccount(identity);
      const result = await write();
      await assertAccount(identity);
      const verified = await inspect();
      await assertAccount(identity);
      if (!verified.usable) throw failure('AHT_PROOF_CHANGED', 'Launch authorization changed before it could be used. Retry Play.');
      return { ...result, ...verified, reused: false };
    }).finally(() => {
      if (--queue.pending === 0 && queues.get(key) === queue) queues.delete(key);
    });
    queue.tail = operation;
    return operation;
  }
  return { run, get pendingFiles() { return queues.size; } };
}
