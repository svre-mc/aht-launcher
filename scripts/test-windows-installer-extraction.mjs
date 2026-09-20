import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';
const require = createRequire(import.meta.url), run = promisify(execFile);
if (process.platform !== 'win32') { console.log('SKIP: Windows installer extraction'); process.exit(0); }
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-installer-zip-'));
const plugins = await require('../build/windows-nsis-zip.cjs').prepareUnicodeZipPlugin(root);
const config = require('../build/electron-builder.windows.cjs');
const bundle = await require('app-builder-lib/out/toolsets/windows').getMakeNsisPath(config.toolsets.nsis);
const nsisRoot = path.join(path.dirname(bundle.path), 'windows');
const escape = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const fixture = new AdmZip(); fixture.addFile('nested/hello.txt', Buffer.from('AHT installer ZIP fixture'));
const archive = path.join(root, 'payload.zip'); fixture.writeZip(archive);
for (const scenario of ['valid', 'spaces', 'missing']) {
  const directory = path.join(root, scenario === 'spaces' ? 'Player Settings' : scenario);
  await fs.mkdir(directory);
  const input = path.join(directory, 'payload.zip');
  if (scenario !== 'missing') await fs.copyFile(archive, input);
  const output = path.join(directory, 'installed'), receipt = path.join(directory, 'result.txt');
  const executable = path.join(directory, 'extract.exe');
  const script = `Unicode true
Name "AHT installer ZIP test"
OutFile "${escape(executable)}"
RequestExecutionLevel user
SilentInstall silent
!addplugindir /x86-unicode "${escape(plugins)}"
Section
nsisunz::Unzip "${escape(input)}" "${escape(output)}"
Pop $0
FileOpen $1 "${escape(receipt)}" w
FileWriteUTF16LE $1 $0
FileClose $1
SectionEnd
`;
  const source = path.join(directory, 'extract.nsi'); await fs.writeFile(source, '\uFEFF' + script);
  await run(path.join(nsisRoot, 'makensis.exe'), ['/V2', source], { env: { ...process.env, NSISDIR: nsisRoot }, windowsHide: true });
  await run(executable, [], { windowsHide: true, timeout: 15000 });
  const result = (await fs.readFile(receipt)).toString('utf16le').replace(/^\uFEFF/, '');
  if (scenario === 'missing') {
    assert.match(result, /^Error opening ZIP file$/);
    assert.equal(await fs.stat(path.join(output, 'nested/hello.txt')).catch(() => null), null);
  } else {
    assert.equal(result, 'success', `${scenario}: ZIP plugin returned ${result}`);
    assert.equal(await fs.readFile(path.join(output, 'nested/hello.txt'), 'utf8'), 'AHT installer ZIP fixture');
  }
}
console.log('PASS: actual Unicode NSIS ZIP extraction, paths with spaces, and readable missing-archive errors.');
