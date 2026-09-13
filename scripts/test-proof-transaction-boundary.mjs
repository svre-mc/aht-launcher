import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const originalIdentity = { installId: 'fixture-install', minecraftUsername: 'AuditAlpha', minecraftUuid: 'a'.repeat(32) };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function fixture(write, inspect) {
  const source = (await fs.readFile(process.env.AHT_PROOF_QUEUE_BASELINE || new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const begin = source.indexOf('async function writeSerializedRegisteredLauncherProof(');
  const code = source.slice(begin, source.indexOf('\nasync function socialRequestContext(', begin));
  let identity = { ...originalIdentity };
  const context = vm.createContext({ path, process, launcherProofRefreshes: new Map(),
    runtimeIdentity: value => value, launcherProofIdentity: value => value,
    launcherProofPath: () => 'C:/fixture/proof.json', loadIdentity: async () => ({ ...identity }),
    inspectLauncherProof: inspect, writeRegisteredLauncherProof: write
  });
  if (!process.env.AHT_PROOF_QUEUE_BASELINE) {
    const { createLauncherProofTransactions } = await import('../src/launcherProofTransactions.js');
    context.launcherProofTransactions = createLauncherProofTransactions({ readIdentity: context.loadIdentity });
  }
  vm.runInContext(code, context);
  return { run: () => context.writeSerializedRegisteredLauncherProof({ config: { instanceDir: 'C:/fixture' }, identity: originalIdentity }),
    changeAccount: () => { identity = { ...identity, minecraftUsername: 'AuditBeta', minecraftUuid: 'b'.repeat(32) }; } };
}

test('queued proof issuance rejects an account that changed while it waited', async () => {
  const hold = deferred(), entered = deferred(); let writes = 0;
  const f = await fixture(async () => { writes++; entered.resolve(); await hold.promise; return {}; }, async () => ({ usable: true }));
  const first = f.run().catch(error => error);
  await entered.promise;
  const second = f.run().catch(error => error);
  f.changeAccount(); hold.resolve();
  await first;
  const result = await second;
  assert.equal(result.code, 'AHT_ACCOUNT_CHANGED'); assert.equal(writes, 1, 'Stale queued request must not overwrite the proof file');
});

test('proof-file serialization includes validation, not only the write', async () => {
  const inspection = deferred(), entered = deferred(); let writes = 0, checks = 0;
  const f = await fixture(async () => { writes++; return {}; }, async () => {
    if (++checks === 1) { entered.resolve(); await inspection.promise; } return { usable: true };
  });
  const first = f.run(); await entered.promise;
  const second = f.run();
  await new Promise(resolve => setImmediate(resolve));
  const duringInspection = writes;
  inspection.resolve(); await Promise.all([first, second]);
  assert.equal(duringInspection, 1, 'The next write must not race the preceding proof inspection');
  assert.equal(writes, 2);
});
