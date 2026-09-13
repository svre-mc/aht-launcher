package com.aht.launcherlock.core;

import net.minecraft.launchwrapper.IClassTransformer;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Divert Forge's one world-entry call, leaving the ordinary handshake intact. */
public final class AdmissionTransformer implements IClassTransformer {
    public byte[] transform(String name, String transformedName, byte[] bytes) {
        if ("net.minecraft.network.NetHandlerPlayServer".equals(transformedName)) return guardConnectionLifecycle(bytes);
        if ("net.minecraft.server.management.PlayerList".equals(transformedName)) return guardPersistence(bytes);
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
    private byte[] guardConnectionLifecycle(byte[] bytes) {
        ClassNode type = new ClassNode();
        new ClassReader(bytes).accept(type, 0);
        int constructors = 0, ticks = 0;
        for (MethodNode method : type.methods) {
            boolean constructor = "<init>".equals(method.name)
                && ("(Lnet/minecraft/server/MinecraftServer;Lnet/minecraft/network/NetworkManager;Lnet/minecraft/entity/player/EntityPlayerMP;)V".equals(method.desc)
                    || "(Lnet/minecraft/server/MinecraftServer;Lgw;Loq;)V".equals(method.desc));
            if (constructor) {
                constructors++;
                boolean existing = false;
                for (AbstractInsnNode instruction : method.instructions.toArray()) if (instruction instanceof MethodInsnNode) {
                    MethodInsnNode call = (MethodInsnNode) instruction;
                    if ("com/aht/launcherlock/PreWorldAdmission".equals(call.owner) && "trackConnectionPlayer".equals(call.name)) existing = true;
                }
                if (!existing) for (AbstractInsnNode instruction : method.instructions.toArray()) if (instruction.getOpcode() == Opcodes.RETURN) {
                    InsnList fence = new InsnList();
                    fence.add(new VarInsnNode(Opcodes.ALOAD, 3));
                    String player = Type.getArgumentTypes(method.desc)[2].getDescriptor();
                    fence.add(new MethodInsnNode(Opcodes.INVOKESTATIC, "com/aht/launcherlock/PreWorldAdmission", "trackConnectionPlayer", "(" + player + ")V", false));
                    method.instructions.insertBefore(instruction, fence);
                }
            }
            if (!"()V".equals(method.desc) || !("update".equals(method.name) || "func_73660_a".equals(method.name) || "e".equals(method.name))) continue;
            for (AbstractInsnNode instruction : method.instructions.toArray()) if (instruction instanceof MethodInsnNode) {
                MethodInsnNode call = (MethodInsnNode) instruction;
                if ("com/aht/launcherlock/PreWorldAdmission".equals(call.owner) && "tickAdmittedPlayer".equals(call.name)) { ticks++; continue; }
                boolean mapped = "net/minecraft/entity/player/EntityPlayerMP".equals(call.owner)
                    && ("onUpdateEntity".equals(call.name) || "func_71127_g".equals(call.name));
                boolean production = "oq".equals(call.owner) && "k_".equals(call.name);
                if (call.getOpcode() != Opcodes.INVOKEVIRTUAL || !"()V".equals(call.desc) || (!mapped && !production)) continue;
                call.desc = "(L" + call.owner + ";)V";
                call.owner = "com/aht/launcherlock/PreWorldAdmission";
                call.name = "tickAdmittedPlayer"; call.setOpcode(Opcodes.INVOKESTATIC); call.itf = false;
                ticks++;
            }
        }
        if (constructors != 1 || ticks != 1) throw new IllegalStateException("AHT unloaded-player lifecycle boundaries are unavailable; refusing unsafe admission.");
        ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
        type.accept(writer); return writer.toByteArray();
    }
    private byte[] guardPersistence(byte[] bytes) {
        ClassNode type = new ClassNode();
        new ClassReader(bytes).accept(type, 0);
        int guarded = 0;
        for (MethodNode method : type.methods) {
            if (!"(Lnet/minecraft/entity/player/EntityPlayerMP;)V".equals(method.desc) && !"(Loq;)V".equals(method.desc)) continue;
            String hook;
            if ("writePlayerData".equals(method.name) || "func_72391_b".equals(method.name) || "b".equals(method.name)) hook = "skipUnadmittedSave";
            else if ("playerLoggedOut".equals(method.name) || "func_72367_e".equals(method.name) || "e".equals(method.name)) hook = "skipUnadmittedLogout";
            else continue;
            guarded++;
            boolean existing = false;
            for (AbstractInsnNode instruction : method.instructions.toArray()) if (instruction instanceof MethodInsnNode) {
                MethodInsnNode call = (MethodInsnNode)instruction;
                if ("com/aht/launcherlock/PreWorldAdmission".equals(call.owner) && hook.equals(call.name)) existing = true;
            }
            if (existing) continue;
            LabelNode original = new LabelNode();
            InsnList guard = new InsnList();
            guard.add(new VarInsnNode(Opcodes.ALOAD, 0));
            guard.add(new VarInsnNode(Opcodes.ALOAD, 1));
            String descriptor = "(L" + type.name + ";" + method.desc.substring(1, method.desc.length() - 1) + "Z";
            guard.add(new MethodInsnNode(Opcodes.INVOKESTATIC, "com/aht/launcherlock/PreWorldAdmission", hook, descriptor, false));
            guard.add(new JumpInsnNode(Opcodes.IFEQ, original));
            guard.add(new InsnNode(Opcodes.RETURN));
            guard.add(original);
            guard.add(new FrameNode(Opcodes.F_SAME, 0, null, 0, null));
            method.instructions.insert(guard);
        }
        if (guarded != 2) throw new IllegalStateException("AHT player-save boundaries are unavailable; refusing unsafe admission.");
        ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
        type.accept(writer);
        return writer.toByteArray();
    }
}
