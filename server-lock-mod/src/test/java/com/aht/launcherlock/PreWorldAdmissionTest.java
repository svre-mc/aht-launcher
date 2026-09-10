package com.aht.launcherlock;

import io.netty.buffer.Unpooled;
import io.netty.channel.embedded.EmbeddedChannel;
import net.minecraft.network.PacketBuffer;
import net.minecraft.network.play.client.*;
import net.minecraft.network.play.server.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class PreWorldAdmissionTest {
    @Test public void unavailableRuntimeDoesNotTellAnAlreadyAuditedPlayerToRepairFiles() {
        String message = PreWorldAdmission.failureMessage("runtime protection");
        assertTrue(message.contains("Close Minecraft"));
        assertTrue(message.contains("AHT Launcher"));
        assertFalse(message.toLowerCase(java.util.Locale.ROOT).contains("repair"));
        assertTrue(PreWorldAdmission.failureMessage("client audit").contains("repair"));
        assertTrue(PreWorldAdmission.failureMessage("launcher proof").contains("repair"));
    }
    @Test public void pendingConnectionReceivesNoWorldOrGameplayAndCannotMove() {
        EmbeddedChannel channel = new EmbeddedChannel(new PreWorldAdmission.Pending(null,null,null,null));
        assertFalse(channel.writeOutbound(new SPacketJoinGame()));
        assertFalse(channel.writeOutbound(new SPacketChunkData()));
        assertFalse(channel.writeOutbound(new SPacketMaps()));
        assertFalse(channel.writeOutbound(new SPacketPlayerListItem()));
        assertFalse(channel.writeInbound(new CPacketPlayer()));
        assertFalse(channel.writeInbound(new CPacketChatMessage("/spawn")));
        assertFalse(channel.writeInbound(new CPacketUseEntity()));
        PacketBuffer buffer = new PacketBuffer(Unpooled.buffer().writeByte(1));
        assertFalse(channel.writeInbound(new CPacketCustomPayload("unapproved",buffer)));
        assertEquals(0,buffer.refCnt());
        CPacketCustomPayload spoofedBrand = new CPacketCustomPayload("MC|Brand",new PacketBuffer(Unpooled.buffer().writeByte(1)));
        assertTrue(channel.writeInbound(spoofedBrand));
        assertSame(spoofedBrand,channel.readInbound());spoofedBrand.getBufferData().release();
        assertFalse(channel.writeOutbound(new SPacketJoinGame()));
        assertFalse(channel.writeInbound(new CPacketPlayer()));
        channel.finishAndReleaseAll();
    }
    @Test public void onlyBoundedAdmissionTrafficPassesUntilAcceptance() {
        PreWorldAdmission.Pending pending = new PreWorldAdmission.Pending(null,null,null,null);
        EmbeddedChannel channel = new EmbeddedChannel(pending);
        CPacketCustomPayload proof = new CPacketCustomPayload("ahtversionlock",new PacketBuffer(Unpooled.buffer().writeByte(1)));
        assertTrue(channel.writeInbound(proof));
        assertSame(proof,channel.readInbound()); proof.getBufferData().release();
        SPacketCustomPayload challenge = new SPacketCustomPayload("aht_anticheat",new PacketBuffer(Unpooled.buffer().writeByte(1)));
        assertTrue(channel.writeOutbound(challenge));
        assertSame(challenge,channel.readOutbound()); challenge.getBufferData().release();
        assertTrue(channel.writeOutbound(new SPacketKeepAlive(123)));
        assertTrue(channel.readOutbound() instanceof SPacketKeepAlive);
        assertTrue(channel.writeInbound(new CPacketKeepAlive(123)));
        assertTrue(channel.readInbound() instanceof CPacketKeepAlive);
        pending.worldEntryAuthorized = true;
        assertFalse(channel.writeOutbound(new SPacketPlayerAbilities()));
        assertFalse(pending.admitted);
        SPacketJoinGame joined = new SPacketJoinGame();
        assertTrue(channel.writeOutbound(joined));
        assertSame(joined,channel.readOutbound());
        assertTrue(pending.admitted);
        assertTrue(channel.writeOutbound(new SPacketPlayerAbilities()));
        assertTrue(channel.readOutbound() instanceof SPacketPlayerAbilities);
        channel.finishAndReleaseAll();
    }
    @Test public void pendingFloodIsBoundedBeforeSchedulingOrDecoding() {
        AdmissionBudget budget = new AdmissionBudget();
        for (int i=0;i<64;i++) assertTrue(budget.allow(16384,1_000_000_000L));
        assertFalse(budget.allow(1,1_000_000_000L));
        assertTrue(budget.allow(16384,2_000_000_000L));
        assertFalse(budget.allow(32768,2_000_000_000L));
        AdmissionBudget small = new AdmissionBudget();
        for(int i=0;i<128;i++) assertTrue(small.allow(0,1_000_000_000L));
        assertFalse(small.allow(0,1_000_000_000L));
    }
}
