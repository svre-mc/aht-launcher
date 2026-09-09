package com.aht.launcherlock;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClientProofRetryTest {
    @Test
    public void longForgeHandshakeDoesNotConsumeProofDeliveryWindow() {
        ClientProofRetry retry = new ClientProofRetry();
        Object socket = new Object();
        retry.connected(socket, 0L);
        assertTrue(retry.attempt(socket, 120_000_000_000L));
        assertTrue(retry.attempt(socket, 121_000_000_000L));
        assertFalse(retry.attempt(socket, 150_000_000_000L));
    }

    @Test
    public void serverRequestCanSendWithoutWaitingForClientTicks() {
        ClientProofRetry retry = new ClientProofRetry();
        Object socket = new Object();
        retry.connected(socket, 0L);
        assertTrue(retry.attempt(socket, 0L));
        assertFalse(retry.attempt(socket, 1L));
        assertTrue(retry.attempt(socket, 1_000_000_000L));
        retry.finished(socket);
        assertFalse(retry.attempt(socket, 2_000_000_000L));
    }

    @Test
    public void staleAcknowledgementDoesNotStopNewConnection() {
        ClientProofRetry retry = new ClientProofRetry();
        Object oldSocket = new Object();
        Object newSocket = new Object();
        retry.connected(oldSocket, 0L);
        retry.connected(newSocket, 100L);
        retry.finished(oldSocket);
        assertFalse(retry.attempt(oldSocket, 100L));
        assertTrue(retry.attempt(newSocket, 100L));
    }
}
