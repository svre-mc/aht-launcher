import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10790);
const endpoint = `http://127.0.0.1:${port}`;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-setup-actions-'));
const userData = path.join(root, 'userData');
const appDefaults = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'A Hard Time');
const minecraftRoot = path.join(root, '.minecraft');
const latestPath = path.join(root, 'latest.json');
const externalCapturePath = path.join(root, 'external-open.jsonl');
const fakeOpenScript = path.join(root, 'fake-minecraft-launcher.cjs');
const fakeOpenMarker = path.join(root, 'fake-minecraft-launcher-opened.json');
const fakeLocalAppData = path.join(root, 'localappdata');
const fakeProgramFiles = path.join(root, 'program-files');
const fakeProgramData = path.join(root, 'program-data');
const fakePublic = path.join(root, 'public');
const fakeAppData = path.join(root, 'appdata');
const fakeUserProfile = path.join(root, 'profile');
const fakeHome = path.join(root, 'home');
const detectedInstanceDir = path.join(fakeUserProfile, 'curseforge', 'minecraft', 'Instances', 'RLCraft Dregora');
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
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await evaluate(client, expression);
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const text = await fsp.readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForFile(file, label, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (fs.existsSync(file)) {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${file}`);
}

await fsp.mkdir(instanceDir, { recursive: true });
await fsp.mkdir(minecraftRoot, { recursive: true });
await fsp.mkdir(fakeLocalAppData, { recursive: true });
await fsp.mkdir(fakeProgramFiles, { recursive: true });
await fsp.mkdir(fakeProgramData, { recursive: true });
await fsp.mkdir(fakePublic, { recursive: true });
await fsp.mkdir(fakeAppData, { recursive: true });
await fsp.mkdir(fakeUserProfile, { recursive: true });
await fsp.mkdir(path.join(fakeUserProfile, 'Documents'), { recursive: true });
await fsp.mkdir(fakeHome, { recursive: true });
await fsp.mkdir(path.join(detectedInstanceDir, 'mods'), { recursive: true });
await fsp.writeFile(path.join(detectedInstanceDir, 'mods', 'detected-aht-pack.jar'), 'detected-pack', 'utf8');
await fsp.writeFile(fakeOpenScript, `
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  disableRtss: process.env.DISABLE_RTSS_LAYER || '',
  disableObs: process.env.DISABLE_VULKAN_OBS_CAPTURE || ''
}, null, 2));
`, 'utf8');
await writeJson(latestPath, {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '9.9.9',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  },
  zip: {
    path: 'packs/a-hard-time-9.9.9.zip',
    size: 123,
    sha256: '0'.repeat(64)
  }
});
await writeJson(appDefaults, {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: latestPath,
  launcherUpdate: { enabled: false, latestUrl: '' },
  minecraftLauncher: {
    enabled: true,
    rootDir: minecraftRoot,
    profileId: 'a-hard-time',
    profileName: 'A Hard Time',
    memoryMb: 4096
  },
  playCommand: {
    command: '',
    args: [],
    cwd: instanceDir
  }
});
const damagedConfigPath = path.join(userData, 'launcher.config.json');
await fsp.mkdir(userData, { recursive: true });
await fsp.writeFile(damagedConfigPath, '[', 'utf8');

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_APP_DEFAULTS: appDefaults,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_USER_DATA: userData,
    AHT_TEST_LOCAL_INSTANCE_DIR: detectedInstanceDir,
    AHT_TEST_OPEN_EXTERNAL_CAPTURE_PATH: externalCapturePath,
    AHT_TEST_SETUP_JAVA_MODE: 'checked-on-play',
    AHT_DISABLE_COMMON_MINECRAFT_LAUNCHER_DRIVES: '1',
    ELECTRON_ENABLE_LOGGING: '0',
    LOCALAPPDATA: fakeLocalAppData,
    APPDATA: fakeAppData,
    USERPROFILE: fakeUserProfile,
    HOME: fakeHome,
    ProgramFiles: fakeProgramFiles,
    'ProgramFiles(x86)': fakeProgramFiles,
    ProgramW6432: fakeProgramFiles,
    ProgramData: fakeProgramData,
    PROGRAMDATA: fakeProgramData,
    ALLUSERSPROFILE: fakeProgramData,
    PUBLIC: fakePublic,
    OneDrive: path.join(fakeHome, 'OneDrive'),
    OneDriveConsumer: path.join(fakeHome, 'OneDrive'),
    OneDriveCommercial: path.join(fakeHome, 'OneDriveBusiness')
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
  const recoveredConfig = JSON.parse(await fsp.readFile(damagedConfigPath, 'utf8'));
  const damagedConfigBackups = (await fsp.readdir(userData)).filter((entry) => /^launcher\.config\.json\.corrupt-.*\.bak$/.test(entry));
  if (recoveredConfig.instanceDir !== instanceDir || recoveredConfig.minecraftLauncher?.rootDir !== minecraftRoot) {
    throw new Error(`Damaged launcher config did not recover from packaged defaults: ${JSON.stringify(recoveredConfig)}`);
  }
  if (!damagedConfigBackups.length) {
    throw new Error('Damaged launcher config was not backed up before recovery.');
  }
  const damagedBackupText = await fsp.readFile(path.join(userData, damagedConfigBackups[0]), 'utf8');
  if (damagedBackupText !== '[') {
    throw new Error(`Damaged launcher config backup did not preserve the broken file: ${JSON.stringify(damagedBackupText)}`);
  }
  await waitFor(client, `document.querySelector('#statusBadge')?.textContent !== 'Checking'`, 'initial status render');
  await evaluate(client, `document.querySelector('.nav [data-tab="settings"]')?.click(); true`);
  await waitFor(client, `document.querySelector('#settings')?.classList.contains('active')`, 'settings tab');

  const missingProof = await evaluate(client, `
    (() => {
      const card = document.querySelector('#setupAssistantCard');
      const getLauncher = document.querySelector('#setupDownloadMinecraftButton');
      const openMinecraft = document.querySelector('#setupOpenMinecraftButton');
      const javaHelp = document.querySelector('#setupJavaHelpButton');
      const state = {
        settingsActive: document.querySelector('#settings')?.classList.contains('active'),
        cardExists: Boolean(card),
        cardHidden: card?.hidden,
        cardClass: card?.className || '',
        title: document.querySelector('#setupAssistantTitle')?.textContent || '',
        detail: document.querySelector('#setupAssistantDetail')?.textContent || '',
        statusBadge: document.querySelector('#statusBadge')?.textContent || '',
        bodyText: document.body.innerText.slice(0, 800),
        getLauncherHidden: getLauncher?.hidden,
        getLauncherDisabled: getLauncher?.classList.contains('is-disabled') || getLauncher?.getAttribute('aria-disabled') === 'true',
        openMinecraftHidden: openMinecraft?.hidden,
        javaHelpHidden: javaHelp?.hidden,
        javaHelpDisabled: javaHelp?.classList.contains('is-disabled') || javaHelp?.getAttribute('aria-disabled') === 'true'
      };
      return state;
    })()
  `);
  if (missingProof.cardHidden || !missingProof.title.includes('Install Minecraft Launcher') || missingProof.getLauncherHidden || missingProof.getLauncherDisabled || !missingProof.openMinecraftHidden || missingProof.javaHelpHidden || missingProof.javaHelpDisabled) {
    throw new Error(`Setup assistant buttons are wrong for missing launcher state: ${JSON.stringify(missingProof)}`);
  }
  if (missingProof.detail.includes('Microsoft account: saved') || !missingProof.detail.includes('Microsoft account: checked after install')) {
    throw new Error(`Missing-launcher setup should not claim Microsoft account readiness: ${JSON.stringify(missingProof)}`);
  }
  if (!missingProof.detail.includes('Install folder: empty')) {
    throw new Error(`Empty configured instance folder should be called out in setup: ${JSON.stringify(missingProof)}`);
  }

  const autoSetupProof = await evaluate(client, `
    (async () => {
      const status = await window.aht.setupApply();
      return {
        instanceDir: status.config?.instanceDir || '',
        playCwd: status.config?.playCommand?.cwd || '',
        setup: status.setup || {}
      };
    })()
  `);
  if (autoSetupProof.instanceDir !== instanceDir || autoSetupProof.playCwd !== instanceDir || autoSetupProof.instanceDir === detectedInstanceDir) {
    throw new Error(`Auto setup should keep the managed AHT install folder instead of adopting an old detected instance: ${JSON.stringify(autoSetupProof)}`);
  }

  await evaluate(client, `document.querySelector('#setupDownloadMinecraftButton')?.click(); true`);
  await waitFor(client, `document.body.innerText.includes('AHT opened the official Minecraft Launcher download page')`, 'Minecraft download toast');
  await evaluate(client, `document.querySelector('#setupJavaHelpButton')?.click(); true`);
  await waitFor(client, `document.body.innerText.includes('AHT opened the Java 8 download page')`, 'Java help toast');

  const capturesAfterLinks = await waitFor(client, `
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return true;
    })()
  `, 'external capture delay').then(() => readJsonLines(externalCapturePath));
  const capturedUrls = capturesAfterLinks.map((entry) => entry.url);
  if (!capturedUrls.includes('https://www.minecraft.net/download') || !capturedUrls.some((url) => url.includes('adoptium.net/temurin/releases'))) {
    throw new Error(`Setup external actions were not captured: ${JSON.stringify(capturesAfterLinks)}`);
  }

  await fsp.mkdir(path.join(instanceDir, 'mods'), { recursive: true });
  await fsp.writeFile(path.join(instanceDir, 'mods', 'aht-setup-smoke.jar'), 'pack-present', 'utf8');

  await evaluate(client, `
    (async () => {
      const status = await window.aht.getStatus();
      await window.aht.saveSettings({
        ...status.config,
        minecraftLauncher: {
          ...status.config.minecraftLauncher,
          rootDir: ${JSON.stringify(minecraftRoot)},
          openCommand: ${JSON.stringify(process.execPath)},
          openArgs: [${JSON.stringify(fakeOpenScript)}, ${JSON.stringify(fakeOpenMarker)}]
        }
      });
      window.location.reload();
      return true;
    })()
  `);
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'reloaded player DOM');
  await evaluate(client, `document.querySelector('.nav [data-tab="settings"]')?.click(); true`);
  const signInProof = await waitFor(client, `
    (() => {
      const openMinecraft = document.querySelector('#setupOpenMinecraftButton');
      const getLauncher = document.querySelector('#setupDownloadMinecraftButton');
      const title = document.querySelector('#setupAssistantTitle')?.textContent || '';
      const detail = document.querySelector('#setupAssistantDetail')?.textContent || '';
      const state = {
        title,
        detail,
        openMinecraftHidden: openMinecraft?.hidden,
        openMinecraftDisabled: openMinecraft?.classList.contains('is-disabled') || openMinecraft?.getAttribute('aria-disabled') === 'true',
        getLauncherHidden: getLauncher?.hidden
      };
      return title ? state : false;
    })()
  `, 'post-save setup state');
  if (!signInProof.title.includes('Microsoft sign-in needed') || signInProof.openMinecraftHidden || signInProof.openMinecraftDisabled || !signInProof.getLauncherHidden) {
    throw new Error(`Setup assistant buttons are wrong for sign-in state: ${JSON.stringify(signInProof)}`);
  }

  await evaluate(client, `document.querySelector('#setupOpenMinecraftButton')?.click(); true`);
  const fakeOpen = await waitForFile(fakeOpenMarker, 'fake Minecraft Launcher open');
  if (fakeOpen.disableRtss !== '1' || fakeOpen.disableObs !== '1') {
    throw new Error(`Minecraft Launcher setup action did not use the protected launch env: ${JSON.stringify(fakeOpen)}`);
  }

  await fsp.mkdir(minecraftRoot, { recursive: true });
  await fsp.writeFile(path.join(minecraftRoot, 'launcher_msa_credentials.bin'), 'credential-cache-only', 'utf8');
  await evaluate(client, `window.location.reload(); true`);
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'reloaded player DOM after credential cache');
  await evaluate(client, `document.querySelector('.nav [data-tab="settings"]')?.click(); true`);
  const credentialOnlyProof = await waitFor(client, `
    (() => {
      const openMinecraft = document.querySelector('#setupOpenMinecraftButton');
      const getLauncher = document.querySelector('#setupDownloadMinecraftButton');
      const title = document.querySelector('#setupAssistantTitle')?.textContent || '';
      const detail = document.querySelector('#setupAssistantDetail')?.textContent || '';
      return title ? {
        title,
        detail,
        openMinecraftHidden: openMinecraft?.hidden,
        openMinecraftDisabled: openMinecraft?.classList.contains('is-disabled') || openMinecraft?.getAttribute('aria-disabled') === 'true',
        getLauncherHidden: getLauncher?.hidden
      } : false;
    })()
  `, 'credential-only setup state');
  if (!credentialOnlyProof.title.includes('Open Minecraft Launcher') || !credentialOnlyProof.detail.includes('Microsoft account: open Minecraft once') || credentialOnlyProof.detail.includes('Microsoft account: saved') || credentialOnlyProof.openMinecraftHidden || credentialOnlyProof.openMinecraftDisabled || !credentialOnlyProof.getLauncherHidden) {
    throw new Error(`Credential-only setup should ask the player to open Minecraft once, not claim saved account readiness: ${JSON.stringify(credentialOnlyProof)}`);
  }

  await writeJson(path.join(minecraftRoot, 'launcher_accounts.json'), {
    activeAccountLocalId: 'active',
    accounts: {
      active: {
        type: 'Xbox',
        minecraftProfile: { name: 'SetupRecovered' }
      }
    }
  });
  await evaluate(client, `window.location.reload(); true`);
  await waitFor(client, "document.readyState === 'complete' && window.aht", 'reloaded player DOM after account file');
  await evaluate(client, `document.querySelector('.nav [data-tab="settings"]')?.click(); true`);
  const recoveredAuthProof = await waitFor(client, `
    (() => {
      const openMinecraft = document.querySelector('#setupOpenMinecraftButton');
      const title = document.querySelector('#setupAssistantTitle')?.textContent || '';
      const detail = document.querySelector('#setupAssistantDetail')?.textContent || '';
      return title ? {
        title,
        detail,
        openMinecraftHidden: openMinecraft?.hidden,
        openMinecraftDisabled: openMinecraft?.classList.contains('is-disabled') || openMinecraft?.getAttribute('aria-disabled') === 'true'
      } : false;
    })()
  `, 'custom-root account setup state');
  if (!recoveredAuthProof.title.includes('Launcher ready') || !recoveredAuthProof.detail.includes('Microsoft account: saved') || !recoveredAuthProof.openMinecraftHidden) {
    throw new Error(`Setup assistant did not trust the configured Minecraft root account: ${JSON.stringify(recoveredAuthProof)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    packaged: Boolean(smokeExe),
    missingProof,
    autoSetupProof,
    signInProof,
    credentialOnlyProof,
    recoveredAuthProof,
    capturedUrls,
    fakeOpen
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
}
