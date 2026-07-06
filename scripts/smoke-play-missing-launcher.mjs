import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const expectMissingCustom = process.argv.includes('--missing-custom');
const portArg = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
const port = Number(portArg || await availablePortPair(expectMissingCustom ? 10822 : 10820));
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-play-missing-launcher-'));
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'A Hard Time');
const mcRoot = path.join(root, '.minecraft');
const externalCapturePath = path.join(root, 'external-open.jsonl');
const errorReportCapturePath = path.join(root, 'copied-error-report.json');
const fakeLocalAppData = path.join(root, 'localappdata');
const fakeAppData = path.join(root, 'appdata');
const fakeUserProfile = path.join(root, 'profile');
const fakeHome = path.join(root, 'home');
const fakeProgramFiles = path.join(root, 'program-files');
const versionId = '1.12.2-forge-14.23.5.2860';
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

async function portIsAvailable(portNumber) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(portNumber, '127.0.0.1');
  });
}

async function availablePortPair(preferredPort) {
  const candidates = [
    preferredPort,
    ...Array.from({ length: 80 }, () => 20_000 + Math.floor(Math.random() * 20_000) * 2)
  ];
  for (const candidate of candidates) {
    if (candidate > 0 && candidate < 65_534 && await portIsAvailable(candidate) && await portIsAvailable(candidate + 1)) {
      return candidate;
    }
  }
  throw new Error('Could not find an available local port pair for the missing-launcher smoke test.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function forgeVersionMetadata(id = versionId, minecraftVersion = '1.12.2') {
  return {
    id,
    type: 'release',
    inheritsFrom: minecraftVersion,
    minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker --versionType Forge',
    libraries: [{ name: `net.minecraftforge:forge:${minecraftVersion}-14.23.5.2860` }]
  };
}

async function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const text = await fsp.readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
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

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '8.8.8',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { url: 'packs/a-hard-time-8.8.8.zip' },
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  }
};
const managedModContent = 'managed mod bytes\n';
const assetBytes = Buffer.from('missing launcher asset bytes\n');
const assetHash = sha1(assetBytes);
const assetIndex = { objects: { 'minecraft/lang/en_us.lang': { hash: assetHash, size: assetBytes.length } } };
const assetIndexBytes = Buffer.from(`${JSON.stringify(assetIndex)}\n`);
const assetIndexHash = sha1(assetIndexBytes);
const clientJarBytes = Buffer.from('missing launcher client jar bytes\n');
const libraryBytes = Buffer.from('missing launcher library bytes\n');
const clientJarHash = sha1(clientJarBytes);
const libraryHash = sha1(libraryBytes);
const libraryRelPath = 'com/example/missing-launcher-lib/1.0.0/missing-launcher-lib-1.0.0.jar';
await fsp.mkdir(instanceDir, { recursive: true });
await fsp.mkdir(path.join(instanceDir, 'mods'), { recursive: true });
await fsp.writeFile(path.join(instanceDir, 'mods', 'aht-clean.jar'), managedModContent, 'utf8');
await writeJson(path.join(instanceDir, '.aht-launcher', 'installed.json'), {
  packId: latest.packId,
  name: latest.name,
  version: latest.version,
  minecraft: latest.minecraft,
  manifestFileCount: 0,
  overrideFileCount: 1
});
await writeJson(path.join(instanceDir, '.aht-launcher', 'managed-files.json'), [{
  relativePath: 'mods/aht-clean.jar',
  source: 'full-client-zip',
  sha256: sha256(managedModContent)
}]);
await writeJson(
  path.join(mcRoot, 'versions', versionId, `${versionId}.json`),
  forgeVersionMetadata()
);
await writeJson(
  path.join(mcRoot, 'versions', '1.12.2', '1.12.2.json'),
  {
    id: '1.12.2',
    assetIndex: {
      id: '1.12',
      url: `${workerEndpoint}/assets/1.12.json`,
      sha1: assetIndexHash,
      size: assetIndexBytes.length,
      totalSize: assetBytes.length
    },
    downloads: {
      client: {
        sha1: clientJarHash,
        size: clientJarBytes.length,
        url: `${workerEndpoint}/runtime/client.jar`
      }
    },
    libraries: [{
      name: 'com.example:missing-launcher-lib:1.0.0',
      downloads: {
        artifact: {
          path: libraryRelPath,
          sha1: libraryHash,
          size: libraryBytes.length,
          url: `${workerEndpoint}/libraries/missing-launcher-lib-1.0.0.jar`
        }
      }
    }]
  }
);
await writeJson(
  path.join(mcRoot, 'assets', 'indexes', '1.12.json'),
  assetIndex
);
await fsp.mkdir(fakeLocalAppData, { recursive: true });
await fsp.mkdir(fakeAppData, { recursive: true });
await fsp.mkdir(fakeUserProfile, { recursive: true });
await fsp.mkdir(path.join(fakeUserProfile, 'Documents'), { recursive: true });
await fsp.mkdir(fakeHome, { recursive: true });
await fsp.mkdir(fakeProgramFiles, { recursive: true });
await writeJson(defaultsPath, {
  packId: latest.packId,
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: false, sendLocalChanges: false, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  launcherUpdate: { enabled: false, latestUrl: '' },
  minecraftLauncher: {
    enabled: true,
    rootDir: mcRoot,
    profileId: 'a-hard-time',
    profileName: 'A Hard Time',
    memoryMb: 4096,
    syncDefaultRoots: false,
    autoImportAccount: false,
    ...(expectMissingCustom ? {
      openCommand: path.join(root, 'missing-custom-launcher', 'MinecraftLauncher.exe'),
      openArgs: ['--bad-custom']
    } : {})
  },
  playCommand: { command: '', args: [], cwd: instanceDir }
});

const registeredUsers = new Map();
const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(latest));
    return;
  }
  if (url.pathname === '/assets/1.12.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(assetIndex));
    return;
  }
  if (url.pathname === `/assets/objects/${assetHash.slice(0, 2)}/${assetHash}`) {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.end(assetBytes);
    return;
  }
  if (url.pathname === '/runtime/client.jar') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.end(clientJarBytes);
    return;
  }
  if (url.pathname === '/libraries/missing-launcher-lib-1.0.0.jar') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.end(libraryBytes);
    return;
  }
  if (url.pathname === '/api/users/register') {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const username = String(payload.username || '').trim();
      const installId = String(payload.installId || '').trim();
      registeredUsers.set(username.toLowerCase(), installId);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true, username, installId }));
    });
    return;
  }
  if (url.pathname === '/api/launcher-proof') {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const username = String(payload.minecraftUsername || '').trim().toLowerCase();
      const installId = String(payload.installId || '').trim();
      if (!username || registeredUsers.get(username) !== installId) {
        response.statusCode = 403;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Minecraft username is not registered to this launcher install.' }));
        return;
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({
        token: 'missing-launcher-proof-token',
        payload,
        signature: { alg: 'HS256', kid: 'smoke', value: 'smoke-signature' }
      }));
    });
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
    AHT_APP_DEFAULTS: defaultsPath,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_OPEN_EXTERNAL_CAPTURE_PATH: externalCapturePath,
    AHT_TEST_ERROR_REPORT_CAPTURE_PATH: errorReportCapturePath,
    AHT_TEST_MINECRAFT_ASSET_BASE_URL: `${workerEndpoint}/assets/objects/`,
    AHT_DISABLE_COMMON_MINECRAFT_LAUNCHER_DRIVES: '1',
    ELECTRON_ENABLE_LOGGING: '0',
    LOCALAPPDATA: fakeLocalAppData,
    APPDATA: fakeAppData,
    USERPROFILE: fakeUserProfile,
    HOME: fakeHome,
    ProgramFiles: fakeProgramFiles,
    'ProgramFiles(x86)': fakeProgramFiles
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
  const registration = await evaluate(client, `
    window.aht.accountRegister('MissingLauncher')
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  if (!registration.ok || !registration.result?.ok) {
    throw new Error(`Player registration failed: ${JSON.stringify(registration)}`);
  }
  const before = await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '8.8.8' ? status : false)
  `, 'ready status before missing launcher Play');
  if (!before.launchReady || before.launchBlockedReason || before.integrity?.counts?.corrupted) {
    throw new Error(`Smoke setup should be launch-ready before opening Minecraft Launcher: ${JSON.stringify(before)}`);
  }
  if (expectMissingCustom) {
    if (before.setup?.minecraftLauncherOpenState !== 'missing' || before.setup?.minecraftLauncherOpenLabel !== 'Install needed') {
      throw new Error(`Stale custom launcher config should be rendered as a normal missing Minecraft Launcher state: ${JSON.stringify(before.setup)}`);
    }
  }

  await evaluate(client, `document.querySelector('#playButton')?.click(); true`);
  const toast = await waitFor(client, `
    (() => {
      const nodes = [...document.querySelectorAll('.toast')];
      const toast = nodes.find((item) => /Setup needed/i.test(item.querySelector('strong')?.textContent || ''));
      if (!toast) return false;
      const copy = toast.querySelector('.toast-copy-action');
      return {
        title: toast.querySelector('strong')?.textContent || '',
        detail: toast.querySelector('span')?.textContent || '',
        copyText: copy?.textContent || '',
        log: document.querySelector('#log')?.textContent || ''
      };
    })()
  `, 'missing Minecraft Launcher setup toast');
  if (toast.title !== 'Setup needed') {
    throw new Error(`Missing Minecraft Launcher toast had the wrong title: ${JSON.stringify(toast)}`);
  }
  const message = String(toast.detail || '');
  if (!/Minecraft Launcher is not installed|official Minecraft Launcher download page/i.test(message)) {
    throw new Error(`Missing Minecraft Launcher did not produce setup-focused wording: ${JSON.stringify(toast)}`);
  }
  if (/ENOENT|spawn\s+.*not found|event|Error invoking remote method/i.test(`${message}\n${toast.log}`)) {
    throw new Error(`Missing Minecraft Launcher leaked a low-level spawn error: ${JSON.stringify(toast)}`);
  }
  if (expectMissingCustom && /custom launcher|missing-custom|--bad-custom/i.test(`${message}\n${toast.log}`)) {
    throw new Error(`Stale custom launcher config leaked to the player-facing missing-launcher flow: ${JSON.stringify(toast)}`);
  }
  if (toast.copyText !== 'Copy full error details') {
    throw new Error(`Missing Minecraft Launcher toast did not expose clickable diagnostics: ${JSON.stringify(toast)}`);
  }
  const captures = await readJsonLines(externalCapturePath);
  if (!captures.some((entry) => entry.url === 'https://www.minecraft.net/download')) {
    throw new Error(`Play did not open the Minecraft Launcher download URL: ${JSON.stringify(captures)}`);
  }
  const proof = JSON.parse(fs.readFileSync(path.join(instanceDir, '.aht-launcher', 'launcher-proof.json'), 'utf8'));
  if (!proof.trusted || proof.source !== 'worker') {
    throw new Error(`Play did not write trusted proof before handoff setup failure: ${JSON.stringify(proof)}`);
  }
  const profile = JSON.parse(fs.readFileSync(path.join(mcRoot, 'launcher_profiles.json'), 'utf8')).profiles?.['a-hard-time'];
  if (!profile || profile.lastVersionId !== versionId || path.resolve(profile.gameDir) !== path.resolve(instanceDir)) {
    throw new Error(`Play did not prepare the Minecraft profile before handoff setup failure: ${JSON.stringify(profile)}`);
  }
  const after = await evaluate(client, 'window.aht.getStatus()');
  if (!after.launchReady || after.launchBlockedReason || after.integrity?.counts?.corrupted) {
    throw new Error(`Missing launcher handoff should not dirty the installed pack state: ${JSON.stringify(after)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    packaged: Boolean(smokeExe),
    expectMissingCustom,
    message,
    capturedUrls: captures.map((entry) => entry.url),
    proofSource: proof.source,
    profile: {
      gameDir: profile.gameDir,
      lastVersionId: profile.lastVersionId
    }
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
