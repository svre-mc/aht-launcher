#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const child = spawn(command, args, {
      ...options,
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

export async function uploadR2Plan({ planPath, bucket, dryRun = false }) {
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
  const uploaded = [];
  for (const item of plan.uploads || []) {
    if (!item.rel || !item.file) {
      throw new Error(`Invalid upload plan item: ${JSON.stringify(item)}`);
    }
    const file = path.isAbsolute(item.file)
      ? item.file
      : path.resolve(path.dirname(resolvedPlanPath), item.file);
    const target = `${bucket}/${item.rel}`;
    if (dryRun) {
      console.log(`[dry-run] ${file} -> ${target}`);
      uploaded.push({ rel: item.rel, file, dryRun: true });
      continue;
    }
    console.log(`Uploading ${item.rel}`);
    await run(npxCommand(), [
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
    uploaded.push({ rel: item.rel, file });
  }
  return { ok: true, bucket, uploaded };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  uploadR2Plan({
    planPath: args.plan,
    bucket: args.bucket || process.env.AHT_R2_BUCKET,
    dryRun: Boolean(args['dry-run'])
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
