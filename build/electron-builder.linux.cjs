const { launcherReleaseVersion, regularPlayerConfig } = require('./electron-builder.common.cjs');

module.exports = {
  ...regularPlayerConfig({
    productName: 'A Hard Time Launcher Linux',
    output: 'release-builds/linux',
    target: 'linux'
  }),
  executableName: 'a-hard-time-launcher',
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
    artifactName: `AHT-Launcher-Linux-x64-${launcherReleaseVersion}.\${ext}`,
    category: 'Game',
    synopsis: 'A Hard Time Minecraft modpack launcher',
    description: 'Install, update, repair, and launch the A Hard Time Minecraft modpack.',
    maintainer: 'au Savant <launcher@aht.local>',
    vendor: 'A Hard Time'
  }
};
