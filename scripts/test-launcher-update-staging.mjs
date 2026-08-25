import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { safeArchivePath, stageWindowsLauncherUpdate, validateStagedWindowsLauncherUpdate } from '../src/launcherUpdateStaging.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertUnsafeArchivePath(value) {
  let rejected = false;
  try {
    safeArchivePath(value);
  } catch (error) {
    rejected = /unsafe path|absolute path|too long/.test(String(error?.message || error));
  }
  assert(rejected, `unsafe Windows archive path was accepted: ${value}`);
}

for (const unsafePath of ['resources//app.asar', 'resources/app.asar:evil', 'CON.txt', 'resources/app.asar.', '../escape']) {
  assertUnsafeArchivePath(unsafePath);
}

async function writeZip(filePath, entries) {
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(value));
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  zip.writeZip(filePath);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-launcher-stage-'));
try {
  const installDir = path.join(root, 'A Hard Time Launcher Windows');
  const archivePath = path.join(root, 'AHT-Launcher-Windows-10-11-7.8.9.zip');
  const stagingDir = path.join(root, '.aht-launcher-update-7.8.9-valid');
  const extractRoot = path.join(root, '.aht-launcher-extract-7.8.9-valid');
  const targetExeName = 'A Hard Time Launcher Windows.exe';
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(path.join(installDir, targetExeName), 'old-launcher');
  await fs.writeFile(path.join(installDir, 'Uninstall A Hard Time Launcher Windows.exe'), 'preserved-uninstaller');
  await writeZip(archivePath, {
    [targetExeName]: 'new-launcher',
    'resources/app.asar': 'new-app-asar',
    'resources/app-update.yml': 'provider: generic',
    'locales/en-US.pak': 'locale'
  });

  let releaseVersionRead;
  const versionGate = new Promise((resolve) => { releaseVersionRead = resolve; });
  let stageResolved = false;
  const stagingPromise = stageWindowsLauncherUpdate({
    archivePath,
    installDir,
    stagingDir,
    extractRoot,
    targetExeName,
    expectedVersion: '7.8.9',
    archiveSha256: 'a'.repeat(64),
    readProductVersion: async () => {
      await versionGate;
      return '7.8.9.0';
    }
  }).then((result) => {
    stageResolved = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert(!stageResolved, 'launcher update became ready before executable version validation finished');
  releaseVersionRead();
  const staged = await stagingPromise;
  assert(staged.receipt.expectedVersion === '7.8.9', 'staging receipt version mismatch');
  assert(staged.receipt.files.some((entry) => entry.path === 'resources/app.asar'), 'staging receipt omitted app.asar');
  assert(staged.receipt.files.some((entry) => entry.path === 'Uninstall A Hard Time Launcher Windows.exe'), 'staging did not preserve installer-owned uninstaller');
  assert((await fs.readFile(path.join(stagingDir, targetExeName), 'utf8')) === 'new-launcher', 'staged launcher executable mismatch');

  const validation = await validateStagedWindowsLauncherUpdate({
    stagingDir,
    receipt: staged.receipt,
    expectedVersion: '7.8.9',
    readProductVersion: async () => '7.8.9.0'
  });
  assert(validation.ok && validation.fileCount === staged.receipt.fileCount, 'valid staged launcher was not accepted');

  await fs.writeFile(path.join(stagingDir, 'resources', 'app.asar'), 'tampered');
  let tamperRejected = false;
  try {
    await validateStagedWindowsLauncherUpdate({ stagingDir, receipt: staged.receipt, expectedVersion: '7.8.9' });
  } catch (error) {
    tamperRejected = /size changed|hash changed/.test(String(error?.message || error));
  }
  assert(tamperRejected, 'staged launcher tampering was not rejected');

  const wrongVersionStage = path.join(root, '.aht-launcher-update-7.8.9-wrong');
  let wrongVersionRejected = false;
  try {
    await stageWindowsLauncherUpdate({
      archivePath,
      installDir,
      stagingDir: wrongVersionStage,
      extractRoot: `${wrongVersionStage}.extracting`,
      targetExeName,
      expectedVersion: '7.8.9',
      readProductVersion: async () => '7.8.8.0'
    });
  } catch (error) {
    wrongVersionRejected = /does not match 7\.8\.9/.test(String(error?.message || error));
  }
  assert(wrongVersionRejected, 'wrong-version staged launcher was not rejected');
  assert(!(await fs.stat(wrongVersionStage).catch(() => null)), 'wrong-version staging directory was not cleaned');

  const unsafeArchive = path.join(root, 'unsafe.zip');
  await writeZip(unsafeArchive, {
    [`app/${targetExeName}`]: 'new-launcher',
    'app/resources/app.asar': 'new-app-asar',
    'outside-payload.txt': 'escape'
  });
  const unsafeStage = path.join(root, '.aht-launcher-update-7.8.9-unsafe');
  let unsafeRejected = false;
  try {
    await stageWindowsLauncherUpdate({
      archivePath: unsafeArchive,
      installDir,
      stagingDir: unsafeStage,
      extractRoot: `${unsafeStage}.extracting`,
      targetExeName,
      expectedVersion: '7.8.9',
      readProductVersion: async () => '7.8.9.0'
    });
  } catch (error) {
    unsafeRejected = /unsafe path|outside the packaged application root/.test(String(error?.message || error));
  }
  assert(unsafeRejected, 'unsafe launcher ZIP path was not rejected');
  assert(!(await fs.stat(path.join(root, 'outside-payload.txt')).catch(() => null)), 'unsafe launcher ZIP wrote outside staging');

  console.log(JSON.stringify({
    ok: true,
    stagedFiles: staged.receipt.fileCount,
    stagedBytes: staged.receipt.totalBytes,
    treeSha256: staged.receipt.treeSha256,
    wrongVersionRejected,
    tamperRejected,
    unsafeRejected
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
