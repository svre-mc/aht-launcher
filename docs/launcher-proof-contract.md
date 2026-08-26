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
- Maximum same-player reconnect window: 24 hours
- Compact JWS limits: 8192 total characters; 1024 header, 6144 payload, and 1024 signature characters

`LAUNCHER_ATTESTATION_PRIVATE_KEY_PKCS8` must be installed with `wrangler secret put`; it must never be committed, written to launcher configuration, packaged into an installer, logged, or copied to the Minecraft client/server. The server receives only the public SPKI key.

## Player issuance

For a player-channel v2 request, the Worker requires all of the following:

1. A registered Minecraft username.
2. The registered launcher `installId`.
3. The account recovery credential in the `X-AHT-Launcher-Recovery` request header, matching the verifier already stored with the registration.
4. A valid Minecraft UUID stored in that registration.
5. Every v2 proof requires a fresh Ed25519 `aht-device-assertion-v1` bound to the exact launch request, including the launcher version. The Worker never signs a v2 proof from a bare version claim.
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
  "launcherVersionAuthority": "worker-policy-matched-device-assertion",
  "launcherChannel": "player",
  "developerClient": false,
  "developerClientBypass": false,
  "modIntegrityBypass": false,
  "accessGranted": true,
  "networkStatus": "unknown"
}
```

The proof document has `trusted: true` and `source: "worker"`. Its `token` is the compact JWS. The launcher performs strict structural and request/response checks, but the Minecraft server is the enforcement authority and verifies the RSA signature locally.

The game server does not call `/api/launcher-proof/verify` for player joins. It holds one authenticated WebSocket to `/server/launcher-state`. A Cloudflare Queue fed by the exact R2 `launcher/latest.json` object-create notification refreshes one Durable Object, which revision-deduplicates and pushes a separately signed `aht-server-state-v1` snapshot. Registration and access-decision changes refresh the same snapshot. A reconnect to the state channel performs a full R2 reconciliation before sending state, so an offline server catches up before it can accept new joins.

The pushed snapshot contains the current required launcher version, hashed account-to-install/device bindings, hashed active account/UUID/device/IP restrictions, and VPN policy. It contains no raw player identifiers. Existing players are not rechecked when a new revision arrives; every new connection uses the latest atomic in-memory revision.

The launcher version is not accepted as a raw game-client field. Before the Worker issues an RSA proof, it verifies a fresh Ed25519 device assertion whose signed binding includes the launcher version, account, UUID, install, launch request, instance hash, and device ID, then requires that version to exactly equal the authoritative release policy. The RSA proof marks this as `worker-policy-matched-device-assertion`. The server requires that authority marker and RSA signature, then requires the signed version to exactly equal the separately signed pushed policy. This is software/device-key attestation, not TPM or kernel attestation; a fully privileged local attacker remains outside this threat model.

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
5. Require a valid issue/expiry window no longer than 10 minutes, a reconnect window no longer than 24 hours, and reject future or reconnect-expired tokens.
6. Require `jti === launchId`, both formatted as a UUID.
7. Hash the signed username/UUID/install/device claims and require an exact pushed registration binding; hash the actual connection IP and all signed access identifiers and reject active pushed restrictions.
8. Compare only the signed `launcherVersion` with the separately signed pushed `necessaryLauncherVersion`. Never compare or accept an unsigned version packet.

Client integrity reports remain signals; they are not allowed to create or alter an attestation.

## Legacy compatibility

The Worker retains the old `/api/launcher-proof/verify` and v1 issuance code only for controlled compatibility during rollout. Launcher Lock 1.2.0 never sends a player proof to that endpoint and never accepts HS256/v1 locally. New joins require the exact v2 RSA proof and pushed v1 server-state protocol.
