package com.aht.launcherlock;

import net.minecraftforge.fml.common.network.simpleimpl.IMessage;
import net.minecraftforge.fml.common.network.simpleimpl.IMessageHandler;
import net.minecraftforge.fml.common.network.simpleimpl.MessageContext;
import net.minecraftforge.fml.relauncher.Side;

public final class LauncherProofControlHandler implements IMessageHandler<LauncherProofControl, IMessage> {
    @Override
    public IMessage onMessage(LauncherProofControl message, MessageContext context) {
        if (context.side == Side.CLIENT && (message.kind == 0 || message.kind == 1)) {
            ClientEvents.onControl(message, context);
        }
        return null;
    }
}
