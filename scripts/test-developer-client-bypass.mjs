import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10030);
const endpoint = `http://127.0.0.1:${port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-developer-client-bypass-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
  name: 'A Hard Time',
  version: '2.8.51',
  required: true,
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  },
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { path: 'packs/developer-smoke.zip' }
};
const expectedContent = 'managed=true\n';
const changedContent = 'managed=false\n';

await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: latest.packId,
  instanceDir,
  latestUrl: 'http://127.0.0.1:9/latest.json',
  curseforge: { proxyBaseUrl: '', apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: '', playerLabel: 'DeveloperSmoke' },
  developer: { adminBaseUrl: '', defaultOutDir: path.join(root, 'release'), defaultCacheModsDir: '', r2Bucket: 'ahtlauncher' },
  launcherUpdate: { enabled: false, latestUrl: '' },
  launcherProof: { enabled: false, required: false, baseUrl: '', keyId: 'aht-launcher-proof-v1' },
  minecraftLauncher: { enabled: true, rootDir: mcRoot, profileId: latest.packId, profileName: latest.name, memoryMb: 4096 },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), { installId: 'developer-smoke-install', minecraftUsername: 'DeveloperSmoke' });
await writeJson(path.join(instanceDir, '.aht-launcher', 'installed.json'), {
  packId: latest.packId,
  name: latest.name,
  version: latest.version,
  minecraft: latest.minecraft,
  manifestFileCount: 0,
  overrideFileCount: 2
});
await writeJson(path.join(instanceDir, '.aht-launcher', 'managed-files.json'), [{
  relativePath: 'config/developer-extra.cfg',
  source: 'overrides',
  sha256: sha256(expectedContent)
}, {
  relativePath: 'mods/developer-extra.jar',
  source: 'curseforge',
  sha256: sha256(expectedContent)
}]);
await fsp.mkdir(path.join(instanceDir, 'config'), { recursive: true });
await fsp.writeFile(path.join(instanceDir, 'config', 'developer-extra.cfg'), changedContent, 'utf8');
await fsp.mkdir(path.join(instanceDir, 'mods'), { recursive: true });
await fsp.writeFile(path.join(instanceDir, 'mods', 'developer-extra.jar'), changedContent, 'utf8');
await fsp.writeFile(path.join(instanceDir, 'mods', 'developer-only-tool.jar'), 'developer tool\n', 'utf8');
await writeJson(
  path.join(mcRoot, 'versions', '1.12.2-forge-14.23.5.2860', '1.12.2-forge-14.23.5.2860.json'),
  { id: '1.12.2-forge-14.23.5.2860', type: 'release' }
);

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '0',
    AHT_ALLOW_DEVELOPER: '1',
    AHT_LAUNCHER_SOURCE_ROOT: process.cwd()
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
    window.aht.getStatus().then((status) => status.developerMode && status.installed?.version === '2.8.51' ? status : false)
  `, 'developer status');
  if (!status.developerClientBypass) {
    throw new Error(`Developer client bypass was not enabled: ${JSON.stringify(status)}`);
  }
  if (!status.latestError) {
    throw new Error(`Smoke setup expected a feed error to prove it does not block developer play: ${JSON.stringify(status)}`);
  }
  if (!status.launchReady || status.launchBlockedReason) {
    throw new Error(`Developer client should be launch-ready despite local changes/feed error: ${JSON.stringify(status)}`);
  }
  if (!status.integrity?.developerClientBypass || status.integrity?.counts?.corrupted !== 0) {
    throw new Error(`Developer integrity was not bypassed cleanly: ${JSON.stringify(status.integrity)}`);
  }
  const scan = await evaluate(client, 'window.aht.scanFiles()');
  if (!scan.developerClientBypass || scan.counts?.corrupted !== 0) {
    throw new Error(`Developer scan should be bypassed cleanly: ${JSON.stringify(scan)}`);
  }
  const changes = await evaluate(client, 'window.aht.scanChanges()');
  if (!changes.developerClientBypass || changes.counts?.changed !== 0 || changes.counts?.added !== 0 || changes.counts?.missing !== 0) {
    throw new Error(`Developer local changes should be bypassed cleanly: ${JSON.stringify(changes)}`);
  }
  const badge = await waitFor(client, `
    (() => {
      const text = document.querySelector('#statusBadge')?.textContent || '';
      return text === 'Ready' ? text : false;
    })()
  `, 'ready developer badge');
  const diffSummary = await evaluate(client, "document.querySelector('#diffSummary')?.textContent || ''");
  if (diffSummary !== 'Bypassed') {
    throw new Error(`Developer local changes summary should be Bypassed, got ${diffSummary}`);
  }

  const localLatestPath = path.join(root, 'developer-latest.json');
  await writeJson(localLatestPath, latest);
  const configPath = path.join(userData, 'launcher.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.latestUrl = localLatestPath;
  await writeJson(configPath, config);
  await fsp.rm(path.join(instanceDir, '.aht-launcher', 'installed.json'), { force: true });
  const notInstalledProof = await waitFor(client, `
    window.aht.getStatus().then((status) => {
      renderStatus(status);
      return status.developerMode && status.developerClientBypass && !status.installed ? {
        updateRequired: status.updateRequired,
        launchReady: status.launchReady,
        launchBlockedReason: status.launchBlockedReason,
        updateDisabled: document.querySelector('#updateButton')?.getAttribute('aria-disabled') === 'true',
        playDisabled: document.querySelector('#playButton')?.getAttribute('aria-disabled') === 'true',
        badge: document.querySelector('#statusBadge')?.textContent || '',
        installed: status.installed || null,
        latest: status.latest?.version || ''
      } : false;
    })
  `, 'developer not-installed update gate');
  if (!notInstalledProof.updateRequired || notInstalledProof.launchReady || !/Install the pack before playing/i.test(notInstalledProof.launchBlockedReason || '')) {
    throw new Error(`Developer not-installed modpack status should require Update before Play: ${JSON.stringify(notInstalledProof)}`);
  }
  if (notInstalledProof.updateDisabled || notInstalledProof.playDisabled) {
    throw new Error(`Developer not-installed modpack should enable Update and keep Play clickable so the backend can report the install requirement: ${JSON.stringify(notInstalledProof)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    badge,
    latestError: status.latestError,
    integrity: status.integrity.counts,
    scanSource: scan.source,
    changesSource: changes.source,
    notInstalledProof
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
}
