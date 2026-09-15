import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { uploadR2Plan } from './upload-r2-plan.mjs';

const [directory, bucket] = process.argv.slice(2);
if (!directory || !bucket) throw new Error('Usage: sync-r2-directory.mjs <release-directory> <bucket>');
const root = path.resolve(directory);
const uploads = [];
async function visit(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release upload directory must not contain symbolic links.');
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile()) uploads.push({ rel: path.relative(root, file).replaceAll(path.sep, '/'), file,
      contentType: ({ '.json': 'application/json', '.zip': 'application/zip', '.jar': 'application/java-archive',
        '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8' })[path.extname(file)] || 'application/octet-stream' });
  }
}
await visit(root);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-r2-plan-'));
const planPath = path.join(scratch, 'plan.json');
try {
  await fs.writeFile(planPath, JSON.stringify({ uploads }));
  await uploadR2Plan({ planPath, bucket });
} finally {
  await fs.unlink(planPath).catch(() => {});
  await fs.rmdir(scratch);
}
