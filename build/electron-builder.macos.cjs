const { regularPlayerConfig } = require('./electron-builder.common.cjs');

const hasMacSigningCert = Boolean(process.env.CSC_LINK || process.env.CSC_NAME || process.env.APPLE_DEVELOPER_IDENTITY);
const macSigningIdentity = process.env.APPLE_DEVELOPER_IDENTITY || process.env.CSC_NAME;
const hasAppleApiNotarization = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
const hasAppleIdNotarization = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
const hasKeychainNotarization = Boolean(process.env.APPLE_KEYCHAIN && process.env.APPLE_KEYCHAIN_PROFILE);
const hasMacNotarization = hasAppleApiNotarization || hasAppleIdNotarization || hasKeychainNotarization;

module.exports = {
  ...regularPlayerConfig({
    productName: 'A Hard Time Launcher macOS',
    output: 'release-builds/macos',
    target: 'macos'
  }),
  icon: 'build/icon-mac.png',
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      },
      {
        target: 'zip',
        arch: ['x64', 'arm64']
      }
    ],
    category: 'public.app-category.games',
    type: 'distribution',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    ...(hasMacSigningCert
      ? {
          ...(macSigningIdentity ? { identity: macSigningIdentity } : {}),
          notarize: hasMacNotarization
        }
      : {
          identity: null,
          notarize: false
        }),
    artifactName: 'AHT-Launcher-macOS-${arch}-${version}.${ext}'
  },
  dmg: {
    title: 'A Hard Time Launcher'
  }
};
