import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const port = Number(process.argv[2] || 10280);
const endpoint = `http://127.0.0.1:${port}`;
const workerEndpoint = `http://127.0.0.1:${port + 1}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-cache-only-'));
const userData = path.join(root, 'userData');
const outDir = path.join(root, 'release');
const defaultsDir = path.join(root, 'defaults');
const fakeBin = path.join(root, 'bin');
const fakeR2Root = path.join(root, 'r2');
const secretLog = path.join(root, 'secret-log.jsonl');
const uploadLog = path.join(root, 'upload-log.jsonl');
const bucket = 'ahtlauncher';
const packZip = path.join(root, 'A Hard Time Dregora-2.8.5.zip');
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

async function waitFor(client, expression, label, attempts = 180) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await fsp.mkdir(fakeBin, { recursive: true });
await fsp.mkdir(path.join(fakeR2Root, bucket), { recursive: true });

const fakeWrangler = path.join(fakeBin, 'fake-wrangler.mjs');
await fsp.writeFile(fakeWrangler, `
import fs from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('wrangler 4.0.0-smoke');
  process.exit(0);
}
if (args.includes('whoami')) {
  console.log('smoke@example.com');
  process.exit(0);
}
if (args.includes('login')) {
  console.log('Successfully logged in');
  process.exit(0);
}
const createIndex = args.indexOf('create');
if (args.includes('bucket') && createIndex !== -1) {
  console.log('Created bucket ' + args[createIndex + 1]);
  process.exit(0);
}
if (args.includes('secret') && args.includes('put')) {
  const name = args[args.indexOf('put') + 1];
  await fs.appendFile(process.env.FAKE_SECRET_LOG, JSON.stringify({ name }) + '\\n');
  console.log('Created secret ' + name);
  process.exit(0);
}
if (args.includes('deploy')) {
  console.log('Deployed ' + process.env.FAKE_WORKER_URL);
  process.exit(0);
}
const putIndex = args.indexOf('put');
if (putIndex === -1) throw new Error('Only r2 object put is supported by this smoke fake');
const target = args[putIndex + 1];
const fileArg = args.find((arg) => arg.startsWith('--file='));
if (!target || !fileArg) throw new Error('Missing target or --file');
const slash = target.indexOf('/');
const bucket = target.slice(0, slash);
const key = target.slice(slash + 1);
const source = fileArg.slice('--file='.length);
const dest = path.join(process.env.FAKE_R2_ROOT, bucket, ...key.split('/'));
await fs.mkdir(path.dirname(dest), { recursive: true });
await fs.copyFile(source, dest);
await fs.appendFile(process.env.FAKE_UPLOAD_LOG, JSON.stringify({ bucket, key }) + '\\n');
console.log('uploaded ' + key);
`, 'utf8');
if (process.platform === 'win32') {
  await fsp.writeFile(path.join(fakeBin, 'npx.cmd'), `@echo off\r\nnode "%~dp0fake-wrangler.mjs" %*\r\n`, 'utf8');
} else {
  const npxPath = path.join(fakeBin, 'npx');
  await fsp.writeFile(npxPath, `#!/usr/bin/env sh\nnode "$(dirname "$0")/fake-wrangler.mjs" "$@"\n`, 'utf8');
  await fsp.chmod(npxPath, 0o755);
}

const manifest = {
  name: 'A Hard Time Dregora',
  version: '2.8.5',
  overrides: 'overrides',
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  },
  files: [
    {
      projectID: 111111,
      fileID: 222222,
      required: true
    }
  ]
};
const zip = new AdmZip();
zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
zip.addFile('overrides/config/cache-only-test.cfg', Buffer.from('cache-only=true\n'));
zip.writeZip(packZip);

await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir: path.join(root, 'instance'),
  latestUrl: '',
  curseforge: { proxyBaseUrl: '', apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: '', playerLabel: 'SmokeUser' },
  developer: { adminBaseUrl: '', defaultOutDir: outDir, defaultCacheModsDir: '', r2Bucket: bucket },
  minecraftLauncher: { enabled: false, rootDir: path.join(root, 'minecraft'), profileId: 'a-hard-time', profileName: 'A Hard Time', memoryMb: 4096 },
  playCommand: { command: '', args: [], cwd: path.join(root, 'instance') }
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
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    FAKE_R2_ROOT: fakeR2Root,
    FAKE_SECRET_LOG: secretLog,
    FAKE_UPLOAD_LOG: uploadLog,
    FAKE_WORKER_URL: workerEndpoint,
    AHT_PLAYER_DEFAULTS_DIR: defaultsDir,
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
  await waitFor(client, "document.querySelector('#setupCloudButton').getAttribute('aria-disabled') === 'true'", 'setup locked before cache-only');
  await evaluate(client, `
    (() => {
      document.querySelector('#packZipInput').value = ${JSON.stringify(packZip)};
      document.querySelector('#playerFeedUrlInput').value = '';
      document.querySelector('#curseforgeApiKeyInput').value = '';
      document.querySelector('#launcherProofSecretInput').value = 'proof-secret';
      document.querySelector('#cacheOnlyInput').checked = true;
      document.querySelector('#bucketInput').value = ${JSON.stringify(bucket)};
      for (const selector of ['#packZipInput', '#playerFeedUrlInput', '#curseforgeApiKeyInput', '#launcherProofSecretInput', '#cacheOnlyInput', '#bucketInput']) {
        document.querySelector(selector).dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector(selector).dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await waitFor(client, "document.querySelector('#setupCloudButton').getAttribute('aria-disabled') !== 'true'", 'cache-only setup enabled');
  await evaluate(client, "document.querySelector('#setupCloudButton').click()");
  await waitFor(client, "document.querySelector('#releaseCheckState').textContent === 'Cloud ready'", 'cloud ready');
  const secretNames = fs.readFileSync(secretLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).name);
  if (secretNames.includes('CURSEFORGE_API_KEY')) {
    throw new Error(`Cache-only setup should not write CURSEFORGE_API_KEY: ${JSON.stringify(secretNames)}`);
  }
  for (const required of ['LAUNCHER_PROOF_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_TOKEN_SECRET']) {
    if (!secretNames.includes(required)) {
      throw new Error(`Cache-only setup missed developer secret ${required}: ${JSON.stringify(secretNames)}`);
    }
  }
  const defaults = JSON.parse(fs.readFileSync(path.join(defaultsDir, 'app.defaults.json'), 'utf8'));
  if (defaults.curseforge?.proxyBaseUrl) {
    throw new Error(`Cache-only player defaults should not include a CurseForge proxy: ${JSON.stringify(defaults)}`);
  }
  if (Object.prototype.hasOwnProperty.call(defaults, 'developer')) {
    throw new Error(`Cache-only player defaults must not include developer config: ${JSON.stringify(defaults.developer)}`);
  }

  await evaluate(client, "document.querySelector('#publishReleaseButton').click()");
  await waitFor(client, `(() => {
    const state = document.querySelector('#releaseCheckState')?.textContent || '';
    return ['Publish failed', 'Upload blocked', 'Cache-only blocked'].includes(state);
  })()`, 'legacy cache-only publish block');
  const blockProof = await evaluate(client, `({
    state: document.querySelector('#releaseCheckState').textContent,
    title: document.querySelector('#releaseCheckTitle').textContent,
    detail: document.querySelector('#releaseCheckDetail').textContent
  })`);
  if (!/Legacy CurseForge export ZIPs are blocked|Cache-only mode requires/.test(blockProof.detail || '')) {
    throw new Error(`Unexpected cache-only publish block: ${JSON.stringify(blockProof)}`);
  }
  if (fs.existsSync(uploadLog) && fs.readFileSync(uploadLog, 'utf8').trim()) {
    throw new Error(`Blocked legacy publish should not upload R2 objects: ${fs.readFileSync(uploadLog, 'utf8')}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    secretNames,
    defaults: {
      latestUrl: defaults.latestUrl,
      proxyBaseUrl: defaults.curseforge?.proxyBaseUrl || '',
      cacheOnlyMode: !defaults.curseforge?.proxyBaseUrl,
    },
    blockProof
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
}
