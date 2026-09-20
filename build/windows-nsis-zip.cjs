const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getNsisPluginsPath } = require('app-builder-lib/out/toolsets/windows');

// nsis@1.2.1 ships the ANSI nsisunz.dll in both architecture folders. Use the
// Unicode plugin from electron-builder's checksum-verified resource bundle.
const unicodePluginSha256 = 'c31b590cba443de87f0f4a81712f0883ac3b506f3868759d918d9a81f84ea922';
async function prepareUnicodeZipPlugin(resourcesDirectory = __dirname) {
  const plugins = await getNsisPluginsPath('0.0.0');
  const bytes = await fs.readFile(path.join(plugins, 'x86-unicode', 'nsisunz.dll'));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== unicodePluginSha256) {
    throw new Error('The Windows installer Unicode ZIP plugin does not match its verified hash.');
  }
  const directory = path.join(resourcesDirectory, 'nsis-unicode-zip');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'nsisunz.dll'), bytes);
  return directory;
}
module.exports = { prepareUnicodeZipPlugin, unicodePluginSha256 };
