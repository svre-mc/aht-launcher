#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLauncherReleaseAdvance,
  validateLauncherUpdateManifest
} from '../src/launcherUpdateManifest.js';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const next = argv[index + 1];
    args[item.slice(2)] = !next || next.startsWith('--') ? true : next;
    if (args[item.slice(2)] !== true) index += 1;
  }
  return args;
}

function requireHttps(value = '', label = 'URL') {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  return url.toString();
}

export async function checkLauncherReleaseImmutability({ candidatePath, latestUrl, fetchImpl = fetch }) {
  const requestedCandidate = String(candidatePath || '').trim();
  if (!requestedCandidate) {
    throw new Error('A candidate launcher manifest is required. Pass --candidate <launcher/latest.json>.');
  }
  const resolvedCandidate = path.resolve(requestedCandidate);
  const candidate = JSON.parse(await fsp.readFile(resolvedCandidate, 'utf8'));
  const candidateValidation = validateLauncherUpdateManifest(candidate, {
    latestUrl,
    requireTrackedDownloads: true,
    requireStagedWindows: true
  });
  if (!candidateValidation.ok) {
    throw new Error(`Candidate launcher manifest is invalid: ${candidateValidation.errors.join('; ')}`);
  }

  const publicLatestUrl = requireHttps(latestUrl, 'Launcher latest URL');
  const response = await fetchImpl(`${publicLatestUrl}${publicLatestUrl.includes('?') ? '&' : '?'}immutability=${Date.now()}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 404) {
    return { ok: true, firstRelease: true, candidateVersion: candidate.version, liveVersion: null };
  }
  if (!response.ok) {
    throw new Error(`Could not prove launcher release immutability: ${response.status} ${response.statusText}`);
  }
  const live = await response.json();
  const liveValidation = validateLauncherUpdateManifest(live, {
    latestUrl: publicLatestUrl,
    requireStagedWindows: true
  });
  if (!liveValidation.ok) {
    throw new Error(`Live launcher manifest is invalid: ${liveValidation.errors.join('; ')}`);
  }
  return assertLauncherReleaseAdvance(candidate, live);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  checkLauncherReleaseImmutability({
    candidatePath: args.candidate,
    latestUrl: args['latest-url'] || process.env.AHT_LAUNCHER_UPDATE_URL || ''
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
