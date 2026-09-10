import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'build/native-guard-test/handoff');
const binary=process.env.AHT_HANDOFF_GUARD||path.join(root,'build/native-guard/Phoenix Anti-cheat.exe');
const javaHome=process.env.JAVA_HOME||'C:/AHTDEV/Toolchains/Java-8';
const javaPath=path.join(javaHome,'bin/java.exe');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function line(child){return new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('startup timeout')),8000);child.once('error',reject);child.stdout.on('data',b=>{text+=b;if(text.includes('\n')){clearTimeout(timer);resolve(text.split('\n')[0]);}});});}
function request(port,text){return new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port});let body='';socket.setTimeout(2000,()=>socket.destroy(Error('timeout')));socket.on('connect',()=>socket.write(text+'\n'));socket.on('error',reject);socket.on('data',b=>{body+=b;if(body.length>6144)socket.destroy(Error('size'));if(body.includes('\n')){socket.destroy();try{resolve(JSON.parse(body));}catch(e){reject(e);}}});socket.on('end',()=>{if(!body.includes('\n'))reject(Error('helper-no-response'));});});}
await fs.mkdir(out,{recursive:true});
execFileSync(path.join(javaHome,'bin/javac.exe'),['-d',out,path.join(root,'native-guard/test/JavaRuntimeFixture.java')],{windowsHide:true});
let game,guard;const results=[];
try{
 game=spawn(javaPath,['-XX:+DisableAttachMechanism','-Dminecraft.applet.TargetDirectory='+out,'-cp',out,'JavaRuntimeFixture'],{windowsHide:true,stdio:['ignore','pipe','pipe']});await line(game);
 guard=spawn(binary,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});const ready=line(guard);
 guard.stdin.end(JSON.stringify({gameDir:out,javaPath,launcherPid:process.pid,launcherSessionId:'9'.repeat(32)})+'\n');const info=JSON.parse(await ready);
 await pause(2500);
 const single=async(management=false)=>{const nonce=crypto.randomBytes(24).toString('hex');const reply=await request(info.port,(management?info.sessionKey+'|':'')+nonce+'|'+game.pid);const bytes=Buffer.from(reply.payload,'base64url');const fields=bytes.toString().split('\n');assert(crypto.verify('sha256',bytes,crypto.createPublicKey({format:'jwk',key:{kty:'RSA',n:reply.modulus,e:reply.exponent}}),Buffer.from(reply.signature,'base64url')));assert.equal(fields[1],nonce);assert.equal(fields[2],info.keyHash);assert.equal(fields[3],String(game.pid));assert.equal(fields[7],'clean');return true;};
 await single();await pause(160);
 for(let round=0;round<3;round++){
   const start=Date.now();const responses=await Promise.allSettled([single(true),single(),single()]);
   results.push({round,elapsedMs:Date.now()-start,accepted:responses.filter(r=>r.status==='fulfilled').length,rejected:responses.filter(r=>r.status==='rejected').map(r=>r.reason.message)});await pause(180);
 }
 const rejected=results.reduce((n,r)=>n+r.rejected.length,0);
 const receipt={status:rejected?'REPRODUCED':'PASSED',scope:'Real published/native helper, real Java 8, concurrent launcher and game measurements; no Minecraft server or real account',results};
 await fs.writeFile(process.env.AHT_CONTENTION_RESULT||path.join(out,'contention-result.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
 if(process.argv.includes('--expect-failure'))assert(rejected>0,'Expected to reproduce published silent rejection');else assert.equal(rejected,0,'Legitimate overlapping measurements must not be silently rejected');
}finally{game?.kill();guard?.kill();}
