import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { projectR2Storage } from '../src/r2StorageBudget.js';
import AdmZip from 'adm-zip';
import { createClientModpackZip } from '../src/clientModpackZip.js';
import { buildRelease } from '../src/releaseBuilder.js';
import { modpackGithubReleasePlan, publishModpackGithubRelease } from '../src/githubModpackRelease.js';
import { CLIENT_DELTA_METADATA_ENTRY } from '../src/clientPackFormat.js';
import { rebuildModpackFromDelta, REMOTE_REBUILD_SCHEMA } from './rebuild-modpack-from-delta.mjs';
import { remoteModpackRebuildPlan } from './remote-modpack-rebuild-plan.mjs';

test('a verified completed rebuild resumes within budget without reserving the stored ZIP twice', async () => {
  const main = await fs.readFile(new URL('../desktop/main.js',import.meta.url),'utf8');
  const start=main.indexOf('function modpackResumeStorageUploads('), end=main.indexOf('\nfunction launcherUpdateRootUrl(',start);
  const plan=vm.runInNewContext(main.slice(start,end)+';modpackResumeStorageUploads', {Buffer,releaseTargetObjectKey:key=>key});
  const input={localLatest:{zip:{path:'packs/aht-2.8.655.zip'}},target:{id:'stable'},canonicalLatestKey:'latest.json',fullZipSize:1231062007,
    incremental:{candidateKey:'staging/candidate.json',resultKey:'staging/result.json',candidateLatest:{version:'2.8.655'}}};
  const first=plan(input);
  assert.equal(projectR2Storage({storedBytes:6076487584,multipartBytes:0,uploads:first}).allowed,true);
  assert.equal(projectR2Storage({storedBytes:7309449126,multipartBytes:0,uploads:first}).allowed,false);
  const resumed=plan({...input,incremental:{...input.incremental,verifiedZipSha256:'a'.repeat(64)}});
  assert.equal(projectR2Storage({storedBytes:7309449126,multipartBytes:0,uploads:resumed}).allowed,true);
  assert(resumed.some(item=>item.key==='latest.json'));
  assert(!resumed.some(item=>item.key===input.localLatest.zip.path || item.key===input.incremental.resultKey));
});

test('publish uses the live baseline; GitHub contains changes only and reuses identical assets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-publish-changes-'));
  try {
    const sourceDir = path.join(root, 'client');
    await fs.mkdir(path.join(sourceDir, 'mods'), { recursive: true });
    await fs.mkdir(path.join(sourceDir, 'config'));
    await fs.writeFile(path.join(sourceDir, 'mods', 'unchanged.jar'), Buffer.alloc(1024 * 1024, 27));
    await fs.writeFile(path.join(sourceDir, 'config', 'change.cfg'), 'published');
    await fs.writeFile(path.join(sourceDir, 'config', 'deleted.cfg'), 'remove me');
    const build = async (version, outDir, previousLatestSource = '') => {
      const zip = await createClientModpackZip({ sourceDir, outDir: path.join(root, 'zips'), version, name: 'A Hard Time', packId: 'a-hard-time-dregora' });
      return buildRelease({ packZip: zip.zipPath, outDir, channel: 'stable', previousLatestSource });
    };
    const liveDir = path.join(root, 'published');
    const outDir = path.join(root, 'staging');
    const live = await build('2.8.800', liveDir);
    // This preview was never published. It must not become the players' baseline.
    await fs.writeFile(path.join(sourceDir, 'config', 'change.cfg'), 'unpublished preview');
    await build('2.8.801', outDir);
    await fs.writeFile(path.join(sourceDir, 'config', 'change.cfg'), 'actual update');
    await fs.rm(path.join(sourceDir, 'config', 'deleted.cfg'));
    const release = await build('2.8.802', outDir, path.join(liveDir, 'latest.json'));
    assert.equal(release.latest.delta.fromVersion, live.latest.version);
    const patch = new AdmZip(path.join(outDir, release.latest.delta.path));
    const entries = patch.getEntries().map(entry => entry.entryName);
    assert(entries.includes('config/change.cfg'));
    assert(!entries.includes('mods/unchanged.jar'));
    assert(JSON.parse(patch.readAsText(CLIENT_DELTA_METADATA_ENTRY)).deleted.includes('config/deleted.cfg'));
    const candidateId = '1234567890abcdef12345678';
    const candidatePath = path.join(root, 'candidate.json');
    const candidate = {
      ...release.latest,
      rebuild: { ...release.latest.rebuild, candidateId }
    };
    await fs.writeFile(candidatePath, JSON.stringify(candidate));
    const rebuiltZipPath = path.join(root, 'rebuilt.zip');
    const rebuildResultPath = path.join(root, 'result.json');
    const rebuilt = await rebuildModpackFromDelta({
      baselineLatestPath: path.join(liveDir, 'latest.json'),
      baselineZipPath: path.join(liveDir, live.latest.zip.path),
      candidateLatestPath: candidatePath,
      targetManifestPath: path.join(outDir, release.latest.clientManifest.path),
      deltaZipPath: path.join(outDir, release.latest.delta.path),
      outputZipPath: rebuiltZipPath,
      resultPath: rebuildResultPath,
      candidateId
    });
    assert.equal(rebuilt.format, REMOTE_REBUILD_SCHEMA);
    assert.equal(rebuilt.version, release.latest.version);
    assert.equal(rebuilt.latest.rebuild, undefined);
    const rebuiltZip = new AdmZip(rebuiltZipPath);
    assert.equal(rebuiltZip.readAsText('config/change.cfg'), 'actual update');
    assert.equal(rebuiltZip.getEntry('config/deleted.cfg'), null);
    assert.equal(rebuiltZip.getEntry('mods/unchanged.jar').header.size, 1024 * 1024);
    assert.equal(JSON.parse(rebuiltZip.readAsText('aht-client-pack.json')).version, release.latest.version);
    const stagingRoot = `staging/modpack-rebuild/stable/${release.latest.version}/${candidateId}`;
    const remotePlan = await remoteModpackRebuildPlan({
      target: 'stable',
      candidateLatestPath: candidatePath,
      baselineLatestPath: path.join(liveDir, 'latest.json'),
      candidateKey: `${stagingRoot}/candidate.json`,
      resultKey: `${stagingRoot}/result.json`,
      candidateId
    });
    assert.equal(remotePlan.baselineLatestKey, 'latest.json');
    assert.equal(remotePlan.zipKey, release.latest.zip.path);
    assert.equal(remotePlan.deltaKey, release.latest.delta.path);
    // A mirror must not even require the local full installer.
    await fs.rm(path.join(outDir, release.latest.zip.path));
    const plan = await modpackGithubReleasePlan({ outDir });
    assert.equal(plan.assets.length, 3);
    assert.equal(plan.assets.filter(asset => asset.name.endsWith('.zip')).length, 1);
    assert(plan.assets.find(asset => asset.name.endsWith('.zip')).name.endsWith('-patch.zip'));
    assert.equal((await modpackGithubReleasePlan({ outDir: liveDir })).assets.some(asset => asset.name.endsWith('.zip')), false);

    for (const change of ['none', 'digest', 'size', 'state']) {
      const calls = [];
      const existing = plan.assets.map((asset, index) => ({ id: index + 1, name: asset.name, size: asset.size, state: 'uploaded', digest: `sha256:${asset.sha256}` }));
      const changed = existing.at(-1);
      if (change === 'digest') changed.digest = 'sha256:' + '0'.repeat(64);
      if (change === 'size') changed.size++;
      if (change === 'state') changed.state = 'starter';
      const result = await publishModpackGithubRelease({ outDir, repo: 'fixture/launcher', token: 'fixture', fetchImpl: async (url, options) => {
        calls.push({ method: options.method || 'GET', url: String(url) });
        if (options.body?.[Symbol.asyncIterator]) for await (const chunk of options.body) { assert(chunk.length > 0); }
        return Response.json({ id: 55, assets: existing });
      } });
      assert.equal(calls.filter(call => call.method === 'DELETE').length, change === 'none' ? 0 : 1);
      assert.equal(calls.filter(call => call.method === 'POST').length, change === 'none' ? 0 : 1);
      assert.equal(result.skipped.length, change === 'none' ? 3 : 2);
      if (change !== 'none') assert(calls.find(call => call.method === 'DELETE').url.endsWith('/assets/3'));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
