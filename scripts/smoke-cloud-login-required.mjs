import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 9960);
const endpoint = `http://127.0.0.1:${port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-cloud-login-'));
const userData = path.join(root, 'userData');
const fakeBin = path.join(root, 'bin');
const authStatePath = path.join(root, 'wrangler-auth-state.json');
const commandLogPath = path.join(root, 'wrangler-command-log.jsonl');
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? ['--developer', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', '--developer', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTarget() {
  let lastError;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Electron debugger target: ${lastError?.message || 'no target'}`);
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
    } else {
      resolve(message.result || {});
    }
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve({
        call(method, params = {}) {
          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((callResolve, callReject) => {
            pending.set(id, { resolve: callResolve, reject: callReject });
            setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              callReject(new Error(`CDP call timed out: ${method}`));
            }, 30000);
          });
        },
        close() {
          socket.close();
        }
      });
    }, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Failed to connect to ${wsUrl}`)), { once: true });
  });
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(client, expression, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await fsp.mkdir(fakeBin, { recursive: true });
await fsp.writeFile(authStatePath, JSON.stringify({ authenticated: false }), 'utf8');

const fakeWrangler = path.join(fakeBin, 'fake-wrangler.mjs');
await fsp.writeFile(fakeWrangler, `
import fs from 'node:fs/promises';
const args = process.argv.slice(2);
await fs.appendFile(process.env.FAKE_COMMAND_LOG, JSON.stringify({ args }) + '\\n');
if (args.includes('--version')) {
  console.log('wrangler 4.104.0');
  process.exit(0);
}
if (args.includes('whoami')) {
  const state = JSON.parse(await fs.readFile(process.env.FAKE_AUTH_STATE, 'utf8'));
  if (!state.authenticated) {
    console.log(' ⛅️ wrangler 4.104.0');
    console.log('────────────────────');
    console.log('Getting User settings...');
    console.log('You are not authenticated. Please run \`wrangler login\`.');
    process.exit(0);
  }
  console.log('You are logged in with an OAuth Token, associated with the email smoke@example.com.');
  console.log('WARNING: Wrangler is missing an optional OAuth scope. To fix this, run wrangler login.');
  process.exit(0);
}
if (args.includes('login')) {
  await fs.writeFile(process.env.FAKE_AUTH_STATE, JSON.stringify({ authenticated: true }), 'utf8');
  console.log('Successfully logged in');
  process.exit(0);
}
throw new Error('Unexpected fake Wrangler command: ' + args.join(' '));
`, 'utf8');

if (process.platform === 'win32') {
  await fsp.writeFile(path.join(fakeBin, 'npx.cmd'), `@echo off\r\nnode "%~dp0fake-wrangler.mjs" %*\r\n`, 'utf8');
} else {
  const npxPath = path.join(fakeBin, 'npx');
  await fsp.writeFile(npxPath, `#!/usr/bin/env sh\nnode "$(dirname "$0")/fake-wrangler.mjs" "$@"\n`, 'utf8');
  await fsp.chmod(npxPath, 0o755);
}

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_ALLOW_DEVELOPER: '1',
    AHT_LAUNCHER_SOURCE_ROOT: process.cwd(),
    AHT_DEVELOPER_USERNAME: 'admin',
    AHT_DEVELOPER_PASSWORD: 'test-dev-password',
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    FAKE_AUTH_STATE: authStatePath,
    FAKE_COMMAND_LOG: commandLogPath,
    ELECTRON_ENABLE_LOGGING: '0'
  },
  stdio: 'ignore',
  windowsHide: true
});

let client;
try {
  const target = await waitForTarget();
  client = await connect(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'developer DOM');
  await evaluate(client, `window.aht.devLogin({ username: 'admin', password: 'test-dev-password' })`);

  const login = await evaluate(client, `window.aht.devCloudLogin({ releaseBucket: 'ahtlauncher', dataBucket: 'ahtlauncher-data' })`);
  if (!login.ok) {
    throw new Error(`Cloud login should recover after Wrangler login: ${JSON.stringify(login)}`);
  }
  if (login.alreadyAuthenticated) {
    throw new Error(`Expected login to run when whoami printed not authenticated: ${JSON.stringify(login)}`);
  }
  if (!/not authenticated/i.test(login.output) || !/Successfully logged in/i.test(login.output)) {
    throw new Error(`Login output did not include before/login/after evidence: ${JSON.stringify(login)}`);
  }

  const commands = fs.readFileSync(commandLogPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).args.join(' '));
  const whoamiCount = commands.filter((command) => command.includes('whoami')).length;
  const loginCount = commands.filter((command) => /\blogin\b/.test(command)).length;
  if (whoamiCount < 2 || loginCount !== 1) {
    throw new Error(`Expected whoami, login, whoami command sequence: ${JSON.stringify(commands)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    login: {
      ok: login.ok,
      alreadyAuthenticated: login.alreadyAuthenticated,
      summary: login.summary
    },
    commandSequence: commands
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
}
