import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  downloadToFile,
  ensureDir,
  fetchJson,
  hashFile,
  pathExists,
  readJsonFile,
  writeJsonFile
} from './utils.js';
import { launcherProofJavaArgs, launcherProofPath } from './launcherProof.js';
import { minecraftServiceFailureMessage } from './minecraftServiceStatus.js';
import { findInstalledForgeVersion } from './forgeInstaller.js';

export function defaultMinecraftRoot(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), '.minecraft');
  }
  const home = env.HOME || os.homedir();
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'minecraft');
  }
  return path.posix.join(home, '.minecraft');
}

export function minecraftRootCandidates(platform = process.platform, env = process.env) {
  const primary = defaultMinecraftRoot(platform, env);
  if (platform === 'win32') {
    const roots = [primary];
    if (env.LOCALAPPDATA) {
      roots.push(path.win32.join(
        env.LOCALAPPDATA,
        'Packages',
        'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
        'LocalCache',
        'Roaming',
        '.minecraft'
      ));
    }
    return uniqueLauncherRoots(roots, platform);
  }
  if (platform !== 'darwin') {
    return uniqueLauncherRoots([primary], platform);
  }
  const home = env.HOME || os.homedir();
  return uniqueLauncherRoots([
    primary,
    path.posix.join(home, 'Library', 'Application Support', 'Minecraft'),
    path.posix.join(home, 'Library', 'Application Support', 'com.mojang.minecraftlauncher')
  ], platform);
}

function launcherRootKey(rootDir = '', platform = process.platform) {
  const text = String(rootDir || '').trim();
  if (!text) {
    return '';
  }
  const normalized = platform === 'win32'
    ? path.win32.normalize(text).toLowerCase()
    : path.posix.normalize(text);
  return normalized.replace(/[\\/]+$/, '');
}

function uniqueLauncherRoots(roots = [], platform = process.platform) {
  const seen = new Set();
  const ordered = [];
  for (const root of roots) {
    const text = String(root || '').trim();
    const key = launcherRootKey(text, platform);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(text);
  }
  return ordered;
}

export function primaryModLoader(minecraft = {}) {
  const loaders = Array.isArray(minecraft.modLoaders) ? minecraft.modLoaders : [];
  return loaders.find((loader) => loader.primary) || loaders[0] || null;
}

export function loaderVersionId(minecraft = {}) {
  const minecraftVersion = minecraft.version || '';
  const loader = primaryModLoader(minecraft);
  const loaderId = loader?.id || '';
  if (!minecraftVersion || !loaderId) {
    return '';
  }
  if (loaderId.startsWith('forge-')) {
    return `${minecraftVersion}-forge-${loaderId.slice('forge-'.length)}`;
  }
  if (loaderId.startsWith('fabric-')) {
    return `${minecraftVersion}-${loaderId}`;
  }
  return `${minecraftVersion}-${loaderId}`;
}

export function loaderInstallerUrl(minecraft = {}) {
  const loader = primaryModLoader(minecraft);
  return String(
    loader?.installerUrl
    || minecraft?.forgeInstallerUrl
    || minecraft?.loaderInstallerUrl
    || ''
  ).trim();
}

function uniqueVersionIds(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    result.push(text);
  }
  return result;
}

const MOJANG_VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MINECRAFT_ASSET_OBJECT_BASE_URL = 'https://resources.download.minecraft.net/';
const MINECRAFT_LIBRARY_BASE_URL = 'https://libraries.minecraft.net/';
export const PLAYER_MINECRAFT_PROFILE_ID = 'a-hard-time';
export const DEVELOPER_MINECRAFT_PROFILE_ID = 'a-hard-time-developer';
export const LEGACY_AHT_MINECRAFT_PROFILE_IDS = ['a-hard-time-dregora'];
const AHT_MANAGED_PROFILE_IDS = [
  PLAYER_MINECRAFT_PROFILE_ID,
  DEVELOPER_MINECRAFT_PROFILE_ID,
  ...LEGACY_AHT_MINECRAFT_PROFILE_IDS
];

function repairableJsonError(error = null) {
  return error instanceof SyntaxError || error?.code === 'ENOENT' || /Unexpected end of JSON input|Unexpected token/i.test(String(error?.message || error || ''));
}

function corruptJsonBackupPath(file = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.aht-corrupt-${stamp}.bak`;
}

async function backupCorruptJson(file = '') {
  try {
    if (await pathExists(file)) {
      await fs.copyFile(file, corruptJsonBackupPath(file));
    }
  } catch {
    // Backups are best-effort; launcher setup should continue with a clean replacement.
  }
}

async function readRepairableJsonFile(file, fallback = null) {
  if (!(await pathExists(file))) {
    return fallback;
  }
  try {
    const value = await readJsonFile(file);
    return value && typeof value === 'object' ? value : fallback;
  } catch (error) {
    if (!repairableJsonError(error)) {
      throw error;
    }
    await backupCorruptJson(file);
    return fallback;
  }
}

async function fetchMinecraftJson(source, fetchJsonImpl = fetchJson) {
  try {
    return await fetchJsonImpl(source);
  } catch (error) {
    const serviceMessage = minecraftServiceFailureMessage(`${source} ${error?.message || error}`);
    if (serviceMessage) {
      throw new Error(serviceMessage);
    }
    throw error;
  }
}

function loaderVersionIdCandidates(minecraft = {}) {
  const primary = loaderVersionId(minecraft);
  const loader = primaryModLoader(minecraft);
  const loaderId = loader?.id || '';
  const minecraftVersion = minecraft.version || '';
  const candidates = [primary];
  if (loaderId?.startsWith('forge-') && minecraftVersion) {
    const forgeVersion = loaderId.slice('forge-'.length);
    candidates.push(
      `${minecraftVersion}-forge-${forgeVersion}`,
      `${minecraftVersion}-forge${minecraftVersion}-${forgeVersion}`,
      `${minecraftVersion}-Forge${forgeVersion}-${minecraftVersion}`
    );
  }
  if (loaderId && loaderId !== primary) {
    candidates.push(loaderId);
  }
  return uniqueVersionIds(candidates);
}

function profileIdFor(packId = PLAYER_MINECRAFT_PROFILE_ID) {
  return String(packId)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || PLAYER_MINECRAFT_PROFILE_ID;
}

function profileIdForConfig(config = {}, latest = null, installed = null) {
  const requested = String(config.minecraftLauncher?.profileId || '').trim();
  const requestedKey = ahtProfileIdKey(requested);
  if (!requested || LEGACY_AHT_MINECRAFT_PROFILE_IDS.includes(requestedKey)) {
    return isAhtDeveloperGameDir(config.instanceDir)
      ? DEVELOPER_MINECRAFT_PROFILE_ID
      : PLAYER_MINECRAFT_PROFILE_ID;
  }
  return requested || profileIdFor(latest?.packId || installed?.packId || config.packId);
}

function quoteJavaValue(value = '') {
  const text = String(value || '');
  return text.includes(' ') ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function memoryMbFor(config = {}) {
  const value = Number(config.minecraftLauncher?.memoryMb || 4096);
  if (!Number.isFinite(value)) {
    return 4096;
  }
  return Math.max(4096, Math.min(32768, Math.round(value / 512) * 512));
}

function javaArgsFor({ config = {}, rootDir = '', gameDir = '' }) {
  const ram = memoryMbFor(config);
  const args = [];
  args.push(`-Xmx${ram}m`, '-Xms512m');
  if (config.launcherProof?.enabled !== false && gameDir) {
    args.push(...launcherProofJavaArgs(launcherProofPath(gameDir)));
  }
  if (gameDir) {
    args.push(
      `-Dminecraft.applet.TargetDirectory=${quoteJavaValue(path.resolve(gameDir))}`,
      '-Dfml.ignorePatchDiscrepancies=true',
      '-Dfml.ignoreInvalidMinecraftCertificates=true',
      '-Duser.language=en',
      '-Duser.country=US',
      `-DlibraryDirectory=${quoteJavaValue(path.join(rootDir, 'libraries'))}`
    );
  }
  return args.join(' ');
}

function minecraftRoot(config = {}) {
  return config.minecraftLauncher?.rootDir || defaultMinecraftRoot();
}

function minecraftProfileRoots(config = {}) {
  const defaultRoots = config.minecraftLauncher?.syncDefaultRoots === true
    ? minecraftRootCandidates()
    : [];
  const extraRoots = Array.isArray(config.minecraftLauncher?.syncRoots)
    ? config.minecraftLauncher.syncRoots
    : [];
  return uniqueLauncherRoots([
    minecraftRoot(config),
    ...defaultRoots,
    ...extraRoots
  ]);
}

function normalizedPathText(value = '') {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function ahtProfileIdKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isManagedAhtProfileId(profileId = '') {
  return AHT_MANAGED_PROFILE_IDS.includes(ahtProfileIdKey(profileId));
}

function profileLooksAhtOwned(profileId = '', profile = {}) {
  if (isManagedAhtProfileId(profileId)) {
    return true;
  }
  const name = String(profile?.name || '').trim().toLowerCase();
  return name === 'a hard time';
}

function isTemporaryAhtGameDir(gameDir = '') {
  const normalized = normalizedPathText(gameDir);
  return /\/(?:temp|tmp)\/aht-[^/]+/.test(normalized);
}

function isAhtDeveloperGameDir(gameDir = '') {
  const normalized = normalizedPathText(gameDir);
  return normalized.endsWith('/a hard time developer');
}

function isAhtPlayerGameDir(gameDir = '') {
  const normalized = normalizedPathText(gameDir);
  return normalized.endsWith('/a hard time') && !isAhtDeveloperGameDir(gameDir);
}

function staleAhtProfileReason(profileId = '', profile = {}) {
  const id = ahtProfileIdKey(profileId);
  const gameDir = profile?.gameDir || '';
  if (isTemporaryAhtGameDir(gameDir) && !isManagedAhtProfileId(id)) {
    return 'temp-game-dir';
  }
  if (LEGACY_AHT_MINECRAFT_PROFILE_IDS.includes(id)) {
    return 'legacy-profile-id';
  }
  if (id === PLAYER_MINECRAFT_PROFILE_ID && isAhtDeveloperGameDir(gameDir)) {
    return 'player-points-at-developer';
  }
  if (id === DEVELOPER_MINECRAFT_PROFILE_ID && isAhtPlayerGameDir(gameDir)) {
    return 'developer-points-at-player';
  }
  return '';
}

function cleanupStaleAhtProfiles(profiles = {}, state = {}) {
  const removed = [];
  const profileMap = profiles.profiles && typeof profiles.profiles === 'object' ? profiles.profiles : {};
  for (const [profileId, profile] of Object.entries(profileMap)) {
    if (profileId === state.profileId || !profileLooksAhtOwned(profileId, profile)) {
      continue;
    }
    const reason = staleAhtProfileReason(profileId, profile);
    if (!reason) {
      continue;
    }
    removed.push({
      profileId,
      reason,
      gameDir: profile?.gameDir || ''
    });
    delete profileMap[profileId];
  }
  return removed;
}

function pushMinecraftUsername(usernames, value = '') {
  const username = String(value || '').trim();
  if (/^[A-Za-z0-9_]{3,16}$/.test(username) && !usernames.includes(username)) {
    usernames.push(username);
    return true;
  }
  return false;
}

function orderedLauncherAccounts(accounts = {}) {
  const accountMap = accounts?.accounts && typeof accounts.accounts === 'object' ? accounts.accounts : {};
  const entries = Array.isArray(accountMap)
    ? accountMap.map((account, index) => [String(account?.localId || account?.id || index), account])
    : Object.entries(accountMap);
  const activeId = String(accounts?.activeAccountLocalId || '');
  return [
    ...entries.filter(([id]) => id === activeId),
    ...entries.filter(([id]) => id !== activeId)
  ].map(([, account]) => account);
}

function orderedLegacyProfilesAccounts(profiles = {}) {
  const database = profiles?.authenticationDatabase && typeof profiles.authenticationDatabase === 'object'
    ? profiles.authenticationDatabase
    : {};
  const entries = Object.entries(database);
  const selected = String(profiles?.selectedUser?.account || profiles?.selectedUser?.profile || '');
  return [
    ...entries.filter(([id]) => id === selected),
    ...entries.filter(([id]) => id !== selected)
  ].map(([, account]) => account);
}

export async function inspectMinecraftLauncherAuth(rootDir = '', options = {}) {
  const roots = uniqueLauncherRoots([
    rootDir,
    ...(options.extraRoots || [])
  ].filter(Boolean));
  if (!roots.length) {
    return { signedIn: false, accountCount: 0, files: [], usernames: [], preferredUsername: '' };
  }
  const candidates = [
    'launcher_accounts.json',
    'launcher_accounts_microsoft_store.json',
    'launcher_msa_credentials.bin',
    'launcher_msa_credentials_microsoft_store.bin',
    'launcher_profiles.json'
  ];
  const files = [];
  const usernames = [];
  let accountCount = 0;
  for (const root of roots) {
    for (const name of candidates) {
      const file = path.join(root, name);
      if (!(await pathExists(file))) {
        continue;
      }
      const displayName = roots.length > 1 ? `${root}:${name}` : name;
      if (!files.includes(displayName)) {
        files.push(displayName);
      }
      if (name.startsWith('launcher_accounts')) {
        try {
          const accounts = await readJsonFile(file);
          const accountItems = orderedLauncherAccounts(accounts);
          accountCount += accountItems.length;
          for (const account of accountItems) {
            pushMinecraftUsername(
              usernames,
              account?.minecraftProfile?.name || account?.displayName || account?.username
            );
          }
        } catch {}
      } else if (name === 'launcher_profiles.json') {
        try {
          const profiles = await readJsonFile(file);
          const accountItems = orderedLegacyProfilesAccounts(profiles);
          accountCount += accountItems.length;
          for (const account of accountItems) {
            pushMinecraftUsername(
              usernames,
              account?.displayName || account?.username || account?.profiles?.[0]?.displayName
            );
          }
        } catch {}
      }
    }
  }
  return {
    signedIn: accountCount > 0 || files.some((name) => String(name).includes('launcher_msa_credentials')),
    accountCount,
    files,
    usernames,
    preferredUsername: usernames[0] || '',
    profileKnown: usernames.length > 0,
    credentialOnly: accountCount === 0 && usernames.length === 0 && files.some((name) => String(name).includes('launcher_msa_credentials'))
  };
}

function profileName(config = {}, latest = null, installed = null) {
  return config.minecraftLauncher?.profileName || latest?.name || installed?.name || 'A Hard Time';
}

function minecraftMetadata(latest = null, installed = null) {
  return latest?.minecraft || installed?.minecraft || null;
}

function validBaseVersionJson(value = null, minecraftVersion = '') {
  return Boolean(
    value
    && typeof value === 'object'
    && (!minecraftVersion || value.id === minecraftVersion)
    && value.assetIndex
    && typeof value.assetIndex === 'object'
    && value.assetIndex.id
    && value.assetIndex.url
  );
}

function validAssetIndexJson(value = null) {
  return Boolean(value && typeof value === 'object' && value.objects && typeof value.objects === 'object');
}

function legacyAssetIndexAliasIds(minecraftVersion = '', assetId = '') {
  const version = String(minecraftVersion || '').trim();
  const aliases = new Set();
  if (/^1\.(?:[0-9]|1[0-2])(?:\.|$)/.test(version)) {
    aliases.add('legacy');
  }
  aliases.delete(String(assetId || '').trim());
  return [...aliases].filter(Boolean);
}

async function ensureAssetIndexAliases(rootDir = '', minecraftVersion = '', assetId = '', assetIndex = null, actions = []) {
  for (const aliasId of legacyAssetIndexAliasIds(minecraftVersion, assetId)) {
    const aliasPath = path.join(rootDir, 'assets', 'indexes', `${aliasId}.json`);
    const existing = await readRepairableJsonFile(aliasPath, null);
    if (validAssetIndexJson(existing)) {
      continue;
    }
    await writeJsonFile(aliasPath, assetIndex);
    actions.push(`wrote ${aliasPath}`);
  }
}

async function readFallbackBaseVersionJson(rootDirs = [], minecraftVersion = '') {
  for (const rootDir of uniqueLauncherRoots(rootDirs)) {
    const file = path.join(rootDir, 'versions', minecraftVersion, `${minecraftVersion}.json`);
    const value = await readRepairableJsonFile(file, null);
    if (validBaseVersionJson(value, minecraftVersion)) {
      return { value, file };
    }
  }
  return null;
}

async function readFallbackAssetIndexJson(rootDirs = [], assetId = '') {
  for (const rootDir of uniqueLauncherRoots(rootDirs)) {
    const file = path.join(rootDir, 'assets', 'indexes', `${assetId}.json`);
    const value = await readRepairableJsonFile(file, null);
    if (validAssetIndexJson(value)) {
      return { value, file };
    }
  }
  return null;
}

function validAssetObjectHash(value = '') {
  return /^[a-f0-9]{40}$/i.test(String(value || '').trim());
}

function assetObjectEntries(assetIndex = null) {
  const objects = assetIndex?.objects && typeof assetIndex.objects === 'object' ? assetIndex.objects : {};
  return Object.entries(objects)
    .map(([name, item]) => ({
      name,
      hash: String(item?.hash || '').trim().toLowerCase(),
      size: Number.isFinite(Number(item?.size)) ? Number(item.size) : null
    }))
    .filter((item) => validAssetObjectHash(item.hash));
}

function assetObjectPath(rootDir = '', hash = '') {
  const normalized = String(hash || '').trim().toLowerCase();
  return path.join(rootDir, 'assets', 'objects', normalized.slice(0, 2), normalized);
}

function assetObjectUrl(hash = '', baseUrl = MINECRAFT_ASSET_OBJECT_BASE_URL) {
  const normalized = String(hash || '').trim().toLowerCase();
  const base = String(baseUrl || MINECRAFT_ASSET_OBJECT_BASE_URL);
  return new URL(`${normalized.slice(0, 2)}/${normalized}`, base.endsWith('/') ? base : `${base}/`).toString();
}

async function assetObjectNeedsRepair(file = '', entry = {}, verifyHashes = false) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) {
    return true;
  }
  if (Number.isFinite(entry.size) && entry.size >= 0 && stat.size !== entry.size) {
    return true;
  }
  if (verifyHashes) {
    return await hashFile(file, 'sha1') !== entry.hash;
  }
  return false;
}

async function assetObjectValidationError(entry = {}, source = '', dest = '') {
  const actualHash = await hashFile(dest, 'sha1').catch(() => 'missing');
  return new Error(`Minecraft asset ${entry.name || entry.hash} from ${source} did not match Mojang metadata after download. Expected ${entry.hash}, got ${actualHash}.`);
}

function minecraftLibraryOsName(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'osx';
  return 'linux';
}

function minecraftLibraryArchValue(arch = process.arch) {
  return /64/.test(String(arch || '')) ? '64' : '32';
}

function minecraftLibraryRuleMatches(rule = {}, platform = process.platform, arch = process.arch) {
  const osRule = rule?.os && typeof rule.os === 'object' ? rule.os : null;
  if (!osRule) return true;
  const osName = String(osRule.name || '').trim();
  if (osName && osName !== minecraftLibraryOsName(platform)) return false;
  const osArch = String(osRule.arch || '').trim();
  if (osArch && osArch !== arch && osArch !== minecraftLibraryArchValue(arch)) return false;
  const osVersion = String(osRule.version || '').trim();
  if (osVersion) {
    try {
      if (!(new RegExp(osVersion).test(os.release()))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function minecraftLibraryAllowed(library = {}, platform = process.platform, arch = process.arch) {
  const rules = Array.isArray(library?.rules) ? library.rules : [];
  if (!rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!minecraftLibraryRuleMatches(rule, platform, arch)) continue;
    allowed = String(rule?.action || '').trim().toLowerCase() === 'allow';
  }
  return allowed;
}

function minecraftLibraryCoordinatePath(name = '') {
  const parts = String(name || '').trim().split(':');
  if (parts.length < 3) return '';
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) return '';
  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${fileName}`;
}

function minecraftLibraryUrl(artifactPath = '', artifactUrl = '', baseUrl = MINECRAFT_LIBRARY_BASE_URL) {
  const explicit = String(artifactUrl || '').trim();
  if (explicit) return explicit;
  const rel = String(artifactPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return '';
  return new URL(rel, String(baseUrl || MINECRAFT_LIBRARY_BASE_URL)).toString();
}

function minecraftNativeClassifier(library = {}, platform = process.platform, arch = process.arch) {
  const natives = library?.natives && typeof library.natives === 'object' ? library.natives : {};
  const raw = String(natives[minecraftLibraryOsName(platform)] || '').trim();
  return raw ? raw.replace('${arch}', minecraftLibraryArchValue(arch)) : '';
}

function minecraftLibraryArtifactEntries(versionJson = null, options = {}) {
  const libraries = Array.isArray(versionJson?.libraries) ? versionJson.libraries : [];
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const entries = [];
  for (const library of libraries) {
    if (!minecraftLibraryAllowed(library, platform, arch)) continue;
    const name = String(library?.name || '').trim();
    const hasDownloads = library?.downloads && typeof library.downloads === 'object';
    const artifact = library?.downloads?.artifact && typeof library.downloads.artifact === 'object'
      ? library.downloads.artifact
      : {};
    const artifactPath = String(artifact.path || (!hasDownloads ? minecraftLibraryCoordinatePath(name) : '')).trim();
    if (artifactPath) {
      entries.push({
        name,
        path: artifactPath,
        url: minecraftLibraryUrl(artifactPath, artifact.url, options.libraryBaseUrl),
        sha1: String(artifact.sha1 || '').trim().toLowerCase(),
        size: Number.isFinite(Number(artifact.size)) ? Number(artifact.size) : null,
        classifier: ''
      });
    }
    const classifier = minecraftNativeClassifier(library, platform, arch);
    const nativeArtifact = classifier && library?.downloads?.classifiers?.[classifier]
      ? library.downloads.classifiers[classifier]
      : null;
    const nativePath = String(nativeArtifact?.path || (classifier ? minecraftLibraryCoordinatePath(`${name}:${classifier}`) : '')).trim();
    if (nativeArtifact && nativePath) {
      entries.push({
        name,
        path: nativePath,
        url: minecraftLibraryUrl(nativePath, nativeArtifact.url, options.libraryBaseUrl),
        sha1: String(nativeArtifact.sha1 || '').trim().toLowerCase(),
        size: Number.isFinite(Number(nativeArtifact.size)) ? Number(nativeArtifact.size) : null,
        classifier
      });
    }
  }
  const seen = new Set();
  return entries.filter((entry) => {
    const key = entry.path.toLowerCase();
    if (!entry.path || !entry.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function minecraftLibraryNeedsRepair(file = '', entry = {}, verifyHashes = false) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return true;
  if (Number.isFinite(entry.size) && entry.size >= 0 && stat.size !== entry.size) return true;
  if (verifyHashes && /^[a-f0-9]{40}$/i.test(entry.sha1 || '')) {
    return await hashFile(file, 'sha1') !== entry.sha1;
  }
  return false;
}

async function minecraftLibraryValidationError(entry = {}, source = '', dest = '') {
  const actualHash = await hashFile(dest, 'sha1').catch(() => 'missing');
  return new Error(`Minecraft library ${entry.path || entry.name} from ${source} did not match Mojang metadata after download. Expected ${entry.sha1 || 'unknown'}, got ${actualHash}.`);
}

async function copyMinecraftLibraryFromRoots({ entry, dest, rootDirs = [], verifyHashes = false, logger }) {
  const destKey = launcherRootKey(dest);
  for (const rootDir of uniqueLauncherRoots(rootDirs)) {
    const candidate = path.join(rootDir, 'libraries', entry.path);
    if (launcherRootKey(candidate) === destKey) continue;
    if (await minecraftLibraryNeedsRepair(candidate, entry, verifyHashes)) continue;
    await ensureDir(path.dirname(dest));
    await fs.copyFile(candidate, dest);
    if (await minecraftLibraryNeedsRepair(dest, entry, verifyHashes)) {
      await fs.rm(dest, { force: true }).catch(() => {});
      continue;
    }
    logger?.log?.(`Copied Minecraft library ${entry.path} from ${rootDir}`);
    return true;
  }
  return false;
}

async function repairMinecraftLibraryArtifact({ entry, dest, downloadFileImpl, verifyHashes, logger }) {
  const attempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(dest, { force: true }).catch(() => {});
      await downloadFileImpl(entry.url, dest, { logger, retries: 3 });
      if (await minecraftLibraryNeedsRepair(dest, entry, verifyHashes)) {
        throw await minecraftLibraryValidationError(entry, entry.url, dest);
      }
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        logger?.log?.(`Minecraft library ${entry.path} failed validation; retrying (${attempt + 1}/${attempts})...`);
      }
    }
  }
  const serviceMessage = minecraftServiceFailureMessage(`${entry.url} ${lastError?.message || lastError}`);
  throw new Error(serviceMessage || lastError?.message || String(lastError));
}

async function ensureMinecraftLibraries({
  rootDir = '',
  versionJson = null,
  downloadFileImpl = downloadToFile,
  fallbackRootDirs = [],
  verifyHashes = false,
  libraryBaseUrl = MINECRAFT_LIBRARY_BASE_URL,
  platform = process.platform,
  arch = process.arch,
  logger = null
} = {}) {
  const entries = minecraftLibraryArtifactEntries(versionJson, { libraryBaseUrl, platform, arch });
  let downloaded = 0;
  let copied = 0;
  for (const entry of entries) {
    const dest = path.join(rootDir, 'libraries', entry.path);
    if (!(await minecraftLibraryNeedsRepair(dest, entry, verifyHashes))) {
      continue;
    }
    if (await copyMinecraftLibraryFromRoots({ entry, dest, rootDirs: fallbackRootDirs, verifyHashes, logger })) {
      copied += 1;
      continue;
    }
    logger?.log?.(`Repairing Minecraft library ${entry.path}`);
    await repairMinecraftLibraryArtifact({ entry, dest, downloadFileImpl, verifyHashes, logger });
    downloaded += 1;
  }
  return {
    checked: entries.length,
    downloaded,
    copied
  };
}

function minecraftRuntimeArtifactEntries(versionJson = null) {
  const entries = [];
  const versionId = String(versionJson?.id || '').trim();
  const client = versionJson?.downloads?.client && typeof versionJson.downloads.client === 'object'
    ? versionJson.downloads.client
    : null;
  if (versionId && client?.url) {
    entries.push({
      kind: 'client jar',
      name: `${versionId}.jar`,
      path: path.join('versions', versionId, `${versionId}.jar`),
      url: String(client.url || '').trim(),
      sha1: String(client.sha1 || '').trim().toLowerCase(),
      size: Number.isFinite(Number(client.size)) ? Number(client.size) : null
    });
  }
  const loggingFile = versionJson?.logging?.client?.file && typeof versionJson.logging.client.file === 'object'
    ? versionJson.logging.client.file
    : null;
  const loggingId = String(loggingFile?.id || '').trim();
  if (loggingId && loggingFile?.url) {
    entries.push({
      kind: 'logging config',
      name: loggingId,
      path: path.join('assets', 'log_configs', loggingId),
      url: String(loggingFile.url || '').trim(),
      sha1: String(loggingFile.sha1 || '').trim().toLowerCase(),
      size: Number.isFinite(Number(loggingFile.size)) ? Number(loggingFile.size) : null
    });
  }
  return entries;
}

async function minecraftRuntimeArtifactNeedsRepair(file = '', entry = {}, verifyHashes = false) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return true;
  if (Number.isFinite(entry.size) && entry.size >= 0 && stat.size !== entry.size) return true;
  if (verifyHashes && /^[a-f0-9]{40}$/i.test(entry.sha1 || '')) {
    return await hashFile(file, 'sha1') !== entry.sha1;
  }
  return false;
}

async function minecraftRuntimeArtifactValidationError(entry = {}, dest = '') {
  const actualHash = await hashFile(dest, 'sha1').catch(() => 'missing');
  return new Error(`Minecraft ${entry.kind || 'runtime file'} ${entry.name || entry.path} from ${entry.url} did not match Mojang metadata after download. Expected ${entry.sha1 || 'unknown'}, got ${actualHash}.`);
}

async function copyMinecraftRuntimeArtifactFromRoots({ entry, dest, rootDirs = [], verifyHashes = false, logger }) {
  const destKey = launcherRootKey(dest);
  for (const rootDir of uniqueLauncherRoots(rootDirs)) {
    const candidate = path.join(rootDir, entry.path);
    if (launcherRootKey(candidate) === destKey) continue;
    if (await minecraftRuntimeArtifactNeedsRepair(candidate, entry, verifyHashes)) continue;
    await ensureDir(path.dirname(dest));
    await fs.copyFile(candidate, dest);
    if (await minecraftRuntimeArtifactNeedsRepair(dest, entry, verifyHashes)) {
      await fs.rm(dest, { force: true }).catch(() => {});
      continue;
    }
    logger?.log?.(`Copied Minecraft ${entry.kind} ${entry.name} from ${rootDir}`);
    return true;
  }
  return false;
}

async function repairMinecraftRuntimeArtifact({ entry, dest, downloadFileImpl, verifyHashes, logger }) {
  const attempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(dest, { force: true }).catch(() => {});
      await downloadFileImpl(entry.url, dest, { logger, retries: 3 });
      if (await minecraftRuntimeArtifactNeedsRepair(dest, entry, verifyHashes)) {
        throw await minecraftRuntimeArtifactValidationError(entry, dest);
      }
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        logger?.log?.(`Minecraft ${entry.kind} ${entry.name} failed validation; retrying (${attempt + 1}/${attempts})...`);
      }
    }
  }
  const serviceMessage = minecraftServiceFailureMessage(`${entry.url} ${lastError?.message || lastError}`);
  throw new Error(serviceMessage || lastError?.message || String(lastError));
}

async function ensureMinecraftRuntimeArtifacts({
  rootDir = '',
  versionJson = null,
  downloadFileImpl = downloadToFile,
  fallbackRootDirs = [],
  verifyHashes = false,
  logger = null
} = {}) {
  const entries = minecraftRuntimeArtifactEntries(versionJson);
  let downloaded = 0;
  let copied = 0;
  for (const entry of entries) {
    const dest = path.join(rootDir, entry.path);
    if (!(await minecraftRuntimeArtifactNeedsRepair(dest, entry, verifyHashes))) {
      continue;
    }
    if (await copyMinecraftRuntimeArtifactFromRoots({ entry, dest, rootDirs: fallbackRootDirs, verifyHashes, logger })) {
      copied += 1;
      continue;
    }
    logger?.log?.(`Repairing Minecraft ${entry.kind} ${entry.name}`);
    await repairMinecraftRuntimeArtifact({ entry, dest, downloadFileImpl, verifyHashes, logger });
    downloaded += 1;
  }
  return {
    checked: entries.length,
    downloaded,
    copied
  };
}

async function repairMinecraftAssetObject({ entry, dest, source, downloadFileImpl, logger }) {
  const attempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(dest, { force: true }).catch(() => {});
      await downloadFileImpl(source, dest, { logger, retries: 3 });
      if (await assetObjectNeedsRepair(dest, entry, true)) {
        throw await assetObjectValidationError(entry, source, dest);
      }
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        logger?.log?.(`Minecraft asset ${entry.name || entry.hash} failed validation; retrying (${attempt + 1}/${attempts})...`);
      }
    }
  }
  const serviceMessage = minecraftServiceFailureMessage(`${source} ${lastError?.message || lastError}`);
  throw new Error(serviceMessage || lastError?.message || String(lastError));
}

async function copyMinecraftAssetObjectFromRoots({ entry, dest, rootDirs = [], logger }) {
  const destKey = launcherRootKey(dest);
  for (const rootDir of uniqueLauncherRoots(rootDirs)) {
    const candidate = assetObjectPath(rootDir, entry.hash);
    if (launcherRootKey(candidate) === destKey) {
      continue;
    }
    if (await assetObjectNeedsRepair(candidate, entry, true)) {
      continue;
    }
    await ensureDir(path.dirname(dest));
    await fs.copyFile(candidate, dest);
    if (await assetObjectNeedsRepair(dest, entry, true)) {
      await fs.rm(dest, { force: true }).catch(() => {});
      continue;
    }
    logger?.log?.(`Copied Minecraft asset ${entry.name || entry.hash} from ${rootDir}`);
    return true;
  }
  return false;
}

async function ensureMinecraftAssetObjects({
  rootDir = '',
  assetIndex = null,
  assetBaseUrl = MINECRAFT_ASSET_OBJECT_BASE_URL,
  downloadFileImpl = downloadToFile,
  fallbackRootDirs = [],
  verifyAssetHashes = false,
  logger = null
} = {}) {
  const entries = assetObjectEntries(assetIndex);
  let downloaded = 0;
  let copied = 0;
  for (const entry of entries) {
    const dest = assetObjectPath(rootDir, entry.hash);
    if (!(await assetObjectNeedsRepair(dest, entry, verifyAssetHashes))) {
      continue;
    }
    if (await copyMinecraftAssetObjectFromRoots({ entry, dest, rootDirs: fallbackRootDirs, logger })) {
      copied += 1;
      continue;
    }
    const source = assetObjectUrl(entry.hash, assetBaseUrl);
    logger?.log?.(`Repairing Minecraft asset ${entry.name || entry.hash}`);
    await repairMinecraftAssetObject({ entry, dest, source, downloadFileImpl, logger });
    downloaded += 1;
  }
  return {
    checked: entries.length,
    downloaded,
    copied
  };
}

async function fetchMinecraftBaseVersionJson(minecraftVersion, { manifestUrl = MOJANG_VERSION_MANIFEST_URL, fetchJsonImpl = fetchJson } = {}) {
  const manifest = await fetchMinecraftJson(manifestUrl, fetchJsonImpl);
  const match = Array.isArray(manifest?.versions)
    ? manifest.versions.find((item) => item?.id === minecraftVersion && item?.url)
    : null;
  if (!match) {
    throw new Error(`Minecraft ${minecraftVersion} was not found in Mojang's version manifest.`);
  }
  const versionJson = await fetchMinecraftJson(match.url, fetchJsonImpl);
  if (!validBaseVersionJson(versionJson, minecraftVersion)) {
    throw new Error(`Mojang returned incomplete Minecraft ${minecraftVersion} metadata.`);
  }
  return versionJson;
}

async function ensureMinecraftRootAssets({
  rootDir = '',
  minecraftVersion = '',
  manifestUrl = MOJANG_VERSION_MANIFEST_URL,
  fetchJsonImpl = fetchJson,
  downloadFileImpl = downloadToFile,
  assetBaseUrl = MINECRAFT_ASSET_OBJECT_BASE_URL,
  libraryBaseUrl = MINECRAFT_LIBRARY_BASE_URL,
  ensureAssetObjects = true,
  ensureLibraries = true,
  ensureRuntimeArtifacts = true,
  fallbackRootDirs = [],
  verifyAssetHashes = false,
  verifyLibraryHashes = verifyAssetHashes,
  verifyRuntimeHashes = verifyAssetHashes,
  logger = null
} = {}) {
  if (!rootDir || !minecraftVersion) {
    return { ok: false, skipped: true, reason: 'missing root or Minecraft version', rootDir, minecraftVersion };
  }
  const actions = [];
  const versionDir = path.join(rootDir, 'versions', minecraftVersion);
  const versionJsonPath = path.join(versionDir, `${minecraftVersion}.json`);
  let versionJson = await readRepairableJsonFile(versionJsonPath, null);
  if (!validBaseVersionJson(versionJson, minecraftVersion)) {
    const fallback = await readFallbackBaseVersionJson(fallbackRootDirs, minecraftVersion);
    if (fallback) {
      logger?.log?.(`Copying Minecraft ${minecraftVersion} version metadata from ${fallback.file}`);
      versionJson = fallback.value;
    } else {
      logger?.log?.(`Repairing Minecraft ${minecraftVersion} version metadata in ${rootDir}`);
      versionJson = await fetchMinecraftBaseVersionJson(minecraftVersion, { manifestUrl, fetchJsonImpl });
    }
    await writeJsonFile(versionJsonPath, versionJson);
    actions.push(`wrote ${versionJsonPath}`);
  }

  const assetId = String(versionJson.assetIndex.id || '').trim();
  const assetUrl = String(versionJson.assetIndex.url || '').trim();
  const assetIndexPath = path.join(rootDir, 'assets', 'indexes', `${assetId}.json`);
  let assetIndex = await readRepairableJsonFile(assetIndexPath, null);
  if (!validAssetIndexJson(assetIndex)) {
    const fallback = await readFallbackAssetIndexJson(fallbackRootDirs, assetId);
    if (fallback) {
      logger?.log?.(`Copying Minecraft asset index ${assetId} from ${fallback.file}`);
      assetIndex = fallback.value;
    } else {
      logger?.log?.(`Repairing Minecraft asset index ${assetId} in ${rootDir}`);
      assetIndex = await fetchMinecraftJson(assetUrl, fetchJsonImpl);
    }
    if (!validAssetIndexJson(assetIndex)) {
      throw new Error(`Mojang returned incomplete Minecraft asset index ${assetId}.`);
    }
    await writeJsonFile(assetIndexPath, assetIndex);
    actions.push(`wrote ${assetIndexPath}`);
  }
  await ensureAssetIndexAliases(rootDir, minecraftVersion, assetId, assetIndex, actions);
  const assetObjects = ensureAssetObjects
    ? await ensureMinecraftAssetObjects({
      rootDir,
      assetIndex,
      downloadFileImpl,
      assetBaseUrl,
      fallbackRootDirs,
      verifyAssetHashes,
      logger
    })
    : { checked: 0, downloaded: 0, copied: 0 };
  if (assetObjects.downloaded > 0) {
    actions.push(`downloaded ${assetObjects.downloaded} Minecraft asset object${assetObjects.downloaded === 1 ? '' : 's'}`);
  }
  if (assetObjects.copied > 0) {
    actions.push(`copied ${assetObjects.copied} Minecraft asset object${assetObjects.copied === 1 ? '' : 's'} from another launcher root`);
  }
  const libraries = ensureLibraries
    ? await ensureMinecraftLibraries({
      rootDir,
      versionJson,
      downloadFileImpl,
      fallbackRootDirs,
      verifyHashes: verifyLibraryHashes,
      libraryBaseUrl,
      logger
    })
    : { checked: 0, downloaded: 0, copied: 0 };
  if (libraries.downloaded > 0) {
    actions.push(`downloaded ${libraries.downloaded} Minecraft librar${libraries.downloaded === 1 ? 'y' : 'ies'}`);
  }
  if (libraries.copied > 0) {
    actions.push(`copied ${libraries.copied} Minecraft librar${libraries.copied === 1 ? 'y' : 'ies'} from another launcher root`);
  }
  const runtimeArtifacts = ensureRuntimeArtifacts
    ? await ensureMinecraftRuntimeArtifacts({
      rootDir,
      versionJson,
      downloadFileImpl,
      fallbackRootDirs,
      verifyHashes: verifyRuntimeHashes,
      logger
    })
    : { checked: 0, downloaded: 0, copied: 0 };
  if (runtimeArtifacts.downloaded > 0) {
    actions.push(`downloaded ${runtimeArtifacts.downloaded} Minecraft runtime file${runtimeArtifacts.downloaded === 1 ? '' : 's'}`);
  }
  if (runtimeArtifacts.copied > 0) {
    actions.push(`copied ${runtimeArtifacts.copied} Minecraft runtime file${runtimeArtifacts.copied === 1 ? '' : 's'} from another launcher root`);
  }

  return {
    ok: true,
    rootDir,
    minecraftVersion,
    versionJsonPath,
    assetIndexPath,
    assetId,
    assetObjects,
    libraries,
    runtimeArtifacts,
    repaired: actions.length > 0,
    actions
  };
}

export async function ensureMinecraftLauncherAssets({
  config = {},
  latest = null,
  installed = null,
  profile = null,
  manifestUrl = MOJANG_VERSION_MANIFEST_URL,
  fetchJsonImpl = fetchJson,
  downloadFileImpl = downloadToFile,
  assetBaseUrl = MINECRAFT_ASSET_OBJECT_BASE_URL,
  libraryBaseUrl = MINECRAFT_LIBRARY_BASE_URL,
  ensureAssetObjects = true,
  ensureLibraries = true,
  ensureRuntimeArtifacts = true,
  verifyAssetHashes = false,
  verifyLibraryHashes = verifyAssetHashes,
  verifyRuntimeHashes = verifyAssetHashes,
  logger = null
} = {}) {
  const minecraft = minecraftMetadata(latest, installed);
  const minecraftVersion = minecraft?.version || profile?.minecraftVersion || '';
  if (!minecraftVersion) {
    return { ok: false, skipped: true, reason: 'release metadata does not include a Minecraft version', roots: [] };
  }
  const profileRoots = Array.isArray(profile?.syncedProfiles) && profile.syncedProfiles.length
    ? profile.syncedProfiles.map((item) => item.rootDir)
    : [profile?.rootDir || minecraftRoot(config)];
  const roots = uniqueLauncherRoots(profileRoots);
  const results = [];
  for (const rootDir of roots) {
    results.push(await ensureMinecraftRootAssets({
      rootDir,
      minecraftVersion,
      manifestUrl,
      fetchJsonImpl,
      downloadFileImpl,
      assetBaseUrl,
      libraryBaseUrl,
      ensureAssetObjects,
      ensureLibraries,
      ensureRuntimeArtifacts,
      fallbackRootDirs: roots.filter((candidate) => launcherRootKey(candidate) !== launcherRootKey(rootDir)),
      verifyAssetHashes,
      verifyLibraryHashes,
      verifyRuntimeHashes,
      logger
    }));
  }
  return {
    ok: true,
    minecraftVersion,
    roots: results,
    assetObjects: {
      checked: results.reduce((total, item) => total + (Number(item.assetObjects?.checked) || 0), 0),
      downloaded: results.reduce((total, item) => total + (Number(item.assetObjects?.downloaded) || 0), 0),
      copied: results.reduce((total, item) => total + (Number(item.assetObjects?.copied) || 0), 0)
    },
    libraries: {
      checked: results.reduce((total, item) => total + (Number(item.libraries?.checked) || 0), 0),
      downloaded: results.reduce((total, item) => total + (Number(item.libraries?.downloaded) || 0), 0),
      copied: results.reduce((total, item) => total + (Number(item.libraries?.copied) || 0), 0)
    },
    runtimeArtifacts: {
      checked: results.reduce((total, item) => total + (Number(item.runtimeArtifacts?.checked) || 0), 0),
      downloaded: results.reduce((total, item) => total + (Number(item.runtimeArtifacts?.downloaded) || 0), 0),
      copied: results.reduce((total, item) => total + (Number(item.runtimeArtifacts?.copied) || 0), 0)
    },
    repaired: results.some((item) => item.repaired)
  };
}

async function readProfiles(file) {
  return readRepairableJsonFile(file, {});
}

async function profileStateForRoot({ config, latest = null, installed = null, rootDir = minecraftRoot(config), authRoots = null }) {
  const profilesPath = path.join(rootDir, 'launcher_profiles.json');
  const minecraft = minecraftMetadata(latest, installed);
  const versionCandidates = loaderVersionIdCandidates(minecraft || {});
  let versionId = versionCandidates[0] || '';
  let versionJson = versionId ? path.join(rootDir, 'versions', versionId, `${versionId}.json`) : '';
  let loaderInstalled = false;
  const loaderId = primaryModLoader(minecraft || {})?.id || '';
  if (loaderId.startsWith('forge-') && minecraft?.version && versionId) {
    const forgeInstall = await findInstalledForgeVersion({
      rootDir,
      minecraftVersion: minecraft.version,
      loaderId,
      versionId
    }, { backupInvalid: false });
    loaderInstalled = Boolean(forgeInstall.installed);
    if (forgeInstall.versionId) {
      versionId = forgeInstall.versionId;
      versionJson = forgeInstall.versionJson || path.join(rootDir, 'versions', versionId, `${versionId}.json`);
    }
  } else {
    for (const candidate of versionCandidates) {
      const candidateJson = path.join(rootDir, 'versions', candidate, `${candidate}.json`);
      if (await pathExists(candidateJson)) {
        versionId = candidate;
        versionJson = candidateJson;
        loaderInstalled = true;
        break;
      }
    }
  }
  const profileId = profileIdForConfig(config, latest, installed);
  const profile = await readProfiles(profilesPath).then((profiles) => profiles.profiles?.[profileId] || null).catch(() => null);
  const allAuthRoots = uniqueLauncherRoots(authRoots || [rootDir]);
  const auth = await inspectMinecraftLauncherAuth(rootDir, {
    extraRoots: allAuthRoots.filter((candidate) => launcherRootKey(candidate) !== launcherRootKey(rootDir))
  });
  return {
    enabled: config.minecraftLauncher?.enabled !== false,
    rootDir,
    profilesPath,
    profileId,
    profileName: profileName(config, latest, installed),
    profileExists: Boolean(profile),
    versionId,
    loaderInstalled,
    versionJson,
    gameDir: config.instanceDir,
    javaArgs: javaArgsFor({ config, rootDir, gameDir: config.instanceDir }),
    minecraftVersion: minecraft?.version || '',
    loaderId,
    loaderInstallerUrl: loaderInstallerUrl(minecraft || {}),
    accountReuseAvailable: auth.signedIn,
    accountProfileKnown: Boolean(auth.profileKnown),
    accountCredentialOnly: Boolean(auth.credentialOnly),
    accountCount: auth.accountCount,
    accountFiles: auth.files,
    accountUsernames: auth.usernames,
    preferredMinecraftUsername: auth.preferredUsername
  };
}

async function profileState({ config, latest = null, installed = null }) {
  const roots = minecraftProfileRoots(config);
  const states = [];
  for (const rootDir of roots) {
    states.push(await profileStateForRoot({
      config,
      latest,
      installed,
      rootDir,
      authRoots: roots
    }));
  }
  const primaryRoot = roots[0] || minecraftRoot(config);
  const primaryState = states.find((state) => launcherRootKey(state.rootDir) === launcherRootKey(primaryRoot))
    || states[0]
    || await profileStateForRoot({ config, latest, installed, rootDir: primaryRoot, authRoots: roots });
  return {
    ...primaryState,
    syncedProfiles: states,
    syncedProfileCount: states.length
  };
}

export async function inspectMinecraftLauncherProfile(options) {
  return profileState(options);
}

async function writeMinecraftLauncherProfile(state) {
  await ensureDir(state.rootDir);
  const profiles = await readProfiles(state.profilesPath);
  profiles.profiles = profiles.profiles && typeof profiles.profiles === 'object' ? profiles.profiles : {};
  const profileCleanup = cleanupStaleAhtProfiles(profiles, state);

  const now = new Date().toISOString();
  const existing = profiles.profiles[state.profileId] || {};
  const next = {
    ...existing,
    name: state.profileName,
    type: 'custom',
    created: existing.created || now,
    lastUsed: now,
    lastVersionId: state.versionId,
    gameDir: path.resolve(state.gameDir)
  };
  if (state.javaArgs) {
    next.javaArgs = state.javaArgs;
  }
  profiles.profiles[state.profileId] = next;
  profiles.selectedProfile = state.profileId;
  await writeJsonFile(state.profilesPath, profiles);
  return {
    ...state,
    profileExists: true,
    profileCleanup
  };
}

export async function ensureMinecraftLauncherProfile({ config, latest = null, installed = null }) {
  const roots = minecraftProfileRoots(config);
  const state = await profileStateForRoot({
    config,
    latest,
    installed,
    rootDir: roots[0] || minecraftRoot(config),
    authRoots: roots
  });
  if (!state.enabled) {
    return state;
  }
  if (!state.versionId) {
    throw new Error('Minecraft loader metadata is missing from the release feed.');
  }

  const syncedProfiles = [];
  for (const rootDir of roots) {
    const rootState = await profileStateForRoot({
      config,
      latest,
      installed,
      rootDir,
      authRoots: roots
    });
    if (!rootState.versionId) {
      continue;
    }
    syncedProfiles.push(await writeMinecraftLauncherProfile(rootState));
  }

  const primaryProfile = syncedProfiles.find((profile) => launcherRootKey(profile.rootDir) === launcherRootKey(state.rootDir))
    || await writeMinecraftLauncherProfile(state);
  return {
    ...primaryProfile,
    syncedProfiles,
    syncedProfileCount: syncedProfiles.length
  };
}
