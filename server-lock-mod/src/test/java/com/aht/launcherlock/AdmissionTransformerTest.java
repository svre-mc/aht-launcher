package com.aht.launcherlock;

import com.aht.launcherlock.core.AdmissionTransformer;
import org.junit.Test;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;
import org.objectweb.asm.commons.*;
import java.util.*;
import static org.junit.Assert.*;

public class AdmissionTransformerTest {
    private static final String TARGET="net.minecraftforge.fml.common.network.handshake.NetworkDispatcher";
    @Test public void saveAndLogoutAreGuardedInMappedAndProductionNamespaces() throws Exception {
        String playerList="net.minecraft.server.management.PlayerList";
        ClassReader source=new ClassReader(getClass().getClassLoader().getResourceAsStream(playerList.replace('.','/')+".class"));
        for (boolean production : new boolean[] {false,true}) {
            ClassWriter original=new ClassWriter(0);
            if (production) {
                Map<String,String> names=new HashMap<String,String>();
                names.put("net/minecraft/server/management/PlayerList","pl");
                names.put("net/minecraft/entity/player/EntityPlayerMP","oq");
                names.put("net/minecraft/server/management/PlayerList.writePlayerData(Lnet/minecraft/entity/player/EntityPlayerMP;)V","b");
                names.put("net/minecraft/server/management/PlayerList.playerLoggedOut(Lnet/minecraft/entity/player/EntityPlayerMP;)V","e");
                source.accept(new ClassRemapper(original,new SimpleRemapper(names)),0);
            } else source.accept(original,0);
            AdmissionTransformer transformer=new AdmissionTransformer();
            byte[] once=transformer.transform(playerList,playerList,original.toByteArray());
            assertArrayEquals(once,transformer.transform(playerList,playerList,once));
            ClassNode node=new ClassNode();new ClassReader(once).accept(node,0);
            Set<String> guards=new HashSet<String>();
            for(MethodNode method:node.methods) for(AbstractInsnNode instruction:method.instructions.toArray()) if(instruction instanceof MethodInsnNode) {
                MethodInsnNode call=(MethodInsnNode)instruction;
                if(call.owner.equals("com/aht/launcherlock/PreWorldAdmission") && call.name.startsWith("skipUnadmitted")) {
                    assertTrue(guards.add(call.name));
                    assertEquals(production?"(Lpl;Loq;)Z":"(Lnet/minecraft/server/management/PlayerList;Lnet/minecraft/entity/player/EntityPlayerMP;)Z",call.desc);
                }
            }
            assertEquals(new HashSet<String>(Arrays.asList("skipUnadmittedSave","skipUnadmittedLogout")),guards);
        }
    }
    @Test public void dispatcherCannotEnterWorldWithoutAdmissionCall() throws Exception {
        String resource=TARGET.replace('.','/')+".class";
        ClassReader source=new ClassReader(getClass().getClassLoader().getResourceAsStream(resource));
        ClassWriter original=new ClassWriter(0);source.accept(original,0);
        byte[] changed=new AdmissionTransformer().transform(TARGET,TARGET,original.toByteArray());
        ClassNode node=new ClassNode();new ClassReader(changed).accept(node,0);
        int guarded=0,unguarded=0;
        for(MethodNode method:node.methods) if(method.name.equals("completeServerSideConnection")) {
            for(AbstractInsnNode instruction:method.instructions.toArray())if(instruction instanceof MethodInsnNode) {
                MethodInsnNode call=(MethodInsnNode)instruction;
                if(call.owner.equals("com/aht/launcherlock/PreWorldAdmission"))guarded++;
                if(call.owner.equals("net/minecraft/server/management/PlayerList"))unguarded++;
            }
        }
        assertEquals(1,guarded);assertEquals(0,unguarded);
    }
    @Test(expected=IllegalStateException.class) public void unknownDispatcherDoesNotSilentlyDisableGate() {
        ClassWriter writer=new ClassWriter(0);
        writer.visit(Opcodes.V1_8,Opcodes.ACC_PUBLIC,TARGET.replace('.','/'),null,"java/lang/Object",null);
        writer.visitEnd();
        new AdmissionTransformer().transform(TARGET,TARGET,writer.toByteArray());
    }
    @Test public void earlyMixinLookupPreservesProductionNamespace() throws Exception {
        ClassReader source=new ClassReader(getClass().getClassLoader().getResourceAsStream(TARGET.replace('.','/')+".class"));
        Map<String,String> names=new HashMap<String,String>();
        names.put("net/minecraft/server/management/PlayerList","pl");
        names.put("net/minecraft/network/NetworkManager","gw");
        names.put("net/minecraft/entity/player/EntityPlayerMP","oq");
        names.put("net/minecraft/network/NetHandlerPlayServer","pa");
        ClassWriter writer=new ClassWriter(0);
        source.accept(new ClassRemapper(writer,new SimpleRemapper(names)),0);
        ClassNode node=new ClassNode();
        new ClassReader(new AdmissionTransformer().transform(TARGET,TARGET,writer.toByteArray())).accept(node,0);
        int guarded=0;
        for(MethodNode method:node.methods) for(AbstractInsnNode instruction:method.instructions.toArray()) {
            if(instruction instanceof MethodInsnNode) {
                MethodInsnNode call=(MethodInsnNode)instruction;
                if(call.owner.equals("com/aht/launcherlock/PreWorldAdmission")) {
                    assertEquals("(Lpl;Lgw;Loq;Lpa;)V",call.desc);guarded++;
                }
            }
        }
        assertEquals(1,guarded);
    }
    @Test public void composesWithCrashContainmentAndIsIdempotent() throws Exception {
        ClassNode node=new ClassNode();
        new ClassReader(getClass().getClassLoader().getResourceAsStream(TARGET.replace('.','/')+".class")).accept(node,0);
        for(MethodNode method:node.methods) if(method.name.equals("completeServerSideConnection")) {
            for(AbstractInsnNode instruction:method.instructions.toArray()) if(instruction instanceof MethodInsnNode) {
                MethodInsnNode call=(MethodInsnNode)instruction;
                if(call.owner.equals("net/minecraft/server/management/PlayerList")) {
                    call.desc="(L"+call.owner+";"+call.desc.substring(1);
                    call.owner="com/aht/crashexploitfixer112/guard/ServerFaultContainment";
                    call.name="initializeConnection";call.setOpcode(Opcodes.INVOKESTATIC);
                }
            }
        }
        ClassWriter writer=new ClassWriter(0);node.accept(writer);
        AdmissionTransformer transformer=new AdmissionTransformer();
        byte[] once=transformer.transform(TARGET,TARGET,writer.toByteArray());
        assertArrayEquals(once,transformer.transform(TARGET,TARGET,once));
    }
}
