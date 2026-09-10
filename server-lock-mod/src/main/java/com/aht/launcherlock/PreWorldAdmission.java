package com.aht.launcherlock;

import io.netty.channel.*;
import io.netty.util.ReferenceCountUtil;
import java.lang.reflect.Method;
import java.lang.reflect.Field;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.network.*;
import net.minecraft.network.play.client.CPacketCustomPayload;
import net.minecraft.network.play.client.CPacketKeepAlive;
import net.minecraft.network.play.server.*;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.management.PlayerList;
import net.minecraft.util.text.TextComponentString;

/** Pending players have no player-list/world membership and receive no world packets. */
public final class PreWorldAdmission {
    private static final String HANDLER = "aht:pre_world";
    private static final Map<NetworkManager,Pending> PENDING = new ConcurrentHashMap<NetworkManager,Pending>();
    // Slow cold audits keep waiting outside the world, never in a playable grace period.
    private static final long DEADLINE_NANOS = 180_000_000_000L;
    private PreWorldAdmission() { }

    public static void initialize(PlayerList players, NetworkManager manager, EntityPlayerMP player, NetHandlerPlayServer handler) {
        if (!players.getServerInstance().isDedicatedServer() || manager.isLocalChannel()) {
            enterWorld(players, manager, player, handler);
            return;
        }
        if (PENDING.size() >= 128 || PENDING.containsKey(manager)) { close(manager); return; }
        // Repeated connections for the same UUID must never replace an active admission's state.
        if (find(player.getUniqueID()) != null) { close(manager); return; }
        Pending pending = new Pending(players, manager, player, handler);
        PENDING.put(manager, pending);
        try {
            ChannelPipeline pipeline = manager.channel().pipeline();
            String anchor = pipeline.get("fml:packet_handler") != null ? "fml:packet_handler" : "packet_handler";
            pipeline.addBefore(anchor, HANDLER, pending);
            player.connection = handler;
            PackVersionLock.watchPlayer(player);
            PackVersionLock.LOG.info("AHT admission pending for {}; world entry is withheld.", player.getName());
        } catch (Throwable failure) { abandon(pending); }
    }

    static EntityPlayerMP find(UUID id) {
        for (Pending pending : PENDING.values()) if (id.equals(pending.player.getUniqueID()) && pending.manager.isChannelOpen()) return pending.player;
        return null;
    }
    static EntityPlayerMP find(MinecraftServer server, UUID id) {
        EntityPlayerMP pending = find(id);
        return pending != null ? pending : server.getPlayerList().getPlayerByUUID(id);
    }
    static boolean contains(EntityPlayerMP player) {
        return player != null && player.connection != null && PENDING.containsKey(player.connection.netManager);
    }
    static void tick() {
        for (Pending pending : PENDING.values()) {
            if (!pending.manager.isChannelOpen() || System.nanoTime() - pending.started >= DEADLINE_NANOS) { abandon(pending); continue; }
            if (!PackVersionLock.accepted(pending.player)) continue;
            try {
                if (pending.begin == null) {
                    Class<?> bridge = Class.forName("com.aht.anticheat.AhtAntiCheat");
                    pending.begin = bridge.getMethod("beginPreWorldAdmission", EntityPlayerMP.class);
                    pending.ready = bridge.getMethod("isPreWorldAdmissionReady", EntityPlayerMP.class);
                    pending.clear = bridge.getMethod("cancelPreWorldAdmission", EntityPlayerMP.class);
                    pending.begin.invoke(null, pending.player);
                }
                if (!Boolean.TRUE.equals(pending.ready.invoke(null, pending.player))) continue;
                if (!pending.manager.isChannelOpen() || !PENDING.remove(pending.manager, pending)) continue;
                // Keep the filter until JoinGame reaches the socket. Main-thread
                // packets queued before this point can still be awaiting Netty;
                // releasing them here would send abilities before the world exists.
                pending.worldEntryAuthorized = true;
                enterWorld(pending.players, pending.manager, pending.player, pending.handler);
                PackVersionLock.LOG.info("AHT admission accepted for {}; verified before world entry.", pending.player.getName());
            } catch (Throwable failure) { abandon(pending); }
        }
    }
    static void clearAll() { for (Pending pending : PENDING.values()) abandon(pending); }
    private static void enterWorld(PlayerList players, NetworkManager manager, EntityPlayerMP player, NetHandlerPlayServer handler) {
        try {
            Class<?> containment = Class.forName("com.aht.crashexploitfixer112.guard.ServerFaultContainment");
            containment.getMethod("initializeConnection", PlayerList.class, NetworkManager.class, EntityPlayerMP.class, NetHandlerPlayServer.class)
                .invoke(null, players, manager, player, handler);
        } catch (ClassNotFoundException absent) {
            players.initializeConnectionToPlayer(manager, player, handler);
        } catch (ReflectiveOperationException failure) {
            throw new IllegalStateException("AHT admission containment could not complete.", failure);
        }
    }
    private static void abandon(Pending pending) {
        PENDING.remove(pending.manager, pending);
        PackVersionLock.clearPlayer(pending.player);
        try { if (pending.clear != null) pending.clear.invoke(null, pending.player); } catch (ReflectiveOperationException ignored) { }
        close(pending.manager);
    }
    private static void close(NetworkManager manager) {
        if (manager.isChannelOpen()) {
            TextComponentString reason = new TextComponentString("Client verification could not be completed. Open AHT Launcher, repair, and reconnect.");
            manager.sendPacket(new SPacketDisconnect(reason), future -> manager.closeChannel(reason));
        }
    }
    private static boolean control(String channel) {
        return "ahtversionlock".equals(channel) || "aht_anticheat".equals(channel)
            || "FML|HS".equals(channel) || "REGISTER".equals(channel) || "UNREGISTER".equals(channel)
            || "MC|Brand".equals(channel);
    }
    private static void release(Object message) {
        if (message instanceof CPacketCustomPayload) ReferenceCountUtil.release(((CPacketCustomPayload)message).getBufferData());
        else if (message instanceof SPacketCustomPayload) ReferenceCountUtil.release(ServerPayload.value(ServerPayload.DATA, message));
        else ReferenceCountUtil.release(message);
    }
    // Vanilla marks the outgoing payload getters client-only; dedicated servers
    // strip those methods. The actual packet fields exist on both physical sides.
    private static final class ServerPayload {
        static final Field CHANNEL = field(String.class);
        static final Field DATA = field(PacketBuffer.class);
        static Field field(Class<?> type) {
            Field match = null;
            for (Field field : SPacketCustomPayload.class.getDeclaredFields()) if (field.getType() == type) {
                if (match != null) throw new IllegalStateException("Ambiguous AHT packet boundary.");
                match = field;
            }
            if (match == null) throw new IllegalStateException("AHT packet boundary unavailable.");
            match.setAccessible(true); return match;
        }
        static Object value(Field field, Object packet) {
            try { return field.get(packet); }
            catch (IllegalAccessException failure) { throw new IllegalStateException("AHT packet boundary unavailable.", failure); }
        }
    }
    static final class Pending extends ChannelDuplexHandler {
        final PlayerList players; final NetworkManager manager; final EntityPlayerMP player; final NetHandlerPlayServer handler;
        final long started = System.nanoTime(); final AdmissionBudget budget = new AdmissionBudget();
        volatile boolean admitted, worldEntryAuthorized;
        Method begin, ready, clear;
        Pending(PlayerList players, NetworkManager manager, EntityPlayerMP player, NetHandlerPlayServer handler) {
            this.players=players; this.manager=manager; this.player=player; this.handler=handler;
        }
        public void channelRead(ChannelHandlerContext context, Object message) throws Exception {
            if (admitted) { context.fireChannelRead(message); return; }
            int size = message instanceof CPacketCustomPayload ? ((CPacketCustomPayload)message).getBufferData().readableBytes() : 0;
            if (!budget.allow(size, System.nanoTime())) { release(message); context.close(); return; }
            if (message instanceof CPacketKeepAlive || (message instanceof CPacketCustomPayload && control(((CPacketCustomPayload)message).getChannelName()))) {
                context.fireChannelRead(message);
            } else release(message);
        }
        public void write(ChannelHandlerContext context, Object message, ChannelPromise promise) throws Exception {
            if (worldEntryAuthorized && message instanceof SPacketJoinGame) {
                admitted = true;
                context.pipeline().remove(this);
            }
            if (admitted || message instanceof SPacketDisconnect || message instanceof SPacketKeepAlive
                || (message instanceof SPacketCustomPayload && control((String)ServerPayload.value(ServerPayload.CHANNEL, message)))) {
                context.write(message, promise);
            } else { release(message); promise.trySuccess(); }
        }
    }
}
