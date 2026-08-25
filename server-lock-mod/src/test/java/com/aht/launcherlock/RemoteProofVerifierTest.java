package com.aht.launcherlock;

import org.junit.Test;

import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class RemoteProofVerifierTest {
    private static final UUID PLAYER_ID = UUID.fromString("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    private static final String PACK_ID = "a-hard-time-dregora";

    @Test
    public void acceptsMatchingLiveSession() {
        RemoteProofVerifier.Result result = RemoteProofVerifier.parseResponseForTests(
                200,
                "application/json; charset=utf-8",
                successBody("DeviceRig", PLAYER_ID.toString(), PACK_ID, "0.1.87", "0.1.87", "0.1.87"),
                "DeviceRig",
                PLAYER_ID,
                PACK_ID
        );

        assertTrue(result.accepted);
        assertEquals("ACCEPTED", result.code);
        assertEquals("0.1.87", result.currentLauncherVersion);
        assertEquals("0.1.87", result.necessaryLauncherVersion);
    }

    @Test
    public void preservesUpdateVersionsForDisconnectMessage() {
        RemoteProofVerifier.Result result = RemoteProofVerifier.parseResponseForTests(
                426,
                "application/json",
                "{\"ok\":false,\"valid\":false,\"accessGranted\":false,"
                        + "\"code\":\"LAUNCHER_UPDATE_REQUIRED\","
                        + "\"currentLauncherVersion\":\"0.1.86\","
                        + "\"necessaryLauncherVersion\":\"0.1.87\"}",
                "DeviceRig",
                PLAYER_ID,
                PACK_ID
        );

        assertFalse(result.accepted);
        assertEquals("LAUNCHER_UPDATE_REQUIRED", result.code);
        assertEquals("0.1.86", result.currentLauncherVersion);
        assertEquals("0.1.87", result.necessaryLauncherVersion);
    }

    @Test
    public void rejectsIdentityOrPolicyMismatch() {
        RemoteProofVerifier.Result wrongUuid = RemoteProofVerifier.parseResponseForTests(
                200,
                "application/json",
                successBody("DeviceRig", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                        PACK_ID, "0.1.87", "0.1.87", "0.1.87"),
                "DeviceRig",
                PLAYER_ID,
                PACK_ID
        );
        RemoteProofVerifier.Result forgedPolicy = RemoteProofVerifier.parseResponseForTests(
                200,
                "application/json",
                successBody("DeviceRig", PLAYER_ID.toString(), PACK_ID,
                        "0.1.86", "0.1.87", "0.1.87"),
                "DeviceRig",
                PLAYER_ID,
                PACK_ID
        );

        assertFalse(wrongUuid.accepted);
        assertEquals("PROOF_IDENTITY_MISMATCH", wrongUuid.code);
        assertFalse(forgedPolicy.accepted);
        assertEquals("PROOF_IDENTITY_MISMATCH", forgedPolicy.code);
    }

    @Test
    public void failsClosedOnMalformedOrUntrustedResponse() {
        RemoteProofVerifier.Result html = RemoteProofVerifier.parseResponseForTests(
                200, "text/html", "<html></html>", "DeviceRig", PLAYER_ID, PACK_ID);
        RemoteProofVerifier.Result malformed = RemoteProofVerifier.parseResponseForTests(
                200, "application/json", "{", "DeviceRig", PLAYER_ID, PACK_ID);
        RemoteProofVerifier.Result oversized = RemoteProofVerifier.parseResponseForTests(
                200, "application/json", repeat('x', 16385), "DeviceRig", PLAYER_ID, PACK_ID);

        assertFalse(html.accepted);
        assertEquals("VERIFICATION_UNAVAILABLE", html.code);
        assertFalse(malformed.accepted);
        assertEquals("VERIFICATION_UNAVAILABLE", malformed.code);
        assertFalse(oversized.accepted);
        assertEquals("VERIFICATION_UNAVAILABLE", oversized.code);
    }

    @Test
    public void emptyMaximumAndTruncatedResponsesRespectBoundaries() {
        String valid = successBody("DeviceRig", PLAYER_ID.toString(), PACK_ID,
                "0.1.87", "0.1.87", "0.1.87");
        String maximum = valid + repeat(' ', 16384 - valid.length());
        RemoteProofVerifier.Result empty = RemoteProofVerifier.parseResponseForTests(
                200, "application/json", "", "DeviceRig", PLAYER_ID, PACK_ID);
        RemoteProofVerifier.Result exactMaximum = RemoteProofVerifier.parseResponseForTests(
                200, "application/json", maximum, "DeviceRig", PLAYER_ID, PACK_ID);
        RemoteProofVerifier.Result truncated = RemoteProofVerifier.parseResponseForTests(
                200, "application/json", valid.substring(0, valid.length() - 1),
                "DeviceRig", PLAYER_ID, PACK_ID);

        assertFalse(empty.accepted);
        assertEquals("VERIFICATION_UNAVAILABLE", empty.code);
        assertTrue(exactMaximum.accepted);
        assertFalse(truncated.accepted);
        assertEquals("VERIFICATION_UNAVAILABLE", truncated.code);
    }

    @Test
    public void endpointMustBeExactHttpsVerifyPath() {
        assertTrue(RemoteProofVerifier.isVerificationUrlAllowedForTests(
                "https://aht-curseforge-proxy.mysticgamer312.workers.dev/api/launcher-proof/verify"));
        assertFalse(RemoteProofVerifier.isVerificationUrlAllowedForTests(
                "http://aht-curseforge-proxy.mysticgamer312.workers.dev/api/launcher-proof/verify"));
        assertFalse(RemoteProofVerifier.isVerificationUrlAllowedForTests(
                "https://example.invalid/api/launcher-proof/verify?token=leak"));
        assertFalse(RemoteProofVerifier.isVerificationUrlAllowedForTests(
                "https://example.invalid/redirect"));
    }

    private static String successBody(String username, String uuid, String packId,
                                      String launcherVersion, String current, String necessary) {
        return "{\"ok\":true,\"valid\":true,\"accessGranted\":true,"
                + "\"session\":{\"minecraftUsername\":\"" + username + "\","
                + "\"minecraftUuid\":\"" + uuid + "\","
                + "\"packId\":\"" + packId + "\","
                + "\"launcherVersion\":\"" + launcherVersion + "\"},"
                + "\"policy\":{\"currentLauncherVersion\":\"" + current + "\","
                + "\"necessaryLauncherVersion\":\"" + necessary + "\"}}";
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index++) result.append(value);
        return result.toString();
    }
}
