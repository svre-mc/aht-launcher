import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readJsonFile, writeJsonFile } from './utils.js';

const PROFILE_PREFIX = 'aht-account-recovery-';
const digest = data => createHash('sha256').update(data).digest('hex');
const failure = (message, code = 'AHT_ACCOUNT_RECOVERY_FAILED') => Object.assign(new Error(message), { code });

// Removes only our exact temporary profile/version. Never restore an old whole-file snapshot.
async function cleanProfile(root, id, previousSelection = '') {
  if (!/^aht-account-recovery-[a-f0-9]{24}$/.test(id)) throw new Error('Invalid recovery profile.');
  const profilesFile = path.join(root, 'launcher_profiles.json');
  const profiles = await readJsonFile(profilesFile).catch(() => null);
  if (profiles?.profiles?.[id]?.lastVersionId === id) {
    delete profiles.profiles[id];
    if (profiles.selectedProfile === id) {
      if (previousSelection && profiles.profiles[previousSelection]) profiles.selectedProfile = previousSelection;
      else delete profiles.selectedProfile;
    }
    await writeJsonFile(profilesFile, profiles);
  }
  const versionFile = path.join(root, 'versions', id, `${id}.json`);
  const version = await readJsonFile(versionFile).catch(() => null);
  if (version?.id === id && version?.mainClass === 'net.ahardtime.recovery.Main') {
    await fs.rm(versionFile, { force: true });
    await fs.rmdir(path.dirname(versionFile)).catch(() => {});
  }
}

export function createMinecraftInteractiveRecovery({ resourceRoot = new URL('./resources/', import.meta.url), onState = () => {} } = {}) {
  let active = null;
  let publicState = { running: false };
  return {
    state: () => ({ ...publicState }),
    cancel: () => active?.abort.abort(),
    async cleanup({ config, journalPath }) {
      if (active || !journalPath) return false;
      const journal = await fs.readFile(journalPath, 'utf8').then(JSON.parse).catch(() => null);
      if (!journal || !/^aht-account-recovery-[a-f0-9]{24}$/.test(journal.id)) return false;
      const allowed = new Set([config.minecraftLauncher.rootDir, ...(config.minecraftLauncher.syncRoots || [])].filter(Boolean).map(value => path.resolve(value)));
      for (const entry of journal.roots || []) {
        if (allowed.has(entry.root)) await cleanProfile(entry.root, journal.id, entry.previousSelection);
      }
      await fs.rm(journalPath, { force: true });
      return true;
    },
    async run({ config, username, minecraftUuid, serverId, expiresAt, openLauncher, journalPath, timeoutMs = 240000 }) {
      const uuid = String(minecraftUuid || '').replaceAll('-', '').toLowerCase();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(username || '') || !/^[a-f0-9]{32}$/.test(uuid)
          || !/^[a-f0-9]{40}$/.test(serverId || '')) throw failure('Account verification request is invalid.');
      const key = `${username.toLowerCase()}:${uuid}:${serverId}`;
      if (active) {
        if (active.key === key) return active.promise;
        throw failure('Another Minecraft account verification is already running.');
      }
      const abort = new AbortController();
      const execute = async () => {
        const root = path.resolve(config.minecraftLauncher.rootDir);
        const roots = [...new Set([root, ...(config.minecraftLauncher.syncRoots || []).filter(Boolean).map(value => path.resolve(value))])];
        const profilesFile = path.join(root, 'launcher_profiles.json');
        const initialProfiles = await readJsonFile(profilesFile);
        const sourceProfile = initialProfiles.profiles?.[config.minecraftLauncher.profileId]
          || Object.values(initialProfiles.profiles || {}).find(profile => profile.gameDir
            && path.resolve(profile.gameDir) === path.resolve(config.instanceDir));
        const javaDir = config.minecraftLauncher.javaPath || sourceProfile?.javaDir;
        if (!javaDir || !path.isAbsolute(javaDir)) throw failure('Run Repair to prepare Java before verifying this account.');
        const id = PROFILE_PREFIX + randomBytes(12).toString('hex');
        const secret = randomBytes(32).toString('hex');
        const pin = JSON.parse(await fs.readFile(new URL('account-recovery.json', resourceRoot), 'utf8'));
        const jar = await fs.readFile(new URL('account-recovery.jar', resourceRoot));
        if (digest(jar) !== pin.sha256) throw failure('Account verification helper could not be verified. Reinstall AHT Launcher.');
        let timer;
        let settle;
        const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
        result.catch(() => {});
        const onAbort = () => settle.reject(failure('Account verification cancelled.', 'AHT_ACCOUNT_RECOVERY_CANCELLED'));
        abort.signal.addEventListener('abort', onAbort, { once: true });
        const server = http.createServer((request, response) => {
          response.setHeader('Cache-Control', 'no-store');
          // No browser-origin traffic, credentials, redirects, or public listener.
          if (request.method !== 'POST' || request.headers.origin || request.headers.host !== `127.0.0.1:${server.address()?.port}`
              || request.url !== `/complete/${secret}`) { response.writeHead(404).end(); return; }
          let body = '';
          request.on('data', chunk => { body += chunk; if (body.length > 256) request.destroy(); });
          request.on('end', () => {
            let value;
            try { value = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
            if (Object.keys(value).length !== 1 || !['verified', 'failed', 'wrong-account'].includes(value.result)) {
              response.writeHead(400).end(); return;
            }
            response.writeHead(204).end();
            if (value.result === 'verified') settle.resolve({ verified: true, source: 'minecraft-launcher-session' });
            else settle.reject(failure(value.result === 'wrong-account'
              ? `Select ${username} in Minecraft Launcher, then retry account sync.`
              : 'Minecraft could not verify this account. Retry account sync.'));
          });
        });
        server.requestTimeout = 5000;
        server.headersTimeout = 5000;
        const touchedRoots = [];
        try {
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
          const remaining = Math.min(timeoutMs, Number(expiresAt || Date.now() + timeoutMs) - Date.now() - 1000);
          if (remaining <= 0) throw failure('Account verification expired. Retry account sync.');
          timer = setTimeout(() => settle.reject(failure('Account verification timed out. Retry account sync.')), remaining);
          const callback = `http://127.0.0.1:${server.address().port}/complete/${secret}`;
          const args = ['--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--access-token', '${auth_access_token}',
            '--expected-name', username, '--expected-uuid', uuid, '--challenge', serverId, '--callback', callback];
          for (const destination of roots) {
            const profilesPath = path.join(destination, 'launcher_profiles.json');
            const profiles = await readJsonFile(profilesPath);
            // Crash leftovers are our generated IDs, never arbitrary profile names or roots from a journal.
            for (const [oldId, profile] of Object.entries(profiles.profiles || {})) {
              if (/^aht-account-recovery-[a-f0-9]{24}$/.test(oldId) && profile.lastVersionId === oldId) await cleanProfile(destination, oldId);
            }
            const current = await readJsonFile(profilesPath);
            const libPath = `net/ahardtime/account-recovery/${pin.version}/account-recovery-${pin.version}.jar`;
            await fs.mkdir(path.dirname(path.join(destination, 'libraries', libPath)), { recursive: true });
            await fs.writeFile(path.join(destination, 'libraries', libPath), jar);
            touchedRoots.push({ root: destination, previousSelection: current.selectedProfile || '' });
            if (journalPath) await writeJsonFile(journalPath, { id, roots: touchedRoots });
            await writeJsonFile(path.join(destination, 'versions', id, `${id}.json`), {
              id, inheritsFrom: '1.12.2', type: 'release', mainClass: 'net.ahardtime.recovery.Main',
              time: new Date().toISOString(), releaseTime: new Date().toISOString(),
              minecraftArguments: args.join(' '),
              libraries: [{ name: `net.ahardtime:account-recovery:${pin.version}`, downloads: { artifact: {
                path: libPath, url: '', size: jar.length, sha1: createHash('sha1').update(jar).digest('hex')
              } } }]
            });
            current.profiles = current.profiles || {};
            current.profiles[id] = { name: 'AHT Account Verification', type: 'custom', lastVersionId: id,
              javaDir, javaArgs: '-Xmx128M', gameDir: path.join(destination, 'versions', id),
              created: new Date().toISOString(), lastUsed: new Date().toISOString() };
            if (Number(current.version) > 0 && Number(current.version) < 3) current.selectedProfile = id;
            await writeJsonFile(profilesPath, current);
          }
          publicState = { running: true, username,
            message: `In Minecraft Launcher, select AHT Account Verification and click Play once as ${username}. AHT will finish automatically.` };
          onState({ ...publicState });
          if (abort.signal.aborted) onAbort();
          await openLauncher(config);
          return await result;
        } finally {
          clearTimeout(timer);
          abort.signal.removeEventListener('abort', onAbort);
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
          for (const destination of touchedRoots) await cleanProfile(destination.root, id, destination.previousSelection);
          if (journalPath) await fs.rm(journalPath, { force: true });
        }
      };
      const promise = execute().finally(() => { active = null; publicState = { running: false }; onState({ ...publicState }); });
      active = { key, abort, promise };
      return promise;
    }
  };
}
