import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'win32') { console.log('SKIP: Windows bootstrap'); process.exit(0); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root = await fs.mkdtemp(path.join(os.tmpdir(),'aht-update-bootstrap-'));
const bootstrap = path.join(root,'launcher-update-bootstrap.ps1');
const helper = path.join(root,'helper with spaces.ps1');
const payload = path.join(root,"payload's [test].json");
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function runBootstrap(args) {
  const log=path.join(root,'bootstrap.log');
  const fd=fsSync.openSync(log,'w');
  return new Promise((resolve,reject)=>{
    const child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',bootstrap,...args],{windowsHide:true,stdio:['ignore',fd,fd]});
    fsSync.closeSync(fd);
    const timer=setTimeout(()=>{child.kill();reject(Error('Bootstrap timeout'));},5000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{
      clearTimeout(timer);
      if(code===0)resolve();
      else {const error=Error('Bootstrap rejected handoff');error.code=code;error.stderr=fsSync.readFileSync(log,'utf8');reject(error);}
    });
  });
}
const content = `param([string]$PayloadPath,[string]$ExpectedPayloadSha256,[string]$ExpectedHelperSha256)
Start-Sleep -Milliseconds 1500
$self = Get-Process -Id $PID
@{ policy=$env:PSExecutionPolicyPreference; window=[long]$self.MainWindowHandle; payloadHash=$ExpectedPayloadSha256; helperHash=$ExpectedHelperSha256 } | ConvertTo-Json -Compress | Set-Content -LiteralPath ($PayloadPath+'.result')
`;
try {
  await fs.copyFile(path.join(repo,'desktop/launcher-update-bootstrap.ps1'),bootstrap);
  await fs.writeFile(helper,content);
  await fs.writeFile(payload,'{}');
  const args=['-PayloadPath',payload,'-ExpectedPayloadSha256',sha('{}'),'-HelperPath',helper,'-ExpectedHelperSha256',sha(content)];
  await runBootstrap(args);
  assert.equal(await fs.stat(payload+'.result').then(()=>true,()=>false),false,'Bootstrap should finish before the helper');
  const deadline=Date.now()+8000;
  let result;
  while(Date.now()<deadline) {
    result=await fs.readFile(payload+'.result','utf8').then(JSON.parse,()=>null);
    if(result)break;
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(result,'Helper must survive bootstrap exit');
  assert.equal(result.policy,'RemoteSigned');
  assert.equal(result.window,0,'No updater console window');
  assert.equal(result.payloadHash,sha('{}'));
  assert.equal(result.helperHash,sha(content));
  await fs.writeFile(payload,'[]');
  await assert.rejects(runBootstrap(args), e=>e.code===1 && /hash mismatch/.test(e.stderr));
  await fs.writeFile(payload,'{}');
  await fs.appendFile(helper,'\n# changed');
  await assert.rejects(runBootstrap(args), e=>e.code===1 && /hash mismatch/.test(e.stderr));
  await fs.writeFile(helper,content);
  const linked=path.join(root,'linked');
  const actual=path.join(root,'actual');
  await fs.mkdir(actual);
  await fs.copyFile(helper,path.join(actual,'helper.ps1'));
  await fs.symlink(actual,linked,'junction');
  const reparseArgs=[...args];reparseArgs[5]=path.join(linked,'helper.ps1');
  await assert.rejects(runBootstrap(reparseArgs), e=>e.code===1 && /reparse point/.test(e.stderr));
  await fs.unlink(linked);
  console.log(JSON.stringify({ok:true,independentHelper:true,noConsoleWindow:true,remoteSigned:true,payloadTamperRejected:true,helperTamperRejected:true,reparseRejected:true}));
} finally {
  const resolved=path.resolve(root);
  if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe test cleanup');
  await fs.rm(resolved,{recursive:true,force:true});
}
