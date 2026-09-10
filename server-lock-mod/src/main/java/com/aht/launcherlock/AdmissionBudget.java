package com.aht.launcherlock;

/** Small, connection-local budget before any mod payload is scheduled/decoded. */
final class AdmissionBudget {
    private long windowStart;
    private int packets;
    private long bytes;
    boolean allow(int size, long now) {
        if (size < 0 || size > 32767) return false;
        if (now - windowStart >= 1_000_000_000L) { windowStart = now; packets = 0; bytes = 0; }
        return ++packets <= 128 && (bytes += size) <= 1024 * 1024;
    }
}
