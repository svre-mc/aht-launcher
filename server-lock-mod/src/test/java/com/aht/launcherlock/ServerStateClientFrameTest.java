package com.aht.launcherlock;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

public class ServerStateClientFrameTest {
    @Test
    public void emptyAndMaximumFramesRespectBoundaries() throws Exception {
        assertArrayEquals(new byte[0], ServerStateClient.readSingleFrameForTests(new byte[] { (byte) 0x81, 0 }));
        byte[] maximum = new byte[ServerStateClient.MAX_MESSAGE_BYTES];
        maximum[0] = 1;
        maximum[maximum.length - 1] = 2;
        assertEquals(maximum.length, ServerStateClient.readSingleFrameForTests(frame(maximum)).length);
    }

    @Test
    public void malformedAndTruncatedFramesAreRejected() throws Exception {
        expectRejected(new byte[] { (byte) 0x81, (byte) 0x80, 0, 0, 0, 0 });
        expectRejected(new byte[] { (byte) 0x81, 3, 'a', 'b' });
        expectRejected(frame(new byte[ServerStateClient.MAX_MESSAGE_BYTES + 1]));
    }

    private static byte[] frame(byte[] payload) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(payload.length + 10);
        output.write(0x81);
        if (payload.length <= 125) {
            output.write(payload.length);
        } else if (payload.length <= 65535) {
            output.write(126);
            output.write((payload.length >>> 8) & 0xff);
            output.write(payload.length & 0xff);
        } else {
            output.write(127);
            long length = payload.length;
            for (int shift = 56; shift >= 0; shift -= 8) output.write((int) ((length >>> shift) & 0xff));
        }
        output.write(payload);
        return output.toByteArray();
    }

    private static void expectRejected(byte[] wire) {
        try {
            ServerStateClient.readSingleFrameForTests(wire);
            fail("malformed frame was accepted");
        } catch (IOException expected) {
            // Expected fail-closed result.
        }
    }
}
