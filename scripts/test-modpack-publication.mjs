import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { commitModpackPublication, modpackPublicationArtifacts } from '../src/modpackPublication.js';
import * as targets from '../src/releaseTargets.js';
import { installPack } from '../src/installer.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ref = (name, bytes) => ({ path: name, size: bytes.length, sha256: digest(bytes) });
const release = (target = 'stable', version = '2') => ({
  packId: targets.releaseTarget(target).packId, channel: target, version,
  zip: ref(`packs/pack-${version}.zip`, 'zip'),
  clientManifest: ref(`manifests/pack-${version}.json`, 'manifest'),
  delta: ref(`patches/pack-1-${version}.zip`, 'patch')
});

test('staged/missing/corrupt/publicly unavailable artifacts never become the player feed', async () => {
  for (const target of ['stable', 'ptb']) for (const fault of ['missing', 'size', 'hash', 'public']) {
    const baseline = release(target, '1');
    const latest = release(target);
    let live = baseline, writes = 0;
    const artifacts = modpackPublicationArtifacts(latest, target);
    await assert.rejects(commitModpackPublication({ latest, baseline, target,
      readFeed: async () => live,
      head: async key => {
        const item = artifacts.find(value => value.key === key);
        return { exists: fault !== 'missing', size: item.size + (fault === 'size' ? 1 : 0),
          sha256: fault === 'hash' ? '0'.repeat(64) : item.sha256 };
      },
      verifyPublic: async () => { throw new Error('Public download unavailable'); },
      writeFeed: async value => { writes++; live = value; }
    }), /not verified|unavailable/);
    assert.equal(writes, 0);
    assert.equal(live, baseline);
  }
});

test('a paused verification keeps the old release available; channel changes prevent commit', async () => {
  const baseline = release('stable', '1'), latest = release();
  let live = baseline, resume;
  const paused = new Promise(resolve => { resume = resolve; });
  const artifacts = modpackPublicationArtifacts(latest);
  const pending = commitModpackPublication({ latest, baseline, target: 'stable',
    readFeed: async () => live,
    head: async key => ({ exists: true, ...artifacts.find(item => item.key === key) }),
    verifyPublic: () => paused,
    writeFeed: async value => { live = value; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(live, baseline);
  const otherRelease = release('stable', '3');
  live = otherRelease;
  resume();
  await assert.rejects(pending, /no pointer was overwritten/);
  assert.equal(live, otherRelease);
});

const main = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
const syncSource = main.slice(main.indexOf('async function syncR2('), main.indexOf('\nfunction localReleasePath('));

test('public verification uses real HTTP HEAD and rejects unavailable or unknown-sized downloads', async t => {
  let mode = 'ready';
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'HEAD');
    if (mode === 'ready') response.setHeader('Content-Length', '3');
    if (mode === 'compressed-manifest') {
      if (request.url.endsWith('.json') && request.headers['accept-encoding'] !== 'identity') response.setHeader('Content-Encoding', 'br');
      else response.setHeader('Content-Length', '3');
    }
    if (mode === 'missing') response.statusCode = 404;
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const context = vm.createContext({ fetch, AbortSignal,
    cacheBustUrl: value => value, latestUrlFromWorkerInput: value => value,
    resolveSource: (base, ref) => new URL(ref, base).href });
  vm.runInContext(main.slice(main.indexOf('async function verifyRemoteHead('), main.indexOf('\nasync function verifyRemoteRelease('))
    + main.slice(main.indexOf('async function verifyRemoteReleaseArtifacts('), main.indexOf('\nfunction cleanR2AccountId(')), context);
  const verify = () => context.verifyRemoteReleaseArtifacts({ publicLatestUrl: `${endpoint}/latest.json`, latest: {
    zip: { path: 'packs/ready.zip', size: 3 }, clientManifest: { path: 'manifests/ready.json', size: 3 }
  } });
  await verify();
  mode = 'compressed-manifest'; await verify();
  mode = 'unknown-size'; await assert.rejects(verify(), /size could not be verified/);
  mode = 'missing'; await assert.rejects(verify(), /404/);
});

test('actual full uploader withholds latest through uploads and public verification, then commits once', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-publication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const target of ['stable', 'ptb']) for (const fault of ['', 'upload', 'public']) {
    const latest = release(target), baseline = release(target, '1');
    const dir = targets.releaseTargetOutDir(root, target);
    const files = [];
    for (const [rel, bytes] of [[latest.zip.path, 'zip'], [latest.clientManifest.path, 'manifest'],
      [latest.delta.path, 'patch'], ['latest.json', JSON.stringify(latest)]]) {
      const file = path.join(dir, rel);
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); files.push(file);
    }
    let live = baseline, verified = false, commits = 0;
    const objects = new Map();
    const api = {
      preflightR2Uploads: async () => {},
      getR2JsonDirect: async () => ({ exists: true, value: live }),
      headR2ObjectDirect: async ({ key }) => objects.get(key) || { exists: false },
      uploadR2ObjectDirect: async ({ key, file, sha256 }) => {
        assert(!key.endsWith('latest.json'), 'Public pointer was uploaded during staging');
        assert.equal(live, baseline, 'Player feed changed before every upload completed');
        if (fault === 'upload' && key.includes('patches/')) throw new Error('Upload interrupted');
        const bytes = await fs.readFile(file);
        objects.set(key, { exists: true, size: bytes.length, sha256 });
        return { method: 'fixture', size: bytes.length };
      },
      commitR2ModpackRelease: async options => {
        commits++;
        return commitModpackPublication({ ...options,
          readFeed: async () => live,
          head: key => objects.get(key),
          writeFeed: async value => { assert(verified); live = value; }
        });
      }
    };
    const context = vm.createContext({ ...targets, fs, path, Buffer, crypto: { createHash },
      uploadState: {}, assertDeveloperAuthenticated() {},
      loadConfig: async () => ({ latestUrl: 'https://fixture.invalid/latest.json', developer: { defaultOutDir: root } }),
      resolveReleaseOutDir: value => value,
      validateRelease: async () => ({ ok: true }), cloudPreflight: async () => ({ ok: true }),
      readJsonFile: async file => JSON.parse(await fs.readFile(file, 'utf8')),
      writeJsonFile: async (file, value) => fs.writeFile(file, JSON.stringify(value)),
      loadDeveloperSecrets: async () => ({}), resolveR2DirectCredentials: async () => ({}),
      directR2CredentialsReady: () => true, missingDirectR2CredentialLabels: () => [],
      loadR2DirectUploadModule: async () => api, incrementalRebuildAvailable: () => false,
      listFiles: async () => files, normalizeRelPath: value => value.replaceAll('\\', '/'),
      isPublishableReleasePath: () => true, releaseUploadOrder: value => value === 'latest.json' ? 1000 : 0,
      formatBytes: String, appendOperationLine() {}, trimUploadLines() {}, contentType: () => 'application/octet-stream',
      releaseObjectSha256: async ({ file }) => digest(await fs.readFile(file)), remoteReleaseObjectMatches: () => false,
      verifyRemoteReleaseArtifacts: async () => { assert.equal(live, baseline); if (fault === 'public') throw new Error('Public download unavailable'); verified = true; },
      verifyRemoteRelease: async () => { assert.equal(live.version, latest.version); return { publicLatestUrl: 'fixture' }; }
    });
    vm.runInContext(syncSource, context);
    if (fault) {
      await assert.rejects(context.syncR2({ releaseTarget: target }), /interrupted|unavailable/);
      assert.equal(live, baseline);
      assert(context.uploadState.error);
    } else {
      await context.syncR2({ releaseTarget: target });
      assert.equal(commits, 1); assert.equal(live.version, '2');
    }
    assert.equal(context.uploadState.running, false);
  }
});

test('real installer uses selected immutable artifacts after HTTP feed advances', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-install-pinned-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zip = new AdmZip();
  zip.addFile('aht-client-pack.json', Buffer.from(JSON.stringify({ format: 'aht-full-client-zip' })));
  zip.addFile('mods/approved.jar', Buffer.from('release one'));
  const bytes = zip.toBuffer();
  let reads = 0;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/latest.json')) { reads++; response.end(JSON.stringify({ version: '2', zip: { url: '/not-ready.zip' } })); }
    else if (request.url.startsWith('/packs/one.zip')) response.end(bytes);
    else { response.statusCode = 404; response.end('staged release not available'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const selected = { packId: 'fixture', version: '1', installMode: 'full-client-zip', zip: {
    url: `${endpoint}/packs/one.zip`, sha256: digest(bytes), size: bytes.length
  } };
  const result = await installPack({ latestSource: `${endpoint}/latest.json`, latestRelease: selected,
    instanceDir: path.join(root, 'instance'), logger: { log() {} } });
  assert.equal(result.installed.version, '1');
  assert.equal(await fs.readFile(path.join(root, 'instance/mods/approved.jar'), 'utf8'), 'release one');
  assert.equal(reads, 0, 'The installer re-read a moving feed after release selection');
});
