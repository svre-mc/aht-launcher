import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'build/native-guard');await fs.mkdir(out,{recursive:true});
const compiler=path.join(process.env.SystemRoot||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const binary=path.join(out,'AHT Runtime Guard.exe');
await fs.copyFile(path.join(root,'native-guard/NOTICE.txt'),path.join(out,'NOTICE.txt'));
execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/debug-','/out:'+binary,
 '/reference:System.Management.dll','/reference:System.Web.Extensions.dll',path.join(root,'native-guard/Guard.cs')],{stdio:'pipe',windowsHide:true});
const bytes=await fs.readFile(binary);const manifest={schema:1,protocol:'AHT-GUARD-1',file:path.basename(binary),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest));
