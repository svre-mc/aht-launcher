import path from 'node:path';

const TARGETS = Object.freeze({
  stable: Object.freeze({
    id: 'stable',
    sidebarKey: 'aht',
    channel: 'stable',
    packId: 'a-hard-time-dregora',
    name: 'A Hard Time',
    r2Prefix: '',
    feedPath: 'latest.json',
    githubTagPrefix: 'modpack-stable-v',
    githubAssetPrefix: 'a-hard-time-stable',
    githubPrerelease: false,
    instanceFolderName: 'A Hard Time',
    profileId: 'a-hard-time-dregora',
    profileName: 'A Hard Time'
  }),
  ptb: Object.freeze({
    id: 'ptb',
    sidebarKey: 'ptb',
    channel: 'ptb',
    packId: 'a-hard-time-ptb',
    name: 'A Hard Time PTB',
    r2Prefix: 'ptb',
    feedPath: 'ptb/latest.json',
    githubTagPrefix: 'modpack-ptb-v',
    githubAssetPrefix: 'a-hard-time-ptb',
    githubPrerelease: true,
    instanceFolderName: 'A Hard Time PTB',
    profileId: 'a-hard-time-ptb',
    profileName: 'A Hard Time PTB'
  })
});

export function normalizeReleaseTarget(value = 'stable') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'stable' || normalized === 'aht') return 'stable';
  if (normalized === 'ptb') return 'ptb';
  throw new Error(`Unknown release target: ${value}`);
}

export function releaseTarget(value = 'stable') {
  return TARGETS[normalizeReleaseTarget(value)];
}

export function releaseTargetOutDir(baseOutDir, value = 'stable') {
  const base = path.resolve(String(baseOutDir || '').trim());
  const target = releaseTarget(value);
  return target.r2Prefix ? path.join(base, target.r2Prefix) : base;
}

export function releaseTargetObjectKey(relativePath, value = 'stable') {
  const target = releaseTarget(value);
  const rel = String(relativePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) {
    throw new Error(`Invalid release object path: ${relativePath}`);
  }
  return target.r2Prefix ? `${target.r2Prefix}/${rel}` : rel;
}

export function releaseTargetFeedUrl(stableFeedUrl = '', value = 'stable') {
  const target = releaseTarget(value);
  const raw = String(stableFeedUrl || '').trim();
  if (!raw || target.id === 'stable') return raw;

  try {
    const url = new URL(raw);
    const stablePath = url.pathname
      .replace(/\/ptb\/latest\.json$/i, '/latest.json')
      .replace(/\/+$/, '');
    const rootPath = stablePath.replace(/\/latest\.json$/i, '/');
    url.pathname = `${rootPath.replace(/\/+$/, '')}/${target.feedPath}`.replace(/\/{2,}/g, '/');
    return url.toString();
  } catch {
    const stablePath = path.resolve(raw);
    return path.join(path.dirname(stablePath), target.feedPath);
  }
}

export function releaseTargetBaseUrl(stableFeedUrl = '', value = 'stable') {
  const feedUrl = releaseTargetFeedUrl(stableFeedUrl, value);
  if (!feedUrl) return '';
  try {
    return new URL('.', feedUrl).toString();
  } catch {
    return path.dirname(feedUrl);
  }
}

export function assertReleaseMatchesTarget(latest = {}, value = 'stable') {
  const target = releaseTarget(value);
  if (String(latest.packId || '') !== target.packId) {
    throw new Error(`${target.name} releases must use packId ${target.packId}; received ${latest.packId || 'missing'}.`);
  }
  if (String(latest.channel || '') !== target.channel) {
    throw new Error(`${target.name} releases must use channel ${target.channel}; received ${latest.channel || 'missing'}.`);
  }
  return target;
}

export const releaseTargets = TARGETS;
