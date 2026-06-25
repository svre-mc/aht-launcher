package com.aht.launcherlock;

import io.netty.buffer.ByteBuf;
import net.minecraftforge.fml.common.network.ByteBufUtils;
import net.minecraftforge.fml.common.network.simpleimpl.IMessage;

public class PackVersionMessage implements IMessage {
    public String packId = "";
    public String version = "";
    public boolean installedJsonPresent = false;

    public PackVersionMessage() {
    }

    public PackVersionMessage(String packId, String version, boolean installedJsonPresent) {
        this.packId = packId == null ? "" : packId;
        this.version = version == null ? "" : version;
        this.installedJsonPresent = installedJsonPresent;
    }

    @Override
    public void fromBytes(ByteBuf buf) {
        this.packId = ByteBufUtils.readUTF8String(buf);
        this.version = ByteBufUtils.readUTF8String(buf);
        this.installedJsonPresent = buf.readBoolean();
    }

    @Override
    public void toBytes(ByteBuf buf) {
        ByteBufUtils.writeUTF8String(buf, packId == null ? "" : packId);
        ByteBufUtils.writeUTF8String(buf, version == null ? "" : version);
        buf.writeBoolean(installedJsonPresent);
    }
}
