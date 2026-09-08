import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
const sessions=new Map();
const pending=new Map();
export function validateNativeGuardDescriptor(info) {
  if(info?.protocol!=='AHT-GUARD-1' || !Number.isInteger(info.port) || info.port<1 || info.port>65535
    || !/^[a-f0-9]{64}$/.test(info.keyHash||'') || !/^[A-Za-z0-9_-]{342}$/.test(info.modulus||'') || info.exponent!=='AQAB')throw new Error('Invalid runtime guard identity');
  const hash=crypto.createHash('sha256').update(info.modulus+'.'+info.exponent).digest('hex');
  if(hash!==info.keyHash)throw new Error('Runtime guard key mismatch');
  return {protocol:info.protocol,port:info.port,keyHash:info.keyHash,modulus:info.modulus,exponent:info.exponent};
}
function readInfo(port) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port});let text='';let done=false;
    const finish=(error,value)=>{if(done)return;done=true;socket.destroy();error?reject(error):resolve(value);};
    socket.setTimeout(1500,()=>finish(new Error('Runtime guard unavailable')));
    socket.on('error',e=>finish(e));socket.on('connect',()=>socket.write('INFO\n'));
    socket.on('data',data=>{text+=data;if(text.length>4096)return finish(new Error('Runtime guard response too large'));
      if(text.includes('\n')){try{finish(null,validateNativeGuardDescriptor(JSON.parse(text)));}catch(e){finish(e);}}});
    socket.on('end',()=>finish(new Error('Runtime guard closed')));
  });
}
export async function ensureNativeGuard({gameDir,javaPath='',runtimeDir,platform=process.platform}) {
  if(platform!=='win32')return null;
  const directory=path.resolve(gameDir);if(pending.has(directory))return pending.get(directory);
  const operation=(async()=>{
    const manifest=JSON.parse(await fs.readFile(path.join(runtimeDir,'manifest.json'),'utf8'));
    if(manifest.file!=='AHT Runtime Guard.exe' || !/^[a-f0-9]{64}$/.test(manifest.sha256||''))throw new Error('Runtime guard manifest invalid');
    const binary=path.join(runtimeDir,manifest.file);const hash=crypto.createHash('sha256').update(await fs.readFile(binary)).digest('hex');
    if(hash!==manifest.sha256)throw new Error('Runtime guard file failed verification');
    const stateFile=path.join(directory,'.aht-launcher','native-guard.json');
    let cached=sessions.get(directory);
    if(!cached){try{cached=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch{}}
    if(cached?.binaryHash===hash) {
      try {const live=await readInfo(validateNativeGuardDescriptor(cached).port);if(live.keyHash===cached.keyHash){sessions.set(directory,cached);return live;}}catch{}
    }
    const child=spawn(binary,[],{windowsHide:true,stdio:['pipe','pipe','pipe'],detached:true});
    try {
      const info=await new Promise((resolve,reject)=>{
        let text='';const timer=setTimeout(()=>reject(new Error('Runtime guard startup timed out')),8000);
        child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Runtime guard stopped during startup'));});
        child.stdout.on('data',data=>{text+=data;if(text.length>4096){clearTimeout(timer);return reject(new Error('Runtime guard startup response too large'));}
          if(text.includes('\n')){clearTimeout(timer);try{resolve(validateNativeGuardDescriptor(JSON.parse(text)));}catch(e){reject(e);}}});
        child.stdin.on('error',reject);child.stdin.end(JSON.stringify({gameDir:directory,javaPath})+'\n');
      });
      const saved={...info,binaryHash:hash};await fs.mkdir(path.dirname(stateFile),{recursive:true});
      await fs.writeFile(stateFile+'.tmp',JSON.stringify(saved)+'\n',{mode:0o600});await fs.rename(stateFile+'.tmp',stateFile);
      sessions.set(directory,saved);child.stdout.destroy();child.stderr.destroy();child.unref();return info;
    }catch(error){child.kill();throw error;}
  })().finally(()=>pending.delete(directory));
  pending.set(directory,operation);return operation;
}
