const { launcherReleaseVersion, regularPlayerConfig } = require('./electron-builder.common.cjs');

module.exports = {
  ...regularPlayerConfig({
    productName: 'A Hard Time Launcher Windows',
    output: 'release-builds/windows',
    target: 'windows'
  }),
  beforePack: async () => { await import('../scripts/prepare-bundled-java.mjs'); await import('../scripts/build-native-guard.mjs'); },
  afterSign: async (context) => {
    // Authenticode changes the helper bytes. Bind the manifest to the signed file.
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const directory = path.join(context.appOutDir, 'resources', 'native-guard');
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const bytes = await fs.readFile(path.join(directory, 'AHT Runtime Guard.exe'));
    manifest.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    manifest.bytes = bytes.length;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  },
  extraResources: [{ from: 'build/runtime/java', to: 'java', filter: ['*.zip', 'NOTICE.txt'] },
    { from: 'build/native-guard', to: 'native-guard', filter: ['AHT Runtime Guard.exe','manifest.json','NOTICE.txt'] }],
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
