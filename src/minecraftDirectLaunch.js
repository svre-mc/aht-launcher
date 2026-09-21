import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import AdmZip from 'adm-zip';
import { minecraftLibraryAllowed, minecraftNativeClassifier, ensureMinecraftLoggingConfiguration } from './minecraftLauncherProfile.js';
import { safeJoin, hashFile } from './utils.js';

const runtimeError = () => Object.assign(new Error('The Minecraft launch runtime is incomplete or damaged. Run Repair, then retry Play.'),
  { code: 'MINECRAFT_DIRECT_RUNTIME' });
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

// Parse launcher metadata, never a shell command. Keep Windows separators and
// quoted JVM property values intact. spawn() always receives an argument array.
export function splitMinecraftArguments(value) {
  const result = []; let current = ''; let quoted = false; let started = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && value[i + 1] === '"') { current += '"'; i++; started = true; }
    else if (ch === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(ch) && !quoted) { if (started) result.push(current); current = ''; started = false; }
    else { current += ch; started = true; }
  }
  if (quoted) throw runtimeError();
  if (started) result.push(current);
  return result;
}

function mavenPath(name) {
  const [coordinate, extension = 'jar'] = String(name || '').split('@');
  const parts = coordinate.split(':');
  if (parts.length < 3 || parts.length > 4 || !parts.every(p => /^[A-Za-z0-9_.-]+$/.test(p)) || extension !== 'jar') throw runtimeError();
  const [group, artifact, version, classifier] = parts;
  return `${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
}

async function normalFile(file) {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw runtimeError();
  return stat;
}

async function readVersions(profile) {
  const versions = []; const seen = new Set(); let id = profile.versionId;
  while (id) {
    if (!safeId(id) || seen.has(id) || versions.length >= 6) throw runtimeError();
    seen.add(id);
    const file = safeJoin(profile.rootDir, `versions/${id}/${id}.json`);
    const stat = await normalFile(file);
    if (stat.size > 2 * 1024 * 1024) throw runtimeError();
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.id !== id) throw runtimeError();
    versions.push(data); id = data.inheritsFrom;
  }
  return versions;
}

async function extractNatives(archives, nativeBase, repair = false) {
  const contents = [];
  const digest = createHash('sha256');
  for (const { file, descriptor, exclude } of archives) {
    const stat = await normalFile(file);
    if (stat.size > 64 * 1024 * 1024 || !/^[a-f0-9]{40}$/i.test(descriptor.sha1 || '')
        || await hashFile(file, 'sha1') !== descriptor.sha1.toLowerCase()) throw runtimeError();
    const bytes = await fs.readFile(file); digest.update(bytes);
    contents.push({ bytes, exclude });
  }
  await fs.mkdir(nativeBase, { recursive: true });
  const nativeDir = path.join(await fs.realpath(nativeBase), digest.digest('hex'));
  try {
  await fs.mkdir(nativeDir, { recursive: true });
  if ((await fs.lstat(nativeDir)).isSymbolicLink()) throw runtimeError();
  let total = 0;
  const expectedFiles = new Set();
  for (const { bytes, exclude } of contents) {
    const archive = new AdmZip(bytes);
    for (const entry of archive.getEntries()) {
      const name = entry.entryName.replaceAll('\\', '/');
      if (entry.isDirectory || name.startsWith('META-INF/') || exclude.some(prefix => name.startsWith(prefix))) continue;
      if (name.length > 240 || name.includes(':') || name.includes('\0') || name.startsWith('/')
          || name.split('/').some(p => !p || p === '.' || p === '..') || ((entry.attr >>> 16) & 0xf000) === 0xa000
          || entry.header.size > 32 * 1024 * 1024 || (total += entry.header.size) > 128 * 1024 * 1024) throw runtimeError();
      const target = safeJoin(nativeDir, name);
      const fileKey = path.relative(nativeDir, target).toLowerCase();
      if (expectedFiles.has(fileKey) || expectedFiles.size >= 256) throw runtimeError();
      expectedFiles.add(fileKey);
      const data = entry.getData();
      if (data.length !== entry.header.size) throw runtimeError();
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (!path.relative(nativeDir, await fs.realpath(path.dirname(target))).split(path.sep).every(p => p !== '..')) throw runtimeError();
      const existing = await fs.lstat(target).catch(() => null);
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink()
            || await hashFile(target, 'sha256') !== createHash('sha256').update(data).digest('hex')) throw runtimeError();
      } else { await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 }); }
    }
  }
  let visited = 0;
  const visit = async (directory, depth = 0) => {
    if (depth > 8 || ++visited > 512) throw runtimeError();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length > 256) throw runtimeError();
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw runtimeError();
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (!entry.isFile() || !expectedFiles.has(path.relative(nativeDir, file).toLowerCase())) throw runtimeError();
    }
  };
  await visit(nativeDir);
  return nativeDir;
  } catch (error) {
    if (!repair || !(await fs.lstat(nativeDir).catch(() => null))) throw error;
    // Only the exact launcher-owned content-addressed directory is quarantined.
    // Rename never follows a malicious symlink; preserve the prior bytes instead
    // of recursively deleting an untrusted tree or touching game/player data.
    await fs.rename(nativeDir, `${nativeDir}.quarantine-${randomUUID()}`);
    return extractNatives(archives, nativeBase, false);
  }
}

export async function prepareMinecraftDirectLaunch({ profile, nativeBase, repairNatives = false, platform = process.platform, arch = process.arch }) {
  try {
    if (profile?.minecraftVersion !== '1.12.2' || !profile.rootDir || !profile.gameDir || !profile.javaPath || !nativeBase) throw runtimeError();
    await normalFile(profile.javaPath);
    const executable = platform === 'win32' && /^java(?:w)?\.exe$/i.test(path.basename(profile.javaPath))
      ? path.join(path.dirname(profile.javaPath), 'javaw.exe') : profile.javaPath;
    await normalFile(executable);
    const versions = await readVersions(profile);
    const mainClass = versions.find(v => v.mainClass)?.mainClass;
    const argumentsText = versions.find(v => v.minecraftArguments)?.minecraftArguments;
    if (!/^[A-Za-z0-9_$.]+$/.test(mainClass || '') || typeof argumentsText !== 'string') throw runtimeError();
    const libraries = []; const seen = new Set();
    for (const version of versions) {
      for (const library of version.libraries || []) {
        if (!minecraftLibraryAllowed(library, { platform, arch })) continue;
        const parts = String(library.name || '').split(':');
        // Mojang can declare the same coordinate twice: once for its classpath
        // artifact and once with native classifiers (notably text2speech).
        const key = `${parts[0]}:${parts[1]}:${parts[3] || minecraftNativeClassifier(library, { platform, arch }) || ''}`;
        if (seen.has(key)) continue;
        seen.add(key); libraries.push(library);
      }
    }
    const classpath = []; const natives = [];
    for (const library of libraries) {
      const artifact = library.downloads?.artifact;
      const relative = artifact?.path || mavenPath(library.name);
      const file = safeJoin(path.join(profile.rootDir, 'libraries'), relative);
      // Mojang's native-only dependencies can omit their normal artifact.
      if (artifact || !library.natives) { await normalFile(file); if (!classpath.includes(file)) classpath.push(file); }
      const classifier = minecraftNativeClassifier(library, { platform, arch });
      if (classifier) {
        const descriptor = library.downloads?.classifiers?.[classifier];
        if (!descriptor?.path) throw runtimeError();
        natives.push({ file: safeJoin(path.join(profile.rootDir, 'libraries'), descriptor.path), descriptor,
          exclude: Array.isArray(library.extract?.exclude) ? library.extract.exclude : [] });
      }
    }
    const base = versions.find(v => v.downloads?.client);
    if (!base || !safeId(base.id)) throw runtimeError();
    const clientJar = safeJoin(profile.rootDir, `versions/${base.id}/${base.id}.jar`);
    await normalFile(clientJar); classpath.push(clientJar);
    const nativeDir = await extractNatives(natives, nativeBase, repairNatives);
    const javaArgs = splitMinecraftArguments(profile.javaArgs || '');
    const loggingFile = await ensureMinecraftLoggingConfiguration(profile.rootDir, base);
    if (loggingFile) javaArgs.push(`-Dlog4j.configurationFile=${loggingFile}`);
    javaArgs.push('-Dlog4j2.formatMsgNoLookups=true');
    if (platform === 'darwin' && !javaArgs.includes('-XstartOnFirstThread')) javaArgs.push('-XstartOnFirstThread');
    const assetId = versions.find(v => v.assetIndex?.id)?.assetIndex.id;
    if (!safeId(assetId)) throw runtimeError();
    return { executable, cwd: profile.gameDir,
      prefix: [...javaArgs, `-Djava.library.path=${nativeDir}`, '-cp', classpath.join(platform === 'win32' ? ';' : ':'), mainClass],
      gameArguments: splitMinecraftArguments(argumentsText),
      values: { version_name: profile.versionId, game_directory: path.resolve(profile.gameDir),
        assets_root: path.join(profile.rootDir, 'assets'), assets_index_name: assetId,
        user_type: 'msa', user_properties: '{}', version_type: 'release' } };
  } catch (error) {
    // File errors retain only their code/path for the existing Repair recovery;
    // launch plans, credentials and command arguments never enter error causes.
    if (error?.code === 'EACCES' || error?.code === 'EPERM') throw Object.assign(runtimeError(), { code: error.code, path: error.path });
    throw runtimeError();
  }
}

export async function launchMinecraftDirect({ plan, session, expectedIdentity, env = process.env, spawnImpl = spawn, settleMs = 1000 }) {
  const compactUuid = value => String(value || '').replaceAll('-', '').toLowerCase();
  if (!session?.accessToken || session.minecraftUuid !== expectedIdentity.minecraftUuid
      || session.username.toLowerCase() !== String(expectedIdentity.minecraftUsername || '').toLowerCase()) {
    throw Object.assign(new Error('The selected Minecraft account changed during Play. Click Play again.'), { code: 'CURSEFORGE_SESSION_CHANGED' });
  }
  const values = { ...plan.values, auth_player_name: session.username,
    auth_uuid: compactUuid(session.minecraftUuid), auth_access_token: session.accessToken };
  const args = [...plan.prefix, ...plan.gameArguments.map(arg => arg.replace(/\$\{([^}]+)\}/g, (_match, name) => {
    if (!(name in values)) throw runtimeError();
    return values[name];
  }))];
  let child;
  try {
    // javaw has no console. SW_HIDE would also hide LWJGL's first game window.
    child = spawnImpl(plan.executable, args, { cwd: plan.cwd, env, shell: false, windowsHide: false, detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      let timer;
      const finish = error => { clearTimeout(timer); child.removeListener('error', failed); child.removeListener('exit', exited); error ? reject(error) : resolve(); };
      const failed = () => finish(runtimeError());
      const exited = () => finish(runtimeError());
      child.once('error', failed); child.once('exit', exited);
      child.once('spawn', () => { timer = setTimeout(() => finish(), settleMs); });
    });
    child.unref();
    return { ok: true, kind: 'curseforge-session', processPid: child.pid, processPath: plan.executable,
      processImage: path.basename(plan.executable), gameProcessStarted: true };
  } catch { throw runtimeError(); }
  finally { args.fill(''); values.auth_access_token = ''; }
}
