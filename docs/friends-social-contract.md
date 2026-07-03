# AHT Launcher Friends Contract

The launcher reads friends data from `config.social` or from the live `latest.json` `social` block. The live feed may stay disabled until the server mod exists.

```json
{
  "social": {
    "enabled": true,
    "feedUrl": "https://example.com/social/{username}.json",
    "actionUrl": "https://example.com/api/social/{action}/{target}"
  }
}
```

Template fields:

- `{username}` is the current Minecraft username registered in the launcher.
- `{installId}` is the launcher install id.
- `{action}` is one of `add_friend`, `remove_friend`, or `unblock_player`.
- `{target}` is the target Minecraft username.

The launcher deliberately does not send a block-player action. Blocking should come from the in-game mod only.

## Friends Feed

`feedUrl` must return JSON. This is the preferred shape:

```json
{
  "username": "PlayerOne",
  "updatedAt": "2026-07-01T12:00:00.000Z",
  "friends": [
    { "username": "FriendOne", "online": true },
    { "username": "FriendTwo", "online": false }
  ],
  "blockedPlayers": [
    "BlockedOne"
  ]
}
```

Accepted aliases:

- `friendList` can be used instead of `friends`.
- `blocked` can be used instead of `blockedPlayers`.
- `online`, `onlineFriends`, or `onlinePlayers` can be provided as a username list if friend rows do not include `online`.
- The response may also be wrapped as `{ "social": { ... } }`.

The launcher sorts online friends first, shows total friends, online friends, and blocked players, and treats a missing feed as "Friend service not connected" instead of blocking play.

Usernames must be normal Minecraft Java usernames: 3 to 16 characters, using only letters, numbers, and underscores. Invalid names are ignored instead of shown.

## File-Backed Server Feed

If the server mod writes a JSON file instead of serving an API directly, expose that file through the same shape as `feedUrl`. For development this can be a `file://` URL relative to a local `latest.json`; for real players it should normally be served over HTTPS by the server/website/Worker because players cannot read a private file on the Linux server.

Recommended server behavior:

- Write one small per-player JSON snapshot such as `social/PlayerOne.json`.
- Update the file only when friends, blocks, or online state changes.
- Write to a temporary file and rename it over the old file atomically.
- Keep the feed read-only unless an `actionUrl` endpoint exists.

The launcher reads the feed when the friends panel opens or when Refresh is clicked. It does not constantly poll the server.

If the launcher catches the file while it is missing, locked, or malformed, it shows the friends service as temporarily unavailable and disables launcher-side friend actions for that refresh. It does not block play.

## Friend Actions

`actionUrl` receives a `POST` with JSON:

```json
{
  "action": "add_friend",
  "target": "FriendThree",
  "username": "PlayerOne",
  "installId": "launcher-install-id"
}
```

Allowed actions:

- `add_friend`
- `remove_friend`
- `unblock_player`

The endpoint can return either `{ "ok": true }` or the updated social state:

```json
{
  "social": {
    "username": "PlayerOne",
    "friends": [{ "username": "FriendThree", "online": true }],
    "blockedPlayers": []
  }
}
```

For a file-backed server mod, keep writes atomic: write a temporary JSON file, then rename it over the public file. That lets the launcher read without seeing half-written JSON.
