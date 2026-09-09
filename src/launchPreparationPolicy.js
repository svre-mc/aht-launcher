import { loaderVersionId } from './minecraftLauncherProfile.js';

export function sameInstalledRelease(release, installed) {
  return Boolean(release?.packId && release?.version && installed?.packId && installed?.version
    && String(release.packId) === String(installed.packId)
    && String(release.version) === String(installed.version));
}

// Discovery of a newer release and preparation of the installed release are
// different states. Never use an old/new release's file list for this install.
export function releaseForInstalledPack(installed, ...candidates) {
  return candidates.find(candidate => sameInstalledRelease(candidate, installed)) || installed;
}

export function preparedRuntimeMatchesInstalled(cached, installed) {
  if (!cached) return false;
  if (sameInstalledRelease(cached.installed, installed)) return true;
  const previous = loaderVersionId(cached.installed?.minecraft || cached.latest?.minecraft);
  const current = loaderVersionId(installed?.minecraft);
  return Boolean(previous && current && previous === current);
}

// A previously signed snapshot may save hashing unchanged files after a pack
// update, but only when the newly verified manifest declares identical bytes.
export function matchingManagedFileStates(previous, nextFiles) {
  if (!previous?.complete) return [];
  const files = new Map(previous.managedFiles.map(file => [file.relativePath, file]));
  const states = new Map(previous.fileStates.map(state => [state.path, state]));
  return nextFiles.flatMap(file => {
    const old = files.get(file.relativePath);
    const state = states.get(file.relativePath);
    return old && state && old.sha256 && old.sha256 === file.sha256
      && Number(old.size) === Number(file.size) ? [state] : [];
  });
}
