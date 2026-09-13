import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('a reused Phoenix session reports against the latest Play authorization, not an old token', async () => {
  const source = (await fs.readFile(process.env.AHT_MONITOR_BASELINE || new URL('../desktop/main.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const start = source.indexOf('function queuePhoenixDetectionMonitor(');
  const code = source.slice(start, source.indexOf('\nfunction phoenixAntiCheatInstallDir(', start));
  let releaseProbe;
  const pending = new Promise(resolve => { releaseProbe = resolve; });
  const reported = [];
  const context = vm.createContext({
    isDeveloperMode: () => false, process: { platform: 'win32' }, applicationQuitting: false,
    phoenixDetectionMonitors: new Map(), phoenixDetectionReported: new Set(), PHOENIX_DETECTION_POLL_MS: 1,
    probeNativeGuard: async () => pending,
    phoenixDetectionFingerprint: () => 'same-detection',
    reportPhoenixDetection: async (_config, proof) => { reported.push(proof.token); context.applicationQuitting = true; },
    sleep: async () => {}
  });
  if (!process.env.AHT_MONITOR_BASELINE) {
    const { createPhoenixDetectionMonitor } = await import('../src/phoenixMonitor.js');
    context.phoenixDetectionMonitor = createPhoenixDetectionMonitor({
      probe: context.probeNativeGuard, report: context.reportPhoenixDetection, fingerprint: context.phoenixDetectionFingerprint,
      isStopping: () => context.applicationQuitting, isSessionAlive: () => true, wait: context.sleep
    });
  }
  vm.runInContext(code, context);
  const nativeGuard = { keyHash: 'same-session' };
  const first = context.queuePhoenixDetectionMonitor({ nativeGuard, launcherProof: { token: 'old-proof' } });
  const second = context.queuePhoenixDetectionMonitor({ nativeGuard, launcherProof: { token: 'fresh-proof' } });
  releaseProbe({ signedProbe: {}, measurement: { state: 'tampered' } });
  await Promise.all([first, second]);
  assert.deepEqual(reported, ['fresh-proof']);
});
