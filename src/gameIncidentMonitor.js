import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { normalizeIncident } from './gameIncidentContract.js';
import { requestServiceJson } from './serviceTransport.js';

export async function containedFile(root, relative, create = false) {
  const realRoot = await fs.realpath(root);
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\\') || p.includes(':'))) throw new Error('Invalid diagnostic path.');
  let current = realRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (create) await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Redirected diagnostic directory.');
  }
  current = path.join(current, parts.at(-1));
  const stat = await fs.lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Redirected diagnostic file.');
  return current;
}

export async function createIncrementalReader(root, relative) {
  let offset = 0, identity = '', partial = '';
  const reader = async (baseline = false) => {
    const file = await containedFile(root, relative);
    const handle = await fs.open(file, 'r').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!handle) return [];
    try {
      const stat = await handle.stat(); const key = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if (identity !== key || stat.size < offset) { offset = 0; partial = ''; }
      identity = key;
      if (baseline) { offset = stat.size; return []; }
      const size = Math.min(65536, Math.max(0, stat.size - offset));
      if (!size) return [];
      const buffer = Buffer.alloc(size); const read = await handle.read(buffer, 0, size, offset);
      offset += read.bytesRead;
      const lines = (partial + buffer.toString('utf8', 0, read.bytesRead)).split(/\r?\n/);
      partial = lines.pop().slice(-8192);
      return lines.filter(line => Buffer.byteLength(line) <= 8192);
    } finally { await handle.close(); }
  };
  try { await reader(true); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return reader;
}

export function diagnosticSymbols(line) {
  // No arbitrary messages, player chat, command lines, URLs, paths or token values.
  const errorLine = /^\[[^\]]+\]\s+\[[^\]]*\/(?:ERROR|FATAL)\]/.test(line)
    || /^\s*(?:Caused by:|at (?:java|javax|sun|io|net|org|com)\.)/.test(line);
  if (!errorLine) return { exceptionClasses: [], stackFrames: [], fatal: false };
  return { exceptionClasses: [...line.matchAll(/\b((?:(?:java|javax|sun|io|net|org|com)\.[\w$.]+|[A-Z][\w$]*)(?:Exception|Error))\b/g)].map(m => m[1]).slice(0, 6),
    stackFrames: [...line.matchAll(/\bat ((?:java|javax|sun|io|net|org|com)\.[\w$.]+)\.([\w$]+)\([^):]*:(\d+)\)/g)].map(m => `${m[1]}#${m[2]}:${m[3]}`).slice(0, 8),
    fatal: /\/(?:FATAL)\]|\bOutOfMemoryError\b|EXCEPTION_ACCESS_VIOLATION/.test(line) };
}

export async function createGameIncidentMonitor(context, { send, now = Date.now, alive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
} } = {}) {
  if (!context?.launchId || !context?.instanceDir) throw new Error('Diagnostic context missing.');
  if (!send) {
    const endpoint = new URL(context.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || endpoint.pathname !== '/api/diagnostics/incidents') throw new Error('Invalid diagnostic endpoint.');
  }
  const journal = await createIncrementalReader(context.instanceDir, 'logs/aht-diagnostics/client-events.jsonl');
  const log = await createIncrementalReader(context.instanceDir, 'logs/latest.log');
  const connectionId = randomUUID(); const started = now();
  let pid = context.gamePid || 0, exited = false, retries = 0, nextSend = 0, lastError = '';
  let symbols = [], queue = [], history = [], fatalReported = false, fatalAt = 0, dirty = false;
  const reportFile = await containedFile(context.instanceDir, 'logs/aht-diagnostics/latest-client-report.json', true);
  const transport = send || (async event => {
    const result = await requestServiceJson(context.endpoint, { timeoutMs: 5000, maxBytes: 1024,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${context.token}` }, body: JSON.stringify(event) });
    if (!result.ok) throw Object.assign(new Error('Diagnostic delivery unavailable.'), { status: result.status });
  });
  async function save() {
    const body = { schemaVersion: 1, launchId: context.launchId, updatedAt: new Date(now()).toISOString(),
      delivery: queue.length ? 'pending' : 'delivered', pendingCount: queue.length, lastError, events: history };
    const temp = await containedFile(context.instanceDir, 'logs/aht-diagnostics/latest-client-report.json.tmp', true);
    await fs.writeFile(temp, JSON.stringify(body), { mode: 0o600 }); await fs.rename(temp, reportFile);
  }
  function enqueue(value) {
    const event = normalizeIncident({ ...value, launchId: context.launchId }, now());
    if (history.some(item => item.id === event.id)) return;
    queue = [...queue, event].slice(-32); history = [...history, event].slice(-32);
    dirty = true;
  }
  async function tick() {
    const instant = now();
    for (const line of await log()) {
      const signal = diagnosticSymbols(line);
      if (signal.exceptionClasses.length || signal.stackFrames.length) symbols.push({ ...signal, at: instant });
      symbols = symbols.filter(item => instant - item.at <= 15_000).slice(-16);
      if (signal.fatal && !fatalReported) {
        fatalReported = true;
        enqueue({ id: randomUUID(), connectionId, kind: 'fatal_error', occurredAt: new Date(instant).toISOString(),
          reasonCode: signal.exceptionClasses.some(c => c.endsWith('OutOfMemoryError')) ? 'out_of_memory' : 'exception', ...signal });
      }
      if (signal.fatal) fatalAt = instant;
    }
    for (const line of await journal()) {
      try {
        const event = JSON.parse(line);
        if (event.launchId !== context.launchId || Date.parse(event.occurredAt) < started - 1000) continue;
        if (event.kind === 'boot' && Number.isSafeInteger(event.pid) && event.pid > 0) pid = event.pid;
        const recent = symbols.filter(item => instant - item.at <= 15_000);
        enqueue({ ...event, exceptionClasses: [...new Set([...(event.exceptionClasses || []), ...recent.flatMap(s => s.exceptionClasses)])],
          stackFrames: [...new Set([...(event.stackFrames || []), ...recent.flatMap(s => s.stackFrames)])] });
      } catch { /* An incomplete or malformed observation never breaks Play. */ }
    }
    if (pid && !alive(pid) && !exited) {
      exited = true;
      enqueue({ id: randomUUID(), connectionId, kind: 'process_exit', reasonCode: fatalAt && instant - fatalAt <= 15000 ? 'process_crash'
        : history.some(item => item.kind === 'normal_exit') ? 'normal_exit' : 'unknown',
        occurredAt: new Date(instant).toISOString(), exceptionClasses: symbols.flatMap(s => s.exceptionClasses),
        stackFrames: symbols.flatMap(s => s.stackFrames), metrics: { exitCode: -1 } });
    }
    if (queue.length && instant >= nextSend) {
      try { await transport(queue[0]); queue.shift(); retries = 0; lastError = ''; nextSend = instant; dirty = true; }
      catch (error) { retries++; lastError = Number.isInteger(error.status) ? `HTTP_${error.status}` : 'TRANSPORT_UNAVAILABLE'; dirty = true;
        nextSend = instant + Math.min(60000, 2000 * 2 ** Math.min(retries, 5)); }
    }
    if (dirty) { await save(); dirty = false; }
    return { done: (exited && !queue.length) || instant - started >= 24 * 60 * 60 * 1000
      || (!pid && instant - started >= 10 * 60 * 1000) || (exited && retries >= 8), pending: queue.length };
  }
  return { tick, setGamePid(value) { if (Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff) pid = value; },
    get history() { return history; } };
}

// Credentials go through the child stdin pipe, never arguments or a bootstrap file.
export function startGameIncidentWorker(context, { executable = process.execPath, script, spawnImpl = spawn, onError = () => {} } = {}) {
  const endpoint = new URL(context.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/diagnostics/incidents')
    throw new Error('Invalid diagnostic endpoint.');
  const child = spawnImpl(executable, [script], { windowsHide: true, detached: true, shell: false,
    stdio: ['pipe', 'ignore', 'ignore', 'ipc'], env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' } });
  child.once('error', () => onError('WORKER_START_FAILED'));
  child.stdin.on('error', () => onError('WORKER_INPUT_FAILED'));
  child.stdin.end(JSON.stringify(context)); child.channel?.unref(); child.unref();
  return child;
}
