package com.aht.launcherlock.core;

import net.minecraft.launchwrapper.IClassTransformer;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Divert Forge's one world-entry call, leaving the ordinary handshake intact. */
public final class AdmissionTransformer implements IClassTransformer {
    public byte[] transform(String name, String transformedName, byte[] bytes) {
        if (!"net.minecraftforge.fml.common.network.handshake.NetworkDispatcher".equals(transformedName)) return bytes;
        ClassNode type = new ClassNode();
        new ClassReader(bytes).accept(type, 0);
        int hooks = 0;
        int existing = 0;
        for (MethodNode method : type.methods) {
            if (!"completeServerSideConnection".equals(method.name)) continue;
            for (AbstractInsnNode instruction : method.instructions.toArray()) {
                if (!(instruction instanceof MethodInsnNode)) continue;
                MethodInsnNode call = (MethodInsnNode)instruction;
                if (call.getOpcode() == Opcodes.INVOKESTATIC && "com/aht/launcherlock/PreWorldAdmission".equals(call.owner)
                    && "initialize".equals(call.name)) { existing++; continue; }
                boolean mapped = "net/minecraft/server/management/PlayerList".equals(call.owner)
                    && "(Lnet/minecraft/network/NetworkManager;Lnet/minecraft/entity/player/EntityPlayerMP;Lnet/minecraft/network/NetHandlerPlayServer;)V".equals(call.desc);
                // Mixin can request Forge bytecode before the deobfuscating
                // transformer. Preserve the descriptor's namespace for its later pass.
                boolean production = "pl".equals(call.owner) && "(Lgw;Loq;Lpa;)V".equals(call.desc);
                boolean contained = call.getOpcode() == Opcodes.INVOKESTATIC
                    && "com/aht/crashexploitfixer112/guard/ServerFaultContainment".equals(call.owner)
                    && "initializeConnection".equals(call.name)
                    && "(Lnet/minecraft/server/management/PlayerList;Lnet/minecraft/network/NetworkManager;Lnet/minecraft/entity/player/EntityPlayerMP;Lnet/minecraft/network/NetHandlerPlayServer;)V".equals(call.desc);
                if (!contained && (call.getOpcode() != Opcodes.INVOKEVIRTUAL || (!mapped && !production))) continue;
                String descriptor = contained ? call.desc : "(L" + call.owner + ";" + call.desc.substring(1);
                call.setOpcode(Opcodes.INVOKESTATIC);
                call.owner = "com/aht/launcherlock/PreWorldAdmission";
                call.name = "initialize";
                call.desc = descriptor;
                call.itf = false;
                hooks++;
            }
        }
        if (hooks + existing != 1) throw new IllegalStateException("AHT world-entry hook is unavailable; refusing an unguarded runtime.");
        ClassWriter writer = new ClassWriter(0);
        type.accept(writer);
        return writer.toByteArray();
    }
}
