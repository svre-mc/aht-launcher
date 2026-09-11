import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { createMinecraftInteractiveRecovery } from '../src/minecraftInteractiveRecovery.js';
import { proveMinecraftAccountOwnership } from '../src/minecraftAccountRecovery.js';

const run = promisify(execFile);
const javaRoot = process.env.AHT_RECOVERY_JAVA_HOME || (process.platform === 'win32' ? 'C:/AHTDEV/Toolchains/Java-8' : process.env.JAVA_HOME);
if (!javaRoot) throw new Error('Set AHT_RECOVERY_JAVA_HOME to the Java 8 test toolchain.');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-interactive-recovery-'));
const mc = path.join(root, '.minecraft');
await fs.mkdir(mc);
const jar = path.resolve('src/resources/account-recovery.jar');
const jarBytes = await fs.readFile(jar);
const pin = JSON.parse(await fs.readFile('src/resources/account-recovery.json', 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
assert.equal(sha(jarBytes), pin.sha256);
assert.equal(sha(await fs.readFile('account-recovery/src/net/ahardtime/recovery/Main.java')), pin.sourceSha256);
const jarEntries = new AdmZip(jarBytes).getEntries();
assert.deepEqual(jarEntries.map(entry => entry.entryName).sort(), [
  'net/ahardtime/recovery/Main$Transport.class', 'net/ahardtime/recovery/Main.class'
]);
assert(jarEntries.every(entry => entry.getData().readUInt16BE(6) === 52));
execFileSync(path.join(javaRoot, `bin/javac${executableSuffix}`), ['-cp', jar, '-d', root,
  'account-recovery/test/net/ahardtime/recovery/TestDriver.java'], { windowsHide: true, stdio: 'pipe' });
const profilesFile = path.join(mc, 'launcher_profiles.json');
const originalProfiles = { version: 3, settings: { keepLauncherOpen: true }, accounts: { selected: 'untouched' },
    profiles: { aht: { name: 'A Hard Time', lastVersionId: 'existing-forge', gameDir: path.join(root, 'pack'), javaDir: path.join(javaRoot, `bin/java${executableSuffix}`) },
    other: { name: 'User profile', lastUsed: '2025-01-01T00:00:00Z' } } };
await fs.writeFile(profilesFile, JSON.stringify(originalProfiles));
const config = { instanceDir: path.join(root, 'pack'), minecraftLauncher: { rootDir: mc, profileId: 'aht', syncRoots: [] } };
const username = 'RecoveryPlayer';
const minecraftUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const uuid = minecraftUuid.replaceAll('-', '');
const challenge = '0123456789012345678901234567890123456789';
let validMojangSession = false;
let joinCalls = 0;
const server = http.createServer((req, res) => {
  let text = '';
  req.on('data', value => { text += value; });
  req.on('end', () => {
    const body = JSON.parse(text);
    assert.equal(req.url, '/test/mojang-join');
    assert.equal(body.accessToken, 'synthetic-recovery-session');
    assert.equal(body.selectedProfile, uuid);
    assert.equal(body.serverId, challenge);
    joinCalls++;
    validMojangSession = true;
    res.writeHead(204).end();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const states = [];
const recovery = createMinecraftInteractiveRecovery({ onState: value => states.push(value) });
const journalPath = path.join(root, 'pending-account-recovery.json');
const options = { config, username, minecraftUuid, serverId: challenge, journalPath, timeoutMs: 10000 };
async function recoveryArgs() {
  const profiles = JSON.parse(await fs.readFile(profilesFile, 'utf8'));
  const [id, profile] = Object.entries(profiles.profiles).find(([id]) => id.startsWith('aht-account-recovery-'));
  assert.equal(profile.javaArgs, '-Xmx128M');
  assert.equal(profiles.version, originalProfiles.version);
  assert.equal(profiles.selectedProfile, profiles.version < 3 ? id : undefined);
  const version = JSON.parse(await fs.readFile(path.join(mc, 'versions', id, `${id}.json`), 'utf8'));
  assert.equal(version.inheritsFrom, '1.12.2');
  assert.equal(version.mainClass, 'net.ahardtime.recovery.Main');
  assert.equal(version.libraries[0].downloads.artifact.url, '', 'Use the installed Forge-style local-library schema.');
  assert(!JSON.stringify(version).includes('synthetic-recovery-session'));
  return version.minecraftArguments.split(' ');
}
async function helper(args, name = username) {
  const placeholders = { '${auth_player_name}': name, '${auth_uuid}': uuid, '${auth_access_token}': 'synthetic-recovery-session' };
  const output = await run(path.join(javaRoot, `bin/java${executableSuffix}`), ['-cp', `${root}${path.delimiter}${jar}`,
    'net.ahardtime.recovery.TestDriver', endpoint, ...args.map(arg => placeholders[arg] || arg)], { windowsHide: true, timeout: 10000 });
  assert.equal(output.stdout + output.stderr, '', 'Helper must not print credentials or upstream errors.');
}
async function assertClean() {
  const value = JSON.parse(await fs.readFile(profilesFile, 'utf8'));
  assert.deepEqual(value, originalProfiles);
  assert.equal(recovery.state().running, false);
  assert.equal(await fs.stat(journalPath).then(() => true).catch(() => false), false);
}
try {
  // No credential cache exists: the official launcher supplies the live session instead.
  await proveMinecraftAccountOwnership({ roots: [mc], username, minecraftUuid, serverId: challenge,
    interactiveRecovery: request => recovery.run({ ...options, ...request, openLauncher: async () => {
      const args = await recoveryArgs();
      const callback = args.at(-1);
      assert.equal((await fetch(callback, { method: 'POST', headers: { Origin: 'https://attacker.invalid' }, body: '{"result":"verified"}' })).status, 404);
      assert.equal((await fetch(callback.replace(/.$/, 'z'), { method: 'POST', body: '{"result":"verified"}' })).status, 404);
      await helper(args);
    } })
  });
  assert(validMojangSession && joinCalls === 1);
  await assertClean();
  await assert.rejects(recovery.run({ ...options, openLauncher: async () => helper(await recoveryArgs(), 'WrongPlayer') }), /Select RecoveryPlayer/);
  assert.equal(joinCalls, 1, 'Wrong accounts must never send their credentials to Mojang for another player.');
  await assertClean();
  await assert.rejects(recovery.run({ ...options, openLauncher: async () => recovery.cancel() }), /cancelled/);
  await assertClean();
  await assert.rejects(recovery.run({ ...options, timeoutMs: 30, openLauncher: async () => {} }), /expired|timed out/);
  await assertClean();
  await assert.rejects(recovery.run({ ...options, openLauncher: async () => { throw new Error('fixture launcher unavailable'); } }), /launcher unavailable/);
  await assertClean();
  // A cancelled/failed promise cannot poison future attempts.
  await recovery.run({ ...options, openLauncher: async () => {
    const profiles = JSON.parse(await fs.readFile(profilesFile, 'utf8'));
    profiles.settings.newUserSetting = true;
    await fs.writeFile(profilesFile, JSON.stringify(profiles));
    await helper(await recoveryArgs());
  } });
  originalProfiles.settings.newUserSetting = true;
  await assertClean();
  originalProfiles.version = 2;
  originalProfiles.selectedProfile = 'aht';
  await fs.writeFile(profilesFile, JSON.stringify(originalProfiles));
  await recovery.run({ ...options, openLauncher: async () => helper([...(await recoveryArgs()), '--width', '854', '--demo']) });
  await assertClean();
  // A prior process may die before finally runs. Replay its bounded cleanup journal.
  const staleId = 'aht-account-recovery-' + 'a'.repeat(24);
  const staleProfiles = structuredClone(originalProfiles);
  staleProfiles.profiles[staleId] = { lastVersionId: staleId };
  staleProfiles.selectedProfile = staleId;
  await fs.writeFile(profilesFile, JSON.stringify(staleProfiles));
  await fs.mkdir(path.join(mc, 'versions', staleId), { recursive: true });
  await fs.writeFile(path.join(mc, 'versions', staleId, `${staleId}.json`), JSON.stringify({ id: staleId, mainClass: 'net.ahardtime.recovery.Main' }));
  await fs.writeFile(journalPath, JSON.stringify({ id: staleId, roots: [{ root: mc, previousSelection: 'aht' }, { root: 'C:/', previousSelection: '' }] }));
  assert.equal(await recovery.cleanup({ config, journalPath }), true);
  await assertClean();
  assert.equal(await fs.stat(path.join(mc, 'versions', staleId)).then(() => true).catch(() => false), false);
  assert(!JSON.stringify(states).includes(challenge) && !JSON.stringify(states).includes('synthetic-recovery-session'));
  console.log(JSON.stringify({ ok: true, helperJava: 8, noCachedCredentials: true, actualJavaCallback: true,
    wrongAccountRejected: true, cancellationRetry: true, timeoutCleanup: true, crashCleanup: true,
    legacyProfileSelectionRestored: true, concurrentUserEditsPreserved: true, fixture: root }));
} finally { recovery.cancel(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
