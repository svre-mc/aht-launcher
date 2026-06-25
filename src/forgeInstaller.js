import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  downloadToFile,
  ensureDir,
  pathExists
} from './utils.js';

export function forgeLoaderVersion(loaderId = '') {
  return String(loaderId).startsWith('forge-') ? String(loaderId).slice('forge-'.length) : '';
}

export function forgeInstallerFileName(minecraftVersion, loaderId) {
  const forgeVersion = forgeLoaderVersion(loaderId);
  if (!minecraftVersion || !forgeVersion) {
    return '';
  }
  return `forge-${minecraftVersion}-${forgeVersion}-installer.jar`;
}

export function forgeInstallerUrl(minecraftVersion, loaderId) {
  const forgeVersion = forgeLoaderVersion(loaderId);
  const fileName = forgeInstallerFileName(minecraftVersion, loaderId);
  if (!minecraftVersion || !forgeVersion || !fileName) {
    return '';
  }
  const coordinate = `${minecraftVersion}-${forgeVersion}`;
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${coordinate}/${fileName}`;
}

export function buildForgeInstallPlan(profile, options = {}) {
  const minecraftVersion = profile?.minecraftVersion || '';
  const loaderId = profile?.loaderId || '';
  const rootDir = profile?.rootDir || '';
  const fileName = forgeInstallerFileName(minecraftVersion, loaderId);
  if (!minecraftVersion || !loaderId || !rootDir) {
    throw new Error('Minecraft profile metadata is incomplete.');
  }
  if (!loaderId.startsWith('forge-')) {
    throw new Error(`Automatic loader installation only supports Forge. Found ${loaderId}.`);
  }
  const installerUrl = options.installerUrl || forgeInstallerUrl(minecraftVersion, loaderId);
  const installerDir = path.join(rootDir, '.aht-launcher', 'forge-installers');
  const installerPath = path.join(installerDir, fileName);
  return {
    minecraftVersion,
    loaderId,
    versionId: profile.versionId,
    rootDir,
    installerUrl,
    installerDir,
    installerPath,
    javaPath: options.javaPath || 'java',
    args: ['-jar', installerPath, '--installClient', rootDir]
  };
}

function javaExecutableName() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function looksPathLike(value = '') {
  const text = String(value || '').trim();
  return path.isAbsolute(text) || text.includes('/') || text.includes('\\');
}

function pushJavaRoot(roots, value = '') {
  const text = String(value || '').trim();
  if (text && !roots.includes(text)) {
    roots.push(text);
  }
}

function javaSearchRoots(profile = {}, options = {}) {
  const roots = [];
  const rootDir = profile?.rootDir || '';
  for (const root of options.javaRoots || []) {
    pushJavaRoot(roots, root);
  }
  pushJavaRoot(roots, rootDir ? path.join(rootDir, 'runtime') : '');
  pushJavaRoot(roots, rootDir ? path.join(rootDir, 'java') : '');
  if (process.platform === 'win32' && rootDir) {
    pushJavaRoot(roots, path.resolve(rootDir, '..', '..', 'Local', 'runtime'));
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    pushJavaRoot(roots, path.join(
      process.env.LOCALAPPDATA,
      'Packages',
      'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
      'LocalCache',
      'Local',
      'runtime'
    ));
  }
  if (process.env.APPDATA) {
    pushJavaRoot(roots, path.join(process.env.APPDATA, '.minecraft', 'runtime'));
  }
  return roots;
}

function rankJavaCandidate(file = '') {
  const normalized = String(file || '').toLowerCase();
  if (normalized.includes('jre-legacy') || normalized.includes('java-runtime-legacy')) return 0;
  if (normalized.includes('java-runtime-gamma')) return 2;
  if (normalized.includes('java-runtime-beta')) return 3;
  if (normalized.includes('java-runtime-delta')) return 4;
  if (normalized.includes('java-runtime-epsilon')) return 5;
  if (normalized.includes('jre_21') || normalized.includes('java-runtime-alpha')) return 8;
  return 6;
}

async function findJavaInRoot(root, maxDepth = 6) {
  const target = javaExecutableName().toLowerCase();
  const matches = [];
  async function visit(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) {
        matches.push(fullPath);
      } else if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
      }
    }
  }
  await visit(root, 0);
  matches.sort((left, right) => rankJavaCandidate(left) - rankJavaCandidate(right) || left.localeCompare(right));
  return matches[0] || '';
}

export async function resolveJavaPath(profile = {}, options = {}) {
  const configured = String(options.javaPath || '').trim();
  const candidates = [];
  if (configured && configured !== 'java') {
    candidates.push(configured);
  }
  for (const envName of ['JAVA_HOME', 'JRE_HOME']) {
    const envPath = String(process.env[envName] || '').trim();
    if (envPath) {
      candidates.push(path.join(envPath, 'bin', javaExecutableName()));
    }
  }
  for (const candidate of candidates) {
    if (looksPathLike(candidate) && await pathExists(candidate)) {
      return candidate;
    }
  }
  for (const root of javaSearchRoots(profile, options)) {
    const javaPath = await findJavaInRoot(root);
    if (javaPath) {
      return javaPath;
    }
  }
  return configured || 'java';
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const output = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const collect = (chunk) => {
      const text = String(chunk);
      output.push(text);
      if (options.logger?.log) {
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          options.logger.log(line);
        }
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      if (error?.code === 'ENOENT') {
        reject(new Error(`Java runtime was not found (${command}). Open Minecraft Launcher once so it can download its runtime, or install Java and try Update again.`));
      } else {
        reject(error);
      }
    });
    child.once('close', (code) => {
      const text = output.join('');
      if (code === 0) {
        resolve({ code, output: text });
      } else {
        const tail = text.trim().split(/\r?\n/).slice(-8).join('\n');
        reject(new Error(`Forge installer exited with code ${code}${tail ? `:\n${tail}` : ''}`));
      }
    });
  });
}

export async function installForgeLoader(profile, options = {}) {
  const plan = buildForgeInstallPlan(profile, options);
  if (profile.loaderInstalled && await pathExists(profile.versionJson)) {
    return {
      ok: true,
      skipped: true,
      reason: `${profile.versionId} is already installed.`,
      plan
    };
  }

  await ensureDir(plan.installerDir || path.dirname(plan.installerPath));
  if (!(await pathExists(plan.installerPath)) || options.forceDownload) {
    options.logger?.log?.(`Downloading Forge installer ${plan.installerUrl}`);
    await downloadToFile(plan.installerUrl, plan.installerPath);
  }

  plan.javaPath = await resolveJavaPath(profile, options);
  options.logger?.log?.(`Running ${plan.javaPath} ${plan.args.map((arg) => arg.includes(' ') ? `"${arg}"` : arg).join(' ')}`);
  const result = await runProcess(plan.javaPath, plan.args, {
    cwd: plan.rootDir,
    logger: options.logger
  });
  const installed = plan.versionId ? await pathExists(path.join(plan.rootDir, 'versions', plan.versionId, `${plan.versionId}.json`)) : false;
  if (!installed) {
    throw new Error(`Forge installer finished, but ${plan.versionId} was not found in ${path.join(plan.rootDir, 'versions')}.`);
  }
  return {
    ok: true,
    skipped: false,
    plan,
    output: result.output,
    loaderInstalled: installed
  };
}
