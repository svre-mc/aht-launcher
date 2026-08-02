import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function forgeFixtureBytes(options = {}) {
  return Buffer.isBuffer(options.artifactBytes)
    ? options.artifactBytes
    : Buffer.from(options.artifactBytes || 'AHT Forge fixture\n', 'utf8');
}

export function forgeVersionJsonFixture(options = {}) {
  const {
    versionId = '1.12.2-forge-14.23.5.2860',
    minecraftVersion = '1.12.2',
    forgeVersion = '14.23.5.2860'
  } = options;
  const artifactBytes = forgeFixtureBytes(options);
  const artifactPath = `net/minecraftforge/forge/${minecraftVersion}-${forgeVersion}/forge-${minecraftVersion}-${forgeVersion}.jar`;
  return {
    id: versionId,
    type: 'release',
    inheritsFrom: minecraftVersion,
    minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker --versionType Forge',
    libraries: [
      {
        name: `net.minecraftforge:forge:${minecraftVersion}-${forgeVersion}`,
        downloads: {
          artifact: {
            path: artifactPath,
            sha1: crypto.createHash('sha1').update(artifactBytes).digest('hex'),
            size: artifactBytes.length
          }
        }
      }
    ]
  };
}

export async function writeForgeInstallationFixture(rootDir, options = {}) {
  const metadata = forgeVersionJsonFixture(options);
  const versionDir = path.join(rootDir, 'versions', metadata.id);
  const versionJson = path.join(versionDir, `${metadata.id}.json`);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(versionJson, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  if (options.includeLibrary !== false) {
    const artifactPath = metadata.libraries[0].downloads.artifact.path;
    const libraryFile = path.join(rootDir, 'libraries', artifactPath);
    await fs.mkdir(path.dirname(libraryFile), { recursive: true });
    await fs.writeFile(libraryFile, forgeFixtureBytes(options));
  }
  return { metadata, versionJson };
}
