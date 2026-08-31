import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  captureManagedIntegrityFingerprint,
  launchCriticalManagedFiles,
  verifyManagedIntegritySnapshot
} from '../src/localChanges.js';
import {
  preparedRuntimeSnapshotCoversFiles,
  verifyPreparedRuntimeSnapshot
} from '../src/preparedRuntimeIntegrity.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-prepared-managed-snapshot-'));

async function write(relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

try {
  const contents = {
    'config/player-owned.cfg': 'player-setting=true\n',
    'mods/aht-critical.jar': 'trusted-mod-bytes',
    'resources/contenttweaker/sounds.json': '{"trusted":true}',
    'scripts/aht-critical.zs': 'print("trusted");\n'
  };
  for (const [relativePath, content] of Object.entries(contents)) await write(relativePath, content);
  const managedFiles = Object.entries(contents).map(([relativePath, content]) => ({
    relativePath,
    source: 'verified-client-manifest',
    sha256: sha256(content)
  }));
  const critical = launchCriticalManagedFiles(managedFiles);
  assert.deepEqual(
    critical.map((item) => item.relativePath).sort(),
    ['mods/aht-critical.jar', 'resources/contenttweaker/sounds.json', 'scripts/aht-critical.zs'],
    'Player-owned config files entered the launch-critical snapshot.'
  );

  const initial = await captureManagedIntegrityFingerprint(root, {
    managedFiles: critical,
    ignoreLocalManaged: true,
    includeFileStates: true
  });
  assert(initial.pathsValid && initial.fileStates.length === critical.length, 'Initial launch-critical fingerprint was incomplete.');
  const cachedAt = new Date().toISOString();

  await write('config/player-owned.cfg', 'player-setting=false\n');
  const resourcePath = path.join(root, 'resources', 'contenttweaker', 'sounds.json');
  const touchedTime = new Date(Date.now() + 2_000);
  await fs.utimes(resourcePath, touchedTime, touchedTime);
  const metadataOnly = await verifyManagedIntegritySnapshot(root, {
    managedFiles,
    ignoreLocalManaged: true,
    previousFileStates: initial.fileStates,
    legacySince: cachedAt
  });
  assert(metadataOnly.valid, `Normal config writes or metadata-only touches invalidated preparation: ${JSON.stringify(metadataOnly.issues)}`);
  assert.equal(metadataOnly.hashedFiles, 1, 'Metadata-only revalidation did not hash only the touched critical file.');
  const watcherNotification = await verifyManagedIntegritySnapshot(root, {
    managedFiles,
    ignoreLocalManaged: true,
    previousFileStates: metadataOnly.fileStates,
    forcePaths: ['resources'],
    onlyForced: true
  });
  assert(watcherNotification.valid, `A same-byte watcher notification was treated as corruption: ${JSON.stringify(watcherNotification.issues)}`);
  assert.equal(watcherNotification.hashedFiles, 1, 'A parent-directory watcher notification did not hash the protected descendant.');

  await write('resources/contenttweaker/sounds.json', '{"trusted":false}');
  const changedCritical = await verifyManagedIntegritySnapshot(root, {
    managedFiles,
    ignoreLocalManaged: true,
    previousFileStates: initial.fileStates,
    legacySince: cachedAt
  });
  assert(!changedCritical.valid, 'A content change to a launch-critical resource was trusted.');
  assert(changedCritical.issues.some((item) => item.path === 'resources/contenttweaker/sounds.json' && item.reason === 'content-changed'));
  await write('resources/contenttweaker/sounds.json', contents['resources/contenttweaker/sounds.json']);

  await write('mods/unmanaged-extra.jar', 'untrusted-extra-mod');
  const extraMod = await verifyManagedIntegritySnapshot(root, {
    managedFiles,
    ignoreLocalManaged: true,
    previousFileStates: initial.fileStates,
    legacySince: cachedAt,
    forcePaths: ['mods'],
    onlyForced: true
  });
  assert(!extraMod.valid, 'An extra unmanaged mod did not invalidate preparation.');
  await fs.rm(path.join(root, 'mods', 'unmanaged-extra.jar'), { force: true });

  const unmanagedLaunchContent = [
    ['fancymenu_data', 'unmanaged-layout.json'],
    ['resourcepacks', 'unmanaged-pack.zip'],
    ['resources', 'unmanaged-resource.json'],
    ['scripts', 'unmanaged-script.zs'],
    ['structures', 'unmanaged-structure.nbt']
  ];
  for (const [contentRoot, fileName] of unmanagedLaunchContent) {
    const relativePath = `${contentRoot}/${fileName}`;
    await write(relativePath, `untrusted-${contentRoot}`);
    const extraContent = await verifyManagedIntegritySnapshot(root, {
      managedFiles,
      ignoreLocalManaged: true,
      previousFileStates: initial.fileStates,
      forcePaths: [contentRoot],
      onlyForced: true
    });
    assert(!extraContent.valid, `An unmanaged ${contentRoot} file did not invalidate preparation.`);
    assert(extraContent.issues.some((item) => item.reason === 'managed-path-set-changed'));
    await fs.rm(path.join(root, ...relativePath.split('/')), { force: true });
  }

  await write('config/player-added.cfg', 'player-owned=true\n');
  await write('options.txt', 'fov:1.0\n');
  const mutablePlayerFiles = await verifyManagedIntegritySnapshot(root, {
    managedFiles,
    ignoreLocalManaged: true,
    previousFileStates: initial.fileStates
  });
  assert(mutablePlayerFiles.valid, `Allowed config/options changes invalidated preparation: ${JSON.stringify(mutablePlayerFiles.issues)}`);

  const legacyBaseline = await captureManagedIntegrityFingerprint(root, {
    managedFiles: critical,
    ignoreLocalManaged: true,
    includeFileStates: true
  });
  const legacyCachedAt = new Date().toISOString();
  const legacyTouchedTime = new Date(Date.now() + 4_000);
  await fs.utimes(resourcePath, legacyTouchedTime, legacyTouchedTime);
  await write('config/player-owned.cfg', 'player-setting=custom\n');
  const migrated = await verifyManagedIntegritySnapshot(root, {
    managedFiles,
    ignoreLocalManaged: true,
    previousFileStates: [],
    legacySince: legacyCachedAt
  });
  assert(migrated.valid, `A legacy signed snapshot could not migrate after normal game writes: ${JSON.stringify(migrated.issues)}`);
  assert(migrated.hashedFiles >= 1, 'Legacy migration did not re-hash critical files changed after its signed cutoff.');
  assert.equal(migrated.fingerprint.schemaVersion, legacyBaseline.schemaVersion);

  const runtimeDir = path.join(root, 'minecraft-runtime');
  const runtimeJar = await write('minecraft-runtime/versions/1.12.2/1.12.2.jar', 'trusted-minecraft-bytes');
  const runtimeLibrary = await write('minecraft-runtime/libraries/forge-library.jar', 'trusted-forge-library-bytes');
  const runtimeFiles = [runtimeJar, runtimeLibrary];
  const runtimeInitial = await verifyPreparedRuntimeSnapshot(runtimeFiles);
  assert(runtimeInitial.valid, `Initial runtime content snapshot failed: ${JSON.stringify(runtimeInitial.issues)}`);
  assert.equal(runtimeInitial.hashedFiles, runtimeFiles.length, 'Initial runtime snapshot did not hash every file.');
  assert(preparedRuntimeSnapshotCoversFiles(runtimeInitial, runtimeFiles), 'Runtime snapshot did not cover its exact path set.');

  const runtimeStable = await verifyPreparedRuntimeSnapshot(runtimeFiles, {
    previousFileStates: runtimeInitial.fileStates
  });
  assert(runtimeStable.valid, `Unchanged runtime files failed verification: ${JSON.stringify(runtimeStable.issues)}`);
  assert.equal(runtimeStable.hashedFiles, 0, 'Unchanged runtime files were unnecessarily rehashed.');

  const runtimeTouchedTime = new Date(Date.now() + 8_000);
  await fs.utimes(runtimeJar, runtimeTouchedTime, runtimeTouchedTime);
  const runtimeMetadataOnly = await verifyPreparedRuntimeSnapshot(runtimeFiles, {
    previousFileStates: runtimeStable.fileStates
  });
  assert(runtimeMetadataOnly.valid, `Metadata-only runtime change was treated as corruption: ${JSON.stringify(runtimeMetadataOnly.issues)}`);
  assert.equal(runtimeMetadataOnly.hashedFiles, 1, 'Metadata-only runtime change did not hash exactly the touched file.');
  assert.equal(runtimeMetadataOnly.fingerprint.digest, runtimeInitial.fingerprint.digest, 'Metadata-only runtime change altered the content fingerprint.');

  await fs.writeFile(runtimeJar, 'trusted-minecraft-bytes', 'utf8');
  const runtimeSameByteRewrite = await verifyPreparedRuntimeSnapshot(runtimeFiles, {
    previousFileStates: runtimeMetadataOnly.fileStates
  });
  assert(runtimeSameByteRewrite.valid, `Same-byte runtime rewrite was treated as corruption: ${JSON.stringify(runtimeSameByteRewrite.issues)}`);
  assert.equal(runtimeSameByteRewrite.fingerprint.digest, runtimeInitial.fingerprint.digest, 'Same-byte runtime rewrite altered the content fingerprint.');

  await fs.writeFile(runtimeJar, 'changed-minecraft-bytes', 'utf8');
  const runtimeChanged = await verifyPreparedRuntimeSnapshot(runtimeFiles, {
    previousFileStates: runtimeSameByteRewrite.fileStates
  });
  assert(!runtimeChanged.valid, 'Changed Minecraft runtime bytes passed the trusted snapshot.');
  assert(runtimeChanged.issues.some((issue) => issue.path === runtimeJar && issue.reason === 'content-changed'));

  await fs.rm(runtimeLibrary, { force: true });
  const runtimeMissing = await verifyPreparedRuntimeSnapshot(runtimeFiles, {
    previousFileStates: runtimeSameByteRewrite.fileStates
  });
  assert(!runtimeMissing.valid, 'A missing Forge library passed the trusted runtime snapshot.');
  assert(runtimeMissing.issues.some((issue) => issue.path === runtimeLibrary && issue.reason === 'missing'));
  assert(path.dirname(runtimeJar).startsWith(runtimeDir), 'Runtime fixture escaped its owned temporary root.');

  console.log(JSON.stringify({
    criticalFiles: critical.length,
    mutableConfigExcluded: true,
    metadataOnlyTouchAccepted: true,
    sameByteWatcherNotificationAccepted: true,
    changedCriticalContentRejected: true,
    extraModRejected: true,
    extraLaunchContentRootsRejected: unmanagedLaunchContent.length,
    mutableConfigAndOptionsAccepted: true,
    legacySnapshotMigrated: true,
    runtimeMetadataOnlyAccepted: true,
    runtimeSameByteRewriteAccepted: true,
    runtimeContentChangeRejected: true,
    runtimeMissingFileRejected: true
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
