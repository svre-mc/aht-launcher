package com.aht.launcherlock;

import io.netty.buffer.Unpooled;
import net.minecraft.client.Minecraft;
import net.minecraft.network.NetworkManager;
import net.minecraft.network.PacketBuffer;
import net.minecraft.network.play.client.CPacketCustomPayload;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import net.minecraftforge.fml.common.gameevent.TickEvent;
import net.minecraftforge.fml.common.network.FMLNetworkEvent;
import net.minecraftforge.fml.common.network.simpleimpl.MessageContext;
import net.minecraftforge.fml.relauncher.Side;
import net.minecraftforge.fml.relauncher.SideOnly;

@SideOnly(Side.CLIENT)
public class ClientEvents {
    private static final ClientProofRetry RETRY = new ClientProofRetry();

    @SubscribeEvent
    public void onConnected(FMLNetworkEvent.ClientConnectedToServerEvent event) {
        if (!event.isLocal()) RETRY.connected(event.getManager(), System.nanoTime());
    }

    @SubscribeEvent
    public void onDisconnected(FMLNetworkEvent.ClientDisconnectionFromServerEvent event) {
        RETRY.finished(event.getManager());
    }

    /** Respond on this connection's network thread even while the first world is loading. */
    static void onControl(LauncherProofControl message, MessageContext context) {
        if (context.getClientHandler() == null) return;
        NetworkManager manager = context.getClientHandler().getNetworkManager();
        if (message.kind == 1) {
            RETRY.finished(manager);
        } else if (sendIfReady(manager)) {
            PackVersionLock.LOG.info("Sent launcher verification for this server connection.");
        }
    }

    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) return;
        Minecraft minecraft = Minecraft.getMinecraft();
        if (minecraft.player != null && minecraft.getConnection() != null) {
            sendIfReady(minecraft.getConnection().getNetworkManager());
        }
    }

    private static boolean sendIfReady(NetworkManager manager) {
        if (manager == null || !manager.isChannelOpen()
                || !RETRY.attempt(manager, System.nanoTime())) return false;
        LauncherProofMessage proof = LauncherProofReader.readLauncherProof();
        // A briefly unavailable or atomically replaced file is retried, never sent as a denial.
        if (!proof.available) return false;
        // Bind discriminator 0 to this exact socket. The wrapper's shared outbound channel can
        // already belong to a newer reconnect when an old callback finishes.
        PacketBuffer payload = new PacketBuffer(Unpooled.buffer());
        payload.writeByte(0);
        proof.toBytes(payload);
        manager.sendPacket(new CPacketCustomPayload(PackVersionLock.MODID, payload));
        return true;
    }
}
