import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ensureModDirectorIcon} from '../src/modDirectorIcon.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'aht-icon-'));
try {
 assert.equal(await ensureModDirectorIcon(root),false);
 await fs.mkdir(path.join(root,'config','mod-director'),{recursive:true});
 await fs.mkdir(path.join(root,'config','itlt'));
 const config=path.join(root,'config','mod-director','modpack.json');
 const target=path.join(root,'config','itlt','RLCraft_Dregora_Logo_FINAL.png');
 await fs.writeFile(config,JSON.stringify({icon:{path:'config/itlt/RLCraft_Dregora_Logo_FINAL.png'}}));
 const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
 await fs.writeFile(path.join(root,'config','itlt','icon256x256.png'),bytes);
 assert.equal(await ensureModDirectorIcon(root),true);
 assert.deepEqual(await fs.readFile(target),bytes);
 await fs.writeFile(target,'preserve-existing-art');
 assert.equal(await ensureModDirectorIcon(root),false);
 assert.equal(await fs.readFile(target,'utf8'),'preserve-existing-art');
 await fs.writeFile(config,JSON.stringify({icon:{path:'custom/logo.png'}}));
 assert.equal(await ensureModDirectorIcon(root),false);
 console.log('Missing legacy logo repair and preservation checks passed.');
} finally {await fs.rm(root,{recursive:true,force:true});}
