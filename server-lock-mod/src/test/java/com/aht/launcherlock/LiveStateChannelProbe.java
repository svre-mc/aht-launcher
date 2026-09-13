package com.aht.launcherlock;

import java.io.IOException;
import java.lang.reflect.Field;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

/** Opt-in, read-only real WSS probe. Secrets stay in memory; output is aggregate timing only. */
public final class LiveStateChannelProbe {
    public static void main(String[] args) throws Exception {
        PackVersionLock.LOG = org.apache.logging.log4j.LogManager.getLogger("AHT-State-Channel-Probe");
        org.apache.logging.log4j.core.config.Configurator.setLevel("AHT-State-Channel-Probe",
            org.apache.logging.log4j.Level.INFO);
        Map<String, String> settings = new HashMap<String, String>();
        for (String line : Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8)) {
            String value = line.trim(); int equals = value.indexOf('=');
            if (value.startsWith("S:") && equals > 2) settings.put(value.substring(2, equals), value.substring(equals + 1));
        }
        String token = System.getenv("AHT_LIVE_PROBE_TOKEN");
        if (token == null || token.isEmpty()) token = System.getenv(settings.getOrDefault("stateServerTokenEnvironmentVariable", "AHT_LAUNCHER_STATE_TOKEN"));
        if (token == null || token.isEmpty()) token = settings.get("stateServerToken");
        if (token == null || token.isEmpty()) throw new IllegalStateException("Server channel credentials unavailable");
        boolean baseline = "baseline".equals(args[1]);
        try {
            ServerStateClient.start(settings.get("stateWebSocketUrl"), token,
                settings.get("attestationPublicKeySha256"), settings.get("requiredPackId"), 10000, 10000);
            long deadline = System.nanoTime() + 20000000000L;
            while ((ServerStateClient.currentSnapshot() == null || !baseline && !ServerStateClient.statusText().contains("2/2"))
                    && System.nanoTime() < deadline) Thread.sleep(5);
            if (ServerStateClient.currentSnapshot() == null || !baseline && !ServerStateClient.statusText().contains("2/2"))
                throw new IllegalStateException("Signed WSS channel did not become ready");
            if (baseline) {
                socketAt(0).close();
                long unavailable = 0, recovered = 0;
                deadline = System.nanoTime() + 20000000000L;
                while (System.nanoTime() < deadline) {
                    if (ServerStateClient.currentSnapshot() == null && unavailable == 0) unavailable = System.nanoTime();
                    if (unavailable != 0 && ServerStateClient.currentSnapshot() != null) { recovered = System.nanoTime(); break; }
                    Thread.sleep(1);
                }
                if (unavailable == 0 || recovered == 0) throw new AssertionError("Baseline outage/recovery was not reproduced");
                System.out.println("BASELINE signed-channel outage after one socket closed: " + (recovered - unavailable) / 1000000L + " ms");
            } else {
                for (int slot = 0; slot < 2; slot++) {
                    Socket previous = socketAt(slot); previous.close();
                    deadline = System.nanoTime() + 15000000000L;
                    do {
                        if (ServerStateClient.currentSnapshot() == null) throw new AssertionError("One transport loss interrupted authorization");
                        Thread.sleep(1);
                    } while ((socketAt(slot) == previous || !ServerStateClient.statusText().contains("2/2")) && System.nanoTime() < deadline);
                    if (!ServerStateClient.statusText().contains("2/2")) throw new AssertionError("Redundancy did not recover");
                }
                // Exercise real Cloudflare protocol ping/pong across two idle intervals.
                deadline = System.nanoTime() + 22000000000L;
                while (System.nanoTime() < deadline) {
                    if (ServerStateClient.currentSnapshot() == null) throw new AssertionError("Live channel became unavailable during heartbeat probe");
                    Thread.sleep(10);
                }
                System.out.println("UPGRADE live WSS: both forced single-socket losses recovered with no observed authorization gap; 22-second heartbeat probe passed");
            }
        } finally { ServerStateClient.stop(); }
    }

    private static Socket socketAt(int slot) throws Exception {
        try { return (Socket) field(ServerStateClient.class, "activeSocket").get(null); }
        catch (NoSuchFieldException upgraded) {
            Object config = field(ServerStateClient.class, "activeConfig").get(null);
            Object session = ((Object[]) field(config.getClass(), "sessions").get(config))[slot];
            return (Socket) field(session.getClass(), "socket").get(session);
        }
    }

    private static Field field(Class<?> owner, String name) throws NoSuchFieldException {
        Field field = owner.getDeclaredField(name); field.setAccessible(true); return field;
    }
}
