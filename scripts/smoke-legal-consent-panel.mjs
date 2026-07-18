import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 9872);
const debuggerEndpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-legal-panel-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const minecraftRoot = path.join(root, '.minecraft');
const defaultsPath = path.join(root, 'app.defaults.json');
const screenshotPath = String(process.env.AHT_TEST_LEGAL_SCREENSHOT || '').trim();
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
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
      const response = await fetch(`${debuggerEndpoint}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page;
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
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({
      call(method, params = {}) {
        const id = nextId++;
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
      close() { socket.close(); }
    }), { once: true });
    socket.addEventListener('error', () => reject(new Error(`Failed to connect to ${wsUrl}`)), { once: true });
  });
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitFor(client, expression, label, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '9.9.9',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { url: `${workerEndpoint}/pack.zip`, size: 123, sha256: '0'.repeat(64) }
};

await fsp.mkdir(instanceDir, { recursive: true });
await fsp.mkdir(minecraftRoot, { recursive: true });
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'legal-panel-install',
  createdAt: '2026-07-01T00:00:00.000Z',
  minecraftUsername: 'LegalUser_1'
});
await writeJson(defaultsPath, {
  packId: 'a-hard-time-dregora',
  instanceDir,
  latestUrl: `${workerEndpoint}/latest.json`,
  sync: { enabled: false, sendLocalChanges: false, baseUrl: '', playerLabel: '' },
  launcherProof: { enabled: false, required: false, baseUrl: '' },
  social: { enabled: false },
  minecraftLauncher: { enabled: true, rootDir: minecraftRoot, profileId: 'a-hard-time', profileName: 'A Hard Time', memoryMb: 4096, autoImportAccount: false }
});

const server = http.createServer((request, response) => {
  if (request.url === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(latest));
    return;
  }
  response.statusCode = 404;
  response.end('not found');
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_APP_DEFAULTS: defaultsPath,
    AHT_TEST_HOOKS: '1',
    AHT_TEST_REQUIRE_LEGAL: '1',
    AHT_TEST_USER_DATA: userData,
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
  const visible = await waitFor(client, `
    (() => {
      const overlay = document.querySelector('#legalOverlay');
      const text = document.querySelector('#legalDocumentText')?.textContent || '';
      if (!overlay || overlay.hidden || !text.includes('SIIS ENTERPRISE LLC')) return false;
      return {
        brand: document.querySelector('#legalTitle')?.previousElementSibling?.textContent,
        title: document.querySelector('#legalTitle')?.textContent,
        acceptDisabled: document.querySelector('#legalAcceptButton')?.disabled,
        checkboxChecked: document.querySelector('#legalAcceptCheckbox')?.checked,
        termsText: text,
        version: document.querySelector('#legalVersion')?.textContent
      };
    })()
  `, 'versioned legal consent panel');
  if (visible.brand !== 'A Hard Time') throw new Error(`Legal panel used the wrong product brand: ${JSON.stringify(visible)}`);
  if (visible.title !== 'Terms have changed' || !visible.acceptDisabled || visible.checkboxChecked) throw new Error(`Legal clickwrap did not start unaccepted: ${JSON.stringify(visible)}`);
  if (!visible.termsText.includes('USD $10,000') || !visible.termsText.includes('not a government fine')) throw new Error('Terms did not contain the qualified contractual-remedies language.');
  await evaluate(client, `document.querySelector('#legalPrivacyTab').click(); true`);
  await waitFor(client, "document.querySelector('#legalDocumentText')?.textContent.includes('IP address') && document.querySelector('#legalDocumentText')?.textContent.includes('blocked players')", 'privacy document');
  const clicked = await evaluate(client, `
    (() => {
      const checkbox = document.querySelector('#legalAcceptCheckbox');
      checkbox.click();
      const style = getComputedStyle(checkbox);
      return {
        checked: checkbox.checked,
        acceptEnabled: !document.querySelector('#legalAcceptButton').disabled,
        width: checkbox.getBoundingClientRect().width,
        height: checkbox.getBoundingClientRect().height,
        appearance: style.appearance,
        accentColor: style.accentColor
      };
    })()
  `);
  if (!clicked.checked || !clicked.acceptEnabled || clicked.width > 24 || clicked.height > 24 || clicked.appearance === 'none') {
    throw new Error(`Legal checkbox did not visibly toggle from a real click: ${JSON.stringify(clicked)}`);
  }
  if (screenshotPath) {
    const screenshot = await client.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await fsp.mkdir(path.dirname(screenshotPath), { recursive: true });
    await fsp.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  }
  await evaluate(client, `document.querySelector('#legalAcceptButton').click(); true`);
  await waitFor(client, "document.querySelector('#legalOverlay').hidden === true", 'accepted legal panel dismissal');

  const status = await evaluate(client, 'window.aht.legalStatus()');
  if (status.required || !status.accepted) throw new Error(`Legal acceptance did not persist: ${JSON.stringify(status)}`);
  const record = JSON.parse(await fsp.readFile(path.join(userData, 'legal-consent.json'), 'utf8'));
  if (!record.affirmed || record.termsVersion !== '2026-07-14.1' || record.privacyVersion !== '2026-07-14.1' || record.termsSha256?.length !== 64 || record.privacySha256?.length !== 64) {
    throw new Error(`Legal consent record was incomplete: ${JSON.stringify(record)}`);
  }
  console.log(JSON.stringify({ ok: true, packaged: Boolean(smokeExe), version: visible.version, acceptedAt: record.acceptedAt }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
