import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_TEMURIN8, verifyJava8Archive } from '../src/bundledJava8.js';
import { downloadToFile } from '../src/utils.js';

const directory = fileURLToPath(new URL('../build/runtime/java/', import.meta.url));
await fs.mkdir(directory, { recursive: true });
const archive = path.join(directory, WINDOWS_TEMURIN8.fileName);
if (!(await verifyJava8Archive(archive))) {
  await downloadToFile(WINDOWS_TEMURIN8.url, archive, { timeoutMs: 120_000, retries: 2 });
}
if (!(await verifyJava8Archive(archive))) throw new Error('Bundled Temurin 8 archive failed checksum validation.');
await fs.writeFile(path.join(directory, 'NOTICE.txt'),
  `Eclipse Temurin ${WINDOWS_TEMURIN8.version}, Windows x64 JRE.\n` +
  `The unmodified archive includes LICENSE, ASSEMBLY_EXCEPTION and THIRD_PARTY_README.\n` +
  `Corresponding source: ${WINDOWS_TEMURIN8.sourceUrl}\n` +
  `Binary: ${WINDOWS_TEMURIN8.url}\nSHA-256: ${WINDOWS_TEMURIN8.sha256}\n`);
console.log(`Verified bundled Temurin ${WINDOWS_TEMURIN8.version}: ${(WINDOWS_TEMURIN8.size / 1048576).toFixed(1)} MiB.`);
