// Opt-in, real-installation diagnostic. Does not download a pack or launch Minecraft.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const executable = process.env.AHT_PROBE_EXE;
const output = process.env.AHT_PROBE_OUTPUT;
if (!output) throw new Error('Set AHT_PROBE_OUTPUT to an evidence JSON path.');
const port = 20000 + Math.floor(Math.random() * 20000);
const started = Date.now();
const child = spawn(executable || path.resolve('node_modules/electron/dist/electron.exe'), executable ? [] : ['.'], {
  cwd: executable ? path.dirname(executable) : process.cwd(), windowsHide: true,
  env: { ...process.env, AHT_TEST_HOOKS: '1', AHT_TEST_REMOTE_DEBUG_PORT: String(port), AHT_TEST_STARTUP_PROBE_PATH: `${output}.jsonl` },
  stdio: 'ignore'
});
let socket;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
let sequence = 0;
function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 90000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async expression => {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
};
try {
  let target;
  while (Date.now() - started < 30000) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()).find(t => t.type === 'page'); } catch {}
    if (target) break;
    await delay(100);
  }
  if (!target) throw new Error('Launcher debugger unavailable');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  const samples = [];
  let state;
  while (Date.now() - started < 90000) {
    state = await evaluate(`({ booting: document.body?.classList.contains('is-booting'), timings: window.__ahtStartupTaskTimings, progress: document.querySelector('#startupLoadingPhase')?.textContent })`);
    samples.push({ elapsedMs: Date.now() - started, ...state });
    if (state.timings && state.booting === false) break;
    await delay(250);
  }
  const result = { executable: executable ? 'installed' : 'source', startupMs: Date.now() - started, state, samples };
  if (process.env.AHT_PROBE_VERIFY === '1') {
    const before = Date.now();
    result.verification = await evaluate(`window.aht.preparePlay('stable',{force:true}).then(x => ({state:x.launchPreparationState, error:x.launchBlockedReason, ready:x.launchReady, version:x.latest?.version, checked:x.integrity?.counts?.checked}))`);
    result.verificationMs = Date.now() - before;
  }
  if (process.env.AHT_PROBE_PLAY === '1') {
    const before = Date.now();
    result.play = await evaluate(`window.aht.play('stable').then(x => ({ok:x.ok, launched:x.launched, error:x.error})).catch(e => ({error:String(e.message)}))`);
    result.playMs = Date.now() - before;
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ startupMs: result.startupMs, state, verification: result.verification, verificationMs: result.verificationMs, play: result.play, playMs: result.playMs }));
  // Closing the renderer destroys the CDP response endpoint. Do not wait for a
  // response from that destroyed page (or leave a 90-second timeout behind).
  await delay(500);
} finally {
  socket?.close();
  for (const request of pending.values()) request.resolve({});
  pending.clear();
  if (child.exitCode === null) child.kill();
}
