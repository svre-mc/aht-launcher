# AHT access control and data security

## Security boundary

The Cloudflare Worker is the access-control authority. The player launcher may request a short-lived launch attestation, but it cannot sign one. The Minecraft server must reject missing, expired, incorrectly signed, or restricted attestations. Local launcher state is a cache and user-interface aid, not a server authorization source.

This design intentionally does not use kernel drivers, process scanning, code injection, obfuscation, WMI or registry serial harvesting, motherboard/disk/BIOS identifiers, MAC addresses, or antivirus bypass techniques. Those techniques would add privacy, support, and antivirus risk without making an Electron client a trustworthy anti-cheat boundary.

## Identity and enforcement scopes

Each launcher installation creates an Ed25519 key pair. The private key is stored in Electron `safeStorage`; only the public key and its SHA-256-derived `ahtd_...` identifier reach the Worker. Registration and launch requests carry fresh, purpose-bound signatures. The Worker verifies the public-key binding, timestamp, nonce, request binding, and signature.

Administrators can restrict or restore:

- Minecraft username/account;
- verified Minecraft UUID;
- cryptographic device-install identifier; or
- the current native IPv4 or IPv6 address.

Every change requires an administrator session, records the reason and actor, updates a current decision record, and writes an append-only audit event. Restrictions are checked before registration refresh and before launch-proof issuance. Account, UUID, device, IP, and IPv4 restrictions are also pushed as normalized SHA-256 digests whenever an administrator changes them. New connections are checked locally against the latest signed in-memory revision; already connected players are deliberately not kicked.

Telemetry is not an identity-recovery authority. In particular, an update event cannot rotate an account's registered install merely by presenting the account's public Minecraft UUID. Install recovery remains confined to the registration endpoint and requires the stored recovery credential, matching UUID, and the bound device assertion when present.

The device identifier is installation-bound, not an unresettable physical-hardware identifier. A user who erases launcher data can create a new key. For serious enforcement, apply account and UUID restrictions together with the device restriction; add an IP restriction only when its collateral impact is acceptable. Stronger physical-device claims require a separately reviewed native/TPM attestation system and must not be represented by this launcher.

## IP and VPN/proxy data

The connection IP comes from Cloudflare's `CF-Connecting-IP`/`CF-Connecting-IPv6` request metadata. The Worker preserves native IPv4 or IPv6 and does not trust a player-supplied IP field.

VPN/proxy state is confidence-bearing:

- `likely`: a configured ASN match or a configured network-intelligence service returned a VPN/proxy signal;
- `not_detected`: a configured intelligence service explicitly returned no VPN or proxy signal;
- `unknown`: no authoritative signal was available or the lookup failed.

The launcher never converts `unknown` into "not using a VPN." Automatic denial of `likely` connections is opt-in because VPN and hosting classifications can be wrong.

## Worker configuration

Required secrets:

- `LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8`
- `LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI` (public configuration is also acceptable)
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD` or `ADMIN_PASSWORD_SHA256`
- `ADMIN_TOKEN_SECRET` with at least 32 characters and no fallback to another secret
- `AHT_SOCIAL_SERVER_SECRET` with at least 32 characters when server social synchronization is enabled
- `AHT_LAUNCHER_STATE_SERVER_TOKEN` with at least 32 random characters; configure the same value only on the dedicated server

Rollout and optional policy values:

- `AHT_REQUIRE_DEVICE_ATTESTATION=true` after the device-capable launcher population has upgraded. Leave unset during the compatibility window.
- `AHT_VPN_ASNS=12345,67890` for high-confidence ASNs maintained by the operator.
- `AHT_NETWORK_INTELLIGENCE` as an optional Worker service binding. It receives connection IP plus Cloudflare ASN/organization/country/colo and returns `vpn`, `proxy`, `hosting`, `confidence`, and `source` fields.
- `AHT_BLOCK_LIKELY_VPN=true` only after reviewing classification quality and the appeal path. It is disabled by default.
- `AHT_ADMIN_RATE_LIMITER` as an optional Cloudflare Workers Rate Limiting binding. The example allows ten attempts per administrator username per minute in each Cloudflare location; a configured limiter fails closed if its binding errors.
- `AHT_PLAYER_API_RATE_LIMITER` as an optional per-connection-IP limit for registration, proof issuance, and telemetry writes. The example allows 120 requests per minute in each Cloudflare location; a configured limiter fails closed if its binding errors.
- `AHT_LAUNCHER_STATE` as the singleton `LauncherStateHub` SQLite Durable Object binding.
- `aht-launcher-release-events` as the Queue consumer, with `aht-launcher-release-events-dlq` as its dead-letter queue.
- An R2 `object-create` notification on the exact `launcher/latest.json` prefix to `aht-launcher-release-events`. Queue delivery is at least once; the Durable Object content revision makes duplicate delivery one effective push.

R2 organization:

- `accounts/usernames/`: current canonical player records;
- `accounts/uuids/`, `accounts/devices/`, `accounts/ipv4/`: lookup/index records;
- `access/decisions/`: current allow/deny state keyed by a hash of normalized scope and value;
- `access/audit/`: append-only decision history;
- `launcher-downloads/`, `launcher-updates/`, `telemetry/events/`: operational history.

## Local files

`launcher-proof.json` is a short-lived signed bearer document, not a signing secret. A player who controls the operating-system account can inspect any client file, command line, memory, or IPC channel. Hiding this document would therefore be obscurity, not an authorization boundary. The launcher stores only the canonical copy in launcher user-data, removes the old pack-local compatibility mirror, and relies on signature validation and expiry.

`managed-files.json` and `integrity.json` now live in launcher user-data rather than the Minecraft instance. More importantly, every player Play attempt requires a current full-client release and full-hashes the authoritative managed set derived from its client manifest only after verifying the exact SHA-256 and byte size declared by `latest.json`. A legacy release without that authoritative manifest fails closed. The local files are display/recovery state only and never authorize launch. Editing, replacing, forging, or deleting them cannot turn a modified managed file into a valid server authorization.

Account-recovery credentials, the device private key, and a migrated developer-login password are OS-protected. A legacy plaintext `developer.credentials.json` is rewritten without its plaintext password on first authenticated-capable launch. These secrets are never included in proof JSON, response payloads, renderer APIs, logs, or telemetry.

## Antivirus and release hygiene

No implementation can guarantee a zero-detection result on every scanning website. The release process should reduce false positives by:

- Authenticode-signing the Windows application and installer with a stable publisher certificate;
- refusing automated production publication when either Windows signature is invalid;
- notarizing/signing macOS releases;
- publishing stable filenames, versions, SHA-256 hashes, and release provenance;
- avoiding packers, obfuscators, hidden persistence, shell injection, serial-number scraping, and unsigned self-updaters; and
- submitting false-positive disputes to the detecting vendor with the signed artifact and hash rather than changing behavior to evade detection.

The GitHub workflow supports `WINDOWS_CERTIFICATE_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD`, and `WINDOWS_CERTIFICATE_NAME` and verifies signed artifacts when those credentials are configured. The project owner has explicitly accepted unsigned Windows releases; that exception must remain visible in release evidence because unsigned installers carry higher SmartScreen and false-positive risk.

## Operator rollout

1. Create the live and dead-letter Queues, deploy the Worker/SQLite Durable Object, and attach the exact R2 launcher-manifest notification.
2. Configure the attestation keys, the dedicated launcher-state server token, and the three rate-limit bindings.
3. Pin the public SPKI SHA-256 in the server-only config and provide the matching channel token through `AHT_LAUNCHER_STATE_TOKEN` or the server-only fallback setting.
4. Deploy Launcher Lock 1.2.0 as one reviewed, byte-identical paired JAR to the client pack and server.
5. Confirm the server receives a signed policy revision, then exercise a version-floor update and account/UUID/device/IP restrict/restore while retaining audit evidence.
6. Confirm an existing player remains connected, an outdated reconnect gets both current/necessary versions, and a current signed reconnect succeeds without any `/api/launcher-proof/verify` request.
7. Keep `AHT_REQUIRE_DEVICE_ATTESTATION=true` so new account registrations are device-bound too. V2 proof issuance itself always requires a fresh device assertion and never accepts a bare client version claim.
