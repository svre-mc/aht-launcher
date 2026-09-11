package net.ahardtime.recovery;

import java.net.URL;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Test-only transport; not in the packaged helper JAR. */
public final class TestDriver {
    public static void main(String[] args) throws Exception {
        String endpoint = args[0];
        Main.run(Arrays.copyOfRange(args, 1, args.length), (url, body) -> {
            if (url.getProtocol().equals("https")) {
                if (!url.toString().equals("https://sessionserver.mojang.com/session/minecraft/join"))
                    throw new AssertionError("Unexpected credential destination");
                url = new URL(endpoint + "/test/mojang-join");
            }
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            try (java.io.OutputStream stream = connection.getOutputStream()) {
                stream.write(body.getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            connection.disconnect();
            return status;
        });
    }
}
