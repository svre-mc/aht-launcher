import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
function declaration(start, end) {
  const offset = source.indexOf(start);
  assert(offset >= 0, `Missing ${start}`);
  const finish = source.indexOf(end, offset);
  assert(finish > offset, `Missing ${end}`);
  return source.slice(offset, finish);
}

const cache = new Map();
const writes = [];
let releaseBackground;
const context = vm.createContext({
  launchPreparationCache: cache,
  LAUNCH_PREPARATION_PROOF_MIN_VALIDITY_MS: 1000,
  identityPayload: async () => ({ minecraftUsername: 'auSavant' }),
  normalizeMinecraftUsername: (value) => String(value || '').trim(),
  writeSerializedRegisteredLauncherProof: async ({ nativeGuard }) => {
    writes.push(nativeGuard?.keyHash || 'unguarded');
    if (writes.length === 1) {
      return new Promise((resolve) => {
        releaseBackground = () => resolve({ usable: true, trusted: true, payload: {} });
      });
    }
    return {
      usable: true,
      trusted: true,
      payload: { nativeGuardKeyHash: nativeGuard.keyHash },
      nativeGuard: { protocol: 'AHT-GUARD-1', keyHash: nativeGuard.keyHash }
    };
  }
});
vm.runInContext(
  declaration('async function refreshPreparedLauncherProof(', '\nfunction scheduleLaunchPreparationProofRefresh('),
  context
);

const entry = {
  state: 'ready',
  launcherConfig: {},
  identity: { minecraftUsername: 'auSavant' },
  latest: {},
  installed: {}
};
cache.set('stable', entry);
const background = context.refreshPreparedLauncherProof('stable', entry);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(typeof releaseBackground, 'function');

const nativeGuard = { keyHash: 'a'.repeat(64) };
const play = context.refreshPreparedLauncherProof('stable', entry, nativeGuard);
releaseBackground();
await background;
const playProof = await play;

assert.deepEqual(writes, ['unguarded', nativeGuard.keyHash], 'Play must follow an unguarded in-flight refresh with a guard-bound refresh');
assert.equal(playProof.payload.nativeGuardKeyHash, nativeGuard.keyHash);
assert.equal(entry.launcherProof.payload.nativeGuardKeyHash, nativeGuard.keyHash);

const social = declaration('async function socialRequestContext(', '\nasync function launcherLegalStatus(');
assert(social.includes("'.aht-launcher', 'social'"), 'Social API proofs must use storage isolated from the Play proof');

const playHandler = source.slice(source.indexOf("ipcMain.handle('play:start'"), source.indexOf("ipcMain.handle('dialog:zip'"));
assert(playHandler.includes("proof?.nativeGuard?.protocol !== 'AHT-GUARD-1'"), 'Play must reject a proof without the live Phoenix descriptor');

let issuedAfterInteractiveWait = false;
context.releaseTarget = id => ({ id });
context.verifyPreparedClientIntegrityAtPlay = async (target, candidate) => {
  assert.equal(target.id, 'stable');
  assert.equal(candidate, entry);
  throw new Error('Modified client. Repair.');
};
context.writeSerializedRegisteredLauncherProof = async ({ beforeInteractiveRecoveryCompletes }) => {
  assert.equal(typeof beforeInteractiveRecoveryCompletes, 'function');
  await beforeInteractiveRecoveryCompletes();
  issuedAfterInteractiveWait = true;
};
await assert.rejects(context.refreshPreparedLauncherProof('stable', entry, nativeGuard, { allowInteractiveRecovery: true }), /Modified client/);
assert.equal(issuedAfterInteractiveWait, false, 'Changing the client during interactive recovery must not grant Play authorization.');
console.log('PASS: isolated Play proof, guarded refresh races and post-recovery integrity revalidation.');
