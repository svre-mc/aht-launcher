package com.aht.launcherlock;

import com.google.gson.JsonObject;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Optional account metadata delivery. Never verifies or blocks world admission. */
final class MinecraftSessionLinkClient {
    private static volatile Config active;
    private static final ThreadPoolExecutor WORK = new ThreadPoolExecutor(1, 1, 30L, TimeUnit.SECONDS,
        new ArrayBlockingQueue<Runnable>(128), task -> {
            Thread thread = new Thread(task, "AHT-Account-Metadata");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.AbortPolicy());

    private MinecraftSessionLinkClient() {}

    static void start(String stateEndpoint, String serverToken) {
        stop();
        try { active = new Config(endpoint(stateEndpoint), serverToken); }
        catch (IllegalArgumentException ignored) { /* State-channel configuration reports this separately. */ }
    }

    static void stop() { active = null; WORK.getQueue().clear(); }

    static URI endpoint(String stateEndpoint) {
        if (!ServerStateClient.isEndpointAllowedForTests(stateEndpoint)) throw new IllegalArgumentException("Invalid server endpoint");
        URI source = URI.create(stateEndpoint);
        if (!"api.ahardtime.net".equalsIgnoreCase(source.getHost())) throw new IllegalArgumentException("Invalid account endpoint");
        return URI.create("https://" + source.getRawAuthority() + "/server/minecraft-session");
    }

    static void link(String proof, String username, UUID uuid) {
        final Config config = active;
        if (config == null || uuid == null || !LauncherProofMessage.isTokenShapeValid(proof)) return;
        // The verifier already authenticated this token. Old proofs need no migration.
        try {
            String payload = new String(java.util.Base64.getUrlDecoder().decode(proof.split("\\.")[1]), StandardCharsets.UTF_8);
            JsonObject claims = new com.google.gson.JsonParser().parse(payload).getAsJsonObject();
            if (!"minecraft-online-session".equals(SignedTokenSupport.readString(claims, "identityAuthority"))) return;
        } catch (RuntimeException ignored) { return; }
        JsonObject body = new JsonObject();
        body.addProperty("proof", proof);
        body.addProperty("username", username);
        body.addProperty("minecraftUuid", uuid.toString());
        final byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        try {
            WORK.execute(() -> {
                for (int attempt = 0; attempt < 3 && active == config; attempt++) {
                    int status = send(config, bytes);
                    if (status == 204 || status == 400 || status == 401 || status == 403) return;
                    if (attempt < 2) try { Thread.sleep(250L * (attempt + 1)); }
                    catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return; }
                }
                if (active == config && PackVersionLock.LOG != null)
                    PackVersionLock.LOG.warn("Optional account metadata delivery is unavailable; game admission is unaffected.");
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            // Bounded optional queue: another authenticated join can retry later.
        }
    }

    private static int send(Config config, byte[] body) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) config.endpoint.toURL().openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + config.token);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setFixedLengthStreamingMode(body.length);
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            return connection.getResponseCode();
        } catch (Exception ignored) { return 503; }
        finally { if (connection != null) connection.disconnect(); }
    }

    private static final class Config {
        final URI endpoint;
        final String token;
        Config(URI endpoint, String token) {
            if (token == null || token.length() < 32 || token.length() > 512 || token.contains("\r") || token.contains("\n"))
                throw new IllegalArgumentException("Invalid server credential");
            this.endpoint = endpoint; this.token = token;
        }
    }
}
