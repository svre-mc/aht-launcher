const { launcherReleaseVersion, regularPlayerConfig } = require('./electron-builder.common.cjs');

const playerConfig = regularPlayerConfig({
    productName: 'A Hard Time Launcher Windows',
    output: 'release-builds/windows',
    target: 'windows'
  });
module.exports = {
  ...playerConfig,
  // Hash/size/version only. Phoenix itself remains a separate consented download.
  files: [...playerConfig.files, { from: 'build/native-guard', to: 'config/phoenix', filter: ['manifest.json'] }],
  beforePack: async () => { await import('../scripts/prepare-bundled-java.mjs'); },
  extraResources: [{ from: 'build/runtime/java', to: 'java', filter: ['*.zip', 'NOTICE.txt'] }],
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      },
      {
        target: 'zip',
        arch: ['x64']
      }
    ],
    artifactName: `AHT-Launcher-Windows-10-11-${launcherReleaseVersion}.\${ext}`
  },
  nsis: {
    // The public installer embeds a normal ZIP payload instead of a solid 7z
    // overlay. In-app updates already use the separate staged ZIP artifact.
    differentialPackage: false,
    useZip: true,
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    include: 'build/windows-installer.nsh',
    license: 'legal/TERMS_OF_SERVICE.txt',
    shortcutName: 'AHT Launcher',
    uninstallDisplayName: 'A Hard Time Launcher'
  }
};
