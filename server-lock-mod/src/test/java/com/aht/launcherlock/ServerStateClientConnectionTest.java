package com.aht.launcherlock;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real TCP/WebSocket transport, production framing and signature verification; no live credentials. */
public class ServerStateClientConnectionTest {
    @After public void stopClient() { ServerStateClient.stop(); }

    @Test public void resetAndReconnectOfOneSocketNeverRemovesJoinVerification() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.startClient();
            await(() -> ServerStateClient.statusText().contains("2/2"));
            String revision = ServerStateClient.currentRevision();
            fixture.blockNew.set(true);
            fixture.peers.get(0).reset();
            long deadline = System.nanoTime() + 3000000000L;
            while (!ServerStateClient.statusText().contains("1/2") && System.nanoTime() < deadline) {
                assertNotNull("One TCP reset interrupted logical authorization", ServerStateClient.currentSnapshot());
                Thread.sleep(2);
            }
            assertTrue(ServerStateClient.statusText(), ServerStateClient.statusText().contains("1/2"));
            assertEquals(revision, ServerStateClient.currentRevision());
            fixture.blockNew.set(false);
            deadline = System.nanoTime() + 6000000000L;
            while (!ServerStateClient.statusText().contains("2/2") && System.nanoTime() < deadline) {
                assertNotNull("Reconnecting the backup interrupted its healthy peer", ServerStateClient.currentSnapshot());
                Thread.sleep(2);
            }
            assertTrue(ServerStateClient.statusText(), ServerStateClient.statusText().contains("2/2"));
            assertEquals(revision, ServerStateClient.currentRevision());
            assertTrue(fixture.peers.size() >= 3);
        }
    }

    @Test public void losingBothSocketsFailsClosedAndBadSignaturesCannotRestoreAvailability() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.startClient();
            await(() -> ServerStateClient.statusText().contains("2/2"));
            fixture.blockNew.set(true);
            for (Peer peer : fixture.peers) peer.reset();
            await(() -> ServerStateClient.currentSnapshot() == null);
            assertEquals("", ServerStateClient.currentRevision());
            com.google.gson.JsonObject forged = new com.google.gson.JsonParser().parse(fixture.message).getAsJsonObject();
            String[] token = forged.get("token").getAsString().split("\\.");
            byte[] signature = Base64.getUrlDecoder().decode(token[2]);
            signature[0] ^= 1;
            forged.addProperty("token", token[0] + "." + token[1] + "."
                + Base64.getUrlEncoder().withoutPadding().encodeToString(signature));
            fixture.message = forged.toString();
            fixture.blockNew.set(false);
            await(() -> fixture.peers.size() >= 4);
            assertNull(ServerStateClient.currentSnapshot());
            fixture.message = SignedStateTestSupport.stateMessage("0.2.24", null, true);
            await(() -> ServerStateClient.currentSnapshot() != null);
            assertEquals("0.2.24", ServerStateClient.currentSnapshot().necessaryLauncherVersion);
            ServerStateClient.stop();
            assertNull(ServerStateClient.currentSnapshot());
        }
    }

    @Test public void restartingTheServiceCannotReuseAnOldWorkersPolicyOrSocket() throws Exception {
        try (Fixture first = new Fixture(); Fixture second = new Fixture()) {
            first.startClient();
            await(() -> ServerStateClient.statusText().contains("2/2"));
            second.blockNew.set(true);
            second.startClient();
            assertNull(ServerStateClient.currentSnapshot());
            for (Peer peer : first.peers) peer.reset();
            assertNull(ServerStateClient.currentSnapshot());
            second.message = SignedStateTestSupport.stateMessage("0.2.25", null, true);
            second.blockNew.set(false);
            await(() -> ServerStateClient.statusText().contains("2/2"));
            assertEquals("0.2.25", ServerStateClient.currentSnapshot().necessaryLauncherVersion);
        }
    }

    private static void await(BooleanSupplier condition) throws Exception {
        long deadline = System.nanoTime() + 8000000000L;
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(5);
        assertTrue(ServerStateClient.statusText(), condition.getAsBoolean());
    }

    private static final class Fixture implements AutoCloseable {
        final ServerSocket listener = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
        final List<Peer> peers = new CopyOnWriteArrayList<Peer>();
        final AtomicBoolean blockNew = new AtomicBoolean();
        volatile String message = SignedStateTestSupport.stateMessage("0.2.23", null, true);
        final Thread accepting;

        Fixture() throws Exception {
            accepting = new Thread(() -> {
                while (!listener.isClosed()) try {
                    Peer peer = new Peer(listener.accept(), this);
                    peers.add(peer);
                    peer.thread.start();
                } catch (IOException closed) { break; }
            }, "State-channel-fixture");
            accepting.setDaemon(true);
            accepting.start();
        }

        void startClient() {
            ServerStateClient.startForTests("wss://state.example.invalid/server/launcher-state",
                "fixture-server-token-01234567890123456789", SignedStateTestSupport.KEY_FINGERPRINT,
                SignedStateTestSupport.PACK_ID, () -> {
                    if (blockNew.get()) throw new IOException("fixture connection unavailable");
                    return new Socket() {
                        @Override public void connect(SocketAddress ignored, int timeout) throws IOException {
                            super.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), listener.getLocalPort()), timeout);
                        }
                    };
                });
        }

        @Override public void close() throws Exception {
            blockNew.set(true);
            ServerStateClient.stop();
            listener.close();
            for (Peer peer : peers) peer.reset();
            accepting.join(1000);
            for (Peer peer : peers) peer.thread.join(1000);
        }
    }

    private static final class Peer {
        final Socket socket;
        final Thread thread;
        Peer(Socket socket, Fixture fixture) {
            this.socket = socket;
            thread = new Thread(() -> {
                try {
                    InputStream input = socket.getInputStream();
                    OutputStream output = socket.getOutputStream();
                    String headers = headers(input);
                    String key = null;
                    for (String line : headers.split("\r\n")) if (line.startsWith("Sec-WebSocket-Key: ")) key = line.substring(19).trim();
                    if (key == null) throw new IOException("missing websocket key");
                    String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                        .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
                    output.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    frame(output, 1, fixture.message.getBytes(StandardCharsets.UTF_8));
                    while (true) {
                        int opcode = input.read();
                        if (opcode < 0) break;
                        int size = input.read();
                        if ((size & 128) == 0 || (size & 127) > 125) throw new IOException("unexpected client control frame");
                        byte[] mask = bytes(input, 4), payload = bytes(input, size & 127);
                        for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
                        if ((opcode & 15) == 9) frame(output, 10, payload);
                        else if ((opcode & 15) == 8) break;
                    }
                } catch (Exception expectedClose) {
                    // The tests intentionally reset transports and reject invalid messages.
                } finally { try { socket.close(); } catch (IOException ignored) {} }
            }, "State-channel-peer");
            thread.setDaemon(true);
        }

        void reset() throws IOException {
            if (!socket.isClosed()) { socket.setSoLinger(true, 0); socket.close(); }
        }
    }

    private static String headers(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int end = 0;
        while (bytes.size() < 16384) {
            int value = input.read(); if (value < 0) throw new EOFException(); bytes.write(value);
            end = (end << 8) | value;
            if (end == 0x0d0a0d0a) return new String(bytes.toByteArray(), StandardCharsets.US_ASCII);
        }
        throw new IOException("oversized headers");
    }

    private static byte[] bytes(InputStream input, int size) throws IOException {
        byte[] data = new byte[size]; new DataInputStream(input).readFully(data); return data;
    }

    private static void frame(OutputStream output, int opcode, byte[] payload) throws IOException {
        output.write(128 | opcode);
        if (payload.length < 126) output.write(payload.length);
        else { output.write(126); output.write(payload.length >>> 8); output.write(payload.length & 255); }
        output.write(payload); output.flush();
    }
}
