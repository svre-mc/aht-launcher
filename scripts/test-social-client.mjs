import { fetchSocialState, sendSocialAction } from '../src/socialClient.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertRejects(fn, pattern, message) {
  try {
    await fn();
  } catch (error) {
    assert(pattern.test(error.message || String(error)), message || `Unexpected rejection: ${error.message || error}`);
    return;
  }
  throw new Error(message || 'Expected rejection.');
}

const identity = {
  minecraftUsername: 'AHT_User',
  installId: 'install-123'
};

const unavailable = await fetchSocialState({
  config: {},
  identity
});
assert(unavailable.available === false, 'Missing social feed should return unavailable state.');
assert(unavailable.counts.friends === 0 && unavailable.counts.blocked === 0, 'Unavailable state should not invent social entries.');

let requestedFeed = '';
const listed = await fetchSocialState({
  config: {
    latestUrl: 'https://packs.example.test/latest.json',
    social: {
      feedUrl: 'social/{username}.json',
      actionUrl: 'api/social/{action}/{target}'
    }
  },
  identity,
  readJson: async (source) => {
    requestedFeed = source;
    return {
      username: 'AHT_User',
      updatedAt: '2026-07-01T12:00:00.000Z',
      online: ['FriendOne'],
      friends: ['FriendOne', { username: 'FriendTwo', online: false }],
      blockedPlayers: { one: { username: 'BlockedOne' } }
    };
  }
});

assert(requestedFeed === 'https://packs.example.test/social/AHT_User.json', `Relative social feed resolved incorrectly: ${requestedFeed}`);
assert(listed.available === true, 'Configured social feed should be available.');
assert(listed.actionsAvailable === true, 'Configured action endpoint should enable launcher actions.');
assert(listed.counts.friends === 2, 'Friend count should be normalized.');
assert(listed.counts.online === 1, 'Online count should be normalized.');
assert(listed.counts.blocked === 1, 'Blocked count should be normalized.');
assert(listed.friends[0].username === 'FriendOne' && listed.friends[0].online, 'Online friends should sort first.');

const fileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-social-file-feed-'));
try {
  const latestPath = path.join(fileRoot, 'latest.json');
  const socialDir = path.join(fileRoot, 'social');
  await fs.mkdir(socialDir, { recursive: true });
  await fs.writeFile(latestPath, '{}\n', 'utf8');
  await fs.writeFile(path.join(socialDir, 'AHT_User.json'), JSON.stringify({
    generatedAt: '2026-07-02T00:00:00.000Z',
    friendList: ['FileFriendOff', { username: 'FileFriendOn', connected: true }],
    blocked: ['FileBlocked']
  }), 'utf8');
  const fileListed = await fetchSocialState({
    config: {
      latestUrl: pathToFileURL(latestPath).toString()
    },
    latest: {
      social: {
        feedUrl: 'social/{username}.json'
      }
    },
    identity
  });
  assert(fileListed.available === true, 'File-backed social feed should be available.');
  assert(fileListed.actionsAvailable === false, 'Read-only file-backed social feed should not claim actions are available without actionUrl.');
  assert(fileListed.counts.friends === 2 && fileListed.counts.online === 1 && fileListed.counts.blocked === 1, 'File-backed social feed counts should be normalized.');
  assert(fileListed.friends[0].username === 'FileFriendOn', 'File-backed social feed should sort online friends first.');
  assert(fileListed.blocked[0].username === 'FileBlocked', 'File-backed social feed should normalize blocked players.');
} finally {
  await fs.rm(fileRoot, { recursive: true, force: true });
}

const unreadable = await fetchSocialState({
  config: {
    latestUrl: 'https://packs.example.test/latest.json',
    social: {
      feedUrl: 'social/{username}.json',
      actionUrl: 'api/social/{action}/{target}'
    }
  },
  identity,
  readJson: async () => {
    throw new SyntaxError('Unexpected end of JSON input');
  }
});
assert(unreadable.available === false, 'Unreadable social feed should return unavailable state instead of throwing.');
assert(unreadable.actionsAvailable === false, 'Unreadable social feed should disable launcher friend actions.');
assert(unreadable.message.includes('Friend service could not be read yet'), `Unreadable social feed should use friendly wording: ${unreadable.message}`);

await assertRejects(
  () => sendSocialAction({ config: {}, identity, action: 'block_player', target: 'BlockedTwo' }),
  /not available/i,
  'Launcher must reject block-player actions.'
);

let posted = null;
const actionResult = await sendSocialAction({
  config: {
    latestUrl: 'https://packs.example.test/latest.json',
    social: {
      actionUrl: 'api/social/{action}/{target}'
    }
  },
  identity,
  action: 'add_friend',
  target: 'FriendThree',
  fetchImpl: async (url, options) => {
    posted = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      friends: [{ username: 'FriendThree', online: true }],
      blocked: []
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

assert(posted.url === 'https://packs.example.test/api/social/add_friend/FriendThree', `Action URL resolved incorrectly: ${posted.url}`);
assert(posted.options.method === 'POST', 'Social actions must POST.');
assert(posted.body.username === 'AHT_User' && posted.body.installId === 'install-123', 'Social action payload must identify the launcher user.');
assert(actionResult.ok && actionResult.social?.friends?.[0]?.username === 'FriendThree', 'Social action should return normalized state when the endpoint responds with it.');

console.log('social client tests passed');
