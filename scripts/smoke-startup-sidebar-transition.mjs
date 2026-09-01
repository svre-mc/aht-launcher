import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 9794);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const sidebarSwitchMaxMs = 2_500;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-startup-switch-'));
const userData = path.join(root, 'userData');
const stableInstanceDir = path.join(root, 'A Hard Time');
const ptbInstanceDir = path.join(root, 'A Hard Time PTB');
const minecraftRoot = path.join(root, '.minecraft');
const defaultsPath = path.join(root, 'app.defaults.json');
const screenshotDir = process.env.AHT_SMOKE_OUTPUT_DIR
  ? path.resolve(process.env.AHT_SMOKE_OUTPUT_DIR)
  : path.join(root, 'screenshots');
const electronArgsFor = (debugPort) => smokeExe
  ? [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function waitForTarget(debugEndpoint = endpoint) {
  let lastError;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(`${debugEndpoint}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        const page = pages.find((target) => (
          /(?:^|\/)index\.html(?:[?#]|$)/i.test(String(target.url || ''))
          && String(target.title || '').trim() === 'A Hard Time Launcher'
        ));
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for Electron debugger target at ${debugEndpoint}: ${lastError?.message || 'no target'}`);
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
          }, 30_000);
        });
      },
      close() { socket.close(); }
    }), { once: true });
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

async function waitFor(client, expression, label, attempts = 300, intervalMs = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function pointerClick(client, selector) {
  const point = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`Pointer target was unavailable: ${selector}`);
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function captureScreenshot(client, name) {
  await fsp.mkdir(screenshotDir, { recursive: true });
  const result = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(screenshotDir, `${name}.png`);
  await fsp.writeFile(file, Buffer.from(result.data, 'base64'));
  return file;
}

function assert(condition, message, evidence) {
  if (!condition) throw new Error(`${message}${evidence === undefined ? '' : `: ${JSON.stringify(evidence)}`}`);
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time',
  version: '2.0.0',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { path: 'packs/a-hard-time-2.0.0.zip', size: 123, sha256: '0'.repeat(64) }
};
const ptbLatest = {
  packId: 'a-hard-time-ptb',
  name: 'A Hard Time PTB',
  version: '2.1.0-ptb.1',
  channel: 'ptb',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { path: 'packs/a-hard-time-ptb-2.1.0-ptb.1.zip', size: 321, sha256: '1'.repeat(64) }
};

await writeJson(path.join(userData, 'identity.json'), {
  installId: 'startup-switch-smoke',
  createdAt: new Date().toISOString(),
  minecraftUsername: 'TransitionUser',
  usernameRegisteredAt: new Date().toISOString(),
  usernameRegistrationMode: 'smoke'
});
await writeJson(path.join(stableInstanceDir, '.aht-launcher', 'installed.json'), {
  schemaVersion: 1,
  packId: latest.packId,
  name: latest.name,
  version: '1.0.0',
  installedAt: new Date().toISOString(),
  minecraft: null,
  manifestFileCount: 0,
  overrideFileCount: 0
});
await fsp.mkdir(minecraftRoot, { recursive: true });
await writeJson(defaultsPath, {
  packId: latest.packId,
  latestUrl: `${workerEndpoint}/latest.json`,
  instanceDir: stableInstanceDir,
  packs: {
    ptb: {
      packId: ptbLatest.packId,
      name: ptbLatest.name,
      latestUrl: `${workerEndpoint}/ptb/latest.json`,
      instanceDir: ptbInstanceDir
    }
  },
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: true, sendLocalChanges: true, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  minecraftLauncher: { enabled: true, rootDir: minecraftRoot, profileId: latest.packId, profileName: 'A Hard Time', memoryMb: 6144 }
});

let stableLatestRequests = 0;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  const sendJson = (value, delayMs = 0) => {
    setTimeout(() => {
      if (response.destroyed) return;
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(value));
    }, delayMs);
  };
  if (url.pathname === '/latest.json') {
    const delayMs = stableLatestRequests++ === 0 ? 6_000 : 0;
    sendJson(latest, delayMs);
    return;
  }
  if (url.pathname === '/ptb/latest.json') {
    sendJson(ptbLatest, 680);
    return;
  }
  if (url.pathname === '/api/update-logs') {
    sendJson({ logs: [{ version: '2.0.0', title: 'Transition proof', body: 'Renderer transition fixture.' }] });
    return;
  }
  sendJson({ ok: true });
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

function spawnLauncher(debugPort) {
  return spawn(electronBin, electronArgsFor(debugPort), {
    cwd: electronCwd,
    env: {
      ...process.env,
      AHT_APP_DEFAULTS: defaultsPath,
      AHT_TEST_HOOKS: '1',
      AHT_TEST_REMOTE_DEBUG_PORT: String(debugPort),
      AHT_TEST_USER_DATA: userData,
      AHT_TEST_STATUS_FAILURE_COUNT: '2',
      ELECTRON_ENABLE_LOGGING: '0'
    },
    stdio: 'ignore',
    windowsHide: true
  });
}

async function waitForChildExit(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(timeoutMs).then(() => false)
  ]);
}

let child = spawnLauncher(port);
let quickChild = null;

let client;
const screenshots = [];
try {
  const target = await waitForTarget();
  client = await connect(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await client.call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
  });
  await client.call('Page.bringToFront');
  await client.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(client, "document.querySelector('#startupLoader') && document.querySelector('.app-frame')", 'startup DOM');
  await waitFor(client, "document.querySelector('#startupLoaderLabel')?.textContent === 'Initializing'", 'first-ever initialization label');

  const startupProof = await evaluate(client, `(() => {
    const loader = document.querySelector('#startupLoader');
    const frame = document.querySelector('.app-frame');
    const moneySystem = loader.querySelector('.money-loader-system');
    const progressRule = document.querySelector('#startupLoaderRule');
    const moneyRect = moneySystem.getBoundingClientRect();
    return {
      booting: document.body.classList.contains('is-booting'),
      loaderOpacity: Number(getComputedStyle(loader).opacity),
      loaderVisibility: getComputedStyle(loader).visibility,
      frameOpacity: Number(getComputedStyle(frame).opacity),
      frameVisibility: getComputedStyle(frame).visibility,
      frameInert: frame.hasAttribute('inert'),
      statusStillPending: document.querySelector('#launcherVersionLabel')?.textContent === 'Launcher v-',
      label: document.querySelector('#startupLoaderLabel')?.textContent || '',
      progressHidden: progressRule?.hidden,
      progressWidth: document.querySelector('#startupLoaderProgress')?.style.width || '',
      moneyLogoSrc: moneySystem.querySelector('.startup-money-logo')?.getAttribute('src') || '',
      moneyStarCount: moneySystem.querySelectorAll('.startup-orbit-star').length,
      legacyGlobePresent: Boolean(moneySystem.querySelector('.news-loader-globe')),
      moneyGeometry: [moneyRect.width, moneyRect.height, moneyRect.right, moneyRect.bottom]
    };
  })()`);
  assert(startupProof.booting && startupProof.loaderOpacity === 1 && startupProof.loaderVisibility === 'visible', 'Startup screen was not opaque while status was pending', startupProof);
  assert(startupProof.frameOpacity === 0 && startupProof.frameVisibility === 'hidden' && startupProof.frameInert, 'Partially loaded launcher shell was exposed', startupProof);
  assert(startupProof.label === 'Initializing' && startupProof.progressHidden === false, 'First-ever startup did not show Initializing with its progress rule beneath the AHT logo', startupProof);
  assert(startupProof.moneyLogoSrc === 'assets/aht-bill-transparent.png' && startupProof.moneyStarCount === 8 && !startupProof.legacyGlobePresent, 'Startup did not expose the required money-and-stars loader component', startupProof);
  screenshots.push(await captureScreenshot(client, 'startup-loading-screen'));

  try {
    await waitFor(client, "!document.body.classList.contains('is-booting') && document.querySelector('#startupLoader')?.hidden", 'startup reveal');
  } catch (error) {
    const diagnostic = await evaluate(client, `(() => ({
      bodyClass: document.body.className,
      loaderHidden: document.querySelector('#startupLoader')?.hidden,
      loaderOpacity: getComputedStyle(document.querySelector('#startupLoader')).opacity,
      documentReadyState: document.readyState,
      fontStatus: document.fonts?.status || '',
      launcherVersion: document.querySelector('#launcherVersionLabel')?.textContent || '',
      actionMode: document.querySelector('#playButton')?.dataset.actionMode || '',
      toastText: document.querySelector('#toastStack')?.innerText || ''
    }))()`);
    throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
  }
  const readyProof = await evaluate(client, `(() => {
    const button = document.querySelector('#playButton');
    return {
      label: button.textContent.trim(),
      background: getComputedStyle(button).backgroundImage,
      frameOpacity: Number(getComputedStyle(document.querySelector('.app-frame')).opacity),
      frameVisibility: getComputedStyle(document.querySelector('.app-frame')).visibility,
      activePack: document.querySelector('.game-tile.active')?.dataset.pack || '',
      actionMode: button.dataset.actionMode || '',
      installedVersion: document.querySelector('#installedVersion')?.textContent || '',
      latestVersion: document.querySelector('#latestVersion')?.textContent || ''
    };
  })()`);
  assert(readyProof.label === 'Update' && readyProof.actionMode === 'update' && readyProof.frameOpacity === 1 && readyProof.frameVisibility === 'visible' && readyProof.activePack === 'aht', 'Ready state was incomplete', readyProof);
  assert(!/190,\s*61,\s*51|217,\s*74,\s*62/.test(readyProof.background), 'Update action retained the saturated red palette', readyProof.background);
  screenshots.push(await captureScreenshot(client, 'startup-ready-update-palette'));

  const shellBefore = await evaluate(client, `(() => {
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    return { sidebar: [sidebar.x, sidebar.y, sidebar.width, sidebar.height], topbar: [topbar.x, topbar.y, topbar.width, topbar.height] };
  })()`);
  const switchStartedAt = Date.now();
  await pointerClick(client, '#ptbTileButton');
  const immediateProof = await evaluate(client, `(() => ({
    ptbSelected: document.querySelector('#ptbTileButton').classList.contains('active'),
    ahtSelected: document.querySelector('#gameTileButton').classList.contains('active'),
    switching: document.querySelector('.workspace').classList.contains('is-sidebar-switching'),
    viewOpacity: Number(getComputedStyle(document.querySelector('.view.active')).opacity),
    viewTransform: getComputedStyle(document.querySelector('.view.active')).transform
  }))()`);
  assert(immediateProof.ptbSelected && !immediateProof.ahtSelected && immediateProof.switching, 'Sidebar selection did not commit immediately', immediateProof);
  assert(immediateProof.viewOpacity > 0.98 && immediateProof.viewTransform === 'none', 'Outgoing view moved or faded before the measured lead-in', immediateProof);

  const exitProof = await waitFor(client, `(() => {
    const view = document.querySelector('.view.active');
    const style = getComputedStyle(view);
    const proof = {
      opacity: Number(style.opacity),
      leaving: view.classList.contains('sidebar-view-leaving'),
      transform: style.transform,
      transitionProperty: style.transitionProperty,
      transitionDuration: style.transitionDuration,
      transitionTimingFunction: style.transitionTimingFunction
    };
    return proof.leaving ? proof : false;
  })()`, 'outgoing sidebar opacity-only fade contract', 46, 5);
  assert(
    exitProof.leaving
      && exitProof.transitionProperty.split(',').map((value) => value.trim()).includes('opacity')
      && exitProof.transitionDuration.split(',').map((value) => value.trim()).includes('0.18s')
      && exitProof.transitionTimingFunction.split(',').map((value) => value.trim()).includes('ease-in')
      && exitProof.opacity >= 0
      && exitProof.opacity <= 1
      && exitProof.transform === 'none',
    'Outgoing view did not use the measured opacity-only fade',
    exitProof
  );

  const midProof = await waitFor(client, `(() => {
    const view = document.querySelector('.view.active');
    const workspace = document.querySelector('.workspace');
    const sidebar = document.querySelector('.sidebar');
    const topbar = document.querySelector('.topbar');
    const sidebarRect = sidebar.getBoundingClientRect();
    const topbarRect = topbar.getBoundingClientRect();
    const proof = {
      viewOpacity: Number(getComputedStyle(view).opacity),
      workspaceBusy: workspace.getAttribute('aria-busy'),
      sidebarOpacity: Number(getComputedStyle(sidebar).opacity),
      topbarOpacity: Number(getComputedStyle(topbar).opacity),
      entering: view.classList.contains('sidebar-view-entering-active'),
      transform: getComputedStyle(view).transform,
      transitionProperty: getComputedStyle(view).transitionProperty,
      transitionDuration: getComputedStyle(view).transitionDuration,
      transitionTimingFunction: getComputedStyle(view).transitionTimingFunction,
      sidebarLoaderPresent: Boolean(document.querySelector('#sidebarSwitchLoader')),
      shell: { sidebar: [sidebarRect.x, sidebarRect.y, sidebarRect.width, sidebarRect.height], topbar: [topbarRect.x, topbarRect.y, topbarRect.width, topbarRect.height] }
    };
    return proof.entering ? proof : false;
  })()`, 'incoming sidebar opacity-only fade contract', 100, 5);
  assert(!midProof.sidebarLoaderPresent && midProof.workspaceBusy === 'true', 'Sidebar switch restored a loading icon or failed to keep its short transition busy state', midProof);
  assert(midProof.sidebarOpacity === 1 && midProof.topbarOpacity === 1 && JSON.stringify(midProof.shell) === JSON.stringify(shellBefore), 'Fixed launcher chrome changed during the switch', { before: shellBefore, mid: midProof });
  const enterProof = { ...midProof, opacity: midProof.viewOpacity };
  assert(
    enterProof.entering
      && enterProof.transitionProperty.split(',').map((value) => value.trim()).includes('opacity')
      && enterProof.transitionDuration.split(',').map((value) => value.trim()).includes('0.33s')
      && enterProof.transitionTimingFunction.split(',').map((value) => value.trim()).includes('ease-out')
      && enterProof.opacity >= 0
      && enterProof.opacity <= 1
      && enterProof.transform === 'none'
      && !enterProof.sidebarLoaderPresent,
    'Incoming view did not use the measured opacity-only fade without a loading icon',
    enterProof
  );
  screenshots.push(await captureScreenshot(client, 'sidebar-switch-direct-transition'));
  screenshots.push(await captureScreenshot(client, 'sidebar-switch-entering'));

  const finalProof = await waitFor(client, `(() => {
    const workspace = document.querySelector('.workspace');
    const button = document.querySelector('#playButton');
    const activeView = document.querySelector('.view.active');
    if (workspace.classList.contains('is-sidebar-switching') || button?.dataset.actionMode !== 'install') return false;
    return {
      activePack: document.querySelector('.game-tile.active')?.dataset.pack || '',
      activeView: activeView?.id || '',
      viewOpacity: Number(getComputedStyle(activeView).opacity),
      sidebarLoaderPresent: Boolean(document.querySelector('#sidebarSwitchLoader')),
      label: button.textContent.trim(),
      background: getComputedStyle(button).backgroundImage,
      workspaceBusy: workspace.hasAttribute('aria-busy')
    };
  })()`, 'completed PTB transition');
  finalProof.elapsedMs = Date.now() - switchStartedAt;
  assert(finalProof.activePack === 'ptb' && finalProof.activeView === 'player' && finalProof.viewOpacity === 1 && !finalProof.sidebarLoaderPresent && !finalProof.workspaceBusy, 'Sidebar transition did not cleanly finish', finalProof);
  assert(finalProof.elapsedMs < sidebarSwitchMaxMs, 'Sidebar transition exceeded the bounded startup-prepared animation window', finalProof);
  assert(finalProof.label === 'Install' && finalProof.background !== readyProof.background, 'Install and Update palettes were not distinct', { update: readyProof, install: finalProof });
  assert(!/116,\s*164,\s*88|147,\s*201,\s*112/.test(finalProof.background), 'Install action retained the saturated green palette', finalProof.background);
  screenshots.push(await captureScreenshot(client, 'sidebar-switch-complete-install-palette'));

  const initializationMarker = JSON.parse(await fsp.readFile(path.join(userData, 'startup-initialization.json'), 'utf8'));
  assert(initializationMarker.completedAt && Array.isArray(initializationMarker.blockedPacks), 'First-ever startup did not persist its cross-version initialization marker', initializationMarker);

  await evaluate(client, "window.aht?.windowClose?.(); true").catch(() => {});
  client.close();
  client = null;
  if (!(await waitForChildExit(child))) child.kill();

  const quickPort = port + 2;
  const quickEndpoint = `http://127.0.0.1:${quickPort}`;
  quickChild = spawnLauncher(quickPort);
  const quickTarget = await waitForTarget(quickEndpoint);
  client = await connect(quickTarget.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await client.call('Page.bringToFront');
  await client.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(client, "document.querySelector('#startupLoader') && document.querySelector('.app-frame')", 'quick-relaunch startup DOM');
  const quickVisibleAt = Date.now();
  const quickStartupState = await evaluate(client, 'window.aht.getStartupPreparationState()');
  const quickLoadingProof = await evaluate(client, `(() => ({
    booting: document.body.classList.contains('is-booting'),
    label: document.querySelector('#startupLoaderLabel')?.textContent || '',
    progressHidden: document.querySelector('#startupLoaderRule')?.hidden,
    frameHidden: document.querySelector('.app-frame')?.getAttribute('aria-hidden') === 'true'
  }))()`);
  assert(quickStartupState.firstInitialization === false && quickStartupState.initialized === true, 'The persisted initialization marker was not reused on relaunch', quickStartupState);
  assert(quickLoadingProof.label === 'Loading launcher' && quickLoadingProof.progressHidden === true, 'A normal relaunch incorrectly restored the one-time Initializing progress UI', quickLoadingProof);
  await waitFor(client, "!document.body.classList.contains('is-booting')", 'quick relaunch reveal', 120, 40);
  const quickStartupElapsedMs = Date.now() - quickVisibleAt;
  const quickFinalState = await evaluate(client, 'window.aht.getStartupPreparationState()');
  assert(quickStartupElapsedMs < 5_000, 'Normal cached startup exceeded the five-second maximum', { quickStartupElapsedMs, quickStartupState, quickFinalState, quickLoadingProof });

  console.log(JSON.stringify({
    ok: true,
    mode: smokeExe ? 'installed' : 'source',
    startup: startupProof,
    quickRelaunch: { elapsedMs: quickStartupElapsedMs, state: quickStartupState, finalState: quickFinalState, loading: quickLoadingProof },
    ready: readyProof,
    transition: { immediate: immediateProof, exit: exitProof, mid: midProof, enter: enterProof, final: finalProof },
    screenshots
  }, null, 2));
} finally {
  if (client) {
    await evaluate(client, "window.aht?.windowClose?.(); true").catch(() => {});
    client.close();
  }
  if (!child.killed) child.kill();
  if (quickChild && !quickChild.killed) quickChild.kill();
  const closePromise = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closePromise;
}
