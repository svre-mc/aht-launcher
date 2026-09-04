package com.aht.launcherlock;

import com.google.gson.JsonArray;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class LocalProofVerifierTest {
    private static final UUID PLAYER_ID = UUID.fromString(SignedStateTestSupport.UUID_TEXT);

    @Test
    public void acceptsOnlyWorkerSignedVersionAgainstPushedFloor() throws Exception {
        ServerPolicySnapshot state = SignedStateTestSupport.state("0.1.87", new JsonArray(), false);
        LocalProofVerifier.Result accepted = verify(SignedStateTestSupport.proof("0.1.87"), state, "203.0.113.77");
        LocalProofVerifier.Result outdated = verify(SignedStateTestSupport.proof("0.1.86"), state, "203.0.113.77");
        LocalProofVerifier.Result unrecognizedFuture = verify(SignedStateTestSupport.proof("9.9.9"), state, "203.0.113.77");

        assertTrue(accepted.accepted);
        assertEquals("ACCEPTED", accepted.code);
        assertFalse(outdated.accepted);
        assertEquals("LAUNCHER_UPDATE_REQUIRED", outdated.code);
        assertEquals("0.1.86", outdated.currentLauncherVersion);
        assertEquals("0.1.87", outdated.necessaryLauncherVersion);
        assertFalse(unrecognizedFuture.accepted);
        assertEquals("LAUNCHER_UPDATE_REQUIRED", unrecognizedFuture.code);
        assertEquals("9.9.9", unrecognizedFuture.currentLauncherVersion);
        assertEquals("0.1.87", unrecognizedFuture.necessaryLauncherVersion);
    }

    @Test
    public void rejectsTamperedClientVersionEvenWhenItLooksCurrent() throws Exception {
        ServerPolicySnapshot state = SignedStateTestSupport.state("0.1.87", new JsonArray(), false);
        String signedOld = SignedStateTestSupport.proof("0.1.86");
        String[] parts = signedOld.split("\\.");
        String payload = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8)
                .replace("\"launcherVersion\":\"0.1.86\"", "\"launcherVersion\":\"0.1.87\"");
        String tampered = parts[0] + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(payload.getBytes(StandardCharsets.UTF_8)) + "." + parts[2];

        LocalProofVerifier.Result result = verify(tampered, state, "203.0.113.77");
        assertFalse(result.accepted);
        assertEquals("INVALID_LAUNCHER_PROOF", result.code);
    }

    @Test
    public void rejectsWorkerSignedButInconsistentLauncherVersionClaims() throws Exception {
        ServerPolicySnapshot state = SignedStateTestSupport.state("0.1.87", new JsonArray(), false);
        LocalProofVerifier.Result result = verify(
                SignedStateTestSupport.proofWithAppVersion("0.1.87", "0.1.86"),
                state,
                "203.0.113.77"
        );
        assertFalse(result.accepted);
        assertEquals("PROOF_IDENTITY_MISMATCH", result.code);
    }

    @Test
    public void emptyMaximumMalformedAndTruncatedProofsFailClosed() throws Exception {
        ServerPolicySnapshot state = SignedStateTestSupport.state("0.1.86", new JsonArray(), false);
        String valid = SignedStateTestSupport.proof("0.1.86");
        String maximum = "a." + repeat('b', LauncherProofMessage.MAX_TOKEN_CHARS - 4) + ".c";
        String[] candidates = { "", "a.b.c", maximum, valid.substring(0, valid.length() - 1) };
        for (String candidate : candidates) {
            LocalProofVerifier.Result result = verify(candidate, state, "203.0.113.77");
            assertFalse(result.accepted);
            assertEquals("INVALID_LAUNCHER_PROOF", result.code);
        }
    }

    @Test
    public void staleRegistrationBindingAndActiveBansFailClosed() throws Exception {
        ServerPolicySnapshot normal = SignedStateTestSupport.state("0.1.86", new JsonArray(), false);
        LocalProofVerifier.Result staleBinding = verify(
                SignedStateTestSupport.proof("0.1.86", "recovered-install", "unknown", 0L),
                normal,
                "203.0.113.77"
        );
        assertFalse(staleBinding.accepted);
        assertEquals("PROOF_IDENTITY_MISMATCH", staleBinding.code);

        ServerPolicySnapshot deviceBanned = SignedStateTestSupport.state(
                "0.1.86", SignedStateTestSupport.denial("device", SignedStateTestSupport.DEVICE_ID), false
        );
        ServerPolicySnapshot ipBanned = SignedStateTestSupport.state(
                "0.1.86", SignedStateTestSupport.denial("ip", "203.0.113.77"), false
        );
        assertEquals("ACCESS_RESTRICTED",
                verify(SignedStateTestSupport.proof("0.1.86"), deviceBanned, "203.0.113.77").code);
        assertEquals("ACCESS_RESTRICTED",
                verify(SignedStateTestSupport.proof("0.1.86"), ipBanned, "203.0.113.77").code);
    }

    @Test
    public void vpnPolicyAndReconnectWindowAreEnforcedLocally() throws Exception {
        ServerPolicySnapshot vpnBlocked = SignedStateTestSupport.state("0.1.86", new JsonArray(), true);
        assertEquals("ACCESS_RESTRICTED", verify(
                SignedStateTestSupport.proof("0.1.86", SignedStateTestSupport.INSTALL_ID, "likely", 0L),
                vpnBlocked,
                "2001:db8::77"
        ).code);
        assertEquals("PROOF_IDENTITY_MISMATCH", verify(
                SignedStateTestSupport.proof("0.1.86", SignedStateTestSupport.INSTALL_ID, "unknown", -1000L),
                vpnBlocked,
                "203.0.113.77"
        ).code);
    }

    @Test
    public void stateEndpointMustBeExactAuthenticatedWssPath() {
        assertTrue(ServerStateClient.isEndpointAllowedForTests(
                "wss://api.ahardtime.net/server/launcher-state"));
        assertFalse(ServerStateClient.isEndpointAllowedForTests(
                "https://api.ahardtime.net/server/launcher-state"));
        assertFalse(ServerStateClient.isEndpointAllowedForTests(
                "wss://api.ahardtime.net/server/launcher-state?token=leak"));
        assertFalse(ServerStateClient.isEndpointAllowedForTests("wss://example.invalid/redirect"));
    }

    private static LocalProofVerifier.Result verify(String token, ServerPolicySnapshot state, String ip) {
        return LocalProofVerifier.verifyForTests(
                token,
                SignedStateTestSupport.USERNAME,
                PLAYER_ID,
                SignedStateTestSupport.PACK_ID,
                ip,
                state,
                System.currentTimeMillis()
        );
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index++) result.append(value);
        return result.toString();
    }
}
