// Both names are used by deployed AHT packs. Never treat a sources/dev archive
// as the runtime lock or inject a second lock beside a renamed installed JAR.
export const VERSION_LOCK_JAR_PATTERN = /^aht[- ]version[- ]lock-(?!.*-(?:sources|javadoc|dev|deobf)\.jar$)[^/\\]+\.jar$/i;

export function isVersionLockJarPath(value) {
  const name = String(value || '').replaceAll('\\', '/').split('/').pop();
  return VERSION_LOCK_JAR_PATTERN.test(name);
}
