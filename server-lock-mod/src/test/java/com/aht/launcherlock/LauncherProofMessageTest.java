package com.aht.launcherlock;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class LauncherProofMessageTest {
    @Test
    public void roundTripsMaximumValidToken() {
        String token = "a." + repeat('b', LauncherProofMessage.MAX_TOKEN_CHARS - 4) + ".c";
        assertEquals(LauncherProofMessage.MAX_TOKEN_CHARS, token.length());
        assertTrue(LauncherProofMessage.isTokenShapeValid(token));

        ByteBuf encoded = Unpooled.buffer();
        LauncherProofMessage.available(token).toBytes(encoded);
        LauncherProofMessage decoded = new LauncherProofMessage();
        decoded.fromBytes(encoded);

        assertTrue(decoded.available);
        assertEquals(token, decoded.token);
    }

    @Test
    public void emptyAndMalformedTokensFailClosed() {
        assertFalse(LauncherProofMessage.isTokenShapeValid(""));
        assertFalse(LauncherProofMessage.isTokenShapeValid("a.b"));
        assertFalse(LauncherProofMessage.isTokenShapeValid("a.b.c.d"));
        assertFalse(LauncherProofMessage.isTokenShapeValid("a.b!.c"));

        ByteBuf encoded = Unpooled.buffer();
        LauncherProofMessage.unavailable().toBytes(encoded);
        LauncherProofMessage decoded = new LauncherProofMessage();
        decoded.fromBytes(encoded);
        assertFalse(decoded.available);
        assertEquals("", decoded.token);
    }

    @Test
    public void truncatedAndTrailingPacketsFailClosed() {
        ByteBuf complete = Unpooled.buffer();
        LauncherProofMessage.available("a.payload.signature").toBytes(complete);

        ByteBuf truncated = complete.copy(0, complete.readableBytes() - 1);
        LauncherProofMessage truncatedMessage = new LauncherProofMessage();
        truncatedMessage.fromBytes(truncated);
        assertFalse(truncatedMessage.available);

        ByteBuf trailing = complete.copy();
        trailing.writeByte(1);
        LauncherProofMessage trailingMessage = new LauncherProofMessage();
        trailingMessage.fromBytes(trailing);
        assertFalse(trailingMessage.available);
    }

    @Test
    public void oversizedPacketIsDiscardedWithoutAllocation() {
        ByteBuf oversized = Unpooled.buffer(LauncherProofMessage.MAX_TOKEN_CHARS + 17);
        oversized.writeZero(LauncherProofMessage.MAX_TOKEN_CHARS + 17);
        LauncherProofMessage decoded = new LauncherProofMessage();
        decoded.fromBytes(oversized);

        assertFalse(decoded.available);
        assertEquals(0, oversized.readableBytes());
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index++) result.append(value);
        return result.toString();
    }
}
