const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
async function main(){
  if(!process.versions.electron){
    const profile=await fs.mkdtemp(path.join(os.tmpdir(),'aht-phoenix-cache-'));
    const child=spawn(require('electron'),[__filename],{env:{...process.env,AHT_PHOENIX_CACHE_PROFILE:profile},windowsHide:true,stdio:'inherit'});
    const timeout=setTimeout(()=>child.kill(),45000);
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timeout);
    assert.equal(code,0);return;
  }
  const {app,net}=require('electron');
  app.setPath('userData',process.env.AHT_PHOENIX_CACHE_PROFILE);await app.whenReady();
  let body='old!',reads=0;const server=http.createServer((request,response)=>{
    reads++;response.setHeader('Cache-Control',body==='old!'?'public, max-age=31536000, immutable':'private, no-store');response.end(body);
  });
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const fileName='Phoenix-Anti-cheat-Windows-x64-9.9.9.exe';
    const releasePath='launcher/anticheat/win32-x64/'+fileName;
    const url='http://127.0.0.1:'+server.address().port+'/'+releasePath;
    const fetchImpl=(url,options={})=>net.fetch(url,{credentials:'omit',...options,bypassCustomProtocolHandlers:true});
    assert.equal(await(await fetchImpl(url)).text(),'old!');body='new!';
    assert.equal(await(await fetchImpl(url)).text(),'old!','Reproduce Chromium retaining the old immutable response');
    assert.equal(reads,1);
    const {installPhoenixAntiCheat}=await import(pathToFileURL(path.join(__dirname,'../src/nativeGuard.js')));
    const result=await installPhoenixAntiCheat({installDir:path.join(app.getPath('userData'),'phoenix'),fetchImpl,platform:'win32',allowInsecureLocalhost:true,
      descriptor:{product:'phoenix-anticheat',platform:'win32-x64',version:'9.9.9',protocol:'AHT-GUARD-1',fileName,path:releasePath,url,size:4,sha256:crypto.createHash('sha256').update('new!').digest('hex')}});
    assert.equal(result.valid,true);assert.equal(reads,2);
    console.log(JSON.stringify({passed:true,staleChromiumCacheReproduced:true,actualInstallerFetchesCorrectedBytes:true}));
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
  app.exit(0);
}
main().catch(error=>{console.error(error);if(process.versions.electron)require('electron').app.exit(1);else process.exitCode=1;});
