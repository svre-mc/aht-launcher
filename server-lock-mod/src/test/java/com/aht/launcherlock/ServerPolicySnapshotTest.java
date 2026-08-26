package com.aht.launcherlock;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

public class ServerPolicySnapshotTest {
    @Test
    public void acceptsPinnedSignedState() throws Exception {
        ServerPolicySnapshot state = SignedStateTestSupport.state("0.1.87", new JsonArray(), false);
        assertEquals("0.1.87", state.necessaryLauncherVersion);
        assertEquals(SignedStateTestSupport.PACK_ID, state.packId);
        assertEquals(SignedStateTestSupport.KEY_FINGERPRINT, state.keyFingerprint);
    }

    @Test
    public void rejectsUnpinnedOrTamperedState() throws Exception {
        String message = SignedStateTestSupport.stateMessage("0.1.87", new JsonArray(), false);
        expectRejected(message, repeat('0', 64));
        JsonObject envelope = new JsonParser().parse(message).getAsJsonObject();
        String token = envelope.get("token").getAsString();
        int signatureStart = token.lastIndexOf('.') + 1;
        char replacement = token.charAt(signatureStart) == 'A' ? 'B' : 'A';
        envelope.addProperty("token", token.substring(0, signatureStart) + replacement
                + token.substring(signatureStart + 1));
        expectRejected(envelope.toString(), SignedStateTestSupport.KEY_FINGERPRINT);
    }

    @Test
    public void emptyMaximumMalformedAndTruncatedStateBoundaries() throws Exception {
        String valid = SignedStateTestSupport.stateMessage("0.1.87", new JsonArray(), false);
        expectRejected("", SignedStateTestSupport.KEY_FINGERPRINT);
        expectRejected("{", SignedStateTestSupport.KEY_FINGERPRINT);
        expectRejected(valid.substring(0, valid.length() - 1), SignedStateTestSupport.KEY_FINGERPRINT);

        int maximum = 1900 * 1024;
        String prefix = valid.substring(0, valid.length() - 1) + ",\"padding\":\"";
        String suffix = "\"}";
        String exactMaximum = prefix + repeat('x', maximum - prefix.length() - suffix.length()) + suffix;
        ServerPolicySnapshot state = ServerPolicySnapshot.verifyMessage(
                exactMaximum,
                SignedStateTestSupport.KEY_FINGERPRINT,
                SignedStateTestSupport.PACK_ID,
                System.currentTimeMillis()
        );
        assertEquals("0.1.87", state.necessaryLauncherVersion);
        expectRejected(exactMaximum + " ", SignedStateTestSupport.KEY_FINGERPRINT);
    }

    private static void expectRejected(String message, String fingerprint) {
        try {
            ServerPolicySnapshot.verifyMessage(
                    message, fingerprint, SignedStateTestSupport.PACK_ID, System.currentTimeMillis()
            );
            fail("untrusted launcher state was accepted");
        } catch (Exception expected) {
            // Expected fail-closed result.
        }
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index++) result.append(value);
        return result.toString();
    }
}
