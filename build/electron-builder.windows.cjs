const { regularPlayerConfig } = require('./electron-builder.common.cjs');

module.exports = {
  ...regularPlayerConfig({
    productName: 'A Hard Time Launcher Windows',
    output: 'release-builds/windows',
    target: 'windows'
  }),
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      }
    ],
    artifactName: 'AHT-Launcher-Windows-10-11-${version}.${ext}'
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    include: 'build/windows-installer.nsh',
    shortcutName: 'AHT Launcher',
    uninstallDisplayName: 'A Hard Time Launcher'
  }
};
