# AHT Launcher Attestation Contract

Current protocol: `aht-launcher-attestation-v2`

The launcher requests a short-lived account attestation from the Cloudflare Worker immediately before Play. Only the Worker holds the signing key. The launcher and Minecraft client never contain a signing secret and cannot create a trusted attestation offline.

## Key contract

- JWS algorithm: `RS256` (`SHA256withRSA`)
- Protected header: `{"alg":"RS256","typ":"AHT-LAUNCHER-ATTESTATION","kid":"aht-launcher-attestation-v2"}`
- Worker secret: `LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8` (unencrypted PKCS#8 PEM)
- Worker/server public key: `LAUNCHER_ATTESTATION_PUBLIC_KEY_SPKI` (SPKI PEM)
- Fixed issuer: `aht-launcher-worker`
- Fixed audience: `aht-minecraft-server`
- Fixed default pack ID: `a-hard-time-dregora`
- Maximum lifetime: 10 minutes
- Compact JWS limits: 8192 total characters; 1024 header, 6144 payload, and 1024 signature characters

`LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8` must be installed with `wrangler secret put`; it must never be committed, written to launcher configuration, packaged into an installer, logged, or copied to the Minecraft client/server. The server receives only the public SPKI key.

## Player issuance

For a player-channel v2 request, the Worker requires all of the following:

1. A registered Minecraft username.
2. The registered launcher `installId`.
3. The account recovery credential in the `X-AHT-Launcher-Recovery` request header, matching the verifier already stored with the registration.
4. A valid Minecraft UUID stored in that registration.
5. When the account is device-bound (or `AHT_REQUIRE_DEVICE_ATTESTATION=true`), a fresh Ed25519 `aht-device-assertion-v1` bound to the exact launch request.
6. No active account, Minecraft UUID, device, or connection-IP restriction and no enabled network policy denial.

The recovery credential is request-only. It is never included in the request JSON, signed payload, proof file, response, or logs. The Worker ignores a client-supplied UUID and signs the UUID from its registration record.

This proves control of the AHT launcher registration and its recovery credential; it is not a replacement for Microsoft/Mojang OAuth. At join time, the dedicated server's online-mode session authentication remains the authority for the connecting Minecraft UUID, and the attestation must match that authenticated UUID.

The Worker generates `jti`, `launchId`, `issuedAt`, and `expiresAt`. `jti` and `launchId` are the same random UUID. The Worker also supplies the fixed issuer, audience, and pack ID.

## Signed v2 payload

```json
{
  "protocol": "aht-launcher-attestation-v2",
  "schemaVersion": 2,
  "jti": "<worker-generated UUID>",
  "launchId": "<same worker-generated UUID>",
  "issuedAt": "2026-08-14T00:00:00.000Z",
  "expiresAt": "2026-08-14T00:10:00.000Z",
  "issuer": "aht-launcher-worker",
  "audience": "aht-minecraft-server",
  "packId": "a-hard-time-dregora",
  "packVersion": "<installed pack version>",
  "minecraftUsername": "PlayerName",
  "minecraftUuid": "01234567-89ab-4def-8123-456789abcdef",
  "installId": "<launcher install id>",
  "deviceId": "ahtd_<SHA-256 of Ed25519 public key>",
  "launcherVersion": "<launcher version>",
  "launcherChannel": "player",
  "developerClient": false,
  "developerClientBypass": false,
  "modIntegrityBypass": false,
  "accessGranted": true,
  "networkStatus": "unknown"
}
```

The proof document has `trusted: true` and `source: "worker"`. Its `token` is the compact JWS. The launcher performs strict structural and request/response checks, but the Minecraft server is the enforcement authority and must verify the RSA signature.

For immediate restriction checks, the server may send the compact token as `Authorization: Bearer <token>` to `GET /api/launcher-proof/verify`. The Worker verifies the signature, expiry, current account registration, device binding, and current account/UUID/device/IP access decisions. A server that verifies only the RSA signature locally must accept that a newly issued restriction can take effect no later than the proof's ten-minute expiry; it should use the Worker verification endpoint when immediate revocation is required.

The Worker-authoritative claims are the account username/UUID binding, install/recovery/device binding, access decision, key/header, IDs, times, issuer, audience, pack ID, and channel authorization. Version, platform, architecture, instance-path hash, and Minecraft-loader context originate in the launcher request; a valid signature prevents later alteration but does not independently prove those client observations.

## JVM properties and proof files

```text
-Daht.launcher.present=true
-Daht.launcher.protocol=aht-launcher-attestation-v2
-Daht.launcher.proofFile=<absolute channel-specific proof path>
```

Canonical proof files live in launcher user data. Pack-local compatibility mirrors are disabled and stale mirrors are removed by default. A mirror can be re-enabled only with the explicit `launcherProof.legacyInstanceMirror` compatibility option. Historical names were:

```text
Player:    <instance>/.aht-launcher/launcher-proof.json
Developer: <instance>/.aht-launcher/launcher-proof.developer.json
```

## Server verification

The server must fail closed unless all checks pass:

1. Parse exactly three compact-JWS segments and require the exact v2 header values.
2. Verify `SHA256withRSA` with the configured public SPKI key.
3. Require protocol/schema, issuer, audience, pack ID, username, Minecraft UUID, channel, and boolean claims to match the joining session.
4. Require `accessGranted === true` and a recognized network-status value. When device attestation is required, also require a valid `ahtd_` device identifier. Treat all other values as denial, not as a warning.
5. Require a valid issue/expiry window no longer than 10 minutes and reject future or expired tokens.
6. Require `jti === launchId`, both formatted as a UUID.
7. Record `jti` with the authenticated Minecraft UUID and expiry in a bounded replay cache. A reconnect by that same UUID may reuse the still-valid proof; reuse by any different UUID is rejected.

Client integrity reports remain signals; they are not allowed to create or alter an attestation.

## Rolling v1 compatibility

Old launchers omit the v2 protocol and therefore receive legacy `aht-launcher-proof-v1`/HS256 responses while the compatibility window is open. A new launcher explicitly requests v2, but accepts an exact remote v1 response from an old Worker. It never creates a local HMAC proof and rejects `source: "local-hmac"`.

Roll out in this order: deploy the v2-capable server verifier first with ordinary-player strict enforcement disabled; configure its public key; deploy the Worker with the matching private key while retaining remote v1 issuance for old launchers; then distribute launcher 0.1.85. Enable strict ordinary-player v2 enforcement only after the Worker, server public key, and launcher population are confirmed. The launcher and Worker compatibility window does not make the server upgrade optional.

Keep the legacy `LAUNCHER_PROOF_SECRET` only as long as old launchers and old server verification must be supported. It is not used for v2. Remove the v1 issuance and verification path after the rollout population is upgraded.
