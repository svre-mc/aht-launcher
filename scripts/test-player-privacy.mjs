import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10720);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-player-privacy-'));
const userData = path.join(root, 'userData');
const appDefaults = path.join(root, 'app.defaults.json');
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
    });
    socket.addEventListener('error', reject, { once: true });
  });
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(client, expression, label) {
  let last;
  for (let attempt = 0; attempt < 160; attempt += 1) {
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

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `${workerEndpoint}/`);
  const body = requestUrl.pathname === '/latest.json'
    ? JSON.stringify({ packId: 'a-hard-time-dregora', name: 'A Hard Time Dregora', version: '9.9.9', required: true, installMode: 'full-client-zip', zipFormat: 'aht-full-client-zip', zip: { url: 'packs/a-hard-time-9.9.9.zip' } })
    : JSON.stringify({ logs: [] });
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(body);
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const dirtyPrivateConfig = {
  packId: 'a-hard-time-dregora',
  instanceDir: path.join(root, 'instance'),
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: true, sendLocalChanges: true, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  developer: {
    adminBaseUrl: `${workerEndpoint}/`,
    defaultOutDir: path.join(root, 'release'),
    defaultCacheModsDir: path.join(root, 'cache-mods'),
    r2Bucket: 'ahtlauncher',
    githubRepo: 'private/dev-should-not-leak'
  },
  serverTransfer: {
    sourceDir: 'C:\\private-server-source',
    host: '192.168.1.121',
    username: 'notevil',
    remoteDir: '/home/notevil/Desktop/AHT Server Files'
  },
  launcherUpdate: { enabled: true, latestUrl: `${workerEndpoint}/launcher/latest.json` },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  minecraftLauncher: { enabled: true, profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 4096 }
};
const stalePlayerConfig = {
  ...dirtyPrivateConfig,
  launcherProof: { ...dirtyPrivateConfig.launcherProof, required: false, baseUrl: 'http://stale-player-proof.invalid/' }
};
await writeJson(appDefaults, dirtyPrivateConfig);
await writeJson(path.join(userData, 'launcher.config.json'), stalePlayerConfig);

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_APP_DEFAULTS: appDefaults,
    ELECTRON_ENABLE_LOGGING: '0'
  },
  stdio: 'ignore',
  windowsHide: true
});
let client = null;
try {
  const target = await waitForTarget();
  client = await connect(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await waitFor(client, 'document.readyState === "complete" && window.aht', 'player DOM');
  const proof = await evaluate(client, `
    (async () => {
      const status = await window.aht.getStatus();
      return {
        developerMode: status.developerMode,
        developerClientBypass: status.developerClientBypass,
        configHasDeveloper: Object.prototype.hasOwnProperty.call(status.config || {}, 'developer'),
        configHasServerTransfer: Object.prototype.hasOwnProperty.call(status.config || {}, 'serverTransfer'),
        configPath: status.configPath || '',
        platformProfileHasInstanceDir: Object.prototype.hasOwnProperty.call(status.platformProfile || {}, 'instanceDir'),
        setupKeys: Object.keys(status.setup || {}).sort(),
        setupText: JSON.stringify(status.setup || {}),
        setupAssistantText: document.querySelector('#setupAssistantDetail')?.textContent || '',
        minecraftProfileKeys: Object.keys(status.minecraftProfile || {}).sort(),
        minecraftProfileText: JSON.stringify(status.minecraftProfile || {}),
        launcherProofRequired: status.config?.launcherProof?.required,
        devApiKeys: Object.keys(window.aht || {}).filter((key) => key.startsWith('dev')).sort(),
        bodyDevMode: document.body.classList.contains('dev-mode'),
        bodyDevLocked: document.body.classList.contains('dev-locked'),
        developerTabHidden: document.querySelector('#developerTab')?.hidden,
        developerTileHidden: document.querySelector('#developerTileButton')?.hidden,
        developerConsoleHidden: document.querySelector('#developerConsole')?.hidden,
        devTextVisible: document.body.innerText.includes('Developer Console') && !document.querySelector('#developerConsole')?.hidden
      };
    })()
  `);
  if (proof.developerMode || proof.developerClientBypass || proof.configHasDeveloper || proof.configHasServerTransfer || proof.configPath || proof.platformProfileHasInstanceDir || proof.devApiKeys.length || proof.bodyDevMode || proof.bodyDevLocked || !proof.developerTabHidden || !proof.developerTileHidden || proof.devTextVisible) {
    throw new Error(`Player launcher exposed developer/private surface: ${JSON.stringify(proof)}`);
  }
  const allowedSetupKeys = ['canAutoConfigure', 'instanceExists', 'latestConfigured', 'minecraftAccountReuseAvailable'];
  if (JSON.stringify(proof.setupKeys) !== JSON.stringify(allowedSetupKeys)) {
    throw new Error(`Player setup exposed diagnostic keys: ${JSON.stringify(proof)}`);
  }
  const forbiddenSetupText = ['cache-mods', 'private-server-source', 'private/dev-should-not-leak', 'Cache mods', 'Detected instance', 'Local feed', 'configPath', 'AppData', 'curseforge', 'Dregora', 'launcher_profiles.json', 'versions', 'javaArgs', 'proofFile'];
  const leakedSetupText = forbiddenSetupText.filter((item) => proof.setupText.includes(item) || proof.setupAssistantText.includes(item));
  if (leakedSetupText.length) {
    throw new Error(`Player setup exposed private diagnostics: ${JSON.stringify({ leakedSetupText, proof })}`);
  }
  const allowedMinecraftProfileKeys = ['accountReuseAvailable', 'enabled', 'loaderId', 'loaderInstalled', 'minecraftVersion', 'profileExists', 'profileId', 'profileName', 'versionId'];
  if (JSON.stringify(proof.minecraftProfileKeys) !== JSON.stringify(allowedMinecraftProfileKeys)) {
    throw new Error(`Player minecraftProfile exposed diagnostic keys: ${JSON.stringify(proof)}`);
  }
  const leakedMinecraftProfileText = forbiddenSetupText.filter((item) => proof.minecraftProfileText.includes(item));
  if (leakedMinecraftProfileText.length) {
    throw new Error(`Player minecraftProfile exposed private diagnostics: ${JSON.stringify({ leakedMinecraftProfileText, proof })}`);
  }
  if (proof.launcherProofRequired !== true) {
    throw new Error(`Player status did not preserve required launcher proof: ${JSON.stringify(proof)}`);
  }
  const storedPlayerConfig = JSON.parse(await fsp.readFile(path.join(userData, 'launcher.config.json'), 'utf8'));
  if (Object.prototype.hasOwnProperty.call(storedPlayerConfig, 'developer') || Object.prototype.hasOwnProperty.call(storedPlayerConfig, 'serverTransfer')) {
    throw new Error(`Player launcher persisted private config blocks: ${JSON.stringify(storedPlayerConfig)}`);
  }
  if (storedPlayerConfig.latestUrl !== `${workerEndpoint}/latest.json` || storedPlayerConfig.launcherProof?.required !== true || storedPlayerConfig.launcherProof?.baseUrl !== `${workerEndpoint}/`) {
    throw new Error(`Player launcher storage scrub damaged public settings: ${JSON.stringify(storedPlayerConfig)}`);
  }
  const recommendProof = await evaluate(client, `
    (async () => {
      const setup = await window.aht.setupRecommend();
      return {
        keys: Object.keys(setup || {}).sort(),
        text: JSON.stringify(setup || {})
      };
    })()
  `);
  if (JSON.stringify(recommendProof.keys) !== JSON.stringify(allowedSetupKeys)) {
    throw new Error(`Player setupRecommend exposed diagnostic keys: ${JSON.stringify(recommendProof)}`);
  }
  const leakedRecommendText = forbiddenSetupText.filter((item) => recommendProof.text.includes(item));
  if (leakedRecommendText.length) {
    throw new Error(`Player setupRecommend exposed private diagnostics: ${JSON.stringify({ leakedRecommendText, recommendProof })}`);
  }

  const saveProof = await evaluate(client, `
    (async () => {
      const result = await window.aht.saveSettings({ minecraftLauncher: { memoryMb: 5120 } });
      return {
        configHasDeveloper: Object.prototype.hasOwnProperty.call(result.config || {}, 'developer'),
        configHasServerTransfer: Object.prototype.hasOwnProperty.call(result.config || {}, 'serverTransfer'),
        minecraftProfileKeys: Object.keys(result.minecraftProfile || {}).sort(),
        minecraftProfileText: JSON.stringify(result.minecraftProfile || {}),
        memoryMb: result.config?.minecraftLauncher?.memoryMb
      };
    })()
  `);
  if (saveProof.configHasDeveloper || saveProof.configHasServerTransfer || saveProof.memoryMb !== 5120) {
    throw new Error(`Player settings save returned unsafe config: ${JSON.stringify(saveProof)}`);
  }
  if (saveProof.minecraftProfileKeys.length && JSON.stringify(saveProof.minecraftProfileKeys) !== JSON.stringify(allowedMinecraftProfileKeys)) {
    throw new Error(`Player settings save returned unsafe minecraftProfile keys: ${JSON.stringify(saveProof)}`);
  }
  const leakedSaveProfileText = forbiddenSetupText.filter((item) => saveProof.minecraftProfileText.includes(item));
  if (leakedSaveProfileText.length) {
    throw new Error(`Player settings save returned private minecraftProfile diagnostics: ${JSON.stringify({ leakedSaveProfileText, saveProof })}`);
  }
  const storedAfterSave = JSON.parse(await fsp.readFile(path.join(userData, 'launcher.config.json'), 'utf8'));
  if (Object.prototype.hasOwnProperty.call(storedAfterSave, 'developer') || Object.prototype.hasOwnProperty.call(storedAfterSave, 'serverTransfer') || storedAfterSave.minecraftLauncher?.memoryMb !== 5120 || storedAfterSave.launcherProof?.required !== true || storedAfterSave.launcherProof?.baseUrl !== `${workerEndpoint}/`) {
    throw new Error(`Player settings save persisted unsafe config: ${JSON.stringify(storedAfterSave)}`);
  }

  await evaluate(client, `document.querySelector('.nav [data-tab="settings"]')?.click(); true`);
  const settingsProof = await waitFor(client, `
    (() => {
      const settings = document.querySelector('#settings');
      if (!settings?.classList.contains('active')) return false;
      const visible = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return false;
        const target = node.closest('label') || node;
        const style = getComputedStyle(target);
        const rect = target.getBoundingClientRect();
        return !target.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      return {
        active: true,
        statusBadge: document.querySelector('#statusBadge')?.textContent || '',
        settingsText: settings.innerText,
        settingsFeedText: document.querySelector('#settingsFeedCard')?.innerText || '',
        latestFeedVisible: visible('#latestUrlInput'),
        proxyVisible: visible('#proxyUrlInput'),
        syncVisible: visible('#syncUrlInput'),
        testFeedVisible: visible('#testFeedButton'),
        openInstanceVisible: visible('#openInstanceButton'),
        developerTabHidden: document.querySelector('#developerTab')?.hidden,
        developerTileHidden: document.querySelector('#developerTileButton')?.hidden
      };
    })()
  `, 'player settings privacy');
  const exposedText = `${settingsProof.settingsText}\n${settingsProof.settingsFeedText}`;
  const forbiddenVisibleText = [
    workerEndpoint,
    '/latest.json',
    '/cf/',
    'private/dev-should-not-leak',
    '192.168.1.121',
    'Latest Feed',
    'CurseForge Proxy',
    'Sync URL',
    'Developer Console',
    'Cache mods',
    'Detected instance',
    'Local feed',
    'CurseForge',
    'fallback cache',
    'Exact AHT client ZIP'
  ].filter((item) => exposedText.includes(item));
  if (forbiddenVisibleText.length || settingsProof.latestFeedVisible || settingsProof.proxyVisible || settingsProof.syncVisible || settingsProof.testFeedVisible || settingsProof.openInstanceVisible) {
    throw new Error(`Player settings exposed technical configuration: ${JSON.stringify({ settingsProof, forbiddenVisibleText })}`);
  }
  if (settingsProof.statusBadge === 'Config error') {
    throw new Error(`Player settings showed Config error: ${JSON.stringify(settingsProof)}`);
  }
  if (!settingsProof.settingsFeedText.includes('A Hard Time 9.9.9') || settingsProof.settingsFeedText.includes('Dregora') || !settingsProof.settingsFeedText.includes('Verified AHT package ready.')) {
    throw new Error(`Player settings did not sanitize the public pack display name: ${JSON.stringify(settingsProof.settingsFeedText)}`);
  }

  console.log(JSON.stringify({ ok: true, root, packaged: Boolean(smokeExe), proof, settingsProof }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
