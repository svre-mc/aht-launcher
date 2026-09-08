import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { headR2ObjectDirect, uploadR2ObjectDirect } from '../src/r2DirectUpload.js';

const [planFile, resultFile] = process.argv.slice(2);
const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
if (result.candidateId !== plan.candidateId || result.version !== plan.version
    || result.zip?.path !== result.latest?.zip?.path || (!plan.zipKey.startsWith('packs/') && !plan.zipKey.startsWith('ptb/packs/'))) {
  throw new Error('Verified rebuild does not match the publication plan');
}
const file = plan.outputZip;
const stat = await fs.stat(file);
const hash = createHash('sha256');
for await (const bytes of createReadStream(file)) hash.update(bytes);
const sha256 = hash.digest('hex');
if (sha256 !== result.zip.sha256 || stat.size !== result.zip.size) throw new Error('Rebuilt ZIP changed after validation');
const options = {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.AHT_R2_BUCKET || 'ahtlauncher',
  key: plan.zipKey
};
const before = await headR2ObjectDirect(options);
if (before.exists && (before.sha256 !== sha256 || before.size !== stat.size)) throw new Error('Immutable ZIP already exists with different content');
if (!before.exists) {
  let last = -10;
  await uploadR2ObjectDirect({ ...options, file, sha256, contentType: 'application/zip', onProgress: p => {
    if (p.percent >= last + 10) { last = p.percent; console.log(`Full ZIP upload: ${p.percent}%`); }
  } });
}
const after = await headR2ObjectDirect(options);
if (after.sha256 !== sha256 || after.size !== stat.size) throw new Error('R2 ZIP readback did not match the verified rebuild');
console.log(JSON.stringify({ verified: true, key: plan.zipKey, sha256, size: stat.size, method: 'direct-multipart' }));
