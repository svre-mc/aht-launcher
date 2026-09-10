package com.aht.launcherlock;

/** Routine joins are debug-only. A broken verification bridge emits one safe warning per connection. */
final class AdmissionLog {
    private boolean failureReported;

    void pending(String name) {
        PackVersionLock.LOG.debug("AHT admission pending for {}; world entry is withheld.", name);
    }

    void accepted(String name) {
        PackVersionLock.LOG.debug("AHT admission accepted for {}; verified before world entry.", name);
    }

    void failure(String name, String stage, String reason, Throwable failure) {
        if (failureReported) return;
        failureReported = true;
        // Never copy exception messages, proof content or local paths into console output.
        Throwable cause = failure;
        for (int i = 0; cause != null && cause.getCause() != null && i < 8; i++) cause = cause.getCause();
        PackVersionLock.LOG.warn("AHT client verification failed for {} at {}: {}{}.", name, stage, reason,
                cause == null ? "" : " (" + cause.getClass().getSimpleName() + ")");
    }
}
