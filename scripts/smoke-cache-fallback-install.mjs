import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildRelease } from '../src/releaseBuilder.js';
import { installPack } from '../src/installer.js';

const port = Number(process.argv[2] || 10120);
const workerEndpoint = `http://127.0.0.1:${port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-cache-fallback-'));
const packZip = path.join(root, 'A Hard Time Cache Test-2.8.4.zip');
const cacheInstance = path.join(root, 'curseforge-instance');
const cacheModsDir = path.join(cacheInstance, 'mods');
const outDir = path.join(root, 'release');
const installDir = path.join(root, 'install');
const cachedJarName = 'locked-mod.jar';
const cachedJarBytes = Buffer.from('private cached mod jar\n');
const extraJarName = 'private-extra.jar';
const extraJarBytes = Buffer.from('private extra local mod jar\n');
const duplicateJarName = 'duplicate-override.jar';
const duplicateCacheBytes = Buffer.from('cache duplicate should be skipped\n');
const duplicateOverrideBytes = Buffer.from('override duplicate should win\n');
const projectId = 111111;
const fileId = 222222;
const manifestKey = `${projectId}:${fileId}`;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function contentTypeFor(file) {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.zip')) return 'application/zip';
  if (file.endsWith('.jar')) return 'application/java-archive';
  if (file.endsWith('.cfg') || file.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeObjectPath(rootDir, key) {
  const target = path.resolve(rootDir, ...key.split('/'));
  const rootResolved = path.resolve(rootDir);
  if (target !== rootResolved && !target.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`Refusing to serve outside release root: ${key}`);
  }
  return target;
}

await fsp.mkdir(cacheModsDir, { recursive: true });
await fsp.writeFile(path.join(cacheModsDir, cachedJarName), cachedJarBytes);
await fsp.writeFile(path.join(cacheModsDir, extraJarName), extraJarBytes);
await fsp.writeFile(path.join(cacheModsDir, duplicateJarName), duplicateCacheBytes);
await writeJson(path.join(cacheInstance, 'minecraftinstance.json'), {
  installedAddons: [
    {
      addonID: projectId,
      filePaths: [path.join(cacheModsDir, cachedJarName)],
      installedFile: {
        id: fileId,
        fileName: cachedJarName,
        fileNameOnDisk: cachedJarName
      }
    }
  ]
});

const manifest = {
  name: 'A Hard Time Cache Test',
  version: '2.8.4',
  overrides: 'overrides',
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  },
  files: [
    {
      projectID: projectId,
      fileID: fileId,
      required: true
    }
  ]
};
const zip = new AdmZip();
zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
zip.addFile('overrides/config/cache-test.cfg', Buffer.from('cache=true\n'));
zip.addFile(`overrides/mods/${duplicateJarName}`, duplicateOverrideBytes);
zip.writeZip(packZip);

const build = await buildRelease({
  packZip,
  outDir,
  baseUrl: workerEndpoint,
  channel: 'stable',
  cacheModsDir: cacheInstance
});
const cacheManifest = JSON.parse(fs.readFileSync(path.join(outDir, 'cache', 'mod-cache.json'), 'utf8'));
const cacheEntry = cacheManifest.entries?.[manifestKey];
if (!cacheEntry) {
  throw new Error(`Expected cache entry ${manifestKey}: ${JSON.stringify(cacheManifest)}`);
}
if (cacheEntry.sha256 !== sha256(cachedJarBytes)) {
  throw new Error(`Cache entry hash mismatch: ${JSON.stringify(cacheEntry)}`);
}
if (build.report.cacheSummary.matchedManifestFiles !== 1 || build.report.cacheSummary.missingManifestFiles.length) {
  throw new Error(`Release builder did not cover the manifest file from cache: ${JSON.stringify(build.report.cacheSummary)}`);
}

const requestLog = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  requestLog.push(`${request.method} ${url.pathname}`);
  if (url.pathname.startsWith('/cf/')) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (url.pathname === `/cf/mods/${projectId}/files/${fileId}`) {
      response.statusCode = 200;
      response.end(JSON.stringify({
        data: {
          fileName: cachedJarName,
          downloadUrl: `${workerEndpoint}/blocked/${cachedJarName}`,
          hashes: [{ value: sha256(Buffer.from('wrong hash length does not match sha1')) }]
        }
      }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'CurseForge endpoint is unavailable in this smoke' }));
    }
    return;
  }
  if (url.pathname.startsWith('/blocked/')) {
    response.statusCode = 403;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'CurseForge file download is blocked in this smoke' }));
    return;
  }

  const key = decodeURIComponent(url.pathname.replace(/^\/+/, '') || 'latest.json');
  const file = safeObjectPath(outDir, key);
  try {
    const stat = await fsp.stat(file);
    response.statusCode = 200;
    response.setHeader('Content-Type', contentTypeFor(file));
    response.setHeader('Content-Length', String(stat.size));
    if (request.method === 'HEAD') {
      response.end();
    } else {
      fs.createReadStream(file).pipe(response);
    }
  } catch {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'not found', key }));
  }
});
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

const logs = [];
try {
  const result = await installPack({
    latestSource: `${workerEndpoint}/latest.json`,
    instanceDir: installDir,
    cfProxyBaseUrl: `${workerEndpoint}/cf/`,
    logger: {
      log(message) {
        logs.push(message);
      }
    }
  });

  const installedJar = await fsp.readFile(path.join(installDir, 'mods', cachedJarName));
  const installedExtraJar = await fsp.readFile(path.join(installDir, 'mods', extraJarName));
  const installedDuplicateJar = await fsp.readFile(path.join(installDir, 'mods', duplicateJarName));
  const managed = JSON.parse(fs.readFileSync(path.join(installDir, '.aht-launcher', 'managed-files.json'), 'utf8'));
  const managedMod = managed.find((item) => item.relativePath === `mods/${cachedJarName}`);
  const managedExtra = managed.find((item) => item.relativePath === `mods/${extraJarName}`);
  const managedDuplicate = managed.find((item) => item.relativePath === `mods/${duplicateJarName}`);
  if (!installedJar.equals(cachedJarBytes)) {
    throw new Error('Installed jar does not match the fallback cache jar.');
  }
  if (!installedExtraJar.equals(extraJarBytes)) {
    throw new Error('Installed cache extra jar does not match the fallback cache jar.');
  }
  if (!installedDuplicateJar.equals(duplicateOverrideBytes)) {
    throw new Error('Override duplicate was not preserved over cache extra.');
  }
  if (!managedMod || managedMod.source !== 'cache' || managedMod.key !== manifestKey || managedMod.sha256 !== cacheEntry.sha256) {
    throw new Error(`Managed file did not record cache source correctly: ${JSON.stringify(managed)}`);
  }
  if (!managedExtra || managedExtra.source !== 'cache-extra') {
    throw new Error(`Managed file did not record cache-extra source correctly: ${JSON.stringify(managed)}`);
  }
  if (!managedDuplicate || managedDuplicate.source !== 'overrides') {
    throw new Error(`Duplicate override was not managed as an override: ${JSON.stringify(managed)}`);
  }
  if (!logs.some((line) => line.includes(`Downloading cache ${manifestKey}`))) {
    throw new Error(`Installer logs did not show cache download: ${JSON.stringify(logs)}`);
  }
  if (!logs.some((line) => line.includes('trying fallback cache'))) {
    throw new Error(`Installer logs did not show CurseForge download failure fallback: ${JSON.stringify(logs)}`);
  }
  if (!logs.some((line) => line.includes(`Downloading cache extra:${sha256(extraJarBytes)}`))) {
    throw new Error(`Installer logs did not show cache extra download: ${JSON.stringify(logs)}`);
  }
  if (!logs.some((line) => line.includes(`Skipping cache extra ${duplicateJarName}`))) {
    throw new Error(`Installer logs did not show duplicate cache extra skip: ${JSON.stringify(logs)}`);
  }
  if (!requestLog.some((line) => line.includes('/cf/mods/111111/files/222222'))) {
    throw new Error(`CurseForge proxy was not attempted before cache fallback: ${JSON.stringify(requestLog)}`);
  }
  if (!requestLog.some((line) => line.includes(`/blocked/${cachedJarName}`))) {
    throw new Error(`CurseForge download URL was not attempted before cache fallback: ${JSON.stringify(requestLog)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    release: {
      version: build.latest.version,
      cacheEntry: manifestKey,
      cacheUrl: cacheEntry.url,
      matchedManifestFiles: build.report.cacheSummary.matchedManifestFiles
    },
    install: {
      version: result.installed.version,
      downloadedModCount: result.downloadedModCount,
      managedSource: managedMod.source,
      managedPath: managedMod.relativePath,
      managedExtraSource: managedExtra.source,
      duplicateSource: managedDuplicate.source
    },
    requestLog,
    logs
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
