import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createAccountStatusRefresh } from '../src/accountStatusRefresh.js';

test('actual status boundary returns local identity while remote synchronization remains stalled', async () => {
  const source = (await fs.readFile(process.env.AHT_STATUS_BASELINE || new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const begin = source.indexOf('async function identityForStatus(');
  const code = source.slice(begin, source.indexOf('\nfunction identityForRenderer(', begin));
  const identity = { installId: 'fixture', minecraftUsername: 'FixturePlayer' };
  let release;
  const network = new Promise(resolve => { release = resolve; });
  const identityPayload = async (_config, options) => {
    if (options.allowRemoteSync !== false) await network;
    return { ...identity };
  };
  const service = createAccountStatusRefresh({ readLocal: identityPayload, refreshRemote: identityPayload,
    keyFor: () => 'fixture', shouldRefresh: () => true });
  const context = vm.createContext({ identityPayload, accountStatusRefresh: service });
  vm.runInContext(code, context);
  const result = context.identityForStatus({}, null, true);
  let timer;
  const observed = await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve('blocked'), 100); })]);
  clearTimeout(timer);
  release();
  await result;
  await service.idle();
  assert.notEqual(observed, 'blocked');
  assert.equal(observed.minecraftUsername, identity.minecraftUsername);
});
