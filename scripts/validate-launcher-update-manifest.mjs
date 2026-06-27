#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_DOWNLOAD_KEYS,
  REQUIRED_PLATFORM_KEYS,
  validateLauncherUpdateManifest
} from '../src/launcherUpdateManifest.js';

export { REQUIRED_DOWNLOAD_KEYS, REQUIRED_PLATFORM_KEYS, validateLauncherUpdateManifest };

function parseArgs(argv = process.argv.slice(2)) {
  const args = { manifestPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--') && !args.manifestPath) {
      args.manifestPath = item;
      continue;
    }
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

export async function validateLauncherUpdateManifestFile(manifestPath, options = {}) {
  const resolved = path.resolve(String(manifestPath || ''));
  if (!resolved) {
    throw new Error('Manifest path is required.');
  }
  const manifest = JSON.parse(await fsp.readFile(resolved, 'utf8'));
  const result = validateLauncherUpdateManifest(manifest, options);
  if (!result.ok) {
    throw new Error(`Invalid launcher update manifest ${resolved}:\n${result.errors.map((item) => `- ${item}`).join('\n')}`);
  }
  return { ...result, manifest, manifestPath: resolved };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  validateLauncherUpdateManifestFile(args.manifestPath, {
    latestUrl: args['latest-url'] || process.env.AHT_LAUNCHER_UPDATE_URL || ''
  }).then((result) => {
    console.log(JSON.stringify({
      ok: true,
      manifestPath: result.manifestPath,
      version: result.manifest.version,
      downloads: REQUIRED_DOWNLOAD_KEYS
    }, null, 2));
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
