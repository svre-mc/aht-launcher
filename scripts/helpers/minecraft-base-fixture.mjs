import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function descriptor(url, bytes, artifactPath = '') {
  return {
    ...(artifactPath ? { path: artifactPath } : {}),
    url,
    sha1: crypto.createHash('sha1').update(bytes).digest('hex'),
    size: bytes.length
  };
}

export async function writeMinecraftBaseFixture(rootDir, { minecraftVersion = '1.12.2' } = {}) {
  const fixtureDir = path.resolve(rootDir);
  const clientBytes = Buffer.from(`AHT Minecraft ${minecraftVersion} client fixture\n`, 'utf8');
  const libraryBytes = Buffer.from(`AHT Minecraft ${minecraftVersion} library fixture\n`, 'utf8');
  const assetIndexBytes = Buffer.from(`${JSON.stringify({ objects: {} }, null, 2)}\n`, 'utf8');
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(path.join(fixtureDir, 'client.jar'), clientBytes);
  await fs.writeFile(path.join(fixtureDir, 'base-library.jar'), libraryBytes);
  await fs.writeFile(path.join(fixtureDir, 'asset-index.json'), assetIndexBytes);
  const metadata = {
    id: minecraftVersion,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: '--username ${auth_player_name} --version ${version_name}',
    assetIndex: {
      id: '1.12',
      ...descriptor('asset-index.json', assetIndexBytes)
    },
    downloads: {
      client: descriptor('client.jar', clientBytes)
    },
    libraries: [{
      name: 'example:aht-base-fixture:1',
      downloads: {
        artifact: descriptor(
          'base-library.jar',
          libraryBytes,
          'example/aht-base-fixture/1/aht-base-fixture-1.jar'
        )
      }
    }]
  };
  await fs.writeFile(
    path.join(fixtureDir, `${minecraftVersion}.json`),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8'
  );
  return { fixtureDir, metadata, clientBytes, libraryBytes, assetIndexBytes };
}
