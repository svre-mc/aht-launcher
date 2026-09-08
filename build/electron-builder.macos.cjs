const { launcherReleaseVersion, regularPlayerConfig } = require('./electron-builder.common.cjs');

module.exports = {
  ...regularPlayerConfig({
    productName: 'A Hard Time Launcher macOS',
    output: 'release-builds/macos',
    target: 'macos'
  }),
  forceCodeSigning: false,
  icon: 'build/icon-mac.png',
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['universal']
      },
      {
        target: 'zip',
        arch: ['universal']
      }
    ],
    category: 'public.app-category.games',
    type: 'distribution',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    identity: null,
    notarize: false,
    artifactName: `AHT-Launcher-macOS-universal-${launcherReleaseVersion}.\${ext}`
  },
  dmg: {
    title: 'A Hard Time Launcher',
    license: 'legal/TERMS_OF_SERVICE.txt'
  }
};
