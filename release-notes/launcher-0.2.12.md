
## What changed

- Protected modpack files are verified at Play without repeating full content hashing during normal warm startup.
- Added, removed, renamed, or modified protected client files now stop Play and direct the player to Repair, while configuration, saves, and player-owned data remain untouched.
- Repair creates a reusable signed file baseline so later Play actions only hash files whose metadata changed.
- Launch reports now draw their diagnostic boundary at the actual Play click, preventing older Minecraft errors from being attributed to a new launch.
- Release validation now replaces stale launcher-lock JARs and requires the same authoritative lock on both client and server release surfaces.
- Public-facing integrity failures remain concise and do not expose internal service or storage details.
