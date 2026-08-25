package com.aht.launcherlock;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class RemoteProofVerifier {
    private static final int MAX_RESPONSE_BYTES = 16384;
    private static final String VERIFY_PATH = "/api/launcher-proof/verify";
    private static final AtomicInteger THREAD_IDS = new AtomicInteger();
    private static final ThreadPoolExecutor EXECUTOR = new ThreadPoolExecutor(
            1, 2, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<Runnable>(128),
            new ThreadFactory() {
                @Override
                public Thread newThread(Runnable runnable) {
                    Thread thread = new Thread(runnable,
                            "AHT-Launcher-Verification-" + THREAD_IDS.incrementAndGet());
                    thread.setDaemon(true);
                    thread.setPriority(Thread.NORM_PRIORITY - 1);
                    return thread;
                }
            },
            new ThreadPoolExecutor.AbortPolicy()
    );

    static final class Result {
        final boolean accepted;
        final String code;
        final String currentLauncherVersion;
        final String necessaryLauncherVersion;

        private Result(boolean accepted, String code, String currentLauncherVersion,
                       String necessaryLauncherVersion) {
            this.accepted = accepted;
            this.code = safeCode(code);
            this.currentLauncherVersion = safeVersion(currentLauncherVersion);
            this.necessaryLauncherVersion = safeVersion(necessaryLauncherVersion);
        }

        static Result accepted(String current, String necessary) {
            return new Result(true, "ACCEPTED", current, necessary);
        }

        static Result updateRequired(String current, String necessary) {
            return new Result(false, "LAUNCHER_UPDATE_REQUIRED", current, necessary);
        }

        static Result denied(String code) {
            return new Result(false, code, "", "");
        }

        static Result unavailable() {
            return new Result(false, "VERIFICATION_UNAVAILABLE", "", "");
        }
    }

    private RemoteProofVerifier() {
    }

    static void cancelQueuedWork() {
        EXECUTOR.getQueue().clear();
        EXECUTOR.purge();
    }

    static CompletableFuture<Result> verifyAsync(final String verificationUrl, final String token,
                                                 final String expectedUsername, final UUID expectedUuid,
                                                 final String expectedPackId, final int connectTimeoutMillis,
                                                 final int readTimeoutMillis) {
        if (!isVerificationUrlAllowed(verificationUrl) || !LauncherProofMessage.isTokenShapeValid(token)) {
            return CompletableFuture.completedFuture(Result.denied("INVALID_LAUNCHER_PROOF"));
        }
        try {
            return CompletableFuture.supplyAsync(() -> verifyNow(verificationUrl, token, expectedUsername,
                    expectedUuid, expectedPackId, connectTimeoutMillis, readTimeoutMillis), EXECUTOR);
        } catch (RejectedExecutionException ignored) {
            return CompletableFuture.completedFuture(Result.unavailable());
        }
    }

    private static Result verifyNow(String verificationUrl, String token, String expectedUsername,
                                    UUID expectedUuid, String expectedPackId,
                                    int connectTimeoutMillis, int readTimeoutMillis) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(verificationUrl).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(boundedTimeout(connectTimeoutMillis));
            connection.setReadTimeout(boundedTimeout(readTimeoutMillis));
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("User-Agent", "AHT-Launcher-Lock/" + PackVersionLock.VERSION);
            int status = connection.getResponseCode();
            String contentType = connection.getHeaderField("Content-Type");
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = readBoundedBody(stream);
            return parseResponse(status, contentType, body, expectedUsername, expectedUuid, expectedPackId);
        } catch (Exception ignored) {
            return Result.unavailable();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static Result parseResponseForTests(int status, String contentType, String body,
                                        String expectedUsername, UUID expectedUuid, String expectedPackId) {
        return parseResponse(status, contentType, body, expectedUsername, expectedUuid, expectedPackId);
    }

    private static Result parseResponse(int status, String contentType, String body,
                                        String expectedUsername, UUID expectedUuid, String expectedPackId) {
        if (contentType == null || !contentType.toLowerCase(Locale.ROOT).startsWith("application/json")
                || body == null || body.isEmpty() || body.length() > MAX_RESPONSE_BYTES) {
            return Result.unavailable();
        }
        JsonObject root;
        try {
            JsonElement parsed = new JsonParser().parse(body);
            if (parsed == null || !parsed.isJsonObject()) return Result.unavailable();
            root = parsed.getAsJsonObject();
        } catch (RuntimeException ignored) {
            return Result.unavailable();
        }

        if (status == 426 && "LAUNCHER_UPDATE_REQUIRED".equals(readString(root, "code"))) {
            String current = readString(root, "currentLauncherVersion");
            String necessary = readString(root, "necessaryLauncherVersion");
            return validVersion(current) && validVersion(necessary)
                    ? Result.updateRequired(current, necessary)
                    : Result.unavailable();
        }
        if (status != 200 || !readBoolean(root, "ok") || !readBoolean(root, "valid")
                || !readBoolean(root, "accessGranted")) {
            if (status == 401) return Result.denied("INVALID_LAUNCHER_PROOF");
            if (status == 403) return Result.denied("ACCESS_RESTRICTED");
            return Result.unavailable();
        }

        JsonObject session = readObject(root, "session");
        JsonObject policy = readObject(root, "policy");
        String username = readString(session, "minecraftUsername");
        String uuid = readString(session, "minecraftUuid");
        String packId = readString(session, "packId");
        String launcherVersion = readString(session, "launcherVersion");
        String current = readString(policy, "currentLauncherVersion");
        String necessary = readString(policy, "necessaryLauncherVersion");
        if (expectedUsername == null || expectedUuid == null || expectedPackId == null
                || !expectedUsername.equalsIgnoreCase(username)
                || !expectedUuid.toString().equals(uuid)
                || !expectedPackId.equals(packId)
                || !launcherVersion.equals(current)
                || !validVersion(current) || !validVersion(necessary)) {
            return Result.denied("PROOF_IDENTITY_MISMATCH");
        }
        Integer comparison = compareVersions(current, necessary);
        return comparison != null && comparison.intValue() >= 0
                ? Result.accepted(current, necessary)
                : Result.updateRequired(current, necessary);
    }

    static boolean isVerificationUrlAllowedForTests(String value) {
        return isVerificationUrlAllowed(value);
    }

    private static boolean isVerificationUrlAllowed(String value) {
        try {
            URI uri = new URI(value == null ? "" : value.trim());
            if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || uri.getHost() == null || !VERIFY_PATH.equals(uri.getPath())) return false;
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if ("https".equals(scheme)) return uri.getPort() == -1 || uri.getPort() == 443;
            if (!"http".equals(scheme) || !Boolean.getBoolean("aht.launcherlock.allowInsecureLoopbackForTests")) {
                return false;
            }
            InetAddress address = InetAddress.getByName(uri.getHost());
            return address.isLoopbackAddress();
        } catch (Exception ignored) {
            return false;
        }
    }

    private static int boundedTimeout(int value) {
        return Math.max(500, Math.min(value, 15000));
    }

    private static String readBoundedBody(InputStream stream) throws Exception {
        if (stream == null) return "";
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[2048];
            int read;
            int total = 0;
            while ((read = input.read(buffer)) >= 0) {
                total += read;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("response too large");
                output.write(buffer, 0, read);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static JsonObject readObject(JsonObject root, String key) {
        try {
            return root != null && root.has(key) && root.get(key).isJsonObject()
                    ? root.getAsJsonObject(key) : null;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static String readString(JsonObject root, String key) {
        try {
            return root != null && root.has(key) && root.get(key).isJsonPrimitive()
                    && root.get(key).getAsJsonPrimitive().isString()
                    ? root.get(key).getAsString().trim() : "";
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private static boolean readBoolean(JsonObject root, String key) {
        try {
            return root != null && root.has(key) && root.get(key).isJsonPrimitive()
                    && root.get(key).getAsJsonPrimitive().isBoolean()
                    && root.get(key).getAsBoolean();
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static Integer compareVersions(String left, String right) {
        int[] a = parseVersion(left);
        int[] b = parseVersion(right);
        if (a == null || b == null) return null;
        for (int index = 0; index < a.length; index++) {
            if (a[index] != b[index]) return Integer.valueOf(a[index] > b[index] ? 1 : -1);
        }
        return Integer.valueOf(0);
    }

    private static boolean validVersion(String value) {
        return parseVersion(value) != null;
    }

    private static int[] parseVersion(String value) {
        String text = safeVersion(value);
        String[] parts = text.split("\\.", -1);
        if (parts.length != 3) return null;
        int[] parsed = new int[3];
        try {
            for (int index = 0; index < parts.length; index++) {
                if (parts[index].isEmpty() || parts[index].length() > 7
                        || !parts[index].matches("[0-9]+")) return null;
                parsed[index] = Integer.parseInt(parts[index]);
            }
            return parsed;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static String safeVersion(String value) {
        if (value == null) return "";
        String text = value.trim();
        return text.length() <= 40 && text.matches("[0-9A-Za-z.-]+") ? text : "";
    }

    private static String safeCode(String value) {
        if (value == null) return "VERIFICATION_UNAVAILABLE";
        String text = value.trim().toUpperCase(Locale.ROOT);
        return text.length() <= 80 && text.matches("[A-Z0-9_]+") ? text : "VERIFICATION_UNAVAILABLE";
    }
}
