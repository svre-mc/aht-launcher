import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = path.join(root, 'account-recovery/src/net/ahardtime/recovery/Main.java');
const compiler = process.env.AHT_RECOVERY_JAVAC || 'C:/AHTDEV/Toolchains/Java-8/bin/javac.exe';
const classes = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-account-recovery-build-'));
execFileSync(compiler, ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-d', classes, source], { windowsHide: true, stdio: 'pipe' });
const zip = new AdmZip();
for (const name of ['Main.class', 'Main$Transport.class']) {
  const bytes = await fs.readFile(path.join(classes, 'net/ahardtime/recovery', name));
  if (bytes.readUInt16BE(6) !== 52) throw new Error('Recovery helper must target Java 8.');
  zip.addFile(`net/ahardtime/recovery/${name}`, bytes);
  zip.getEntry(`net/ahardtime/recovery/${name}`).header.time = new Date('2020-01-01T00:00:00Z');
}
const bytes = zip.toBuffer();
const resources = path.join(root, 'src/resources');
await fs.mkdir(resources, { recursive: true });
await fs.writeFile(path.join(resources, 'account-recovery.jar'), bytes);
const digest = data => createHash('sha256').update(data).digest('hex');
await fs.writeFile(path.join(resources, 'account-recovery.json'), JSON.stringify({
  version: '1', sha256: digest(bytes), sourceSha256: digest(await fs.readFile(source))
}, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, size: bytes.length, javaMajor: 52 }));
