package com.aht.launcherlock;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.text.TextComponentString;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.common.config.Configuration;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;
import net.minecraftforge.fml.common.event.FMLPreInitializationEvent;
import net.minecraftforge.fml.common.network.NetworkRegistry;
import net.minecraftforge.fml.common.network.simpleimpl.SimpleNetworkWrapper;
import net.minecraftforge.fml.relauncher.Side;
import org.apache.logging.log4j.Logger;

import java.io.File;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Mod(
        modid = PackVersionLock.MODID,
        name = PackVersionLock.NAME,
        version = PackVersionLock.VERSION,
        acceptedMinecraftVersions = "[1.12.2]",
        acceptableRemoteVersions = "*"
)
public class PackVersionLock {
    public static final String MODID = "ahtversionlock";
    public static final String NAME = "AHT Version Lock";
    public static final String VERSION = "1.0.0";

    public static Logger LOG;
    public static SimpleNetworkWrapper NETWORK;
    public static final Map<UUID, Integer> pendingPlayers = new HashMap<UUID, Integer>();
    public static final Set<UUID> acceptedPlayers = new HashSet<UUID>();

    private static String requiredPackId = "a-hard-time-dregora";
    private static String requiredVersion = "2.8.1";
    private static String kickMessage = "Update A Hard Time in the launcher. Required: {required}. Your version: {actual}.";
    private static int timeoutTicks = 200;

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        LOG = event.getModLog();
        loadConfig(event.getSuggestedConfigurationFile());
        NETWORK = NetworkRegistry.INSTANCE.newSimpleChannel(MODID);
        NETWORK.registerMessage(PackVersionMessageHandler.class, PackVersionMessage.class, 0, Side.SERVER);
    }

    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        MinecraftForge.EVENT_BUS.register(new ServerEvents());
        if (event.getSide().isClient()) {
            MinecraftForge.EVENT_BUS.register(new ClientEvents());
        }
    }

    private static void loadConfig(File configFile) {
        Configuration config = new Configuration(configFile);
        config.load();
        requiredPackId = config.getString(
                "requiredPackId",
                "general",
                requiredPackId,
                "Launcher packId required by this server."
        );
        requiredVersion = config.getString(
                "requiredVersion",
                "general",
                requiredVersion,
                "Launcher-installed pack version required by this server."
        );
        timeoutTicks = config.getInt(
                "timeoutTicks",
                "general",
                timeoutTicks,
                40,
                1200,
                "Ticks to wait after login for the client launcher version report."
        );
        kickMessage = config.getString(
                "kickMessage",
                "general",
                kickMessage,
                "Disconnect message. Tokens: {pack}, {required}, {actual}, {reason}."
        );
        if (config.hasChanged()) {
            config.save();
        }
    }

    public static void watchPlayer(UUID playerId) {
        if (!acceptedPlayers.contains(playerId)) {
            pendingPlayers.put(playerId, timeoutTicks);
        }
    }

    public static void clearPlayer(UUID playerId) {
        pendingPlayers.remove(playerId);
        acceptedPlayers.remove(playerId);
    }

    public static void handleClientVersion(EntityPlayerMP player, PackVersionMessage message) {
        if (player == null) {
            return;
        }

        String actualPack = clean(message.packId);
        String actualVersion = clean(message.version);
        if (!message.installedJsonPresent) {
            disconnect(player, "launcher installed.json missing");
            return;
        }
        if (!requiredPackId.equals(actualPack)) {
            disconnect(player, "wrong pack id: " + readable(actualPack));
            return;
        }
        if (!requiredVersion.equals(actualVersion)) {
            disconnect(player, "version mismatch: " + readable(actualVersion));
            return;
        }

        acceptedPlayers.add(player.getUniqueID());
        pendingPlayers.remove(player.getUniqueID());
        LOG.info("{} passed AHT version lock with {} {}", player.getName(), actualPack, actualVersion);
    }

    public static void disconnect(EntityPlayerMP player, String reason) {
        UUID playerId = player.getUniqueID();
        pendingPlayers.remove(playerId);
        acceptedPlayers.remove(playerId);
        String actual = reason.contains(":") ? reason.substring(reason.indexOf(':') + 1).trim() : "missing";
        String message = kickMessage
                .replace("{pack}", requiredPackId)
                .replace("{required}", requiredVersion)
                .replace("{actual}", actual)
                .replace("{reason}", reason);
        LOG.warn("Disconnecting {} from AHT version lock: {}", player.getName(), reason);
        player.connection.disconnect(new TextComponentString(message));
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static String readable(String value) {
        return value == null || value.trim().isEmpty() ? "missing" : value.trim();
    }
}
