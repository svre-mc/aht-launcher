import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const source = process.argv[2] ? pathToFileURL(process.argv[2]).href : '../cloudflare/curseforge-proxy-worker.js';
const { default: worker } = await import(source);
const env = { AHT_PUBLIC_ORIGIN: 'https://api.ahardtime.net' };
const legacy = 'https://aht-curseforge-proxy.mysticgamer312.workers.dev';
const response = await worker.fetch(new Request(`${legacy}/api/launcher-proof/verify`, {
  headers: { Authorization: 'Bearer diagnostic-invalid-proof', 'User-Agent': 'AHT-Launcher-Lock/1.1.1' }
}), env, {});
assert.equal(response.status, 401);
assert.match(response.headers.get('content-type'), /application\/json/);
assert.equal(response.headers.get('location'), null);
assert.equal((await response.json()).accessGranted, false);
const download = await worker.fetch(new Request(`${legacy}/launcher/latest.json`), env, {});
assert.equal(download.status, 308);
assert.equal(download.headers.get('location'), 'https://api.ahardtime.net/launcher/latest.json');
console.log('PASS: legacy Java verification returns authenticated JSON without redirects; invalid proof stays denied; download redirect remains intact.');
