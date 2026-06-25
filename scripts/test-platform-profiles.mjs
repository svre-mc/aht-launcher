import {
  defaultInstanceDirForPlatform,
  platformProfile
} from '../src/platformProfile.js';

const windowsDir = defaultInstanceDirForPlatform('win32', {
  SystemDrive: 'C:',
  USERPROFILE: 'C:\\Users\\Player'
});
const macDir = defaultInstanceDirForPlatform('darwin', {
  HOME: '/Users/player'
});

if (windowsDir !== 'C:\\AHT\\A Hard Time') {
  throw new Error(`Unexpected Windows instance dir: ${windowsDir}`);
}
if (macDir !== '/Users/player/Library/Application Support/A Hard Time/Instance') {
  throw new Error(`Unexpected macOS instance dir: ${macDir}`);
}

const profiles = {
  windows: platformProfile('win32', { SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\Player' }),
  macos: platformProfile('darwin', { HOME: '/Users/player' })
};

if (profiles.windows.displayName !== 'Windows 10/11' || !profiles.windows.packageTarget.includes('NSIS')) {
  throw new Error(`Windows profile is not tailored: ${JSON.stringify(profiles.windows)}`);
}
if (profiles.macos.displayName !== 'macOS' || !profiles.macos.packageTarget.includes('DMG')) {
  throw new Error(`macOS profile is not tailored: ${JSON.stringify(profiles.macos)}`);
}

console.log(JSON.stringify({
  ok: true,
  instanceDirs: {
    windows: windowsDir,
    macos: macDir
  },
  profiles
}, null, 2));
