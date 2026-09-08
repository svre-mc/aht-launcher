#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanLauncherReleaseVersion,
  launcherPackageVersionForRelease
} from '../src/launcherVersion.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseVersion = cleanLauncherReleaseVersion(process.argv[2] || process.env.AHT_LAUNCHER_VERSION || '');
const packageVersion = launcherPackageVersionForRelease(releaseVersion);

if (!releaseVersion) {
  throw new Error('Usage: node scripts/set-package-version.mjs <version>');
}

async function updateJson(file, updater) {
  const fullPath = path.join(repoRoot, file);
  const json = JSON.parse(await fsp.readFile(fullPath, 'utf8'));
  updater(json);
  await fsp.writeFile(fullPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
}

await updateJson('package.json', (json) => {
  json.version = packageVersion;
  json.ahtLauncherVersion = releaseVersion;
});

await updateJson('package-lock.json', (json) => {
  json.version = packageVersion;
  if (json.packages?.['']) {
    json.packages[''].version = packageVersion;
  }
});

console.log(`Launcher release version set to ${releaseVersion} (npm package version ${packageVersion})`);
