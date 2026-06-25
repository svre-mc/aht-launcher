const GITHUB_API = 'https://api.github.com';
const DEFAULT_REPO = 'svre-mc/aht-launcher';
const DEFAULT_BRANCH = 'main';
const DEFAULT_WORKFLOW = 'build-macos.yml';

export function cleanGithubRepo(value = DEFAULT_REPO) {
  const raw = String(value || '').trim() || DEFAULT_REPO;
  const withoutGit = raw.replace(/\.git$/i, '');
  const urlMatch = withoutGit.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  const repo = urlMatch ? `${urlMatch[1]}/${urlMatch[2]}` : withoutGit;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('GitHub repository must be in owner/repo format.');
  }
  return repo;
}

export function cleanWorkflowId(value = DEFAULT_WORKFLOW) {
  const raw = String(value || '').trim() || DEFAULT_WORKFLOW;
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error('GitHub workflow must be a workflow file name like build-macos.yml or a workflow id.');
  }
  return raw;
}

export function cleanRef(value = DEFAULT_BRANCH) {
  const raw = String(value || '').trim() || DEFAULT_BRANCH;
  if (!/^[A-Za-z0-9._/-]+$/.test(raw) || raw.includes('..') || raw.startsWith('/') || raw.endsWith('/')) {
    throw new Error('GitHub branch/ref is invalid.');
  }
  return raw;
}

export function cleanLauncherVersion(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(raw)) {
    throw new Error('Launcher version must look like 0.1.3.');
  }
  return raw;
}

function githubHeaders(token) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) {
    throw new Error('GitHub token is required to trigger the launcher release workflow.');
  }
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${cleanToken}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function readGithubJson(response, label) {
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }
  if (!response.ok) {
    const detail = parsed?.message || `${response.status} ${response.statusText}`.trim();
    throw new Error(`${label} failed: ${detail}`);
  }
  return parsed;
}

export async function dispatchGithubWorkflow({
  repo = DEFAULT_REPO,
  workflow = DEFAULT_WORKFLOW,
  ref = DEFAULT_BRANCH,
  token,
  launcherVersion = '',
  publishToR2 = true,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available.');
  const cleanRepo = cleanGithubRepo(repo);
  const cleanWorkflow = cleanWorkflowId(workflow);
  const cleanBranch = cleanRef(ref);
  const version = cleanLauncherVersion(launcherVersion);
  const inputs = {
    publish_to_r2: Boolean(publishToR2)
  };
  if (version) {
    inputs.launcher_version = version;
  }
  const response = await fetchImpl(`${GITHUB_API}/repos/${cleanRepo}/actions/workflows/${encodeURIComponent(cleanWorkflow)}/dispatches`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({
      ref: cleanBranch,
      inputs
    })
  });
  await readGithubJson(response, 'GitHub workflow dispatch');
  return {
    ok: true,
    repo: cleanRepo,
    workflow: cleanWorkflow,
    ref: cleanBranch,
    version,
    actionsUrl: `https://github.com/${cleanRepo}/actions/workflows/${cleanWorkflow}`
  };
}

export async function findRecentWorkflowRun({
  repo = DEFAULT_REPO,
  workflow = DEFAULT_WORKFLOW,
  ref = DEFAULT_BRANCH,
  token,
  since = new Date(Date.now() - 30_000).toISOString(),
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available.');
  const cleanRepo = cleanGithubRepo(repo);
  const cleanWorkflow = cleanWorkflowId(workflow);
  const cleanBranch = cleanRef(ref);
  const url = new URL(`${GITHUB_API}/repos/${cleanRepo}/actions/workflows/${encodeURIComponent(cleanWorkflow)}/runs`);
  url.searchParams.set('event', 'workflow_dispatch');
  url.searchParams.set('branch', cleanBranch);
  url.searchParams.set('per_page', '10');
  const response = await fetchImpl(url, {
    headers: githubHeaders(token)
  });
  const parsed = await readGithubJson(response, 'GitHub workflow run lookup');
  const sinceMs = Date.parse(since) || 0;
  const run = (parsed?.workflow_runs || [])
    .filter((item) => Date.parse(item.created_at || '') >= sinceMs - 10_000)
    .sort((left, right) => Date.parse(right.created_at || '') - Date.parse(left.created_at || ''))[0];
  return run ? {
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
    branch: run.head_branch
  } : null;
}

export async function triggerLauncherReleaseWorkflow(options = {}) {
  const dispatchStartedAt = new Date().toISOString();
  const dispatch = await dispatchGithubWorkflow(options);
  const waitMs = Number(options.waitForRunMs ?? 20_000);
  const intervalMs = Number(options.pollIntervalMs ?? 2_000);
  let run = null;
  const deadline = Date.now() + Math.max(0, waitMs);
  while (!run && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    run = await findRecentWorkflowRun({
      ...options,
      since: dispatchStartedAt
    });
  }
  return {
    ...dispatch,
    run,
    dispatchStartedAt
  };
}

export const launcherWorkflowDefaults = {
  repo: DEFAULT_REPO,
  branch: DEFAULT_BRANCH,
  workflow: DEFAULT_WORKFLOW
};
