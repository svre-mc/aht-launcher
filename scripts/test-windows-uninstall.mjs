import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const run = promisify(execFile);
if (process.platform !== 'win32') { console.log('SKIP: Windows uninstaller runtime'); process.exit(0); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-uninstall-test-'));
const windowsConfig = require('../build/electron-builder.windows.cjs');
const compilerBundle = await require('app-builder-lib/out/toolsets/windows').getMakeNsisPath(windowsConfig.toolsets?.nsis);
// The modern bundle's .cmd entry point sets NSISDIR. Invoke its documented
// executable directly so fixture paths remain arguments, never shell text.
const compiler = compilerBundle.path.endsWith('.cmd')
  ? { path: path.join(path.dirname(compilerBundle.path), 'windows', 'makensis.exe'), env: { NSISDIR: path.join(path.dirname(compilerBundle.path), 'windows') } }
  : compilerBundle;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = [];
const nsis = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
async function waitFor(file) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fs.stat(file).catch(() => null)) return; await pause(100); }
  throw Error(`Fixture did not finish: ${file}`);
}
try {
  const ui = path.join(root, 'ui.exe');
  await run(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/reference:System.Drawing.dll', `/out:${ui}`, path.join(repo, 'scripts/helpers/windows-uninstall-ui.cs')], { windowsHide: true });
  for (const scenario of ['remove', 'keep', 'back', 'cancel', 'silent', 'upgrade', 'unowned', 'root-junction', 'marker-junction', 'child-junction']) {
    const caseRoot = path.join(root, scenario), data = path.join(caseRoot, 'AHT');
    const outside = path.join(caseRoot, 'outside');
    await fs.mkdir(outside, { recursive: true }); await fs.writeFile(path.join(outside, 'keep.txt'), 'outside');
    if (scenario === 'root-junction') await fs.symlink(outside, data, 'junction');
    else await fs.mkdir(data);
    const instance = path.join(data, 'A Hard Time'), metadata = path.join(instance, '.aht-launcher');
    await fs.mkdir(instance, { recursive: true });
    if (scenario === 'marker-junction') await fs.symlink(outside, metadata, 'junction');
    else await fs.mkdir(metadata);
    if (scenario !== 'unowned') await fs.writeFile(path.join(metadata, 'installed.json'), '{"packId":"a-hard-time-dregora","version":"fixture"}');
    await fs.writeFile(path.join(instance, 'world.txt'), 'saved game');
    if (scenario === 'child-junction') await fs.symlink(outside, path.join(data, 'linked-folder'), 'junction');
    const title = `AHT Uninstall Test ${path.basename(root)} ${scenario}`;
    const result = path.join(caseRoot, 'result.ini'), generator = path.join(caseRoot, 'generate.exe'), uninstaller = path.join(caseRoot, 'uninstall.exe');
    const script = `Unicode true
Name "${title}"
OutFile "${nsis(generator)}"
RequestExecutionLevel user
SilentInstall silent
SetCompressor zlib
!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh
!define BUILD_UNINSTALLER
!define BUILD_RESOURCES_DIR "${nsis(path.join(repo, 'build'))}"
Var FixtureUpdating
!define isUpdated '\"$FixtureUpdating\" == \"1\"'
!include "${nsis(path.join(repo, 'build/windows-installer.nsh'))}"
!insertmacro customUnWelcomePage
${scenario === 'back' ? 'UninstPage custom un.FixtureSecondPage' : ''}
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro customHeader
Function un.FixtureSecondPage
  nsDialogs::Create 1018
  Pop $0
  nsDialogs::Show
FunctionEnd
Function un.onInit
  StrCpy $FixtureUpdating "${scenario === 'upgrade' ? '1' : '0'}"
  !insertmacro customUnInit
  StrCpy $AhtDataRoot "${nsis(data)}"
  SetAutoClose true
FunctionEnd
Section
  WriteUninstaller "${nsis(uninstaller)}"
SectionEnd
Section "Uninstall"
  !insertmacro customUnInstall
  WriteINIStr "${nsis(result)}" "test" "complete" "1"
SectionEnd
`;
    const scriptPath = path.join(caseRoot, 'fixture.nsi'); await fs.writeFile(scriptPath, script);
    await run(compiler.path, ['/V2', scriptPath], { env: { ...process.env, ...compiler.env }, windowsHide: true });
    await run(generator, [], { windowsHide: true });
    await waitFor(uninstaller);
    const { spawn } = await import('node:child_process');
    const child = spawn(uninstaller, scenario === 'silent' ? ['/S'] : [], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    const enabled = !['unowned', 'root-junction', 'marker-junction'].includes(scenario);
    if (!['silent', 'upgrade'].includes(scenario)) {
      const action = ['keep', 'cancel', 'back'].includes(scenario) ? scenario : 'remove';
      const args = [title, action, enabled ? '1' : '0', enabled ? '1' : '0'];
      if (scenario === 'remove' && process.env.AHT_UNINSTALL_SCREENSHOT) args.push(process.env.AHT_UNINSTALL_SCREENSHOT);
      const controller = await run(ui, args, { windowsHide: true, timeout: 25000 });
      assert.match(controller.stdout, /PASS options/);
    }
    if (scenario === 'cancel') { await pause(500); assert.equal(await fs.stat(result).catch(() => null), null); }
    else await waitFor(result);
    const removed = ['remove', 'child-junction'].includes(scenario);
    assert.equal(Boolean(await fs.lstat(data).catch(() => null)), !removed, `${scenario}: data preservation`);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside', `${scenario}: followed a junction`);
    rows.push({ scenario, passed: true, defaultChecked: enabled, dataRemoved: removed });
  }
  console.log(JSON.stringify({ passed: true, cases: rows }, null, 2));
} finally {
  await run(path.join(root, 'ui.exe'), [path.basename(root), 'cleanup'], { windowsHide: true }).catch(() => {});
  await pause(250);
  // This exact mkdtemp result is the only recursive cleanup target.
  assert(path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('aht-uninstall-test-'));
  await fs.rm(root, { recursive: true, force: true });
}
