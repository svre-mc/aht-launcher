package com.aht.launcherlock;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.security.KeyFactory;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

final class ServerPolicySnapshot {
    static final String PROTOCOL = "aht-server-state-v1";
    private static final String TOKEN_TYPE = "AHT-SERVER-STATE";
    private static final String ISSUER = "aht-launcher-worker";
    private static final String AUDIENCE = "aht-minecraft-server-state";
    private static final int MAX_MESSAGE_CHARS = 1900 * 1024;
    private static final int MAX_TOKEN_CHARS = 1400 * 1024;
    private static final int MAX_PAYLOAD_BYTES = 900 * 1024;
    private static final int MAX_ACCOUNTS = 5000;
    private static final int MAX_DENIALS = 5000;

    final String revision;
    final String packId;
    final String necessaryLauncherVersion;
    final boolean blockLikelyVpn;
    final RSAPublicKey publicKey;
    final String keyFingerprint;
    private final Map<String, String> accountBindings;
    private final Map<String, Set<String>> accessDenials;

    private ServerPolicySnapshot(String revision, String packId, String necessaryLauncherVersion,
                                 boolean blockLikelyVpn, RSAPublicKey publicKey, String keyFingerprint,
                                 Map<String, String> accountBindings,
                                 Map<String, Set<String>> accessDenials) {
        this.revision = revision;
        this.packId = packId;
        this.necessaryLauncherVersion = necessaryLauncherVersion;
        this.blockLikelyVpn = blockLikelyVpn;
        this.publicKey = publicKey;
        this.keyFingerprint = keyFingerprint;
        this.accountBindings = Collections.unmodifiableMap(new HashMap<String, String>(accountBindings));
        Map<String, Set<String>> denialCopy = new HashMap<String, Set<String>>();
        for (Map.Entry<String, Set<String>> entry : accessDenials.entrySet()) {
            denialCopy.put(entry.getKey(), Collections.unmodifiableSet(new HashSet<String>(entry.getValue())));
        }
        this.accessDenials = Collections.unmodifiableMap(denialCopy);
    }

    String accountBinding(String accountDigest) {
        return accountBindings.get(accountDigest);
    }

    boolean isDenied(String scope, String digest) {
        Set<String> values = accessDenials.get(scope);
        return values != null && values.contains(digest);
    }

    static ServerPolicySnapshot verifyMessage(String message, String expectedFingerprint,
                                              String expectedPackId, long nowMillis) throws Exception {
        JsonObject envelope = SignedTokenSupport.parseObject(message, MAX_MESSAGE_CHARS);
        if (!"launcher-server-state".equals(SignedTokenSupport.readString(envelope, "type"))
                || !PROTOCOL.equals(SignedTokenSupport.readString(envelope, "protocol"))
                || SignedTokenSupport.readInt(envelope, "schemaVersion") != 1) {
            throw new IllegalArgumentException("launcher state envelope is invalid");
        }
        String outerRevision = exactHex(SignedTokenSupport.readString(envelope, "revision"), 64);
        String token = SignedTokenSupport.readString(envelope, "token");
        String publicKeySpki = SignedTokenSupport.readString(envelope, "publicKeySpki");
        if (token.isEmpty() || token.length() > MAX_TOKEN_CHARS
                || publicKeySpki.isEmpty() || publicKeySpki.length() > 4096) {
            throw new IllegalArgumentException("launcher state envelope is oversized");
        }

        String normalizedFingerprint = exactHex(expectedFingerprint, 64);
        byte[] publicKeyBytes = SignedTokenSupport.decodeBase64Url(publicKeySpki);
        String actualFingerprint = SignedTokenSupport.sha256Hex(publicKeyBytes);
        if (!SignedTokenSupport.constantEquals(normalizedFingerprint, actualFingerprint)) {
            throw new IllegalArgumentException("launcher state public key does not match the pinned fingerprint");
        }
        RSAPublicKey publicKey = (RSAPublicKey) KeyFactory.getInstance("RSA")
                .generatePublic(new X509EncodedKeySpec(publicKeyBytes));
        if (publicKey.getModulus().bitLength() < 2048) {
            throw new IllegalArgumentException("launcher state RSA key is too small");
        }

        SignedTokenSupport.VerifiedToken verified = SignedTokenSupport.verifyRs256(
                token, publicKey, TOKEN_TYPE, MAX_TOKEN_CHARS, MAX_PAYLOAD_BYTES
        );
        JsonObject payload = verified.payload;
        String revision = exactHex(SignedTokenSupport.readString(payload, "revision"), 64);
        String packId = SignedTokenSupport.safe(SignedTokenSupport.readString(payload, "packId"), 80);
        String necessaryLauncherVersion = SignedTokenSupport.safe(
                SignedTokenSupport.readString(payload, "necessaryLauncherVersion"), 40
        );
        String policySource = SignedTokenSupport.safe(
                SignedTokenSupport.readString(payload, "policySource"), 80
        );
        long issuedAt = SignedTokenSupport.parseInstant(SignedTokenSupport.readString(payload, "issuedAt"));
        if (!PROTOCOL.equals(SignedTokenSupport.readString(payload, "protocol"))
                || SignedTokenSupport.readInt(payload, "schemaVersion") != 1
                || !ISSUER.equals(SignedTokenSupport.readString(payload, "issuer"))
                || !AUDIENCE.equals(SignedTokenSupport.readString(payload, "audience"))
                || !SignedTokenSupport.KEY_ID.equals(SignedTokenSupport.readString(payload, "keyId"))
                || !normalizedFingerprint.equals(exactHex(
                        SignedTokenSupport.readString(payload, "attestationKeySha256"), 64))
                || !outerRevision.equals(revision)
                || !expectedPackId.equals(packId)
                || !SignedTokenSupport.validVersion(necessaryLauncherVersion)
                || !("launcher/latest.json".equals(policySource) || "configured-floor".equals(policySource))
                || issuedAt < 1577836800000L || issuedAt > nowMillis + 120000L) {
            throw new IllegalArgumentException("launcher state signed claims are invalid");
        }

        Map<String, String> bindings = parseAccountBindings(SignedTokenSupport.readArray(payload, "accountBindings"));
        Map<String, Set<String>> denials = parseAccessDenials(SignedTokenSupport.readArray(payload, "accessDenials"));
        boolean blockLikelyVpn = SignedTokenSupport.readBoolean(payload, "blockLikelyVpn", true);
        return new ServerPolicySnapshot(
                revision,
                packId,
                necessaryLauncherVersion,
                blockLikelyVpn,
                publicKey,
                normalizedFingerprint,
                bindings,
                denials
        );
    }

    private static Map<String, String> parseAccountBindings(JsonArray values) {
        if (values.size() > MAX_ACCOUNTS) throw new IllegalArgumentException("too many account bindings");
        Map<String, String> result = new HashMap<String, String>();
        for (JsonElement value : values) {
            if (value == null || !value.isJsonObject()) throw new IllegalArgumentException("invalid account binding");
            JsonObject row = value.getAsJsonObject();
            String accountDigest = exactHex(SignedTokenSupport.readString(row, "accountDigest"), 64);
            String bindingDigest = exactHex(SignedTokenSupport.readString(row, "bindingDigest"), 64);
            String existing = result.put(accountDigest, bindingDigest);
            if (existing != null && !existing.equals(bindingDigest)) {
                throw new IllegalArgumentException("conflicting account binding");
            }
        }
        return result;
    }

    private static Map<String, Set<String>> parseAccessDenials(JsonArray values) {
        if (values.size() > MAX_DENIALS) throw new IllegalArgumentException("too many access denials");
        Map<String, Set<String>> result = new HashMap<String, Set<String>>();
        for (JsonElement value : values) {
            if (value == null || !value.isJsonObject()) throw new IllegalArgumentException("invalid access denial");
            JsonObject row = value.getAsJsonObject();
            String scope = SignedTokenSupport.safe(SignedTokenSupport.readString(row, "scope"), 40)
                    .toLowerCase(Locale.ROOT);
            if (!("account".equals(scope) || "minecraft_uuid".equals(scope) || "device".equals(scope)
                    || "ip".equals(scope) || "ipv4".equals(scope))) {
                throw new IllegalArgumentException("invalid access-denial scope");
            }
            String digest = exactHex(SignedTokenSupport.readString(row, "digest"), 64);
            if (!result.containsKey(scope)) result.put(scope, new HashSet<String>());
            result.get(scope).add(digest);
        }
        return result;
    }

    private static String exactHex(String value, int length) {
        String text = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (text.length() != length || !text.matches("[a-f0-9]{" + length + "}")) {
            throw new IllegalArgumentException("required digest is invalid");
        }
        return text;
    }
}
