package com.aht.launcherlock;

import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.util.HashSet;
import java.util.Set;

/** Exact temporary player objects, not usernames/UUIDs; rejected reconnects cannot own a save. */
final class AdmissionSaveState {
    private final ReferenceQueue<Object> collected = new ReferenceQueue<Object>();
    private final Set<Identity> unloaded = new HashSet<Identity>();

    synchronized void track(Object player) {
        clean();
        unloaded.add(new Identity(player, collected));
    }
    synchronized boolean blocked(Object player, boolean exactListedPlayer) {
        clean();
        Identity key = new Identity(player, null);
        if (exactListedPlayer) { unloaded.remove(key); return false; }
        return unloaded.contains(key);
    }
    private void clean() {
        Identity key;
        while ((key = (Identity) collected.poll()) != null) unloaded.remove(key);
    }
    private static final class Identity extends WeakReference<Object> {
        final int hash;
        Identity(Object player, ReferenceQueue<Object> queue) {
            super(player, queue); hash = System.identityHashCode(player);
        }
        public int hashCode() { return hash; }
        public boolean equals(Object other) {
            return this == other || other instanceof Identity && get() != null && get() == ((Identity)other).get();
        }
    }
}
