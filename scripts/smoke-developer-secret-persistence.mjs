import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const basePort = Number(process.argv[2] || (12000 + Math.floor(Math.random() * 20000)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-dev-secret-'));
const userData = path.join(root, 'userData');
const vaultDir = path.join(root, 'developer-secret-vault');
const splitUserData = path.join(root, 'split-userData');
const splitVaultDir = path.join(root, 'split-developer-secret-vault');
const secretValue = 'fake-cf-key-persisted';
const proofSecretValue = 'proof-secret-persisted';
const socialSecretValue = 'social-server-secret-persisted-at-least-32-bytes';
const r2AccountValue = 'abc123abc123abc123abc123abc123ab';
const r2AccessKeyValue = 'r2-access-key-persisted';
const r2SecretKeyValue = 'r2-secret-key-persisted';
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgsFor = (port, targetUserData = userData) => smokeExe
  ? ['--developer', `--remote-debugging-port=${port}`, `--user-data-dir=${targetUserData}`]
  : ['.', '--developer', `--remote-debugging-port=${port}`, `--user-data-dir=${targetUserData}`];
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

async function readDeveloperWindowChrome(client, contentSelector) {
  return evaluate(client, `(() => {
    const rectOf = (node) => {
      const rect = node?.getBoundingClientRect();
      return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    };
    const frame = document.querySelector('.app-frame');
    const drag = document.querySelector('#developerWindowDragRegion');
    const controls = document.querySelector('.window-controls');
    const minimize = document.querySelector('#windowMinimizeButton');
    const close = document.querySelector('#windowCloseButton');
    const content = document.querySelector(${JSON.stringify(contentSelector)});
    const dragStyle = drag ? getComputedStyle(drag) : null;
    const controlsStyle = controls ? getComputedStyle(controls) : null;
    const hitMap = (node) => {
      const rect = node?.getBoundingClientRect();
      if (!rect) return [];
      const xs = [rect.left + 3, rect.left + rect.width / 2, rect.right - 3];
      const ys = [rect.top + 3, rect.top + rect.height / 2, rect.bottom - 3];
      return ys.flatMap((y) => xs.map((x) => {
        const target = document.elementFromPoint(x, y);
        return { directId: target?.id || '', directTag: target?.tagName || '' };
      }));
    };
    return {
      controlsDirectlyOwnedByFrame: controls?.parentElement === frame,
      dragDisplay: dragStyle?.display || '',
      dragAppRegion: dragStyle?.getPropertyValue('-webkit-app-region') || '',
      controlsDisplay: controlsStyle?.display || '',
      controlsPointerEvents: controlsStyle?.pointerEvents || '',
      drag: rectOf(drag),
      controls: rectOf(controls),
      minimize: rectOf(minimize),
      close: rectOf(close),
      minimizeHitMap: hitMap(minimize),
      closeHitMap: hitMap(close),
      minimizeSpanPointerEvents: minimize?.querySelector('span') ? getComputedStyle(minimize.querySelector('span')).pointerEvents : '',
      closeSpanPointerEvents: close?.querySelector('span') ? getComputedStyle(close.querySelector('span')).pointerEvents : '',
      content: rectOf(content)
    };
  })()`);
}

function assertDeveloperWindowChrome(proof, phase) {
  if (
    !proof?.controlsDirectlyOwnedByFrame
    || proof.dragDisplay === 'none'
    || proof.dragAppRegion.trim() !== 'drag'
    || proof.controlsDisplay === 'none'
    || proof.controlsPointerEvents === 'none'
    || proof.drag?.height < 33
    || proof.minimize?.width < 33
    || proof.minimize?.height < 33
    || proof.close?.width < 33
    || proof.close?.height < 33
    || proof.minimizeHitMap?.length !== 9
    || proof.minimizeHitMap.some((hit) => hit.directId !== 'windowMinimizeButton')
    || proof.closeHitMap?.length !== 9
    || proof.closeHitMap.some((hit) => hit.directId !== 'windowCloseButton')
    || proof.minimizeSpanPointerEvents !== 'none'
    || proof.closeSpanPointerEvents !== 'none'
    || proof.drag.right > proof.controls.left + 0.5
    || proof.content?.top < proof.drag.bottom
  ) {
    throw new Error(`Developer window chrome failed during ${phase}: ${JSON.stringify(proof)}`);
  }
}

async function runDeveloperApp(port, task, targetUserData = userData, targetVaultDir = vaultDir) {
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawn(electronBin, electronArgsFor(port, targetUserData), {
    cwd: electronCwd,
    env: {
      ...process.env,
      AHT_ALLOW_DEVELOPER: '1',
      AHT_LAUNCHER_SOURCE_ROOT: process.cwd(),
      AHT_TEST_HOOKS: '1',
      AHT_TEST_USER_DATA: targetUserData,
      AHT_DEVELOPER_VAULT_DIR: targetVaultDir,
      AHT_DEVELOPER_USERNAME: '',
      AHT_DEVELOPER_PASSWORD: '',
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
    await waitFor(client, `
      (() => {
        const frame = document.querySelector('.app-frame');
        const controls = document.querySelector('.window-controls');
        return document.readyState === 'complete'
          && document.body.classList.contains('is-launcher-ready')
          && !document.body.classList.contains('is-booting')
          && frame
          && !frame.hasAttribute('inert')
          && frame.getAttribute('aria-hidden') !== 'true'
          && controls
          && getComputedStyle(controls).visibility === 'visible'
          && getComputedStyle(controls).pointerEvents !== 'none'
          && document.querySelector('#developerLoginForm');
      })()
    `, 'interactive developer login DOM');
    await waitFor(client, "document.body.classList.contains('dev-mode') && document.body.classList.contains('dev-locked')", 'locked developer shell');
    assertDeveloperWindowChrome(await readDeveloperWindowChrome(client, '#developerLoginScreen .dev-login-box'), 'locked login');
    await evaluate(client, `
      (() => {
        document.querySelector('#adminPasswordInput').value = 'test-dev-password';
        document.querySelector('#developerLoginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()
    `);
    await waitFor(client, "document.body.classList.contains('dev-locked') === false", 'developer unlock');
    await waitFor(client, "document.querySelector('#developerConsole:not([hidden])')", 'developer console');
    assertDeveloperWindowChrome(await readDeveloperWindowChrome(client, '#developerConsole .dev-header'), 'unlocked console');
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
  minecraftLauncher: { enabled: false, rootDir: path.join(root, 'minecraft'), profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 6144 },
  playCommand: { command: '', args: [], cwd: path.join(root, 'instance') }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'smoke-install',
  minecraftUsername: 'SmokeUser'
});
await writeJson(path.join(userData, 'developer.credentials.json'), {
  schemaVersion: 1,
  username: 'admin',
  password: 'test-dev-password'
});

const saved = await runDeveloperApp(basePort, async (client) => {
  await evaluate(client, `
    (() => {
      const input = document.querySelector('#curseforgeApiKeyInput');
      const proofInput = document.querySelector('#launcherProofSecretInput');
      const socialInput = document.querySelector('#socialServerSecretInput');
      const r2AccountInput = document.querySelector('#r2AccountIdInput');
      const r2AccessInput = document.querySelector('#r2AccessKeyIdInput');
      const r2SecretInput = document.querySelector('#r2SecretAccessKeyInput');
      input.value = ${JSON.stringify(secretValue)};
      proofInput.value = ${JSON.stringify(proofSecretValue)};
      socialInput.value = ${JSON.stringify(socialSecretValue)};
      r2AccountInput.value = ${JSON.stringify(r2AccountValue)};
      r2AccessInput.value = ${JSON.stringify(r2AccessKeyValue)};
      r2SecretInput.value = ${JSON.stringify(r2SecretKeyValue)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      proofInput.dispatchEvent(new Event('input', { bubbles: true }));
      socialInput.dispatchEvent(new Event('input', { bubbles: true }));
      r2AccountInput.dispatchEvent(new Event('input', { bubbles: true }));
      r2AccessInput.dispatchEvent(new Event('input', { bubbles: true }));
      r2SecretInput.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const saveResult = await evaluate(client, `window.aht.devSaveSecrets(${JSON.stringify({
    curseforgeApiKey: secretValue,
    launcherProofSecret: proofSecretValue,
    socialServerSecret: socialSecretValue,
    r2AccountId: r2AccountValue,
    r2AccessKeyId: r2AccessKeyValue,
    r2SecretAccessKey: r2SecretKeyValue
  })}).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error?.message || error) }))`);
  await sleep(800);
  const result = await evaluate(client, `window.aht.devGetSecrets().then((secrets) => ({ ok: true, secrets })).catch((error) => ({ ok: false, error: String(error?.message || error) }))`);
  if (!result.ok || result.secrets?.curseforgeApiKey !== secretValue || result.secrets?.launcherProofSecret !== proofSecretValue || result.secrets?.socialServerSecret !== socialSecretValue) {
    const developerLog = await evaluate(client, `document.querySelector('#developerLog')?.textContent || document.querySelector('#releaseCheckDetail')?.textContent || ''`);
    throw new Error(`Developer secrets did not persist: ${JSON.stringify({ saveResult, result, developerLog })}`);
  }
  await waitForVaultSnapshotProfile();
  return result.secrets;
});

if (saved.curseforgeApiKey !== secretValue || saved.launcherProofSecret !== proofSecretValue || saved.socialServerSecret !== socialSecretValue || saved.r2AccountId !== r2AccountValue || saved.r2AccessKeyId !== r2AccessKeyValue || saved.r2SecretAccessKey !== r2SecretKeyValue) {
  throw new Error(`Developer secrets did not save before reload: ${JSON.stringify(saved)}`);
}
const migratedCredentials = JSON.parse(await fsp.readFile(path.join(userData, 'developer.credentials.json'), 'utf8'));
if (migratedCredentials.password || migratedCredentials.protectedPassword?.encrypted !== true) {
  throw new Error(`Legacy developer credentials were not migrated to OS protection: ${JSON.stringify(migratedCredentials)}`);
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
  await waitFor(client, `document.querySelector('#curseforgeApiKeyInput').value === ${JSON.stringify(secretValue)} && document.querySelector('#launcherProofSecretInput').value === ${JSON.stringify(proofSecretValue)} && document.querySelector('#socialServerSecretInput').value === ${JSON.stringify(socialSecretValue)}`, 'restored developer secrets');
  const afterBlankSave = await evaluate(client, `(async () => {
    await window.aht.devSaveSecrets({
      curseforgeApiKey: '',
      serverSshPassword: '',
      launcherProofSecret: '',
      socialServerSecret: '',
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
    socialField: document.querySelector('#socialServerSecretInput').value,
    r2AccountField: document.querySelector('#r2AccountIdInput').value,
    r2AccessField: document.querySelector('#r2AccessKeyIdInput').value,
    r2SecretField: document.querySelector('#r2SecretAccessKeyInput').value,
    status: await window.aht.getStatus(),
    afterBlankSave: ${JSON.stringify(afterBlankSave)}
  }))()`);
});

const status = restored.status;
if (restored.field !== secretValue || restored.proofField !== proofSecretValue || restored.socialField !== socialSecretValue || restored.r2AccountField !== r2AccountValue || restored.r2AccessField !== r2AccessKeyValue || restored.r2SecretField !== r2SecretKeyValue) {
  throw new Error(`Developer secret fields were not restored: ${JSON.stringify(restored)}`);
}
if (restored.afterBlankSave?.curseforgeApiKey !== secretValue || restored.afterBlankSave?.launcherProofSecret !== proofSecretValue || restored.afterBlankSave?.socialServerSecret !== socialSecretValue || restored.afterBlankSave?.r2SecretAccessKey !== r2SecretKeyValue) {
  throw new Error(`Blank developer form save removed existing secrets: ${JSON.stringify(restored.afterBlankSave)}`);
}
if (status.config?.developer?.curseforgeApiKey || status.config?.developer?.launcherProofSecret || status.config?.developer?.socialServerSecret || status.config?.developer?.r2AccessKeyId || status.config?.developer?.r2SecretAccessKey) {
  throw new Error(`Developer secrets leaked into launcher config: ${JSON.stringify(status.config.developer)}`);
}

await fsp.mkdir(splitUserData, { recursive: true });
await fsp.copyFile(path.join(userData, 'launcher.config.json'), path.join(splitUserData, 'launcher.config.json'));
await fsp.copyFile(path.join(userData, 'identity.json'), path.join(splitUserData, 'identity.json'));
await writeJson(path.join(splitUserData, 'developer.credentials.json'), {
  schemaVersion: 1,
  username: 'admin',
  password: 'test-dev-password'
});

await runDeveloperApp(basePort + 2, async (client) => {
  const initialStatus = await evaluate(client, `window.aht.getStatus().then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error?.message || error) }))`);
  if (!initialStatus.ok) throw new Error(`Split-profile seed status failed: ${JSON.stringify(initialStatus)}`);
}, splitUserData, splitVaultDir);

const splitLocalStateBefore = await fsp.readFile(path.join(splitUserData, 'Local State'));
const splitCredentialsBefore = await fsp.readFile(path.join(splitUserData, 'developer.credentials.json'));
const originalSplitDevice = JSON.parse(await fsp.readFile(path.join(splitUserData, 'device-identity.json'), 'utf8'));
if (originalSplitDevice.privateKey?.encrypted !== true) {
  throw new Error('Split-profile seed did not create an OS-protected device identity.');
}

const sourceSecrets = JSON.parse(await fsp.readFile(path.join(userData, 'developer.secrets.json'), 'utf8'));
const unreadableSecrets = {
  ...sourceSecrets,
  secrets: Object.fromEntries(Object.entries(sourceSecrets.secrets || {}).map(([key, record]) => [key, {
    ...record,
    encrypted: true,
    value: Buffer.from(`intentionally-unreadable-${key}`, 'utf8').toString('base64')
  }]))
};
await writeJson(path.join(splitUserData, 'developer.secrets.json'), unreadableSecrets);
const staleSecrets = await fsp.readFile(path.join(splitUserData, 'developer.secrets.json'));
const unreadableSplitDevice = {
  ...originalSplitDevice,
  privateKey: {
    encrypted: true,
    value: Buffer.from('intentionally-unreadable-safe-storage-record', 'utf8').toString('base64')
  }
};
await writeJson(path.join(splitUserData, 'device-identity.json'), unreadableSplitDevice);
const unreadableSplitDeviceBytes = await fsp.readFile(path.join(splitUserData, 'device-identity.json'));

const splitRecovery = await runDeveloperApp(basePort + 3, async (client) => {
  const recoveredStatus = await evaluate(client, `window.aht.getStatus().then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error?.message || error) }))`);
  if (!recoveredStatus.ok) throw new Error(`Split-profile recovered status failed: ${JSON.stringify(recoveredStatus)}`);
  const staleSecretRead = await evaluate(client, `window.aht.devGetSecrets().then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error?.message || error) }))`);
  return {
    configPackId: recoveredStatus.value?.config?.packId || '',
    configBucket: recoveredStatus.value?.config?.developer?.r2Bucket || '',
    staleSecretRead
  };
}, splitUserData, vaultDir);

const splitLocalStateAfter = await fsp.readFile(path.join(splitUserData, 'Local State'));
const splitCredentialsAfter = await fsp.readFile(path.join(splitUserData, 'developer.credentials.json'));
const staleSecretsAfter = await fsp.readFile(path.join(splitUserData, 'developer.secrets.json'));
const recoveredSplitDevice = JSON.parse(await fsp.readFile(path.join(splitUserData, 'device-identity.json'), 'utf8'));
const recoveryBackup = String(recoveredSplitDevice.previousIdentityBackup || '');
if (!splitLocalStateAfter.equals(splitLocalStateBefore)) {
  throw new Error('A live developer Local State was replaced by an older vault encryption profile.');
}
if (!splitCredentialsAfter.equals(splitCredentialsBefore)) {
  throw new Error('Protected developer credentials changed during split-profile recovery.');
}
if (!staleSecretsAfter.equals(staleSecrets)) {
  throw new Error('Unreadable encrypted developer secret records were modified or wiped during recovery.');
}
if (
  recoveredSplitDevice.recoveredFrom !== 'unreadable-developer-device-identity'
  || recoveredSplitDevice.privateKey?.encrypted !== true
  || !recoveryBackup
  || !fs.existsSync(recoveryBackup)
  || !(await fsp.readFile(recoveryBackup)).equals(unreadableSplitDeviceBytes)
) {
  throw new Error(`Unreadable developer device identity was not preserved and securely recreated: ${JSON.stringify(recoveredSplitDevice)}`);
}
if (
  splitRecovery.configPackId !== 'a-hard-time-dregora'
  || splitRecovery.configBucket !== 'ahtlauncher'
  || splitRecovery.staleSecretRead?.ok !== true
  || !splitRecovery.staleSecretRead?.value?.warning
  || splitRecovery.staleSecretRead.value.curseforgeApiKey
  || splitRecovery.staleSecretRead.value.launcherProofSecret
  || splitRecovery.staleSecretRead.value.socialServerSecret
  || splitRecovery.staleSecretRead.value.r2AccessKeyId
  || splitRecovery.staleSecretRead.value.r2SecretAccessKey
) {
  throw new Error(`Developer config hydration or stale-secret isolation failed: ${JSON.stringify(splitRecovery)}`);
}

console.log(JSON.stringify({
  ok: true,
  root,
  secretRestored: restored.field === secretValue,
  proofSecretRestored: restored.proofField === proofSecretValue,
  socialSecretRestored: restored.socialField === socialSecretValue,
  r2SecretsRestored: restored.r2AccountField === r2AccountValue && restored.r2AccessField === r2AccessKeyValue && restored.r2SecretField === r2SecretKeyValue,
  vaultRestoredAfterUserDataReset: restored.afterBlankSave?.curseforgeApiKey === secretValue,
  blankSavePreservedSecrets: restored.afterBlankSave?.r2SecretAccessKey === r2SecretKeyValue,
  plaintextDeveloperPasswordMigrated: !migratedCredentials.password && migratedCredentials.protectedPassword?.encrypted === true,
  liveEncryptionProfilePreserved: splitLocalStateAfter.equals(splitLocalStateBefore),
  unreadableDeviceIdentityRecovered: recoveredSplitDevice.recoveredFrom === 'unreadable-developer-device-identity',
  unreadableSecretRecordsPreserved: staleSecretsAfter.equals(staleSecrets),
  developerWindowChromeVerified: true,
  secretStoredOutsideConfig: !status.config?.developer?.curseforgeApiKey && !status.config?.developer?.launcherProofSecret && !status.config?.developer?.socialServerSecret && !status.config?.developer?.r2AccessKeyId && !status.config?.developer?.r2SecretAccessKey,
  encrypted: Boolean(status.developerSecrets?.encrypted),
  encryptionAvailable: Boolean(status.developerSecrets?.encryptionAvailable)
}, null, 2));
