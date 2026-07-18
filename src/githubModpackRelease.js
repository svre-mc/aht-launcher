import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanGithubRepo, cleanRef } from './githubActions.js';
import { assertReleaseMatchesTarget, releaseTarget } from './releaseTargets.js';

const GITHUB_API = 'https://api.github.com';
const GITHUB_UPLOADS = 'https://uploads.github.com';

function githubHeaders(token, contentType = 'application/vnd.github+json') {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('GitHub token is required to publish a modpack release.');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${cleanToken}`,
    'Content-Type': contentType,
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function githubJson(response, label, { allowNotFound = false } = {}) {
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${label} failed: ${body?.message || `${response.status} ${response.statusText}`.trim()}`);
  }
  return body;
}

function safeVersion(value = '') {
  const version = String(value || '').trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version)) {
    throw new Error(`Modpack version is invalid for a GitHub release tag: ${value || 'missing'}`);
  }
  return version;
}

function contentTypeForAsset(file) {
  if (file.toLowerCase().endsWith('.zip')) return 'application/zip';
  if (file.toLowerCase().endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function insideDirectory(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function modpackGithubReleasePlan({ outDir, releaseTarget: targetValue = 'stable' } = {}) {
  if (!outDir) throw new Error('Release output directory is required for GitHub publication.');
  const target = releaseTarget(targetValue);
  const resolvedOutDir = path.resolve(outDir);
  const latestPath = path.join(resolvedOutDir, 'latest.json');
  const latest = JSON.parse(await fs.readFile(latestPath, 'utf8'));
  assertReleaseMatchesTarget(latest, target.id);
  const version = safeVersion(latest.version);
  const zipRelativePath = String(latest.zip?.path || '').replaceAll('\\', '/');
  const zipPath = path.resolve(resolvedOutDir, ...zipRelativePath.split('/'));
  if (!zipRelativePath || !insideDirectory(resolvedOutDir, zipPath)) {
    throw new Error('Release ZIP path must stay inside the target output directory.');
  }
  const [zipStat, latestStat] = await Promise.all([fs.stat(zipPath), fs.stat(latestPath)]);
  if (!zipStat.isFile()) throw new Error(`Release ZIP is missing: ${zipPath}`);
  const tagName = `${target.githubTagPrefix}${version}`;
  return {
    target: target.id,
    tagName,
    releaseName: `${target.name} ${version}`,
    prerelease: target.githubPrerelease,
    latest,
    assets: [
      {
        file: zipPath,
        name: `${target.githubAssetPrefix}-${version}.zip`,
        size: zipStat.size,
        contentType: 'application/zip'
      },
      {
        file: latestPath,
        name: `${target.githubAssetPrefix}-latest.json`,
        size: latestStat.size,
        contentType: 'application/json'
      }
    ]
  };
}

export async function publishModpackGithubRelease({
  repo,
  ref = 'main',
  token,
  outDir,
  releaseTarget: targetValue = 'stable',
  fetchImpl = globalThis.fetch,
  apiBase = GITHUB_API,
  uploadsBase = GITHUB_UPLOADS
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available for GitHub publication.');
  const cleanRepo = cleanGithubRepo(repo);
  const cleanBranch = cleanRef(ref);
  const plan = await modpackGithubReleasePlan({ outDir, releaseTarget: targetValue });
  const headers = githubHeaders(token);
  const encodedTag = encodeURIComponent(plan.tagName);
  let release = await githubJson(await fetchImpl(`${apiBase}/repos/${cleanRepo}/releases/tags/${encodedTag}`, {
    headers
  }), 'GitHub modpack release lookup', { allowNotFound: true });

  if (!release) {
    release = await githubJson(await fetchImpl(`${apiBase}/repos/${cleanRepo}/releases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tag_name: plan.tagName,
        target_commitish: cleanBranch,
        name: plan.releaseName,
        body: `${plan.releaseName} exact client package. Channel: ${plan.target}.`,
        draft: true,
        prerelease: plan.prerelease,
        make_latest: 'false'
      })
    }), 'GitHub modpack release creation');
  }

  const existingAssets = Array.isArray(release.assets) ? release.assets : [];
  for (const asset of plan.assets) {
    const existing = existingAssets.find((item) => item?.name === asset.name && item?.id);
    if (existing) {
      await githubJson(await fetchImpl(`${apiBase}/repos/${cleanRepo}/releases/assets/${existing.id}`, {
        method: 'DELETE',
        headers
      }), `GitHub asset replacement for ${asset.name}`);
    }
    const uploadUrl = new URL(`${uploadsBase}/repos/${cleanRepo}/releases/${release.id}/assets`);
    uploadUrl.searchParams.set('name', asset.name);
    const stream = fsSync.createReadStream(asset.file);
    const response = await fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        ...githubHeaders(token, contentTypeForAsset(asset.file)),
        'Content-Length': String(asset.size)
      },
      body: stream,
      duplex: 'half'
    });
    await githubJson(response, `GitHub asset upload ${asset.name}`);
  }

  const published = await githubJson(await fetchImpl(`${apiBase}/repos/${cleanRepo}/releases/${release.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      name: plan.releaseName,
      draft: false,
      prerelease: plan.prerelease,
      make_latest: 'false'
    })
  }), 'GitHub modpack release finalization');

  return {
    ok: true,
    target: plan.target,
    repo: cleanRepo,
    ref: cleanBranch,
    tagName: plan.tagName,
    releaseName: plan.releaseName,
    prerelease: plan.prerelease,
    releaseUrl: published?.html_url || release?.html_url || `https://github.com/${cleanRepo}/releases/tag/${plan.tagName}`,
    assets: plan.assets.map(({ file, ...asset }) => asset)
  };
}
