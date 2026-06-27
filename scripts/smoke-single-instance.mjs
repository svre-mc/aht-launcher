import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10200);
const firstEndpoint = `http://127.0.0.1:${port}`;
const secondEndpoint = `http://127.0.0.1:${port + 1}`;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-single-instance-'));
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

function argsFor(debugPort) {
  return smokeExe
    ? [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`]
    : ['.', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnApp(debugPort) {
  return spawn(electronBin, argsFor(debugPort), {
    cwd: electronCwd,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    stdio: 'ignore',
    windowsHide: true
  });
}

async function debuggerTargets(endpoint) {
  const response = await fetch(`${endpoint}/json/list`);
  if (!response.ok) {
    throw new Error(`${endpoint}/json/list returned ${response.status}`);
  }
  return response.json();
}

async function waitForTarget(endpoint, label) {
  let lastError;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const targets = await debuggerTargets(endpoint);
      const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (pages.length) return pages;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message || 'no target'}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

const first = spawnApp(port);
let second = null;
try {
  const firstTargets = await waitForTarget(firstEndpoint, 'first launcher instance');
  second = spawnApp(port + 1);
  const secondExit = await waitForExit(second, 15000);
  await sleep(1000);

  let secondDebuggerAvailable = false;
  try {
    const secondTargets = await debuggerTargets(secondEndpoint);
    secondDebuggerAvailable = secondTargets.some((target) => target.type === 'page');
  } catch {
    secondDebuggerAvailable = false;
  }

  const firstStillRunning = first.exitCode === null && !first.killed;
  const firstTargetsAfter = await debuggerTargets(firstEndpoint);
  const firstPageCount = firstTargetsAfter.filter((target) => target.type === 'page').length;
  if (!firstStillRunning) {
    throw new Error('Primary launcher exited after duplicate launch.');
  }
  if (secondDebuggerAvailable) {
    throw new Error('Duplicate launcher opened its own debugger target.');
  }
  if (firstPageCount !== 1) {
    throw new Error(`Expected one primary launcher page after duplicate launch, got ${firstPageCount}`);
  }

  console.log(JSON.stringify({
    ok: true,
    userData,
    firstPid: first.pid,
    secondPid: second.pid,
    secondExit,
    firstPageCountBefore: firstTargets.length,
    firstPageCountAfter: firstPageCount,
    duplicateDebuggerOpened: secondDebuggerAvailable
  }, null, 2));
} finally {
  if (second && second.exitCode === null) {
    second.kill();
  }
  first.kill();
}
