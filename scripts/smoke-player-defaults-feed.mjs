import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 9700);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-player-defaults-'));
const userData = path.join(root, 'userData');
const minecraftRoot = path.join(root, '.minecraft');
const tempDefaults = path.join(root, 'app.defaults.json');
const packagedDefaults = smokeExe ? path.join(path.dirname(smokeExe), 'app.defaults.json') : '';
const defaultsPath = packagedDefaults || tempDefaults;
const originalDefaults = packagedDefaults && fs.existsSync(packagedDefaults)
  ? await fsp.readFile(packagedDefaults)
  : null;
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time Dregora',
  version: '9.9.9',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: {
    path: 'packs/a-hard-time-dregora-9.9.9.zip',
    size: 123,
    sha256: '0'.repeat(64)
  },
  cacheManifest: {
    path: 'cache/mod-cache.json'
  }
};

await fsp.mkdir(minecraftRoot, { recursive: true });

await writeJson(defaultsPath, {
  packId: 'a-hard-time-dregora',
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: {
    proxyBaseUrl: `${workerEndpoint}/cf/`,
    apiKeyEnv: 'CURSEFORGE_API_KEY'
  },
  sync: {
    enabled: true,
    sendLocalChanges: true,
    baseUrl: `${workerEndpoint}/`,
    playerLabel: ''
  },

  minecraftLauncher: {
    enabled: true,
    rootDir: minecraftRoot,
    profileId: 'a-hard-time-dregora',
    profileName: 'A Hard Time',
    memoryMb: 4096
  }
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(latest));
    return;
  }
  if (url.pathname === '/api/update-logs') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ logs: [] }));
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_APP_DEFAULTS: smokeExe ? '' : tempDefaults,
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
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'player DOM');
  const status = await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '9.9.9' ? status : false)
  `, 'default Worker feed');
  if (status.config.latestUrl !== `${workerEndpoint}/latest.json`) {
    throw new Error(`Fresh config did not use defaults feed: ${JSON.stringify(status.config)}`);
  }
  if (!status.updateRequired) {
    throw new Error(`Fresh player did not detect required update: ${JSON.stringify(status)}`);
  }
  if (!status.config.instanceDir.includes('AHT') || !status.config.instanceDir.includes('A Hard Time')) {
    throw new Error(`Fresh player did not use managed AHT instance dir: ${JSON.stringify(status.config)}`);
  }
  const legacyInstanceFragments = ['curseforge', 'RLCraft Dregora', 'A Hard Time Dregora'];
  const leakedFreshInstanceFragments = legacyInstanceFragments.filter((item) => status.config.instanceDir.toLowerCase().includes(item.toLowerCase()));
  if (leakedFreshInstanceFragments.length) {
    throw new Error(`Fresh player leaked a legacy instance dir: ${JSON.stringify({ leakedFreshInstanceFragments, config: status.config })}`);
  }
  if (status.config.minecraftLauncher?.memoryMb !== 4096) {
    throw new Error(`Fresh player default RAM is not 4096 MB: ${JSON.stringify(status.config.minecraftLauncher)}`);
  }
  if (status.config.minecraftLauncher?.enabled === false) {
    throw new Error(`Fresh player default disabled Minecraft Launcher profile integration: ${JSON.stringify(status.config.minecraftLauncher)}`);
  }
  const launcherRoot = String(status.config.minecraftLauncher?.rootDir || '');
  if (path.resolve(launcherRoot) !== path.resolve(minecraftRoot)) {
    throw new Error(`Fresh player did not keep the isolated Minecraft Launcher root: ${JSON.stringify({ launcherRoot, minecraftRoot, config: status.config.minecraftLauncher })}`);
  }
  if (/curseforge[\\/]+minecraft[\\/]+install/i.test(launcherRoot)) {
    throw new Error(`Fresh player should prefer the normal Minecraft Launcher root over CurseForge: ${JSON.stringify(status.config.minecraftLauncher)}`);
  }
  const savedConfig = JSON.parse(fs.readFileSync(path.join(userData, 'launcher.config.json'), 'utf8'));
  if (savedConfig.latestUrl !== `${workerEndpoint}/latest.json`) {
    throw new Error(`Saved first-run config did not persist defaults feed: ${JSON.stringify(savedConfig)}`);
  }
  const savedPathText = `${savedConfig.instanceDir || ''}\n${savedConfig.playCommand?.cwd || ''}`;
  const leakedSavedInstanceFragments = legacyInstanceFragments.filter((item) => savedPathText.toLowerCase().includes(item.toLowerCase()));
  if (leakedSavedInstanceFragments.length) {
    throw new Error(`Saved first-run config persisted a legacy instance path: ${JSON.stringify({ leakedSavedInstanceFragments, savedConfig })}`);
  }
  const savedLauncherRoot = String(savedConfig.minecraftLauncher?.rootDir || '');
  if (/curseforge[\\/]+minecraft[\\/]+install/i.test(savedLauncherRoot)) {
    throw new Error(`Saved first-run config persisted a CurseForge launcher root: ${JSON.stringify(savedConfig.minecraftLauncher)}`);
  }
  const appliedSetup = await evaluate(client, `
    window.aht.setupApply().then((result) => ({
      instanceDir: result.config?.instanceDir || '',
      playCwd: result.config?.playCommand?.cwd || '',
      setup: result.setup || {}
    }))
  `);
  const appliedPathText = `${appliedSetup.instanceDir}\n${appliedSetup.playCwd}`;
  const leakedAppliedInstanceFragments = legacyInstanceFragments.filter((item) => appliedPathText.toLowerCase().includes(item.toLowerCase()));
  if (leakedAppliedInstanceFragments.length || !appliedSetup.instanceDir.includes('AHT') || !appliedSetup.instanceDir.includes('A Hard Time')) {
    throw new Error(`Player auto-setup selected an unsafe instance path: ${JSON.stringify({ leakedAppliedInstanceFragments, appliedSetup })}`);
  }
  console.log(JSON.stringify({
    ok: true,
    userData,
    defaultsPath,
    status: {
      latestUrl: status.config.latestUrl,
      latestVersion: status.latest?.version,
      updateRequired: status.updateRequired,
      instanceDir: status.config.instanceDir,
      minecraftRoot: status.config.minecraftLauncher?.rootDir,
      memoryMb: status.config.minecraftLauncher?.memoryMb
    }
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
  if (packagedDefaults) {
    if (originalDefaults) {
      await fsp.writeFile(packagedDefaults, originalDefaults);
    } else {
      await fsp.rm(packagedDefaults, { force: true });
    }
  }
}
