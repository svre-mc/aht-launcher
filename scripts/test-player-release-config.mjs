import assert from 'node:assert/strict';
import { restorePlayerReleaseFeeds } from '../src/playerReleaseConfig.js';
const defaults = {
  latestUrl: 'https://api.ahardtime.net/latest.json',
  packs: { ptb: { latestUrl: 'https://api.ahardtime.net/ptb/latest.json' } },
  curseforge: { proxyBaseUrl: 'https://api.ahardtime.net/cf/' }
};
for (const broken of ['', 'file:///old/latest.json', 'https://old.example/other-pack/latest.json', defaults.packs.ptb.latestUrl]) {
  const config = { latestUrl: broken, instanceDir: 'C:\\AHT\\My Existing Pack', minecraftLauncher: { memoryMb: 8192 } };
  assert(restorePlayerReleaseFeeds(config, defaults));
  assert.equal(config.latestUrl, defaults.latestUrl);
  assert.equal(config.packs.ptb.latestUrl, defaults.packs.ptb.latestUrl);
  assert.equal(config.curseforge.proxyBaseUrl, defaults.curseforge.proxyBaseUrl);
  assert.equal(config.instanceDir, 'C:\\AHT\\My Existing Pack');
  assert.equal(config.minecraftLauncher.memoryMb, 8192);
  assert.equal(restorePlayerReleaseFeeds(config, defaults), false);
}
const configured = structuredClone(defaults);
assert.equal(restorePlayerReleaseFeeds(configured, {}), false);
assert.deepEqual(configured, defaults);
console.log('PASS: shipped player feeds repair blank, obsolete, local and wrong-channel saved addresses without changing game settings.');
