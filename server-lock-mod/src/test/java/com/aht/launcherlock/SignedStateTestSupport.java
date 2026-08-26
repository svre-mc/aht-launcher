package com.aht.launcherlock;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

final class SignedStateTestSupport {
    static final String USERNAME = "DeviceRig";
    static final String UUID_TEXT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    static final String INSTALL_ID = "device-install-test";
    static final String DEVICE_ID = "ahtd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    static final String PACK_ID = "a-hard-time-dregora";
    static final KeyPair KEY_PAIR = generateKeyPair();
    static final String KEY_FINGERPRINT = SignedTokenSupport.sha256Hex(KEY_PAIR.getPublic().getEncoded());

    private SignedStateTestSupport() {
    }

    static ServerPolicySnapshot state(String necessaryVersion, JsonArray denials, boolean blockVpn) throws Exception {
        return ServerPolicySnapshot.verifyMessage(
                stateMessage(necessaryVersion, denials, blockVpn), KEY_FINGERPRINT, PACK_ID, System.currentTimeMillis()
        );
    }

    static String stateMessage(String necessaryVersion, JsonArray denials, boolean blockVpn) throws Exception {
        JsonObject binding = new JsonObject();
        binding.addProperty("accountDigest", SignedTokenSupport.sha256Hex("account\0" + USERNAME.toLowerCase()));
        binding.addProperty("bindingDigest", bindingDigest(INSTALL_ID));
        JsonArray bindings = new JsonArray();
        bindings.add(binding);

        JsonObject payload = new JsonObject();
        payload.addProperty("protocol", ServerPolicySnapshot.PROTOCOL);
        payload.addProperty("schemaVersion", 1);
        payload.addProperty("issuer", "aht-launcher-worker");
        payload.addProperty("audience", "aht-minecraft-server-state");
        payload.addProperty("keyId", SignedTokenSupport.KEY_ID);
        payload.addProperty("attestationKeySha256", KEY_FINGERPRINT);
        payload.addProperty("packId", PACK_ID);
        payload.addProperty("necessaryLauncherVersion", necessaryVersion);
        payload.addProperty("policySource", "launcher/latest.json");
        payload.addProperty("manifestEtag", "test-etag");
        payload.addProperty("blockLikelyVpn", blockVpn);
        payload.add("accountBindings", bindings);
        payload.add("accessDenials", denials == null ? new JsonArray() : denials);
        String revision = SignedTokenSupport.sha256Hex(payload.toString());
        payload.addProperty("revision", revision);
        payload.addProperty("issuedAt", Instant.now().toString());

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "launcher-server-state");
        envelope.addProperty("protocol", ServerPolicySnapshot.PROTOCOL);
        envelope.addProperty("schemaVersion", 1);
        envelope.addProperty("revision", revision);
        envelope.addProperty("token", sign("AHT-SERVER-STATE", payload));
        envelope.addProperty("publicKeySpki", Base64.getUrlEncoder().withoutPadding()
                .encodeToString(KEY_PAIR.getPublic().getEncoded()));
        return envelope.toString();
    }

    static String proof(String launcherVersion) throws Exception {
        return proof(launcherVersion, launcherVersion, INSTALL_ID, "unknown", 0L);
    }

    static String proof(String launcherVersion, String installId, String networkStatus,
                        long reconnectExpiryOffsetMillis) throws Exception {
        return proof(launcherVersion, launcherVersion, installId, networkStatus, reconnectExpiryOffsetMillis);
    }

    static String proofWithAppVersion(String launcherVersion, String appVersion) throws Exception {
        return proof(launcherVersion, appVersion, INSTALL_ID, "unknown", 0L);
    }

    private static String proof(String launcherVersion, String appVersion, String installId,
                                String networkStatus, long reconnectExpiryOffsetMillis) throws Exception {
        long now = System.currentTimeMillis();
        String launchId = UUID.randomUUID().toString();
        JsonObject payload = new JsonObject();
        payload.addProperty("protocol", "aht-launcher-attestation-v2");
        payload.addProperty("schemaVersion", 2);
        payload.addProperty("jti", launchId);
        payload.addProperty("launchId", launchId);
        payload.addProperty("issuedAt", Instant.ofEpochMilli(now).toString());
        payload.addProperty("expiresAt", Instant.ofEpochMilli(now + 10L * 60L * 1000L).toString());
        long reconnect = reconnectExpiryOffsetMillis == 0L
                ? now + 24L * 60L * 60L * 1000L : now + reconnectExpiryOffsetMillis;
        payload.addProperty("reconnectExpiresAt", Instant.ofEpochMilli(reconnect).toString());
        payload.addProperty("issuer", "aht-launcher-worker");
        payload.addProperty("audience", "aht-minecraft-server");
        payload.addProperty("packId", PACK_ID);
        payload.addProperty("minecraftUsername", USERNAME);
        payload.addProperty("minecraftUuid", UUID_TEXT);
        payload.addProperty("installId", installId);
        payload.addProperty("deviceId", DEVICE_ID);
        payload.addProperty("appVersion", appVersion);
        payload.addProperty("launcherVersion", launcherVersion);
        payload.addProperty("launcherVersionAuthority", "worker-policy-matched-device-assertion");
        payload.addProperty("launcherChannel", "player");
        payload.addProperty("developerClient", false);
        payload.addProperty("developerClientBypass", false);
        payload.addProperty("modIntegrityBypass", false);
        payload.addProperty("accessGranted", true);
        payload.addProperty("networkStatus", networkStatus);
        return sign("AHT-LAUNCHER-ATTESTATION", payload);
    }

    static JsonArray denial(String scope, String normalizedValue) {
        JsonObject denial = new JsonObject();
        denial.addProperty("scope", scope);
        denial.addProperty("digest", SignedTokenSupport.sha256Hex(scope + "\0" + normalizedValue));
        JsonArray denials = new JsonArray();
        denials.add(denial);
        return denials;
    }

    static String bindingDigest(String installId) {
        return SignedTokenSupport.sha256Hex(
                "binding-v1\0" + USERNAME.toLowerCase() + "\0" + UUID_TEXT + "\0"
                        + installId + "\0" + DEVICE_ID
        );
    }

    private static String sign(String type, JsonObject payload) throws Exception {
        JsonObject header = new JsonObject();
        header.addProperty("alg", "RS256");
        header.addProperty("typ", type);
        header.addProperty("kid", SignedTokenSupport.KEY_ID);
        String encodedHeader = base64Url(header.toString().getBytes(StandardCharsets.UTF_8));
        String encodedPayload = base64Url(payload.toString().getBytes(StandardCharsets.UTF_8));
        String signingInput = encodedHeader + "." + encodedPayload;
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initSign(KEY_PAIR.getPrivate());
        signature.update(signingInput.getBytes(StandardCharsets.US_ASCII));
        return signingInput + "." + base64Url(signature.sign());
    }

    private static String base64Url(byte[] value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    private static KeyPair generateKeyPair() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            return generator.generateKeyPair();
        } catch (Exception error) {
            throw new ExceptionInInitializerError(error);
        }
    }
}
