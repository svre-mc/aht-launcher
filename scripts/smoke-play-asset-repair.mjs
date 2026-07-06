import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10870);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-play-asset-repair-'));
const fakeUserProfile = path.join(root, 'home');
const fakeHome = fakeUserProfile;
const fakeAppData = path.join(fakeUserProfile, 'AppData', 'Roaming');
const fakeLocalAppData = path.join(fakeUserProfile, 'AppData', 'Local');
const fakeProgramFiles = path.join(root, 'Program Files');
const desktopMinecraftLauncher = path.join(fakeProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe');
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const instanceDir = path.join(root, 'A Hard Time');
const mcRoot = path.join(root, '.minecraft');
const spawnCapturePath = path.join(root, 'spawn-detached.jsonl');
const versionId = '1.12.2-forge-14.23.5.2860';
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

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

async function waitForFile(file, label) {
  let lastError = '';
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const stat = await fsp.stat(file);
      if (stat.isFile()) return true;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError || file}`);
}

async function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const text = await fsp.readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '8.9.2',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { url: 'packs/a-hard-time-8.9.2.zip' },
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  }
};
const managedModContent = 'managed mod bytes\n';
const assetBytes = Buffer.from('aht launcher repaired asset\n');
const assetHash = sha1(assetBytes);
const assetObjectPath = path.join(mcRoot, 'assets', 'objects', assetHash.slice(0, 2), assetHash);
const assetIndexPath = path.join(mcRoot, 'assets', 'indexes', '1.12.json');
const minecraftLibraryOsName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const minecraftLibraryArch = /64/.test(process.arch) ? '64' : '32';
const libraryBytes = Buffer.from('aht launcher repaired minecraft library\n');
const nativeBytes = Buffer.from('aht launcher repaired minecraft native\n');
const clientJarBytes = Buffer.from('aht launcher repaired minecraft client jar\n');
const logConfigBytes = Buffer.from('<Configuration>aht launcher log config</Configuration>\n');
const libraryHash = sha1(libraryBytes);
const nativeHash = sha1(nativeBytes);
const clientJarHash = sha1(clientJarBytes);
const logConfigHash = sha1(logConfigBytes);
const libraryRelPath = 'com/example/base-lib/1.0.0/base-lib-1.0.0.jar';
const nativeClassifier = `natives-${minecraftLibraryOsName}-${minecraftLibraryArch}`;
const nativeRelPath = `com/example/native-lib/1.0.0/native-lib-1.0.0-${nativeClassifier}.jar`;
const libraryPath = path.join(mcRoot, 'libraries', libraryRelPath);
const nativePath = path.join(mcRoot, 'libraries', nativeRelPath);
const clientJarPath = path.join(mcRoot, 'versions', '1.12.2', '1.12.2.jar');
const logConfigPath = path.join(mcRoot, 'assets', 'log_configs', 'client-1.12.xml');
const assetRequests = [];
const libraryRequests = [];
const runtimeRequests = [];
let assetObjectRequestCount = 0;

await fsp.mkdir(path.join(instanceDir, 'mods'), { recursive: true });
await fsp.mkdir(path.dirname(desktopMinecraftLauncher), { recursive: true });
await fsp.writeFile(desktopMinecraftLauncher, 'desktop launcher placeholder\n', 'utf8');
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
await writeJson(path.join(mcRoot, 'versions', versionId, `${versionId}.json`), forgeVersionMetadata());
await writeJson(
  path.join(mcRoot, 'versions', '1.12.2', '1.12.2.json'),
  {
    id: '1.12.2',
    assetIndex: { id: '1.12', url: `${workerEndpoint}/assets/1.12.json` },
    downloads: {
      client: {
        sha1: clientJarHash,
        size: clientJarBytes.length,
        url: `${workerEndpoint}/runtime/client.jar`
      }
    },
    logging: {
      client: {
        argument: '-Dlog4j.configurationFile=${path}',
        file: {
          id: 'client-1.12.xml',
          sha1: logConfigHash,
          size: logConfigBytes.length,
          url: `${workerEndpoint}/runtime/client-1.12.xml`
        },
        type: 'log4j2-xml'
      }
    },
    libraries: [
      {
        name: 'com.example:base-lib:1.0.0',
        downloads: {
          artifact: {
            path: libraryRelPath,
            url: `${workerEndpoint}/libraries/base-lib-1.0.0.jar`,
            sha1: libraryHash,
            size: libraryBytes.length
          }
        }
      },
      {
        name: 'com.example:native-lib:1.0.0',
        natives: { [minecraftLibraryOsName]: `natives-${minecraftLibraryOsName}-${'${arch}'}` },
        downloads: {
          classifiers: {
            [nativeClassifier]: {
              path: nativeRelPath,
              url: `${workerEndpoint}/libraries/native-lib-1.0.0-native.jar`,
              sha1: nativeHash,
              size: nativeBytes.length
            }
          }
        }
      }
    ]
  }
);
await fsp.mkdir(path.dirname(assetIndexPath), { recursive: true });
await fsp.writeFile(assetIndexPath, '', 'utf8');
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
    autoImportAccount: false
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
    assetRequests.push(url.pathname);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ objects: { 'minecraft/lang/en_us.lang': { hash: assetHash, size: assetBytes.length } } }));
    return;
  }
  if (url.pathname === `/asset-objects/${assetHash.slice(0, 2)}/${assetHash}`) {
    assetRequests.push(url.pathname);
    assetObjectRequestCount += 1;
    const body = assetObjectRequestCount === 1 ? Buffer.from('bad first asset response\n') : assetBytes;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', String(body.length));
    response.end(body);
    return;
  }
  if (url.pathname === '/libraries/base-lib-1.0.0.jar') {
    libraryRequests.push(url.pathname);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/java-archive');
    response.setHeader('Content-Length', String(libraryBytes.length));
    response.end(libraryBytes);
    return;
  }
  if (url.pathname === '/libraries/native-lib-1.0.0-native.jar') {
    libraryRequests.push(url.pathname);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/java-archive');
    response.setHeader('Content-Length', String(nativeBytes.length));
    response.end(nativeBytes);
    return;
  }
  if (url.pathname === '/runtime/client.jar') {
    runtimeRequests.push(url.pathname);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/java-archive');
    response.setHeader('Content-Length', String(clientJarBytes.length));
    response.end(clientJarBytes);
    return;
  }
  if (url.pathname === '/runtime/client-1.12.xml') {
    runtimeRequests.push(url.pathname);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/xml');
    response.setHeader('Content-Length', String(logConfigBytes.length));
    response.end(logConfigBytes);
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
        token: 'asset-repair-proof-token',
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
    AHT_TEST_MINECRAFT_ASSET_BASE_URL: `${workerEndpoint}/asset-objects/`,
    AHT_TEST_SPAWN_DETACHED_CAPTURE_PATH: spawnCapturePath,
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
    window.aht.accountRegister('AssetRepairUser')
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  if (!registration.ok || !registration.result?.ok) {
    throw new Error(`Player registration failed: ${JSON.stringify(registration)}`);
  }
  const before = await waitFor(client, `
    window.aht.getStatus().then((status) => status.latest?.version === '8.9.2' ? status : false)
  `, 'ready status before Play asset index handoff');
  if (!before.launchReady || before.launchBlockedReason || before.integrity?.counts?.corrupted) {
    throw new Error(`Smoke setup should be launch-ready before asset index repair Play: ${JSON.stringify(before)}`);
  }

  await evaluate(client, `document.querySelector('#playButton')?.click(); true`);
  const toast = await waitFor(client, `
    (() => {
      const nodes = [...document.querySelectorAll('.toast')];
      const toast = nodes.find((item) => /Minecraft Launcher opened/i.test(item.querySelector('strong')?.textContent || ''));
      if (!toast) return false;
      return {
        title: toast.querySelector('strong')?.textContent || '',
        detail: toast.querySelector('span')?.textContent || '',
        log: document.querySelector('#log')?.textContent || ''
      };
    })()
  `, 'Play success toast after asset-object repair');
  if (/REQUEST_FAILED|Unable to prepare assets|Unexpected end of JSON|Launch failed|Error invoking remote method/i.test(`${toast.title}\n${toast.detail}\n${toast.log}`)) {
    throw new Error(`Asset repair Play leaked a launcher asset failure: ${JSON.stringify(toast)}`);
  }
  await waitForFile(spawnCapturePath, 'Minecraft Launcher spawn capture');
  const spawnCaptures = await readJsonLines(spawnCapturePath);
  const spawnCapture = spawnCaptures.at(-1);
  const expectedLauncher = process.platform === 'win32'
    ? desktopMinecraftLauncher
    : path.join(mcRoot, 'minecraft-launcher');
  if (!spawnCapture || path.resolve(spawnCapture.command) !== path.resolve(expectedLauncher)) {
    throw new Error(`Play did not use the Minecraft Launcher executable: ${JSON.stringify(spawnCaptures)}`);
  }
  if (process.platform === 'win32' && JSON.stringify(spawnCapture.args) !== JSON.stringify(['--workDir', mcRoot])) {
    throw new Error(`Play did not pass --workDir to Minecraft Launcher: ${JSON.stringify(spawnCapture)}`);
  }
  if (path.resolve(spawnCapture.cwd) !== path.resolve(mcRoot)) {
    throw new Error(`Play did not launch from the verified Minecraft root cwd: ${JSON.stringify(spawnCapture)}`);
  }
  if (spawnCapture.windowsHide === true) {
    throw new Error(`Play launched Minecraft Launcher hidden instead of visible: ${JSON.stringify(spawnCapture)}`);
  }
  if (spawnCapture.env?.DISABLE_RTSS_LAYER !== '1' || spawnCapture.env?.DISABLE_VULKAN_OBS_CAPTURE !== '1') {
    throw new Error(`Play did not pass launcher overlay-safety environment flags: ${JSON.stringify(spawnCapture)}`);
  }

  if (!fs.existsSync(assetObjectPath)) {
    throw new Error(`Play did not repair the missing Minecraft asset object before opening Minecraft Launcher: ${assetObjectPath}`);
  }
  const repairedAssetHash = sha1(fs.readFileSync(assetObjectPath));
  if (repairedAssetHash !== assetHash || assetObjectRequestCount !== 2 || !assetRequests.includes(`/asset-objects/${assetHash.slice(0, 2)}/${assetHash}`)) {
    throw new Error(`Play did not fully repair and verify the Minecraft asset object before launch: ${JSON.stringify({ assetRequests, assetObjectRequestCount, repairedAssetHash, expected: assetHash })}`);
  }
  if (!fs.existsSync(libraryPath) || sha1(fs.readFileSync(libraryPath)) !== libraryHash) {
    throw new Error(`Play did not repair the base Minecraft library before opening Minecraft Launcher: ${libraryPath}`);
  }
  if (!fs.existsSync(nativePath) || sha1(fs.readFileSync(nativePath)) !== nativeHash) {
    throw new Error(`Play did not repair the Minecraft native library before opening Minecraft Launcher: ${nativePath}`);
  }
  if (!fs.existsSync(clientJarPath) || sha1(fs.readFileSync(clientJarPath)) !== clientJarHash) {
    throw new Error(`Play did not repair the Minecraft client jar before opening Minecraft Launcher: ${clientJarPath}`);
  }
  if (!fs.existsSync(logConfigPath) || sha1(fs.readFileSync(logConfigPath)) !== logConfigHash) {
    throw new Error(`Play did not repair the Minecraft logging config before opening Minecraft Launcher: ${logConfigPath}`);
  }
  if (!libraryRequests.includes('/libraries/base-lib-1.0.0.jar') || !libraryRequests.includes('/libraries/native-lib-1.0.0-native.jar')) {
    throw new Error(`Play did not request the expected Minecraft library artifacts: ${JSON.stringify(libraryRequests)}`);
  }
  if (!runtimeRequests.includes('/runtime/client.jar') || !runtimeRequests.includes('/runtime/client-1.12.xml')) {
    throw new Error(`Play did not request the expected Minecraft runtime artifacts: ${JSON.stringify(runtimeRequests)}`);
  }
  const after = await evaluate(client, 'window.aht.getStatus()');
  if (!after.launchReady || after.launchBlockedReason || after.integrity?.counts?.corrupted) {
    throw new Error(`Asset repair Play should leave the installed pack launch-ready: ${JSON.stringify(after)}`);
  }
  const profile = JSON.parse(fs.readFileSync(path.join(mcRoot, 'launcher_profiles.json'), 'utf8')).profiles?.['a-hard-time'];
  if (!profile || profile.lastVersionId !== versionId || path.resolve(profile.gameDir) !== path.resolve(instanceDir)) {
    throw new Error(`Play did not prepare the Minecraft profile before launch: ${JSON.stringify(profile)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    root,
    packaged: Boolean(smokeExe),
    assetObjectRepairOnPlay: true,
    libraryRepairOnPlay: true,
    runtimeRepairOnPlay: true,
    requests: assetRequests,
    libraryRequests,
    runtimeRequests,
    assetObjectRequestCount,
    spawnCapture,
    profile: {
      gameDir: profile.gameDir,
      lastVersionId: profile.lastVersionId
    }
  }, null, 2));
} finally {
  try {
    client?.close?.();
  } catch {}
  server.close();
  if (!child.killed) {
    child.kill();
  }
}
