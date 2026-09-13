import assert from 'node:assert/strict';
import test from 'node:test';
import * as entry from '../cloudflare/curseforge-proxy-worker.js';

test('the Worker entry module exports only its fetch handler and durable object class', () => {
  assert.deepEqual(Object.keys(entry).sort(), ['LauncherStateHub', 'default']);
  assert.equal(typeof entry.default.fetch, 'function');
  assert.equal(typeof entry.LauncherStateHub, 'function');
});
