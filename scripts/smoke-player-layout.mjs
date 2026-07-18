import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 9760);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-player-layout-'));
const userData = path.join(root, 'userData');
const minecraftRoot = path.join(root, '.minecraft');
const ptbInstanceDir = path.join(root, 'A Hard Time PTB');
const tempDefaults = path.join(root, 'app.defaults.json');
const defaultsPath = tempDefaults;
const screenshotDir = path.join(root, 'screenshots');
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
    if (message.error) {
      reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
    } else {
      resolve(message.result || {});
    }
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

async function waitFor(client, expression, label, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function setWindowSize(client, _targetId, width, height) {
  await evaluate(client, `window.resizeTo(${Number(width)}, ${Number(height)}); window.moveTo(0, 0); true`);
  await sleep(600);
}

async function captureScreenshot(client, name) {
  await fsp.mkdir(screenshotDir, { recursive: true });
  const result = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(screenshotDir, `${name}.png`);
  await fsp.writeFile(file, Buffer.from(result.data, 'base64'));
  return file;
}

async function click(client, selector) {
  await evaluate(client, `document.querySelector(${JSON.stringify(selector)})?.click(); true`);
  await sleep(400);
}

async function assertLayout(client, label) {
  const report = await evaluate(client, `
    (() => {
      const visible = (el) => {
        if (!el || el.hidden) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const describe = (el) => {
        const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        return {
          selector: el.id ? '#' + el.id : el.className ? '.' + String(el.className).trim().replace(/\\s+/g, '.') : el.tagName.toLowerCase(),
          text: text.slice(0, 80),
          rect: (() => {
            const rect = el.getBoundingClientRect();
            return { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) };
          })(),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight
        };
      };
      const horizontalOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth + 2;
      const visibleButtons = [...document.querySelectorAll('button')].filter(visible);
      const clippedButtons = visibleButtons
        .filter((button) => button.scrollWidth > button.clientWidth + 3 || button.scrollHeight > button.clientHeight + 3)
        .map(describe);
      const critical = [...document.querySelectorAll('.app-frame, .sidebar, .workspace, .topbar, .profile-card, .game-tile, .hero-panel, .news-grid, .quick-actions, .launch-strip, .settings-panel, .downloads-panel, .modal-card, .status-pill')]
        .filter(visible)
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < -2 || rect.right > window.innerWidth + 2;
        })
        .map(describe);
      const visibleDeveloperText = !document.querySelector('#developerConsole')?.hidden && document.body.innerText.includes('Developer Console');
      return {
        label: ${JSON.stringify(label)},
        viewport: { width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth },
        activeView: document.querySelector('.view.active')?.id || '',
        horizontalOverflow,
        clippedButtons,
        critical,
        visibleDeveloperText,
        bodyText: document.body.innerText.slice(0, 1000)
      };
    })()
  `);
  const failures = [];
  if (report.horizontalOverflow) failures.push('horizontal overflow');
  if (report.clippedButtons.length) failures.push(`clipped buttons: ${JSON.stringify(report.clippedButtons.slice(0, 5))}`);
  if (report.critical.length) failures.push(`critical elements outside viewport: ${JSON.stringify(report.critical.slice(0, 5))}`);
  if (report.visibleDeveloperText) failures.push('developer console visible in player UI');
  if (/NSIS|DMG app|package target|build -/i.test(report.bodyText)) failures.push('technical package/build wording visible in player UI');
  if (/CurseForge|fallback cache|Exact AHT client ZIP/i.test(report.bodyText)) failures.push('technical release-source wording visible in player UI');
  if (failures.length) {
    throw new Error(`Layout check failed for ${label}: ${failures.join('; ')}\n${JSON.stringify(report, null, 2)}`);
  }
  return report;
}

const latest = {
  packId: 'a-hard-time-dregora',
  name: 'A Hard Time Dregora',
  version: '9.9.9',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { path: 'packs/a-hard-time-9.9.9.zip', size: 123, sha256: '0'.repeat(64) }
};
const ptbLatest = {
  packId: 'a-hard-time-ptb',
  name: 'A Hard Time PTB',
  version: '10.0.0-ptb.1',
  channel: 'ptb',
  required: true,
  installMode: 'full-client-zip',
  zipFormat: 'aht-full-client-zip',
  zip: { path: 'packs/a-hard-time-ptb-10.0.0-ptb.1.zip', size: 321, sha256: '1'.repeat(64) }
};

await writeJson(path.join(userData, 'identity.json'), {
  installId: 'layout-smoke-install',
  createdAt: new Date().toISOString(),
  minecraftUsername: 'LayoutUser_1',
  usernameRegisteredAt: new Date().toISOString(),
  usernameRegistrationMode: 'layout-smoke'
});
await fsp.mkdir(minecraftRoot, { recursive: true });

await writeJson(defaultsPath, {
  packId: 'a-hard-time-dregora',
  latestUrl: `${workerEndpoint}/latest.json`,
  packs: {
    ptb: {
      packId: 'a-hard-time-ptb',
      name: 'A Hard Time PTB',
      latestUrl: `${workerEndpoint}/ptb/latest.json`,
      instanceDir: ptbInstanceDir
    }
  },
  curseforge: { proxyBaseUrl: `${workerEndpoint}/cf/`, apiKeyEnv: 'CURSEFORGE_API_KEY' },
  sync: { enabled: true, sendLocalChanges: true, baseUrl: `${workerEndpoint}/`, playerLabel: '' },
  launcherProof: { enabled: true, required: true, baseUrl: `${workerEndpoint}/`, keyId: 'aht-launcher-proof-v1' },
  minecraftLauncher: { enabled: true, rootDir: minecraftRoot, profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 4096 }
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(latest));
    return;
  }
  if (url.pathname === '/ptb/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(ptbLatest));
    return;
  }
  if (url.pathname === '/api/update-logs') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ logs: [
      { version: '9.9.9', title: 'Launcher Stability Pass', body: 'Exact client ZIP installs, clean repair gates, and Minecraft Launcher handoff.' },
      { version: '9.9.8', title: 'Download Flow Cleaned Up', body: 'Progress, retry handling, and final states stay responsive.' },
      { version: '9.9.7', title: 'Player Privacy Pass', body: 'Developer-only fields stay out of the regular launcher.' }
    ] }));
    return;
  }
  if (url.pathname === '/api/users/register' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const payload = JSON.parse(body || '{}');
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true, username: payload.username || 'LayoutUser_1' }));
    });
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => server.listen(workerPort, '127.0.0.1', resolve));

const child = spawn(electronBin, electronArgs, {
  cwd: electronCwd,
  env: {
    ...process.env,
    AHT_APP_DEFAULTS: tempDefaults,
    AHT_TEST_HOOKS: '1',
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
  await client.call('Page.enable');
  await waitFor(client, "document.readyState === 'complete' && window.aht && document.querySelector('#accountOverlay')", 'player DOM');
  const status = await waitFor(client, "window.aht.getStatus().then((status) => status.latest?.version === '9.9.9' ? status : false)", 'layout latest feed');
  if (/curseforge[\\/]+minecraft[\\/]+install/i.test(String(status.config?.minecraftLauncher?.rootDir || ''))) {
    throw new Error(`Player layout should not show a CurseForge Minecraft Launcher root by default: ${JSON.stringify(status.config?.minecraftLauncher)}`);
  }
  const minecraftProfileProof = await waitFor(client, `
    (() => ({
      enabled: document.querySelector('#minecraftProfileEnabledInput')?.checked === true,
      rootDir: document.querySelector('#minecraftRootInput')?.value || '',
      profileName: document.querySelector('#minecraftProfileNameInput')?.value || ''
    }))()
  `, 'layout Minecraft profile setting');
  if (
    !minecraftProfileProof.enabled
    || path.resolve(minecraftProfileProof.rootDir) !== path.resolve(minecraftRoot)
    || minecraftProfileProof.profileName !== 'A Hard Time'
  ) {
    throw new Error(`Player layout did not render Minecraft profile integration as enabled: ${JSON.stringify({ minecraftProfileProof, minecraftRoot })}`);
  }
  const sidebarVersionProof = await waitFor(client, `
    (() => {
      const sidebarVersion = document.querySelector('#sideInstalledVersion')?.textContent?.trim();
      const latestVersion = document.querySelector('#latestVersion')?.textContent?.trim();
      return sidebarVersion ? { sidebarVersion, latestVersion } : false;
    })()
  `, 'sidebar installed version label');
  const expectedSidebarVersion = status.installed?.version ? `v.${status.installed.version}` : 'Not Installed';
  if (
    sidebarVersionProof.sidebarVersion !== expectedSidebarVersion
    || (expectedSidebarVersion !== sidebarVersionProof.latestVersion && sidebarVersionProof.sidebarVersion === sidebarVersionProof.latestVersion)
  ) {
    throw new Error(`Sidebar must show installed version truth, not latest feed version: ${JSON.stringify(sidebarVersionProof)}`);
  }
  const launcherVersionProof = await waitFor(client, `
    (() => {
      const label = document.querySelector('#launcherVersionLabel')?.textContent?.trim();
      return label && /Launcher v\\d+\\.\\d+\\.\\d+/.test(label) ? { label } : false;
    })()
  `, 'visible launcher version label');
  if (!launcherVersionProof.label.includes(status.appVersion)) {
    throw new Error(`Launcher version label must show the running app version: ${JSON.stringify({ launcherVersionProof, appVersion: status.appVersion })}`);
  }
  const launcherVisualProof = await waitFor(client, `
    (() => {
      const frame = document.querySelector('.app-frame');
      const workspace = document.querySelector('.workspace');
      const heroPanel = document.querySelector('.hero-panel');
      const heroArt = document.querySelector('.hero-art');
      const actions = document.querySelector('.quick-actions');
      const scanButton = document.querySelector('#scanButton');
      return frame && workspace && heroPanel && heroArt && actions && scanButton ? {
        frameBackground: getComputedStyle(frame).backgroundImage,
        workspaceBackground: getComputedStyle(workspace).backgroundImage,
        heroBeforeBackground: getComputedStyle(heroPanel, '::before').backgroundImage,
        heroAfterBackground: getComputedStyle(heroPanel, '::after').backgroundImage,
        heroArtAfterBackground: getComputedStyle(heroArt, '::after').backgroundImage,
        repairText: scanButton.textContent.trim(),
        repairIcon: scanButton.querySelector('.button-icon')?.className || '',
        actionsMarginTop: parseFloat(getComputedStyle(actions).marginTop || '0')
      } : false;
    })()
  `, 'launcher background and repair quick action');
  if (
    launcherVisualProof.frameBackground !== 'none'
    || !launcherVisualProof.workspaceBackground.includes('launcher-background.png')
  ) {
    throw new Error(`Launcher must draw the high-resolution background once on the player workspace: ${JSON.stringify(launcherVisualProof)}`);
  }
  if (
    launcherVisualProof.heroBeforeBackground !== 'none'
    || launcherVisualProof.heroAfterBackground !== 'none'
    || launcherVisualProof.heroArtAfterBackground !== 'none'
  ) {
    throw new Error(`Launcher background must not be covered by decorative hero overlays: ${JSON.stringify(launcherVisualProof)}`);
  }
  if (launcherVisualProof.repairText !== 'Repair' || !launcherVisualProof.repairIcon.includes('icon-wrench')) {
    throw new Error(`Quick action must be labeled Repair with the wrench icon: ${JSON.stringify(launcherVisualProof)}`);
  }
  if (launcherVisualProof.actionsMarginTop < 10) {
    throw new Error(`Repair/Game settings buttons need positive spacing above them: ${JSON.stringify(launcherVisualProof)}`);
  }
  const sidebarIconProof = await waitFor(client, `
    (() => {
      const tile = document.querySelector('#gameTileButton');
      return tile ? {
        hasDownloadIcon: Boolean(tile.querySelector('.icon-download')),
        hasVersionDot: Boolean(tile.querySelector('.sidebar-version-dot'))
      } : false;
    })()
  `, 'sidebar installed version indicator');
  if (sidebarIconProof.hasDownloadIcon || !sidebarIconProof.hasVersionDot) {
    throw new Error(`Sidebar installed-version label must use a neutral status dot, not a download icon: ${JSON.stringify(sidebarIconProof)}`);
  }
  const sidebarArtProof = await waitFor(client, `
    (() => {
      const thumbs = [...document.querySelectorAll('.game-list .game-thumb.bill-art')];
      return thumbs.length >= 2 ? thumbs.map((thumb) => ({
        className: thumb.className,
        before: getComputedStyle(thumb, '::before').content,
        after: getComputedStyle(thumb, '::after').content,
        backgroundImage: getComputedStyle(thumb).backgroundImage
      })) : false;
    })()
  `, 'sidebar AHT thumbnail art');
  const dirtySidebarArt = sidebarArtProof.filter((thumb) => thumb.before !== 'none' || thumb.after !== 'none');
  if (dirtySidebarArt.length) {
    throw new Error(`Sidebar AHT thumbnails must not inherit large cover-art overlays: ${JSON.stringify(dirtySidebarArt)}`);
  }
  if (!sidebarArtProof.every((thumb) => thumb.backgroundImage.includes('aht-bill-transparent.png'))) {
    throw new Error(`Sidebar AHT thumbnails must use the transparent bill asset: ${JSON.stringify(sidebarArtProof)}`);
  }
  const sidebarPackProof = await waitFor(client, `
    (() => {
      const tiles = [...document.querySelectorAll('.game-list .game-tile')].map((tile) => ({
        id: tile.id || '',
        pack: tile.dataset.pack || '',
        title: tile.querySelector('.game-copy strong')?.textContent?.trim() || '',
        subtitle: tile.querySelector('.game-copy small')?.textContent?.trim() || '',
        disabled: tile.disabled === true,
        active: tile.classList.contains('active')
      }));
      return tiles.length >= 3 ? tiles : false;
    })()
  `, 'sidebar pack order');
  const expectedPackOrder = ['AHT', 'PTB', 'AHT 3.0'];
  if (
    sidebarPackProof.slice(0, 3).map((tile) => tile.title).join('|') !== expectedPackOrder.join('|')
    || sidebarPackProof[1].pack !== 'ptb'
    || !/Public test build/i.test(sidebarPackProof[1].subtitle)
    || sidebarPackProof[2].disabled !== true
    || !/Coming soon/i.test(sidebarPackProof[2].subtitle)
  ) {
    throw new Error(`Sidebar must show AHT, PTB, then disabled AHT 3.0: ${JSON.stringify(sidebarPackProof)}`);
  }
  await click(client, '#ptbTileButton');
  const ptbActiveProof = await waitFor(client, `
    window.aht.getStatus('ptb').then((status) => {
      const aht = document.querySelector('#gameTileButton');
      const ptb = document.querySelector('#ptbTileButton');
      const heroTitle = document.querySelector('#playerPackTitle')?.textContent?.trim() || '';
      const latestVersion = document.querySelector('#latestVersion')?.textContent?.trim() || '';
      return ptb?.classList.contains('active') && heroTitle === 'A Hard Time PTB' && latestVersion === '10.0.0-ptb.1' ? {
        ahtActive: aht.classList.contains('active'),
        ptbActive: ptb.classList.contains('active'),
        activeView: document.querySelector('.view.active')?.id || '',
        heroTitle,
        latestVersion,
        activePack: status.activePack,
        releaseTarget: status.releaseTarget,
        packId: status.config?.packId,
        latestUrl: status.config?.latestUrl,
        instanceDir: status.config?.instanceDir,
        profileId: status.config?.minecraftLauncher?.profileId,
        profileName: status.config?.minecraftLauncher?.profileName,
        feedPackId: status.latest?.packId
      } : false;
    })
  `, 'PTB sidebar selection');
  if (
    ptbActiveProof.ahtActive
    || !ptbActiveProof.ptbActive
    || ptbActiveProof.activeView !== 'player'
    || ptbActiveProof.activePack !== 'ptb'
    || ptbActiveProof.releaseTarget !== 'ptb'
    || ptbActiveProof.packId !== 'a-hard-time-ptb'
    || ptbActiveProof.feedPackId !== 'a-hard-time-ptb'
    || ptbActiveProof.latestUrl !== `${workerEndpoint}/ptb/latest.json`
    || path.resolve(ptbActiveProof.instanceDir) !== path.resolve(ptbInstanceDir)
    || ptbActiveProof.profileId !== 'a-hard-time-ptb'
    || ptbActiveProof.profileName !== 'A Hard Time PTB'
  ) {
    throw new Error(`PTB selection must use isolated feed, instance, and Minecraft profile state: ${JSON.stringify(ptbActiveProof)}`);
  }
  await click(client, '#gameTileButton');
  const stableRestoredProof = await waitFor(client, `
    window.aht.getStatus('stable').then((status) => {
      const heroTitle = document.querySelector('#playerPackTitle')?.textContent?.trim() || '';
      const latestVersion = document.querySelector('#latestVersion')?.textContent?.trim() || '';
      return document.querySelector('#gameTileButton')?.classList.contains('active') && heroTitle === 'A Hard Time' && latestVersion === '9.9.9' ? {
        activePack: status.activePack,
        releaseTarget: status.releaseTarget,
        packId: status.config?.packId,
        latestUrl: status.config?.latestUrl,
        profileId: status.config?.minecraftLauncher?.profileId
      } : false;
    })
  `, 'stable sidebar state restored after PTB');
  if (
    stableRestoredProof.activePack !== 'aht'
    || stableRestoredProof.releaseTarget !== 'stable'
    || stableRestoredProof.packId !== 'a-hard-time-dregora'
    || stableRestoredProof.latestUrl !== `${workerEndpoint}/latest.json`
    || stableRestoredProof.profileId !== 'a-hard-time-dregora'
  ) {
    throw new Error(`Returning from PTB changed stable player state: ${JSON.stringify(stableRestoredProof)}`);
  }
  const identityProof = await waitFor(client, `
    window.aht.getStatus().then((status) => status.identity?.minecraftUsername ? {
      username: status.identity.minecraftUsername,
      overlayHidden: document.querySelector('#accountOverlay')?.hidden,
      playerLabel: document.querySelector('#playerLabelView')?.textContent || ''
    } : false)
  `, 'layout account identity');
  if (!identityProof.username || identityProof.overlayHidden !== true || identityProof.playerLabel !== identityProof.username) {
    throw new Error(`Saved or synced identity was not reflected in the player UI: ${JSON.stringify(identityProof)}`);
  }
  await waitFor(client, "document.querySelector('#updateLogGrid')?.hidden === false", 'layout update logs');

  const sidebarProgressProof = await evaluate(client, `
    (() => {
      if (typeof setSidebarProgress === 'function') {
        setSidebarProgress(true, 33, 'Downloading pack 580 MB/718 MB at 13 MB/s');
      } else {
        const progress = document.querySelector('#sidebarProgress');
        progress.hidden = false;
        document.querySelector('#sidebarProgressLabel').textContent = 'Downloading pack';
        document.querySelector('#sidebarProgressCount').textContent = '33%';
      }
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const progress = document.querySelector('#sidebarProgress').getBoundingClientRect();
      const downloads = document.querySelector('#downloadsButton').getBoundingClientRect();
      const label = document.querySelector('#sidebarProgressLabel');
      const proof = {
        label: label.textContent.trim(),
        fullTitle: document.querySelector('#sidebarProgress').title,
        progress: { left: progress.left, right: progress.right, top: progress.top, bottom: progress.bottom, width: progress.width, height: progress.height },
        downloads: { left: downloads.left, right: downloads.right, top: downloads.top, bottom: downloads.bottom, width: downloads.width, height: downloads.height },
        sidebar: { left: sidebar.left, right: sidebar.right, top: sidebar.top, bottom: sidebar.bottom, width: sidebar.width, height: sidebar.height },
        overlap: progress.bottom > downloads.top - 1,
        progressOutsideSidebar: progress.left < sidebar.left - 1 || progress.right > sidebar.right + 1,
        labelOverflow: label.scrollWidth > label.clientWidth + 2
      };
      document.querySelector('#sidebarProgress').hidden = true;
      return proof;
    })()
  `);
  if (
    /MB|GB|\/s/i.test(sidebarProgressProof.label)
    || !/580 MB\/718 MB/i.test(sidebarProgressProof.fullTitle || '')
    || sidebarProgressProof.overlap
    || sidebarProgressProof.progressOutsideSidebar
    || sidebarProgressProof.labelOverflow
  ) {
    throw new Error(`Sidebar progress overlaps or shows unbounded transfer text: ${JSON.stringify(sidebarProgressProof)}`);
  }

  const reports = [];
  const screenshots = [];
  for (const size of [{ name: 'desktop', width: 1260, height: 760 }, { name: 'compact', width: 980, height: 700 }]) {
    await setWindowSize(client, target.id, size.width, size.height);
    await click(client, '.nav [data-tab="player"]');
    reports.push(await assertLayout(client, `${size.name}-player`));
    screenshots.push(await captureScreenshot(client, `${size.name}-player`));
    await click(client, '.nav [data-tab="settings"]');
    reports.push(await assertLayout(client, `${size.name}-settings`));
    screenshots.push(await captureScreenshot(client, `${size.name}-settings`));
    await click(client, '#downloadsButton');
    reports.push(await assertLayout(client, `${size.name}-downloads`));
    screenshots.push(await captureScreenshot(client, `${size.name}-downloads`));
    await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  }

  console.log(JSON.stringify({ ok: true, root, screenshots, reports: reports.map(({ label, viewport, activeView }) => ({ label, viewport, activeView })) }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
