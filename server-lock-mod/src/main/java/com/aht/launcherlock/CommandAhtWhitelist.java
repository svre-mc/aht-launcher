package com.aht.launcherlock;

import java.io.IOException;
import java.util.*;
import net.minecraft.command.*;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.text.TextComponentString;

/** Registered by the current signed launcher verifier, independently of legacy Utilities. */
public final class CommandAhtWhitelist extends CommandBase {
    private final LauncherWhitelist policy;
    CommandAhtWhitelist(LauncherWhitelist policy){this.policy=policy;}
    @Override public String getName(){return "ahtwhitelist";}
    @Override public String getUsage(ICommandSender sender){return "/ahtwhitelist <add|remove|list|reload|me|all|status> [player|on|off]";}
    @Override public int getRequiredPermissionLevel(){return 4;}
    @Override public boolean checkPermission(MinecraftServer server,ICommandSender sender){
        if(!(sender instanceof EntityPlayerMP))return sender==server || sender.canUseCommand(4,getName());
        EntityPlayerMP player=(EntityPlayerMP)sender;
        net.minecraft.server.management.UserListOpsEntry entry=server.getPlayerList().getOppedPlayers().getEntry(player.getGameProfile());
        return entry!=null && entry.getPermissionLevel()>=4;
    }
    @Override public void execute(MinecraftServer server,ICommandSender sender,String[] args)throws CommandException {
        if(!checkPermission(server,sender))throw new CommandException("commands.generic.permission");
        String action=args.length==0?"status":args[0].toLowerCase(Locale.ROOT);
        try {
            if(action.equals("status") || action.equals("list")) {
                if(args.length>1)throw new WrongUsageException(getUsage(sender));
                if(action.equals("status")) reply(sender,"Launcher policy channel: "+ServerStateClient.statusText()+".");
                reply(sender,"Signed launcher proof enforcement: "+(policy.required()?"ON":"OFF")+". Applies to new/pending connections.");
                reply(sender,"Launcher exemptions ("+policy.names().size()+"): "+(policy.names().isEmpty()?"none":String.join(", ",policy.names())));
                reply(sender,"These exemptions do not grant operator access or bypass bans, modpack integrity or anti-cheat checks.");
            }else if(action.equals("add") || action.equals("remove") || action.equals("me")) {
                String name;
                if(action.equals("me")) {
                    if(args.length!=1 || !(sender instanceof EntityPlayerMP))throw new WrongUsageException("/ahtwhitelist add <player> (console); /ahtwhitelist me (player)");
                    name=sender.getName();
                }else{if(args.length!=2)throw new WrongUsageException("/ahtwhitelist "+action+" <player>");name=args[1];}
                boolean remove=action.equals("remove");boolean changed=remove?policy.remove(name):policy.add(name);
                reply(sender,(changed?(remove?"Removed ":"Added "):(remove?"Not exempt: ":"Already exempt: "))+name+"; signed launcher proof exemption. Applies to new/pending connections.");
            }else if(action.equals("all")) {
                if(args.length==1){reply(sender,"Signed launcher proof enforcement: "+(policy.required()?"ON":"OFF")+". Use /ahtwhitelist all on|off.");return;}
                if(args.length!=2 || !(args[1].equalsIgnoreCase("on") || args[1].equalsIgnoreCase("off")))throw new WrongUsageException("/ahtwhitelist all <on|off>");
                boolean required=args[1].equalsIgnoreCase("on");policy.setRequired(required);
                reply(sender,required?"Signed launcher proof is required for all non-exempt players on new connections.":"Signed launcher proof enforcement is OFF for new connections. Use /ahtwhitelist all on to require proof again.");
            }else if(action.equals("reload")) {
                if(args.length!=1)throw new WrongUsageException("/ahtwhitelist reload");
                policy.reload();reply(sender,"Reloaded signed launcher whitelist. Enforcement: "+(policy.required()?"ON":"OFF")+"; exemptions: "+policy.names().size()+".");
            }else throw new WrongUsageException(getUsage(sender));
        }catch(IOException failure){throw new CommandException("Could not save/load launcher whitelist; active policy unchanged: %s",failure.getMessage());}
        catch(IllegalArgumentException invalid){throw new CommandException("%s",invalid.getMessage());}
    }
    @Override public List<String> getTabCompletions(MinecraftServer server,ICommandSender sender,String[] args,BlockPos pos){
        if(!checkPermission(server,sender))return Collections.emptyList();
        if(args.length==1)return getListOfStringsMatchingLastWord(args,"add","remove","list","reload","me","all","status");
        if(args.length==2 && args[0].equalsIgnoreCase("all"))return getListOfStringsMatchingLastWord(args,"on","off");
        if(args.length==2 && args[0].equalsIgnoreCase("remove"))return getListOfStringsMatchingLastWord(args,policy.names());
        if(args.length==2 && args[0].equalsIgnoreCase("add"))return getListOfStringsMatchingLastWord(args,server.getOnlinePlayerNames());
        return Collections.emptyList();
    }
    private static void reply(ICommandSender sender,String text){sender.sendMessage(new TextComponentString(text));}
}
