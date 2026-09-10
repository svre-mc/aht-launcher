package com.aht.launcherlock;

import org.junit.Test;
import static org.junit.Assert.*;

public class AdmissionSaveStateTest {
    // Deliberately colliding equality/UUID-like identity must not merge connections.
    static final class Player {
        public int hashCode() { return 1; }
        public boolean equals(Object other) { return other instanceof Player; }
    }
    @Test public void rejectedAndCancelledPlayersCannotSaveAcrossMultipleIdentities() {
        AdmissionSaveState saves = new AdmissionSaveState();
        Object[] players = {new Player(), new Player(), new Player(), new Player()};
        for (Object player : players) saves.track(player);
        for (Object player : players) assertTrue(saves.blocked(player, false));
        assertFalse(saves.blocked(players[0], true));
        assertFalse(saves.blocked(players[0], false));
        for (int i=1;i<players.length;i++) assertTrue(saves.blocked(players[i], false));
        Object rejectedReconnect = new Player(); saves.track(rejectedReconnect);
        assertTrue(saves.blocked(rejectedReconnect, false));
        assertFalse(saves.blocked(players[0], true));
        assertTrue(saves.blocked(players[1], false));
    }
    @Test public void ordinaryUntrackedSavesAndSuccessfulLogoutsKeepWorking() {
        AdmissionSaveState saves = new AdmissionSaveState(); Object player = new Player();
        assertFalse(saves.blocked(player, false));
        saves.track(player); assertTrue(saves.blocked(player, false));
        assertFalse(saves.blocked(player, true));
        assertFalse(saves.blocked(player, false));
    }
}
