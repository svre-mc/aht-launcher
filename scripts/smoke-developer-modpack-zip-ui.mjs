import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const port = Number(process.argv[2] || (18000 + Math.floor(Math.random() * 15000)));
const endpoint = `http://127.0.0.1:${port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-dev-modpack-zip-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const mcRoot = path.join(root, 'minecraft');
const outDir = path.join(root, 'release');
const clientDir = path.join(root, 'client-pack');
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

async function writeFile(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, value);
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
            }, 45000);
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

for (const dir of ['config', 'fancymenu_data', 'mods', 'resourcepacks', 'resources', 'scripts', 'structures']) {
  await fsp.mkdir(path.join(clientDir, dir), { recursive: true });
}
await writeFile(path.join(clientDir, 'config', 'aht-client.cfg'), 'client=true\n');
await writeFile(path.join(clientDir, 'fancymenu_data', 'layout.txt'), 'menu\n');
await writeFile(path.join(clientDir, 'mods', 'aht-required.jar'), Buffer.from('fake jar'));
await writeFile(path.join(clientDir, 'resourcepacks', 'aht-resources.zip'), Buffer.from('fake resource pack'));
await writeFile(path.join(clientDir, 'resources', 'readme.txt'), 'resource root\n');
await writeFile(path.join(clientDir, 'scripts', 'aht.zs'), 'print("aht");\n');
await writeFile(path.join(clientDir, 'structures', 'aht.nbt'), Buffer.from('fake structure'));
await writeFile(path.join(clientDir, 'options.txt'), 'player-options\n');
await writeFile(path.join(clientDir, 'optionsof.txt'), 'player-optifine-options\n');

await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: '',
  curseforge: { proxyBaseUrl: '', apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: '', playerLabel: 'SmokeUser' },
  developer: { adminBaseUrl: '', defaultOutDir: outDir, defaultCacheModsDir: '', clientModpackDir: clientDir, r2Bucket: 'ahtlauncher' },
  minecraftLauncher: { enabled: false, rootDir: mcRoot, profileId: 'a-hard-time', profileName: 'A Hard Time', memoryMb: 4096 },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'smoke-install',
  minecraftUsername: 'SmokeUser'
});

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_ALLOW_DEVELOPER: '1',
    AHT_LAUNCHER_SOURCE_ROOT: process.cwd(),
    AHT_DEVELOPER_USERNAME: 'admin',
    AHT_DEVELOPER_PASSWORD: 'test-dev-password',
    AHT_SKIP_REMOTE_DEVELOPER_LOGIN: '1',
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
  await waitFor(client, "document.readyState === 'complete' && document.querySelector('#developerLoginForm')", 'developer login DOM');
  await evaluate(client, `
    (() => {
      document.querySelector('#adminPasswordInput').value = 'test-dev-password';
      document.querySelector('#developerLoginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()
  `);
  await waitFor(client, "document.body.classList.contains('dev-locked') === false", 'developer unlock');
  await waitFor(client, "document.querySelector('#clientModpackDirInput') && document.querySelector('#clientZipVersionInput')", 'modpack zip fields');
  const proof = await evaluate(client, `
    (async () => {
      const setValue = (selector, value) => {
        const input = document.querySelector(selector);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return input.value;
      };
      document.querySelector('[data-dev-target="modpackZipTools"]').click();
      setValue('#clientModpackDirInput', ${JSON.stringify(clientDir)});
      setValue('#clientZipVersionInput', '2.8.88');
      document.querySelector('#buildClientZipButton').click();
      const snapshot = () => ({
        zipPath: document.querySelector('#packZipInput')?.value || '',
        title: document.querySelector('#clientZipStatus strong')?.textContent || '',
        detail: document.querySelector('#clientZipStatus p')?.textContent || '',
        activePanelHidden: document.querySelector('#modpackZipTools')?.hidden,
        releasePackZip: document.querySelector('#packZipInput')?.value || '',
        releaseCheckTitle: document.querySelector('#releaseCheckTitle')?.textContent || '',
        sourceValue: document.querySelector('#clientModpackDirInput')?.value || '',
        versionValue: document.querySelector('#clientZipVersionInput')?.value || '',
        buttonDisabled: document.querySelector('#buildClientZipButton')?.classList.contains('is-disabled') || false,
        toastText: [...document.querySelectorAll('.toast')].map((node) => node.textContent.trim()).join(' | '),
        devLog: document.querySelector('#devLog')?.textContent?.slice(0, 1200) || ''
      });
      const started = Date.now();
      let last = snapshot();
      while (Date.now() - started < 60000) {
        last = snapshot();
        if (last.zipPath && last.title === 'ZIP created') return last;
        if (last.title === 'ZIP failed' || last.title === 'Folder required' || last.title === 'Version required') {
          throw new Error('Modpack ZIP UI failed: ' + JSON.stringify(last));
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('Timed out waiting for ZIP created status: ' + JSON.stringify(last));
    })()
  `);
  if (!proof.zipPath || proof.activePanelHidden) {
    throw new Error(`Modpack ZIP UI did not remain active or did not fill Pack ZIP: ${JSON.stringify(proof)}`);
  }

  const zip = new AdmZip(proof.zipPath);
  const metadataEntry = zip.getEntry('aht-client-pack.json');
  if (!metadataEntry) throw new Error('Generated client ZIP is missing aht-client-pack.json');
  const metadata = JSON.parse(metadataEntry.getData().toString('utf8'));
  const entries = new Set(zip.getEntries().map((entry) => entry.entryName.replace(/\\/g, '/')));
  const requiredEntries = [
    'config/aht-client.cfg',
    'fancymenu_data/layout.txt',
    'mods/aht-required.jar',
    'resourcepacks/aht-resources.zip',
    'resources/readme.txt',
    'scripts/aht.zs',
    'structures/aht.nbt',
    'options.txt',
    'optionsof.txt'
  ];
  const missing = requiredEntries.filter((entry) => !entries.has(entry));
  if (missing.length) throw new Error(`Generated client ZIP missing expected entries: ${missing.join(', ')}`);
  if (metadata.format !== 'aht-full-client-zip') throw new Error(`Unexpected metadata format: ${metadata.format}`);
  if (metadata.packId !== 'a-hard-time-dregora') throw new Error(`Generated pack id mismatch: ${metadata.packId}`);
  if (metadata.name !== 'A Hard Time') throw new Error(`Generated pack name mismatch: ${metadata.name}`);
  if (metadata.version !== '2.8.88') throw new Error(`Generated version mismatch: ${metadata.version}`);

  console.log(JSON.stringify({
    ok: true,
    root,
    zipPath: proof.zipPath,
    packId: metadata.packId,
    fileCount: metadata.fileCount,
    releasePackZip: proof.releasePackZip
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await sleep(600);
}