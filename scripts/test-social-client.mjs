import {
  fetchSocialState,
  normalizeSocialState,
  sendSocialAction,
  socialEndpoints
} from '../src/socialClient.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const config = {
  latestUrl: 'https://packs.example.test/latest.json',
  launcherProof: { baseUrl: 'https://worker.example.test/' },
  social: { enabled: true }
};
const identity = { minecraftUsername: 'SocialUser', installId: 'install-id-must-not-be-posted' };
const endpoints = socialEndpoints(config);
assert(endpoints.stateUrl === 'https://worker.example.test/api/social',
  `Social state endpoint was wrong: ${endpoints.stateUrl}`);
assert(endpoints.actionUrl === 'https://worker.example.test/api/social/actions',
  `Social action endpoint was wrong: ${endpoints.actionUrl}`);

const normalized = normalizeSocialState({
  username: 'SocialUser',
  friends: [
    { username: 'OfflineFriend', online: false },
    { username: 'OnlineFriend', online: true },
    { username: 'onlinefriend', online: false }
  ],
  requests: [{ username: 'RequestUser', online: true, server: 'Lobby', onlineSince: '2026-07-14T10:00:00.000Z' }]
}, { actionsAvailable: true });
assert(normalized.counts.friends === 2 && normalized.counts.online === 1
  && normalized.counts.requests === 1, `Normalized counts were wrong: ${JSON.stringify(normalized.counts)}`);
assert(normalized.friends[0].username === 'OnlineFriend' && normalized.friends[0].online,
  'Online friends must sort first.');
assert(normalized.requests[0].username === 'RequestUser', 'Pending friend request was not normalized.');
assert(normalized.requests[0].server === 'Lobby' && normalized.requests[0].onlineSince, 'Request presence details were not normalized.');

let listRequest = null;
const listed = await fetchSocialState({
  config,
  identity,
  proofToken: 'signed.launcher.proof',
  fetchImpl: async (url, options) => {
    listRequest = { url, options };
    return new Response(JSON.stringify({
      username: 'SocialUser',
      actionsAvailable: true,
      friends: [{ username: 'OnlineFriend', online: true }],
      requests: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
});
assert(listed.available && listed.actionsAvailable && listed.counts.online === 1,
  `Authenticated social list failed: ${JSON.stringify(listed)}`);
assert(listRequest.url === endpoints.stateUrl
  && listRequest.options.headers.Authorization === 'Bearer signed.launcher.proof',
  `Launcher proof was not used for social list: ${JSON.stringify(listRequest)}`);

const missingProof = await fetchSocialState({ config, identity, proofToken: '' });
assert(!missingProof.available && !missingProof.actionsAvailable,
  'Missing launcher proof must keep social data unavailable.');

let actionRequest = null;
const actionResult = await sendSocialAction({
  config,
  identity,
  proofToken: 'signed.launcher.proof',
  action: 'accept_friend',
  target: 'tArGeTuSeR',
  fetchImpl: async (url, options) => {
    actionRequest = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ ok: true, queued: true, message: 'Friend request acceptance queued.' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
assert(actionResult.ok && actionResult.queued, 'Social action was not accepted as queued.');
assert(actionRequest.url === endpoints.actionUrl
  && actionRequest.options.headers.Authorization === 'Bearer signed.launcher.proof',
  'Social action did not use launcher proof authentication.');
assert(actionRequest.body.action === 'accept_friend' && actionRequest.body.target === 'tArGeTuSeR'
  && !('username' in actionRequest.body) && !('installId' in actionRequest.body),
  `Renderer-controlled identity leaked into action body: ${JSON.stringify(actionRequest.body)}`);

const declineResult = await sendSocialAction({
  config,
  identity,
  proofToken: 'signed.launcher.proof',
  action: 'decline_friend',
  target: 'TargetUser',
  fetchImpl: async (url, options) => {
    actionRequest = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ ok: true, queued: true, message: 'Friend request decline queued.' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
assert(declineResult.ok && declineResult.queued && actionRequest.body.action === 'decline_friend', 'Launcher-side decline action was not accepted.');
await assertRejects(
  () => sendSocialAction({ config, identity, proofToken: 'proof', action: 'add_friend', target: 'TargetUser' }),
  /not available/i,
  'Launcher add-friend action must be rejected.'
);
await assertRejects(
  () => sendSocialAction({ config, identity, proofToken: 'proof', action: 'block_player', target: 'TargetUser' }),
  /not available/i,
  'Launcher block action must be rejected.'
);

async function assertRejects(run, pattern, message) {
  try {
    await run();
  } catch (error) {
    assert(pattern.test(error.message || String(error)), `${message} Got: ${error.message || error}`);
    return;
  }
  throw new Error(message);
}

console.log('social client tests passed');
