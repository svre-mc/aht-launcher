import { createGameIncidentMonitor } from '../src/gameIncidentMonitor.js';
// One session, exact game root, no renderer, no account/developer credential store.
let bytes = 0, input = '';
let control, monitor;
process.on('message', message => {
  if (message && Number.isSafeInteger(message.gamePid)) {
    control = { launchId: message.launchId, gamePid: message.gamePid };
    if (monitor && control.launchId === monitor.launchId) monitor.setGamePid(control.gamePid);
  }
});
const timer = setTimeout(() => process.exit(1), 5000);
try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16384) throw new Error('Bootstrap too large.');
    input += chunk.toString('utf8');
  }
  clearTimeout(timer);
  const context = JSON.parse(input); input = '';
  if (typeof context.token !== 'string' || context.token.length > 8192) throw new Error('Invalid bootstrap.');
  monitor = await createGameIncidentMonitor(context);
  monitor.launchId = context.launchId;
  if (control?.launchId === context.launchId) monitor.setGamePid(control.gamePid);
  while (!(await monitor.tick()).done) await new Promise(resolve => setTimeout(resolve, 1000));
} catch { process.exitCode = 1; }
finally { clearTimeout(timer); if (process.connected) process.disconnect(); }
