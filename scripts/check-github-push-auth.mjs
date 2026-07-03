#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);

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

export function redactGitOutput(value = '') {
  return String(value || '')
    .replace(/(https?:\/\/)([^:\s/@]+):([^@\s]+)@/gi, '$1[redacted]@')
    .replace(/^(password|oauth_refresh_token|access_token|credential|token)=.*$/gim, '$1=[redacted]')
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, '$1[redacted]');
}

function loginCommands(username = 'svre-mc') {
  const base = `git credential-manager github login --username ${username} --url https://github.com --force`;
  return [
    `${base} --browser`,
    `${base} --device`,
    `${base} --pat <token>`
  ];
}

export function classifyPushDryRunFailure(output = '', username = 'svre-mc') {
  const redacted = redactGitOutput(output);
  const text = redacted.toLowerCase();
  if (
    text.includes('cannot prompt')
    || text.includes('unable to get password')
    || text.includes('terminal prompts disabled')
    || text.includes('could not read username')
    || text.includes('could not read password')
    || text.includes('authentication failed')
  ) {
    return {
      reason: 'missing-github-write-credential',
      message: 'GitHub write authentication is not available noninteractively. Log in with Git Credential Manager or provide a PAT before publishing.',
      loginCommands: loginCommands(username),
      output: redacted
    };
  }
  if (
    text.includes('write access to repository not granted')
    || text.includes('permission denied')
    || text.includes('403')
  ) {
    return {
      reason: 'github-write-access-denied',
      message: 'GitHub authentication exists, but it does not have write access to this repository.',
      output: redacted
    };
  }
  if (text.includes('repository not found') || text.includes('not found')) {
    return {
      reason: 'github-repository-not-found',
      message: 'GitHub did not expose the repository to the current credential.',
      output: redacted
    };
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return {
      reason: 'github-push-dry-run-timeout',
      message: 'GitHub push dry-run timed out. Re-run with prompts disabled and check Git Credential Manager.',
      output: redacted
    };
  }
  return {
    reason: 'github-push-dry-run-failed',
    message: 'GitHub push dry-run failed.',
    output: redacted
  };
}

function runGitCommand(args, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 60_000));
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        ...(options.env || {})
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        status: null,
        timedOut: true,
        stdout,
        stderr: `${stderr}\nTimed out after ${timeoutMs}ms.`
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, error: error.message, stdout, stderr });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

export async function checkGithubPushAuth(options = {}) {
  const remote = String(options.remote || 'origin').trim();
  const branch = String(options.branch || 'main').trim();
  const username = String(options.username || 'svre-mc').trim();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 60_000));
  const runGit = options.runGit || ((args, runOptions = {}) => runGitCommand(args, {
    cwd: options.cwd,
    timeoutMs: runOptions.timeoutMs || timeoutMs,
    env: runOptions.env
  }));

  if (!remote) throw new Error('Remote is required.');
  if (!branch) throw new Error('Branch is required.');

  const branchStatus = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 });
  const localBranch = String(branchStatus.stdout || '').trim();
  const remoteStatus = await runGit(['ls-remote', '--heads', remote, branch], { timeoutMs: 30_000 });
  if (remoteStatus.status !== 0) {
    return {
      ok: false,
      phase: 'read-remote',
      remote,
      branch,
      localBranch,
      failure: classifyPushDryRunFailure(`${remoteStatus.stdout || ''}\n${remoteStatus.stderr || remoteStatus.error || ''}`, username)
    };
  }

  const pushStatus = await runGit([
    '-c',
    'credential.interactive=false',
    'push',
    '--dry-run',
    remote,
    `HEAD:${branch}`
  ], {
    timeoutMs,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never'
    }
  });

  if (pushStatus.status === 0 && !pushStatus.timedOut && !pushStatus.error) {
    return {
      ok: true,
      phase: 'push-dry-run',
      remote,
      branch,
      localBranch,
      output: redactGitOutput(`${pushStatus.stdout || ''}\n${pushStatus.stderr || ''}`).trim()
    };
  }

  return {
    ok: false,
    phase: 'push-dry-run',
    remote,
    branch,
    localBranch,
    failure: classifyPushDryRunFailure(`${pushStatus.stdout || ''}\n${pushStatus.stderr || pushStatus.error || ''}`, username)
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const args = parseArgs();
  checkGithubPushAuth({
    remote: args.remote || 'origin',
    branch: args.branch || 'main',
    username: args.username || 'svre-mc',
    timeoutMs: Number(args['timeout-ms'] || 60_000)
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 2);
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
