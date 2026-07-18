import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureDir,
  fetchJson,
  pathExists,
  readJsonFile,
  writeJsonFile
} from './utils.js';
import { launcherProofJavaArgs, launcherProofPath } from './launcherProof.js';

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
    preferredUsername: usernames[0] || ''
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

async function fetchMinecraftBaseVersionJson(minecraftVersion, { manifestUrl = MOJANG_VERSION_MANIFEST_URL, fetchJsonImpl = fetchJson } = {}) {
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

async function ensureMinecraftRootAssets({ rootDir = '', minecraftVersion = '', manifestUrl = MOJANG_VERSION_MANIFEST_URL, fetchJsonImpl = fetchJson, logger = null } = {}) {
  if (!rootDir || !minecraftVersion) {
    return { ok: false, skipped: true, reason: 'missing root or Minecraft version', rootDir, minecraftVersion };
  }
  const actions = [];
  const versionDir = path.join(rootDir, 'versions', minecraftVersion);
  const versionJsonPath = path.join(versionDir, `${minecraftVersion}.json`);
  let versionJson = await readRepairableJsonFile(versionJsonPath, null);
  if (!validBaseVersionJson(versionJson, minecraftVersion)) {
    logger?.log?.(`Repairing Minecraft ${minecraftVersion} version metadata in ${rootDir}`);
    versionJson = await fetchMinecraftBaseVersionJson(minecraftVersion, { manifestUrl, fetchJsonImpl });
    await writeJsonFile(versionJsonPath, versionJson);
    actions.push(`wrote ${versionJsonPath}`);
  }

  const assetId = String(versionJson.assetIndex.id || '').trim();
  const assetUrl = String(versionJson.assetIndex.url || '').trim();
  const assetIndexPath = path.join(rootDir, 'assets', 'indexes', `${assetId}.json`);
  let assetIndex = await readRepairableJsonFile(assetIndexPath, null);
  if (!validAssetIndexJson(assetIndex)) {
    logger?.log?.(`Repairing Minecraft asset index ${assetId} in ${rootDir}`);
    assetIndex = await fetchJsonImpl(assetUrl);
    if (!validAssetIndexJson(assetIndex)) {
      throw new Error(`Mojang returned incomplete Minecraft asset index ${assetId}.`);
    }
    await writeJsonFile(assetIndexPath, assetIndex);
    actions.push(`wrote ${assetIndexPath}`);
  }

  return {
    ok: true,
    rootDir,
    minecraftVersion,
    versionJsonPath,
    assetIndexPath,
    assetId,
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
  for (const candidate of versionCandidates) {
    const candidateJson = path.join(rootDir, 'versions', candidate, `${candidate}.json`);
    if (await pathExists(candidateJson)) {
      versionId = candidate;
      versionJson = candidateJson;
      break;
    }
  }
  const profileId = config.minecraftLauncher?.profileId || profileIdFor(latest?.packId || installed?.packId || config.packId);
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
    loaderInstalled: versionJson ? await pathExists(versionJson) : false,
    versionJson,
    gameDir: config.instanceDir,
    javaArgs: javaArgsFor({ config, rootDir, gameDir: config.instanceDir }),
    minecraftVersion: minecraft?.version || '',
    loaderId: primaryModLoader(minecraft || {})?.id || '',
    loaderInstallerUrl: loaderInstallerUrl(minecraft || {}),
    accountReuseAvailable: auth.signedIn,
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
    profileExists: true
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
