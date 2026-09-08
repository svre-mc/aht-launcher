import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert(process.versions.electron, 'Run this test with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.');
const resources = path.join(path.dirname(process.execPath), 'resources');
const runtimeModule = await import(pathToFileURL(path.join(resources, 'app.asar/src/bundledJava8.js')));
const { inspectJavaRuntime, preflightJava8Runtime } = await import(pathToFileURL(path.join(resources, 'app.asar/src/forgeInstaller.js')));
const { verifyRepairedJava, RUNTIME_REPAIR_BUILD } = await import(pathToFileURL(path.join(resources, 'app.asar/src/runtimeRepair.js')));
const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-packaged-java-'));
try {
  const runtime = await runtimeModule.ensureBundledJava8({
    cacheDir, archivePath: runtimeModule.bundledJava8ArchivePath(resources), allowDownload: false,
    probe: (file) => inspectJavaRuntime(file, { refresh: true })
  });
  assert(runtime.usable && runtime.major === 8 && runtime.is64Bit && runtime.bundled);
  const receipt = JSON.parse(await fs.readFile(path.join(cacheDir, 'temurin8/aht-runtime.json'), 'utf8'));
  const library = receipt.files.find((item) => item.path.endsWith('/lib/rt.jar'));
  assert(library);
  await fs.rm(path.join(cacheDir, 'temurin8', library.path));
  const repaired = await runtimeModule.ensureBundledJava8({
    cacheDir, archivePath: runtimeModule.bundledJava8ArchivePath(resources), allowDownload: false,
    refresh: true, probe: (file) => inspectJavaRuntime(file, { refresh: true })
  });
  assert(repaired.usable && (await fs.stat(path.join(cacheDir, 'temurin8', library.path))).size === library.size);
  await fs.rm(repaired.javaPath);
  const recoveredExecutable = await runtimeModule.ensureBundledJava8({
    cacheDir, archivePath: runtimeModule.bundledJava8ArchivePath(resources), allowDownload: false,
    probe: (file) => inspectJavaRuntime(file, { refresh: true })
  });
  const finalJava = await verifyRepairedJava({
    runtime: { ...recoveredExecutable, path: recoveredExecutable.javaPath },
    profile: { javaPath: recoveredExecutable.javaPath }, memoryMb: 4096, probe: preflightJava8Runtime
  });
  assert(finalJava.heapReady && finalJava.usable);
  console.log(JSON.stringify({ ok: true, executable: process.execPath, platform: os.release(),
    java: runtime.version, architecture: runtime.arch, vendor: runtime.vendor,
    build: RUNTIME_REPAIR_BUILD, bundledArchive: true, downloaded: false,
    missingJvmLibraryRepaired: true, missingCachedJavaExecutableRepaired: true, finalHeapProbePassed: true }));
} finally { await fs.rm(cacheDir, { recursive: true, force: true }); }
