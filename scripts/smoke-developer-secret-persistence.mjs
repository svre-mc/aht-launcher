import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const basePort = Number(process.argv[2] || (12000 + Math.floor(Math.random() * 20000)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-dev-secret-'));
const userData = path.join(root, 'userData');
const vaultDir = path.join(root, 'developer-secret-vault');
const secretValue = 'fake-cf-key-persisted';
const proofSecretValue = 'proof-secret-persisted';
const r2AccountValue = 'abc123abc123abc123abc123abc123ab';
const r2AccessKeyValue = 'r2-access-key-persisted';
const r2SecretKeyValue = 'r2-secret-key-persisted';
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgsFor = (port) => smokeExe
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

async function waitForTarget(endpoint) {
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

async function waitFor(client, expression, label, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForVaultSnapshotProfile(timeoutMs = 15000) {
  const snapshotsDir = path.join(vaultDir, 'snapshots');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshots = await fsp.readdir(snapshotsDir).catch(() => []);
    for (const snapshot of snapshots) {
      const snapshotDir = path.join(snapshotsDir, snapshot);
      if (
        fs.existsSync(path.join(snapshotDir, 'developer.secrets.json'))
        && fs.existsSync(path.join(snapshotDir, 'Local State'))
      ) {
        return snapshotDir;
      }
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for a decryptable developer secret vault snapshot');
}

async function runDeveloperApp(port, task) {
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawn(electronBin, electronArgsFor(port), {
    cwd: electronCwd,
    env: {
      ...process.env,
      AHT_ALLOW_DEVELOPER: '1',
      AHT_LAUNCHER_SOURCE_ROOT: process.cwd(),
      AHT_TEST_HOOKS: '1',
      AHT_DEVELOPER_VAULT_DIR: vaultDir,
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
    const target = await waitForTarget(endpoint);
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
    return await task(client);
  } finally {
    if (client) {
      await client.call('Browser.close').catch(() => {});
      client.close();
    }
    child.kill();
    await sleep(600);
  }
}

await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir: path.join(root, 'instance'),
  latestUrl: '',
  curseforge: { proxyBaseUrl: '', apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: '', playerLabel: 'SmokeUser' },
  developer: { adminBaseUrl: '', defaultOutDir: path.join(root, 'release'), defaultCacheModsDir: '', r2Bucket: 'ahtlauncher' },
  minecraftLauncher: { enabled: false, rootDir: path.join(root, 'minecraft'), profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 4096 },
  playCommand: { command: '', args: [], cwd: path.join(root, 'instance') }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'smoke-install',
  minecraftUsername: 'SmokeUser'
});

const saved = await runDeveloperApp(basePort, async (client) => {
  await evaluate(client, `
    (() => {
      const input = document.querySelector('#curseforgeApiKeyInput');
      const proofInput = document.querySelector('#launcherProofSecretInput');
      const r2AccountInput = document.querySelector('#r2AccountIdInput');
      const r2AccessInput = document.querySelector('#r2AccessKeyIdInput');
      const r2SecretInput = document.querySelector('#r2SecretAccessKeyInput');
      input.value = ${JSON.stringify(secretValue)};
      proofInput.value = ${JSON.stringify(proofSecretValue)};
      r2AccountInput.value = ${JSON.stringify(r2AccountValue)};
      r2AccessInput.value = ${JSON.stringify(r2AccessKeyValue)};
      r2SecretInput.value = ${JSON.stringify(r2SecretKeyValue)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      proofInput.dispatchEvent(new Event('input', { bubbles: true }));
      r2AccountInput.dispatchEvent(new Event('input', { bubbles: true }));
      r2AccessInput.dispatchEvent(new Event('input', { bubbles: true }));
      r2SecretInput.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const saveResult = await evaluate(client, `window.aht.devSaveSecrets(${JSON.stringify({
    curseforgeApiKey: secretValue,
    launcherProofSecret: proofSecretValue,
    r2AccountId: r2AccountValue,
    r2AccessKeyId: r2AccessKeyValue,
    r2SecretAccessKey: r2SecretKeyValue
  })}).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error?.message || error) }))`);
  await sleep(800);
  const result = await evaluate(client, `window.aht.devGetSecrets().then((secrets) => ({ ok: true, secrets })).catch((error) => ({ ok: false, error: String(error?.message || error) }))`);
  if (!result.ok || result.secrets?.curseforgeApiKey !== secretValue || result.secrets?.launcherProofSecret !== proofSecretValue) {
    const developerLog = await evaluate(client, `document.querySelector('#developerLog')?.textContent || document.querySelector('#releaseCheckDetail')?.textContent || ''`);
    throw new Error(`Developer secrets did not persist: ${JSON.stringify({ saveResult, result, developerLog })}`);
  }
  await waitForVaultSnapshotProfile();
  return result.secrets;
});

if (saved.curseforgeApiKey !== secretValue || saved.launcherProofSecret !== proofSecretValue || saved.r2AccountId !== r2AccountValue || saved.r2AccessKeyId !== r2AccessKeyValue || saved.r2SecretAccessKey !== r2SecretKeyValue) {
  throw new Error(`Developer secrets did not save before reload: ${JSON.stringify(saved)}`);
}

const vaultSnapshots = await fsp.readdir(path.join(vaultDir, 'snapshots'));
const decryptableVaultSnapshot = vaultSnapshots.some((snapshot) => {
  const snapshotDir = path.join(vaultDir, 'snapshots', snapshot);
  return fs.existsSync(path.join(snapshotDir, 'developer.secrets.json'))
    && fs.existsSync(path.join(snapshotDir, 'Local State'));
});
if (!decryptableVaultSnapshot) {
  throw new Error(`Developer secret vault snapshot was not created: ${JSON.stringify(vaultSnapshots)}`);
}

await fsp.rm(path.join(userData, 'developer.secrets.json'), { force: true });
await fsp.rm(path.join(userData, 'Local State'), { force: true });

const restored = await runDeveloperApp(basePort + 1, async (client) => {
  await waitFor(client, `document.querySelector('#curseforgeApiKeyInput').value === ${JSON.stringify(secretValue)} && document.querySelector('#launcherProofSecretInput').value === ${JSON.stringify(proofSecretValue)}`, 'restored developer secrets');
  const afterBlankSave = await evaluate(client, `(async () => {
    await window.aht.devSaveSecrets({
      curseforgeApiKey: '',
      serverSshPassword: '',
      launcherProofSecret: '',
      githubToken: '',
      r2AccountId: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: ''
    });
    return window.aht.devGetSecrets();
  })()`);
  return evaluate(client, `(async () => ({
    field: document.querySelector('#curseforgeApiKeyInput').value,
    proofField: document.querySelector('#launcherProofSecretInput').value,
    r2AccountField: document.querySelector('#r2AccountIdInput').value,
    r2AccessField: document.querySelector('#r2AccessKeyIdInput').value,
    r2SecretField: document.querySelector('#r2SecretAccessKeyInput').value,
    status: await window.aht.getStatus(),
    afterBlankSave: ${JSON.stringify(afterBlankSave)}
  }))()`);
});

const status = restored.status;
if (restored.field !== secretValue || restored.proofField !== proofSecretValue || restored.r2AccountField !== r2AccountValue || restored.r2AccessField !== r2AccessKeyValue || restored.r2SecretField !== r2SecretKeyValue) {
  throw new Error(`Developer secret fields were not restored: ${JSON.stringify(restored)}`);
}
if (restored.afterBlankSave?.curseforgeApiKey !== secretValue || restored.afterBlankSave?.launcherProofSecret !== proofSecretValue || restored.afterBlankSave?.r2SecretAccessKey !== r2SecretKeyValue) {
  throw new Error(`Blank developer form save removed existing secrets: ${JSON.stringify(restored.afterBlankSave)}`);
}
if (status.config?.developer?.curseforgeApiKey || status.config?.developer?.launcherProofSecret || status.config?.developer?.r2AccessKeyId || status.config?.developer?.r2SecretAccessKey) {
  throw new Error(`Developer secrets leaked into launcher config: ${JSON.stringify(status.config.developer)}`);
}

console.log(JSON.stringify({
  ok: true,
  root,
  secretRestored: restored.field === secretValue,
  proofSecretRestored: restored.proofField === proofSecretValue,
  r2SecretsRestored: restored.r2AccountField === r2AccountValue && restored.r2AccessField === r2AccessKeyValue && restored.r2SecretField === r2SecretKeyValue,
  vaultRestoredAfterUserDataReset: restored.afterBlankSave?.curseforgeApiKey === secretValue,
  blankSavePreservedSecrets: restored.afterBlankSave?.r2SecretAccessKey === r2SecretKeyValue,
  secretStoredOutsideConfig: !status.config?.developer?.curseforgeApiKey && !status.config?.developer?.launcherProofSecret && !status.config?.developer?.r2AccessKeyId && !status.config?.developer?.r2SecretAccessKey,
  encrypted: Boolean(status.developerSecrets?.encrypted),
  encryptionAvailable: Boolean(status.developerSecrets?.encryptionAvailable)
}, null, 2));
