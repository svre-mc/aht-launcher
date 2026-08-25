package com.aht.launcherlock;

import io.netty.buffer.ByteBuf;
import net.minecraftforge.fml.common.network.ByteBufUtils;
import net.minecraftforge.fml.common.network.simpleimpl.IMessage;

public final class LauncherProofMessage implements IMessage {
    static final int MAX_TOKEN_CHARS = 8192;
    private static final int MAX_WIRE_BYTES = MAX_TOKEN_CHARS + 16;

    String token = "";
    boolean available;

    public LauncherProofMessage() {
    }

    private LauncherProofMessage(String token, boolean available) {
        this.token = token == null ? "" : token;
        this.available = available && isTokenShapeValid(this.token);
    }

    static LauncherProofMessage available(String token) {
        return new LauncherProofMessage(token, true);
    }

    static LauncherProofMessage unavailable() {
        return new LauncherProofMessage("", false);
    }

    @Override
    public void fromBytes(ByteBuf buffer) {
        this.available = false;
        this.token = "";
        if (buffer == null || buffer.readableBytes() <= 0 || buffer.readableBytes() > MAX_WIRE_BYTES) {
            if (buffer != null) buffer.skipBytes(buffer.readableBytes());
            return;
        }
        try {
            boolean declaredAvailable = buffer.readBoolean();
            String decoded = ByteBufUtils.readUTF8String(buffer);
            if (buffer.isReadable() || !declaredAvailable || !isTokenShapeValid(decoded)) {
                return;
            }
            this.token = decoded;
            this.available = true;
        } catch (RuntimeException ignored) {
            this.token = "";
            this.available = false;
        }
    }

    @Override
    public void toBytes(ByteBuf buffer) {
        boolean usable = this.available && isTokenShapeValid(this.token);
        buffer.writeBoolean(usable);
        ByteBufUtils.writeUTF8String(buffer, usable ? this.token : "");
    }

    static boolean isTokenShapeValid(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_TOKEN_CHARS) return false;
        int separators = 0;
        int segmentLength = 0;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character == '.') {
                if (segmentLength == 0 || separators >= 2) return false;
                separators++;
                segmentLength = 0;
                continue;
            }
            boolean allowed = character >= 'A' && character <= 'Z'
                    || character >= 'a' && character <= 'z'
                    || character >= '0' && character <= '9'
                    || character == '-' || character == '_';
            if (!allowed) return false;
            segmentLength++;
        }
        return separators == 2 && segmentLength > 0;
    }
}
