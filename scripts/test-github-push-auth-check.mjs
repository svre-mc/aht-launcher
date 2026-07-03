import {
  checkGithubPushAuth,
  classifyPushDryRunFailure,
  redactGitOutput
} from './check-github-push-auth.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const classified = classifyPushDryRunFailure('fatal: Cannot prompt because user interactivity has been disabled.\nfatal: unable to get password from user', 'svre-mc');
assert(classified.reason === 'missing-github-write-credential', `wrong missing credential reason: ${JSON.stringify(classified)}`);
assert(classified.loginCommands?.some((command) => command.includes('github login --username svre-mc')), 'missing credential response must include GCM login commands');

const denied = classifyPushDryRunFailure('remote: Write access to repository not granted.\nfatal: unable to access: The requested URL returned error: 403');
assert(denied.reason === 'github-write-access-denied', `wrong denied reason: ${JSON.stringify(denied)}`);

const redacted = redactGitOutput('https://user:secret@github.com/svre-mc/aht-launcher.git\npassword=abc\nAuthorization: Bearer real-token');
assert(!redacted.includes('secret') && !redacted.includes('abc') && !redacted.includes('real-token'), `redaction leaked credentials: ${redacted}`);

const calls = [];
const okResult = await checkGithubPushAuth({
  remote: 'origin',
  branch: 'main',
  username: 'svre-mc',
  runGit: async (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'main\n', stderr: '' };
    if (args[0] === 'ls-remote') return { status: 0, stdout: 'abc\trefs/heads/main\n', stderr: '' };
    if (args.includes('push')) return { status: 0, stdout: '', stderr: 'To https://github.com/svre-mc/aht-launcher.git\n' };
    throw new Error(`Unexpected git args: ${args.join(' ')}`);
  }
});
assert(okResult.ok && okResult.phase === 'push-dry-run', `expected ok push dry-run: ${JSON.stringify(okResult)}`);
const pushCall = calls.find((call) => call.args.includes('push'));
assert(pushCall, 'push dry-run was not attempted');
assert(pushCall.args.includes('--dry-run'), 'push auth check must use --dry-run');
assert(pushCall.options.env?.GIT_TERMINAL_PROMPT === '0' && pushCall.options.env?.GCM_INTERACTIVE === 'never', `push auth check must disable prompts: ${JSON.stringify(pushCall.options.env)}`);

const missingCredentialResult = await checkGithubPushAuth({
  remote: 'origin',
  branch: 'main',
  runGit: async (args) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'main\n', stderr: '' };
    if (args[0] === 'ls-remote') return { status: 0, stdout: 'abc\trefs/heads/main\n', stderr: '' };
    return { status: 128, stdout: '', stderr: 'fatal: Cannot prompt because user interactivity has been disabled.' };
  }
});
assert(!missingCredentialResult.ok && missingCredentialResult.failure?.reason === 'missing-github-write-credential', `missing credential result was not actionable: ${JSON.stringify(missingCredentialResult)}`);

console.log(JSON.stringify({
  ok: true,
  checkedCalls: calls.length,
  missingCredentialReason: missingCredentialResult.failure.reason
}, null, 2));
