import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { githubPublishRequest } from '../src/githubPublishRequest.js';
import { publishModpackGithubRelease } from '../src/githubModpackRelease.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const stalled = () => new Promise(() => {});

test('a hung API call aborts with a useful error', async () => {
  let signal;
  await assert.rejects(githubPublishRequest(async (_url, opts) => { signal = opts.signal; return stalled(); },
    'https://api.example/test', {}, response => response.text(), { label: 'Mirror lookup', idleTimeoutMs: 25, requestTimeoutMs: 500 }), /Mirror lookup: no progress/);
  assert.equal(signal.aborted, true);
});

test('a response body that never finishes is also bounded', async () => {
  await assert.rejects(githubPublishRequest(async () => ({ text: stalled }), 'https://api.example/test', {},
    response => response.text(), { idleTimeoutMs: 25, requestTimeoutMs: 500 }), /no progress/);
});

test('an upload reports progress but never reports completion without acknowledgement', async () => {
  let bytes = 0;
  let waiting = false;
  const source = Readable.from([Buffer.alloc(10), Buffer.alloc(20)]);
  await assert.rejects(githubPublishRequest(async (_url, options) => {
    for await (const _chunk of options.body) { }
    return stalled();
  }, 'https://upload.example/test', { body: source }, response => response.text(), {
    idleTimeoutMs: 30, requestTimeoutMs: 500, onBytes: count => { bytes += count; }, onBodyComplete: () => { waiting = true; }
  }), /no progress/);
  assert.equal(bytes, 30);
  assert.equal(waiting, true);
  assert.equal(source.destroyed, true);
});

test('continued upload progress resets the stall timeout', async () => {
  const source = Readable.from((async function* () {
    for (let i = 0; i < 6; i++) { await delay(15); yield Buffer.alloc(10); }
  })());
  const result = await githubPublishRequest(async (_url, options) => {
    for await (const _chunk of options.body) { }
    return new Response('confirmed');
  }, 'https://upload.example/test', { body: source }, response => response.text(), { idleTimeoutMs: 60, requestTimeoutMs: 500 });
  assert.equal(result, 'confirmed');
});

test('both assets and final publication must complete before 100 percent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-github-progress-'));
  try {
    await fs.writeFile(path.join(root, 'client.zip'), Buffer.alloc(32));
    await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ packId: 'a-hard-time-dregora', channel: 'stable', version: '2.8.999', zip: { path: 'client.zip' } }));
    for (const failFinalization of [false, true]) {
      const events = [];
      const fetchImpl = async (url, options) => {
        if (options.method === 'POST' && options.body) {
          if (options.body?.[Symbol.asyncIterator]) for await (const _chunk of options.body) { }
          else if (typeof options.body.arrayBuffer === 'function') await options.body.arrayBuffer();
          return Response.json({ id: 12 });
        }
        if (options.method === 'PATCH') {
          assert(events.every(event => event.percent < 100));
          if (failFinalization) return stalled();
        }
        return Response.json({ id: 10, assets: [] });
      };
      const run = publishModpackGithubRelease({ repo: 'test/fixture', token: 'fixture-only', outDir: root,
        fetchImpl, onProgress: progress => events.push(progress), apiTimeoutMs: 40 });
      if (failFinalization) {
        await assert.rejects(run, /finalization: (no progress|request time limit)/);
        assert(events.every(event => event.percent < 100));
      } else {
        assert.equal((await run).ok, true);
        assert.equal(events.at(-1).percent, 100);
        assert.equal(events.at(-1).completed, events.at(-1).total);
        assert(events.some(event => event.phase.startsWith('GitHub confirmed')));
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

const renderer = await fs.readFile(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
const renderCode = renderer.slice(renderer.indexOf('function renderUploadState('), renderer.indexOf('function startUploadPolling('));
test('the UI distinguishes a live release, an uploading mirror and mirror failure', () => {
  const checks = [];
  const context = vm.createContext({
    setReleaseUploadProgress: () => {}, setReleaseCheck: (...args) => checks.push(args), formatBytes: n => String(n)
  });
  vm.runInContext(renderCode, context);
  context.renderUploadState({ stage: 'github', releaseTarget: 'ptb', running: true, progress: { percent: 40, total: 100, completed: 40, phase: 'Uploading ZIP' } });
  assert.equal(checks.at(-1)[1], 'Release live; mirroring to GitHub');
  assert.match(checks.at(-1)[2], /40 \/ 100/);
  assert.equal(checks.at(-1)[4], 'ptb');
  context.renderUploadState({ stage: 'github', running: false, error: 'Mirror timed out' });
  assert.equal(checks.at(-1)[0], 'warn');
  assert.match(checks.at(-1)[2], /live on R2/);
  context.renderUploadState({ stage: 'github', running: false, githubResult: { ok: true } });
  assert.equal(checks.at(-1)[1], 'Upload complete');
});

test('a delayed R2 poll cannot overwrite the newer mirror phase', async () => {
  let callback, resolvePoll, renderCount = 0;
  const polling = renderer.slice(renderer.indexOf('function startUploadPolling('), renderer.indexOf('async function buildReleaseFromSelectedZip('));
  const context = vm.createContext({
    window: { aht: { devUploadState: () => new Promise(resolve => { resolvePoll = resolve; }) } },
    setInterval: cb => { callback = cb; return 1; }, clearInterval: () => {},
    renderUploadState: () => { renderCount++; }
  });
  vm.runInContext('let uploadPoll; let uploadPollGeneration = 0;\n' + polling, context);
  context.startUploadPolling();
  const old = callback();
  context.startUploadPolling('github');
  resolvePoll({ running: false, lastResult: { ok: true } });
  await old;
  assert.equal(renderCount, 0);
});


for (const target of ['stable', 'ptb']) {
  for (const failUpload of [false, true]) {
    test(target + ': publication mirrors only after the player feed is live', async () => {
      const checks = [], busy = [];
      let mirrorCalls = 0, defaultsCalls = 0;
      const context = vm.createContext({
        window: { aht: {
          saveSettings: async () => {},
          devSyncR2: async payload => {
            assert.equal(payload.releaseTarget, target);
            if (failUpload) throw new Error('Upload failed');
            return { uploaded: [{ path: 'patch.zip' }, { path: 'unchanged', skipped: true }], verification: { publicLatestUrl: 'https://fixture.example/latest.json' } };
          },
          devPublishModpackGithub: async () => { mirrorCalls++; return { tagName: `fixture-${target}` }; },
          devUploadState: async () => null
        } },
        publishBlockReason: () => '', setReleaseCheck: (...args) => checks.push(args),
        setReleaseBusy: value => busy.push(value), showToast: () => {}, saveDeveloperSecrets: async () => {},
        serializeSettings: () => ({}), activeSidebarPack: 'aht', releaseFeedUrl: () => 'https://fixture.example/latest.json',
        validateSelectedRelease: async () => {}, missingFastR2UploadFields: () => [],
        setReleaseUploadProgress: () => {}, startUploadPolling: () => {}, clearInterval: () => {},
        developerOutDir: () => 'fixture', releaseBucketName: () => 'fixture', inputValue: (_input, fallback) => fallback,
        els: {}, writePlayerDefaultsForCurrentFeed: async () => { defaultsCalls++; },
        setDevLog: () => {}, cleanErrorMessage: error => error.message
      });
      const start = renderer.indexOf('async function publishSelectedRelease(');
      const code = renderer.slice(start, renderer.indexOf('els.setupCloudButton.addEventListener(', start));
      vm.runInContext('let uploadPoll; let uploadPollGeneration = 0;\n' + code, context);
      const outcome = await context.publishSelectedRelease(target);
      assert.equal(outcome.ok, !failUpload);
      assert.equal(busy.at(-1), false);
      assert.equal(mirrorCalls, failUpload ? 0 : 1);
      assert.equal(defaultsCalls, failUpload ? 0 : (target === 'stable' ? 1 : 0));
      assert.equal(checks.at(-1)[1], failUpload ? 'Publish failed' : target === 'ptb' ? 'PTB published' : 'Upload complete');
      if (!failUpload) assert.match(checks.at(-1)[3], /1 changed files uploaded; 1 unchanged files reused/);
    });
  }

  test(target + ': a mirror failure cannot roll back the live player feed', async () => {
    const checks = [];
    const context = vm.createContext({
      window: { aht: {
        saveSettings: async () => {},
        devSyncR2: async () => ({ uploaded: [], verification: { publicLatestUrl: 'https://fixture.example/latest.json' } }),
        devPublishModpackGithub: async () => { throw new Error('GitHub unavailable'); },
        devUploadState: async () => ({ stage: 'github', running: false, error: 'GitHub unavailable' })
      } },
      publishBlockReason: () => '', setReleaseCheck: (...args) => checks.push(args),
      setReleaseBusy: () => {}, showToast: () => {}, saveDeveloperSecrets: async () => {},
      serializeSettings: () => ({}), activeSidebarPack: 'aht', releaseFeedUrl: () => 'https://fixture.example/latest.json',
      validateSelectedRelease: async () => {}, missingFastR2UploadFields: () => [],
      setReleaseUploadProgress: () => {}, startUploadPolling: () => {}, clearInterval: () => {},
      developerOutDir: () => 'fixture', releaseBucketName: () => 'fixture', inputValue: (_input, fallback) => fallback,
      els: {}, writePlayerDefaultsForCurrentFeed: async () => {},
      setDevLog: () => {}, cleanErrorMessage: error => error.message, renderUploadState: () => {}
    });
    const start = renderer.indexOf('async function publishSelectedRelease(');
    const code = renderer.slice(start, renderer.indexOf('els.setupCloudButton.addEventListener(', start));
    vm.runInContext('let uploadPoll; let uploadPollGeneration = 0;\n' + code, context);
    const outcome = await context.publishSelectedRelease(target);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.partial, true);
    assert.equal(checks.at(-1)[1], 'Update published');
    assert.match(checks.at(-1)[2], /GitHub mirror incomplete/);
  });
}
