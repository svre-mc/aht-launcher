package com.aht.launcherlock;

/** Two live, independently verified transports; a cached policy alone never authorizes a join. */
final class ServerStateConnections {
    static final int COUNT = 2;
    private final ServerPolicySnapshot[] snapshots = new ServerPolicySnapshot[COUNT];
    private final long[] activity = new long[COUNT];
    private final long freshNanos;
    private ServerPolicySnapshot latest;
    private boolean conflictingTimestamp;

    ServerStateConnections(long freshNanos) { this.freshNanos = freshNanos; }

    synchronized void signedPolicy(int slot, ServerPolicySnapshot snapshot, long now) {
        if (latest == null || snapshot.issuedAtMillis > latest.issuedAtMillis) {
            latest = snapshot;
            conflictingTimestamp = false;
        } else if (snapshot.issuedAtMillis == latest.issuedAtMillis
                && !snapshot.revision.equals(latest.revision)) {
            // Equal timestamps cannot establish which different signed policy is newer.
            conflictingTimestamp = true;
        }
        snapshots[slot] = snapshot;
        activity[slot] = now;
    }

    synchronized void responsive(int slot, long now) {
        if (snapshots[slot] != null) activity[slot] = now;
    }

    synchronized void disconnected(int slot) { snapshots[slot] = null; }

    synchronized boolean established(int slot) { return snapshots[slot] != null; }

    synchronized int healthyCount(long now) {
        if (latest == null || conflictingTimestamp) return 0;
        int count = 0;
        for (int i = 0; i < COUNT; i++) {
            if (snapshots[i] != null && snapshots[i].revision.equals(latest.revision)
                    && now - activity[i] <= freshNanos) count++;
        }
        return count;
    }

    synchronized ServerPolicySnapshot current(long now) {
        return healthyCount(now) == 0 ? null : latest;
    }
}
