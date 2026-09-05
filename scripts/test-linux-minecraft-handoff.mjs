import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { linuxMinecraftLauncherPaths, isLinuxMinecraftLauncherExecutable } from '../src/linuxMinecraftLauncher.js';

const source = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
function declaration(start, end) {
  const offset = source.indexOf(start);
  assert(offset >= 0);
  return source.slice(offset, source.indexOf(end, offset));
}
const available = new Map();
const fakeFs = {
  async stat(file) { return { isFile: () => available.get(file) === 'executable' || available.get(file) === 'noexec' }; },
  async access(file) { if (available.get(file) !== 'executable') throw new Error('EACCES'); }
};
const home = '/home/Test Player';
const root = `${home}/Documents/curseforge/minecraft/Install`;
let handedOff = null;
const context = vm.createContext({
  process: { platform: 'linux', env: {} }, path: path.posix,
  app: { getPath: (key) => key === 'downloads' ? `${home}/Downloads` : home },
  linuxMinecraftLauncherPaths,
  isLinuxMinecraftLauncherExecutable: (file) => isLinuxMinecraftLauncherExecutable(file, fakeFs),
  commandOnPath: () => '', existingLaunchCwd: async (value) => value,
  trustedMinecraftOpenCommandAllowed: () => false,
  spawnDetachedGui: async (command, args, cwd) => { handedOff = { command, args: [...args], cwd }; return { ok: true }; },
  minecraftLaunchEnv: () => ({}), platformKey: () => 'linux'
});
vm.runInContext(
  declaration('function linuxMinecraftLauncherCandidates(', '\nfunction launcherRecordLabel(')
    + declaration('async function openPreparedMinecraftLauncherRoute(', '\nasync function openMinecraftLauncher('),
  context
);
const config = { minecraftLauncher: { rootDir: root } };
await assert.rejects(context.resolveMinecraftLauncherRoute(config), /select the minecraft-launcher executable/);
const downloaded = `${home}/Downloads/minecraft-launcher/minecraft-launcher`;
available.set(`${home}/Downloads/minecraft-launcher`, 'directory');
available.set(downloaded, 'executable');
let route = await context.resolveMinecraftLauncherRoute(config);
assert.equal(route.executablePath, downloaded, 'Extracted official download must be found without PATH installation');
await context.openPreparedMinecraftLauncherRoute(route);
assert.deepEqual(handedOff, { command: downloaded, args: ['--workDir', root], cwd: root });
const bundled = `${root}/minecraft-launcher/minecraft-launcher`;
available.set(`${root}/minecraft-launcher`, 'directory');
available.set(bundled, 'executable');
route = await context.resolveMinecraftLauncherRoute(config);
assert.equal(route.executablePath, bundled, 'CurseForge bundled executable must take precedence over unrelated downloads');
const chosen = `${home}/My Games/minecraft-launcher`;
available.set(chosen, 'executable');
route = await context.resolveMinecraftLauncherRoute({ minecraftLauncher: { rootDir: root, executablePath: chosen } });
assert.equal(route.executablePath, chosen, 'Explicit executable selection must win without changing the prepared root');
available.set(chosen, 'noexec');
await assert.rejects(context.resolveMinecraftLauncherRoute({ minecraftLauncher: { rootDir: root, executablePath: chosen } }), /selected Minecraft Launcher cannot run/);
assert.equal(await isLinuxMinecraftLauncherExecutable(`${home}/minecraft.tar.gz`, fakeFs), false);

if (process.platform === 'linux') {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-linux-handoff-'));
  const executablePath = path.join(fixture, 'Downloaded Minecraft', 'minecraft-launcher');
  const workDir = path.join(fixture, 'Prepared AHT Root');
  await fs.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.mkdir(workDir);
  await fs.writeFile(executablePath, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n', { mode: 0o755 });
  assert(await isLinuxMinecraftLauncherExecutable(executablePath));
  const output = await new Promise((resolve, reject) => {
    const child = spawn(executablePath, ['--workDir', workDir], { cwd: workDir, shell: false });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(text) : reject(new Error(`fixture exit ${code}`)));
  });
  assert.equal(output, `${workDir}\n--workDir\n${workDir}\n`);
}
console.log('PASS: Linux downloaded/bundled/selected launcher discovery, executable permissions, and exact managed-root handoff.');
