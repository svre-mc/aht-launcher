import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const [main, renderer, workflow] = await Promise.all([
  fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../.github/workflows/publish-modpack-delta.yml', import.meta.url), 'utf8')
]);

const syncStart = main.indexOf('async function syncR2(');
const syncEnd = main.indexOf('\nfunction localReleasePath(', syncStart);
assert(syncStart >= 0 && syncEnd > syncStart, 'Could not isolate the R2 release transaction.');
const sync = main.slice(syncStart, syncEnd);
assert(sync.includes("const targetLatestUrl = releaseTargetFeedUrl(publicLatestUrl || config.latestUrl || '', target.id);")
  && sync.includes('verifyRemoteRelease({ publicLatestUrl: targetLatestUrl, localLatest'),
'R2 publication is not pinned to the explicitly requested stable/PTB feed.');
const withholdIndex = sync.indexOf("new Set(['latest.json', normalizeRelPath(localLatest.zip?.path || '')])");
const remoteWaitIndex = sync.indexOf('await waitForGithubWorkflowRun');
const compareAndSwapIndex = sync.indexOf('const liveBeforeCommit = await r2Direct.getR2JsonDirect');
const commitMessageIndex = sync.indexOf('Committing ${canonicalLatestKey} after the remote artifact readback.');
const commitUploadIndex = sync.indexOf('key: canonicalLatestKey', commitMessageIndex);
assert(withholdIndex >= 0, 'Incremental publication did not withhold the local full ZIP and live pointer.');
assert(remoteWaitIndex > withholdIndex, 'Remote rebuild was not ordered after changed-file staging.');
assert(compareAndSwapIndex > remoteWaitIndex, 'Live channel compare-and-swap must run after the remote rebuild.');
assert(commitUploadIndex > compareAndSwapIndex, 'latest.json was not committed last after the live baseline readback.');
assert(sync.includes('Reused the already verified remote full-ZIP rebuild from the interrupted publish.'), 'Interrupted publication cannot resume a completed immutable rebuild.');
assert(sync.includes("liveLatest.remoteBuild?.method === 'changed-files'")
  && sync.includes("liveLatest.remoteBuild?.candidateId || '') === modpackRebuildCandidateId(localLatest)")
  && sync.includes('await writeJsonFile(localLatestPath, liveLatest);'),
'A completed remote rebuild is not recognized as the same content-bound release on retry.');
assert(sync.includes('no pointer was overwritten'), 'Concurrent channel changes must stop the transaction without overwriting latest.json.');

assert(renderer.includes('function stablePlayerFeedUrl()')
  && renderer.includes('return target === "ptb" ? ptbPlayerFeedUrl() : stablePlayerFeedUrl();'),
'Release Builder does not derive stable/PTB feeds independently of the selected sidebar pack.');

const putLines = workflow.split(/\r?\n/).filter((line) => /r2 object put/i.test(line));
assert.equal(putLines.length, 1, 'Wrangler uploads only the private result; the full ZIP uses multipart upload.');
assert(workflow.includes('node scripts/upload-rebuilt-modpack.mjs rebuild-plan.json rebuild-result.json'));
assert(!workflow.match(/r2 object put[\s\S]{0,180}(?:^|\/)latest\.json/m), 'Remote workflow must never commit a public latest.json pointer.');
assert(workflow.includes('group: aht-modpack-rebuild-${{ inputs.release_target }}'), 'Remote rebuilds are not serialized per channel.');

console.log(JSON.stringify({ ok: true, transaction: 'commit-last', remoteWorkflowCommitsLatest: false }, null, 2));
