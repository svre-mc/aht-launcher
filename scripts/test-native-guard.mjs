import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'build/native-guard-test');await fs.mkdir(output,{recursive:true});
function line(child){return new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(new Error('child output timeout')),8000);const read=c=>{s+=c;if(s.includes('\n')){clearTimeout(timer);child.stdout.off('data',read);resolve(s.trim().split('\n')[0]);}};child.stdout.on('data',read);child.once('error',reject);});}
function request(port,nonce,pid){return new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port});let body='';socket.setTimeout(2500,()=>socket.destroy(new Error('guard response timeout')));socket.on('connect',()=>socket.write(`${nonce}|${pid}\n`));socket.on('data',c=>{body+=c;if(body.length>16384)socket.destroy(new Error('size'));if(body.includes('\n')){socket.end();try{resolve(JSON.parse(body));}catch(e){reject(e);}}});socket.on('error',reject);socket.on('end',()=>{if(!body)reject(new Error('request rejected'));});});}
function verify(reply,info,nonce) {
 const bytes=Buffer.from(reply.payload,'base64url');const fields=bytes.toString().split('\n');
 assert.equal(fields.length,11);assert.equal(fields[0],'AHT-GUARD-1');assert.equal(fields[1],nonce);assert.equal(fields[2],info.keyHash);
 const key=crypto.createPublicKey({key:{kty:'RSA',n:reply.modulus,e:reply.exponent},format:'jwk'});
 assert(crypto.verify('sha256',bytes,key,Buffer.from(reply.signature,'base64url')));return fields;
}
const java=spawn(path.join(output,'java.exe'),['--gameDir',output],{cwd:output,windowsHide:true,stdio:['pipe','pipe','pipe']});
const guardian=spawn(path.join(root,'build/native-guard/AHT Runtime Guard.exe'),[],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
const evidence=[];
const signedFixtures=[];
let decoy;
try {
 const pid=Number(await line(java));const ready=line(guardian);guardian.stdin.end(JSON.stringify({gameDir:output,javaPath:path.join(output,'java.exe')})+'\n');const info=JSON.parse(await ready);
 async function sample(save=true){const nonce=crypto.randomBytes(24).toString('hex');const reply=await request(info.port,nonce,pid);const fields=verify(reply,info,nonce);if(save)signedFixtures.push({nonce,keyHash:info.keyHash,reply,state:fields[7]});evidence.push({at:new Date().toISOString(),state:fields[7],modules:Number(fields[8]),bytes:Number(fields[9]),detail:Buffer.from(fields[10],'base64url').toString()});return fields;}
 await new Promise(r=>setTimeout(r,2600));await sample();await new Promise(r=>setTimeout(r,2500));assert.equal((await sample())[7],'clean');
 java.stdin.write('jit\n');await new Promise(r=>setTimeout(r,2300));assert.equal((await sample())[7],'clean');
 decoy=spawn(path.join(output,'java.exe'),['--gameDir',output],{cwd:output,windowsHide:true,stdio:['pipe','pipe','pipe']});await line(decoy);
 await new Promise(r=>setTimeout(r,2400));assert.equal((await sample(false))[7],'incomplete');
 decoy.stdin.write('quit\n');await new Promise(r=>decoy.once('exit',r));
 await new Promise(r=>setTimeout(r,2400));assert.equal((await sample(false))[7],'clean');
 java.stdin.write('patch\n');await new Promise(r=>setTimeout(r,4500));assert.equal((await sample())[7],'tampered');
 await assert.rejects(()=>request(info.port,crypto.randomBytes(24).toString('hex'),process.pid));
 const nonce=crypto.randomBytes(24).toString('hex');await new Promise(r=>setTimeout(r,200));const reply=await request(info.port,nonce,pid);assert.throws(()=>verify(reply,info,crypto.randomBytes(24).toString('hex')));
 java.stdin.write('quit\n');await new Promise(r=>guardian.once('exit',r));
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:true,evidence,checks:['clean code','JIT-like private executable memory','ambiguous matching process withheld','unique process recovery','actual native code patch','wrong process','nonce replay','exit cleanup']},null,2));
 await fs.writeFile(path.join(output,'signed-fixtures.json'),JSON.stringify(signedFixtures,null,2));
 console.log('PASS: clean baseline, JIT-like memory, ambiguous process, recovery, repeated native patch, wrong PID, nonce replay, game-exit cleanup');
} finally {java.kill();guardian.kill();decoy?.kill();}
