package com.aht.launcherlock;

import org.junit.Test;

import java.util.Collections;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class JoinSessionRegistryTest {
    @Test
    public void proofBeforeLoginIsRetainedAndLoginDoesNotResetVerification() {
        JoinSessionRegistry registry = new JoinSessionRegistry();
        UUID player = UUID.randomUUID();
        Object socket = new Object();
        UUID first = registry.begin(player, socket, 5);

        assertEquals(first, registry.markVerificationInFlight(player, socket));
        assertEquals(first, registry.begin(player, socket, 1000));
        assertNull(registry.markVerificationInFlight(player, socket));
        assertTrue(registry.accept(player, first));
        assertNull(registry.begin(player, socket, 5));
        assertTrue(registry.isAccepted(player, socket));
    }

    @Test
    public void staleLogoutAndCallbackCannotAffectRejoinedConnection() {
        JoinSessionRegistry registry = new JoinSessionRegistry();
        UUID player = UUID.randomUUID();
        Object oldSocket = new Object();
        Object newSocket = new Object();
        UUID oldConnection = registry.begin(player, oldSocket, 20);
        registry.markVerificationInFlight(player, oldSocket);
        UUID newConnection = registry.begin(player, newSocket, 20);

        registry.clear(player, oldSocket);
        assertFalse(registry.accept(player, oldConnection));
        assertFalse(registry.fail(player, oldConnection));
        assertTrue(registry.current(player, newConnection));
        assertTrue(registry.accept(player, newConnection));
        registry.clear(player, oldSocket);
        assertTrue(registry.isAccepted(player, newSocket));
        registry.clear(player, newSocket);
        assertFalse(registry.isAccepted(player, newSocket));
    }

    @Test
    public void deliveryAndLocalVerificationHaveSeparateReasons() {
        JoinSessionRegistry registry = new JoinSessionRegistry();
        UUID player = UUID.randomUUID();
        Object socket = new Object();

        registry.begin(player, socket, 2);
        assertTrue(registry.tickAndCollectExpired().isEmpty());
        assertEquals("PROOF_DELIVERY_TIMEOUT", registry.tickAndCollectExpired().get(player));

        registry.begin(player, socket, 2);
        registry.markVerificationInFlight(player, socket);
        assertTrue(registry.tickAndCollectExpired().isEmpty());
        assertEquals("LOCAL_VERIFICATION_TIMEOUT", registry.tickAndCollectExpired().get(player));
    }

    @Test
    public void unavailablePolicyRetriesWithoutExtendingOriginalDeadline() {
        JoinSessionRegistry registry = new JoinSessionRegistry();
        UUID player = UUID.randomUUID();
        Object socket = new Object();
        UUID connection = registry.begin(player, socket, 3);

        assertEquals(connection, registry.markVerificationInFlight(player, socket));
        assertTrue(registry.tickAndCollectExpired().isEmpty());
        assertTrue(registry.retryVerification(player, connection));
        assertEquals(Collections.singletonList(player), registry.requestsDue());
        assertEquals(connection, registry.markVerificationInFlight(player, socket));
        assertTrue(registry.tickAndCollectExpired().isEmpty());
        assertEquals("LOCAL_VERIFICATION_TIMEOUT", registry.tickAndCollectExpired().get(player));
    }

    @Test
    public void requestsStopDuringVerificationAndAfterAcceptance() {
        JoinSessionRegistry registry = new JoinSessionRegistry();
        UUID player = UUID.randomUUID();
        Object socket = new Object();
        UUID connection = registry.begin(player, socket, 50);

        assertEquals(Collections.singletonList(player), registry.requestsDue());
        assertTrue(registry.requestsDue().isEmpty());
        registry.markVerificationInFlight(player, socket);
        for (int index = 0; index < 100; index++) assertTrue(registry.requestsDue().isEmpty());
        assertTrue(registry.accept(player, connection));
        assertTrue(registry.requestsDue().isEmpty());
    }
}
