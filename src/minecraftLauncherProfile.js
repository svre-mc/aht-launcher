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
  safeJoin,
  writeJsonFile
} from './utils.js';
import { launcherProofJavaArgs, launcherProofPath } from './launcherProof.js';
import { findInstalledForgeVersion } from './forgeInstaller.js';

const MIN_MINECRAFT_MEMORY_MB = 4096;

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

function safeMinecraftIdentifier(value = '') {
  const text = String(value || '').trim();
  return Boolean(
    text
    && text !== '.'
    && text !== '..'
    && text.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)
  );
}

export function loaderVersionId(minecraft = {}) {
  const minecraftVersion = minecraft.version || '';
  const loader = primaryModLoader(minecraft);
  const loaderId = loader?.id || '';
  if (!safeMinecraftIdentifier(minecraftVersion) || !safeMinecraftIdentifier(loaderId)) {
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

function repairableJsonError(error = null) {
  return error instanceof SyntaxError || error?.code === 'ENOENT' || /Unexpected end of JSON input|Unexpected token/i.test(String(error?.message || error || ''));
}

function corruptJsonBackupPath(file = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.aht-corrupt-${stamp}.bak`;
}

function invalidJsonBackupPath(file = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.aht-invalid-${stamp}.bak`;
}

async function backupCorruptJson(file = '') {
  if (!(await pathExists(file))) return '';
  const backupPath = corruptJsonBackupPath(file);
  await fs.copyFile(file, backupPath);
  return backupPath;
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

function loaderVersionIdCandidates(minecraft = {}) {
  const primary = loaderVersionId(minecraft);
  const loader = primaryModLoader(minecraft);
  const loaderId = loader?.id || '';
  const minecraftVersion = minecraft.version || '';
  if (!safeMinecraftIdentifier(minecraftVersion) || !safeMinecraftIdentifier(loaderId)) return [];
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

function profileIdFor(packId = 'a-hard-time-dregora') {
  return String(packId)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'aht-dregora';
}

function quoteJavaValue(value = '') {
  const text = String(value || '');
  return text.includes(' ') ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function memoryMbFor(config = {}, latest = null, installed = null) {
  const configured = Number(config.minecraftLauncher?.memoryMb);
  const recommended = Number(latest?.minecraft?.recommendedRam || installed?.minecraft?.recommendedRam);
  const value = Number.isFinite(configured)
    ? configured
    : (Number.isFinite(recommended) ? recommended : MIN_MINECRAFT_MEMORY_MB);
  if (!Number.isFinite(value)) {
    return MIN_MINECRAFT_MEMORY_MB;
  }
  return Math.max(MIN_MINECRAFT_MEMORY_MB, Math.min(32768, Math.round(value / 512) * 512));
}

async function backupInvalidJson(file = '') {
  if (!(await pathExists(file))) return '';
  const backupPath = invalidJsonBackupPath(file);
  await fs.copyFile(file, backupPath);
  return backupPath;
}

function javaArgsFor({ config = {}, latest = null, installed = null, rootDir = '', gameDir = '' }) {
  const ram = memoryMbFor(config, latest, installed);
  const args = [];
  args.push(`-Xmx${ram}m`, '-Xms512m');
  if (config.launcherProof?.enabled !== false && gameDir) {
    args.push(...launcherProofJavaArgs(launcherProofPath(
      gameDir,
      config.launcherProof?.channel || 'player',
      config.launcherProof?.proofDir ? { proofDir: config.launcherProof.proofDir } : {}
    )));
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
  const defaultRoots = config.minecraftLauncher?.syncDefaultRoots === false
    ? []
    : minecraftRootCandidates();
  const extraRoots = Array.isArray(config.minecraftLauncher?.syncRoots)
    ? config.minecraftLauncher.syncRoots
    : [];
  return uniqueLauncherRoots([
    minecraftRoot(config),
    ...defaultRoots,
    ...extraRoots
  ]);
}

function pushMinecraftUsername(usernames, value = '') {
  const username = String(value || '').trim();
  if (/^[A-Za-z0-9_]{3,16}$/.test(username) && !usernames.includes(username)) {
    usernames.push(username);
    return true;
  }
  return false;
}

function normalizeMinecraftProfileUuid(value = '') {
  const compact = String(value || '').trim().replace(/[{}-]/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact) || /^0{32}$/.test(compact)) return '';
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20)
  ].join('-');
}

function pushMinecraftAuthProfile(authProfiles, usernames, minecraftUuids, usernameValue = '', uuidValue = '') {
  const username = String(usernameValue || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return false;
  pushMinecraftUsername(usernames, username);
  const minecraftUuid = normalizeMinecraftProfileUuid(uuidValue);
  const existing = authProfiles.find((profile) => profile.username.toLowerCase() === username.toLowerCase());
  if (!existing) {
    authProfiles.push({ username, minecraftUuid });
  } else if (!existing.minecraftUuid && minecraftUuid) {
    existing.minecraftUuid = minecraftUuid;
  }
  if (minecraftUuid && !minecraftUuids.includes(minecraftUuid)) minecraftUuids.push(minecraftUuid);
  return true;
}

function orderedLegacyMinecraftProfiles(account = {}, selectedProfileId = '') {
  const source = account?.profiles && typeof account.profiles === 'object' ? account.profiles : {};
  const entries = Array.isArray(source)
    ? source.map((profile, index) => [String(profile?.id || profile?.uuid || index), profile])
    : Object.entries(source);
  const ordered = [
    ...entries.filter(([id]) => id === selectedProfileId),
    ...entries.filter(([id]) => id !== selectedProfileId)
  ];
  if (!ordered.length) {
    return [{
      username: account?.displayName || account?.username || '',
      minecraftUuid: account?.id || account?.uuid || ''
    }];
  }
  return ordered.map(([id, profile]) => ({
    username: profile?.displayName || profile?.name || account?.displayName || account?.username || '',
    minecraftUuid: profile?.id || profile?.uuid || id
  }));
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
    return {
      signedIn: false,
      accountCount: 0,
      files: [],
      usernames: [],
      minecraftUuids: [],
      profiles: [],
      preferredUsername: '',
      preferredMinecraftUuid: ''
    };
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
  const minecraftUuids = [];
  const authProfiles = [];
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
            pushMinecraftAuthProfile(
              authProfiles,
              usernames,
              minecraftUuids,
              account?.minecraftProfile?.name || account?.displayName || account?.username,
              account?.minecraftProfile?.id || account?.minecraftProfile?.uuid
            );
          }
        } catch {}
      } else if (name === 'launcher_profiles.json') {
        try {
          const profiles = await readJsonFile(file);
          const accountItems = orderedLegacyProfilesAccounts(profiles);
          const selectedProfileId = String(profiles?.selectedUser?.profile || '');
          accountCount += accountItems.length;
          for (const account of accountItems) {
            for (const profile of orderedLegacyMinecraftProfiles(account, selectedProfileId)) {
              pushMinecraftAuthProfile(
                authProfiles,
                usernames,
                minecraftUuids,
                profile.username,
                profile.minecraftUuid
              );
            }
          }
        } catch {}
      }
    }
  }
  const preferredUsername = usernames[0] || '';
  const preferredProfile = authProfiles.find(
    (profile) => profile.username.toLowerCase() === preferredUsername.toLowerCase()
  ) || null;
  return {
    signedIn: accountCount > 0 || files.some((name) => String(name).includes('launcher_msa_credentials')),
    accountCount,
    files,
    usernames,
    minecraftUuids,
    profiles: authProfiles,
    preferredUsername,
    preferredMinecraftUuid: preferredProfile?.minecraftUuid || ''
  };
}

function profileName(config = {}, latest = null, installed = null) {
  return config.minecraftLauncher?.profileName || latest?.name || installed?.name || 'A Hard Time';
}

function minecraftMetadata(latest = null, installed = null) {
  return latest?.minecraft || installed?.minecraft || null;
}

const minecraftBaseFileValidationCache = new Map();

function validMinecraftDownloadDescriptor(value = null, { requirePath = false } = {}) {
  const relativePath = String(value?.path || '').trim().replaceAll('\\', '/');
  return Boolean(
    value
    && typeof value === 'object'
    && String(value.url || '').trim()
    && /^[a-f0-9]{40}$/i.test(String(value.sha1 || '').trim())
    && Number.isFinite(Number(value.size))
    && Number(value.size) > 0
    && (
      !requirePath
      || (
        relativePath
        && !relativePath.startsWith('/')
        && !/^[a-z]:/i.test(relativePath)
        && !relativePath.split('/').includes('..')
      )
    )
  );
}

function minecraftLibraryOsName(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'osx';
  return 'linux';
}

function minecraftLibraryRuleMatches(rule = {}, { platform = process.platform, arch = process.arch, osVersion = os.release() } = {}) {
  if (rule?.features && Object.keys(rule.features).length) {
    return false;
  }
  const expectedOs = String(rule?.os?.name || '').trim();
  if (expectedOs && expectedOs !== minecraftLibraryOsName(platform)) {
    return false;
  }
  const expectedArch = String(rule?.os?.arch || '').trim();
  if (expectedArch) {
    try {
      if (!(new RegExp(expectedArch)).test(String(arch || ''))) return false;
    } catch {
      return false;
    }
  }
  const expectedVersion = String(rule?.os?.version || '').trim();
  if (expectedVersion) {
    try {
      if (!(new RegExp(expectedVersion)).test(String(osVersion || ''))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function minecraftLibraryAllowed(library = {}, options = {}) {
  const rules = Array.isArray(library?.rules) ? library.rules : [];
  if (!rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    if (minecraftLibraryRuleMatches(rule, options)) {
      allowed = rule?.action === 'allow';
    }
  }
  return allowed;
}

function minecraftNativeClassifier(library = {}, { platform = process.platform, arch = process.arch } = {}) {
  const template = String(library?.natives?.[minecraftLibraryOsName(platform)] || '').trim();
  if (!template) return '';
  const archToken = /(?:64|x64|amd64|aarch64|arm64)/i.test(String(arch || '')) ? '64' : '32';
  return template.replace('${arch}', archToken);
}

function minecraftBaseLibraryDownloads(versionJson = null, options = {}) {
  const downloads = [];
  const seenPaths = new Set();
  for (const library of Array.isArray(versionJson?.libraries) ? versionJson.libraries : []) {
    if (!minecraftLibraryAllowed(library, options)) continue;
    const name = String(library?.name || 'unnamed Minecraft library').trim();
    const artifact = library?.downloads?.artifact;
    if (artifact) {
      const artifactPath = String(artifact.path || '').trim().replaceAll('\\', '/');
      if (!seenPaths.has(artifactPath.toLowerCase())) {
        downloads.push({ name, kind: 'library', descriptor: artifact });
        seenPaths.add(artifactPath.toLowerCase());
      }
    }
    const nativeClassifier = minecraftNativeClassifier(library, options);
    if (nativeClassifier) {
      const nativeArtifact = library?.downloads?.classifiers?.[nativeClassifier];
      const nativePath = String(nativeArtifact?.path || '').trim().replaceAll('\\', '/');
      if (!seenPaths.has(nativePath.toLowerCase())) {
        downloads.push({ name: `${name}:${nativeClassifier}`, kind: 'native', descriptor: nativeArtifact });
        seenPaths.add(nativePath.toLowerCase());
      }
    }
  }
  return downloads;
}

function minecraftBaseVersionMetadataProblem(value = null, minecraftVersion = '', options = {}) {
  if (!value || typeof value !== 'object') return 'metadata is not an object';
  if (!safeMinecraftIdentifier(minecraftVersion)) return 'requested Minecraft version id is unsafe';
  if (minecraftVersion && value.id !== minecraftVersion) return `metadata id is not ${minecraftVersion}`;
  if (!String(value.mainClass || '').trim()) return 'mainClass is missing';
  if ('arguments' in value && (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments))) {
    return 'arguments is not an object';
  }
  if (!String(value.minecraftArguments || '').trim() && !Array.isArray(value?.arguments?.game)) {
    return 'launch arguments are missing';
  }
  if (
    !value.assetIndex
    || typeof value.assetIndex !== 'object'
    || !safeMinecraftIdentifier(value.assetIndex.id)
    || !validMinecraftDownloadDescriptor(value.assetIndex)
  ) {
    return 'asset index metadata is incomplete';
  }
  if (!validMinecraftDownloadDescriptor(value?.downloads?.client)) {
    return 'client download metadata is incomplete';
  }
  const libraries = Array.isArray(value.libraries) ? value.libraries : [];
  if (!libraries.length) return 'libraries are missing';
  for (const library of libraries) {
    const name = String(library?.name || 'unnamed Minecraft library');
    if (!library || typeof library !== 'object' || Array.isArray(library)) return `${name} is not an object`;
    if ('clientreq' in library || 'serverreq' in library) return `${name} uses unsupported legacy requirement fields`;
    if ('rules' in library && !Array.isArray(library.rules)) return `${name} rules is not an array`;
    if ('natives' in library && (!library.natives || typeof library.natives !== 'object' || Array.isArray(library.natives))) {
      return `${name} natives is not an object`;
    }
    if ('extract' in library && (!library.extract || typeof library.extract !== 'object' || Array.isArray(library.extract))) {
      return `${name} extract is not an object`;
    }
  }
  const requiredDownloads = minecraftBaseLibraryDownloads(value, options);
  if (!requiredDownloads.length) return 'required library downloads are missing';
  for (const library of libraries) {
    if (!minecraftLibraryAllowed(library, options)) continue;
    const name = String(library?.name || 'unnamed Minecraft library');
    const artifact = library?.downloads?.artifact;
    const nativeClassifier = minecraftNativeClassifier(library, options);
    if (artifact && !validMinecraftDownloadDescriptor(artifact, { requirePath: true })) {
      return `${name} library download metadata is incomplete`;
    }
    if (
      nativeClassifier
      && !validMinecraftDownloadDescriptor(library?.downloads?.classifiers?.[nativeClassifier], { requirePath: true })
    ) {
      return `${name}:${nativeClassifier} native download metadata is incomplete`;
    }
    if (!artifact && !nativeClassifier) {
      return `${name} has no required download`;
    }
  }
  return '';
}

function validBaseVersionJson(value = null, minecraftVersion = '') {
  return !minecraftBaseVersionMetadataProblem(value, minecraftVersion);
}

function validAssetIndexJson(value = null) {
  return Boolean(value && typeof value === 'object' && value.objects && typeof value.objects === 'object');
}

function minecraftBaseTestFixtureDir() {
  if (process.env.AHT_TEST_HOOKS !== '1') return '';
  const configured = String(process.env.AHT_TEST_MINECRAFT_BASE_FIXTURE_DIR || '').trim();
  return configured ? path.resolve(configured) : '';
}

function resolveMinecraftFixtureUrl(value = '', fixtureDir = '') {
  const source = String(value || '').trim();
  if (!source || !fixtureDir || path.isAbsolute(source) || /^[a-z][a-z0-9+.-]*:/i.test(source)) {
    return source;
  }
  return safeJoin(fixtureDir, source.replaceAll('\\', '/'));
}

function resolveMinecraftFixtureVersionJson(value = null, fixtureDir = '') {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    assetIndex: value.assetIndex
      ? { ...value.assetIndex, url: resolveMinecraftFixtureUrl(value.assetIndex.url, fixtureDir) }
      : value.assetIndex,
    downloads: value.downloads
      ? {
        ...value.downloads,
        client: value.downloads.client
          ? { ...value.downloads.client, url: resolveMinecraftFixtureUrl(value.downloads.client.url, fixtureDir) }
          : value.downloads.client
      }
      : value.downloads,
    libraries: Array.isArray(value.libraries)
      ? value.libraries.map((library) => ({
        ...library,
        downloads: library?.downloads
          ? {
            ...library.downloads,
            artifact: library.downloads.artifact
              ? { ...library.downloads.artifact, url: resolveMinecraftFixtureUrl(library.downloads.artifact.url, fixtureDir) }
              : library.downloads.artifact,
            classifiers: library.downloads.classifiers
              ? Object.fromEntries(Object.entries(library.downloads.classifiers).map(([name, descriptor]) => [
                name,
                descriptor ? { ...descriptor, url: resolveMinecraftFixtureUrl(descriptor.url, fixtureDir) } : descriptor
              ]))
              : library.downloads.classifiers
          }
          : library?.downloads
      }))
      : value.libraries
  };
}

async function fetchMinecraftBaseVersionJson(minecraftVersion, { manifestUrl = MOJANG_VERSION_MANIFEST_URL, fetchJsonImpl = fetchJson } = {}) {
  const fixtureDir = minecraftBaseTestFixtureDir();
  if (fixtureDir) {
    const fixtureJsonPath = safeJoin(fixtureDir, `${minecraftVersion}.json`);
    const fixtureJson = resolveMinecraftFixtureVersionJson(await readJsonFile(fixtureJsonPath), fixtureDir);
    if (!validBaseVersionJson(fixtureJson, minecraftVersion)) {
      throw new Error(`AHT Minecraft test fixture returned incomplete Minecraft ${minecraftVersion} metadata.`);
    }
    return fixtureJson;
  }
  const manifest = await fetchJsonImpl(manifestUrl);
  const match = Array.isArray(manifest?.versions)
    ? manifest.versions.find((item) => item?.id === minecraftVersion && item?.url)
    : null;
  if (!match) {
    throw new Error(`Minecraft ${minecraftVersion} was not found in Mojang's version manifest.`);
  }
  const versionJson = await fetchJsonImpl(match.url);
  if (!validBaseVersionJson(versionJson, minecraftVersion)) {
    throw new Error(`Mojang returned incomplete Minecraft ${minecraftVersion} metadata.`);
  }
  return versionJson;
}

async function inspectMinecraftBaseFile(file = '', descriptor = null, { refresh = false } = {}) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { ok: false, reason: 'file is missing' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'path is not a file' };
  const expectedSize = Number(descriptor?.size);
  if (stat.size !== expectedSize) {
    return { ok: false, reason: `size mismatch (${stat.size} != ${expectedSize})` };
  }
  const cacheKey = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const cached = minecraftBaseFileValidationCache.get(cacheKey);
  let actualSha1 = !refresh && cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs
    ? cached.sha1
    : '';
  if (!actualSha1) {
    actualSha1 = await hashFile(file, 'sha1');
    minecraftBaseFileValidationCache.set(cacheKey, { size: stat.size, mtimeMs: stat.mtimeMs, sha1: actualSha1 });
  }
  const expectedSha1 = String(descriptor?.sha1 || '').trim().toLowerCase();
  if (actualSha1.toLowerCase() !== expectedSha1) {
    return { ok: false, reason: 'SHA-1 mismatch', actualSha1 };
  }
  return { ok: true, actualSha1 };
}

async function ensureMinecraftBaseFile({ file = '', descriptor = null, label = 'Minecraft file', logger = null } = {}) {
  const existing = await inspectMinecraftBaseFile(file, descriptor);
  if (existing.ok) return { file, downloaded: false };
  logger?.log?.(`Repairing ${label} (${existing.reason})`);
  await downloadToFile(String(descriptor.url), file);
  const downloaded = await inspectMinecraftBaseFile(file, descriptor, { refresh: true });
  if (!downloaded.ok) {
    await fs.rm(file, { force: true }).catch(() => {});
    throw new Error(`Downloaded ${label} failed integrity validation: ${downloaded.reason}.`);
  }
  return { file, downloaded: true };
}

async function ensureMinecraftRootAssets({ rootDir = '', minecraftVersion = '', manifestUrl = MOJANG_VERSION_MANIFEST_URL, fetchJsonImpl = fetchJson, logger = null } = {}) {
  if (!rootDir || !minecraftVersion) {
    return { ok: false, skipped: true, reason: 'missing root or Minecraft version', rootDir, minecraftVersion };
  }
  if (!safeMinecraftIdentifier(minecraftVersion)) {
    throw new Error(`Refusing unsafe Minecraft version identifier: ${minecraftVersion}`);
  }
  const actions = [];
  const versionDir = safeJoin(path.join(rootDir, 'versions'), minecraftVersion);
  const versionJsonPath = safeJoin(versionDir, `${minecraftVersion}.json`);
  let versionJson = await readRepairableJsonFile(versionJsonPath, null);
  if (!validBaseVersionJson(versionJson, minecraftVersion)) {
    const problem = minecraftBaseVersionMetadataProblem(versionJson, minecraftVersion);
    logger?.log?.(`Repairing Minecraft ${minecraftVersion} version metadata in ${rootDir}${problem ? ` (${problem})` : ''}`);
    if (versionJson && typeof versionJson === 'object') {
      await backupInvalidJson(versionJsonPath);
    }
    versionJson = await fetchMinecraftBaseVersionJson(minecraftVersion, { manifestUrl, fetchJsonImpl });
    await writeJsonFile(versionJsonPath, versionJson);
    actions.push(`wrote ${versionJsonPath}`);
  }

  const clientJarPath = safeJoin(versionDir, `${minecraftVersion}.jar`);
  const clientResult = await ensureMinecraftBaseFile({
    file: clientJarPath,
    descriptor: versionJson.downloads.client,
    label: `Minecraft ${minecraftVersion} client JAR`,
    logger
  });
  if (clientResult.downloaded) actions.push(`downloaded ${clientJarPath}`);

  const libraryDownloads = minecraftBaseLibraryDownloads(versionJson);
  let downloadedLibraryCount = 0;
  for (const item of libraryDownloads) {
    const libraryPath = safeJoin(path.join(rootDir, 'libraries'), String(item.descriptor.path).replaceAll('\\', '/'));
    const libraryResult = await ensureMinecraftBaseFile({
      file: libraryPath,
      descriptor: item.descriptor,
      label: `Minecraft library ${item.name}`,
      logger
    });
    if (libraryResult.downloaded) {
      downloadedLibraryCount += 1;
      actions.push(`downloaded ${libraryPath}`);
    }
  }

  const assetId = String(versionJson.assetIndex.id || '').trim();
  const assetIndexPath = safeJoin(path.join(rootDir, 'assets', 'indexes'), `${assetId}.json`);
  const existingAssetIndex = await inspectMinecraftBaseFile(assetIndexPath, versionJson.assetIndex);
  if (!existingAssetIndex.ok && await pathExists(assetIndexPath)) {
    await backupInvalidJson(assetIndexPath);
  }
  const assetIndexResult = await ensureMinecraftBaseFile({
    file: assetIndexPath,
    descriptor: versionJson.assetIndex,
    label: `Minecraft asset index ${assetId}`,
    logger
  });
  if (assetIndexResult.downloaded) actions.push(`downloaded ${assetIndexPath}`);
  const assetIndex = await readJsonFile(assetIndexPath);
  if (!validAssetIndexJson(assetIndex)) {
    throw new Error(`Mojang returned incomplete Minecraft asset index ${assetId}.`);
  }

  return {
    ok: true,
    rootDir,
    minecraftVersion,
    versionJsonPath,
    clientJarPath,
    assetIndexPath,
    assetId,
    baseLibraryCount: libraryDownloads.length,
    downloadedLibraryCount,
    repaired: actions.length > 0,
    actions
  };
}

export async function ensureMinecraftLauncherAssets({ config = {}, latest = null, installed = null, profile = null, manifestUrl = MOJANG_VERSION_MANIFEST_URL, fetchJsonImpl = fetchJson, logger = null } = {}) {
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
    results.push(await ensureMinecraftRootAssets({ rootDir, minecraftVersion, manifestUrl, fetchJsonImpl, logger }));
  }
  return {
    ok: true,
    minecraftVersion,
    roots: results,
    repaired: results.some((item) => item.repaired)
  };
}

async function readProfiles(file) {
  return readRepairableJsonFile(file, {});
}

async function prepareMinecraftLauncherQuickPlay(rootDir = '', profileId = '') {
  const normalizedRoot = String(rootDir || '').trim();
  const normalizedProfileId = String(profileId || '').trim();
  const quickPlayFile = path.join(normalizedRoot, 'launcher_quick_play.json');
  const accountsFile = path.join(normalizedRoot, 'launcher_accounts.json');
  if (!normalizedRoot || !normalizedProfileId || !(await pathExists(quickPlayFile)) || !(await pathExists(accountsFile))) {
    return { ok: true, changed: false, skipped: true, quickPlayFile };
  }

  const quickPlay = await readRepairableJsonFile(quickPlayFile, null);
  const accounts = await readRepairableJsonFile(accountsFile, null);
  const activeAccountLocalId = String(accounts?.activeAccountLocalId || '').trim();
  const activeAccount = activeAccountLocalId ? accounts?.accounts?.[activeAccountLocalId] : null;
  const remoteAccountId = String(activeAccount?.remoteId || '').trim();
  if (!quickPlay || typeof quickPlay !== 'object' || !remoteAccountId) {
    return { ok: true, changed: false, skipped: true, quickPlayFile, reason: 'active Minecraft account is unavailable' };
  }

  const quickPlayData = quickPlay.quickPlayData && typeof quickPlay.quickPlayData === 'object'
    ? quickPlay.quickPlayData
    : {};
  const existing = Array.isArray(quickPlayData[remoteAccountId]) ? quickPlayData[remoteAccountId] : [];
  const next = existing.filter((entry) => String(entry?.javaInstance?.configId || '') !== normalizedProfileId);
  next.unshift({
    epochLastPlayedTimeMs: Date.now(),
    id: normalizedProfileId,
    javaInstance: { configId: normalizedProfileId },
    source: 'Java'
  });
  quickPlay.quickPlayData = quickPlayData;
  quickPlay.quickPlayData[remoteAccountId] = next;
  await writeJsonFile(quickPlayFile, quickPlay);
  return {
    ok: true,
    changed: true,
    quickPlayFile,
    remoteAccountId,
    profileId: normalizedProfileId
  };
}

export async function setMinecraftLauncherHomePage(rootDir = '') {
  const file = path.join(String(rootDir || ''), 'launcher_ui_state.json');
  if (!rootDir || !(await pathExists(file))) {
    return { ok: true, changed: false, skipped: true, file };
  }

  try {
    const raw = await fs.readFile(file, 'utf8');
    const jsonStart = raw.indexOf('{');
    if (jsonStart < 0) {
      return { ok: false, changed: false, file, reason: 'launcher UI state has no JSON payload' };
    }
    const preamble = raw.slice(0, jsonStart);
    const state = JSON.parse(raw.slice(jsonStart));
    const storedSettings = state?.data?.UiSettings;
    if (storedSettings === undefined || storedSettings === null) {
      return { ok: true, changed: false, skipped: true, file };
    }
    const settings = typeof storedSettings === 'string'
      ? JSON.parse(storedSettings)
      : { ...storedSettings };
    if (settings.lastVisitedPage === 'home') {
      return { ok: true, changed: false, file, page: 'home' };
    }
    settings.lastVisitedPage = 'home';
    state.data.UiSettings = typeof storedSettings === 'string'
      ? JSON.stringify(settings)
      : settings;
    await fs.writeFile(file, `${preamble}${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return { ok: true, changed: true, file, page: 'home' };
  } catch (error) {
    return { ok: false, changed: false, file, reason: error.message || String(error) };
  }
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
    }, {
      backupInvalid: false,
      repairMetadata: false,
      verifyLibraries: true
    });
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
  const profileId = config.minecraftLauncher?.profileId || profileIdFor(latest?.packId || installed?.packId || config.packId);
  const profile = await readProfiles(profilesPath).then((profiles) => profiles.profiles?.[profileId] || null).catch(() => null);
  const allAuthRoots = uniqueLauncherRoots(authRoots || [rootDir]);
  const auth = await inspectMinecraftLauncherAuth(rootDir, {
    extraRoots: allAuthRoots.filter((candidate) => launcherRootKey(candidate) !== launcherRootKey(rootDir))
  });
  return {
    enabled: true,
    rootDir,
    profilesPath,
    profileId,
    profileName: profileName(config, latest, installed),
    profileExists: Boolean(profile),
    versionId,
    loaderInstalled,
    versionJson,
    gameDir: config.instanceDir,
    javaArgs: javaArgsFor({ config, latest, installed, rootDir, gameDir: config.instanceDir }),
    javaPath: String(config.minecraftLauncher?.javaPath || profile?.javaDir || '').trim(),
    minecraftVersion: minecraft?.version || '',
    loaderId,
    loaderInstallerUrl: loaderInstallerUrl(minecraft || {}),
    accountReuseAvailable: auth.signedIn,
    accountCount: auth.accountCount,
    accountFiles: auth.files,
    accountUsernames: auth.usernames,
    accountMinecraftUuids: auth.minecraftUuids,
    accountMinecraftProfiles: auth.profiles,
    preferredMinecraftUsername: auth.preferredUsername,
    preferredMinecraftUuid: auth.preferredMinecraftUuid
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

const LEGACY_STABLE_PROFILE_NAMES = new Set(['A Hard Time', 'A Hard Time Dregora']);
const PROFILE_CLOCK_SKEW_LIMIT_MS = 5 * 60 * 1000;

function isExactLegacyStableProfile(profile = {}, state = {}) {
  return state.profileId === 'a-hard-time-dregora'
    && LEGACY_STABLE_PROFILE_NAMES.has(String(profile.name || '').trim());
}

function validAbsoluteJavaDir(profile = {}) {
  const javaDir = String(profile.javaDir || '').trim();
  return javaDir && path.isAbsolute(javaDir) ? path.resolve(javaDir) : '';
}

function nextProfileSelectionTimestamp(profiles = {}, nowMs = Date.now()) {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const upperBound = safeNow + PROFILE_CLOCK_SKEW_LIMIT_MS;
  let latestTimestamp = safeNow;
  for (const profile of Object.values(profiles || {})) {
    const timestamp = Date.parse(String(profile?.lastUsed || ''));
    if (Number.isFinite(timestamp) && timestamp >= latestTimestamp && timestamp <= upperBound) {
      latestTimestamp = timestamp;
    }
  }
  return new Date(Math.min(upperBound, latestTimestamp + 1)).toISOString();
}

function usesLegacySelectedProfile(profiles = {}) {
  const schemaVersion = Number(profiles.version);
  return Number.isFinite(schemaVersion) && schemaVersion > 0 && schemaVersion < 3;
}

function updateOwnedSelectedProfileState(profiles, state, { migrateLegacyStable, selectForPlay }) {
  const ownsSelection = Object.prototype.hasOwnProperty.call(profiles, 'selectedProfile');
  const selectedProfile = String(profiles.selectedProfile || '').trim();
  const legacySelectionSchema = usesLegacySelectedProfile(profiles);
  if (ownsSelection && (
    selectedProfile === state.profileId
    || (migrateLegacyStable && selectedProfile === 'a-hard-time')
  )) {
    if (legacySelectionSchema) {
      profiles.selectedProfile = state.profileId;
    } else {
      delete profiles.selectedProfile;
    }
  }
  if (selectForPlay && legacySelectionSchema) {
    profiles.selectedProfile = state.profileId;
  }
}

async function writeMinecraftLauncherProfile(state, { selectForPlay = false } = {}) {
  await ensureDir(state.rootDir);
  const profiles = await readProfiles(state.profilesPath);
  profiles.profiles = profiles.profiles && typeof profiles.profiles === 'object' ? profiles.profiles : {};

  const now = new Date().toISOString();
  const canonical = profiles.profiles[state.profileId];
  const legacyStable = profiles.profiles['a-hard-time'];
  const migrateLegacyStable = isExactLegacyStableProfile(legacyStable, state);
  const legacyJavaDir = migrateLegacyStable ? validAbsoluteJavaDir(legacyStable) : '';
  const existing = canonical || (migrateLegacyStable ? legacyStable : {});
  const next = {
    ...existing,
    name: state.profileName,
    type: 'custom',
    created: existing.created || now,
    lastVersionId: state.versionId,
    gameDir: path.resolve(state.gameDir)
  };
  if (!validAbsoluteJavaDir(next) && legacyJavaDir) {
    next.javaDir = legacyJavaDir;
  }
  if (!String(next.lastUsed || '').trim()) {
    next.lastUsed = '1970-01-01T00:00:00.000Z';
  }
  let selectedAt = '';
  if (selectForPlay) {
    selectedAt = nextProfileSelectionTimestamp(profiles.profiles);
    next.lastUsed = selectedAt;
  }
  if (state.javaArgs) {
    next.javaArgs = state.javaArgs;
  }
  if (state.javaPath && path.isAbsolute(state.javaPath)) {
    next.javaDir = path.resolve(state.javaPath);
  }
  if (migrateLegacyStable) {
    delete profiles.profiles['a-hard-time'];
  }
  if (selectForPlay) {
    // Modern launchers use recent-profile order/lastUsed plus quick-play state.
    // Keep their schema free of the legacy selectedProfile field so CurseForge
    // can continue to own and rewrite its launcher metadata independently.
    delete profiles.profiles[state.profileId];
  }
  profiles.profiles[state.profileId] = next;
  updateOwnedSelectedProfileState(profiles, state, { migrateLegacyStable, selectForPlay });
  await writeJsonFile(state.profilesPath, profiles);
  const quickPlay = selectForPlay
    ? await prepareMinecraftLauncherQuickPlay(state.rootDir, state.profileId)
    : { ok: true, changed: false, skipped: true };
  const written = await readProfiles(state.profilesPath);
  const writtenProfile = written.profiles?.[state.profileId];
  const writtenKeys = Object.keys(written.profiles || {});
  const selectedTimestamp = Date.parse(selectedAt);
  const newerCompetitors = Object.entries(written.profiles || {}).filter(([profileId, profile]) => {
    if (profileId === state.profileId) return false;
    const timestamp = Date.parse(String(profile?.lastUsed || ''));
    return Number.isFinite(timestamp) && Number.isFinite(selectedTimestamp) && timestamp > selectedTimestamp;
  });
  const selectionPrepared = Boolean(selectForPlay
    && writtenProfile
    && launcherRootKey(writtenProfile.gameDir) === launcherRootKey(state.gameDir)
    && String(writtenProfile.lastVersionId || '') === String(state.versionId || '')
    && String(writtenProfile.lastUsed || '') === selectedAt
    && writtenKeys.at(-1) === state.profileId
    && newerCompetitors.length === 0
    && (!selectForPlay
      || !usesLegacySelectedProfile(written)
      || String(written.selectedProfile || '') === state.profileId));
  if (selectForPlay && !selectionPrepared) {
    if (newerCompetitors.length) {
      throw new Error(`Minecraft Launcher has another installation with a future last-used time (${newerCompetitors[0][0]}). Correct the computer clock or open that installation once, then click Play again.`);
    }
    throw new Error(`Minecraft Launcher profile selection write-back failed for ${state.profileName}.`);
  }
  return {
    ...state,
    profileExists: true,
    selectionPrepared,
    selectedAt,
    quickPlayPrepared: quickPlay,
    legacyProfileRemoved: migrateLegacyStable
  };
}

export async function ensureMinecraftLauncherProfile({ config, latest = null, installed = null, selectForPlay = false }) {
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
    syncedProfiles.push(await writeMinecraftLauncherProfile(rootState, { selectForPlay }));
  }

  const primaryProfile = syncedProfiles.find((profile) => launcherRootKey(profile.rootDir) === launcherRootKey(state.rootDir))
    || await writeMinecraftLauncherProfile(state, { selectForPlay });
  return {
    ...primaryProfile,
    syncedProfiles,
    syncedProfileCount: syncedProfiles.length
  };
}

export async function selectPreparedMinecraftLauncherProfile(profile = null) {
  const candidates = Array.isArray(profile?.syncedProfiles) && profile.syncedProfiles.length
    ? profile.syncedProfiles
    : (profile ? [profile] : []);
  if (!candidates.length) {
    throw new Error('The prepared Minecraft Launcher profile is missing. Restart A Hard Time Launcher.');
  }
  const selected = [];
  for (const candidate of candidates) {
    if (!candidate?.rootDir || !candidate?.profilesPath || !candidate?.profileId || !candidate?.versionId) {
      throw new Error('The prepared Minecraft Launcher profile is incomplete. Restart A Hard Time Launcher.');
    }
    selected.push(await writeMinecraftLauncherProfile(candidate, { selectForPlay: true }));
  }
  const primaryRoot = launcherRootKey(profile?.rootDir || '');
  const primary = selected.find((candidate) => launcherRootKey(candidate.rootDir) === primaryRoot) || selected[0];
  return {
    ...primary,
    syncedProfiles: selected,
    syncedProfileCount: selected.length
  };
}
