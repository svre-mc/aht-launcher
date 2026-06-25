import { spawn } from 'node:child_process';
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
    child.once('error', reject);
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
