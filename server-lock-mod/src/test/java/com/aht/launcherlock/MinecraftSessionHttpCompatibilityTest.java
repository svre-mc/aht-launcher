package com.aht.launcherlock;

import org.junit.Test;
import static org.junit.Assert.*;
import java.net.*;
import java.io.*;
import java.lang.reflect.*;

public class MinecraftSessionHttpCompatibilityTest {
    @Test public void serverMetadataUsesExplicitServiceIdentityAndNoRedirects() throws Exception {
        final ByteArrayOutputStream sent = new ByteArrayOutputStream();
        final HttpURLConnection[] observed = new HttpURLConnection[1];
        URL.setURLStreamHandlerFactory(protocol -> "ahtfixture".equals(protocol) ? new URLStreamHandler() {
            protected URLConnection openConnection(URL url) {
                return observed[0] = new HttpURLConnection(url) {
                    public void connect() {}
                    public void disconnect() {}
                    public boolean usingProxy() { return false; }
                    public OutputStream getOutputStream() { return sent; }
                    public int getResponseCode() { return 204; }
                };
            }
        } : null);
        Class<?> type = Class.forName("com.aht.launcherlock.MinecraftSessionLinkClient$Config");
        Constructor<?> constructor = type.getDeclaredConstructor(URI.class, String.class);
        constructor.setAccessible(true);
        Object config = constructor.newInstance(URI.create("ahtfixture://localhost/server/minecraft-session"),
            "fixture-server-token-12345678901234567890");
        Method send = MinecraftSessionLinkClient.class.getDeclaredMethod("send", type, byte[].class);
        send.setAccessible(true);
        byte[] body = "{}".getBytes("UTF-8");
        assertEquals(204, ((Integer) send.invoke(null, config, body)).intValue());
        assertEquals("AHT-Server/" + PackVersionLock.VERSION, observed[0].getRequestProperty("User-Agent"));
        assertFalse(observed[0].getInstanceFollowRedirects());
        assertEquals(5000, observed[0].getConnectTimeout());
        assertEquals(5000, observed[0].getReadTimeout());
        assertArrayEquals(body, sent.toByteArray());
    }
}
