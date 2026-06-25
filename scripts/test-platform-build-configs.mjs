import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const windowsInstallerInclude = fs.readFileSync(new URL('../build/windows-installer.nsh', import.meta.url), 'utf8');
const rendererApp = fs.readFileSync(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');

const configs = {
  windows: require('../build/electron-builder.windows.cjs'),
  macos: require('../build/electron-builder.macos.cjs'),
  ubuntu: require('../build/electron-builder.ubuntu.cjs')
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(configs.windows.productName === 'A Hard Time Launcher Windows', 'Windows product name is not tailored.');
assert(configs.windows.directories?.output === 'release-builds/windows', 'Windows output folder is wrong.');
assert(configs.windows.win?.artifactName?.includes('Windows-10-11'), 'Windows artifact name should target Windows 10/11.');
assert(configs.windows.win?.target?.[0]?.target === 'nsis', 'Windows regular launcher must build NSIS.');
assert(configs.windows.nsis?.oneClick === false, 'Windows installer must show installer options.');
assert(configs.windows.nsis?.createDesktopShortcut === true, 'Windows desktop shortcut should be checked by default.');
assert(configs.windows.nsis?.createStartMenuShortcut === true, 'Windows Start Menu shortcut should be enabled.');
assert(configs.windows.nsis?.include === 'build/windows-installer.nsh', 'Windows installer must include the shortcut options page.');
assert(windowsInstallerInclude.includes('Create a desktop shortcut'), 'Windows installer include must expose the desktop shortcut option.');
assert(windowsInstallerInclude.includes('AHT Developer Launcher.lnk'), 'Windows installer must create a developer launcher shortcut.');
assert(windowsInstallerInclude.includes('"--developer"'), 'Developer launcher shortcut must pass --developer.');
assert(!rendererApp.includes('update.updateRequired && !status?.developerMode'), 'Developer mode must not suppress required launcher update overlay.');
assert(!rendererApp.includes('status.launcherUpdate?.updateRequired && !status.developerMode'), 'Developer mode must not bypass launcher update gating.');

assert(configs.macos.productName === 'A Hard Time Launcher macOS', 'macOS product name is not tailored.');
assert(configs.macos.directories?.output === 'release-builds/macos', 'macOS output folder is wrong.');
assert(configs.macos.mac?.target?.[0]?.target === 'dmg', 'macOS regular launcher must build DMG.');
assert(configs.macos.mac?.target?.[0]?.arch?.includes('arm64'), 'macOS regular launcher should include Apple Silicon.');
assert(configs.macos.mac?.target?.[0]?.arch?.includes('x64'), 'macOS regular launcher should include Intel.');

assert(configs.ubuntu.productName === 'A Hard Time Launcher Ubuntu', 'Ubuntu product name is not tailored.');
assert(configs.ubuntu.directories?.output === 'release-builds/ubuntu', 'Ubuntu output folder is wrong.');
assert(configs.ubuntu.linux?.executableName === 'aht-launcher', 'Ubuntu executable name should be Linux-safe.');
assert(configs.ubuntu.linux?.target?.some((item) => item.target === 'AppImage'), 'Ubuntu regular launcher must build AppImage.');
assert(configs.ubuntu.linux?.target?.some((item) => item.target === 'deb'), 'Ubuntu regular launcher must build .deb.');
assert(configs.ubuntu.deb?.packageName === 'aht-launcher', 'Ubuntu .deb package name is wrong.');

assert(packageJson.scripts['dist:regular:windows']?.includes('--win'), 'Windows regular script must force --win.');
assert(packageJson.scripts['dist:regular:macos']?.includes('--mac'), 'macOS regular script must force --mac.');
assert(packageJson.scripts['dist:regular:ubuntu']?.includes('--linux'), 'Ubuntu regular script must force --linux.');

for (const [name, config] of Object.entries(configs)) {
  assert(config.extraMetadata?.ahtLauncherMode === 'player', `${name} config should be regular/player mode.`);
  assert(config.files?.includes('pack-fixes/**/*'), `${name} config must include pack-fixes.`);
  assert(config.asarUnpack?.includes('pack-fixes/*.jar'), `${name} config must unpack pack-fix jars.`);
}

console.log(JSON.stringify({
  ok: true,
  targets: Object.fromEntries(Object.entries(configs).map(([name, config]) => [
    name,
    {
      productName: config.productName,
      output: config.directories.output,
      target: config.extraMetadata.ahtLauncherTarget
    }
  ]))
}, null, 2));
