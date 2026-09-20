import {
  cleanGithubRepo,
  cleanLauncherVersion,
  dispatchGithubWorkflow,
  findRecentWorkflowRun,
  readGithubPackageVersion,
  readGithubWorkflowRun,
  waitForGithubWorkflowRun,
  triggerLauncherReleaseWorkflow
} from '../src/githubActions.js';
import nodeAssert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { verifyReviewedBuildProvenance, verifyReviewedWindowsArtifacts } from './verify-reviewed-launcher-artifacts.mjs';

const reviewedRun = { status: 'completed', conclusion: 'success', head_sha: 'reviewed-commit', repository: { full_name: 'owner/launcher' }, path: '.github/workflows/build-macos.yml' };
verifyReviewedBuildProvenance(reviewedRun, 'reviewed-commit', 'owner/launcher');
for (const change of [{ status: 'in_progress' }, { conclusion: 'failure' }, { head_sha: 'other-commit' }, { repository: { full_name: 'other/launcher' } }, { path: 'other.yml' }]) {
  nodeAssert.throws(() => verifyReviewedBuildProvenance({ ...reviewedRun, ...change }, 'reviewed-commit', 'owner/launcher'));
}
const reviewRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-reviewed-artifacts-'));
try {
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const zip = new AdmZip();
  const uninstaller = Buffer.from('fixture-uninstaller'), appAsar = Buffer.from('fixture-app');
  zip.addFile('Uninstall A Hard Time Launcher Windows.exe', uninstaller);
  zip.addFile('resources/app.asar', appAsar);
  const zipBytes = zip.toBuffer(), exeBytes = Buffer.from('fixture-installer');
  const base = path.join(reviewRoot, 'AHT-Launcher-Windows-10-11-0.2.30-repair.1');
  await fs.writeFile(`${base}.exe`, exeBytes); await fs.writeFile(`${base}.zip`, zipBytes);
  const pins = { installer: hash(exeBytes), updateZip: hash(zipBytes), uninstaller: hash(uninstaller), appAsar: hash(appAsar) };
  nodeAssert.equal((await verifyReviewedWindowsArtifacts(reviewRoot, '0.2.30-repair.1', pins)).verified, true);
  for (const key of Object.keys(pins)) {
    await nodeAssert.rejects(verifyReviewedWindowsArtifacts(reviewRoot, '0.2.30-repair.1', { ...pins, [key]: '0'.repeat(64) }));
  }
  await fs.writeFile(`${base}.exe`, 'changed-after-review');
  await nodeAssert.rejects(verifyReviewedWindowsArtifacts(reviewRoot, '0.2.30-repair.1', pins));
} finally {
  nodeAssert.equal(path.dirname(reviewRoot), path.resolve(os.tmpdir()));
  nodeAssert(path.basename(reviewRoot).startsWith('aht-reviewed-artifacts-'));
  await fs.rm(reviewRoot, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(cleanGithubRepo('https://github.com/svre-mc/aht-launcher.git') === 'svre-mc/aht-launcher', 'repo URL parsing failed');
assert(cleanLauncherVersion('0.1.3') === '0.1.3', 'version parsing failed');
assert(cleanLauncherVersion('0.2.01') === '0.2.01', 'zero-padded public launcher version parsing failed');

const calls = [];
const fetchImpl = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (String(url).includes('/contents/package.json')) {
    return Response.json({
      content: Buffer.from(JSON.stringify({ version: '0.1.9', ahtLauncherVersion: '0.1.09' })).toString('base64')
    });
  }
  if (String(url).endsWith('/dispatches')) {
    return new Response(null, { status: 204 });
  }
  if (/\/actions\/runs\/123$/.test(String(url))) {
    return Response.json({
      id: 123,
      name: 'Build and Publish Launchers',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/svre-mc/aht-launcher/actions/runs/123',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      head_branch: 'main'
    });
  }
  return Response.json({
    workflow_runs: [
      {
        id: 123,
        name: 'Build and Publish Launchers',
        status: 'queued',
        conclusion: null,
        html_url: 'https://github.com/svre-mc/aht-launcher/actions/runs/123',
        created_at: new Date().toISOString(),
        head_branch: 'main'
      }
    ]
  });
};

const dispatch = await dispatchGithubWorkflow({
  repo: 'svre-mc/aht-launcher',
  workflow: 'build-macos.yml',
  ref: 'main',
  token: 'test-token',
  publishToR2: true,
  fetchImpl
});
assert(dispatch.ok, 'dispatch did not return ok');
const body = JSON.parse(calls[0].options.body);
assert(body.ref === 'main', 'dispatch ref mismatch');
assert(!Object.hasOwn(body.inputs, 'launcher_version'), 'dispatch must not send a manual launcher_version override');
assert(body.inputs.publish_to_r2 === true, 'dispatch publish_to_r2 input missing');
assert(calls[0].options.headers.Authorization === 'Bearer test-token', 'authorization header mismatch');

const githubPackageVersion = await readGithubPackageVersion({
  repo: 'svre-mc/aht-launcher',
  ref: 'main',
  token: 'test-token',
  fetchImpl
});
assert(githubPackageVersion === '0.1.09', 'GitHub public launcher version lookup failed');

const run = await findRecentWorkflowRun({
  repo: 'svre-mc/aht-launcher',
  workflow: 'build-macos.yml',
  ref: 'main',
  token: 'test-token',
  fetchImpl
});
assert(run?.id === 123, 'workflow run lookup failed');
const freshRun = await findRecentWorkflowRun({ token:'test-token', runNameIncludes:'exact-candidate',
  fetchImpl:async (_url, options) => Response.json({ workflow_runs:
    options.cache === 'no-store' && options.headers['Cache-Control'] === 'no-cache'
      ? [{id:456,display_title:'Rebuild stable (exact-candidate)',created_at:new Date().toISOString(),status:'in_progress'}]
      : [] }) });
assert(freshRun?.id === 456, 'post-dispatch discovery reused a cached empty run list');

const runStatus = await readGithubWorkflowRun({
  repo: 'svre-mc/aht-launcher',
  runId: 123,
  token: 'test-token',
  fetchImpl
});
assert(runStatus?.conclusion === 'success', 'workflow run status lookup failed');

const completed = await waitForGithubWorkflowRun({
  repo: 'svre-mc/aht-launcher',
  runId: 123,
  token: 'test-token',
  fetchImpl,
  waitForCompletionMs: 10,
  pollIntervalMs: 1,
  sleepImpl: async () => {}
});
assert(completed?.status === 'completed', 'workflow completion wait failed');

const triggered = await triggerLauncherReleaseWorkflow({
  repo: 'svre-mc/aht-launcher',
  workflow: 'build-macos.yml',
  ref: 'main',
  token: 'test-token',
  fetchImpl,
  waitForRunMs: 1,
  pollIntervalMs: 1
});
assert(triggered.actionsUrl.endsWith('/actions/workflows/build-macos.yml'), 'actions URL mismatch');

console.log(JSON.stringify({
  ok: true,
  calls: calls.length,
  runUrl: run.htmlUrl
}, null, 2));
