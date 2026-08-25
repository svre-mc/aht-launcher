package com.aht.launcherlock;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

final class LauncherProofReader {
    private static final String PROOF_FILE_PROPERTY = "aht.launcher.proofFile";
    private static final String PROOF_PROTOCOL_PROPERTY = "aht.launcher.protocol";
    private static final String REQUIRED_PROTOCOL = "aht-launcher-attestation-v2";
    private static final long MAX_PROOF_FILE_BYTES = 32768L;

    private LauncherProofReader() {
    }

    static LauncherProofMessage readLauncherProof() {
        if (!REQUIRED_PROTOCOL.equals(System.getProperty(PROOF_PROTOCOL_PROPERTY, "").trim())) {
            return LauncherProofMessage.unavailable();
        }
        String configuredPath = System.getProperty(PROOF_FILE_PROPERTY, "").trim();
        if (configuredPath.isEmpty()) {
            return LauncherProofMessage.unavailable();
        }
        File proofFile = new File(configuredPath);
        try {
            if (!proofFile.isAbsolute() || !proofFile.isFile()
                    || proofFile.length() <= 0L || proofFile.length() > MAX_PROOF_FILE_BYTES
                    || Files.isSymbolicLink(proofFile.toPath())) {
                return LauncherProofMessage.unavailable();
            }
            try (Reader reader = new InputStreamReader(new FileInputStream(proofFile), StandardCharsets.UTF_8)) {
                JsonObject root = new JsonParser().parse(reader).getAsJsonObject();
                String protocol = readString(root, "protocol");
                String source = readString(root, "source");
                String token = readString(root, "token");
                boolean trusted = root.has("trusted") && root.get("trusted").isJsonPrimitive()
                        && root.get("trusted").getAsJsonPrimitive().isBoolean()
                        && root.get("trusted").getAsBoolean();
                if (!trusted || !"worker".equals(source) || !REQUIRED_PROTOCOL.equals(protocol)
                        || !LauncherProofMessage.isTokenShapeValid(token)) {
                    return LauncherProofMessage.unavailable();
                }
                return LauncherProofMessage.available(token);
            }
        } catch (Exception error) {
            if (PackVersionLock.LOG != null) {
                PackVersionLock.LOG.debug("Launcher proof was not readable for this connection.");
            }
            return LauncherProofMessage.unavailable();
        }
    }

    private static String readString(JsonObject json, String key) {
        try {
            return json != null && json.has(key) && json.get(key).isJsonPrimitive()
                    && json.get(key).getAsJsonPrimitive().isString()
                    ? json.get(key).getAsString().trim()
                    : "";
        } catch (Exception ignored) {
            return "";
        }
    }
}
