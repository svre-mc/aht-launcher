package com.aht.launcherlock;

import com.google.gson.JsonObject;

import java.net.Inet6Address;
import java.net.InetAddress;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class LocalProofVerifier {
    private static final String PROTOCOL = "aht-launcher-attestation-v2";
    private static final String TOKEN_TYPE = "AHT-LAUNCHER-ATTESTATION";
    private static final String ISSUER = "aht-launcher-worker";
    private static final String AUDIENCE = "aht-minecraft-server";
    private static final long PROOF_TTL_MILLIS = 10L * 60L * 1000L;
    private static final long RECONNECT_TTL_MILLIS = 24L * 60L * 60L * 1000L;
    private static final AtomicInteger THREAD_IDS = new AtomicInteger();
    private static final ThreadPoolExecutor EXECUTOR = new ThreadPoolExecutor(
            1, 2, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<Runnable>(128),
            new ThreadFactory() {
                @Override
                public Thread newThread(Runnable runnable) {
                    Thread thread = new Thread(runnable,
                            "AHT-Local-Proof-Verification-" + THREAD_IDS.incrementAndGet());
                    thread.setDaemon(true);
                    thread.setPriority(Thread.NORM_PRIORITY - 1);
                    return thread;
                }
            },
            new ThreadPoolExecutor.AbortPolicy()
    );

    interface SnapshotProvider {
        ServerPolicySnapshot current();

        String currentRevision();
    }

    static final class Result {
        final boolean accepted;
        final String code;
        final String currentLauncherVersion;
        final String necessaryLauncherVersion;
        final String policyRevision;

        private Result(boolean accepted, String code, String currentLauncherVersion,
                       String necessaryLauncherVersion, String policyRevision) {
            this.accepted = accepted;
            this.code = safeCode(code);
            this.currentLauncherVersion = safeVersion(currentLauncherVersion);
            this.necessaryLauncherVersion = safeVersion(necessaryLauncherVersion);
            this.policyRevision = policyRevision != null && policyRevision.matches("[a-f0-9]{64}")
                    ? policyRevision : "";
        }

        static Result accepted(String current, String necessary, String revision) {
            return new Result(true, "ACCEPTED", current, necessary, revision);
        }

        static Result updateRequired(String current, String necessary, String revision) {
            return new Result(false, "LAUNCHER_UPDATE_REQUIRED", current, necessary, revision);
        }

        static Result denied(String code, String revision) {
            return new Result(false, code, "", "", revision);
        }

        static Result unavailable() {
            return new Result(false, "VERIFICATION_UNAVAILABLE", "", "", "");
        }
    }

    private LocalProofVerifier() {
    }

    static void cancelQueuedWork() {
        EXECUTOR.getQueue().clear();
        EXECUTOR.purge();
    }

    static CompletableFuture<Result> verifyAsync(final String token, final String expectedUsername,
                                                 final UUID expectedUuid, final String expectedPackId,
                                                 final String remoteIp,
                                                 final SnapshotProvider snapshots) {
        if (!LauncherProofMessage.isTokenShapeValid(token) || snapshots == null) {
            return CompletableFuture.completedFuture(Result.denied("INVALID_LAUNCHER_PROOF", ""));
        }
        try {
            return CompletableFuture.supplyAsync(() -> {
                for (int attempt = 0; attempt < 3; attempt++) {
                    ServerPolicySnapshot snapshot = snapshots.current();
                    if (snapshot == null) return Result.unavailable();
                    Result result = verifyNow(token, expectedUsername, expectedUuid, expectedPackId,
                            remoteIp, snapshot, System.currentTimeMillis());
                    if (snapshot.revision.equals(snapshots.currentRevision())) return result;
                }
                return Result.unavailable();
            }, EXECUTOR);
        } catch (RejectedExecutionException ignored) {
            return CompletableFuture.completedFuture(Result.unavailable());
        }
    }

    static Result verifyForTests(String token, String expectedUsername, UUID expectedUuid,
                                 String expectedPackId, String remoteIp,
                                 ServerPolicySnapshot snapshot, long nowMillis) {
        return verifyNow(token, expectedUsername, expectedUuid, expectedPackId, remoteIp, snapshot, nowMillis);
    }

    private static Result verifyNow(String token, String expectedUsername, UUID expectedUuid,
                                    String expectedPackId, String remoteIp,
                                    ServerPolicySnapshot state, long nowMillis) {
        if (state == null || expectedUsername == null || expectedUuid == null || expectedPackId == null
                || !expectedPackId.equals(state.packId)) return Result.unavailable();
        final JsonObject payload;
        try {
            payload = SignedTokenSupport.verifyRs256(
                    token, state.publicKey, TOKEN_TYPE, LauncherProofMessage.MAX_TOKEN_CHARS, 4608
            ).payload;
        } catch (Exception ignored) {
            return Result.denied("INVALID_LAUNCHER_PROOF", state.revision);
        }

        try {
            String username = SignedTokenSupport.safe(
                    SignedTokenSupport.readString(payload, "minecraftUsername"), 16
            );
            String minecraftUuid = SignedTokenSupport.normalizeUuid(
                    SignedTokenSupport.readString(payload, "minecraftUuid")
            );
            String installId = SignedTokenSupport.safe(SignedTokenSupport.readString(payload, "installId"), 120);
            String deviceId = SignedTokenSupport.safe(SignedTokenSupport.readString(payload, "deviceId"), 80)
                    .toLowerCase(Locale.ROOT);
            String launcherVersion = safeVersion(SignedTokenSupport.readString(payload, "launcherVersion"));
            String appVersion = safeVersion(SignedTokenSupport.readString(payload, "appVersion"));
            String launcherVersionAuthority = SignedTokenSupport.safe(
                    SignedTokenSupport.readString(payload, "launcherVersionAuthority"), 80
            );
            String launcherChannel = SignedTokenSupport.safe(
                    SignedTokenSupport.readString(payload, "launcherChannel"), 32
            ).toLowerCase(Locale.ROOT);
            String networkStatus = SignedTokenSupport.safe(
                    SignedTokenSupport.readString(payload, "networkStatus"), 20
            );
            String launchId = SignedTokenSupport.safe(SignedTokenSupport.readString(payload, "launchId"), 80);
            boolean developerClient = SignedTokenSupport.readBoolean(payload, "developerClient", true);
            boolean developerClientBypass = SignedTokenSupport.readBoolean(payload, "developerClientBypass", true);
            boolean modIntegrityBypass = SignedTokenSupport.readBoolean(payload, "modIntegrityBypass", true);
            boolean accessGranted = SignedTokenSupport.readBoolean(payload, "accessGranted", true);
            boolean developerProof = "developer".equals(launcherChannel) && developerClient
                    && developerClientBypass && modIntegrityBypass;
            boolean hasAnyDeveloperClaim = "developer".equals(launcherChannel) || developerClient
                    || developerClientBypass || modIntegrityBypass;
            long issuedAt = SignedTokenSupport.parseInstant(SignedTokenSupport.readString(payload, "issuedAt"));
            long expiresAt = SignedTokenSupport.parseInstant(SignedTokenSupport.readString(payload, "expiresAt"));
            long reconnectExpiresAt = SignedTokenSupport.parseInstant(
                    SignedTokenSupport.readString(payload, "reconnectExpiresAt")
            );
            if (!PROTOCOL.equals(SignedTokenSupport.readString(payload, "protocol"))
                    || SignedTokenSupport.readInt(payload, "schemaVersion") != 2
                    || !ISSUER.equals(SignedTokenSupport.readString(payload, "issuer"))
                    || !AUDIENCE.equals(SignedTokenSupport.readString(payload, "audience"))
                    || !launchId.equals(SignedTokenSupport.readString(payload, "jti"))
                    || !launchId.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")
                    || !username.matches("[A-Za-z0-9_]{3,16}")
                    || !expectedUsername.equalsIgnoreCase(username)
                    || !expectedUuid.toString().equals(minecraftUuid)
                    || !expectedPackId.equals(SignedTokenSupport.safe(
                            SignedTokenSupport.readString(payload, "packId"), 80))
                    || installId.isEmpty() || !SignedTokenSupport.validVersion(launcherVersion)
                    || !launcherVersion.equals(appVersion)
                    || !"worker-policy-matched-device-assertion".equals(launcherVersionAuthority)
                    || !("player".equals(launcherChannel) || "developer".equals(launcherChannel))
                    || !("likely".equals(networkStatus) || "not_detected".equals(networkStatus)
                            || "unknown".equals(networkStatus))
                    || !accessGranted || (hasAnyDeveloperClaim && !developerProof)
                    || issuedAt <= 0L || expiresAt <= issuedAt
                    || expiresAt - issuedAt > PROOF_TTL_MILLIS
                    || reconnectExpiresAt <= expiresAt || reconnectExpiresAt <= nowMillis
                    || reconnectExpiresAt - issuedAt > RECONNECT_TTL_MILLIS
                    || issuedAt > nowMillis + 120000L) {
                return Result.denied("PROOF_IDENTITY_MISMATCH", state.revision);
            }

            if (!developerProof) {
                if (!deviceId.matches("ahtd_[a-f0-9]{64}")) {
                    return Result.denied("PROOF_IDENTITY_MISMATCH", state.revision);
                }
                String normalizedUsername = username.toLowerCase(Locale.ROOT);
                String accountDigest = SignedTokenSupport.sha256Hex("account\0" + normalizedUsername);
                String bindingDigest = SignedTokenSupport.sha256Hex(
                        "binding-v1\0" + normalizedUsername + "\0" + minecraftUuid + "\0"
                                + installId + "\0" + deviceId
                );
                if (!SignedTokenSupport.constantEquals(state.accountBinding(accountDigest), bindingDigest)) {
                    return Result.denied("PROOF_IDENTITY_MISMATCH", state.revision);
                }
                String normalizedIp = normalizeConnectionIp(remoteIp);
                if (normalizedIp.isEmpty()) {
                    return Result.denied("PROOF_IDENTITY_MISMATCH", state.revision);
                }
                if (denied(state, "account", normalizedUsername)
                        || denied(state, "minecraft_uuid", minecraftUuid)
                        || denied(state, "device", deviceId)
                        || denied(state, "ip", normalizedIp)
                        || (normalizedIp.indexOf(':') < 0 && denied(state, "ipv4", normalizedIp))
                        || (state.blockLikelyVpn && "likely".equals(networkStatus))) {
                    return Result.denied("ACCESS_RESTRICTED", state.revision);
                }
            }

            return launcherVersion.equals(state.necessaryLauncherVersion)
                    ? Result.accepted(launcherVersion, state.necessaryLauncherVersion, state.revision)
                    : Result.updateRequired(launcherVersion, state.necessaryLauncherVersion, state.revision);
        } catch (RuntimeException ignored) {
            return Result.denied("INVALID_LAUNCHER_PROOF", state.revision);
        }
    }

    static String normalizeConnectionIp(String value) {
        String text = SignedTokenSupport.safe(value, 80).toLowerCase(Locale.ROOT);
        if (text.startsWith("::ffff:")) text = text.substring(7);
        if (text.matches("\\d{1,3}(?:\\.\\d{1,3}){3}")) {
            String[] parts = text.split("\\.");
            StringBuilder normalized = new StringBuilder();
            for (String part : parts) {
                int number;
                try {
                    number = Integer.parseInt(part);
                } catch (NumberFormatException ignored) {
                    return "";
                }
                if (number < 0 || number > 255) return "";
                if (normalized.length() > 0) normalized.append('.');
                normalized.append(number);
            }
            return normalized.toString();
        }
        int zone = text.indexOf('%');
        if (zone >= 0) text = text.substring(0, zone);
        if (!text.contains(":") || !text.matches("[0-9a-f:.]+")) return "";
        try {
            InetAddress address = InetAddress.getByName(text);
            return address instanceof Inet6Address
                    ? address.getHostAddress().replaceAll("%.*$", "").toLowerCase(Locale.ROOT) : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private static boolean denied(ServerPolicySnapshot state, String scope, String value) {
        return state.isDenied(scope, SignedTokenSupport.sha256Hex(scope + "\0" + value));
    }

    private static String safeVersion(String value) {
        String text = SignedTokenSupport.safe(value, 40);
        return text.matches("[0-9A-Za-z.-]+") ? text : "";
    }

    private static String safeCode(String value) {
        if (value == null) return "VERIFICATION_UNAVAILABLE";
        String text = value.trim().toUpperCase(Locale.ROOT);
        return text.length() <= 80 && text.matches("[A-Z0-9_]+") ? text : "VERIFICATION_UNAVAILABLE";
    }
}
