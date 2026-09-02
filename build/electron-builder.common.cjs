const developerOnlySourceFiles = [
  'src/releaseBuilder.js',
  'src/clientModpackZip.js',
  'src/serverTransfer.js',
  'src/githubActions.js',
  'src/githubModpackRelease.js',
  'src/r2DirectUpload.js'
];
const developerOnlyNodeModules = [
  'node_modules/@aws-sdk/**',
  'node_modules/@smithy/**',
  'node_modules/@aws-crypto/**',
  'node_modules/ssh2/**',
  'node_modules/yazl/**'
];
const packageMetadata = require('../package.json');
const launcherReleaseVersion = String(packageMetadata.ahtLauncherVersion || packageMetadata.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(launcherReleaseVersion)) {
  throw new Error('package.json ahtLauncherVersion must be a numeric launcher release version.');
}

const files = [
  // Installer/build sources are not runtime payload. Shipping them inside
  // app.asar adds avoidable process/registry signatures for AV scanners.
  'build/icon.png',
  'pack-fixes/**/*',
  'desktop/**/*',
  'src/**/*',
  ...developerOnlySourceFiles.map((file) => `!${file}`),
  ...developerOnlyNodeModules.map((folder) => `!${folder}`),
  'config/app.defaults.json',
  'legal/**/*',
  'package.json',
  'README.md'
];

const asarUnpack = [
  'pack-fixes/*.jar'
];

function regularPlayerConfig({ productName, output, target }) {
  return {
    appId: 'com.ahardtime.launcher',
    productName,
    copyright: 'Copyright (c) 2026 au Savant',
    icon: 'build/icon',
    directories: {
      output
    },
    npmRebuild: false,
    files,
    asarUnpack,
    extraMetadata: {
      ahtLauncherTarget: target,
      ahtLauncherMode: 'player',
      ahtLauncherVersion: launcherReleaseVersion
    }
  };
}

module.exports = {
  regularPlayerConfig,
  launcherReleaseVersion,
  developerOnlySourceFiles,
  developerOnlyNodeModules
};
