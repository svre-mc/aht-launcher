package com.aht.launcherlock;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.channels.FileChannel;
import java.nio.ByteBuffer;
import java.nio.file.*;
import java.util.*;

/** Server-only operator policy. A successful durable write precedes publication. */
final class LauncherWhitelist {
    private final Path file;
    private volatile Policy policy = new Policy(true, Collections.<String>emptySet());
    private static final class Policy {
        final boolean required;
        final Set<String> names;
        Policy(boolean required, Set<String> names) {
            this.required=required;
            this.names=Collections.unmodifiableSet(new TreeSet<String>(names));
        }
    }
    LauncherWhitelist(Path file) { this.file=file; }
    synchronized void initialize(Path legacy) throws IOException {
        if(Files.exists(file,LinkOption.NOFOLLOW_LINKS)){reload();return;}
        Set<String> names=new TreeSet<String>();
        if(legacy!=null && Files.isRegularFile(legacy,LinkOption.NOFOLLOW_LINKS)) {
            // Old all=off disabled the retired duplicate verifier. Do not let it
            // silently disable the currently required signed launcher gate.
            for(String raw:read(legacy)) {
                String value=clean(raw);
                if(value.isEmpty() || value.toLowerCase(Locale.ROOT).startsWith("all="))continue;
                names.add(normalize(value));
            }
        }
        save(new Policy(true,names));
    }
    synchronized void reload() throws IOException {
        boolean required=true;boolean toggleSeen=false;Set<String> names=new TreeSet<String>();
        for(String raw:read(file)) {
            String value=clean(raw);
            if(value.isEmpty())continue;
            if(value.equalsIgnoreCase("all=on") || value.equalsIgnoreCase("all=off")) {
                if(toggleSeen)throw new IOException("Duplicate all= setting");
                required=value.equalsIgnoreCase("all=on");toggleSeen=true;
            } else {
                try { names.add(normalize(value)); }
                catch(IllegalArgumentException invalid){throw new IOException("Invalid whitelist entry",invalid);}
            }
        }
        policy=new Policy(required,names);
    }
    boolean allows(String name) {
        if(name==null || !name.matches("[A-Za-z0-9_]{1,16}"))return false;
        Policy current=policy;
        return !current.required || current.names.contains(name.toLowerCase(Locale.ROOT));
    }
    boolean required(){return policy.required;}
    List<String> names(){return new ArrayList<String>(policy.names);}
    Path file(){return file;}
    synchronized boolean add(String name)throws IOException {
        String key=normalize(name);Set<String> names=new TreeSet<String>(policy.names);
        if(!names.add(key))return false;
        if(names.size()>10000)throw new IOException("Whitelist entry limit reached");
        save(new Policy(policy.required,names));return true;
    }
    synchronized boolean remove(String name)throws IOException {
        Set<String> names=new TreeSet<String>(policy.names);
        if(!names.remove(normalize(name)))return false;
        save(new Policy(policy.required,names));return true;
    }
    synchronized boolean setRequired(boolean required)throws IOException {
        if(policy.required==required)return false;
        save(new Policy(required,policy.names));return true;
    }
    private static String clean(String raw) {
        int comment=raw.indexOf('#');return (comment<0?raw:raw.substring(0,comment)).trim();
    }
    private static String normalize(String name) {
        if(name==null || !name.matches("[A-Za-z0-9_]{1,16}"))throw new IllegalArgumentException("Expected a Minecraft username (1-16 letters, numbers or underscores).");
        return name.toLowerCase(Locale.ROOT);
    }
    private static List<String> read(Path file)throws IOException {
        if(!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS) || Files.size(file)>1024*1024)
            throw new IOException("Whitelist must be a regular file smaller than 1 MiB");
        return Files.readAllLines(file,StandardCharsets.UTF_8);
    }
    private void save(Policy next)throws IOException {
        Files.createDirectories(file.toAbsolutePath().getParent());
        if(Files.isSymbolicLink(file))throw new IOException("Whitelist must not be a symbolic link");
        StringBuilder text=new StringBuilder("# Signed launcher proof exemptions. Does not grant operator access or bypass game/anti-cheat checks.\n# /ahtwhitelist all on|off\nall=")
                .append(next.required?"on":"off").append('\n');
        for(String name:next.names)text.append(name).append('\n');
        Path temp=Files.createTempFile(file.toAbsolutePath().getParent(),".whitelist-",".tmp");
        try {
            try(FileChannel channel=FileChannel.open(temp,StandardOpenOption.WRITE,StandardOpenOption.TRUNCATE_EXISTING)) {
                ByteBuffer bytes=ByteBuffer.wrap(text.toString().getBytes(StandardCharsets.UTF_8));
                while(bytes.hasRemaining())channel.write(bytes);channel.force(true);
            }
            Files.move(temp,file,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
            policy=next;
        }finally{Files.deleteIfExists(temp);}
    }
}
