import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {ensureNativeGuard} from '../src/nativeGuard.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const gameDir=path.join(root,'build/native-guard-test/manager');
const runtimeDir=path.join(root,'build/native-guard');
function info(port){return new Promise((resolve,reject)=>{let text='';const s=net.connect({host:'127.0.0.1',port});s.setTimeout(2000,()=>s.destroy(new Error('timeout')));s.on('error',reject);s.on('connect',()=>s.write('INFO\n'));s.on('data',data=>{text+=data;if(text.includes('\n')){s.destroy();resolve(JSON.parse(text));}});s.on('end',()=>{if(!text)reject(new Error('empty reply'));});});}
let pid;
try {
  const [first,second]=await Promise.all([ensureNativeGuard({gameDir,runtimeDir}),ensureNativeGuard({gameDir,runtimeDir})]);
  assert.deepEqual(first,second);pid=(await info(first.port)).guardPid;
  assert.deepEqual(await ensureNativeGuard({gameDir,runtimeDir}),first);
  // A fresh module instance models a launcher restart while the helper is still alive.
  const restarted=await import('../src/nativeGuard.js?restart-test');
  assert.deepEqual(await restarted.ensureNativeGuard({gameDir,runtimeDir}),first);
  process.kill(pid);pid=null;await new Promise(r=>setTimeout(r,300));
  const replacement=await ensureNativeGuard({gameDir,runtimeDir});pid=(await info(replacement.port)).guardPid;
  assert.notEqual(replacement.keyHash,first.keyHash,'A dead helper must acquire a new session key');
  const invalidDir=path.join(gameDir,'bad-runtime');await fs.mkdir(invalidDir,{recursive:true});
  await fs.copyFile(path.join(runtimeDir,'AHT Runtime Guard.exe'),path.join(invalidDir,'AHT Runtime Guard.exe'));
  await fs.writeFile(path.join(invalidDir,'manifest.json'),JSON.stringify({file:'AHT Runtime Guard.exe',sha256:'0'.repeat(64)}));
  await assert.rejects(()=>ensureNativeGuard({gameDir,runtimeDir:invalidDir}),/failed verification/);
  assert.equal(await ensureNativeGuard({gameDir,runtimeDir,platform:'linux'}),null);
  await fs.rm(path.join(invalidDir,'AHT Runtime Guard.exe'));await fs.rm(path.join(invalidDir,'manifest.json'));await fs.rmdir(invalidDir);
  await fs.writeFile(path.join(gameDir,'results.json'),JSON.stringify({passed:true,checks:['concurrent requests share one helper','same-session reuse','reuse after launcher restart','changed binary hash rejected','non-Windows behavior preserved']},null,2));
  console.log('PASS: guard startup, concurrent/restarted launcher reuse, hash rejection, platform boundary');
}finally{if(pid)process.kill(pid);}
