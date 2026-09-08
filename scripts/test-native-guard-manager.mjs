import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {ensureNativeGuard} from '../src/nativeGuard.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const gameDir=path.join(root,'build/native-guard-test/manager');
const runtimeDir=path.join(root,'build/native-guard');
function info(port,sessionKey){return new Promise((resolve,reject)=>{let text='';const s=net.connect({host:'127.0.0.1',port});s.setTimeout(2000,()=>s.destroy(new Error('timeout')));s.on('error',reject);s.on('connect',()=>s.write(`${sessionKey}|INFO\n`));s.on('data',data=>{text+=data;if(text.includes('\n')){s.destroy();resolve(JSON.parse(text));}});s.on('end',()=>{if(!text)reject(new Error('empty reply'));});});}
let pid;
try {
  const legacyStateDir=path.join(gameDir,'.aht-launcher');await fs.mkdir(legacyStateDir,{recursive:true});
  const legacyStateFile=path.join(legacyStateDir,'native-guard.json');
  await fs.writeFile(legacyStateFile,JSON.stringify({sessionKey:'legacy-secret'}));
  await fs.writeFile(`${legacyStateFile}.tmp`,JSON.stringify({sessionKey:'legacy-temporary-secret'}));
  const options={gameDir,developmentRuntimeDir:runtimeDir,developerMode:true,launcherPid:process.pid,launcherSessionId:'1'.repeat(32)};
  const [first,second]=await Promise.all([ensureNativeGuard(options),ensureNativeGuard(options)]);
  assert.deepEqual(first,second);pid=(await info(first.port,first.sessionKey)).guardPid;
  await assert.rejects(()=>fs.access(legacyStateFile));await assert.rejects(()=>fs.access(`${legacyStateFile}.tmp`));
  assert.deepEqual(await ensureNativeGuard(options),first);
  // A fresh module instance with the same explicit process-session identity models a hot module reload.
  const restarted=await import('../src/nativeGuard.js?restart-test');
  assert.deepEqual(await restarted.ensureNativeGuard(options),first);
  process.kill(pid);pid=null;await new Promise(r=>setTimeout(r,300));
  const replacement=await ensureNativeGuard(options);pid=(await info(replacement.port,replacement.sessionKey)).guardPid;
  assert.notEqual(replacement.keyHash,first.keyHash,'A dead helper must acquire a new session key');
  const invalidDir=path.join(gameDir,'bad-runtime');await fs.mkdir(invalidDir,{recursive:true});
  const binaryName='Phoenix Anti-cheat.exe';
  const binary=await fs.readFile(path.join(runtimeDir,binaryName));
  await fs.writeFile(path.join(invalidDir,binaryName),binary);
  await fs.writeFile(path.join(invalidDir,'manifest.json'),JSON.stringify({product:'phoenix-anticheat',version:'1.0.0',protocol:'AHT-GUARD-1',file:binaryName,sha256:'0'.repeat(64),bytes:binary.length}));
  await assert.rejects(()=>ensureNativeGuard({...options,developmentRuntimeDir:invalidDir}),/required to play/);
  assert.equal(await ensureNativeGuard({...options,platform:'linux'}),null);
  await fs.rm(invalidDir,{recursive:true,force:true});
  await fs.writeFile(path.join(gameDir,'results.json'),JSON.stringify({passed:true,checks:['legacy descriptor removed','concurrent requests share one helper','same process-session reuse','explicit session identity survives module reload','changed binary hash rejected','non-Windows behavior preserved']},null,2));
  console.log('PASS: legacy descriptor cleanup, guard startup, same-session reuse, module reload, hash rejection, platform boundary');
}finally{if(pid)process.kill(pid);}
