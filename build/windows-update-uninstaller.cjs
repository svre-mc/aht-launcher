const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');

const name = 'Uninstall A Hard Time Launcher Windows.exe';
async function addUninstallerToUpdate(zipFile, uninstallerFile) {
  const bytes = await fs.readFile(uninstallerFile);
  if (bytes.length < 1024 || bytes.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Windows update requires the generated NSIS uninstaller.');
  }
  const zip = new AdmZip(zipFile);
  if (!zip.getEntry('A Hard Time Launcher Windows.exe')) throw new Error('Unexpected Windows update ZIP layout.');
  zip.addFile(name, bytes);
  const temporary = `${zipFile}.with-uninstaller.tmp`;
  try {
    await new Promise((resolve, reject) => zip.writeZip(temporary, error => error ? reject(error) : resolve()));
    if (!new AdmZip(temporary).readFile(name)?.equals(bytes)) throw new Error('Update uninstaller verification failed.');
    await fs.rename(temporary, zipFile);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

module.exports = async function finalizeWindowsUpdate(context) {
  const zip = context.artifactPaths.find(file => /AHT-Launcher-Windows-10-11-.*\.zip$/i.test(file));
  const installer = context.artifactPaths.find(file => /AHT-Launcher-Windows-10-11-.*\.exe$/i.test(file));
  if (!zip && !installer) return []; // --dir does not produce distributable artifacts.
  if (!zip || !installer) throw new Error('Windows release must build both NSIS and ZIP targets together.');
  await addUninstallerToUpdate(zip, path.join(__dirname, 'windows-update-uninstaller.exe'));
  return [];
};
module.exports.addUninstallerToUpdate = addUninstallerToUpdate;

// Compile-time callback for the pinned NSIS version, which predates !copyfile.
// This command is not embedded in, or executed by, the player's uninstaller.
if (require.main === module) {
  fs.copyFile(process.argv[2], path.join(__dirname, 'windows-update-uninstaller.exe')).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
