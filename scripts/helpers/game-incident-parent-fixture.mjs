import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGameIncidentWorker } from '../../src/gameIncidentMonitor.js';
let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 16384) process.exit(1); }
const context = JSON.parse(input);
const child = startGameIncidentWorker(context, {
  executable: path.resolve('node_modules/electron/dist/electron.exe'),
  script: process.env.AHT_DIAG_HELPER_SCRIPT || fileURLToPath(new URL('../../desktop/game-diagnostics-worker.mjs', import.meta.url))
});
process.stdout.write(JSON.stringify({ pid: child.pid }) + '\n');
setTimeout(() => {
  child.send({ launchId: context.launchId, gamePid: 2147483646 }, () => {});
  setTimeout(() => process.exit(0), 50);
}, 500);
