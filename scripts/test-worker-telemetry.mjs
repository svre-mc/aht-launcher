import worker from '../cloudflare/curseforge-proxy-worker.js';

const objects = new Map();
const env = {
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'secret',
  ADMIN_TOKEN_SECRET: 'test-secret',
  LAUNCHER_PROOF_SECRET: 'proof-secret',
  AHT_DATA: {
    async put(key, value) {
      objects.set(key, value);
    },
    async list({ prefix }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key }))
      };
    },
    async get(key) {
      const value = objects.get(key);
      return value ? { async json() { return JSON.parse(value); } } : null;
    }
  }
};

async function jsonRequest(path, options = {}) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`, options), env, {
    country: 'US'
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

await jsonRequest('/api/events', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '203.0.113.42',
    'User-Agent': 'AHT test'
  },
  body: JSON.stringify({
    schemaVersion: 1,
    installId: 'install-a',
    playerLabel: 'auSavant',
    platform: 'win32',
    arch: 'x64',
    packId: 'a-hard-time-dregora',
    event: { type: 'install_completed', version: '2.8.1' }
  })
});

await jsonRequest('/api/events', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '198.51.100.14',
    'User-Agent': 'AHT test'
  },
  body: JSON.stringify({
    schemaVersion: 1,
    installId: 'install-b',
    playerLabel: 'TestRig',
    platform: 'darwin',
    arch: 'x64',
    packId: 'a-hard-time-dregora',
    event: {
      type: 'local_changes',
      changes: {
        counts: { changed: 2, missing: 0, added: 1 },
        changed: [{ path: 'config/example.cfg' }],
        added: [{ path: 'shaderpacks/local.zip' }],
        missing: []
      }
    }
  })
});

const registration = await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '203.0.113.42',
    'User-Agent': 'AHT test'
  },
  body: JSON.stringify({
    username: 'TestRig',
    installId: 'install-b',
    platform: 'darwin',
    arch: 'x64',
    packId: 'a-hard-time-dregora'
  })
});

const repeatRegistration = await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'testrig',
    installId: 'install-b'
  })
});

const duplicateResponse = await worker.fetch(new Request('https://worker.test/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'TestRig',
    installId: 'install-c'
  })
}), env, {});
const duplicateBody = await duplicateResponse.json();
if (registration.username !== 'TestRig' || repeatRegistration.username !== 'testrig') {
  throw new Error(`Username registration failed: ${JSON.stringify({ registration, repeatRegistration })}`);
}
if (duplicateResponse.status !== 409 || !/not available/i.test(duplicateBody.error || '')) {
  throw new Error(`Expected duplicate username rejection, got ${duplicateResponse.status} ${JSON.stringify(duplicateBody)}`);
}

await jsonRequest('/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'RecoveredRig',
    installId: 'install-old',
    platform: 'win32',
    arch: 'x64',
    packId: 'a-hard-time-dregora'
  })
});
const recoveryResponse = await worker.fetch(new Request('https://worker.test/api/users/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'RecoveredRig',
    installId: 'install-new',
    recoverExistingUsername: true,
    minecraftAccountMatched: true,
    recoveryReason: 'minecraft-launcher-account-match'
  })
}), env, {});
const recoveryBody = await recoveryResponse.json();
if (!recoveryResponse.ok || !recoveryBody.recovered) {
  throw new Error(`Expected Minecraft Launcher account recovery, got ${recoveryResponse.status} ${JSON.stringify(recoveryBody)}`);
}
const recoveredProof = await jsonRequest('/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'RecoveredRig',
    installId: 'install-new',
    packId: 'a-hard-time-dregora',
    installedVersion: '2.8.2'
  })
});
if (!recoveredProof.trusted || recoveredProof.payload.installId !== 'install-new') {
  throw new Error(`Recovered username did not produce a proof for the new install: ${JSON.stringify(recoveredProof)}`);
}
const oldRecoveredProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ minecraftUsername: 'RecoveredRig', installId: 'install-old' })
}), env, {});
if (oldRecoveredProofResponse.status !== 403) {
  throw new Error(`Recovered username should reject the old install proof, got ${oldRecoveredProofResponse.status}`);
}

const launcherProof = await jsonRequest('/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    protocol: 'aht-launcher-proof-v1',
    launchId: 'launch-proof-test',
    username: 'TestRig',
    minecraftUsername: 'TestRig',
    installId: 'install-b',
    packId: 'a-hard-time-dregora',
    packVersion: '2.8.2',
    installedVersion: '2.8.2',
    appVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    instanceDirHash: 'abc123'
  })
});
if (
  !launcherProof.trusted
  || launcherProof.source !== 'worker'
  || launcherProof.signature?.alg !== 'HS256'
  || launcherProof.token.split('.').length !== 3
  || launcherProof.payload.minecraftUsername !== 'TestRig'
  || launcherProof.payload.installId !== 'install-b'
) {
  throw new Error(`Launcher proof signing failed: ${JSON.stringify(launcherProof)}`);
}

const fallbackProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-b'
  })
}), {
  ...env,
  LAUNCHER_PROOF_SECRET: '',
  AHT_LAUNCHER_PROOF_SECRET: 'aht-proof-secret'
}, {});
const fallbackProof = await fallbackProofResponse.json();
if (!fallbackProofResponse.ok || !fallbackProof.trusted || fallbackProof.source !== 'worker' || fallbackProof.token.split('.').length !== 3) {
  throw new Error(`AHT_LAUNCHER_PROOF_SECRET fallback did not sign proof: ${fallbackProofResponse.status} ${JSON.stringify(fallbackProof)}`);
}

const curseForgeOnlyProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-b'
  })
}), {
  AHT_DATA: env.AHT_DATA,
  CURSEFORGE_API_KEY: 'cf-key-is-not-a-proof-secret'
}, {});
const curseForgeOnlyProof = await curseForgeOnlyProofResponse.json();
if (curseForgeOnlyProofResponse.status !== 500 || !/LAUNCHER_PROOF_SECRET/i.test(curseForgeOnlyProof.error || '')) {
  throw new Error(`CurseForge API key should not sign launcher proofs: ${curseForgeOnlyProofResponse.status} ${JSON.stringify(curseForgeOnlyProof)}`);
}

const proofMismatchResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-c'
  })
}), env, {});
if (proofMismatchResponse.status !== 403) {
  throw new Error(`Expected launcher proof install mismatch rejection, got ${proofMismatchResponse.status}`);
}

const unauthDeveloperProofResponse = await worker.fetch(new Request('https://worker.test/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-b',
    launcherChannel: 'developer',
    developerClient: true,
    developerClientBypass: true,
    modIntegrityBypass: true
  })
}), env, {});
if (unauthDeveloperProofResponse.status !== 401) {
  throw new Error(`Expected unauthenticated developer proof rejection, got ${unauthDeveloperProofResponse.status}`);
}

const login = await jsonRequest('/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'secret' })
});
const auth = { Authorization: `Bearer ${login.token}` };
const developerLauncherProof = await jsonRequest('/api/launcher-proof', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify({
    minecraftUsername: 'TestRig',
    installId: 'install-b',
    launcherChannel: 'developer',
    developerClient: true,
    developerClientBypass: true,
    modIntegrityBypass: true,
    packId: 'a-hard-time-dregora',
    installedVersion: '2.8.2'
  })
});
if (
  developerLauncherProof.payload.launcherChannel !== 'developer'
  || !developerLauncherProof.payload.developerClientBypass
  || !developerLauncherProof.payload.modIntegrityBypass
) {
  throw new Error(`Authenticated developer proof did not include bypass flags: ${JSON.stringify(developerLauncherProof)}`);
}
const emptyLogs = await jsonRequest('/api/update-logs?limit=3');
if (emptyLogs.logs.length !== 0) {
  throw new Error(`Expected no update logs before publish, got ${JSON.stringify(emptyLogs)}`);
}
const publishedLog = await jsonRequest('/admin/update-logs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify({
    version: '2.8.2',
    title: 'AHT Update Feed',
    subtitle: 'Exact client ZIP installs and launcher proof telemetry.',
    text: '# Launcher Patch\nExact AHT client ZIP installs and launcher proof telemetry are now visible in the launcher.\n- Full log modal ready\n- Optional videos ready',
    image: { type: 'image', url: 'https://packs.example.com/update-media/banner.webp', path: 'update-media/banner.webp' },
    media: { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Patch video' }
  })
});
const publicLogs = await jsonRequest('/api/update-logs?limit=3');
const adminLogs = await jsonRequest('/admin/update-logs?limit=10', { headers: auth });
if (
  publishedLog.log.title !== 'AHT Update Feed'
  || publishedLog.log.subtitle !== 'Exact client ZIP installs and launcher proof telemetry.'
  || publishedLog.log.image?.url !== 'https://packs.example.com/update-media/banner.webp'
  || publishedLog.log.media?.type !== 'youtube'
  || !publishedLog.log.text.includes('Full log modal ready')
  || publicLogs.logs.length !== 1
  || publicLogs.logs[0].media?.type !== 'youtube'
  || adminLogs.logs.length !== 1
) {
  throw new Error(`Update log publish/list failed: ${JSON.stringify({ publishedLog, publicLogs, adminLogs })}`);
}
const summary = await jsonRequest('/admin/summary', { headers: auth });
const events = await jsonRequest('/admin/events?limit=10', { headers: auth });

if (summary.counts.installs !== 1 || summary.counts.changeReports !== 1 || summary.counts.uniqueIps !== 2) {
  throw new Error(`Unexpected summary counts: ${JSON.stringify(summary.counts)}`);
}
if (events.events.length !== 2) {
  throw new Error(`Expected 2 events, got ${events.events.length}`);
}
const changeEvent = events.events.find((item) => item.event?.type === 'local_changes');
if (!changeEvent?.ip || changeEvent.event.changes.counts.changed !== 2 || changeEvent.playerLabel !== 'TestRig') {
  throw new Error(`Local change event lost detail: ${JSON.stringify(changeEvent)}`);
}

console.log(JSON.stringify({ registration, launcherProof: { source: launcherProof.source, trusted: launcherProof.trusted, tokenParts: launcherProof.token.split('.').length }, developerLauncherProof: { bypass: developerLauncherProof.payload.modIntegrityBypass, channel: developerLauncherProof.payload.launcherChannel }, publishedLog, publicLogs, summary, events }, null, 2));
