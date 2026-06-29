package com.aht.launcherlock;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraftforge.fml.common.FMLCommonHandler;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import net.minecraftforge.fml.common.gameevent.PlayerEvent;
import net.minecraftforge.fml.common.gameevent.TickEvent;

import java.util.Iterator;
import java.util.Map;
import java.util.UUID;

public class ServerEvents {
    @SubscribeEvent
    public void onPlayerLoggedIn(PlayerEvent.PlayerLoggedInEvent event) {
        if (!isDedicatedServer()) {
            PackVersionLock.clearPlayer(event.player.getUniqueID());
            return;
        }

        if (event.player instanceof EntityPlayerMP) {
            EntityPlayerMP player = (EntityPlayerMP) event.player;
            PackVersionLock.watchPlayer(player.getUniqueID());
        }
    }

    @SubscribeEvent
    public void onPlayerLoggedOut(PlayerEvent.PlayerLoggedOutEvent event) {
        PackVersionLock.clearPlayer(event.player.getUniqueID());
    }

    @SubscribeEvent
    public void onServerTick(TickEvent.ServerTickEvent event) {
        if (event.phase != TickEvent.Phase.END || !isDedicatedServer()) {
            return;
        }

        MinecraftServer server = FMLCommonHandler.instance().getMinecraftServerInstance();
        if (server == null || server.getPlayerList() == null) {
            return;
        }

        Iterator<Map.Entry<UUID, Integer>> iterator = PackVersionLock.pendingPlayers.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<UUID, Integer> entry = iterator.next();
            int remaining = entry.getValue() - 1;
            if (remaining > 0) {
                entry.setValue(remaining);
                continue;
            }

            iterator.remove();
            EntityPlayerMP player = server.getPlayerList().getPlayerByUUID(entry.getKey());
            if (player != null && !PackVersionLock.acceptedPlayers.contains(entry.getKey())) {
                PackVersionLock.disconnect(player, "missing launcher version report");
            }
        }
    }

    private static boolean isDedicatedServer() {
        MinecraftServer server = FMLCommonHandler.instance().getMinecraftServerInstance();
        return server != null && server.isDedicatedServer();
    }
}
