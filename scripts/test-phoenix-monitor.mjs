import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoenixDetectionMonitor } from '../src/phoenixMonitor.js';

const context = { config: {}, launcherProof: { token: 'fixture-proof' }, nativeGuard: { keyHash: 'fixture-key' } };
const finding = { signedProbe: { verifiedFixture: true }, measurement: { state: 'tampered', detail: 'fixture' } };

test('temporary probe failures back off without making a finding or permanently stopping a live session', async () => {
  let attempts = 0, live = true;
  const reports = [], delays = [];
  const monitor = createPhoenixDetectionMonitor({
    isSessionAlive: () => live, fingerprint: () => 'finding',
    probe: async () => { if (++attempts <= 4) throw new Error('transport unavailable'); return finding; },
    report: async (...args) => { reports.push(args); live = false; },
    wait: async ms => { delays.push(ms); if (delays.length > 6) live = false; }
  });
  await monitor.start(context);
  assert.equal(attempts, 5); assert.equal(reports.length, 1);
  assert.deepEqual(delays, [5000, 10000, 15000, 15000]); assert.equal(monitor.activeCount, 0);
});

test('pending, incomplete, clean and transport errors cannot be reported as cheating', async () => {
  const states = ['pending', 'incomplete', 'clean', 'error']; let attempts = 0;
  const reports = [];
  const monitor = createPhoenixDetectionMonitor({
    isSessionAlive: () => attempts < states.length, fingerprint: () => 'finding', wait: async () => {},
    probe: async () => { const state = states[attempts++]; if (state === 'error') throw new Error('unavailable'); return { ...finding, measurement: { state } }; },
    report: async (...args) => reports.push(args)
  });
  await monitor.start(context);
  assert.equal(attempts, 4); assert.deepEqual(reports, []); assert.equal(monitor.activeCount, 0);
});

test('reports retry until acknowledged, then suppress duplicates for that native session', async () => {
  let attempts = 0, reports = 0;
  const monitor = createPhoenixDetectionMonitor({
    isSessionAlive: () => attempts < 4, fingerprint: () => 'finding', wait: async () => {},
    probe: async () => { attempts++; return finding; },
    report: async () => { if (++reports === 1) throw new Error('temporary service failure'); }
  });
  await monitor.start(context);
  assert.equal(reports, 2); assert.equal(attempts, 4); assert.equal(monitor.activeCount, 0);
});

test('stopping the launcher during a pending probe suppresses reporting and releases session state', async () => {
  let stopping = false;
  const monitor = createPhoenixDetectionMonitor({
    isStopping: () => stopping, fingerprint: () => 'finding',
    probe: async () => { stopping = true; return finding; },
    report: async () => assert.fail('No report after shutdown'), wait: async () => assert.fail('No delay after shutdown')
  });
  await monitor.start(context); assert.equal(monitor.activeCount, 0);
});
