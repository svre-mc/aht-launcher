// Both names are used by deployed AHT packs. Never treat a sources/dev archive
// as the runtime lock or inject a second lock beside a renamed installed JAR.
export const VERSION_LOCK_JAR_PATTERN = /^aht[- ]version[- ]lock-(?!.*-(?:sources|javadoc|dev|deobf)\.jar$)[^/\\]+\.jar$/i;

export function isVersionLockJarPath(value) {
  const name = String(value || '').replaceAll('\\', '/').split('/').pop();
  return VERSION_LOCK_JAR_PATTERN.test(name);
}

// Runtime integrity policies include paths, not only hashes. Updating the bytes
// must not rename a mod already installed under the pack's canonical filename.
export function versionLockClientPath(existingPaths, fallback) {
  const paths = [...existingPaths];
  return paths.find(value => value.endsWith('/AHT Version Lock-1.1.1.jar'))
    || paths.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0]
    || fallback;
}
