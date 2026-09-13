package com.aht.launcherlock;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;
import static org.junit.Assert.*;

public class MinecraftSessionAuthorityTest {
    private JsonObject claims() throws Exception {
        String token = SignedStateTestSupport.proof("0.1.87", "repaired-install", "unknown", 0L);
        JsonObject claims = new JsonParser().parse(new String(Base64.getUrlDecoder().decode(token.split("\\.")[1]), StandardCharsets.UTF_8)).getAsJsonObject();
        claims.addProperty("identityAuthority", "minecraft-online-session");
        claims.addProperty("accountLinked", false);
        return claims;
    }
    private LocalProofVerifier.Result verify(JsonObject claims, boolean authenticated, ServerPolicySnapshot state) throws Exception {
        return LocalProofVerifier.verifyForTests(SignedStateTestSupport.sign("AHT-LAUNCHER-ATTESTATION", claims),
            SignedStateTestSupport.USERNAME, UUID.fromString(SignedStateTestSupport.UUID_TEXT), SignedStateTestSupport.PACK_ID,
            "203.0.113.77", state, System.currentTimeMillis(), authenticated);
    }
    @Test public void staleRegistrationDoesNotOverrideAuthenticatedMinecraftConnection() throws Exception {
        ServerPolicySnapshot state = SignedStateTestSupport.state("0.1.87", new JsonArray(), false);
        assertTrue(verify(claims(), true, state).accepted);
        assertFalse(verify(claims(), false, state).accepted);
        JsonObject old = claims(); old.remove("identityAuthority");
        assertFalse(verify(old, true, state).accepted);
    }
    @Test public void currentUuidAndNameCannotBeReplacedByLauncherClaims() throws Exception {
        ServerPolicySnapshot state = SignedStateTestSupport.state("0.1.87", new JsonArray(), false);
        JsonObject other = claims(); other.addProperty("minecraftUuid", UUID.randomUUID().toString());
        assertFalse(verify(other, true, state).accepted);
        other = claims(); other.addProperty("minecraftUsername", "OtherPlayer");
        assertFalse(verify(other, true, state).accepted);
        other = claims(); other.addProperty("identityAuthority", "offline-forwarded-name");
        assertFalse(verify(other, true, state).accepted);
    }
    @Test public void restrictionsAndVersionRemainMandatoryAfterMinecraftAuthentication() throws Exception {
        String[][] restrictions = {{"device", SignedStateTestSupport.DEVICE_ID}, {"account", SignedStateTestSupport.USERNAME.toLowerCase()},
            {"minecraft_uuid", SignedStateTestSupport.UUID_TEXT}, {"ip", "203.0.113.77"}};
        for (String[] restriction : restrictions) {
            ServerPolicySnapshot state = SignedStateTestSupport.state("0.1.87", SignedStateTestSupport.denial(restriction[0], restriction[1]), false);
            assertEquals("ACCESS_RESTRICTED", verify(claims(), true, state).code);
        }
        assertEquals("LAUNCHER_UPDATE_REQUIRED", verify(claims(), true, SignedStateTestSupport.state("0.1.88", new JsonArray(), false)).code);
        JsonObject expired = claims(); expired.addProperty("reconnectExpiresAt", "2020-01-01T00:00:00Z");
        assertFalse(verify(expired, true, SignedStateTestSupport.state("0.1.87", new JsonArray(), false)).accepted);
    }
    @Test public void onlyExplicitPrivateProxyRouteOrOnlineServerCanSupplyIdentity() {
        InetSocketAddress local = new InetSocketAddress("127.0.0.1", 12345);
        InetSocketAddress remote = new InetSocketAddress("203.0.113.77", 12345);
        assertTrue(MinecraftConnectionAuthority.authenticated(true, false, "0.0.0.0", remote));
        assertTrue(MinecraftConnectionAuthority.authenticated(false, true, "127.0.0.1", local));
        assertFalse(MinecraftConnectionAuthority.authenticated(false, false, "127.0.0.1", local));
        assertFalse(MinecraftConnectionAuthority.authenticated(false, true, "0.0.0.0", local));
        assertFalse(MinecraftConnectionAuthority.authenticated(false, true, "127.0.0.1", remote));
        assertFalse(MinecraftConnectionAuthority.authenticated(false, true, "127.0.0.1", null));
        assertFalse(MinecraftConnectionAuthority.authenticated(true, false, "", InetSocketAddress.createUnresolved("untrusted.invalid", 12345)));
    }
    @Test public void metadataTransportDoesNotFollowAnArbitraryEndpoint() {
        assertEquals("https://api.ahardtime.net/server/minecraft-session", MinecraftSessionLinkClient.endpoint("wss://api.ahardtime.net/server/launcher-state").toString());
        for (String endpoint : new String[]{"ws://api.ahardtime.net/server/launcher-state", "wss://untrusted.invalid/server/launcher-state",
            "wss://api.ahardtime.net/server/launcher-state?token=secret"}) {
            try { MinecraftSessionLinkClient.endpoint(endpoint); fail("Unsafe endpoint accepted"); }
            catch (IllegalArgumentException expected) {}
        }
    }
}
