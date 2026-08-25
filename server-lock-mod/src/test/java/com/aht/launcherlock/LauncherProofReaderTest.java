package com.aht.launcherlock;

import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class LauncherProofReaderTest {
    private static final String PROOF_FILE_PROPERTY = "aht.launcher.proofFile";
    private static final String PROOF_PROTOCOL_PROPERTY = "aht.launcher.protocol";
    private static final String PROTOCOL = "aht-launcher-attestation-v2";

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @After
    public void clearProperties() {
        System.clearProperty(PROOF_FILE_PROPERTY);
        System.clearProperty(PROOF_PROTOCOL_PROPERTY);
    }

    @Test
    public void readsOnlyTrustedWorkerProofWithExpectedProtocol() throws Exception {
        File file = temporaryFolder.newFile("proof.json");
        Files.write(file.toPath(), ("{\"protocol\":\"" + PROTOCOL + "\","
                + "\"source\":\"worker\",\"trusted\":true,"
                + "\"token\":\"a.payload.signature\"}").getBytes(StandardCharsets.UTF_8));
        System.setProperty(PROOF_FILE_PROPERTY, file.getAbsolutePath());
        System.setProperty(PROOF_PROTOCOL_PROPERTY, PROTOCOL);

        LauncherProofMessage message = LauncherProofReader.readLauncherProof();
        assertTrue(message.available);
        assertEquals("a.payload.signature", message.token);
    }

    @Test
    public void readsMaximumLengthToken() throws Exception {
        String token = "a." + repeat('b', LauncherProofMessage.MAX_TOKEN_CHARS - 4) + ".c";
        assertEquals(LauncherProofMessage.MAX_TOKEN_CHARS, token.length());
        File file = temporaryFolder.newFile("maximum-proof.json");
        Files.write(file.toPath(), ("{\"protocol\":\"" + PROTOCOL + "\","
                + "\"source\":\"worker\",\"trusted\":true,"
                + "\"token\":\"" + token + "\"}").getBytes(StandardCharsets.UTF_8));
        System.setProperty(PROOF_FILE_PROPERTY, file.getAbsolutePath());
        System.setProperty(PROOF_PROTOCOL_PROPERTY, PROTOCOL);

        LauncherProofMessage message = LauncherProofReader.readLauncherProof();
        assertTrue(message.available);
        assertEquals(token, message.token);
    }

    @Test
    public void missingMalformedAndUntrustedProofsFailClosed() throws Exception {
        System.setProperty(PROOF_PROTOCOL_PROPERTY, PROTOCOL);
        assertFalse(LauncherProofReader.readLauncherProof().available);

        File malformed = temporaryFolder.newFile("malformed.json");
        Files.write(malformed.toPath(), "{".getBytes(StandardCharsets.UTF_8));
        System.setProperty(PROOF_FILE_PROPERTY, malformed.getAbsolutePath());
        assertFalse(LauncherProofReader.readLauncherProof().available);

        File untrusted = temporaryFolder.newFile("untrusted.json");
        Files.write(untrusted.toPath(), ("{\"protocol\":\"" + PROTOCOL + "\","
                + "\"source\":\"worker\",\"trusted\":false,"
                + "\"token\":\"a.payload.signature\"}").getBytes(StandardCharsets.UTF_8));
        System.setProperty(PROOF_FILE_PROPERTY, untrusted.getAbsolutePath());
        assertFalse(LauncherProofReader.readLauncherProof().available);
    }

    @Test
    public void oversizedProofFileFailsClosed() throws Exception {
        File oversized = temporaryFolder.newFile("oversized.json");
        try (FileOutputStream output = new FileOutputStream(oversized)) {
            output.write(new byte[32769]);
        }
        System.setProperty(PROOF_FILE_PROPERTY, oversized.getAbsolutePath());
        System.setProperty(PROOF_PROTOCOL_PROPERTY, PROTOCOL);

        assertFalse(LauncherProofReader.readLauncherProof().available);
    }

    @Test
    public void emptyAndTruncatedProofFilesFailClosed() throws Exception {
        File empty = temporaryFolder.newFile("empty.json");
        System.setProperty(PROOF_FILE_PROPERTY, empty.getAbsolutePath());
        System.setProperty(PROOF_PROTOCOL_PROPERTY, PROTOCOL);
        assertFalse(LauncherProofReader.readLauncherProof().available);

        File truncated = temporaryFolder.newFile("truncated.json");
        Files.write(truncated.toPath(), ("{\"protocol\":\"" + PROTOCOL + "\","
                + "\"source\":\"worker\",\"trusted\":true,"
                + "\"token\":\"a.payload.signature\"").getBytes(StandardCharsets.UTF_8));
        System.setProperty(PROOF_FILE_PROPERTY, truncated.getAbsolutePath());
        assertFalse(LauncherProofReader.readLauncherProof().available);
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index++) result.append(value);
        return result.toString();
    }
}
