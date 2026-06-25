import fs from 'node:fs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const main = fs.readFileSync('desktop/main.js', 'utf8');
const renderer = fs.readFileSync('desktop/renderer/app.js', 'utf8');

assert(main.includes('function createOperationState'), 'main process is missing operation state helper.');
assert(main.includes("updateState = createOperationState(forceRepair ? 'repair' : 'install'"), 'runUpdate must mark updateState running before slow setup work.');
assert(main.includes("updateState.progress = { ...(updateState.progress || {}), phase: 'Saving install state', percent: 98 };"), 'runUpdate must leave installer Finalizing before writing terminal success.');
assert(main.includes("completeOperationState(updateState, result, 'Complete');"), 'runUpdate must normalize success to Complete.');
assert(main.includes("failOperationState(updateState, error, forceRepair ? 'Repair failed' : 'Update failed');"), 'runUpdate must normalize failure and clear running.');
assert(!main.includes('finally {\n    updateState.running = false;\n  }'), 'runUpdate must not rely on a bare finally running=false terminal state.');

assert(renderer.includes('const DOWNLOAD_COMPLETE_VISIBLE_MS = 2200;'), 'renderer must define the completed download visible window.');
assert(renderer.includes('function shouldShowUpdateProgress(state)'), 'renderer is missing terminal progress visibility helper.');
assert(renderer.includes('return isSuccessfulUpdateState(state) && terminalUpdateAgeMs(state) < DOWNLOAD_COMPLETE_VISIBLE_MS;'), 'successful installs must not show progress forever.');
assert(renderer.includes('els.downloadsRowProgress.hidden = !progressVisible;'), 'downloads row progress must hide after terminal success clears.');
assert(renderer.includes('setProgress(shouldShowUpdateProgress(state), estimateProgress(state), updateProgressLabel(state));'), 'pollUpdate must use normalized progress visibility.');
assert(renderer.includes('if (shouldShowUpdateProgress(lastUpdateState))'), 'renderStatus must use normalized progress visibility.');
assert(!renderer.includes('lastUpdateState?.running || lastUpdateState?.lastResult || lastUpdateState?.error'), 'renderer must not treat lastResult as active progress forever.');
assert(renderer.includes('lastUpdateState = {\n    running: true,'), 'startUpdate must create an optimistic running state for first-click feedback.');
assert(renderer.includes('lastIntegrityScan = null;'), 'repair must clear stale scan results before starting.');
assert(renderer.includes('setUnavailable(els.scanButton, true);'), 'update and repair must lock Scan while installing.');
assert(renderer.includes('setInterval(pollUpdate, 500)'), 'update polling should be responsive while installing.');

console.log(JSON.stringify({ ok: true }, null, 2));