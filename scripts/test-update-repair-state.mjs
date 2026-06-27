import fs from 'node:fs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const main = fs.readFileSync('desktop/main.js', 'utf8').replace(/\r\n/g, '\n');
const renderer = fs.readFileSync('desktop/renderer/app.js', 'utf8').replace(/\r\n/g, '\n');

assert(main.includes('function createOperationState'), 'main process is missing operation state helper.');
assert(main.includes("updateState = createOperationState(forceRepair ? 'repair' : 'install'"), 'runUpdate must mark updateState running before slow setup work.');
assert(main.includes("updateState.progress = { ...(updateState.progress || {}), phase: 'Verifying installed files', percent: 98 };"), 'runUpdate must verify installed files before writing terminal success.');
assert(main.includes('const integrity = await scanCurrentManagedIntegrity(config, latestAfterInstall);'), 'runUpdate must scan the repaired install before saving integrity state.');
assert(main.includes("await writeIntegrityState(config, integrity, forceRepair ? 'repair' : 'install');"), 'runUpdate must save the real post-install integrity result.');
assert(main.includes('if (isFullClientRelease(release)) {\n    return [];\n  }'), 'full-client ZIP integrity must not pull legacy cache extras into required managed files.');
assert(main.includes('relativePath: normalizeRelPath(entry.installPath || `mods/${entry.fileName}`),'), 'cache-extra integrity must honor release cache installPath for resourcepacks.');
assert(main.includes('function refreshStaleIntegrityState(config, latest, integrity)'), 'status refresh must be able to self-heal stale cache-extra integrity state.');
assert(main.includes('integrity = await refreshStaleIntegrityState(config, latest, integrity);'), 'getStatus must refresh stale cache-extra integrity before blocking Play.');
assert(!main.includes("phase: 'Saving install state'"), 'runUpdate must not skip real integrity verification with a synthetic clean state.');
assert(main.includes("completeOperationState(updateState, result, 'Complete');"), 'runUpdate must normalize success to Complete.');
assert(main.includes("failOperationState(updateState, error, forceRepair ? 'Repair failed' : 'Update failed');"), 'runUpdate must normalize failure and clear running.');
assert(!main.includes('finally {\n    updateState.running = false;\n  }'), 'runUpdate must not rely on a bare finally running=false terminal state.');

assert(renderer.includes('const DOWNLOAD_COMPLETE_VISIBLE_MS = 2200;'), 'renderer must define the completed download visible window.');
assert(renderer.includes('const DOWNLOAD_ERROR_VISIBLE_MS = 6200;'), 'renderer must define a bounded failed download visible window.');
assert(renderer.includes('if (state.error) return terminalUpdateAgeMs(ensureTerminalUpdateTimestamp(state)) < DOWNLOAD_ERROR_VISIBLE_MS;'), 'failed installs must not pin sidebar progress forever.');
assert(renderer.includes('const visibleMs = lastUpdateState.error ? DOWNLOAD_ERROR_VISIBLE_MS : DOWNLOAD_COMPLETE_VISIBLE_MS;'), 'terminal update cleanup must use the correct success/error visibility window.');
assert(renderer.includes('scheduleCompletedUpdateClear(DOWNLOAD_ERROR_VISIBLE_MS);'), 'direct update failures must schedule failed progress cleanup.');
assert(renderer.includes('function shouldShowUpdateProgress(state)'), 'renderer is missing terminal progress visibility helper.');
assert(renderer.includes('return isSuccessfulUpdateState(state) && terminalUpdateAgeMs(state) < DOWNLOAD_COMPLETE_VISIBLE_MS;'), 'successful installs must not show progress forever.');
assert(renderer.includes('els.downloadsRowProgress.hidden = !progressVisible;'), 'downloads row progress must hide after terminal success clears.');
assert(renderer.includes('setProgress(shouldShowUpdateProgress(state), estimateProgress(state), updateProgressLabel(state));'), 'pollUpdate must use normalized progress visibility.');
assert(renderer.includes('if (shouldShowUpdateProgress(lastUpdateState))'), 'renderStatus must use normalized progress visibility.');
assert(!renderer.includes('lastUpdateState?.running || lastUpdateState?.lastResult || lastUpdateState?.error'), 'renderer must not treat lastResult as active progress forever.');
assert(renderer.includes('lastUpdateState = {\n    running: true,'), 'startUpdate must create an optimistic running state for first-click feedback.');
assert(renderer.includes('lastIntegrityScan = null;'), 'repair must clear stale scan results before starting.');
assert(renderer.includes('setUnavailable(els.scanButton, true);'), 'update and repair must lock Scan while installing.');
assert(renderer.includes('if (updatePoll || lastUpdateState?.running) return;'), 'scan completion cleanup must only wait for active installs, not completed update progress.');
assert(!renderer.includes('if (updatePoll || shouldShowUpdateProgress(lastUpdateState)) return;'), 'scan completion cleanup must not keep Scan complete visible because of stale terminal update state.');
assert(renderer.includes('setInterval(pollUpdate, 500)'), 'update polling should be responsive while installing.');
assert(renderer.includes('const completedKind = activeUpdateKind;'), 'repair completion must preserve the finished update kind before clearing it.');
assert(renderer.includes('completedKind === "repair"'), 'repair completion must use the preserved repair kind.');
assert(renderer.includes('els.diffSummary.textContent = "Clean";'), 'successful repair must clear stale corrupted-file summary text.');
assert(renderer.includes('closeRepairPrompt();'), 'successful repair must close any stale repair prompt.');

console.log(JSON.stringify({ ok: true }, null, 2));
