import worker from '../cloudflare/curseforge-proxy-worker.js';
import assert from 'node:assert/strict';

const encoder = new TextEncoder();
const releaseReads = new Map();
const cacheStore = new Map();
Object.defineProperty(globalThis, 'caches', {
  configurable: true,
  value: {
    default: {
      async match(request) {
        return cacheStore.get(request.url)?.clone() || undefined;
      },
      async put(request, response) {
        cacheStore.set(request.url, response.clone());
      }
    }
  }
});
const store = new Map([
  ['latest.json', { value: JSON.stringify({ name: 'AHT', version: '2.8.1' }), contentType: 'application/json; charset=utf-8' }],
  ['ptb/latest.json', { value: JSON.stringify({ name: 'AHT PTB', version: '2.9.0-ptb.1' }), contentType: 'application/json; charset=utf-8' }],
  ['ptb/packs/aht-ptb.zip', { value: new Uint8Array([21, 22, 23]), contentType: '' }],
  ['ptb/patches/aht-ptb-delta.zip', { value: new Uint8Array([24, 25]), contentType: '' }],
  ['manifests/aht-client.json', { value: JSON.stringify({ format: 'aht-client-manifest-v1' }), contentType: '' }],
  ['launcher/latest.json', { value: JSON.stringify({ product: 'aht-launcher', version: '0.1.1' }), contentType: 'application/json; charset=utf-8' }],
  ['launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.1.exe', { value: new Uint8Array([7, 8, 9]), contentType: '' }],
  ['cache/files/test.jar', { value: new Uint8Array([1, 2, 3]), contentType: '' }],
  ['packs/range-test.zip', { value: new Uint8Array([10, 11, 12, 13, 14]), contentType: '' }],
  ['packs/empty.zip', { value: new Uint8Array([]), contentType: '' }],
  ['server/aht_version_lock.cfg', { value: 'stateWebSocketUrl=wss://worker.test/server/launcher-state', contentType: '' }]
]);

function objectFor(key, record, options = {}) {
  const bytes = typeof record.value === 'string' ? encoder.encode(record.value) : record.value;
  const requestedRange = options.range || null;
  const rangeOffset = Math.max(0, Number(requestedRange?.offset || 0));
  const rangeLength = Math.max(0, Number(requestedRange?.length || bytes.byteLength));
  const responseBytes = requestedRange
    ? bytes.subarray(rangeOffset, Math.min(bytes.byteLength, rangeOffset + rangeLength))
    : bytes;
  return {
    key,
    size: bytes.byteLength,
    uploaded: new Date('2026-06-24T00:00:00Z'),
    httpEtag: '"test-etag"',
    httpMetadata: record.contentType ? { contentType: record.contentType } : {},
    body: new Response(responseBytes).body
  };
}

const env = {
  AHT_RELEASES: {
    async head(key) {
      const record = store.get(key);
      return record ? objectFor(key, record) : null;
    },
    async get(key, options = {}) {
      releaseReads.set(key, Number(releaseReads.get(key) || 0) + 1);
      const record = store.get(key);
      return record ? objectFor(key, record, options) : null;
    }
  },
  AHT_DATA: {
    async put() {},
    async list() {
      return { objects: [] };
    }
  },
  AHT_PLAYER_API_RATE_LIMITER: {
    async limit() {
      return { success: true };
    }
  }
};

async function check(name, request, expected) {
  const response = await worker.fetch(request, env, {});
  const body = await response.text();
  const actual = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    length: response.headers.get('content-length'),
    contentRange: response.headers.get('content-range'),
    acceptRanges: response.headers.get('accept-ranges'),
    body
  };
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`${name}: expected ${key}=${value}, got ${actual[key]} (${JSON.stringify(actual)})`);
    }
  }
  return { name, ...actual };
}

const results = [];
results.push(await check('latest', new Request('https://worker.test/latest.json'), {
  status: 200,
  contentType: 'application/json; charset=utf-8',
  cacheControl: 'public, max-age=60, must-revalidate',
  length: '32',
  body: '{"name":"AHT","version":"2.8.1"}'
}));
results.push(await check('release prefix alias', new Request('https://worker.test/releases/latest.json'), {
  status: 200,
  contentType: 'application/json; charset=utf-8',
  cacheControl: 'public, max-age=60, must-revalidate',
  length: '32'
}));
results.push(await check('ptb latest', new Request('https://worker.test/ptb/latest.json'), {
  status: 200,
  contentType: 'application/json; charset=utf-8',
  cacheControl: 'public, max-age=60, must-revalidate',
  body: '{"name":"AHT PTB","version":"2.9.0-ptb.1"}'
}));
results.push(await check('ptb pack', new Request('https://worker.test/ptb/packs/aht-ptb.zip'), {
  status: 200,
  contentType: 'application/zip',
  cacheControl: 'public, max-age=31536000, immutable',
  length: '3'
}));
results.push(await check('ptb delta patch', new Request('https://worker.test/ptb/patches/aht-ptb-delta.zip'), {
  status: 200,
  contentType: 'application/zip',
  cacheControl: 'public, max-age=31536000, immutable',
  length: '2'
}));
results.push(await check('client manifest', new Request('https://worker.test/manifests/aht-client.json'), {
  status: 200,
  contentType: 'application/json; charset=utf-8',
  cacheControl: 'public, max-age=31536000, immutable',
  body: '{"format":"aht-client-manifest-v1"}'
}));
results.push(await check('cache jar', new Request('https://worker.test/cache/files/test.jar'), {
  status: 200,
  contentType: 'application/java-archive',
  cacheControl: 'public, max-age=31536000, immutable',
  length: '3'
}));
results.push(await check('launcher latest', new Request('https://worker.test/launcher/latest.json'), {
  status: 200,
  contentType: 'application/json; charset=utf-8',
  cacheControl: 'public, max-age=60, must-revalidate',
  length: '44',
  body: '{"product":"aht-launcher","version":"0.1.1"}'
}));
results.push(await check('launcher installer', new Request('https://worker.test/launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.1.exe'), {
  status: 200,
  contentType: 'application/vnd.microsoft.portable-executable',
  cacheControl: 'public, max-age=31536000, immutable',
  length: '3'
}));
results.push(await check('range pack', new Request('https://worker.test/packs/range-test.zip', { headers: { Range: 'bytes=1-3' } }), {
  status: 206,
  contentType: 'application/zip',
  cacheControl: 'public, max-age=31536000, immutable',
  length: '3',
  contentRange: 'bytes 1-3/5',
  acceptRanges: 'bytes',
  body: String.fromCharCode(11, 12, 13)
}));
results.push(await check('invalid range', new Request('https://worker.test/packs/range-test.zip', { headers: { Range: 'bytes=99-100' } }), {
  status: 416,
  contentRange: 'bytes */5',
  acceptRanges: 'bytes',
  body: ''
}));
results.push(await check('empty suffix range', new Request('https://worker.test/packs/empty.zip', { headers: { Range: 'bytes=-1' } }), {
  status: 416,
  contentRange: 'bytes */0',
  acceptRanges: 'bytes',
  body: ''
}));
results.push(await check('head jar', new Request('https://worker.test/cache/files/test.jar', { method: 'HEAD' }), {
  status: 200,
  contentType: 'application/java-archive',
  cacheControl: 'public, max-age=31536000, immutable',
  length: '3',
  body: ''
}));
results.push(await check('missing', new Request('https://worker.test/packs/missing.zip'), {
  status: 404,
  contentType: 'application/json',
  body: '{"error":"Release object not found","key":"packs/missing.zip"}'
}));
results.push(await check('invalid', new Request('https://worker.test/cache/%00/secret.jar'), {
  status: 400,
  contentType: 'application/json',
  body: '{"error":"Invalid release path"}'
}));
results.push(await check('root', new Request('https://worker.test/'), {
  status: 200,
  contentType: 'application/json'
}));

cacheStore.clear();
const cacheProbeKey = 'launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.1.exe';
const readsBeforeCacheProbe = Number(releaseReads.get(cacheProbeKey) || 0);
await check('normalized cache query one', new Request(`https://worker.test/${cacheProbeKey}?probe=one`), {
  status: 200,
  length: '3'
});
await check('normalized cache query two', new Request(`https://worker.test/${cacheProbeKey}?probe=two`), {
  status: 200,
  length: '3'
});
assert.equal(Number(releaseReads.get(cacheProbeKey) || 0) - readsBeforeCacheProbe, 1, 'normalized cache key should avoid a second R2 read');

const readsBeforeRateLimit = Number(releaseReads.get('packs/range-test.zip') || 0);
const blocked = await worker.fetch(new Request('https://worker.test/packs/range-test.zip'), {
  ...env,
  AHT_PLAYER_API_RATE_LIMITER: { async limit() { return { success: false }; } }
}, {});
assert.equal(blocked.status, 429, 'release limiter should reject abusive request bursts');
assert.equal(Number(releaseReads.get('packs/range-test.zip') || 0), readsBeforeRateLimit, 'rate limit should run before R2');

console.log(JSON.stringify(results, null, 2));
