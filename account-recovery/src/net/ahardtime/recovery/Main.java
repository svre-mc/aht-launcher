package net.ahardtime.recovery;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** One-shot Minecraft Launcher entry point. Never starts Minecraft or logs credentials. */
public final class Main {
    public interface Transport { int post(URL url, String body) throws Exception; }
    private static final String JOIN = "https://sessionserver.mojang.com/session/minecraft/join";

    public static void main(String[] args) {
        // Do not let an exception (including arguments or response bodies) reach launcher logs.
        try { run(args, Main::post); } catch (Exception ignored) { }
    }

    public static boolean run(String[] args, Transport transport) throws Exception {
        Map<String, String> values = new HashMap<>();
        java.util.List<String> required = java.util.Arrays.asList("--expected-name", "--expected-uuid", "--username",
                "--uuid", "--access-token", "--challenge", "--callback");
        for (int i = 0; i < args.length; i++) {
            if (!required.contains(args[i])) continue; // Minecraft Launcher may add window/demo arguments.
            if (i + 1 == args.length || values.containsKey(args[i])) return false;
            values.put(args[i], args[++i]);
        }
        if (values.size() != required.size()) return false;
        String expectedName = values.get("--expected-name");
        String expectedUuid = compact(values.get("--expected-uuid"));
        String username = values.get("--username");
        String uuid = compact(values.get("--uuid"));
        String token = values.get("--access-token");
        String challenge = values.get("--challenge");
        URL callback = new URL(values.get("--callback"));
        if (!"http".equals(callback.getProtocol()) || !"127.0.0.1".equals(callback.getHost())
                || callback.getPort() < 1 || callback.getUserInfo() != null || callback.getQuery() != null
                || !callback.getPath().matches("/complete/[a-f0-9]{64}")) return false;
        String outcome = "failed";
        if (expectedName != null && expectedName.matches("[A-Za-z0-9_]{3,16}")
                && expectedName.equalsIgnoreCase(username) && expectedUuid.matches("[a-f0-9]{32}")
                && expectedUuid.equals(uuid) && challenge != null && challenge.matches("[a-f0-9]{40}")
                && token != null && !token.isEmpty() && token.length() <= 32768 && !token.contains("${")) {
            try {
                String body = "{\"accessToken\":" + quote(token) + ",\"selectedProfile\":" + quote(uuid)
                        + ",\"serverId\":" + quote(challenge) + "}";
                if (transport.post(new URL(JOIN), body) == 204) outcome = "verified";
            } catch (Exception ignored) { }
        } else if (!expectedUuid.equals(uuid) || expectedName == null || !expectedName.equalsIgnoreCase(username)) {
            outcome = "wrong-account";
        }
        // Only a result is sent to AHT. The Worker independently verifies Mojang's challenge.
        transport.post(callback, "{\"result\":\"" + outcome + "\"}");
        return "verified".equals(outcome);
    }

    private static String compact(String value) { return value == null ? "" : value.replace("-", "").toLowerCase(java.util.Locale.ROOT); }
    private static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 32) out.append(String.format("\\u%04x", (int)c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
    private static int post(URL url, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setDoOutput(true);
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        try {
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            return connection.getResponseCode();
        } finally { connection.disconnect(); }
    }
}
