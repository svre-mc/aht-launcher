import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10910);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-error-details-copy-'));
const userData = path.join(root, 'userData');
const defaultsPath = path.join(root, 'app.defaults.json');
const capturePath = path.join(root, 'copied-error-report.json');
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function waitForTarget() {
  let lastError;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/list`);
      if (response.ok) {
        const payload = await response.json();
        const targets = Array.isArray(payload) ? payload : [];
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page;
        lastError = new Error(`no page target in ${JSON.stringify(payload).slice(0, 200)}`);
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Electron debugger target: ${lastError?.message || 'no target'}`);
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
    else resolve(message.result || {});
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve({
        call(method, params = {}) {
          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((callResolve, callReject) => {
            pending.set(id, { resolve: callResolve, reject: callReject });
            setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              callReject(new Error(`CDP call timed out: ${method}`));
            }, 30000);
          });
        },
        close() {
          socket.close();
        }
      });
    }, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Failed to connect to ${wsUrl}`)), { once: true });
  });
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(client, expression, label, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForReport() {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const text = await fsp.readFile(capturePath, 'utf8');
      if (text.trim()) return JSON.parse(text);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for captured error report: ${lastError?.message || 'missing report'}`);
}

async function removeCapture() {
  await fsp.rm(capturePath, { force: true }).catch(() => {});
}

async function clickPoint(client, x, y) {
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

await writeJson(defaultsPath, {
  packId: 'a-hard-time-dregora',
  latestUrl: `${workerEndpoint}/latest.json`,
  curseforge: { proxyBaseUrl: '', apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: true, sendLocalChanges: true, baseUrl: '', playerLabel: '' },
  launcherProof: { enabled: true, required: true, baseUrl: '', keyId: 'aht-launcher-proof-v1' },
  launcherUpdate: { enabled: false, latestUrl: '' },
  minecraftLauncher: {
    enabled: true,
    rootDir: path.join(root, '.minecraft'),
    profileId: 'a-hard-time',
    profileName: 'A Hard Time',
    memoryMb: 4096
  }
});

const failedUpdateLatest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '9.9.9',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: {
    fileName: 'missing-pack.zip',
    url: `${workerEndpoint}/packs/missing-pack.zip`,
    sha256: '0'.repeat(64),
    size: 123
  },
  curseforge: { disabled: true, fileCount: 0 },
  minecraft: {
    version: '1.12.2',
    modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }]
  }
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(failedUpdateLatest));
    return;
  }
  if (url.pathname === '/api/update-logs') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ logs: [] }));
    return;
  }
  response.statusCode = 404;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end('missing test artifact');
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_APP_DEFAULTS: defaultsPath,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_USER_DATA: userData,
    AHT_TEST_ERROR_REPORT_CAPTURE_PATH: capturePath,
    ELECTRON_ENABLE_LOGGING: '0'
  },
  stdio: 'ignore',
  windowsHide: true
});

let client;
try {
  const target = await waitForTarget();
  client = await connect(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await waitFor(client, "document.readyState === 'complete' && window.aht && document.querySelector('#toastStack')", 'renderer diagnostics DOM');
  const directCopy = await evaluate(client, `
    window.aht.copyErrorReport({
      title: 'Direct diagnostic smoke',
      message: 'Direct preload diagnostic route check.',
      detail: 'Direct preload diagnostic route check.',
      context: 'direct-diagnostic-smoke'
    }).then((result) => ({ ok: true, result })).catch((error) => ({ ok: false, message: String(error?.message || error || '') }))
  `);
  if (!directCopy.ok || Number(directCopy.result?.chars || 0) < 200) {
    throw new Error(`Preload diagnostic copy route did not call main diagnostics IPC: ${JSON.stringify(directCopy)}`);
  }
  const directReport = await waitForReport();
  if (directReport.title !== 'Direct diagnostic smoke' || directReport.rendererError?.context !== 'direct-diagnostic-smoke') {
    throw new Error(`Direct diagnostic report did not contain expected context: ${JSON.stringify(directReport, null, 2)}`);
  }
  await removeCapture();
  const toastProof = await evaluate(client, `
    (() => {
      showToast('Launch failed', 'Synthetic launch failure for diagnostics smoke.', 'error', { context: 'diagnostic-smoke' });
      const button = document.querySelector('.toast.error .toast-copy-action');
      if (!button) return { ok: false, reason: 'missing copy button', text: document.body.innerText };
      const rect = button.getBoundingClientRect();
      return {
        ok: true,
        buttonText: button.textContent,
        toastTitle: document.querySelector('.toast.error strong')?.textContent || '',
        toastDetail: document.querySelector('.toast.error span')?.textContent || '',
        click: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      };
    })()
  `);
  if (!toastProof.ok || toastProof.buttonText !== 'Copy full error details') {
    throw new Error(`Error toast did not expose the copy-details action: ${JSON.stringify(toastProof)}`);
  }
  await removeCapture();
  await clickPoint(client, toastProof.click.x, toastProof.click.y);
  const report = await waitForReport();
  if (
    report.title !== 'Launch failed'
    || report.rendererError?.message !== 'Synthetic launch failure for diagnostics smoke.'
    || report.rendererError?.context !== 'diagnostic-smoke'
    || !report.app?.version
    || !report.platform?.platform
    || !report.config
    || !report.minecraftRuntime?.configuredRoot
    || !Array.isArray(report.minecraftRuntime?.plannedRoutes)
    || report.minecraftRuntime?.profile?.profileId !== 'a-hard-time'
    || !report.operations?.update
  ) {
    throw new Error(`Captured error report is missing required diagnostic fields: ${JSON.stringify(report, null, 2)}`);
  }
  const successToast = await waitFor(client, `
    [...document.querySelectorAll('.toast.success strong')].some((node) => node.textContent === 'Error details copied')
  `, 'copy success toast');
  if (!successToast) {
    throw new Error('Copy success toast was not shown.');
  }
  await removeCapture();
  await evaluate(client, `
    startUpdate(false);
    true
  `);
  const updateToast = await waitFor(client, `
    (() => {
      const toast = [...document.querySelectorAll('.toast.error')]
        .reverse()
        .find((node) => (node.querySelector('strong')?.textContent || '') === 'Update failed');
      const button = toast?.querySelector('.toast-copy-action');
      if (!toast || !button) return false;
      const rect = button.getBoundingClientRect();
      return {
        title: toast.querySelector('strong')?.textContent || '',
        detail: toast.querySelector('span')?.textContent || '',
        buttonText: button.textContent || '',
        click: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      };
    })()
  `, 'update failure diagnostics toast');
  if (updateToast.buttonText !== 'Copy full error details') {
    throw new Error(`Update failure toast did not expose copy details: ${JSON.stringify(updateToast)}`);
  }
  await clickPoint(client, updateToast.click.x, updateToast.click.y);
  const updateReport = await waitForReport();
  const updateOperation = updateReport.operations?.update || {};
  if (
    updateReport.title !== 'Update failed'
    || updateReport.rendererError?.message !== updateToast.detail
    || updateOperation.kind !== 'install'
    || !/404|missing-pack|Download failed|Unable to download/i.test(updateOperation.error || '')
    || !Array.isArray(updateOperation.lines)
    || !updateOperation.lines.some((line) => /Reading release feed from 127\.0\.0\.1/i.test(line))
    || updateOperation.progress?.phase !== 'Update failed'
    || updateReport.config?.latestHost !== `127.0.0.1:${workerPort}`
    || !Array.isArray(updateReport.minecraftRuntime?.plannedRoutes)
    || !updateReport.minecraftRuntime?.executableCandidates
  ) {
    throw new Error(`Captured update failure report is missing operation diagnostics: ${JSON.stringify(updateReport, null, 2)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    root,
    packaged: Boolean(smokeExe),
    report: {
      title: report.title,
      app: report.app,
      rendererError: report.rendererError,
      latestConfigured: report.config.latestConfigured,
      operationKeys: Object.keys(report.operations || {}),
      updateFailure: {
        title: updateReport.title,
        error: updateOperation.error,
        lines: updateOperation.lines
      }
    }
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
