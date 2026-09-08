import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanGithubRepo, cleanRef } from './githubActions.js';
import { assertReleaseMatchesTarget, releaseTarget } from './releaseTargets.js';
import { githubPublishRequest } from './githubPublishRequest.js';
import { hashFile } from './utils.js';
import { CLIENT_DELTA_FORMAT } from './clientPackFormat.js';

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
  const assets = [];
  const addAsset = async (relativePath, name) => {
    const file = path.resolve(resolvedOutDir, ...String(relativePath || '').replaceAll('\\', '/').split('/'));
    if (!relativePath || !insideDirectory(resolvedOutDir, file)) {
      throw new Error('Mirror asset path must stay inside the target output directory.');
    }
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`Mirror asset is missing: ${file}`);
    assets.push({ file, name, size: stat.size, contentType: contentTypeForAsset(file), sha256: await hashFile(file, 'sha256') });
  };
  // GitHub is optional. Never duplicate the full installer already hosted on R2.
  if (latest.delta) {
    if (latest.delta.format !== CLIENT_DELTA_FORMAT || latest.delta.toVersion !== version || latest.delta.fromVersion === version) {
      throw new Error('GitHub mirror requires a changed-files patch for this release version.');
    }
    const fromVersion = safeVersion(latest.delta.fromVersion);
    if (latest.delta.path === latest.zip?.path) throw new Error('GitHub patch must not be the full client ZIP.');
    await addAsset(latest.delta.path, `${target.githubAssetPrefix}-${fromVersion}-to-${version}-patch.zip`);
  }
  if (latest.clientManifest?.path) {
    await addAsset(latest.clientManifest.path, `${target.githubAssetPrefix}-${version}-manifest.json`);
  }
  await addAsset('latest.json', `${target.githubAssetPrefix}-latest.json`);
  const tagName = `${target.githubTagPrefix}${version}`;
  return {
    target: target.id,
    tagName,
    releaseName: `${target.name} ${version}`,
    prerelease: target.githubPrerelease,
    latest,
    assets
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
  uploadsBase = GITHUB_UPLOADS,
  onProgress = () => {},
  apiTimeoutMs = 30_000,
  uploadIdleTimeoutMs = 180_000,
  uploadTimeoutMs = 30 * 60_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available for GitHub publication.');
  const cleanRepo = cleanGithubRepo(repo);
  const cleanBranch = cleanRef(ref);
  const plan = await modpackGithubReleasePlan({ outDir, releaseTarget: targetValue });
  const headers = githubHeaders(token);
  const started = Date.now();
  const total = plan.assets.reduce((sum, asset) => sum + asset.size, 0);
  let completed = 0;
  const progress = (phase, extra = {}) => onProgress({
    phase, completed, total, unit: 'bytes',
    percent: Math.min(99, Math.floor(completed * 100 / Math.max(1, total))),
    elapsedMs: Date.now() - started, ...extra
  });
  const request = (url, options, label, jsonOptions) => githubPublishRequest(
    fetchImpl, url, options, response => githubJson(response, label, jsonOptions),
    { label, idleTimeoutMs: apiTimeoutMs, requestTimeoutMs: apiTimeoutMs }
  );
  progress('Checking GitHub mirror');
  const encodedTag = encodeURIComponent(plan.tagName);
  let release = await request(`${apiBase}/repos/${cleanRepo}/releases/tags/${encodedTag}`, {
    headers
  }, 'GitHub modpack release lookup', { allowNotFound: true });

  if (!release) {
    release = await request(`${apiBase}/repos/${cleanRepo}/releases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tag_name: plan.tagName,
        target_commitish: cleanBranch,
        name: plan.releaseName,
        body: `${plan.releaseName} changed-files mirror and release metadata. Channel: ${plan.target}. Install and update through AHT Launcher.`,
        draft: true,
        prerelease: plan.prerelease,
        make_latest: 'false'
      })
    }, 'GitHub modpack release creation');
  }

  const existingAssets = Array.isArray(release.assets) ? release.assets : [];
  const skipped = [];
  for (const asset of plan.assets) {
    const existing = existingAssets.find((item) => item?.name === asset.name && item?.id);
    if (existing?.state === 'uploaded' && Number(existing.size) === asset.size &&
        String(existing.digest || '').toLowerCase() === `sha256:${asset.sha256}`) {
      completed += asset.size;
      skipped.push(asset.name);
      progress(`Unchanged ${asset.name}`);
      continue;
    }
    if (existing) {
      await request(`${apiBase}/repos/${cleanRepo}/releases/assets/${existing.id}`, {
        method: 'DELETE',
        headers
      }, `GitHub asset replacement for ${asset.name}`);
    }
    const uploadUrl = new URL(`${uploadsBase}/repos/${cleanRepo}/releases/${release.id}/assets`);
    uploadUrl.searchParams.set('name', asset.name);
    const label = `GitHub asset upload ${asset.name}`;
    const assetContentType = contentTypeForAsset(asset.file);
    const uploadBody = typeof fsSync.openAsBlob === 'function'
      ? await fsSync.openAsBlob(asset.file, { type: assetContentType })
      : await fs.readFile(asset.file);
    progress(`Uploading ${asset.name}`);
    await githubPublishRequest(fetchImpl, uploadUrl, {
      method: 'POST',
      headers: githubHeaders(token, assetContentType),
      body: uploadBody
    }, response => githubJson(response, label), {
      label, idleTimeoutMs: uploadIdleTimeoutMs, requestTimeoutMs: uploadTimeoutMs
    });
    completed += asset.size;
    progress(`GitHub confirmed ${asset.name}`);
  }

  progress('Finalizing GitHub mirror');
  const published = await request(`${apiBase}/repos/${cleanRepo}/releases/${release.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      name: plan.releaseName,
      draft: false,
      prerelease: plan.prerelease,
      make_latest: 'false'
    })
  }, 'GitHub modpack release finalization');
  progress('GitHub mirror published', { percent: 100 });

  return {
    ok: true,
    target: plan.target,
    repo: cleanRepo,
    ref: cleanBranch,
    tagName: plan.tagName,
    releaseName: plan.releaseName,
    prerelease: plan.prerelease,
    skipped,
    releaseUrl: published?.html_url || release?.html_url || `https://github.com/${cleanRepo}/releases/tag/${plan.tagName}`,
    assets: plan.assets.map(({ file, ...asset }) => asset)
  };
}
