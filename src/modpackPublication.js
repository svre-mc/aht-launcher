import { assertReleaseMatchesTarget, releaseTarget, releaseTargetObjectKey } from './releaseTargets.js';

export function immutableModpackObject(key = '') {
  return /^(?:ptb\/)?(?:packs|patches|manifests)\/[^/]+\.(?:zip|json)$/.test(key);
}

export function modpackPublicationArtifacts(latest, targetValue = 'stable') {
  assertReleaseMatchesTarget(latest, targetValue);
  const references = [latest.zip, latest.clientManifest, ...(latest.delta ? [latest.delta] : [])];
  return references.map(ref => {
    if (!ref || !/^(?:packs|patches|manifests)\/[^/]+\.(?:zip|json)$/.test(ref.path || '')
        || !Number.isSafeInteger(ref.size) || ref.size <= 0 || !/^[a-f0-9]{64}$/i.test(ref.sha256 || '')) {
      throw new Error('Publication requires complete versioned ZIP, manifest and patch references. The player feed was not changed.');
    }
    return { key: releaseTargetObjectKey(ref.path, targetValue), size: ref.size, sha256: ref.sha256.toLowerCase() };
  });
}

// The caller holds the account's existing writer lock through this whole gate.
// Uploading an object is not evidence that every dependency is publicly usable.
export async function commitModpackPublication({ latest, baseline, target: targetValue,
  readFeed, head, verifyPublic, writeFeed }) {
  const target = releaseTarget(targetValue);
  const artifacts = modpackPublicationArtifacts(latest, target.id);
  const before = await readFeed();
  if (JSON.stringify(before || null) !== JSON.stringify(baseline || null)) {
    throw new Error(`Remote ${target.name} changed during publication; no pointer was overwritten.`);
  }
  for (const artifact of artifacts) {
    const remote = await head(artifact.key);
    if (!remote?.exists || remote.size !== artifact.size || String(remote.sha256 || '').toLowerCase() !== artifact.sha256) {
      throw new Error(`Release artifact is not verified: ${artifact.key}. The player feed was not changed.`);
    }
  }
  await verifyPublic();
  // Include a second check for writers outside this application's lock protocol.
  if (JSON.stringify(await readFeed() || null) !== JSON.stringify(before || null)) {
    throw new Error(`Remote ${target.name} changed during verification; no pointer was overwritten.`);
  }
  await writeFeed(latest);
  if (JSON.stringify(await readFeed()) !== JSON.stringify(latest)) {
    throw new Error('Committed player feed failed readback verification.');
  }
  return { committed: true, artifacts: artifacts.length };
}
