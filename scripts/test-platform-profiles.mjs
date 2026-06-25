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
const ubuntuDir = defaultInstanceDirForPlatform('linux', {
  HOME: '/home/player'
});
const ubuntuXdgDir = defaultInstanceDirForPlatform('linux', {
  HOME: '/home/player',
  XDG_DATA_HOME: '/home/player/.var/app/aht/data'
});

if (windowsDir !== 'C:\\AHT\\A Hard Time') {
  throw new Error(`Unexpected Windows instance dir: ${windowsDir}`);
}
if (macDir !== '/Users/player/Library/Application Support/A Hard Time/Instance') {
  throw new Error(`Unexpected macOS instance dir: ${macDir}`);
}
if (ubuntuDir !== '/home/player/.local/share/aht-launcher/A Hard Time') {
  throw new Error(`Unexpected Ubuntu instance dir: ${ubuntuDir}`);
}
if (ubuntuXdgDir !== '/home/player/.var/app/aht/data/aht-launcher/A Hard Time') {
  throw new Error(`Unexpected XDG Ubuntu instance dir: ${ubuntuXdgDir}`);
}

const profiles = {
  windows: platformProfile('win32', { SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\Player' }),
  macos: platformProfile('darwin', { HOME: '/Users/player' }),
  ubuntu: platformProfile('linux', { HOME: '/home/player' })
};

if (profiles.windows.displayName !== 'Windows 10/11' || !profiles.windows.packageTarget.includes('NSIS')) {
  throw new Error(`Windows profile is not tailored: ${JSON.stringify(profiles.windows)}`);
}
if (profiles.macos.displayName !== 'macOS' || !profiles.macos.packageTarget.includes('DMG')) {
  throw new Error(`macOS profile is not tailored: ${JSON.stringify(profiles.macos)}`);
}
if (profiles.ubuntu.displayName !== 'Ubuntu/Linux' || !profiles.ubuntu.packageTarget.includes('.deb')) {
  throw new Error(`Ubuntu profile is not tailored: ${JSON.stringify(profiles.ubuntu)}`);
}

console.log(JSON.stringify({
  ok: true,
  instanceDirs: {
    windows: windowsDir,
    macos: macDir,
    ubuntu: ubuntuDir,
    ubuntuXdg: ubuntuXdgDir
  },
  profiles
}, null, 2));
