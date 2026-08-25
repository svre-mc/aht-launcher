package com.aht.launcherlock;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraftforge.fml.common.FMLCommonHandler;
import net.minecraftforge.fml.common.network.simpleimpl.IMessage;
import net.minecraftforge.fml.common.network.simpleimpl.IMessageHandler;
import net.minecraftforge.fml.common.network.simpleimpl.MessageContext;

public final class LauncherProofMessageHandler implements IMessageHandler<LauncherProofMessage, IMessage> {
    @Override
    public IMessage onMessage(final LauncherProofMessage message, final MessageContext context) {
        final MinecraftServer server = FMLCommonHandler.instance().getMinecraftServerInstance();
        if (server == null || !server.isDedicatedServer()) return null;
        server.addScheduledTask(new Runnable() {
            @Override
            public void run() {
                EntityPlayerMP player = context.getServerHandler() == null ? null : context.getServerHandler().player;
                PackVersionLock.handleLauncherProof(player, message);
            }
        });
        return null;
    }
}
