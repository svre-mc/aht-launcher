# AHT Launcher Lock

Forge 1.12.2 reconnect gate for private A Hard Time servers.

Version 1.2.2 intercepts Forge's final admission call before PlayerList/world
registration. Pending connections receive only bounded verification/control
traffic and keepalive responses; gameplay and world packets are withheld.
Signed launcher proof, the matching anti-cheat runtime audit and any required
Phoenix response must pass before the first JoinGame packet releases the gate.
There is no playable grace period. The existing crash-containment wrapper is
preserved. A timeout denies entry; it does not prove the player was cheating.

Deploy the matching anti-cheat client/server build with this version. Unit tests
cover both mapped/production Forge bytecode, crash-guard composition and packet
ordering; real packaged-runtime tests are also required for publication.

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

The server requests proof on the exact joining connection until it is accepted or the bounded join deadline expires. A temporarily unreadable proof file and a brief authenticated state-channel reconnect are retried without extending that deadline. The server remains fail-closed when the state channel is unavailable, stale, unsigned, unpinned, malformed, or inconsistent for the full deadline. Existing players are not rechecked or kicked. WebSocket protocol ping/pong maintains connection liveness without reading policy or waking the Durable Object.

Server configuration is `config/aht_version_lock.cfg`. Set the public SPKI SHA-256 pin and provide the server-only channel token through `AHT_LAUNCHER_STATE_TOKEN` (preferred) or the server-only config fallback. Never put that server config or token in a player artifact. The public-key fingerprint is not secret.

Build and deployment must use the reviewed AHT Java 8/ForgeGradle workflow documented by the AHT workspace guards. The project compiles against Forge `1.12.2-14.23.5.2847` and uses stable 1.12.2 networking/events compatible with the pack's 14.23.5.2860 runtime.
