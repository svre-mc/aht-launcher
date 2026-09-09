package com.aht.launcherlock;

/** Keeps proof delivery bounded to the current server connection. */
final class ClientProofRetry {
    private Object connection;
    private long deadline;
    private long nextAttempt;
    private boolean started;

    synchronized void connected(Object connection, long now) {
        this.connection = connection;
        this.started = false;
        this.nextAttempt = now;
    }

    synchronized boolean attempt(Object connection, long now) {
        if (this.connection != connection || connection == null || now < nextAttempt) return false;
        // Start the bounded window only when Minecraft is ready to send on this connection.
        if (!started) {
            deadline = now + 30_000_000_000L;
            started = true;
        }
        if (now >= deadline) return false;
        nextAttempt = now + 1_000_000_000L;
        return true;
    }

    synchronized void finished(Object connection) {
        if (this.connection == connection) this.connection = null;
    }
}
