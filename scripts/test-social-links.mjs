import assert from 'node:assert/strict';
import {
  createLauncherSocialLinksManifest,
  DEFAULT_LAUNCHER_SOCIAL_LINKS,
  LAUNCHER_SOCIAL_LINKS_OBJECT_KEY,
  LAUNCHER_SOCIAL_LINKS_SCHEMA,
  normalizeLauncherSocialLinks,
  parseLauncherSocialLinksManifest,
  validateLauncherSocialLinks
} from '../src/socialLinks.js';

assert.deepEqual(normalizeLauncherSocialLinks({}), DEFAULT_LAUNCHER_SOCIAL_LINKS);
assert.equal(LAUNCHER_SOCIAL_LINKS_OBJECT_KEY, 'update-media/launcher-social-links.json');

const custom = normalizeLauncherSocialLinks({
  discord: 'https://discord.gg/AUVMekfNfq',
  youtube: 'https://youtube.com/@AHardTime',
  tiktok: 'https://tiktok.com/@ahardtimefr',
  forum: 'https://www.ahardtime.net/forum/community'
});
assert.equal(custom.discord, 'https://discord.gg/AUVMekfNfq');
assert.equal(custom.youtube, 'https://youtube.com/@AHardTime');
assert.equal(custom.tiktok, 'https://tiktok.com/@ahardtimefr');
assert.equal(custom.forum, 'https://www.ahardtime.net/forum/community');

for (const invalid of [
  { discord: 'http://discord.com/invite/AUVMekfNfq' },
  { discord: 'https://discord.com/channels/123/456' },
  { youtube: 'https://example.com/@AHardTime' },
  { tiktok: 'https://evil.example/@ahardtimefr' },
  { forum: 'https://ahardtime.net/shop' },
  { forum: 'javascript:alert(1)' }
]) {
  const result = validateLauncherSocialLinks({ ...DEFAULT_LAUNCHER_SOCIAL_LINKS, ...invalid });
  assert.equal(result.ok, false, `Unsafe social link was accepted: ${JSON.stringify(invalid)}`);
  assert.deepEqual(result.links, DEFAULT_LAUNCHER_SOCIAL_LINKS, 'Invalid social data must fail closed to the complete safe default set.');
}

const manifest = createLauncherSocialLinksManifest(custom, {
  publishedAt: '2026-08-31T12:00:00.000Z',
  publishedBy: 'admin'
});
assert.equal(manifest.schema, LAUNCHER_SOCIAL_LINKS_SCHEMA);
assert.equal(manifest.publishedBy, 'admin');
assert.deepEqual(parseLauncherSocialLinksManifest(manifest).links, custom);
assert.throws(
  () => parseLauncherSocialLinksManifest({ ...manifest, schema: 'unsupported/v2' }),
  /schema is not supported/
);

console.log(JSON.stringify({
  defaults: DEFAULT_LAUNCHER_SOCIAL_LINKS,
  objectKey: LAUNCHER_SOCIAL_LINKS_OBJECT_KEY,
  approvedCustomLinks: custom,
  unsafeSchemesAndHostsRejected: true
}, null, 2));
