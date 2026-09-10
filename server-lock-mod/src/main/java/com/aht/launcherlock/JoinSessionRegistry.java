package com.aht.launcherlock;

import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Authentication and expiry belong to one network connection, never only a player UUID. */
final class JoinSessionRegistry {
    static final class PendingSession {
        final UUID connectionId = UUID.randomUUID();
        final Object transport;
        int remainingTicks;
        int requestTicks;
        boolean verificationInFlight;

        PendingSession(Object transport, int ticks) {
            this.transport = transport;
            this.remainingTicks = Math.max(1, ticks);
        }
    }

    private final Map<UUID, PendingSession> pending = new HashMap<UUID, PendingSession>();
    private final Map<UUID, Object> accepted = new HashMap<UUID, Object>();

    synchronized UUID begin(UUID playerId, Object transport, int timeoutTicks) {
        if (playerId == null || transport == null) return null;
        if (accepted.get(playerId) == transport) return null;
        PendingSession existing = pending.get(playerId);
        if (existing != null && existing.transport == transport) return existing.connectionId;
        accepted.remove(playerId);
        PendingSession session = new PendingSession(transport, timeoutTicks);
        pending.put(playerId, session);
        return session.connectionId;
    }

    synchronized UUID markVerificationInFlight(UUID playerId, Object transport) {
        PendingSession session = pending.get(playerId);
        if (session == null || session.transport != transport || session.verificationInFlight) return null;
        session.verificationInFlight = true;
        return session.connectionId;
    }

    synchronized boolean retryVerification(UUID playerId, UUID connectionId) {
        PendingSession session = pending.get(playerId);
        if (session == null || !session.connectionId.equals(connectionId)) return false;
        session.verificationInFlight = false;
        session.requestTicks = 0;
        return true;
    }

    synchronized boolean current(UUID playerId, UUID connectionId) {
        PendingSession session = pending.get(playerId);
        return session != null && session.connectionId.equals(connectionId);
    }

    synchronized boolean accept(UUID playerId, UUID connectionId) {
        PendingSession session = pending.get(playerId);
        if (session == null || !session.connectionId.equals(connectionId)) return false;
        pending.remove(playerId);
        accepted.put(playerId, session.transport);
        return true;
    }

    synchronized boolean fail(UUID playerId, UUID connectionId) {
        PendingSession session = pending.get(playerId);
        if (session == null || !session.connectionId.equals(connectionId)) return false;
        pending.remove(playerId);
        accepted.remove(playerId);
        return true;
    }

    synchronized boolean isAccepted(UUID playerId, Object transport) {
        return transport != null && accepted.get(playerId) == transport;
    }

    synchronized boolean acceptExempt(LauncherWhitelist policy,String name,UUID playerId,Object transport,int timeoutTicks) {
        if(policy==null || !policy.allows(name) || playerId==null || transport==null)return false;
        UUID connection=begin(playerId,transport,timeoutTicks);
        return connection==null?isAccepted(playerId,transport):accept(playerId,connection);
    }

    synchronized List<UUID> requestsDue() {
        List<UUID> result = new ArrayList<UUID>();
        for (Map.Entry<UUID, PendingSession> entry : pending.entrySet()) {
            PendingSession session = entry.getValue();
            if (!session.verificationInFlight && session.requestTicks-- <= 0) {
                session.requestTicks = 19;
                result.add(entry.getKey());
            }
        }
        return result;
    }

    synchronized Map<UUID, String> tickAndCollectExpired() {
        Map<UUID, String> expired = new LinkedHashMap<UUID, String>();
        Iterator<Map.Entry<UUID, PendingSession>> iterator = pending.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<UUID, PendingSession> entry = iterator.next();
            entry.getValue().remainingTicks--;
            if (entry.getValue().remainingTicks <= 0) {
                expired.put(entry.getKey(), entry.getValue().verificationInFlight
                        ? "LOCAL_VERIFICATION_TIMEOUT" : "PROOF_DELIVERY_TIMEOUT");
                iterator.remove();
            }
        }
        return expired;
    }

    synchronized void clear(UUID playerId, Object transport) {
        PendingSession session = pending.get(playerId);
        if (session != null && session.transport == transport) pending.remove(playerId);
        if (accepted.get(playerId) == transport) accepted.remove(playerId);
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
