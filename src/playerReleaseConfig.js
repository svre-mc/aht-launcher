// Public player builds use their shipped release addresses. Reinstalling the
// application preserves user settings, including empty or obsolete old feeds.
export function restorePlayerReleaseFeeds(config, defaults) {
  let changed = false;
  const restore = (target, source, key) => {
    const value = String(source?.[key] || '').trim();
    if (!/^https?:\/\//i.test(value) || target[key] === value) return;
    target[key] = value;
    changed = true;
  };
  restore(config, defaults, 'latestUrl');
  config.packs ||= {};
  config.packs.ptb ||= {};
  restore(config.packs.ptb, defaults.packs?.ptb, 'latestUrl');
  config.curseforge ||= {};
  restore(config.curseforge, defaults.curseforge, 'proxyBaseUrl');
  return changed;
}
