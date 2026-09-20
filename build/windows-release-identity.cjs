const fs = require('node:fs/promises');
const path = require('node:path');
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');

module.exports = async function preserveRepairProductVersion(context) {
  const version = context.packager.appInfo.version;
  if (!/-repair\.[1-9]\d*$/.test(version)) return;
  const file = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  // electron-builder normalizes ProductVersion to four numbers. Older launchers
  // validate this string before staging, so retain the exact repair identity.
  // Keep the numeric version resource, code sections and other resources intact.
  const executable = NtExecutable.from(await fs.readFile(file), { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  if (versions.length !== 1) throw new Error('Expected one Windows version resource.');
  for (const language of versions[0].getAllLanguagesForStringValues()) {
    versions[0].setStringValues(language, { ProductVersion: version });
  }
  versions[0].outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  await fs.writeFile(file, Buffer.from(executable.generate()));
  // Reapply the configured signing policy after the final metadata edit.
  await context.packager.signIf(file);
};
