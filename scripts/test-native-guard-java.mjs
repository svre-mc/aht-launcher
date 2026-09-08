import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn,execFileSync } from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const out=path.join(root,'build/native-guard-test');
const javaHome=process.env.JAVA_HOME;if(!javaHome)throw new Error('Pinned Java 8 JAVA_HOME is required');
execFileSync(path.join(javaHome,'bin/javac.exe'),['-d',out,path.join(root,'native-guard/test/JavaRuntimeFixture.java')],{windowsHide:true});
function firstLine(child){return new Promise((resolve,reject)=>{let s='';const timeout=setTimeout(()=>reject(new Error('startup timeout')),8000);const onData=c=>{s+=c;if(s.includes('\n')){clearTimeout(timeout);child.stdout.off('data',onData);resolve(s.trim().split('\n')[0]);}};child.stdout.on('data',onData);child.on('error',reject);});}
function request(port,sessionKey,pid){return new Promise((resolve,reject)=>{const nonce=crypto.randomBytes(24).toString('hex');const socket=net.connect({host:'127.0.0.1',port});let text='';socket.setTimeout(2500,()=>socket.destroy(new Error('timeout')));socket.on('connect',()=>socket.write(sessionKey+'|'+nonce+'|'+pid+'\n'));socket.on('error',reject);socket.on('data',data=>{text+=data;if(text.includes('\n')){socket.destroy();const reply=JSON.parse(text);const payload=Buffer.from(reply.payload,'base64url');assert(crypto.verify('sha256',payload,crypto.createPublicKey({key:{kty:'RSA',n:reply.modulus,e:reply.exponent},format:'jwk'}),Buffer.from(reply.signature,'base64url')));const fields=payload.toString().split('\n');assert.equal(fields[1],nonce);resolve(fields);}});socket.on('end',()=>{if(!text)reject(new Error('closed'));});});}
const java=spawn(path.join(javaHome,'bin/java.exe'),['-XX:+DisableAttachMechanism','-Dminecraft.applet.TargetDirectory='+out,'-cp',out,'JavaRuntimeFixture'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
const guard=spawn(path.join(root,'build/native-guard/Phoenix Anti-cheat.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
try {
 const pid=Number(await firstLine(java));const ready=firstLine(guard);guard.stdin.end(JSON.stringify({gameDir:out,javaPath:path.join(javaHome,'bin/java.exe'),launcherPid:process.pid,launcherSessionId:'3'.repeat(32)})+'\n');const info=JSON.parse(await ready);assert.equal(info.launcherPid,process.pid);assert.equal(info.launcherSessionId,'3'.repeat(32));
 assert.match(info.sessionKey,/^[A-Za-z0-9_-]{43}$/);await new Promise(r=>setTimeout(r,2600));await request(info.port,info.sessionKey,pid);const samples=[];
 for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,2400));const fields=await request(info.port,info.sessionKey,pid);samples.push({state:fields[7],modules:Number(fields[8]),bytes:Number(fields[9]),detail:Buffer.from(fields[10],'base64url').toString()});assert.equal(fields[7],'clean',JSON.stringify(samples.at(-1)));}
 let refused=false;try{execFileSync(path.join(javaHome,'bin/jcmd.exe'),[String(pid),'VM.version'],{windowsHide:true,timeout:7000,stdio:'pipe'});}catch(error){refused=/does not support|attach|not responding/i.test(String(error.stderr));}
 assert(refused,'The standard JVM attach path must be refused');
 await fs.writeFile(path.join(out,'java-runtime-results.json'),JSON.stringify({passed:true,attachRefused:refused,samples},null,2));console.log('PASS: real Java 8 native code stays clean during JIT activity; standard attach refused');
}finally{java.kill();guard.kill();}
