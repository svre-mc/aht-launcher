package com.aht.launcherlock;

import org.junit.Test;
import static org.junit.Assert.*;

public class ServerStateConnectionsTest {
    private static ServerPolicySnapshot policy(String version, long issuedAt) throws Exception {
        return ServerPolicySnapshot.verifyMessage(
            SignedStateTestSupport.stateMessage(version, null, true, issuedAt),
            SignedStateTestSupport.KEY_FINGERPRINT, SignedStateTestSupport.PACK_ID, System.currentTimeMillis());
    }

    @Test public void eitherFreshTransportKeepsTheLatestSignedPolicyAvailable() throws Exception {
        ServerStateConnections channel = new ServerStateConnections(100);
        ServerPolicySnapshot policy = policy("0.2.23", System.currentTimeMillis() - 1000);
        channel.signedPolicy(0, policy, 0);
        channel.signedPolicy(1, policy, 50);
        assertEquals(2, channel.healthyCount(90));
        assertEquals(1, channel.healthyCount(101));
        assertSame(policy, channel.current(101));
        channel.disconnected(0);
        assertSame(policy, channel.current(120));
        channel.disconnected(1);
        assertNull("The cached signed policy alone cannot authorize joins", channel.current(120));
    }

    @Test public void aReconnectingOrLaggingPeerCannotRollBackTheCurrentPolicy() throws Exception {
        long issued = System.currentTimeMillis() - 2000;
        ServerPolicySnapshot old = policy("0.2.22", issued);
        ServerPolicySnapshot latest = policy("0.2.23", issued + 1000);
        ServerStateConnections channel = new ServerStateConnections(100);
        channel.signedPolicy(0, old, 0);
        channel.signedPolicy(1, latest, 10);
        assertSame(latest, channel.current(20));
        channel.disconnected(1);
        channel.responsive(0, 30);
        assertNull("An older peer must not become a fallback for a newer policy", channel.current(30));
        channel.signedPolicy(1, old, 40);
        assertNull(channel.current(40));
        channel.signedPolicy(0, latest, 50);
        assertSame(latest, channel.current(50));
    }

    @Test public void staleConnectionsAndConflictingSignedTimestampsFailClosed() throws Exception {
        long issued = System.currentTimeMillis() - 2000;
        ServerStateConnections channel = new ServerStateConnections(100);
        channel.signedPolicy(0, policy("0.2.22", issued), 0);
        assertNull(channel.current(101));
        channel.responsive(1, 110);
        assertNull("Pongs without a verified policy cannot establish a channel", channel.current(110));
        channel.signedPolicy(1, policy("0.2.23", issued), 120);
        assertNull("Arrival order cannot resolve conflicting same-time policies", channel.current(120));
        channel.signedPolicy(1, policy("0.2.23", issued + 1000), 130);
        assertEquals("0.2.23", channel.current(130).necessaryLauncherVersion);
    }
}
