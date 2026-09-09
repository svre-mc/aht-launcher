package com.aht.launcherlock;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class LauncherProofControlTest {
    @Test
    public void requestAndAcknowledgementUseStrictOneByteFrames() {
        for (boolean accepted : new boolean[] { false, true }) {
            ByteBuf bytes = Unpooled.buffer();
            new LauncherProofControl(accepted).toBytes(bytes);
            LauncherProofControl decoded = new LauncherProofControl();
            decoded.fromBytes(bytes);
            assertEquals(accepted ? 1 : 0, decoded.kind);
            bytes.release();
        }
        ByteBuf extra = Unpooled.wrappedBuffer(new byte[] { 0, 1 });
        LauncherProofControl invalid = new LauncherProofControl();
        invalid.fromBytes(extra);
        assertEquals(-1, invalid.kind);
        extra.release();
    }
}
