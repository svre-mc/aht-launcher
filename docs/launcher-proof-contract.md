# AHT Launcher Proof Contract

Protocol: `aht-launcher-proof-v1`

The launcher writes a short-lived proof file before Update finishes and before Play opens the official Minecraft Launcher.

## JVM Properties

The Minecraft Launcher profile gets these Java properties:

```text
-Daht.launcher.present=true
-Daht.launcher.protocol=aht-launcher-proof-v1
-Daht.launcher.proofFile=<absolute path to launcher-proof.json>
```

Client mod entry point:

```java
String protocol = System.getProperty("aht.launcher.protocol", "");
String proofFile = System.getProperty("aht.launcher.proofFile", "");
```

If `protocol` is not `aht-launcher-proof-v1` or `proofFile` is blank, the client did not launch through the AHT launcher profile.

## Proof File

Path:

```text
<instance>/.aht-launcher/launcher-proof.json
```

Important fields:

```json
{
  "protocol": "aht-launcher-proof-v1",
  "schemaVersion": 1,
  "trusted": true,
  "source": "worker",
  "token": "<header.payload.signature>",
  "header": {
    "alg": "HS256",
    "typ": "AHT-LAUNCHER-PROOF",
    "kid": "aht-launcher-proof-v1"
  },
  "payload": {
    "protocol": "aht-launcher-proof-v1",
    "schemaVersion": 1,
    "launchId": "<uuid>",
    "issuedAt": "2026-06-25T00:00:00.000Z",
    "expiresAt": "2026-06-25T00:10:00.000Z",
    "packId": "a-hard-time-dregora",
    "packVersion": "2.8.2",
    "minecraftUsername": "PlayerName",
    "installId": "<launcher install id>",
    "appVersion": "0.1.0",
    "platform": "win32",
    "arch": "x64",
    "launcherChannel": "player",
    "instanceDirHash": "<sha256>"
  },
  "signature": {
    "alg": "HS256",
    "kid": "aht-launcher-proof-v1",
    "value": "<base64url hmac>"
  }
}
```

The client mod should send the whole `token` or the whole proof JSON to the server during the mod handshake.

## Server Verification

Server mod rules:

1. Require `trusted === true`.
2. Require `source === "worker"` for real enforcement.
3. Require `header.alg === "HS256"`.
4. Verify `token` as a JWT-style value:
   - Split by `.`
   - Compute `HmacSHA256(headerBase64 + "." + payloadBase64, LAUNCHER_PROOF_SECRET)`
   - Base64url-encode the result without padding
   - Compare to the third token part using a constant-time comparison
5. Decode payload JSON and require:
   - `protocol === "aht-launcher-proof-v1"`
   - `packId === "a-hard-time-dregora"`
   - `minecraftUsername` matches the joining player name
   - `expiresAt` is still in the future
   - `issuedAt` is not too far in the future
6. Track `launchId` for a short time and reject reuse if you want one-token-per-join behavior.

## Worker Secret

Cloudflare Worker secret required for real signatures:

```text
LAUNCHER_PROOF_SECRET=<same secret your server mod uses to verify HMAC>
LAUNCHER_PROOF_KEY_ID=aht-launcher-proof-v1
```

The Worker signs launcher proof tokens with `LAUNCHER_PROOF_SECRET`. For compatibility with older server-side setups it will also accept `AHT_LAUNCHER_PROOF_SECRET`, then `ADMIN_TOKEN_SECRET`, then `ADMIN_PASSWORD` as fallback signing secrets. The server should be configured with `LAUNCHER_PROOF_SECRET` set to the exact same value whenever possible.

Do not use `CURSEFORGE_API_KEY` as the proof-signing secret. That key is only for CurseForge API access.

Set the same proof secret in the Minecraft server process environment, service manager, or host panel before starting the server.

Until the Worker is deployed and `LAUNCHER_PROOF_SECRET` is set, the launcher can write an unsigned fallback proof. The server mod should not accept fallback proofs.