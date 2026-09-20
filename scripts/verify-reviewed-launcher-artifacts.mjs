import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

export function verifyReviewedBuildProvenance(run, expectedCommit, expectedRepository) {
  assert.equal(run.status, 'completed', 'Reviewed build is not complete');
  assert.equal(run.conclusion, 'success', 'Reviewed build did not succeed');
  assert.equal(run.head_sha, expectedCommit, 'Reviewed build belongs to a different source commit');
  assert.equal(run.repository?.full_name, expectedRepository, 'Reviewed build belongs to a different repository');
  assert.equal(run.path, '.github/workflows/build-macos.yml', 'Reviewed build belongs to a different workflow');
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export async function verifyReviewedWindowsArtifacts(directory, version, pins) {
  for (const key of ['installer', 'updateZip', 'uninstaller', 'appAsar']) {
    assert.match(String(pins?.[key] || ''), /^[a-f0-9]{64}$/, `Missing reviewed ${key} SHA256`);
  }
  assert.match(version, /^\d+\.\d+\.\d+(?:-repair\.[1-9]\d*)?$/, 'Invalid artifact release identity');
  const base = `AHT-Launcher-Windows-10-11-${version}`;
  const installer = await fs.readFile(path.join(directory, `${base}.exe`));
  const updateZip = await fs.readFile(path.join(directory, `${base}.zip`));
  assert.equal(sha256(installer), pins.installer, 'Installer differs from the reviewed bytes');
  assert.equal(sha256(updateZip), pins.updateZip, 'Update ZIP differs from the reviewed bytes');
  const zip = new AdmZip(updateZip);
  assert.equal(sha256(zip.readFile('Uninstall A Hard Time Launcher Windows.exe')), pins.uninstaller, 'Uninstaller differs from the reviewed bytes');
  assert.equal(sha256(zip.readFile('resources/app.asar')), pins.appAsar, 'Application differs from the reviewed bytes');
  return { verified: true, version, ...pins };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runId = String(process.env.AHT_ARTIFACT_RUN_ID || '');
  assert.match(runId, /^[1-9]\d*$/, 'A successful reviewed build run is required');
  const repo = String(process.env.GITHUB_REPOSITORY || '');
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/, 'A repository identity is required');
  const run = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/actions/runs/${runId}`], { encoding: 'utf8', windowsHide: true }));
  verifyReviewedBuildProvenance(run, process.env.GITHUB_SHA, repo);
  const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const directory = process.argv[process.argv.indexOf('--artifacts') + 1];
  assert(directory && directory !== process.argv[0], '--artifacts is required');
  const result = await verifyReviewedWindowsArtifacts(directory, metadata.ahtLauncherVersion || metadata.version,
    JSON.parse(process.env.AHT_REVIEWED_WINDOWS_ARTIFACTS || '{}'));
  console.log(JSON.stringify({ sourceRun: runId, ...result }));
}
