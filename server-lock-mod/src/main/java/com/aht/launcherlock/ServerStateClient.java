package com.aht.launcherlock;

import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

final class ServerStateClient {
    private static final String STATE_PATH = "/server/launcher-state";
    private static final String WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int MAX_HTTP_HEADER_BYTES = 16384;
    static final int MAX_MESSAGE_BYTES = 1900 * 1024;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static volatile Config activeConfig;

    interface ChannelSocketFactory { Socket create() throws IOException; }

    private ServerStateClient() {
    }

    static synchronized void start(String endpoint, String serverToken, String expectedKeyFingerprint,
                                   String expectedPackId, int connectTimeoutMillis,
                                   int heartbeatMillis) {
        start(endpoint, serverToken, expectedKeyFingerprint, expectedPackId, connectTimeoutMillis,
                heartbeatMillis, new ChannelSocketFactory() {
                    @Override public Socket create() throws IOException {
                        return (SSLSocket) SSLSocketFactory.getDefault().createSocket();
                    }
                });
    }

    static synchronized void startForTests(String endpoint, String serverToken, String expectedKeyFingerprint,
                                           String expectedPackId, ChannelSocketFactory sockets) {
        start(endpoint, serverToken, expectedKeyFingerprint, expectedPackId, 1000, 10000, sockets);
    }

    private static void start(String endpoint, String serverToken, String expectedKeyFingerprint,
                              String expectedPackId, int connectTimeoutMillis, int heartbeatMillis,
                              ChannelSocketFactory sockets) {
        stop();
        Config config;
        try {
            config = new Config(endpoint, serverToken, expectedKeyFingerprint, expectedPackId,
                    connectTimeoutMillis, heartbeatMillis, sockets);
        } catch (IllegalArgumentException error) {
            PackVersionLock.LOG.error("AHT Launcher Lock state channel configuration is invalid; reconnects will fail closed: {}",
                    error.getMessage());
            return;
        }
        activeConfig = config;
        RUNNING.set(true);
        for (final Session session : config.sessions) {
            Thread thread = new Thread(new Runnable() {
                @Override public void run() { runLoop(config, session); }
            }, "AHT-Launcher-State-Channel-" + (session.slot + 1));
            thread.setDaemon(true);
            thread.setPriority(Thread.NORM_PRIORITY - 1);
            session.thread = thread;
            thread.start();
        }
    }

    static synchronized void stop() {
        RUNNING.set(false);
        Config config = activeConfig;
        activeConfig = null;
        if (config == null) return;
        for (Session session : config.sessions) {
            config.connections.disconnected(session.slot);
            Socket socket = session.socket;
            if (socket != null) try { socket.close(); } catch (IOException ignored) {}
            Thread thread = session.thread;
            if (thread != null) thread.interrupt();
        }
    }

    static ServerPolicySnapshot currentSnapshot() {
        Config config = activeConfig;
        if (config == null || !active(config)) return null;
        return config.connections.current(System.nanoTime());
    }

    static String currentRevision() {
        ServerPolicySnapshot snapshot = currentSnapshot();
        return snapshot == null ? "" : snapshot.revision;
    }

    static String statusText() {
        ServerPolicySnapshot snapshot = currentSnapshot();
        if (snapshot == null) return "unavailable; waiting for a fresh signed policy";
        Config config = activeConfig;
        return "connected; signed policy " + snapshot.revision.substring(0, 12)
                + "; healthy connections " + (config == null ? 0
                : config.connections.healthyCount(System.nanoTime())) + "/2";
    }

    private static boolean active(Config config) {
        return RUNNING.get() && activeConfig == config;
    }

    static boolean isEndpointAllowedForTests(String endpoint) {
        try {
            parseEndpoint(endpoint);
            return true;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    static byte[] readSingleFrameForTests(byte[] wire) throws IOException {
        Frame frame = readFrame(new java.io.ByteArrayInputStream(wire));
        return frame.payload;
    }

    private static void runLoop(Config config, Session session) {
        long retryMillis = 1000L;
        while (active(config)) {
            Exception failure = new IOException("WebSocket closed");
            boolean established;
            try {
                connectAndRead(config, session);
            } catch (Exception error) {
                failure = error;
            } finally {
                established = config.connections.established(session.slot);
                config.connections.disconnected(session.slot);
                reportState(config, failure);
            }
            if (!active(config)) break;
            // Replace an established transport immediately while its peer stays live.
            // Failed handshakes retain bounded backoff to avoid a reconnect storm.
            long delay = established ? 0L : retryMillis + RANDOM.nextInt(201);
            retryMillis = established ? 1000L : Math.min(30000L, retryMillis * 2L);
            try {
                if (delay > 0L) Thread.sleep(delay);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    private static synchronized void reportState(Config config, Exception error) {
        if (!active(config)) return;
        ServerPolicySnapshot snapshot = config.connections.current(System.nanoTime());
        if (snapshot != null) {
            if (PackVersionLock.LOG != null && (!config.reportedAvailable
                    || !snapshot.revision.equals(config.reportedRevision))) {
                PackVersionLock.LOG.info(
                        "AHT Launcher Lock state channel connected; received signed policy revision {} (necessary launcher {}). New joins can be verified.",
                        snapshot.revision.substring(0, 12), snapshot.necessaryLauncherVersion);
            }
            config.reportedAvailable = true;
            config.reportedRevision = snapshot.revision;
        } else {
            long now = System.nanoTime();
            if (error != null && PackVersionLock.LOG != null && (config.reportedAvailable
                    || now - config.lastWarningNanos >= 60000000000L)) {
                PackVersionLock.LOG.warn(
                        "AHT Launcher Lock state channel has no healthy signed connection; new joins fail closed until it recovers ({}).",
                        safeError(error));
                config.lastWarningNanos = now;
            }
            config.reportedAvailable = false;
        }
    }

    private static void connectAndRead(Config config, Session session) throws Exception {
        Socket socket = config.sockets.create();
        synchronized (ServerStateClient.class) {
            if (!active(config)) { socket.close(); return; }
            session.socket = socket;
        }
        try {
        socket.setKeepAlive(true);
        socket.setTcpNoDelay(true);
        socket.connect(new InetSocketAddress(config.endpoint.getHost(), config.port), config.connectTimeoutMillis);
        socket.setSoTimeout(config.connectTimeoutMillis);
        if (socket instanceof SSLSocket) {
            SSLSocket tls = (SSLSocket) socket;
            SSLParameters ssl = tls.getSSLParameters();
            ssl.setEndpointIdentificationAlgorithm("HTTPS");
            tls.setSSLParameters(ssl);
            tls.startHandshake();
        }

        InputStream input = socket.getInputStream();
        OutputStream output = socket.getOutputStream();
        String websocketKey = randomWebSocketKey();
        String hostHeader = config.endpoint.getHost() + (config.port == 443 ? "" : ":" + config.port);
        String request = "GET " + STATE_PATH + " HTTP/1.1\r\n"
                + "Host: " + hostHeader + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + websocketKey + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "Authorization: Bearer " + config.serverToken + "\r\n"
                + "User-Agent: AHT-Launcher-Lock/" + PackVersionLock.VERSION + "\r\n\r\n";
        output.write(request.getBytes(StandardCharsets.US_ASCII));
        output.flush();
        verifyHandshake(readHttpHeaders(input), websocketKey);
        socket.setSoTimeout(config.heartbeatMillis);
        HeartbeatInput heartbeat = new HeartbeatInput(input, output);

        ByteArrayOutputStream fragmented = null;
        while (active(config)) {
            // Handle idle timeouts inside the read operation. Retrying readFrame
            // after a timeout would interpret a partial payload as a new header.
            Frame frame = readFrame(heartbeat);
            if (!active(config)) return;
            if (frame.opcode == 0xA) {
                if (heartbeat.pong(frame.payload)) {
                    config.connections.responsive(session.slot, System.nanoTime());
                }
                continue;
            }
            if (frame.opcode == 0x9) {
                writeFrame(output, 0xA, frame.payload);
                config.connections.responsive(session.slot, System.nanoTime());
                continue;
            }
            if (frame.opcode == 0x8) {
                try { writeFrame(output, 0x8, frame.payload); } catch (IOException ignored) {}
                return;
            }
            if (frame.opcode == 0x1) {
                if (fragmented != null) throw new IOException("overlapping WebSocket messages");
                fragmented = new ByteArrayOutputStream(Math.min(frame.payload.length + 128, MAX_MESSAGE_BYTES));
                appendBounded(fragmented, frame.payload);
            } else if (frame.opcode == 0x0) {
                if (fragmented == null) throw new IOException("unexpected WebSocket continuation");
                appendBounded(fragmented, frame.payload);
            } else {
                throw new IOException("unsupported WebSocket data frame");
            }
            if (!frame.fin) continue;
            if (fragmented == null) throw new IOException("empty WebSocket message");
            String message = strictUtf8(fragmented.toByteArray());
            fragmented = null;
            ServerPolicySnapshot snapshot = ServerPolicySnapshot.verifyMessage(
                    message, config.expectedKeyFingerprint, config.expectedPackId, System.currentTimeMillis()
            );
            synchronized (ServerStateClient.class) {
                if (!active(config)) return;
                config.connections.signedPolicy(session.slot, snapshot, System.nanoTime());
            }
            heartbeat.responsive();
            reportState(config, null);
        }
        } finally {
            try { socket.close(); } catch (IOException ignored) { }
            synchronized (ServerStateClient.class) {
                if (session.socket == socket) session.socket = null;
            }
        }
    }

    static byte[] readHeartbeatFrameForTests(InputStream input, OutputStream output) throws IOException {
        return readFrame(new HeartbeatInput(input, output)).payload;
    }

    private static final class HeartbeatInput extends InputStream {
        private final InputStream input;
        private final OutputStream output;
        private byte[] pending;
        HeartbeatInput(InputStream input, OutputStream output) { this.input = input; this.output = output; }
        private void idle() throws IOException {
            if (pending != null) throw new IOException("state channel heartbeat timed out");
            pending = new byte[8]; RANDOM.nextBytes(pending); writeFrame(output, 0x9, pending);
        }
        boolean pong(byte[] payload) {
            if (pending == null || !Arrays.equals(pending, payload)) return false;
            pending = null;
            return true;
        }
        void responsive() { pending = null; }
        @Override public int read() throws IOException {
            while (true) try { return input.read(); } catch (SocketTimeoutException timeout) { idle(); }
        }
        @Override public int read(byte[] bytes, int off, int len) throws IOException {
            while (true) try { return input.read(bytes, off, len); } catch (SocketTimeoutException timeout) { idle(); }
        }
    }

    private static String readHttpHeaders(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(1024);
        int matched = 0;
        while (output.size() < MAX_HTTP_HEADER_BYTES) {
            int value = input.read();
            if (value < 0) throw new EOFException("WebSocket handshake ended early");
            output.write(value);
            int expected = matched == 0 || matched == 2 ? '\r' : '\n';
            if (value == expected) {
                matched++;
                if (matched == 4) return new String(output.toByteArray(), StandardCharsets.US_ASCII);
            } else {
                matched = value == '\r' ? 1 : 0;
            }
        }
        throw new IOException("WebSocket response headers are oversized");
    }

    private static void verifyHandshake(String text, String websocketKey) throws Exception {
        String[] lines = text.split("\\r\\n");
        if (lines.length < 2 || !lines[0].matches("HTTP/1\\.[01] 101(?: .*)?")) {
            throw new IOException("WebSocket upgrade was rejected");
        }
        Map<String, List<String>> headers = new HashMap<String, List<String>>();
        for (int index = 1; index < lines.length; index++) {
            int colon = lines[index].indexOf(':');
            if (colon <= 0) continue;
            String name = lines[index].substring(0, colon).trim().toLowerCase(Locale.ROOT);
            String value = lines[index].substring(colon + 1).trim();
            if (!headers.containsKey(name)) headers.put(name, new ArrayList<String>());
            headers.get(name).add(value);
        }
        if (!headerContains(headers, "upgrade", "websocket")
                || !headerContains(headers, "connection", "upgrade")) {
            throw new IOException("WebSocket upgrade headers are invalid");
        }
        List<String> accepts = headers.get("sec-websocket-accept");
        String expected = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1").digest(
                        (websocketKey + WEBSOCKET_GUID).getBytes(StandardCharsets.US_ASCII)
                )
        );
        if (accepts == null || accepts.size() != 1
                || !SignedTokenSupport.constantEquals(accepts.get(0), expected)) {
            throw new IOException("WebSocket accept proof is invalid");
        }
    }

    private static boolean headerContains(Map<String, List<String>> headers, String name, String token) {
        List<String> values = headers.get(name);
        if (values == null) return false;
        for (String value : values) {
            for (String part : value.split(",")) {
                if (token.equalsIgnoreCase(part.trim())) return true;
            }
        }
        return false;
    }

    private static Frame readFrame(InputStream input) throws IOException {
        int first = input.read();
        int second = input.read();
        if (first < 0 || second < 0) throw new EOFException("WebSocket closed");
        boolean fin = (first & 0x80) != 0;
        int reserved = first & 0x70;
        int opcode = first & 0x0f;
        boolean masked = (second & 0x80) != 0;
        long length = second & 0x7f;
        if (reserved != 0 || masked) throw new IOException("invalid WebSocket frame flags");
        if (length == 126) {
            length = ((long) readByte(input) << 8) | readByte(input);
        } else if (length == 127) {
            length = 0L;
            for (int index = 0; index < 8; index++) length = (length << 8) | readByte(input);
            if (length < 0L) throw new IOException("invalid WebSocket frame length");
        }
        boolean control = opcode >= 0x8;
        if ((control && (!fin || length > 125L)) || length > MAX_MESSAGE_BYTES) {
            throw new IOException("WebSocket frame is oversized");
        }
        byte[] payload = new byte[(int) length];
        readFully(input, payload);
        return new Frame(fin, opcode, payload);
    }

    private static void writeFrame(OutputStream output, int opcode, byte[] payload) throws IOException {
        if (payload == null) payload = new byte[0];
        if (payload.length > 125 && opcode >= 0x8) throw new IOException("control frame is oversized");
        output.write(0x80 | (opcode & 0x0f));
        if (payload.length <= 125) {
            output.write(0x80 | payload.length);
        } else if (payload.length <= 65535) {
            output.write(0x80 | 126);
            output.write((payload.length >>> 8) & 0xff);
            output.write(payload.length & 0xff);
        } else {
            output.write(0x80 | 127);
            long length = payload.length;
            for (int shift = 56; shift >= 0; shift -= 8) output.write((int) ((length >>> shift) & 0xff));
        }
        byte[] mask = new byte[4];
        RANDOM.nextBytes(mask);
        output.write(mask);
        for (int index = 0; index < payload.length; index++) output.write(payload[index] ^ mask[index & 3]);
        output.flush();
    }

    private static void appendBounded(ByteArrayOutputStream output, byte[] value) throws IOException {
        if (output.size() + value.length > MAX_MESSAGE_BYTES) throw new IOException("WebSocket message is oversized");
        output.write(value);
    }

    private static int readByte(InputStream input) throws IOException {
        int value = input.read();
        if (value < 0) throw new EOFException("WebSocket frame ended early");
        return value;
    }

    private static void readFully(InputStream input, byte[] target) throws IOException {
        int offset = 0;
        while (offset < target.length) {
            int read = input.read(target, offset, target.length - offset);
            if (read < 0) throw new EOFException("WebSocket frame ended early");
            offset += read;
        }
    }

    private static String strictUtf8(byte[] value) throws Exception {
        CharBuffer decoded = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(value));
        return decoded.toString();
    }

    private static String randomWebSocketKey() {
        byte[] value = new byte[16];
        RANDOM.nextBytes(value);
        return Base64.getEncoder().encodeToString(value);
    }

    private static URI parseEndpoint(String value) {
        try {
            URI uri = new URI(value == null ? "" : value.trim());
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!"wss".equals(scheme) || uri.getHost() == null || uri.getHost().isEmpty()
                    || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || !STATE_PATH.equals(uri.getPath()) || (uri.getPort() != -1 && uri.getPort() != 443)) {
                throw new IllegalArgumentException("stateWebSocketUrl must be an exact wss:// URL ending in " + STATE_PATH);
            }
            return uri;
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("stateWebSocketUrl is invalid");
        }
    }

    private static String safeError(Exception error) {
        String message = error == null ? "connection failed" : String.valueOf(error.getMessage());
        message = message.replaceAll("[\\r\\n\\t]", " ").trim();
        if (message.isEmpty()) message = error == null ? "connection failed" : error.getClass().getSimpleName();
        return message.length() <= 180 ? message : message.substring(0, 180);
    }

    private static final class Frame {
        final boolean fin;
        final int opcode;
        final byte[] payload;

        Frame(boolean fin, int opcode, byte[] payload) {
            this.fin = fin;
            this.opcode = opcode;
            this.payload = payload;
        }
    }

    private static final class Session {
        final int slot;
        volatile Socket socket;
        volatile Thread thread;
        Session(int slot) { this.slot = slot; }
    }

    private static final class Config {
        final URI endpoint;
        final int port;
        final String serverToken;
        final String expectedKeyFingerprint;
        final String expectedPackId;
        final int connectTimeoutMillis;
        final int heartbeatMillis;
        final ChannelSocketFactory sockets;
        final ServerStateConnections connections;
        final Session[] sessions = {new Session(0), new Session(1)};
        boolean reportedAvailable;
        String reportedRevision = "";
        long lastWarningNanos = Long.MIN_VALUE / 2;

        Config(String endpoint, String serverToken, String expectedKeyFingerprint,
               String expectedPackId, int connectTimeoutMillis, int heartbeatMillis,
               ChannelSocketFactory sockets) {
            this.endpoint = parseEndpoint(endpoint);
            this.port = this.endpoint.getPort() == -1 ? 443 : this.endpoint.getPort();
            this.serverToken = serverToken == null ? "" : serverToken.trim();
            this.expectedKeyFingerprint = expectedKeyFingerprint == null
                    ? "" : expectedKeyFingerprint.trim().toLowerCase(Locale.ROOT);
            this.expectedPackId = expectedPackId == null ? "" : expectedPackId.trim();
            this.connectTimeoutMillis = Math.max(1000, Math.min(connectTimeoutMillis, 30000));
            this.heartbeatMillis = Math.max(10000, Math.min(heartbeatMillis, 300000));
            this.sockets = sockets;
            this.connections = new ServerStateConnections(this.heartbeatMillis * 3000000L);
            if (!this.serverToken.matches("[A-Za-z0-9_-]{32,512}")) {
                throw new IllegalArgumentException("state server token is missing or invalid");
            }
            if (!this.expectedKeyFingerprint.matches("[a-f0-9]{64}")) {
                throw new IllegalArgumentException("attestation public-key fingerprint is missing or invalid");
            }
            if (!this.expectedPackId.matches("[A-Za-z0-9._-]{1,80}")) {
                throw new IllegalArgumentException("requiredPackId is invalid");
            }
        }
    }
}
