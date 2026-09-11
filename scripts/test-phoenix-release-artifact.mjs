import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { phoenixSourceHash, reusePhoenixRelease } from './phoenix-release-artifact.mjs';
const source = 'fixture\nsource\n';
const bytes = Buffer.from('published executable fixture');
const pin = { version: '1.1.4', sourceSha256: phoenixSourceHash(source),
  url: 'https://api.ahardtime.net/launcher/anticheat/win32-x64/Phoenix-Anti-cheat-Windows-x64-1.1.4.exe',
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
let requests = 0;
const serve = async () => { requests++; return new Response(bytes); };
assert.deepEqual(await reusePhoenixRelease(pin, '1.1.4', source, serve), bytes);
assert.deepEqual(await reusePhoenixRelease(pin, '1.1.4', source.replaceAll('\n', '\r\n'), serve), bytes);
assert.equal(await reusePhoenixRelease(pin, '1.1.5', source + 'changed', serve), null);
await assert.rejects(reusePhoenixRelease(pin, '1.1.4', source + 'changed', serve), /source changed/);
assert.equal(requests, 2);
await assert.rejects(reusePhoenixRelease({ ...pin, url: 'https://invalid.example/file' }, '1.1.4', source, serve), /Invalid/);
await assert.rejects(reusePhoenixRelease(pin, '1.1.4', source, async () => new Response('not found', { status: 404 })), /unavailable/);
await assert.rejects(reusePhoenixRelease(pin, '1.1.4', source, async () => new Response(Buffer.alloc(bytes.length))), /verification/);
await assert.rejects(reusePhoenixRelease(pin, '1.1.4', source, async () => new Response(Buffer.alloc(bytes.length + 1))), /size mismatch/);
console.log('PASS: immutable Phoenix reuse, normalized source pin, version advancement, fail-closed network/size/hash checks');
const publishedPin = JSON.parse(await fs.readFile(new URL('../native-guard/release.json', import.meta.url), 'utf8'));
const publishedSource = await fs.readFile(new URL('../native-guard/Guard.cs', import.meta.url), 'utf8');
const publishedArtifact = await fs.readFile(new URL(`../native-guard/releases/Phoenix-Anti-cheat-Windows-x64-${publishedPin.version}.exe`, import.meta.url));
const buildVersion = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).phoenixAntiCheatVersion;
assert.equal(publishedArtifact.length, publishedPin.size);
assert.equal(crypto.createHash('sha256').update(publishedArtifact).digest('hex'), publishedPin.sha256);
if (buildVersion === publishedPin.version) {
  assert.deepEqual(await reusePhoenixRelease(publishedPin, buildVersion, publishedSource, async () => new Response(publishedArtifact)), publishedArtifact);
}
console.log('PASS: repository artifact matches published source, size and SHA256 pins');
