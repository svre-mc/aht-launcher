import assert from 'node:assert/strict';
import worker from '../cloudflare/curseforge-proxy-worker.js';
const key='launcher/anticheat/win32-x64/Phoenix-Anti-cheat-Windows-x64-1.1.3.exe';
let cacheReads=0,cacheWrites=0,originReads=0;
Object.defineProperty(globalThis,'caches',{configurable:true,value:{default:{
  async match(){cacheReads++;return new Response('old!',{headers:{'Cache-Control':'public, max-age=31536000, immutable','Content-Length':'4'}});},
  async put(){cacheWrites++;}
}}});
const object=()=>({size:4,body:new Response('new!').body,httpMetadata:{},httpEtag:'"new"'});
const env={AHT_RELEASES:{async get(){originReads++;return object();},async head(){originReads++;return object();}},AHT_PLAYER_API_RATE_LIMITER:{async limit(){return {success:true};}}};
for(const method of ['GET','HEAD']){
  const response=await worker.fetch(new Request('https://worker.test/'+key,{method}),env,{});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(await response.text(),method==='GET'?'new!':'');
}
assert.equal(cacheReads,0);assert.equal(cacheWrites,0);assert.equal(originReads,2);
console.log(JSON.stringify({passed:true,stalePhoenixCacheBypassed:true,originHashCanBeVerified:true}));
