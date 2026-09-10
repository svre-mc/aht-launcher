import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {minecraftJavaExecutable,preflightJava8Runtime} from '../src/forgeInstaller.js';
import {verifyRepairedJava} from '../src/runtimeRepair.js';
import {createLaunchAttempt,setLaunchRequirement} from '../src/launchDiagnostics.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const javaHome=process.env.AHT_TEST_JRE||process.env.JAVA_HOME;
if(process.platform!=='win32'||!javaHome)throw Error('Windows and an explicit AHT_TEST_JRE or JAVA_HOME are required');
const javaPath=path.join(javaHome,'bin/java.exe');
const javaw=await minecraftJavaExecutable(javaPath);
const gameDir=process.env.AHT_TEST_GAME_DIR||'C:/AHTDEV/Testing/Client';
const binary=process.env.AHT_TEST_PHOENIX||path.join(root,'build/native-guard/Phoenix Anti-cheat.exe');
const out=path.join(root,'build/native-guard-test');
const source=await fs.readFile(path.join(root,'desktop/main.js'),'utf8');
const functionSource=source.slice(source.indexOf('async function publishCompletedUpdatePreparation('),source.indexOf('function launchPreparationKey('));
const runtime={usable:true,path:javaPath,vendor:'Temurin',version:'1.8.0_504'};
const config={instanceDir:gameDir,minecraftLauncher:{javaPath,memoryMb:4096}};
const context={
  clearLaunchPreparationResources(){},developerClientBypassAllowed:()=>true,
  resolveMinecraftLauncherRoute:async()=>({kind:'curseforge'}),java8RuntimeStatus:async()=>runtime,
  selectPreparedMinecraftLauncherProfile:async value=>value,verifyRepairedJava,minecraftJavaExecutable,
  DEFAULT_MINECRAFT_MEMORY_MB:4096,preflightJava8Runtime,
  createLaunchDiagnosticAttempt:createLaunchAttempt,setLaunchRequirement,
  createLaunchPreparationMutationMonitor:async()=>null,confirmLaunchPreparationMutationMonitor:async()=>{},
  launchPreparationCache:new Map(),persistPreparedLaunchEntry:async()=>{},invalidateLaunchPreparation(){},Date
};
vm.createContext(context);vm.runInContext(functionSource+'\nglobalThis.finalize=publishCompletedUpdatePreparation;',context);
const prepared=await context.finalize({target:{id:'stable',name:'A Hard Time'},config,launcherConfig:config,
  latest:{version:'2.8.659'},installed:{version:'2.8.659'},integrity:{valid:true,counts:{}},
  minecraftProfile:{profileName:'A Hard Time',javaPath:javaw,javaRuntime:runtime}});
const configured=prepared.launcherConfig.minecraftLauncher.javaPath;
const result={profileExecutable:path.basename(javaw),phoenixExpectedExecutable:path.basename(configured)};
let game,guard;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function request(port,text){return new Promise((resolve,reject)=>{
  const s=net.connect({host:'127.0.0.1',port});let body='';s.setTimeout(3000,()=>s.destroy(Error('timeout')));
  s.on('connect',()=>s.write(text+'\n'));s.on('error',reject);
  s.on('data',data=>{body+=data;if(body.length>6144)s.destroy(Error('oversize'));if(body.includes('\n')){s.destroy();try{resolve(JSON.parse(body));}catch(e){reject(e);}}});
  s.on('end',()=>{if(!body.includes('\n'))reject(Error('helper-no-response'));});
});}
try {
  execFileSync(path.join(process.env.JAVA_HOME||'C:/AHTDEV/Toolchains/Java-8','bin/javac.exe'),['-d',out,path.join(root,'native-guard/test/JavaRuntimeFixture.java')],{windowsHide:true});
  game=spawn(javaw,['-XX:+DisableAttachMechanism','-Dminecraft.applet.TargetDirectory='+gameDir,'-cp',out,'JavaRuntimeFixture'],{windowsHide:true,stdio:'ignore'});
  guard=spawn(binary,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const ready=new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>reject(Error('helper-startup-timeout')),8000);
    guard.on('error',reject);guard.stdout.on('data',data=>{text+=data;if(text.includes('\n')){clearTimeout(timeout);try{resolve(JSON.parse(text.split('\n')[0]));}catch(e){reject(e);}}});});
  guard.stdin.end(JSON.stringify({gameDir,javaPath:configured,launcherPid:process.pid,launcherSessionId:'a'.repeat(32)})+'\n');
  const info=await ready;await pause(4700);
  const live=await request(info.port,info.sessionKey+'|INFO');result.gameBound=live.gamePid===game.pid;
  const nonce=crypto.randomBytes(24).toString('hex');
  try {
    const response=await request(info.port,nonce+'|'+game.pid);
    const payload=Buffer.from(response.payload,'base64url');const fields=payload.toString().split('\n');
    assert(crypto.verify('sha256',payload,crypto.createPublicKey({format:'jwk',key:{kty:'RSA',n:response.modulus,e:response.exponent}}),Buffer.from(response.signature,'base64url')));
    assert.equal(fields[1],nonce);assert.equal(fields[2],info.keyHash);assert.equal(fields[3],String(game.pid));result.measurement=fields[7];
  } catch(error){result.measurement=error.message;}
  result.status=result.gameBound&&result.measurement==='clean'?'PASSED':'REPRODUCED';
  if(process.env.AHT_JAVA_PATH_RESULT)await fs.writeFile(process.env.AHT_JAVA_PATH_RESULT,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  if(process.argv.includes('--expect-failure'))assert.equal(result.status,'REPRODUCED');
  else {assert.equal(configured,javaw);assert.equal(result.status,'PASSED');}
} finally {game?.kill();guard?.kill();}
