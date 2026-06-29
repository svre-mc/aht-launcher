package com.aht.launcherlock;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraftforge.fml.common.FMLCommonHandler;
import net.minecraftforge.fml.common.network.simpleimpl.IMessage;
import net.minecraftforge.fml.common.network.simpleimpl.IMessageHandler;
import net.minecraftforge.fml.common.network.simpleimpl.MessageContext;

public class PackVersionMessageHandler implements IMessageHandler<PackVersionMessage, IMessage> {
    @Override
    public IMessage onMessage(final PackVersionMessage message, final MessageContext ctx) {
        final MinecraftServer server = FMLCommonHandler.instance().getMinecraftServerInstance();
        if (server == null || !server.isDedicatedServer()) {
            return null;
        }

        server.addScheduledTask(new Runnable() {
            @Override
            public void run() {
                EntityPlayerMP player = ctx.getServerHandler().player;
                PackVersionLock.handleClientVersion(player, message);
            }
        });
        return null;
    }
}
