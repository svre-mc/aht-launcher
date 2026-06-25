import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildRelease } from '../src/releaseBuilder.js';
import { installPack } from '../src/installer.js';
import { pathExists, readJsonFile } from '../src/utils.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function contentTypeFor(file) {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

function safeObjectPath(rootDir, key) {
  const target = path.resolve(rootDir, ...key.split('/'));
  const rootResolved = path.resolve(rootDir);
  if (target !== rootResolved && !target.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`Refusing to serve outside release root: ${key}`);
  }
  return target;
}

async function writeResourcePackZip(filePath) {
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 3, description: 'Wilhelm' } }, null, 2)));
  zip.addFile('assets/aht/lang/en_us.lang', Buffer.from('aht.test=Wilhelm\n'));
  zip.writeZip(filePath);
}

const port = Number(process.argv[2] || 10121);
const workerEndpoint = `http://127.0.0.1:${port}`;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aht-resourcepack-keyed-cache-'));
const sourceInstance = path.join(root, 'curseforge-instance');
const modsDir = path.join(sourceInstance, 'mods');
const resourcepacksDir = path.join(sourceInstance, 'resourcepacks');
const outDir = path.join(root, 'release');
const installDir = path.join(root, 'install');
const packZip = path.join(root, 'A Hard Time Resourcepack Cache-2.8.52.zip');
const projectId = 815314;
const fileId = 4358088;
const manifestKey = `${projectId}:${fileId}`;
const resourcePackName = 'Wilhelm.zip';
const resourcePackPath = path.join(resourcepacksDir, resourcePackName);

await fsp.mkdir(modsDir, { recursive: true });
await fsp.mkdir(resourcepacksDir, { recursive: true });
await writeResourcePackZip(resourcePackPath);
const resourcePackBytes = await fsp.readFile(resourcePackPath);

await fsp.writeFile(path.join(sourceInstance, 'minecraftinstance.json'), JSON.stringify({
  installedAddons: [
    {
      addonID: projectId,
      packageType: 3,
      categorySection: { path: 'resourcepacks', packageType: 3 },
      fileNameOnDisk: resourcePackName,
      modFolderPath: resourcepacksDir,
      filePaths: [resourcePackPath],
      installedFile: {
        id: fileId,
        projectId,
        fileName: resourcePackName,
        fileNameOnDisk: resourcePackName,
        hashes: [{ type: 1, value: '4599d3354f1ceac083e024b0bb4e20481050601e' }]
      }
    }
  ]
}, null, 2));

const pack = new AdmZip();
pack.addFile('manifest.json', Buffer.from(JSON.stringify({
  minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }] },
  manifestType: 'minecraftModpack',
  manifestVersion: 1,
  name: 'A Hard Time',
  version: '2.8.52',
  author: 'AHT',
  files: [{ projectID: projectId, fileID: fileId, required: true }],
  overrides: 'overrides'
}, null, 2)));
pack.addFile('overrides/config/aht.cfg', Buffer.from('aht=true\n'));
pack.writeZip(packZip);

const build = await buildRelease({
  packZip,
  outDir,
  baseUrl: workerEndpoint,
  cacheModsDir: sourceInstance
});
const cacheManifest = await readJsonFile(path.join(outDir, 'cache', 'mod-cache.json'));
const entry = cacheManifest.entries?.[manifestKey];
assert(entry, `Expected keyed cache entry ${manifestKey}: ${JSON.stringify(cacheManifest)}`);
assert(entry.fileName === resourcePackName, `Resource pack cache filename mismatch: ${JSON.stringify(entry)}`);
assert(entry.installPath === `resourcepacks/${resourcePackName}`, `Resource pack cache installPath mismatch: ${JSON.stringify(entry)}`);
assert(entry.sha256 === sha256(resourcePackBytes), `Resource pack cache hash mismatch: ${JSON.stringify(entry)}`);
assert(build.report.cacheSummary.matchedManifestFiles === 1, `Expected one matched manifest file: ${JSON.stringify(build.report.cacheSummary)}`);
assert(build.report.cacheSummary.missingManifestFiles.length === 0, `Unexpected missing cache entries: ${JSON.stringify(build.report.cacheSummary)}`);
assert(!(cacheManifest.extraFiles || []).some((extra) => extra.fileName === resourcePackName), 'Matched resource pack should not also be emitted as an extra file.');

const requestLog = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, workerEndpoint);
  requestLog.push(`${request.method} ${url.pathname}`);
  if (url.pathname.startsWith('/cf/')) {
    response.statusCode = 403;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'CurseForge blocked in smoke' }));
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
    logger: { log(message) { logs.push(message); } }
  });

  assert(await pathExists(path.join(installDir, 'resourcepacks', resourcePackName)), 'Resource pack was not installed into resourcepacks.');
  assert(!(await pathExists(path.join(installDir, 'mods', resourcePackName))), 'Resource pack was incorrectly installed into mods.');
  const installedBytes = await fsp.readFile(path.join(installDir, 'resourcepacks', resourcePackName));
  assert(installedBytes.equals(resourcePackBytes), 'Installed resource pack bytes do not match the private cache.');
  const managed = await readJsonFile(path.join(installDir, '.aht-launcher', 'managed-files.json'));
  const managedEntry = managed.find((item) => item.relativePath === `resourcepacks/${resourcePackName}`);
  assert(managedEntry?.source === 'cache' && managedEntry?.key === manifestKey, `Managed file did not record keyed cache resource pack: ${JSON.stringify(managed)}`);
  assert(requestLog.some((line) => line.includes(`/cf/mods/${projectId}/files/${fileId}`)), `CurseForge metadata was not attempted: ${JSON.stringify(requestLog)}`);
  assert(logs.some((line) => line.includes(`Downloading cache ${manifestKey}`)), `Installer did not use keyed cache fallback: ${JSON.stringify(logs)}`);

  console.log(JSON.stringify({
    ok: true,
    releaseVersion: build.latest.version,
    installedVersion: result.installed.version,
    cacheEntry: entry,
    managedEntry,
    requestLog,
    logs
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
