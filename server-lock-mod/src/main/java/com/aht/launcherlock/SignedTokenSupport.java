package com.aht.launcherlock;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Base64;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class SignedTokenSupport {
    static final String KEY_ID = "aht-launcher-attestation-v2";
    private static final Pattern VERSION = Pattern.compile(
            "^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?$"
    );

    static final class VerifiedToken {
        final JsonObject header;
        final JsonObject payload;

        VerifiedToken(JsonObject header, JsonObject payload) {
            this.header = header;
            this.payload = payload;
        }
    }

    private SignedTokenSupport() {
    }

    static VerifiedToken verifyRs256(String token, RSAPublicKey key, String expectedType,
                                     int maxTokenChars, int maxPayloadBytes) throws Exception {
        if (token == null || key == null || token.length() < 16 || token.length() > maxTokenChars) {
            throw new IllegalArgumentException("signed token is missing or oversized");
        }
        String[] parts = token.split("\\.", -1);
        if (parts.length != 3 || !base64UrlPart(parts[0], 1024)
                || !base64UrlPart(parts[1], maxTokenChars) || !base64UrlPart(parts[2], 1024)) {
            throw new IllegalArgumentException("signed token shape is invalid");
        }
        byte[] headerBytes = decodeBase64Url(parts[0]);
        byte[] payloadBytes = decodeBase64Url(parts[1]);
        byte[] signatureBytes = decodeBase64Url(parts[2]);
        if (headerBytes.length > 512 || payloadBytes.length > maxPayloadBytes || signatureBytes.length > 1024) {
            throw new IllegalArgumentException("signed token component is oversized");
        }
        JsonObject header = parseObject(headerBytes);
        JsonObject payload = parseObject(payloadBytes);
        if (!"RS256".equals(readString(header, "alg"))
                || !expectedType.equals(readString(header, "typ"))
                || !KEY_ID.equals(readString(header, "kid"))) {
            throw new IllegalArgumentException("signed token header is invalid");
        }
        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(key);
        verifier.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
        if (!verifier.verify(signatureBytes)) {
            throw new IllegalArgumentException("signed token signature is invalid");
        }
        return new VerifiedToken(header, payload);
    }

    static JsonObject parseObject(String text, int maxChars) {
        if (text == null || text.isEmpty() || text.length() > maxChars) {
            throw new IllegalArgumentException("JSON object is missing or oversized");
        }
        try {
            JsonElement parsed = new JsonParser().parse(text);
            if (parsed == null || !parsed.isJsonObject()) throw new IllegalArgumentException("JSON object is invalid");
            return parsed.getAsJsonObject();
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("JSON object is invalid", error);
        }
    }

    private static JsonObject parseObject(byte[] bytes) throws CharacterCodingException {
        CharBuffer decoded = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes));
        return parseObject(decoded.toString(), Math.max(1, decoded.length()));
    }

    static String readString(JsonObject object, String key) {
        try {
            return object != null && object.has(key) && object.get(key).isJsonPrimitive()
                    && object.get(key).getAsJsonPrimitive().isString()
                    ? object.get(key).getAsString() : "";
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    static boolean readBoolean(JsonObject object, String key, boolean required) {
        try {
            if (object != null && object.has(key) && object.get(key).isJsonPrimitive()
                    && object.get(key).getAsJsonPrimitive().isBoolean()) {
                return object.get(key).getAsBoolean();
            }
        } catch (RuntimeException ignored) {
        }
        if (required) throw new IllegalArgumentException("required boolean is missing");
        return false;
    }

    static int readInt(JsonObject object, String key) {
        try {
            if (object != null && object.has(key) && object.get(key).isJsonPrimitive()
                    && object.get(key).getAsJsonPrimitive().isNumber()) {
                return object.get(key).getAsInt();
            }
        } catch (RuntimeException ignored) {
        }
        throw new IllegalArgumentException("required integer is missing");
    }

    static JsonArray readArray(JsonObject object, String key) {
        try {
            if (object != null && object.has(key) && object.get(key).isJsonArray()) {
                return object.getAsJsonArray(key);
            }
        } catch (RuntimeException ignored) {
        }
        throw new IllegalArgumentException("required array is missing");
    }

    static String normalizeUuid(String value) {
        String compact = safe(value, 80).replace("-", "").replace("{", "").replace("}", "")
                .toLowerCase(Locale.ROOT);
        if (!compact.matches("[a-f0-9]{32}") || compact.matches("0{32}")) return "";
        return compact.substring(0, 8) + "-" + compact.substring(8, 12) + "-"
                + compact.substring(12, 16) + "-" + compact.substring(16, 20) + "-"
                + compact.substring(20);
    }

    static String safe(String value, int maxLength) {
        if (value == null) return "";
        String text = value.trim();
        return text.length() <= maxLength ? text : "";
    }

    static long parseInstant(String value) {
        try {
            return Instant.parse(safe(value, 80)).toEpochMilli();
        } catch (DateTimeParseException ignored) {
            return 0L;
        }
    }

    static String sha256Hex(String value) {
        return sha256Hex(value.getBytes(StandardCharsets.UTF_8));
    }

    static String sha256Hex(byte[] value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
            StringBuilder text = new StringBuilder(digest.length * 2);
            for (byte item : digest) text.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            return text.toString();
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    static boolean constantEquals(String left, String right) {
        return MessageDigest.isEqual(
                String.valueOf(left).getBytes(StandardCharsets.US_ASCII),
                String.valueOf(right).getBytes(StandardCharsets.US_ASCII)
        );
    }

    static boolean validVersion(String value) {
        return parseVersion(value) != null;
    }

    static Integer compareVersions(String left, String right) {
        ParsedVersion a = parseVersion(left);
        ParsedVersion b = parseVersion(right);
        if (a == null || b == null) return null;
        for (int index = 0; index < 3; index++) {
            if (a.numbers[index] != b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
        }
        if (a.prerelease.equals(b.prerelease)) return 0;
        if (a.prerelease.isEmpty()) return 1;
        if (b.prerelease.isEmpty()) return -1;
        return comparePrerelease(a.prerelease, b.prerelease);
    }

    private static int comparePrerelease(String left, String right) {
        String[] a = left.split("\\.", -1);
        String[] b = right.split("\\.", -1);
        int length = Math.min(a.length, b.length);
        for (int index = 0; index < length; index++) {
            boolean aNumeric = a[index].matches("\\d+");
            boolean bNumeric = b[index].matches("\\d+");
            int comparison;
            if (aNumeric && bNumeric) {
                comparison = compareNumericIdentifier(a[index], b[index]);
            } else if (aNumeric != bNumeric) {
                comparison = aNumeric ? -1 : 1;
            } else {
                comparison = a[index].compareToIgnoreCase(b[index]);
            }
            if (comparison != 0) return comparison > 0 ? 1 : -1;
        }
        return Integer.compare(a.length, b.length);
    }

    private static int compareNumericIdentifier(String left, String right) {
        String a = left.replaceFirst("^0+(?!$)", "");
        String b = right.replaceFirst("^0+(?!$)", "");
        if (a.length() != b.length()) return a.length() > b.length() ? 1 : -1;
        return a.compareTo(b);
    }

    private static ParsedVersion parseVersion(String value) {
        String text = safe(value, 40);
        Matcher match = VERSION.matcher(text);
        if (!match.matches()) return null;
        int[] numbers = new int[3];
        try {
            for (int index = 0; index < 3; index++) {
                numbers[index] = Integer.parseInt(match.group(index + 1));
                if (numbers[index] < 0 || numbers[index] > 1000000) return null;
            }
        } catch (NumberFormatException ignored) {
            return null;
        }
        return new ParsedVersion(numbers, match.group(4) == null ? "" : match.group(4));
    }

    private static boolean base64UrlPart(String value, int maxLength) {
        return value != null && !value.isEmpty() && value.length() <= maxLength
                && value.matches("[A-Za-z0-9_-]+");
    }

    static byte[] decodeBase64Url(String value) {
        return Base64.getUrlDecoder().decode(value);
    }

    private static final class ParsedVersion {
        final int[] numbers;
        final String prerelease;

        ParsedVersion(int[] numbers, String prerelease) {
            this.numbers = numbers;
            this.prerelease = prerelease;
        }
    }
}
