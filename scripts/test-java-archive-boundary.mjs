import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import AdmZip from 'adm-zip';

async function extractor() {
  const source = (await fs.readFile(new URL('../src/forgeInstaller.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const begin = source.indexOf('async function extractJavaArchive(');
  const context = vm.createContext({ AdmZip });
  vm.runInContext(source.slice(begin, source.indexOf('\nasync function ensureManagedJava8Runtime(', begin)), context);
  return context.extractJavaArchive;
}

test('Java archive extraction refuses a linked destination without changing its target', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-java-archive-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'extract'), outside = path.join(root, 'unrelated-fixture');
  await fs.mkdir(destination); await fs.mkdir(outside);
  const sentinel = path.join(outside, 'java.exe');
  await fs.writeFile(sentinel, 'preserved unrelated fixture');
  await fs.symlink(outside, path.join(destination, 'bin'), process.platform === 'win32' ? 'junction' : 'dir');
  const zip = new AdmZip(); zip.addFile('bin/java.exe', Buffer.from('archive fixture'));
  const archive = path.join(root, 'runtime.zip'); await fs.writeFile(archive, zip.toBuffer());
  const extract = await extractor();
  await assert.rejects(extract(archive, destination));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserved unrelated fixture');
});

test('ordinary Java archive files retain their directory structure and exact bytes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-java-archive-normal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zip = new AdmZip(); zip.addFile('jdk8/bin/java.exe', Buffer.from('java fixture'));
  zip.addFile('jdk8/lib/runtime.jar', Buffer.from('library fixture'));
  const archive = path.join(root, 'runtime.zip'); await fs.writeFile(archive, zip.toBuffer());
  const destination = path.join(root, 'extract');
  await (await extractor())(archive, destination);
  assert.equal(await fs.readFile(path.join(destination, 'jdk8/bin/java.exe'), 'utf8'), 'java fixture');
  assert.equal(await fs.readFile(path.join(destination, 'jdk8/lib/runtime.jar'), 'utf8'), 'library fixture');
});
