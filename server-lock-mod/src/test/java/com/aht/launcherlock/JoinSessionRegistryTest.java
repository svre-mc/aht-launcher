package com.aht.launcherlock;

import org.junit.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class JoinSessionRegistryTest {
    @Test
    public void acceptedConnectionIsNotRecheckedUntilLogout() {
        JoinSessionRegistry registry = new JoinSessionRegistry();
        UUID playerId = UUID.randomUUID();
        UUID connectionId = registry.begin(playerId, 3);

        assertEquals(connectionId, registry.markVerificationInFlight(playerId));
        assertTrue(registry.accept(playerId, connectionId));
        for (int index = 0; index < 10000; index++) {
            assertTrue(registry.tickAndCollectExpired().isEmpty());
        }
        assertTrue(registry.isAccepted(playerId));
        assertNull(registry.markVerificationInFlight(playerId));

        registry.clear(playerId);
        assertFalse(registry.isAccepted(playerId));
        UUID reconnectId = registry.begin(playerId, 3);
        assertNotEquals(connectionId, reconnectId);
        assertEquals(reconnectId, registry.markVerificationInFlight(playerId));
    }

    @Test
    public void staleVerificationCannotAffectNewConnection() {
        JoinSessionRegistry registry = new JoinSessionRegistry();
        UUID playerId = UUID.randomUUID();
        UUID firstConnection = registry.begin(playerId, 20);
        assertEquals(firstConnection, registry.markVerificationInFlight(playerId));

        UUID secondConnection = registry.begin(playerId, 20);
        assertFalse(registry.accept(playerId, firstConnection));
        assertEquals(secondConnection, registry.markVerificationInFlight(playerId));
        assertTrue(registry.accept(playerId, secondConnection));
    }

    @Test
    public void pendingConnectionExpiresFailClosed() {
        JoinSessionRegistry registry = new JoinSessionRegistry();
        UUID playerId = UUID.randomUUID();
        registry.begin(playerId, 2);

        assertTrue(registry.tickAndCollectExpired().isEmpty());
        List<UUID> expired = registry.tickAndCollectExpired();
        assertEquals(1, expired.size());
        assertEquals(playerId, expired.get(0));
        assertFalse(registry.isAccepted(playerId));
    }
}
