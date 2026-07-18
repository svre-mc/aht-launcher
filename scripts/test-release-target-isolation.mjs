import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClientModpackZip } from '../src/clientModpackZip.js';
import { modpackGithubReleasePlan, publishModpackGithubRelease } from '../src/githubModpackRelease.js';
import { buildRelease } from '../src/releaseBuilder.js';
import {
  assertReleaseMatchesTarget,
  releaseTarget,
  releaseTargetFeedUrl,
  releaseTargetObjectKey,
  releaseTargetOutDir
} from '../src/releaseTargets.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function makeClientSource(root, marker) {
  const source = path.join(root, `${marker}-source`);
  await fs.mkdir(path.join(source, 'mods'), { recursive: true });
  await fs.mkdir(path.join(source, 'config'), { recursive: true });
  await fs.writeFile(path.join(source, 'mods', `${marker}.jar`), `${marker}-jar`, 'utf8');
  await fs.writeFile(path.join(source, 'config', `${marker}.cfg`), `${marker}=true\n`, 'utf8');
  return source;
}

async function listRelativeFiles(root) {
  const files = [];
  async function walk(current, rel = '') {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(entryPath, entryRel);
      else if (entry.isFile()) files.push(entryRel.replaceAll('\\', '/'));
    }
  }
  await walk(root);
  return files.sort();
}

async function buildTarget({ root, baseOutDir, targetId, version }) {
  const target = releaseTarget(targetId);
  const sourceDir = await makeClientSource(root, targetId);
  const zipResult = await createClientModpackZip({
    sourceDir,
    outDir: path.join(root, 'client-zips', targetId),
    version,
    name: target.name,
    packId: target.packId,
    includeFiles: true
  });
  const outDir = releaseTargetOutDir(baseOutDir, targetId);
  const feedUrl = releaseTargetFeedUrl('https://launcher.example/latest.json', targetId);
  const result = await buildRelease({
    packZip: zipResult.zipPath,
    outDir,
    baseUrl: new URL('.', feedUrl).toString(),
    channel: target.channel
  });
  assertReleaseMatchesTarget(result.latest, targetId);
  return { target, sourceDir, zipResult, outDir, feedUrl, result };
}

async function publishWithMock({ targetId, outDir, releaseId }) {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    const method = options.method || 'GET';
    let jsonBody = null;
    if (typeof options.body === 'string') jsonBody = JSON.parse(options.body);
    if (options.body && typeof options.body !== 'string' && Symbol.asyncIterator in options.body) {
      let bytes = 0;
      for await (const chunk of options.body) bytes += chunk.length;
      calls.push({ method, url, streamedBytes: bytes, headers: options.headers || {} });
    } else {
      calls.push({ method, url, jsonBody, headers: options.headers || {} });
    }

    if (method === 'GET' && url.includes('/releases/tags/')) {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    if (method === 'POST' && /\/releases$/.test(url)) {
      return Response.json({ id: releaseId, assets: [], html_url: `https://github.test/release/${releaseId}` });
    }
    if (method === 'POST' && url.includes('/assets?')) {
      return Response.json({ id: releaseId + calls.length, name: new URL(url).searchParams.get('name') });
    }
    if (method === 'PATCH' && url.endsWith(`/releases/${releaseId}`)) {
      return Response.json({ id: releaseId, html_url: `https://github.test/release/${releaseId}` });
    }
    throw new Error(`Unexpected mocked GitHub request: ${method} ${url}`);
  };

  const result = await publishModpackGithubRelease({
    repo: 'svre-mc/aht-launcher',
    ref: 'main',
    token: 'test-token',
    outDir,
    releaseTarget: targetId,
    fetchImpl,
    apiBase: 'https://api.github.test',
    uploadsBase: 'https://uploads.github.test'
  });
  return { result, calls };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-release-targets-'));
const baseOutDir = path.join(root, 'release');
const stable = await buildTarget({ root, baseOutDir, targetId: 'stable', version: '2.8.700' });
const stableLatestBefore = await fs.readFile(path.join(stable.outDir, 'latest.json'));
const stableFilesBefore = await listRelativeFiles(stable.outDir);

const ptb = await buildTarget({ root, baseOutDir, targetId: 'ptb', version: '2.9.0-ptb.7' });
const stableLatestAfter = await fs.readFile(path.join(stable.outDir, 'latest.json'));
const stableFilesAfter = (await listRelativeFiles(stable.outDir)).filter((file) => !file.startsWith('ptb/'));

assert(stableLatestBefore.equals(stableLatestAfter), 'Building PTB changed stable latest.json.');
assert(JSON.stringify(stableFilesBefore) === JSON.stringify(stableFilesAfter), 'Building PTB changed stable release artifacts.');
assert(ptb.outDir === path.join(baseOutDir, 'ptb'), `PTB output was not isolated: ${ptb.outDir}`);
assert(stable.outDir === baseOutDir, `Stable output path changed: ${stable.outDir}`);
assert(stable.feedUrl === 'https://launcher.example/latest.json', `Stable feed changed: ${stable.feedUrl}`);
assert(ptb.feedUrl === 'https://launcher.example/ptb/latest.json', `PTB feed is not isolated: ${ptb.feedUrl}`);
assert(releaseTargetObjectKey('latest.json', 'stable') === 'latest.json', 'Stable R2 key changed.');
assert(releaseTargetObjectKey('latest.json', 'ptb') === 'ptb/latest.json', 'PTB R2 key is not isolated.');
assert(releaseTargetObjectKey(stable.result.latest.zip.path, 'stable').startsWith('packs/'), 'Stable pack key changed.');
assert(releaseTargetObjectKey(ptb.result.latest.zip.path, 'ptb').startsWith('ptb/packs/'), 'PTB pack key is not isolated.');

const stablePlan = await modpackGithubReleasePlan({ outDir: stable.outDir, releaseTarget: 'stable' });
const ptbPlan = await modpackGithubReleasePlan({ outDir: ptb.outDir, releaseTarget: 'ptb' });
assert(stablePlan.tagName !== ptbPlan.tagName, 'Stable and PTB GitHub tags collide.');
assert(stablePlan.assets.every((asset) => asset.name.startsWith('a-hard-time-stable-')), 'Stable GitHub asset names changed.');
assert(ptbPlan.assets.every((asset) => asset.name.startsWith('a-hard-time-ptb-')), 'PTB GitHub asset names are not isolated.');
assert(stablePlan.prerelease === false, 'Stable GitHub release must not be a prerelease.');
assert(ptbPlan.prerelease === true, 'PTB GitHub release must be a prerelease.');

const stablePublish = await publishWithMock({ targetId: 'stable', outDir: stable.outDir, releaseId: 101 });
const ptbPublish = await publishWithMock({ targetId: 'ptb', outDir: ptb.outDir, releaseId: 202 });
const stableCreate = stablePublish.calls.find((call) => call.method === 'POST' && /\/releases$/.test(call.url));
const ptbCreate = ptbPublish.calls.find((call) => call.method === 'POST' && /\/releases$/.test(call.url));
const stableUploads = stablePublish.calls.filter((call) => call.method === 'POST' && call.url.includes('/assets?'));
const ptbUploads = ptbPublish.calls.filter((call) => call.method === 'POST' && call.url.includes('/assets?'));
assert(stableCreate?.jsonBody?.tag_name === stablePlan.tagName, 'Stable GitHub creation used the wrong tag.');
assert(ptbCreate?.jsonBody?.tag_name === ptbPlan.tagName, 'PTB GitHub creation used the wrong tag.');
assert(stableCreate?.jsonBody?.prerelease === false, 'Stable GitHub creation was marked prerelease.');
assert(ptbCreate?.jsonBody?.prerelease === true, 'PTB GitHub creation was not marked prerelease.');
assert(stableCreate?.jsonBody?.make_latest === 'false' && ptbCreate?.jsonBody?.make_latest === 'false', 'Modpack releases must not replace launcher latest releases.');
assert(stableUploads.length === 2 && ptbUploads.length === 2, 'Each GitHub channel must upload exactly its ZIP and latest manifest.');
assert(stableUploads.every((call) => !call.url.includes('a-hard-time-ptb')), 'Stable publication used a PTB asset name.');
assert(ptbUploads.every((call) => call.url.includes('a-hard-time-ptb')), 'PTB publication used a stable asset name.');
assert(stablePublish.result.tagName !== ptbPublish.result.tagName, 'Published GitHub release tags collide.');

console.log(JSON.stringify({
  ok: true,
  root,
  stable: {
    packId: stable.result.latest.packId,
    channel: stable.result.latest.channel,
    feedUrl: stable.feedUrl,
    outDir: stable.outDir,
    githubTag: stablePublish.result.tagName,
    githubAssets: stablePublish.result.assets.map((asset) => asset.name)
  },
  ptb: {
    packId: ptb.result.latest.packId,
    channel: ptb.result.latest.channel,
    feedUrl: ptb.feedUrl,
    outDir: ptb.outDir,
    githubTag: ptbPublish.result.tagName,
    githubAssets: ptbPublish.result.assets.map((asset) => asset.name)
  },
  stableManifestUnchangedAfterPtbBuild: stableLatestBefore.equals(stableLatestAfter),
  stableArtifactsUnchangedAfterPtbBuild: JSON.stringify(stableFilesBefore) === JSON.stringify(stableFilesAfter)
}, null, 2));
