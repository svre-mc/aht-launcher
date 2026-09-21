import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import AdmZip from 'adm-zip';
import { prepareMinecraftDirectLaunch, launchMinecraftDirect, splitMinecraftArguments } from '../src/minecraftDirectLaunch.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-direct session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, data) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return file; };
  const archive = new AdmZip(); archive.addFile('lwjgl64.dll', Buffer.from('synthetic-native'));
  archive.addFile('META-INF/MANIFEST.MF', Buffer.from('excluded'));
  const native = archive.toBuffer();
  await write('libraries/test/native/1/native.jar', native);
  await write('libraries/test/base/1/base-1.jar', 'base-library');
  await write('libraries/test/base/2/base-2.jar', 'forge-override');
  await write('libraries/test/native/1/native-1.jar', 'native-support-library');
  await write('versions/1.12.2/1.12.2.jar', 'client-jar');
  await write('versions/1.12.2/1.12.2.json', JSON.stringify({ id: '1.12.2', mainClass: 'net.minecraft.client.main.Main', assetIndex: { id: '1.12' },
    downloads: { client: {} }, minecraftArguments: '--username ${auth_player_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --gameDir ${game_directory}',
    libraries: [{ name: 'test:base:1' }, { name: 'test:native:1' }, { name: 'test:native:1', natives: { windows: 'natives-windows' }, downloads: { classifiers: {
      'natives-windows': { path: 'test/native/1/native.jar', sha1: createHash('sha1').update(native).digest('hex') }
    } } }] }));
  await write('versions/forge-test/forge-test.json', JSON.stringify({ id: 'forge-test', inheritsFrom: '1.12.2', mainClass: 'net.minecraft.launchwrapper.Launch',
    libraries: [{ name: 'test:base:2' }] }));
  const java = await write('java.exe', 'synthetic-java');
  await write('javaw.exe', 'synthetic-java');
  const game = path.join(root, 'managed game'); await fs.mkdir(game);
  return { root, write, profile: { rootDir: root, versionId: 'forge-test', minecraftVersion: '1.12.2', gameDir: game,
    javaPath: java, javaArgs: '-Xmx4096m -XX:+DisableAttachMechanism -Daht.launcherProof="C:\\path with spaces\\proof.json"' },
    nativeBase: path.join(root, 'natives'), platform: 'win32', arch: 'x64' };
}
const identity = { minecraftUsername: 'ExistingPlayer', minecraftUuid: '12345678-1234-4234-9234-123456789abc' };
const session = { username: identity.minecraftUsername, minecraftUuid: identity.minecraftUuid, accessToken: 'private-fixture-token' };

test('Forge inherited launch plan preserves managed game directory, proof JVM args, native libraries and classpath precedence', async t => {
  const f = await fixture(t); const plan = await prepareMinecraftDirectLaunch(f);
  assert(plan.prefix.includes('-Daht.launcherProof=C:\\path with spaces\\proof.json'));
  assert(plan.prefix.includes('-XX:+DisableAttachMechanism'));
  assert(plan.prefix.includes('net.minecraft.launchwrapper.Launch'));
  const cp = plan.prefix[plan.prefix.indexOf('-cp') + 1];
  assert(cp.includes('base-2.jar') && !cp.includes('base-1.jar'));
  assert(cp.includes(path.join('versions', '1.12.2', '1.12.2.jar')));
  const natives = plan.prefix.find(v => v.startsWith('-Djava.library.path=')).split('=').slice(1).join('=');
  assert.equal(await fs.readFile(path.join(natives, 'lwjgl64.dll'), 'utf8'), 'synthetic-native');
  assert.equal(plan.cwd, f.profile.gameDir);
  let captured;
  const result = await launchMinecraftDirect({ plan, session, expectedIdentity: identity, settleMs: 1,
    spawnImpl: (exe, args, options) => {
      captured = { exe, args: [...args], options }; const child = new EventEmitter(); child.pid = 123; child.unref = () => {};
      queueMicrotask(() => child.emit('spawn')); return child;
    } });
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.windowsHide, false, 'The game window must be visible');
  assert.equal(path.basename(captured.exe), 'javaw.exe', 'Use console-free Java on Windows');
  assert.equal(captured.args[captured.args.indexOf('--accessToken') + 1], session.accessToken);
  assert.equal(captured.args[captured.args.indexOf('--uuid') + 1], identity.minecraftUuid.replaceAll('-', ''));
  assert.equal(captured.args[captured.args.indexOf('--gameDir') + 1], f.profile.gameDir);
  assert(!JSON.stringify(result).includes('private'));
  assert.equal(result.gameProcessStarted, true);
});

test('missing runtime and changed account fail before process launch', async t => {
  const f = await fixture(t); const plan = await prepareMinecraftDirectLaunch(f);
  await assert.rejects(launchMinecraftDirect({ plan, session: { ...session, username: 'DifferentPlayer' }, expectedIdentity: identity,
    spawnImpl: () => assert.fail('Mismatched account reached process launch') }), { code: 'CURSEFORGE_SESSION_CHANGED' });
  await fs.rm(path.join(f.root, 'libraries/test/base/2/base-2.jar'));
  await assert.rejects(prepareMinecraftDirectLaunch(f), { code: 'MINECRAFT_DIRECT_RUNTIME' });
});

test('spawn failures cannot leak token-bearing spawnargs or errors', async t => {
  const f = await fixture(t); const plan = await prepareMinecraftDirectLaunch(f);
  await assert.rejects(launchMinecraftDirect({ plan, session, expectedIdentity: identity, spawnImpl: () => {
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('error', new Error('spawn failed private-fixture-token'))); return child;
  } }), error => error.code === 'MINECRAFT_DIRECT_RUNTIME' && !String(error.stack).includes('private-fixture-token') && !error.cause);
  assert.deepEqual(splitMinecraftArguments('-Dname="with spaces" -Dpath=C:\\games\\minecraft'), ['-Dname=with spaces', '-Dpath=C:\\games\\minecraft']);
});

test('tampered or additional native libraries cannot be loaded from a prior extraction', async t => {
  const f = await fixture(t); const plan = await prepareMinecraftDirectLaunch(f);
  const directory = plan.prefix.find(v => v.startsWith('-Djava.library.path=')).split('=').slice(1).join('=');
  await fs.writeFile(path.join(directory, 'unexpected.dll'), 'unmanaged native');
  await assert.rejects(prepareMinecraftDirectLaunch(f), { code: 'MINECRAFT_DIRECT_RUNTIME' });
  await fs.rm(path.join(directory, 'unexpected.dll'));
  await fs.writeFile(path.join(directory, 'lwjgl64.dll'), 'tampered');
  await assert.rejects(prepareMinecraftDirectLaunch(f), { code: 'MINECRAFT_DIRECT_RUNTIME' });
  await prepareMinecraftDirectLaunch({ ...f, repairNatives: true });
  assert.equal(await fs.readFile(path.join(directory, 'lwjgl64.dll'), 'utf8'), 'synthetic-native');
  assert.equal((await fs.readdir(f.nativeBase)).filter(name => name.includes('.quarantine-')).length, 1);
});
