package com.aht.launcherlock;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.text.TextComponentString;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.common.config.Configuration;
import net.minecraftforge.fml.common.FMLCommonHandler;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;
import net.minecraftforge.fml.common.event.FMLPreInitializationEvent;
import net.minecraftforge.fml.common.event.FMLServerStartedEvent;
import net.minecraftforge.fml.common.event.FMLServerStoppingEvent;
import net.minecraftforge.fml.common.network.NetworkRegistry;
import net.minecraftforge.fml.common.network.simpleimpl.SimpleNetworkWrapper;
import net.minecraftforge.fml.relauncher.Side;
import org.apache.logging.log4j.Logger;

import java.io.File;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

@Mod(
        modid = PackVersionLock.MODID,
        name = PackVersionLock.NAME,
        version = PackVersionLock.VERSION,
        acceptedMinecraftVersions = "[1.12.2]",
        acceptableRemoteVersions = "*"
)
public class PackVersionLock {
    public static final String MODID = "ahtversionlock";
    public static final String NAME = "AHT Launcher Lock";
    public static final String VERSION = "1.2.1";

    private static final String DEFAULT_STATE_WEBSOCKET_URL =
            "wss://api.ahardtime.net/server/launcher-state";
    private static final String DEFAULT_UPDATE_MESSAGE =
            "Current Launcher Version: {current}\nNecessary Launcher Version: {necessary}\n"
                    + "Update A Hard Time Launcher, restart it, and reconnect.";
    private static final String DEFAULT_INVALID_MESSAGE =
            "A valid A Hard Time Launcher session is required. Restart the launcher and reconnect.";
    private static final String DEFAULT_UNAVAILABLE_MESSAGE =
            "A Hard Time Launcher policy is temporarily unavailable. Please reconnect shortly.";
    private static final String DEFAULT_PACK_UPDATE_MESSAGE =
            "Your A Hard Time modpack is out of date. Update it in A Hard Time Launcher and reconnect.";

    public static Logger LOG;
    public static SimpleNetworkWrapper NETWORK;

    private static final JoinSessionRegistry SESSIONS = new JoinSessionRegistry();
    private static final LocalProofVerifier.SnapshotProvider POLICY_SNAPSHOTS =
            new LocalProofVerifier.SnapshotProvider() {
                @Override
                public ServerPolicySnapshot current() {
                    return ServerStateClient.currentSnapshot();
                }

                @Override
                public String currentRevision() {
                    return ServerStateClient.currentRevision();
                }
            };
    private static String stateWebSocketUrl = DEFAULT_STATE_WEBSOCKET_URL;
    private static String stateServerTokenEnvironmentVariable = "AHT_LAUNCHER_STATE_TOKEN";
    private static String stateServerToken = "";
    private static String attestationPublicKeySha256 = "";
    private static String requiredPackId = "a-hard-time-dregora";
    private static String updateRequiredMessage = DEFAULT_UPDATE_MESSAGE;
    private static String invalidProofMessage = DEFAULT_INVALID_MESSAGE;
    private static String verificationUnavailableMessage = DEFAULT_UNAVAILABLE_MESSAGE;
    private static int timeoutTicks = 300;
    private static int stateConnectTimeoutMillis = 10000;
    private static int stateHeartbeatMillis = 30000;

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        LOG = event.getModLog();
        if (event.getSide().isServer()) {
            loadConfig(new File(event.getModConfigurationDirectory(), "aht_version_lock.cfg"));
        }
        NETWORK = NetworkRegistry.INSTANCE.newSimpleChannel(MODID);
        NETWORK.registerMessage(LauncherProofMessageHandler.class, LauncherProofMessage.class, 0, Side.SERVER);
        NETWORK.registerMessage(LauncherProofControlHandler.class, LauncherProofControl.class, 1, Side.CLIENT);
    }

    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        if (event.getSide().isServer()) {
            MinecraftForge.EVENT_BUS.register(new ServerEvents());
        } else {
            MinecraftForge.EVENT_BUS.register(new ClientEvents());
        }
    }

    @Mod.EventHandler
    public void serverStarted(FMLServerStartedEvent event) {
        MinecraftServer server = FMLCommonHandler.instance().getMinecraftServerInstance();
        if (server != null && server.isDedicatedServer()) {
            ServerStateClient.start(
                    stateWebSocketUrl,
                    resolvedStateServerToken(),
                    attestationPublicKeySha256,
                    requiredPackId,
                    stateConnectTimeoutMillis,
                    stateHeartbeatMillis
            );
        }
    }

    @Mod.EventHandler
    public void serverStopping(FMLServerStoppingEvent event) {
        SESSIONS.clearAll();
        LocalProofVerifier.cancelQueuedWork();
        ServerStateClient.stop();
    }

    private static void loadConfig(File configFile) {
        Configuration config = new Configuration(configFile);
        config.load();
        stateWebSocketUrl = config.getString(
                "stateWebSocketUrl",
                "general",
                stateWebSocketUrl,
                "Exact WSS endpoint for the one persistent, server-only signed policy channel."
        ).trim();
        stateServerTokenEnvironmentVariable = config.getString(
                "stateServerTokenEnvironmentVariable",
                "general",
                stateServerTokenEnvironmentVariable,
                "Preferred environment variable containing the server-only channel token."
        ).trim();
        stateServerToken = config.getString(
                "stateServerToken",
                "general",
                stateServerToken,
                "Server-only fallback token. Never copy this config to a player client."
        ).trim();
        attestationPublicKeySha256 = config.getString(
                "attestationPublicKeySha256",
                "general",
                attestationPublicKeySha256,
                "Pinned lowercase SHA-256 of the Worker's RSA public-key SPKI."
        ).trim();
        requiredPackId = config.getString(
                "requiredPackId",
                "general",
                requiredPackId,
                "Launcher packId required by this server."
        ).trim();
        timeoutTicks = config.getInt(
                "timeoutTicks",
                "general",
                timeoutTicks,
                40,
                1200,
                "Ticks to wait after login for signed local launcher-proof verification."
        );
        stateConnectTimeoutMillis = config.getInt(
                "stateConnectTimeoutMillis",
                "general",
                stateConnectTimeoutMillis,
                1000,
                30000,
                "TLS/WebSocket connection timeout in milliseconds."
        );
        stateHeartbeatMillis = config.getInt(
                "stateHeartbeatMillis",
                "general",
                stateHeartbeatMillis,
                10000,
                300000,
                "WebSocket liveness heartbeat in milliseconds; this does not read launcher policy."
        );
        updateRequiredMessage = decodeNewlines(config.getString(
                "updateRequiredMessage",
                "general",
                encodeNewlines(updateRequiredMessage),
                "Disconnect message. Tokens: {current}, {necessary}. Use \\n for a new line."
        ));
        invalidProofMessage = decodeNewlines(config.getString(
                "invalidProofMessage",
                "general",
                encodeNewlines(invalidProofMessage),
                "Disconnect message for missing, invalid, mismatched, or restricted launcher proof."
        ));
        verificationUnavailableMessage = decodeNewlines(config.getString(
                "verificationUnavailableMessage",
                "general",
                encodeNewlines(verificationUnavailableMessage),
                "Fail-closed disconnect message when the signed policy channel is unavailable."
        ));
        if (!ServerStateClient.isEndpointAllowedForTests(stateWebSocketUrl)) {
            LOG.error("AHT Launcher Lock stateWebSocketUrl is invalid; reconnects will fail closed.");
        }
        if (!stateServerTokenEnvironmentVariable.matches("[A-Za-z_][A-Za-z0-9_]{0,79}")) {
            LOG.error("AHT Launcher Lock stateServerTokenEnvironmentVariable is invalid; reconnects will fail closed.");
        }
        if (!attestationPublicKeySha256.matches("[a-f0-9]{64}")) {
            LOG.error("AHT Launcher Lock attestationPublicKeySha256 is missing or invalid; reconnects will fail closed.");
        }
        if (requiredPackId.isEmpty() || requiredPackId.length() > 80) {
            LOG.error("AHT Launcher Lock requiredPackId is invalid; reconnects will fail closed.");
        }
        if (config.hasChanged()) {
            config.save();
        }
    }

    static void watchPlayer(EntityPlayerMP player) {
        if (player == null || player.connection == null) return;
        if (rejectOutdatedClient(player)) return;
        SESSIONS.begin(player.getUniqueID(), player.connection.netManager, timeoutTicks);
        sendControl(player, SESSIONS.isAccepted(player.getUniqueID(), player.connection.netManager));
    }

    static void clearPlayer(UUID playerId) {
        SESSIONS.clear(playerId);
    }

    static void clearPlayer(EntityPlayerMP player) {
        if (player != null && player.connection != null) {
            SESSIONS.clear(player.getUniqueID(), player.connection.netManager);
        }
    }

    static void handleLauncherProof(final EntityPlayerMP player, LauncherProofMessage message) {
        if (player == null || player.connection == null
                || !player.connection.netManager.isChannelOpen()) return;
        MinecraftServer server = FMLCommonHandler.instance().getMinecraftServerInstance();
        EntityPlayerMP current = server == null || server.getPlayerList() == null
                ? null : server.getPlayerList().getPlayerByUUID(player.getUniqueID());
        if (current != null && current != player) return;
        if (rejectOutdatedClient(player)) return;
        final UUID playerId = player.getUniqueID();
        SESSIONS.begin(playerId, player.connection.netManager, timeoutTicks);
        if (SESSIONS.isAccepted(playerId, player.connection.netManager)) {
            sendControl(player, true);
            return;
        }

        // A temporarily unreadable proof file is not a signed denial. Keep requesting it until
        // the original bounded join deadline expires.
        if (message == null || !message.available) return;
        final UUID connectionId = SESSIONS.markVerificationInFlight(playerId, player.connection.netManager);
        if (connectionId == null) return;
        if (!LauncherProofMessage.isTokenShapeValid(message.token)) {
            if (SESSIONS.fail(playerId, connectionId)) {
                disconnect(player, invalidProofMessage, "INVALID_LAUNCHER_PROOF", "", "");
            }
            return;
        }

        CompletableFuture<LocalProofVerifier.Result> verification = LocalProofVerifier.verifyAsync(
                message.token,
                player.getName(),
                playerId,
                requiredPackId,
                remoteIp(player),
                POLICY_SNAPSHOTS
        );
        verification.whenComplete((result, error) -> scheduleVerificationResult(
                playerId,
                connectionId,
                error == null && result != null ? result : LocalProofVerifier.Result.unavailable()
        ));
    }

    private static void scheduleVerificationResult(final UUID playerId, final UUID connectionId,
                                                   final LocalProofVerifier.Result result) {
        final MinecraftServer server = FMLCommonHandler.instance().getMinecraftServerInstance();
        if (server == null || !server.isDedicatedServer() || server.isServerStopped()) return;
        server.addScheduledTask(new Runnable() {
            @Override
            public void run() {
                completeVerification(server, playerId, connectionId, result);
            }
        });
    }

    private static void completeVerification(MinecraftServer server, UUID playerId, UUID connectionId,
                                             LocalProofVerifier.Result result) {
        EntityPlayerMP player = server.getPlayerList() == null
                ? null : server.getPlayerList().getPlayerByUUID(playerId);
        if (player == null || player.connection == null) {
            SESSIONS.fail(playerId, connectionId);
            return;
        }
        if (!SESSIONS.current(playerId, connectionId)) return;
        if (result.accepted) {
            if (SESSIONS.accept(playerId, connectionId)) {
                LOG.info("{} passed signed local launcher verification (current {}, necessary {}, policy {}).",
                        player.getName(), result.currentLauncherVersion, result.necessaryLauncherVersion,
                        result.policyRevision.substring(0, 12));
                sendControl(player, true);
            }
            return;
        }
        // Keep the admission gate closed, but tolerate a short state-channel reconnect by
        // requesting the same signed proof again within the unchanged join deadline.
        if ("VERIFICATION_UNAVAILABLE".equals(result.code)) {
            if (SESSIONS.retryVerification(playerId, connectionId)) sendControl(player, false);
            return;
        }
        if (!SESSIONS.fail(playerId, connectionId)) return;
        if ("LAUNCHER_UPDATE_REQUIRED".equals(result.code)) {
            String message = updateRequiredMessage
                    .replace("{current}", readableVersion(result.currentLauncherVersion))
                    .replace("{necessary}", readableVersion(result.necessaryLauncherVersion));
            disconnect(player, message, result.code,
                    result.currentLauncherVersion, result.necessaryLauncherVersion);
        } else {
            disconnect(player, invalidProofMessage, result.code, "", "");
        }
    }

    static void expirePendingPlayers(MinecraftServer server) {
        if (server == null || server.getPlayerList() == null) return;
        for (UUID playerId : SESSIONS.requestsDue()) {
            sendControl(server.getPlayerList().getPlayerByUUID(playerId), false);
        }
        for (Map.Entry<UUID, String> expired : SESSIONS.tickAndCollectExpired().entrySet()) {
            EntityPlayerMP player = server.getPlayerList().getPlayerByUUID(expired.getKey());
            if (player != null && player.connection != null) {
                boolean deliveryTimeout = "PROOF_DELIVERY_TIMEOUT".equals(expired.getValue());
                disconnect(player,
                        deliveryTimeout
                                ? "Launcher verification was not received. Fully close Minecraft, then click Play in A Hard Time Launcher and reconnect."
                                : verificationUnavailableMessage,
                        expired.getValue(), "", "");
            }
        }
    }

    private static void sendControl(EntityPlayerMP player, boolean accepted) {
        if (player == null || player.connection == null
                || !player.connection.netManager.isChannelOpen()) return;
        net.minecraftforge.fml.common.network.handshake.NetworkDispatcher dispatcher =
                net.minecraftforge.fml.common.network.handshake.NetworkDispatcher.get(
                        player.connection.netManager);
        // Never send the new discriminator to an older client that did not register it.
        if (dispatcher != null && dispatcher.getModList() != null
                && VERSION.equals(dispatcher.getModList().get(MODID))) {
            NETWORK.sendTo(new LauncherProofControl(accepted), player);
        }
    }

    private static boolean rejectOutdatedClient(EntityPlayerMP player) {
        if (player == null || player.connection == null) return false;
        net.minecraftforge.fml.common.network.handshake.NetworkDispatcher dispatcher =
                net.minecraftforge.fml.common.network.handshake.NetworkDispatcher.get(
                        player.connection.netManager);
        if (dispatcher == null || dispatcher.getModList() == null) return false;
        String clientVersion = dispatcher.getModList().get(MODID);
        if (VERSION.equals(clientVersion)) return false;
        SESSIONS.clear(player.getUniqueID(), player.connection.netManager);
        disconnect(player, DEFAULT_PACK_UPDATE_MESSAGE, "MODPACK_UPDATE_REQUIRED",
                clientVersion, VERSION);
        return true;
    }

    private static void disconnect(EntityPlayerMP player, String message, String code,
                                   String currentVersion, String necessaryVersion) {
        LOG.warn("Disconnecting {} from AHT Launcher Lock: {} (current {}, necessary {}).",
                player.getName(), safeLogCode(code), readableVersion(currentVersion),
                readableVersion(necessaryVersion));
        player.connection.disconnect(new TextComponentString(limitMessage(message)));
    }

    private static String readableVersion(String value) {
        return value == null || value.trim().isEmpty() ? "unknown" : value.trim();
    }

    private static String safeLogCode(String value) {
        return value != null && value.matches("[A-Z0-9_]{1,80}") ? value : "VERIFICATION_FAILED";
    }

    private static String limitMessage(String value) {
        String message = value == null ? "" : value.trim();
        if (message.isEmpty()) message = DEFAULT_INVALID_MESSAGE;
        return message.length() <= 1000 ? message : message.substring(0, 1000);
    }

    private static String encodeNewlines(String value) {
        return value == null ? "" : value.replace("\r", "").replace("\n", "\\n");
    }

    private static String decodeNewlines(String value) {
        return value == null ? "" : value.replace("\\n", "\n");
    }

    private static String resolvedStateServerToken() {
        String value = "";
        if (stateServerTokenEnvironmentVariable.matches("[A-Za-z_][A-Za-z0-9_]{0,79}")) {
            try {
                value = System.getenv(stateServerTokenEnvironmentVariable);
            } catch (SecurityException ignored) {
                value = "";
            }
        }
        value = value == null ? "" : value.trim();
        return value.isEmpty() ? stateServerToken : value;
    }

    private static String remoteIp(EntityPlayerMP player) {
        try {
            SocketAddress remote = player.connection.netManager.getRemoteAddress();
            if (!(remote instanceof InetSocketAddress)) return "";
            InetSocketAddress address = (InetSocketAddress) remote;
            return address.getAddress() == null ? "" : address.getAddress().getHostAddress();
        } catch (RuntimeException ignored) {
            return "";
        }
    }
}
