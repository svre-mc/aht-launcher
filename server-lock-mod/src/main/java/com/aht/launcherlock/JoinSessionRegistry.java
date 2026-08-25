package com.aht.launcherlock;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

final class JoinSessionRegistry {
    static final class PendingSession {
        final UUID connectionId;
        int remainingTicks;
        boolean verificationInFlight;

        PendingSession(UUID connectionId, int remainingTicks) {
            this.connectionId = connectionId;
            this.remainingTicks = remainingTicks;
        }
    }

    private final Map<UUID, PendingSession> pending = new HashMap<UUID, PendingSession>();
    private final Set<UUID> accepted = new HashSet<UUID>();

    synchronized UUID begin(UUID playerId, int timeoutTicks) {
        if (playerId == null) return null;
        accepted.remove(playerId);
        UUID connectionId = UUID.randomUUID();
        pending.put(playerId, new PendingSession(connectionId, Math.max(1, timeoutTicks)));
        return connectionId;
    }

    synchronized UUID markVerificationInFlight(UUID playerId) {
        PendingSession session = pending.get(playerId);
        if (session == null || session.verificationInFlight || accepted.contains(playerId)) return null;
        session.verificationInFlight = true;
        return session.connectionId;
    }

    synchronized boolean accept(UUID playerId, UUID connectionId) {
        PendingSession session = pending.get(playerId);
        if (session == null || !session.connectionId.equals(connectionId)) return false;
        pending.remove(playerId);
        accepted.add(playerId);
        return true;
    }

    synchronized boolean fail(UUID playerId, UUID connectionId) {
        PendingSession session = pending.get(playerId);
        if (session == null || !session.connectionId.equals(connectionId)) return false;
        pending.remove(playerId);
        accepted.remove(playerId);
        return true;
    }

    synchronized boolean isAccepted(UUID playerId) {
        return playerId != null && accepted.contains(playerId);
    }

    synchronized List<UUID> tickAndCollectExpired() {
        List<UUID> expired = new ArrayList<UUID>();
        java.util.Iterator<Map.Entry<UUID, PendingSession>> iterator = pending.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<UUID, PendingSession> entry = iterator.next();
            entry.getValue().remainingTicks--;
            if (entry.getValue().remainingTicks <= 0) {
                expired.add(entry.getKey());
                iterator.remove();
            }
        }
        return expired;
    }

    synchronized void clear(UUID playerId) {
        if (playerId == null) return;
        pending.remove(playerId);
        accepted.remove(playerId);
    }

    synchronized void clearAll() {
        pending.clear();
        accepted.clear();
    }
}
