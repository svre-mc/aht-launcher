package com.aht.launcherlock;

import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import net.minecraftforge.fml.common.gameevent.TickEvent;
import net.minecraftforge.fml.common.network.FMLNetworkEvent;
import net.minecraftforge.fml.relauncher.Side;
import net.minecraftforge.fml.relauncher.SideOnly;

@SideOnly(Side.CLIENT)
public class ClientEvents {
    private int sendDelayTicks = -1;

    @SubscribeEvent
    public void onConnected(FMLNetworkEvent.ClientConnectedToServerEvent event) {
        if (event.isLocal()) {
            this.sendDelayTicks = -1;
            return;
        }

        this.sendDelayTicks = 20;
    }

    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END || sendDelayTicks < 0) {
            return;
        }
        sendDelayTicks--;
        if (sendDelayTicks == 0) {
            PackVersionLock.NETWORK.sendToServer(InstalledVersionReader.readInstalledVersion());
            sendDelayTicks = -1;
        }
    }
}
