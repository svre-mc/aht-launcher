package com.aht.launcherlock;

import io.netty.buffer.ByteBuf;
import net.minecraftforge.fml.common.network.simpleimpl.IMessage;

/** One-byte server request (0) or acceptance acknowledgement (1). */
public final class LauncherProofControl implements IMessage {
    int kind = -1;

    public LauncherProofControl() {
    }

    LauncherProofControl(boolean accepted) {
        this.kind = accepted ? 1 : 0;
    }

    @Override
    public void fromBytes(ByteBuf bytes) {
        this.kind = bytes != null && bytes.readableBytes() == 1 ? bytes.readUnsignedByte() : -1;
    }

    @Override
    public void toBytes(ByteBuf bytes) {
        bytes.writeByte(kind);
    }
}
