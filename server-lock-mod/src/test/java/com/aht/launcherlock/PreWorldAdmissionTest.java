package com.aht.launcherlock;

import io.netty.buffer.Unpooled;
import io.netty.channel.embedded.EmbeddedChannel;
import net.minecraft.network.PacketBuffer;
import net.minecraft.network.play.client.*;
import net.minecraft.network.play.server.*;
import net.minecraftforge.fml.common.network.internal.FMLProxyPacket;
import org.junit.Test;
import static org.junit.Assert.*;

public class PreWorldAdmissionTest {
    @Test public void unverifiedModSetupIsNotQueuedAndIsReleased() {
        PreWorldAdmission.Pending pending = new PreWorldAdmission.Pending(null,null,null,null);
        EmbeddedChannel channel = new EmbeddedChannel(pending);
        PacketBuffer data = new PacketBuffer(Unpooled.buffer().writeByte(3));
        assertFalse(channel.writeOutbound(new FMLProxyPacket(data, "CreativeCore")));
        assertEquals(0, data.refCnt());
        pending.worldEntryAuthorized = true;
        SPacketJoinGame join = new SPacketJoinGame();
        channel.writeOutbound(join);
        assertSame(join, channel.readOutbound());
        assertNull(channel.readOutbound());
        channel.finishAndReleaseAll();
    }
    @Test public void queuedSetupIsReleasedOnDisconnectOrHandlerRemoval() {
        for (boolean remove : new boolean[]{false,true}) {
            PreWorldAdmission.Pending pending = new PreWorldAdmission.Pending(null,null,null,null);
            EmbeddedChannel channel = new EmbeddedChannel(pending);
            pending.worldEntryAuthorized = true;
            PacketBuffer data = new PacketBuffer(Unpooled.buffer().writeByte(3));
            io.netty.channel.ChannelPromise promise = channel.newPromise();
            channel.pipeline().write(new FMLProxyPacket(data, "CreativeCore"), promise);
            assertFalse(promise.isDone());
            if (remove) channel.pipeline().remove(pending); else channel.close();
            assertEquals(0, data.refCnt());
            assertTrue(promise.isDone()); assertFalse(promise.isSuccess());
            channel.finishAndReleaseAll();
        }
    }
    @Test public void setupFloodHasPacketAndByteLimits() {
        for (boolean large : new boolean[]{false,true}) {
            PreWorldAdmission.Pending pending = new PreWorldAdmission.Pending(null,null,null,null);
            EmbeddedChannel channel = new EmbeddedChannel(pending);
            pending.worldEntryAuthorized = true;
            java.util.List<PacketBuffer> held = new java.util.ArrayList<>();
            int count = large ? 2 : PreWorldAdmission.Pending.MAX_SETUP_PACKETS+1;
            int size = large ? PreWorldAdmission.Pending.MAX_SETUP_BYTES : 1;
            for (int i=0; i<count; i++) {
                PacketBuffer data = new PacketBuffer(Unpooled.buffer(size).writeZero(size)); held.add(data);
                // An explicit promise lets the test observe fail-closed overflow
                // without EmbeddedChannel rethrowing the expected failed write.
                channel.pipeline().write(new FMLProxyPacket(data,"CreativeCore"), channel.newPromise());
            }
            assertFalse(channel.isOpen());
            for (PacketBuffer data : held) assertEquals(0,data.refCnt());
            channel.finishAndReleaseAll();
        }
    }
    @Test public void forgeConnectionConfigurationSurvivesButWaitsForJoinGame() {
        PreWorldAdmission.Pending pending = new PreWorldAdmission.Pending(null,null,null,null);
        EmbeddedChannel channel = new EmbeddedChannel(pending);
        pending.worldEntryAuthorized = true;
        PacketBuffer forgeData = new PacketBuffer(Unpooled.buffer().writeByte(7));
        FMLProxyPacket config = new FMLProxyPacket(forgeData, "CreativeCore");
        PacketBuffer vanillaData = new PacketBuffer(Unpooled.buffer().writeByte(8));
        SPacketCustomPayload extra = new SPacketCustomPayload("setup", vanillaData);
        assertFalse(channel.writeOutbound(config));
        assertFalse(channel.writeOutbound(extra));
        assertFalse(channel.writeInbound(new CPacketPlayer()));
        SPacketJoinGame join = new SPacketJoinGame();
        assertTrue(channel.writeOutbound(join));
        assertSame(join, channel.readOutbound());
        assertSame("Forge fires connection config before JoinGame; it must not be discarded", config, channel.readOutbound());
        assertSame(extra, channel.readOutbound());
        assertEquals(7, forgeData.readByte());
        assertEquals(8, vanillaData.readByte());
        forgeData.release(); vanillaData.release();
        channel.finishAndReleaseAll();
    }
    @Test public void unavailableVerificationKeepsDetailsInServerDiagnosticsOnly() {
        for (String stage : new String[] {"runtime protection", "client audit", "launcher proof", "world entry", null})
            assertEquals("Error", PreWorldAdmission.failureMessage(stage));
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
