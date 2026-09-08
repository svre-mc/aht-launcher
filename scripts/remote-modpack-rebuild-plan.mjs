#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseMatchesTarget, releaseTarget, releaseTargetObjectKey } from '../src/releaseTargets.js';
import { CLIENT_DELTA_FORMAT, CLIENT_MANIFEST_FORMAT } from '../src/clientPackFormat.js';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) args[item.slice(2)] = true;
    else {
      args[item.slice(2)] = next;
      index += 1;
    }
  }
  return args;
}

function safeObjectKey(value = '', label = 'object key') {
  const key = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!key || key.split('/').includes('..') || !/^[A-Za-z0-9._+\/-]+$/.test(key)) {
    throw new Error(`${label} is invalid.`);
  }
  return key;
}

function relativeArtifactPath(value = '', label = 'artifact path') {
  const rel = safeObjectKey(value, label);
  if (rel.startsWith('ptb/') || rel.startsWith('staging/')) throw new Error(`${label} must be target-relative.`);
  return rel;
}

function outputLine(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  return fs.appendFile(file, `${name}=${String(value)}\n`, 'utf8');
}

export async function remoteModpackRebuildPlan({
  target: targetValue,
  candidateLatestPath,
  baselineLatestPath,
  candidateKey,
  resultKey,
  candidateId
} = {}) {
  const target = releaseTarget(targetValue);
  const [candidate, baseline] = await Promise.all([
    fs.readFile(candidateLatestPath, 'utf8').then(JSON.parse),
    fs.readFile(baselineLatestPath, 'utf8').then(JSON.parse)
  ]);
  assertReleaseMatchesTarget(candidate, target.id);
  assertReleaseMatchesTarget(baseline, target.id);
  if (candidate.delta?.format !== CLIENT_DELTA_FORMAT
      || candidate.clientManifest?.format !== CLIENT_MANIFEST_FORMAT
      || String(candidate.delta.fromVersion || '') !== String(baseline.version || '')
      || String(candidate.delta.toVersion || '') !== String(candidate.version || '')) {
    throw new Error('Candidate changed-files metadata does not advance the live release.');
  }
  if (String(candidate.rebuild?.candidateId || '') !== String(candidateId || '')) {
    throw new Error('Candidate id does not match the staged release.');
  }
  const cleanCandidateKey = safeObjectKey(candidateKey, 'candidate key');
  const cleanResultKey = safeObjectKey(resultKey, 'result key');
  const expectedRoot = `staging/modpack-rebuild/${target.id}/${candidate.version}/${candidateId}/`;
  if (cleanCandidateKey !== `${expectedRoot}candidate.json` || cleanResultKey !== `${expectedRoot}result.json`) {
    throw new Error('Candidate and result keys are outside the versioned rebuild transaction.');
  }
  const zipRelative = relativeArtifactPath(candidate.zip?.path, 'candidate ZIP path');
  const deltaRelative = relativeArtifactPath(candidate.delta?.path, 'candidate delta path');
  const manifestRelative = relativeArtifactPath(candidate.clientManifest?.path, 'candidate manifest path');
  const baselineZipRelative = relativeArtifactPath(baseline.zip?.path, 'baseline ZIP path');
  const plan = {
    target: target.id,
    packId: target.packId,
    channel: target.channel,
    version: candidate.version,
    fromVersion: baseline.version,
    candidateId,
    candidateKey: cleanCandidateKey,
    resultKey: cleanResultKey,
    baselineLatestKey: target.feedPath,
    baselineZipKey: releaseTargetObjectKey(baselineZipRelative, target.id),
    deltaKey: releaseTargetObjectKey(deltaRelative, target.id),
    manifestKey: releaseTargetObjectKey(manifestRelative, target.id),
    zipKey: releaseTargetObjectKey(zipRelative, target.id),
    outputZip: path.basename(zipRelative)
  };
  return plan;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  remoteModpackRebuildPlan({
    target: args.target,
    candidateLatestPath: args.candidate,
    baselineLatestPath: args.baseline,
    candidateKey: args['candidate-key'],
    resultKey: args['result-key'],
    candidateId: args['candidate-id']
  }).then(async (plan) => {
    for (const [name, value] of Object.entries({
      baseline_latest_key: plan.baselineLatestKey,
      baseline_zip_key: plan.baselineZipKey,
      delta_key: plan.deltaKey,
      manifest_key: plan.manifestKey,
      zip_key: plan.zipKey,
      output_zip: plan.outputZip
    })) await outputLine(name, value);
    await fs.writeFile(args.output || 'remote-modpack-rebuild-plan.json', `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, target: plan.target, fromVersion: plan.fromVersion, version: plan.version }));
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
