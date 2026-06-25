#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanLauncherVersion } from '../src/githubActions.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = cleanLauncherVersion(process.argv[2] || process.env.AHT_LAUNCHER_VERSION || '');

if (!version) {
  throw new Error('Usage: node scripts/set-package-version.mjs <version>');
}

async function updateJson(file, updater) {
  const fullPath = path.join(repoRoot, file);
  const json = JSON.parse(await fsp.readFile(fullPath, 'utf8'));
  updater(json);
  await fsp.writeFile(fullPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
}

await updateJson('package.json', (json) => {
  json.version = version;
});

await updateJson('package-lock.json', (json) => {
  json.version = version;
  if (json.packages?.['']) {
    json.packages[''].version = version;
  }
});

console.log(`Launcher package version set to ${version}`);
