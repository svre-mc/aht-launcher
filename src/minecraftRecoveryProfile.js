import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonFile, writeJsonFile } from './utils.js';
import { recoveryFailure, throwIfRecoveryCancelled } from './recoveryResultChannel.js';

export const RECOVERY_PROFILE_PREFIX = 'aht-account-recovery-';
const ownedId = id => /^aht-account-recovery-[a-f0-9]{24}$/.test(id);
const pathKey = root => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);

async function pendingRecoveryTransactions(journalPath) {
  if (!journalPath) return [];
  const journal = await readJsonFile(journalPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!journal) return [];
  const transactions = [journal, ...(Array.isArray(journal.pending) ? journal.pending : [])];
  if (transactions.length > 16 || transactions.some(item => !ownedId(item?.id) || !Array.isArray(item.roots)
      || item.roots.some(entry => typeof entry?.root !== 'string' || !path.isAbsolute(entry.root)))) {
    throw recoveryFailure('Account verification cleanup needs attention. Retry account sync.', 'AHT_ACCOUNT_RECOVERY_CLEANUP_FAILED');
  }
  return transactions.map(({ id, roots }) => ({ id, roots }));
}

async function storeRecoveryTransactions(journalPath, transactions) {
  if (!journalPath) return;
  if (!transactions.length) { await fs.rm(journalPath, { force: true }); return; }
  if (transactions.length > 16) throw recoveryFailure('Account verification cleanup needs attention.', 'AHT_ACCOUNT_RECOVERY_CLEANUP_FAILED');
  const [current, ...pending] = transactions;
  await writeJsonFile(journalPath, { ...current, ...(pending.length ? { pending } : {}) });
}

async function recordRecoveryTransaction(journalPath, id, entries) {
  if (!journalPath) return;
  const others = (await pendingRecoveryTransactions(journalPath)).filter(item => item.id !== id);
  await storeRecoveryTransactions(journalPath, [{ id, roots: entries }, ...others]);
}

export function recoveryRoots(config) {
  const primary = config.minecraftLauncher?.rootDir;
  if (!primary || !path.isAbsolute(primary)) throw recoveryFailure('Run Repair to prepare Minecraft Launcher before verifying this account.');
  const roots = new Map();
  for (const value of [primary, ...(config.minecraftLauncher.syncRoots || [])]) {
    if (typeof value === 'string' && path.isAbsolute(value)) roots.set(pathKey(value), path.resolve(value));
  }
  return [path.resolve(primary), ...[...roots.values()].filter(value => pathKey(value) !== pathKey(primary))];
}

// Remove only our exact temporary entry/version. Never restore a whole-file snapshot.
export async function cleanRecoveryProfile(root, id, previousSelection = '') {
  if (!ownedId(id)) throw recoveryFailure('Invalid recovery profile.');
  const missingOnly = error => { if (error.code === 'ENOENT') return null; throw error; };
  const profilesFile = path.join(root, 'launcher_profiles.json');
  const profiles = await readJsonFile(profilesFile).catch(missingOnly);
  if (profiles?.profiles?.[id]?.lastVersionId === id) {
    delete profiles.profiles[id];
    if (profiles.selectedProfile === id) {
      if (previousSelection && profiles.profiles[previousSelection]) profiles.selectedProfile = previousSelection;
      else delete profiles.selectedProfile;
    }
    await writeJsonFile(profilesFile, profiles);
  }
  const versionFile = path.join(root, 'versions', id, `${id}.json`);
  const version = await readJsonFile(versionFile).catch(missingOnly);
  if (version?.id === id && version?.mainClass === 'net.ahardtime.recovery.Main') {
    await fs.rm(versionFile, { force: true });
    await fs.rmdir(path.dirname(versionFile)).catch(() => {});
  }
}

export async function cleanRecoveryTransaction({ id, entries, journalPath }) {
  const failures = [];
  for (const entry of entries) {
    try { await cleanRecoveryProfile(entry.root, id, entry.previousSelection); }
    catch (error) { failures.push(error); }
  }
  // Retain the journal when cleanup fails so the next startup can finish safely.
  if (failures.length) throw recoveryFailure('Account verification cleanup needs attention. Retry account sync.', 'AHT_ACCOUNT_RECOVERY_CLEANUP_FAILED');
  if (journalPath) {
    const transactions = await pendingRecoveryTransactions(journalPath);
    const completed = new Set(entries.map(entry => pathKey(entry.root)));
    const remaining = transactions.map(item => item.id !== id ? item
      : { ...item, roots: item.roots.filter(entry => !completed.has(pathKey(entry.root))) });
    // Another transaction or an unprocessed old root remains recoverable.
    await storeRecoveryTransactions(journalPath, remaining.filter(item => item.roots.length));
  }
}

export async function cleanRecoveryJournal({ config, journalPath }) {
  if (!journalPath) return false;
  const transactions = await pendingRecoveryTransactions(journalPath);
  if (!transactions.length) return false;
  const allowed = new Set(recoveryRoots(config).map(pathKey));
  for (const item of transactions) {
    const entries = item.roots.filter(entry => allowed.has(pathKey(entry.root)));
    await cleanRecoveryTransaction({ id: item.id, entries, journalPath });
  }
  return !(await pendingRecoveryTransactions(journalPath)).length;
}

export async function prepareRecoveryProfiles({ config, roots, id, pin, jar, args, journalPath, entries, signal }) {
  throwIfRecoveryCancelled(signal);
  if (!ownedId(id)) throw recoveryFailure('Invalid recovery profile.');
  const initial = await readJsonFile(path.join(roots[0], 'launcher_profiles.json'));
  const sourceProfile = initial.profiles?.[config.minecraftLauncher.profileId]
    || Object.values(initial.profiles || {}).find(profile => profile?.gameDir
      && pathKey(profile.gameDir) === pathKey(config.instanceDir));
  const javaDir = config.minecraftLauncher.javaPath || sourceProfile?.javaDir;
  if (!javaDir || !path.isAbsolute(javaDir)) throw recoveryFailure('Run Repair to prepare Java before verifying this account.');
  for (const destination of roots) {
    throwIfRecoveryCancelled(signal);
    const profilesPath = path.join(destination, 'launcher_profiles.json');
    const profiles = await readJsonFile(profilesPath).catch(error => {
      // CurseForge may have been uninstalled. The primary Minecraft root remains required.
      if (destination !== roots[0] && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!profiles) continue;
    for (const [oldId, profile] of Object.entries(profiles.profiles || {})) {
      if (ownedId(oldId) && profile?.lastVersionId === oldId) await cleanRecoveryProfile(destination, oldId);
    }
    const initialCurrent = await readJsonFile(profilesPath);
    const entry = { root: destination, previousSelection: initialCurrent.selectedProfile || '' };
    entries.push(entry);
    await recordRecoveryTransaction(journalPath, id, entries);
    const libPath = `net/ahardtime/account-recovery/${pin.version}/account-recovery-${pin.version}.jar`;
    await fs.mkdir(path.dirname(path.join(destination, 'libraries', libPath)), { recursive: true });
    await fs.writeFile(path.join(destination, 'libraries', libPath), jar);
    await writeJsonFile(path.join(destination, 'versions', id, `${id}.json`), {
      id, inheritsFrom: '1.12.2', type: 'release', mainClass: 'net.ahardtime.recovery.Main',
      time: new Date().toISOString(), releaseTime: new Date().toISOString(), minecraftArguments: args.join(' '),
      libraries: [{ name: `net.ahardtime:account-recovery:${pin.version}`, downloads: { artifact: {
        path: libPath, url: '', size: jar.length, sha1: createHash('sha1').update(jar).digest('hex')
      } } }]
    });
    // Minecraft/CurseForge may change metadata while the helper files are written.
    // Merge our exact entry into the latest document, never that earlier snapshot.
    const current = await readJsonFile(profilesPath);
    entry.previousSelection = current.selectedProfile || '';
    await recordRecoveryTransaction(journalPath, id, entries);
    current.profiles = current.profiles || {};
    current.profiles[id] = { name: 'AHT Account Verification', type: 'custom', lastVersionId: id,
      javaDir, javaArgs: '-Xmx128M', gameDir: path.join(destination, 'versions', id),
      created: new Date().toISOString(), lastUsed: new Date().toISOString() };
    if (Number(current.version) > 0 && Number(current.version) < 3) current.selectedProfile = id;
    throwIfRecoveryCancelled(signal);
    await writeJsonFile(profilesPath, current);
  }
}
