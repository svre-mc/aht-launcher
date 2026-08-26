# AHT Launcher Lock

Forge 1.12.2 reconnect gate for private A Hard Time servers.

Install the same `aht-version-lock-*.jar` on the client pack and dedicated server. The client sends only a compact Worker-signed token. The dedicated server verifies that token locally against a signed in-memory state snapshot delivered over one authenticated WebSocket.

The game server never asks the Worker to verify individual players. R2 emits one Queue event when `launcher/latest.json` changes; the Queue refreshes one Durable Object; the Durable Object revision-deduplicates the event and pushes the new signed floor to the connected server. Registration changes and access decisions use the same channel. A reconnect also receives a fresh full snapshot so an offline server cannot miss an update.

Each new connection must pass all of these checks:

- exact RS256 signature, key ID, issuer, audience, timestamps, and reconnect window;
- a Worker-confirmed launcher-version authority bound to the encrypted device signing key;
- Minecraft username and UUID match the joining connection;
- signed install/device claims match the pushed hashed registration binding;
- pushed account, UUID, device, IP, IPv4, and optional VPN restrictions remain clear;
- pack ID matches the server;
- the signed launcher version meets the separately signed pushed version floor.

A text version sent by a client is never accepted as policy or proof. Editing the token payload invalidates its RSA signature. The Worker also requires the launcher version inside the short-lived Ed25519 device assertion before issuing the RSA proof. This is a strong software identity boundary, but it is not TPM or kernel attestation; software alone cannot prove an executable is untampered against a fully privileged local attacker.

Acceptance belongs to one connection. A launcher update does not kick players who are already online. Logout clears acceptance, so the next connection is checked against the current in-memory revision. An outdated reconnect receives:

```text
Current Launcher Version: 0.1.86
Necessary Launcher Version: 0.1.87
Update A Hard Time Launcher, restart it, and reconnect.
```

The server fails closed for new joins when the authenticated state channel is unavailable, stale, unsigned, unpinned, malformed, or inconsistent. Existing players are not rechecked or kicked. WebSocket protocol ping/pong maintains connection liveness without reading policy or waking the Durable Object.

Server configuration is `config/aht_version_lock.cfg`. Set the public SPKI SHA-256 pin and provide the server-only channel token through `AHT_LAUNCHER_STATE_TOKEN` (preferred) or the server-only config fallback. Never put that server config or token in a player artifact. The public-key fingerprint is not secret.

Build and deployment must use the reviewed AHT Java 8/ForgeGradle workflow documented by the AHT workspace guards. The project compiles against Forge `1.12.2-14.23.5.2847` and uses stable 1.12.2 networking/events compatible with the pack's 14.23.5.2860 runtime.
