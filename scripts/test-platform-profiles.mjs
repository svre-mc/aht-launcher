import {
  defaultInstanceDirForPlatform,
  isMacosPrivacyProtectedPath,
  platformProfile
} from '../src/platformProfile.js';

const windowsDir = defaultInstanceDirForPlatform('win32', {
  SystemDrive: 'C:',
  USERPROFILE: 'C:\\Users\\Player'
});
const macDir = defaultInstanceDirForPlatform('darwin', {
  HOME: '/Users/player'
});
const linuxDir = defaultInstanceDirForPlatform('linux', {
  HOME: '/home/player'
});
const linuxXdgDir = defaultInstanceDirForPlatform('linux', {
  HOME: '/home/player',
  XDG_DATA_HOME: '/mnt/player-data'
});

if (!isMacosPrivacyProtectedPath('/Users/player/Documents/CurseForge', { HOME: '/Users/player' })) {
  throw new Error('macOS Documents paths must be treated as privacy protected during automatic discovery.');
}
if (!isMacosPrivacyProtectedPath('/Volumes/External/Minecraft', { HOME: '/Users/player' })) {
  throw new Error('macOS external volumes must not be probed automatically.');
}
if (isMacosPrivacyProtectedPath('/Users/player/Library/Application Support/minecraft', { HOME: '/Users/player' })) {
  throw new Error('The standard macOS Minecraft support directory must remain available without a Documents permission prompt.');
}

if (windowsDir !== 'C:\\AHT\\A Hard Time') {
  throw new Error(`Unexpected Windows instance dir: ${windowsDir}`);
}
if (macDir !== '/Users/player/Library/Application Support/A Hard Time/Instance') {
  throw new Error(`Unexpected macOS instance dir: ${macDir}`);
}
if (linuxDir !== '/home/player/.local/share/A Hard Time/Instance') {
  throw new Error(`Unexpected Linux instance dir: ${linuxDir}`);
}
if (linuxXdgDir !== '/mnt/player-data/A Hard Time/Instance') {
  throw new Error(`Unexpected Linux XDG instance dir: ${linuxXdgDir}`);
}

const profiles = {
  windows: platformProfile('win32', { SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\Player' }),
  macos: platformProfile('darwin', { HOME: '/Users/player' }),
  linux: platformProfile('linux', { HOME: '/home/player' })
};

if (profiles.windows.displayName !== 'Windows 10/11' || !profiles.windows.packageTarget.includes('NSIS')) {
  throw new Error(`Windows profile is not tailored: ${JSON.stringify(profiles.windows)}`);
}
if (profiles.macos.displayName !== 'macOS' || !profiles.macos.packageTarget.includes('DMG')) {
  throw new Error(`macOS profile is not tailored: ${JSON.stringify(profiles.macos)}`);
}
if (profiles.linux.displayName !== 'Linux x64' || !profiles.linux.packageTarget.includes('AppImage')) {
  throw new Error(`Linux profile is not tailored: ${JSON.stringify(profiles.linux)}`);
}

function assertUnsupported(fn, label) {
  try {
    fn();
  } catch (error) {
    if (/Unsupported AHT launcher platform/.test(error.message)) return;
    throw new Error(`${label} threw the wrong error: ${error.message}`);
  }
  throw new Error(`${label} accepted an unsupported platform.`);
}

assertUnsupported(() => defaultInstanceDirForPlatform('freebsd', { HOME: '/home/player' }), 'freebsd instance dir');
assertUnsupported(() => platformProfile('freebsd', { HOME: '/home/player' }), 'freebsd platform profile');

console.log(JSON.stringify({
  ok: true,
  instanceDirs: {
    windows: windowsDir,
    macos: macDir,
    linux: linuxDir,
    linuxXdg: linuxXdgDir
  },
  profiles
}, null, 2));
