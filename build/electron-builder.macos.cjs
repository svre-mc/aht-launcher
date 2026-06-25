const { regularPlayerConfig } = require('./electron-builder.common.cjs');

module.exports = {
  ...regularPlayerConfig({
    productName: 'A Hard Time Launcher macOS',
    output: 'release-builds/macos',
    target: 'macos'
  }),
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      }
    ],
    category: 'public.app-category.games',
    artifactName: 'AHT-Launcher-macOS-${arch}-${version}.${ext}'
  },
  dmg: {
    title: 'A Hard Time Launcher'
  }
};
