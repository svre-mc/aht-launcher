import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10042);
const endpoint = `http://127.0.0.1:${port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-dev-instance-dir-'));
const userData = path.join(root, 'userData');
const oldPlayerDir = process.platform === 'win32'
  ? 'C:\\AHT\\A Hard Time'
  : path.join(root, 'A Hard Time');
const expectedDeveloperDir = process.platform === 'win32'
  ? 'C:\\AHT\\A Hard Time Developer'
  : process.platform === 'darwin'
    ? path.join(userData, 'A Hard Time', 'Developer Instance')
    : path.join(userData, 'A Hard Time Developer');
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

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalize(value = '') {
  return path.resolve(String(value));
}

async function waitForTarget() {
  let lastError;
  for (let attempt = 0; attempt < 180; attempt += 1) {
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

async function waitFor(client, expression, label, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir: oldPlayerDir,
  latestUrl: '',
  curseforge: { proxyBaseUrl: '', apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: true, sendLocalChanges: true, baseUrl: '', playerLabel: 'DeveloperSmoke' },
  developer: { adminBaseUrl: '', defaultOutDir: path.join(root, 'release-builder'), defaultCacheModsDir: '', r2Bucket: 'ahtlauncher' },
  minecraftLauncher: { enabled: true, rootDir: path.join(root, 'minecraft'), profileId: 'a-hard-time', profileName: 'A Hard Time', memoryMb: 4096 },
  playCommand: { command: '', args: [], cwd: oldPlayerDir }
});

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '0',
    AHT_ALLOW_DEVELOPER: '1',
    AHT_LAUNCHER_SOURCE_ROOT: process.cwd(),
    AHT_DEVELOPER_USERNAME: 'admin',
    AHT_DEVELOPER_PASSWORD: 'test-dev-password'
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
  const status = await waitFor(client, `
    window.aht.getStatus().then((status) => status.developerMode && status.config?.instanceDir ? status : false)
  `, 'developer status');
  const savedConfig = JSON.parse(fs.readFileSync(path.join(userData, 'launcher.config.json'), 'utf8'));

  if (normalize(status.config.instanceDir) !== normalize(expectedDeveloperDir)) {
    throw new Error(`Developer instance dir did not migrate: ${status.config.instanceDir}`);
  }
  if (normalize(status.config.playCommand?.cwd) !== normalize(expectedDeveloperDir)) {
    throw new Error(`Developer play cwd did not migrate: ${status.config.playCommand?.cwd}`);
  }
  if (normalize(status.setup?.defaultInstanceDir) !== normalize(expectedDeveloperDir)) {
    throw new Error(`Developer setup default dir is wrong: ${status.setup?.defaultInstanceDir}`);
  }
  if (normalize(savedConfig.instanceDir) !== normalize(expectedDeveloperDir) || normalize(savedConfig.playCommand?.cwd) !== normalize(expectedDeveloperDir)) {
    throw new Error(`Migrated developer config was not persisted: ${JSON.stringify(savedConfig)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    oldPlayerDir,
    expectedDeveloperDir,
    statusInstanceDir: status.config.instanceDir,
    savedInstanceDir: savedConfig.instanceDir
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
}
