import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function waitForNextPaint(');
const end = source.indexOf('\nfunction setSidebarSwitchLoader(', start);
assert(start >= 0 && end > start);

function harness(hidden = true) {
  const listeners = new Set();
  const document = { hidden, addEventListener: (_name, callback) => listeners.add(callback),
    removeEventListener: (_name, callback) => listeners.delete(callback) };
  const context = vm.createContext({ document, performance,
    window: { setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame() {} } });
  vm.runInContext(source.slice(start, end), context);
  return { context, document, listeners, hide: () => { document.hidden = true; for (const callback of [...listeners]) callback(); } };
}

test('occluded windows do not gate selection on an invisible animation', async () => {
  const { context } = harness();
  const view = { style: {} };
  const startTime = Date.now();
  await context.waitForNextPaint();
  await context.animateSidebarOpacity(view, 0, 1, 330);
  assert(Date.now() - startTime < 60, 'an occluded launcher waited for paint/animation before becoming ready');
  assert.equal(view.style.opacity, '1');
});

test('becoming hidden settles the active transition and releases listeners', async () => {
  const fixture = harness(false);
  const view = { style: {} };
  const operation = fixture.context.animateSidebarOpacity(view, 0, 1, 330);
  const startTime = Date.now();
  fixture.hide();
  await operation;
  assert(Date.now() - startTime < 60);
  assert.equal(fixture.listeners.size, 0);
  assert.equal(view.style.opacity, '1');
});
