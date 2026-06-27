import {
  cleanGithubRepo,
  cleanLauncherVersion,
  dispatchGithubWorkflow,
  findRecentWorkflowRun,
  readGithubPackageVersion,
  triggerLauncherReleaseWorkflow
} from '../src/githubActions.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(cleanGithubRepo('https://github.com/svre-mc/aht-launcher.git') === 'svre-mc/aht-launcher', 'repo URL parsing failed');
assert(cleanLauncherVersion('0.1.3') === '0.1.3', 'version parsing failed');

const calls = [];
const fetchImpl = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (String(url).includes('/contents/package.json')) {
    return Response.json({
      content: Buffer.from(JSON.stringify({ version: '0.1.9' })).toString('base64')
    });
  }
  if (String(url).endsWith('/dispatches')) {
    return new Response(null, { status: 204 });
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
assert(githubPackageVersion === '0.1.9', 'GitHub package version lookup failed');

const run = await findRecentWorkflowRun({
  repo: 'svre-mc/aht-launcher',
  workflow: 'build-macos.yml',
  ref: 'main',
  token: 'test-token',
  fetchImpl
});
assert(run?.id === 123, 'workflow run lookup failed');

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
