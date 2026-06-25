import worker from '../cloudflare/curseforge-proxy-worker.js';

const encoder = new TextEncoder();
const store = new Map([
  ['latest.json', { value: JSON.stringify({ name: 'AHT', version: '2.8.1' }), contentType: 'application/json; charset=utf-8' }],
  ['launcher/latest.json', { value: JSON.stringify({ product: 'aht-launcher', version: '0.1.1' }), contentType: 'application/json; charset=utf-8' }],
  ['launcher/files/win32-x64/AHT-Launcher-Windows-10-11-0.1.1.exe', { value: new Uint8Array([7, 8, 9]), contentType: '' }],
  ['cache/files/test.jar', { value: new Uint8Array([1, 2, 3]), contentType: '' }],
  ['server/aht_version_lock.cfg', { value: 'requiredVersion=2.8.1', contentType: '' }]
]);

function objectFor(key, record) {
  const bytes = typeof record.value === 'string' ? encoder.encode(record.value) : record.value;
  return {
    key,
    size: bytes.byteLength,
    uploaded: new Date('2026-06-24T00:00:00Z'),
    httpEtag: '"test-etag"',
    httpMetadata: record.contentType ? { contentType: record.contentType } : {},
    body: new Response(bytes).body
  };
}

const env = {
  AHT_RELEASES: {
    async get(key) {
      const record = store.get(key);
      return record ? objectFor(key, record) : null;
    }
  },
  AHT_DATA: {
    async put() {},
    async list() {
      return { objects: [] };
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

console.log(JSON.stringify(results, null, 2));
