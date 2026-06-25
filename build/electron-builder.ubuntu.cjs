const { regularPlayerConfig } = require('./electron-builder.common.cjs');

module.exports = {
  ...regularPlayerConfig({
    productName: 'A Hard Time Launcher Ubuntu',
    output: 'release-builds/ubuntu',
    target: 'ubuntu-linux'
  }),
  linux: {
    target: [
      {
        target: 'AppImage',
        arch: ['x64']
      },
      {
        target: 'deb',
        arch: ['x64']
      }
    ],
    category: 'Game',
    executableName: 'aht-launcher',
    maintainer: 'A Hard Time',
    artifactName: 'AHT-Launcher-Ubuntu-${version}-x64.${ext}'
  },
  deb: {
    packageName: 'aht-launcher'
  }
};
