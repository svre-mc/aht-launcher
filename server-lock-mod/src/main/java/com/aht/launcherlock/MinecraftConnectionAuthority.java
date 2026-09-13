package com.aht.launcherlock;

import java.net.InetSocketAddress;
import java.net.SocketAddress;

/** This decision uses the physical socket, never Bungee's forwarded player IP. */
final class MinecraftConnectionAuthority {
    private MinecraftConnectionAuthority() {}

    static boolean authenticated(boolean onlineMode, boolean trustedLoopbackProxy,
                                 String boundHost, SocketAddress physicalPeer) {
        if (!(physicalPeer instanceof InetSocketAddress)) return false;
        InetSocketAddress peer = (InetSocketAddress) physicalPeer;
        if (peer.isUnresolved()) return false;
        if (onlineMode) return true;
        // Explicit opt-in for the privately bound backend behind our online-mode
        // proxy. A wildcard bind or direct/offline connection never qualifies.
        boolean loopbackBind = "127.0.0.1".equals(boundHost) || "::1".equals(boundHost);
        return trustedLoopbackProxy && loopbackBind && peer.getAddress().isLoopbackAddress();
    }
}
