#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withR2StorageBudget } from '../src/r2StorageBudget.js';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

function npxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const shell = Object.hasOwn(options, 'shell')
      ? options.shell
      : process.platform === 'win32' && /\.cmd$/i.test(command);
    const child = spawn(command, args, {
      ...options,
      shell,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}\n${stderr || stdout}`.trim()));
    });
  });
}

export async function uploadR2Plan({ planPath, bucket, dryRun = false, checkOnly = false, client, runImpl = run }) {
  if (!planPath) throw new Error('Upload plan path is required.');
  if (!bucket) throw new Error('R2 bucket is required.');
  if (!dryRun && !process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error('CLOUDFLARE_API_TOKEN is required to publish launcher updates from GitHub Actions.');
  }
  if (!dryRun && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is required to publish launcher updates from GitHub Actions.');
  }

  const resolvedPlanPath = path.resolve(planPath);
  const plan = await readJson(resolvedPlanPath);
  if (!Array.isArray(plan.uploads) || !plan.uploads.length) throw new Error('Upload plan is empty or invalid.');
  const items = [];
  const keys = new Set();
  for (const item of plan.uploads) {
    if (typeof item.rel !== 'string' || !item.rel || typeof item.file !== 'string' || !item.file
        || item.rel.startsWith('/') || item.rel.includes('\\') || item.rel.includes('\0')
        || item.rel.split('/').includes('..') || keys.has(item.rel)) throw new Error('Invalid or duplicate upload plan item.');
    keys.add(item.rel);
    const file = path.resolve(path.dirname(resolvedPlanPath), item.file);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Upload plan must contain regular files.');
    items.push({ ...item, file, size: stat.size });
  }
  // Public pointers always come after their assets, regardless of plan order.
  items.sort((a, b) => Number(/(?:^|\/)latest\.json$/.test(a.rel)) - Number(/(?:^|\/)latest\.json$/.test(b.rel)));
  const uploaded = [];
  const performUpload = async () => {
    if (checkOnly) return { ok: true, bucket, checked: true };
    for (const [index, item] of items.entries()) {
      const file = item.file;
      const target = `${bucket}/${item.rel}`;
      if (dryRun) {
        console.log(`[dry-run] ${file} -> ${target}`);
        uploaded.push({ rel: item.rel, file, dryRun: true });
        continue;
      }
      console.log(`Uploading ${item.rel}`);
      // Re-inventory immediately before each write, while retaining the global
      // lock for this entire plan. Include every remaining incoming object.
      await withR2StorageBudget({ client, bucket, uploads: items.slice(index).map(row => ({ key: row.rel, size: row.size })) }, async () => {
        if ((await fsp.stat(file)).size !== item.size) throw new Error('Upload file changed after the storage preflight.');
        await runImpl(npxCommand(), [
          '--yes',
          'wrangler',
          'r2',
          'object',
          'put',
          target,
          `--file=${file}`,
          `--content-type=${item.contentType || 'application/octet-stream'}`,
          '--remote'
        ], {
          env: process.env
        });
      });
      uploaded.push({ rel: item.rel, file });
    }
    return { ok: true, bucket, uploaded };
  };
  // An offline dry run previews paths only; it is never an upload authorization.
  if (dryRun) return performUpload();
  return withR2StorageBudget({ client, bucket, ...(checkOnly ? { archiveDir: '' } : {}), uploads: items.map(item => ({ key: item.rel, size: item.size })),
    onProjection: projection => console.log(JSON.stringify({ storagePreflight: projection })) }, performUpload);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  uploadR2Plan({
    planPath: args.plan,
    bucket: args.bucket || process.env.AHT_R2_BUCKET,
    dryRun: Boolean(args['dry-run']),
    checkOnly: Boolean(args['check-only'])
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
