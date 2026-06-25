const files = [
  'build/**/*',
  'pack-fixes/**/*',
  'desktop/**/*',
  'src/**/*',
  'public/**/*',
  'cloudflare/**/*',
  'config/**/*',
  'server-lock-mod/build/libs/aht-version-lock-*.jar',
  '!server-lock-mod/build/libs/*-sources.jar',
  'server-lock-mod/README.md',
  'package.json',
  'README.md'
];

const asarUnpack = [
  'server-lock-mod/build/libs/aht-version-lock-*.jar',
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
    files,
    asarUnpack,
    extraMetadata: {
      ahtLauncherTarget: target,
      ahtLauncherMode: 'player'
    }
  };
}

module.exports = {
  regularPlayerConfig
};
