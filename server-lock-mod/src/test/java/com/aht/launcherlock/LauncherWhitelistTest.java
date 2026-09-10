package com.aht.launcherlock;

import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.lang.reflect.Proxy;
import net.minecraft.command.*;
import net.minecraft.util.text.ITextComponent;
import org.junit.*;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class LauncherWhitelistTest {
    @Rule public TemporaryFolder folder=new TemporaryFolder();
    private LauncherWhitelist create()throws Exception {
        LauncherWhitelist policy=new LauncherWhitelist(folder.newFolder().toPath().resolve("whitelist.txt"));
        policy.initialize(null);return policy;
    }
    @Test public void importsNamesButNotRetiredGlobalDisable()throws Exception {
        Path base=folder.newFolder().toPath();Path old=base.resolve("old.txt");
        Files.write(old,Arrays.asList("# old system", "all=off", "Alice", "ALICE", "Bob"),StandardCharsets.UTF_8);
        LauncherWhitelist p=new LauncherWhitelist(base.resolve("new.txt"));p.initialize(old);
        assertTrue(p.required());assertTrue(p.allows("aLiCe"));assertFalse(p.allows("Carol"));
        assertEquals(Arrays.asList("alice","bob"),p.names());
        Files.write(old,Arrays.asList("all=off","Carol"),StandardCharsets.UTF_8);
        p.initialize(old);assertFalse(p.allows("Carol"));
    }
    @Test public void adminAddRemoveToggleAndReloadArePersistent()throws Exception {
        LauncherWhitelist p=create();assertFalse(p.allows("Alice"));assertTrue(p.add("Alice"));assertFalse(p.add("ALICE"));
        LauncherWhitelist reopened=new LauncherWhitelist(p.file());reopened.reload();assertTrue(reopened.allows("alice"));
        assertTrue(p.remove("ALICE"));p.setRequired(false);assertTrue(p.allows("Anyone"));
        reopened.reload();assertFalse(reopened.required());assertTrue(reopened.allows("Anyone"));
        p.setRequired(true);assertFalse(p.allows("Anyone"));assertFalse(p.allows("../bad"));
    }
    @Test public void invalidReloadAndFailedSaveDoNotPublishPartialPolicy()throws Exception {
        LauncherWhitelist p=create();p.add("Alice");
        Files.write(p.file(),Arrays.asList("all=off","not a username"),StandardCharsets.UTF_8);
        try{p.reload();fail();}catch(java.io.IOException expected){}
        assertTrue(p.required());assertTrue(p.allows("Alice"));assertFalse(p.allows("Bob"));
        Files.delete(p.file());Files.createDirectory(p.file());
        try{p.setRequired(false);fail();}catch(java.io.IOException expected){}
        assertTrue(p.required());assertFalse(p.allows("Bob"));
    }
    @Test public void exemptionCoversPendingProofAndStaleDenialCannotRevokeIt()throws Exception {
        LauncherWhitelist p=create();JoinSessionRegistry r=new JoinSessionRegistry();UUID id=UUID.randomUUID();Object socket=new Object();
        UUID pending=r.begin(id,socket,3);r.markVerificationInFlight(id,socket);
        assertFalse(r.acceptExempt(p,"Alice",id,socket,3));assertTrue(r.current(id,pending));
        p.add("Alice");assertTrue(r.acceptExempt(p,"ALICE",id,socket,3));assertTrue(r.isAccepted(id,socket));
        assertFalse(r.fail(id,pending));for(int i=0;i<5;i++)assertTrue(r.tickAndCollectExpired().isEmpty());
        p.remove("Alice");assertTrue(r.isAccepted(id,socket)); // Existing accepted sessions remain connected.
        Object reconnect=new Object();UUID next=r.begin(id,reconnect,3);
        assertFalse(r.acceptExempt(p,"Alice",id,reconnect,3));assertFalse(r.isAccepted(id,reconnect));
        r.clear(id,socket);assertTrue(r.current(id,next));
    }
    @Test public void globalToggleAndNullIdentityCannotLeakAcrossConnections()throws Exception {
        LauncherWhitelist p=create();JoinSessionRegistry r=new JoinSessionRegistry();UUID id=UUID.randomUUID();Object socket=new Object();
        p.setRequired(false);assertTrue(r.acceptExempt(p,"Alice",id,socket,3));
        assertFalse(r.acceptExempt(p,"../bad",UUID.randomUUID(),new Object(),3));assertFalse(r.acceptExempt(p,"Alice",id,null,3));
        p.setRequired(true);r.clear(id,socket);Object next=new Object();r.begin(id,next,3);
        assertFalse(r.acceptExempt(p,"Alice",id,next,3));assertFalse(r.isAccepted(id,next));
    }
    private ICommandSender sender(final boolean admin,final List<String> output) {
        return (ICommandSender)Proxy.newProxyInstance(getClass().getClassLoader(),new Class[]{ICommandSender.class},(proxy,method,args)->{
            if(method.getName().equals("canUseCommand"))return admin;
            if(method.getName().equals("sendMessage")){output.add(((ITextComponent)args[0]).getUnformattedText());return null;}
            if(method.getName().equals("getName"))return "TestConsole";
            if(method.getReturnType()==boolean.class)return false;
            if(method.getReturnType()==int.class)return 0;
            return null;
        });
    }
    @Test public void consoleCommandsProduceReadableOutputAndRequirePermission()throws Exception {
        LauncherWhitelist p=create();CommandAhtWhitelist command=new CommandAhtWhitelist(p);List<String> output=new ArrayList<String>();
        assertEquals(4,command.getRequiredPermissionLevel());
        try{command.execute(null,sender(false,output),new String[]{"all","off"});fail();}catch(CommandException expected){}
        assertTrue(p.required());assertTrue(output.isEmpty());
        ICommandSender admin=sender(true,output);command.execute(null,admin,new String[]{"add","Alice"});
        command.execute(null,admin,new String[]{"list"});assertTrue(String.join("\n",output).contains("alice"));
        command.execute(null,admin,new String[]{"remove","ALICE"});assertFalse(p.allows("Alice"));
        command.execute(null,admin,new String[]{"all","off"});assertFalse(p.required());
        command.execute(null,admin,new String[]{"all","on"});assertTrue(p.required());
        command.execute(null,admin,new String[]{"reload"});
        try{command.execute(null,admin,new String[]{"add","bad name"});fail();}catch(CommandException expected){}
        try{command.execute(null,admin,new String[]{"me"});fail();}catch(CommandException expected){}
        assertEquals(Arrays.asList("on","off"),command.getTabCompletions(null,admin,new String[]{"all",""},null));
    }
}
