import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10500);
const endpoint = `http://127.0.0.1:${port}`;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-settings-profile-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'A Hard Time');
const minecraftRoot = path.join(root, '.minecraft');
const versionId = '1.12.2-forge-14.23.5.2860';
const latestPath = path.join(root, 'latest.json');
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

await fsp.mkdir(path.join(minecraftRoot, 'versions', versionId), { recursive: true });
await fsp.writeFile(path.join(minecraftRoot, 'versions', versionId, `${versionId}.json`), `${JSON.stringify(forgeVersionMetadata(), null, 2)}\n`, 'utf8');
await writeJson(latestPath, {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '9.9.9',
  required: true,
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
await writeJson(defaultsPath, {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: latestPath,
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

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_APP_DEFAULTS: smokeExe ? '' : tempDefaults,
    ELECTRON_ENABLE_LOGGING: '0',
    AHT_TEST_HOOKS: '1',
    AHT_TEST_DIALOG_ECHO_DEFAULT_PATH: '1'
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
    window.aht.getStatus().then((status) => status.config?.latestUrl === ${JSON.stringify(latestPath)} ? status : false)
  `, 'local default config');

  const folderLabel = await evaluate(client, `
    (() => {
      const label = document.querySelector('#instanceInput')?.closest('label');
      return {
        text: label?.childNodes?.[0]?.textContent?.trim() || '',
        hidden: Boolean(label?.hidden),
        technical: Boolean(label?.classList?.contains('player-technical'))
      };
    })()
  `);
  if (folderLabel.text !== 'Modpack Folder' || folderLabel.hidden || folderLabel.technical) {
    throw new Error(`Modpack folder setting is not visible/player-facing: ${JSON.stringify(folderLabel)}`);
  }

  const browseProof = await evaluate(client, `
    (async () => {
      const input = document.querySelector('#instanceInput');
      const button = document.querySelector('#pickInstanceButton');
      const expected = ${JSON.stringify(instanceDir)};
      const expectedEcho = ${JSON.stringify(path.join(instanceDir, '__aht_dialog_default_path__'))};
      if (!input || !button) return { ok: false, reason: 'missing controls' };
      input.value = expected;
      button.click();
      for (let attempt = 0; attempt < 30 && input.value !== expectedEcho; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const proof = { ok: input.value === expectedEcho, inputValue: input.value, expected, expectedEcho };
      input.value = expected;
      return proof;
    })()
  `);
  if (!browseProof?.ok) {
    throw new Error(`Modpack folder Browse did not pass the listed folder path to the native dialog: ${JSON.stringify(browseProof)}`);
  }

  const saveResult = await evaluate(client, `
    window.aht.getStatus().then((status) => window.aht.saveSettings({
      ...status.config,
      minecraftLauncher: {
        ...status.config.minecraftLauncher,
        memoryMb: 8192
      },
      playCommand: {
        ...status.config.playCommand,
        cwd: status.config.instanceDir
      }
    }))
  `);
  if (!saveResult?.profileUpdated) {
    throw new Error(`Settings save did not update Minecraft profile: ${JSON.stringify(saveResult)}`);
  }

  const profiles = JSON.parse(await fsp.readFile(path.join(minecraftRoot, 'launcher_profiles.json'), 'utf8'));
  const profile = profiles.profiles?.['a-hard-time'];
  if (!profile) {
    throw new Error('Minecraft Launcher profile was not written.');
  }
  if (!profile.javaArgs.includes('-Xmx8192m') || !profile.javaArgs.includes('-Xms512m') || !profile.javaArgs.includes('-Daht.launcher.proofFile=')) {
    throw new Error(`RAM setting did not reach launcher_profiles.json: ${profile.javaArgs}`);
  }
  if (profile.gameDir !== path.resolve(instanceDir)) {
    throw new Error(`Profile gameDir did not use configured modpack folder: ${profile.gameDir}`);
  }

  console.log(JSON.stringify({
    ok: true,
    userData,
    defaultsPath,
    instanceDir: status.config.instanceDir,
    profile: {
      gameDir: profile.gameDir,
      javaArgs: profile.javaArgs,
      lastVersionId: profile.lastVersionId
    },
    saveResult: {
      profileUpdated: saveResult.profileUpdated,
      profileId: saveResult.minecraftProfile?.profileId,
      rootDir: saveResult.minecraftProfile?.rootDir
    }
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  if (packagedDefaults) {
    if (originalDefaults) {
      await fsp.writeFile(packagedDefaults, originalDefaults);
    } else {
      await fsp.rm(packagedDefaults, { force: true });
    }
  }
}
