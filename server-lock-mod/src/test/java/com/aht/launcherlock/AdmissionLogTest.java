package com.aht.launcherlock;

import java.util.ArrayList;
import java.util.List;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.Logger;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.junit.Test;
import static org.junit.Assert.*;

public class AdmissionLogTest {
    @Test public void routineRetriesStayQuietAndFailureIsSingleAndSanitized() {
        org.apache.logging.log4j.Logger original = PackVersionLock.LOG;
        Logger logger = (Logger) org.apache.logging.log4j.LogManager.getLogger("admission-regression-test");
        PackVersionLock.LOG = logger;
        Level before = logger.getLevel();
        final List<String> messages = new ArrayList<String>();
        AbstractAppender capture = new AbstractAppender("admission-test", null, null) {
            @Override public void append(LogEvent event) { messages.add(event.getMessage().getFormattedMessage()); }
        };
        capture.start(); logger.addAppender(capture); logger.setLevel(Level.INFO);
        try {
            for (int i = 0; i < 100; i++) {
                AdmissionLog session = new AdmissionLog();
                session.pending("TestPlayer"); session.accepted("TestPlayer");
            }
            assertTrue(messages.isEmpty());
            AdmissionLog broken = new AdmissionLog();
            for (int i = 0; i < 100; i++) broken.failure("TestPlayer", "runtime protection", "verification unavailable",
                    new IllegalStateException("private proof must not appear", new NoSuchMethodException("private path")));
            assertEquals(1, messages.size());
            assertTrue(messages.get(0).contains("runtime protection"));
            assertTrue(messages.get(0).contains("NoSuchMethodException"));
            assertFalse(messages.get(0).contains("private"));
            new AdmissionLog().failure("NextPlayer", "launcher proof", "timed out", null);
            assertEquals(2, messages.size());
        } finally { logger.removeAppender(capture); logger.setLevel(before); capture.stop(); PackVersionLock.LOG = original; }
    }
}
