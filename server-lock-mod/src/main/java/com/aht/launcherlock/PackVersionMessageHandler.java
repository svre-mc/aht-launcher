package com.aht.launcherlock;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraftforge.fml.common.FMLCommonHandler;
import net.minecraftforge.fml.common.network.simpleimpl.IMessage;
import net.minecraftforge.fml.common.network.simpleimpl.IMessageHandler;
import net.minecraftforge.fml.common.network.simpleimpl.MessageContext;

public class PackVersionMessageHandler implements IMessageHandler<PackVersionMessage, IMessage> {
    @Override
    public IMessage onMessage(final PackVersionMessage message, final MessageContext ctx) {
        FMLCommonHandler.instance().getMinecraftServerInstance().addScheduledTask(new Runnable() {
            @Override
            public void run() {
                EntityPlayerMP player = ctx.getServerHandler().player;
                PackVersionLock.handleClientVersion(player, message);
            }
        });
        return null;
    }
}
