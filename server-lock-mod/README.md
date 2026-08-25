# AHT Launcher Lock

Forge 1.12.2 reconnect gate for private A Hard Time servers.

Install the same `aht-version-lock-*.jar` on the client pack and dedicated server. The launcher starts Minecraft with the path of its short-lived, Worker-signed launcher proof. The client mod sends only that compact signed token to the server; the server calls the authoritative Worker endpoint and accepts the connection only when all of these checks pass:

- proof signature, issuer, audience, expiry, and reconnect window;
- Minecraft username and UUID match the joining player;
- account/install/device access remains allowed;
- pack ID matches the server;
- proof launcher version meets the version in `launcher/latest.json`.

Acceptance belongs to one connection. A launcher release can raise the version floor without polling or kicking players who are already connected. Logout clears acceptance, so the next connection must be verified against the current floor. An outdated reconnect receives:

```text
Current Launcher Version: 0.1.86
Necessary Launcher Version: 0.1.87
Update A Hard Time Launcher, restart it, and reconnect.
```

The server fails closed on missing proof, identity mismatch, restricted access, timeout, malformed response, or Worker outage. Proof tokens and local proof paths are never logged. The token is not a server secret: the Worker signature and live server-side verification make client edits untrusted.

Server configuration is `config/aht_version_lock.cfg`. The release builder generates the deployment template at `server/aht_version_lock.cfg`; it contains the endpoint, pack ID, timeouts, and player-facing messages. Launcher-version policy is intentionally not duplicated in that file.

Build and deployment must use the reviewed AHT Java 8/ForgeGradle workflow documented by the AHT workspace guards. The project compiles against Forge `1.12.2-14.23.5.2847` and uses stable 1.12.2 networking/events compatible with the pack's 14.23.5.2860 runtime.
