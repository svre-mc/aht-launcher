import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const testEvidenceDir = String(process.env.AHT_TEST_EVIDENCE_DIR || '').trim()
  ? path.resolve(process.env.AHT_TEST_EVIDENCE_DIR)
  : '';
const sidebarSelectedLightPath = path.resolve('desktop', 'renderer', 'assets', 'sidebar-selected-light.png');
const sidebarSelectedLight = fs.readFileSync(sidebarSelectedLightPath);
const sidebarSelectedLightIdentity = {
  width: sidebarSelectedLight.readUInt32BE(16),
  height: sidebarSelectedLight.readUInt32BE(20),
  sha256: sha256(sidebarSelectedLight)
};
if (
  sidebarSelectedLightIdentity.width !== 195
  || sidebarSelectedLightIdentity.height !== 80
  || sidebarSelectedLightIdentity.sha256 !== '3A3874AC5FF279CC2E2D3F3E128F138F4D190F6CF5A14513B8BA7530D5E5ED19'
) {
  throw new Error(`Selected sidebar light asset drifted from the measured BSG texture: ${JSON.stringify(sidebarSelectedLightIdentity)}`);
}
const vineLogoPath = path.resolve('desktop', 'renderer', 'assets', 'aht-vine-logo.png');
const vineLogo = fs.readFileSync(vineLogoPath);
const vineLogoIdentity = {
  width: vineLogo.readUInt32BE(16),
  height: vineLogo.readUInt32BE(20),
  sha256: sha256(vineLogo)
};
if (
  vineLogoIdentity.width !== 2240
  || vineLogoIdentity.height !== 1088
  || vineLogoIdentity.sha256 !== '68F31F78CF0A9B5780CEB92E41DBEED4FD92A532CA2FEC50C1821D323AED3872'
) {
  throw new Error(`A Hard Time vine footer logo drifted from the supplied PNG: ${JSON.stringify(vineLogoIdentity)}`);
}
const footerGlowAssets = [
  {
    path: path.resolve('desktop', 'renderer', 'assets', 'bsg-button-huge-light-1.png'),
    sha256: 'A2BF4736D2C80F99602F2507A55F005B542F72E560391A9AE532F48F828AAD1E'
  },
  {
    path: path.resolve('desktop', 'renderer', 'assets', 'bsg-button-huge-light-2.png'),
    sha256: 'BDD12A413444DAB8DA35FAB614DCA3853D9CEB3D40EB08A16F76CAF764E0DC40'
  }
];
for (const asset of footerGlowAssets) {
  const bytes = fs.readFileSync(asset.path);
  const identity = {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    sha256: sha256(bytes)
  };
  if (identity.width !== 809 || identity.height !== 413 || identity.sha256 !== asset.sha256) {
    throw new Error(`Footer glow asset drifted from the native BSG alpha field: ${JSON.stringify({ path: asset.path, ...identity })}`);
  }
}
const reducedMotionArgs = process.env.AHT_TEST_FORCE_REDUCED_MOTION === '1'
  ? ['--force-prefers-reduced-motion=reduce']
  : [];
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, ...reducedMotionArgs]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, ...reducedMotionArgs];
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

async function captureElementPng(client, selector) {
  const rect = await evaluate(client, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    const bounds = node.getBoundingClientRect();
    return { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
  })()`);
  if (!rect) throw new Error(`Screenshot target was unavailable: ${selector}`);
  const result = await client.call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { ...rect, scale: 1 }
  });
  return Buffer.from(result.data, 'base64');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

async function click(client, selector) {
  await evaluate(client, `document.querySelector(${JSON.stringify(selector)})?.click(); true`);
  await sleep(/^#(?:gameTileButton|ptbTileButton|developerTileButton)$/.test(selector) ? 850 : 400);
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
        .filter((button) => !button.matches('.nav-item') && (button.scrollWidth > button.clientWidth + 3 || button.scrollHeight > button.clientHeight + 3))
        .map(describe);
      const critical = [...document.querySelectorAll('.app-frame, .sidebar, .workspace, .topbar, .profile-card, .game-tile, .hero-panel, .news-grid, .news-feed-grid, .quick-actions, .launch-strip, .settings-panel, .downloads-panel, .modal-card, .status-pill')]
        .filter(visible)
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < -2 || rect.right > window.innerWidth + 2;
        })
        .map(describe);
      const workspace = document.querySelector('.workspace');
      const responsiveContent = [...document.querySelectorAll('.hero-art, .news-grid, .news-feed-grid, .quick-actions, .launch-strip')]
        .filter(visible)
        .map(describe);
      const workspaceWidth = workspace?.clientWidth || 0;
      const contentWidthLimit = Math.max(0, workspaceWidth - 60);
      const oversizedContent = responsiveContent.filter((item) => item.width > contentWidthLimit + 2);
      const settingsPanel = document.querySelector('.settings-panel');
      const settingsPanelRect = settingsPanel?.getBoundingClientRect();
      const settingsWidthShortfall = document.querySelector('.view.active')?.id === 'settings' && settingsPanelRect && visible(settingsPanel)
        ? Math.round(contentWidthLimit - settingsPanelRect.width)
        : null;
      const heroPanel = document.querySelector('.hero-panel');
      const newsGrid = document.querySelector('.news-grid');
      const heroRect = heroPanel?.getBoundingClientRect();
      const newsRect = newsGrid?.getBoundingClientRect();
      const newsBottomGap = heroRect && newsRect && visible(newsGrid)
        ? Math.round(heroRect.bottom - newsRect.bottom)
        : null;
      const launchStrip = document.querySelector('.launch-strip');
      const workspaceRect = workspace?.getBoundingClientRect();
      const launchRect = launchStrip?.getBoundingClientRect();
      const launchBottomGap = workspaceRect && launchRect && visible(launchStrip)
        ? Math.round(workspaceRect.bottom - launchRect.bottom)
        : null;
      const visibleDeveloperText = !document.querySelector('#developerConsole')?.hidden && document.body.innerText.includes('Developer Console');
      return {
        label: ${JSON.stringify(label)},
        viewport: { width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth },
        activeView: document.querySelector('.view.active')?.id || '',
        horizontalOverflow,
        clippedButtons,
        critical,
        contentWidthLimit,
        responsiveContent,
        oversizedContent,
        settingsWidthShortfall,
        newsBottomGap,
        launchBottomGap,
        visibleDeveloperText,
        bodyText: document.body.innerText.slice(0, 1000)
      };
    })()
  `);
  const failures = [];
  if (report.horizontalOverflow) failures.push('horizontal overflow');
  if (report.clippedButtons.length) failures.push(`clipped buttons: ${JSON.stringify(report.clippedButtons.slice(0, 5))}`);
  if (report.critical.length) failures.push(`critical elements outside viewport: ${JSON.stringify(report.critical.slice(0, 5))}`);
  if (report.oversizedContent.length) failures.push(`responsive content exceeds its max width: ${JSON.stringify(report.oversizedContent.slice(0, 5))}`);
  if (report.settingsWidthShortfall !== null && report.settingsWidthShortfall > 2) failures.push(`settings panel does not fill the responsive content width: ${report.settingsWidthShortfall}px short`);
  if (report.activeView === 'player' && report.newsBottomGap !== null && report.newsBottomGap > 8) failures.push(`news cards are floating above the hero bottom: ${report.newsBottomGap}px`);
  if (report.activeView === 'player' && report.launchBottomGap !== null && report.launchBottomGap > 28) failures.push(`launch strip is floating above the workspace bottom: ${report.launchBottomGap}px`);
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
const launcherSocialLinks = Object.freeze({
  discord: 'https://discord.com/invite/LayoutSmoke',
  youtube: 'https://www.youtube.com/@AHardTimeLayout',
  tiktok: 'https://www.tiktok.com/@ahardtimelayout',
  forum: 'https://ahardtime.net/forum/launcher-layout'
});

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
  minecraftLauncher: { enabled: true, rootDir: minecraftRoot, profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 6144 }
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
  if (url.pathname === '/update-media/launcher-social-links.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({
      schema: 'aht-launcher-social-links/v1',
      links: launcherSocialLinks,
      publishedAt: '2026-08-30T12:00:00.000Z',
      publishedBy: 'Player Layout Smoke'
    }));
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
    AHT_TEST_OPEN_EXTERNAL_ECHO: '1',
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
  await client.call('Page.bringToFront');
  await client.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(250);
  await waitFor(client, "document.readyState === 'complete' && window.aht && document.querySelector('#closeLauncherWhenGameStartsInput')", 'player DOM');
  const fixedWindowProof = await evaluate(client, `({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    documentWidth: document.documentElement.clientWidth,
    documentHeight: document.documentElement.clientHeight,
    controls: document.querySelectorAll('.window-controls .window-control').length,
    minimizeLabel: document.querySelector('#windowMinimizeButton')?.getAttribute('aria-label') || '',
    closeLabel: document.querySelector('#windowCloseButton')?.getAttribute('aria-label') || ''
  })`);
  if (fixedWindowProof.innerWidth !== 1432 || fixedWindowProof.innerHeight !== 760 || fixedWindowProof.documentWidth !== 1432 || fixedWindowProof.documentHeight !== 760 || fixedWindowProof.controls !== 2 || fixedWindowProof.minimizeLabel !== 'Minimize launcher' || fixedWindowProof.closeLabel !== 'Close launcher') {
    throw new Error(`Launcher must use the fixed 1432x760 frameless shell with its own controls: ${JSON.stringify(fixedWindowProof)}`);
  }
  const status = await waitFor(client, "window.aht.getStatus().then((status) => status.latest?.version === '9.9.9' ? status : false)", 'layout latest feed');
  const minecraftProfileProof = await waitFor(client, `
    (() => {
      const proof = {
        profileToggleAbsent: !document.querySelector('#minecraftProfileEnabledInput'),
        closeSettingPresent: Boolean(document.querySelector('#closeLauncherWhenGameStartsInput')),
        serializedEnabled: serializeSettings().minecraftLauncher.enabled,
        rootDir: document.querySelector('#minecraftRootInput')?.value || '',
        profileName: document.querySelector('#minecraftProfileNameInput')?.value || ''
      };
      return proof.profileToggleAbsent && proof.closeSettingPresent && proof.serializedEnabled === true && proof.rootDir && proof.profileName ? proof : false;
    })()
  `, 'layout Minecraft profile setting');
  if (
    !minecraftProfileProof.profileToggleAbsent
    || !minecraftProfileProof.closeSettingPresent
    || minecraftProfileProof.serializedEnabled !== true
    || path.resolve(minecraftProfileProof.rootDir) !== path.resolve(minecraftRoot)
    || minecraftProfileProof.profileName !== 'A Hard Time'
  ) {
    throw new Error(`Player layout did not force Minecraft profile integration or render the replacement close setting: ${JSON.stringify({ minecraftProfileProof, minecraftRoot })}`);
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
      const settingsButton = actions?.querySelector('[data-tab="settings"]');
      const launchStrip = document.querySelector('.launch-strip');
      const launchInfo = document.querySelector('.launch-game-info');
      const launchActions = document.querySelector('.launch-actions');
      const playButton = document.querySelector('#playButton');
      const footerLogo = document.querySelector('.footer-game-logo');
      const footerLogoImage = footerLogo?.querySelector('img');
      const firstHomeArt = document.querySelector('.home-news-card .feature-art');
      const oldFacts = document.querySelector('.launch-state-data');
      const statusBadge = document.querySelector('#statusBadge');
      const editableField = document.querySelector('input');
      const repairIcon = scanButton?.querySelector('.button-icon');
      if (!(frame && workspace && heroPanel && heroArt && actions && scanButton && settingsButton && launchStrip && launchInfo && launchActions && playButton && footerLogo && footerLogoImage?.complete && oldFacts && statusBadge && editableField && repairIcon)) return false;
      if (playButton.classList.contains('is-disabled') || playButton.getAttribute('aria-disabled') === 'true') return false;
      const workspaceRect = workspace.getBoundingClientRect();
      const stripRect = launchStrip.getBoundingClientRect();
      const actionRect = launchActions.getBoundingClientRect();
      const playRect = playButton.getBoundingClientRect();
      const logoRect = footerLogo.getBoundingClientRect();
      const logoImageRect = footerLogoImage.getBoundingClientRect();
      const glow1 = getComputedStyle(launchActions, '::before');
      const glow2 = getComputedStyle(launchActions, '::after');
      return {
        frameBackground: getComputedStyle(frame).backgroundImage,
        workspaceBackground: getComputedStyle(workspace).backgroundImage,
        heroBeforeBackground: getComputedStyle(heroPanel, '::before').backgroundImage,
        heroAfterBackground: getComputedStyle(heroPanel, '::after').backgroundImage,
        heroArtAfterBackground: getComputedStyle(heroArt, '::after').backgroundImage,
        repairText: scanButton.textContent.trim(),
        repairIcon: repairIcon.className || '',
        settingsText: settingsButton.textContent.trim(),
        actionsMarginTop: parseFloat(getComputedStyle(actions).marginTop || '0'),
        actionsGap: getComputedStyle(actions).gap,
        repairFontSize: getComputedStyle(scanButton).fontSize,
        repairIconWidth: repairIcon.getBoundingClientRect().width,
        repairBorder: getComputedStyle(scanButton).borderTopWidth,
        settingsBorder: getComputedStyle(settingsButton).borderTopWidth,
        actionsPaddingLeft: parseFloat(getComputedStyle(actions).paddingLeft),
        gameInfoPaddingLeft: parseFloat(getComputedStyle(launchInfo).paddingLeft),
        heroLabelsAbsent: !document.querySelector('#playerPackTitle') && !document.querySelector('#versionLine'),
        launchInfoRows: launchInfo.children.length,
        launchInfoText: launchInfo.textContent.replace(/\\s+/g, ' ').trim(),
        removedFooterLabelsAbsent: !document.querySelector('#launchGameEdition') && !document.querySelector('#launchServerStatus'),
        footerLogoSource: footerLogoImage.getAttribute('src') || '',
        footerLogoNaturalWidth: footerLogoImage.naturalWidth,
        footerLogoNaturalHeight: footerLogoImage.naturalHeight,
        footerLogoLeftGap: logoRect.left - workspaceRect.left,
        footerLogoBottomGap: workspaceRect.bottom - logoRect.bottom,
        footerLogoWidth: logoRect.width,
        footerLogoHeight: logoRect.height,
        footerLogoImageWidth: logoImageRect.width,
        firstHomeArtAfterContent: firstHomeArt ? getComputedStyle(firstHomeArt, '::after').content : 'none',
        stripWidth: stripRect.width,
        stripHeight: stripRect.height,
        stripRightGap: workspaceRect.right - stripRect.right,
        stripBackground: getComputedStyle(launchStrip).backgroundImage,
        stripBeforeBackground: getComputedStyle(launchStrip, '::before').backgroundImage,
        stripBeforeRight: getComputedStyle(launchStrip, '::before').right,
        stripBeforeWidth: parseFloat(getComputedStyle(launchStrip, '::before').width),
        stripBeforeBorderLeft: getComputedStyle(launchStrip, '::before').borderLeftWidth,
        stripBeforeMask: getComputedStyle(launchStrip, '::before').maskImage,
        stripAfterBackground: getComputedStyle(launchStrip, '::after').backgroundImage,
        glow1Background: glow1.backgroundImage,
        glow1Top: glow1.top,
        glow1Right: glow1.right,
        glow1Width: parseFloat(glow1.width),
        glow1Height: parseFloat(glow1.height),
        glow1Blend: glow1.mixBlendMode,
        glow1Opacity: Number.parseFloat(glow1.opacity),
        glow2Background: glow2.backgroundImage,
        glow2Top: glow2.top,
        glow2Right: glow2.right,
        glow2Width: parseFloat(glow2.width),
        glow2Height: parseFloat(glow2.height),
        glow2Blend: glow2.mixBlendMode,
        glow2Opacity: Number.parseFloat(glow2.opacity),
        glowViewportLeft: actionRect.right + 252 - 809,
        glowViewportTop: actionRect.top - 231,
        playWidth: playRect.width,
        playHeight: playRect.height,
        playRightDelta: stripRect.right - playRect.right,
        playBorderRadius: getComputedStyle(playButton).borderTopLeftRadius,
        playClipPath: getComputedStyle(playButton).clipPath,
        primaryMode: playButton.dataset.actionMode,
        primaryText: playButton.textContent.trim(),
        installClass: playButton.classList.contains('is-install-action'),
        updateClass: playButton.classList.contains('is-update-action'),
        oldFactsHidden: oldFacts.hidden && getComputedStyle(oldFacts).display === 'none',
        statusBadgeHidden: statusBadge.getClientRects().length === 0,
        nonEditableUserSelect: getComputedStyle(heroArt).userSelect,
        editableUserSelect: getComputedStyle(editableField).userSelect,
        bodySelectPrevented: !document.body.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true })),
        editableSelectAllowed: editableField.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true })),
        artworkDragPrevented: !heroArt.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true })),
        bodySelectAllPrevented: !document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
      };
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
  if (launcherVisualProof.repairText !== 'Repair' || !launcherVisualProof.repairIcon.includes('icon-wrench') || launcherVisualProof.settingsText !== 'Game Settings') {
    throw new Error(`Quick actions must use the BSG-aligned Repair and Game Settings labels/icons: ${JSON.stringify(launcherVisualProof)}`);
  }
  if (launcherVisualProof.actionsMarginTop < 10) {
    throw new Error(`Repair/Game settings buttons need positive spacing above them: ${JSON.stringify(launcherVisualProof)}`);
  }
  if (
    launcherVisualProof.repairBorder !== '0px'
    || launcherVisualProof.settingsBorder !== '0px'
    || launcherVisualProof.actionsGap !== '10px'
    || Math.abs(launcherVisualProof.actionsPaddingLeft - 28) > 1
    || Math.abs(launcherVisualProof.gameInfoPaddingLeft - 28) > 1
    || launcherVisualProof.repairFontSize !== '15px'
    || Math.abs(launcherVisualProof.repairIconWidth - 26) > 1
    || Math.abs(launcherVisualProof.stripWidth - 575) > 1
    || Math.abs(launcherVisualProof.stripHeight - 104) > 1
    || Math.abs(launcherVisualProof.stripRightGap - 36) > 1
    || launcherVisualProof.stripBackground !== 'none'
    || !launcherVisualProof.stripBeforeBackground.includes('linear-gradient')
    || launcherVisualProof.stripBeforeRight !== '-36px'
    || Math.abs(launcherVisualProof.stripBeforeWidth - 611) > 1
    || launcherVisualProof.stripBeforeBorderLeft !== '0px'
    || launcherVisualProof.stripBeforeMask === 'none'
    || !launcherVisualProof.stripBeforeMask.includes('72%')
    || !launcherVisualProof.stripBeforeMask.includes('0.16')
    || launcherVisualProof.stripAfterBackground !== 'none'
    || !launcherVisualProof.glow1Background.includes('bsg-button-huge-light-1.png')
    || launcherVisualProof.glow1Top !== '-231px'
    || launcherVisualProof.glow1Right !== '-252px'
    || Math.abs(launcherVisualProof.glow1Width - 809) > 1
    || Math.abs(launcherVisualProof.glow1Height - 413) > 1
    || launcherVisualProof.glow1Blend !== 'screen'
    || launcherVisualProof.glow1Opacity !== 1
    || !launcherVisualProof.glow2Background.includes('bsg-button-huge-light-2.png')
    || launcherVisualProof.glow2Top !== '-231px'
    || launcherVisualProof.glow2Right !== '-252px'
    || Math.abs(launcherVisualProof.glow2Width - 809) > 1
    || Math.abs(launcherVisualProof.glow2Height - 413) > 1
    || launcherVisualProof.glow2Blend !== 'color-dodge'
    || launcherVisualProof.glow2Opacity !== 1
    || Math.abs(launcherVisualProof.playWidth - 293) > 1
    || Math.abs(launcherVisualProof.playHeight - 68) > 1
    || Math.abs(launcherVisualProof.playRightDelta) > 1
    || !launcherVisualProof.heroLabelsAbsent
    || launcherVisualProof.launchInfoRows !== 1
    || !launcherVisualProof.launchInfoText.startsWith('Game version:')
    || launcherVisualProof.launchInfoText.includes('Game edition:')
    || launcherVisualProof.launchInfoText.includes('Server:')
    || !launcherVisualProof.removedFooterLabelsAbsent
    || !launcherVisualProof.footerLogoSource.endsWith('assets/aht-vine-logo.png')
    || launcherVisualProof.footerLogoNaturalWidth !== 2240
    || launcherVisualProof.footerLogoNaturalHeight !== 1088
    || Math.abs(launcherVisualProof.footerLogoLeftGap - 34) > 1
    || Math.abs(launcherVisualProof.footerLogoBottomGap) > 1
    || Math.abs(launcherVisualProof.footerLogoWidth - 565) > 1
    || Math.abs(launcherVisualProof.footerLogoHeight - 190) > 1
    || Math.abs(launcherVisualProof.footerLogoImageWidth - 600) > 1
    || launcherVisualProof.firstHomeArtAfterContent !== 'none'
    || launcherVisualProof.playBorderRadius !== '2px'
    || launcherVisualProof.playClipPath !== 'none'
    || launcherVisualProof.primaryMode !== 'install'
    || launcherVisualProof.primaryText !== 'Install'
    || !launcherVisualProof.installClass
    || launcherVisualProof.updateClass
    || !launcherVisualProof.oldFactsHidden
    || !launcherVisualProof.statusBadgeHidden
    || launcherVisualProof.nonEditableUserSelect !== 'none'
    || launcherVisualProof.editableUserSelect !== 'text'
    || !launcherVisualProof.bodySelectPrevented
    || !launcherVisualProof.editableSelectAllowed
    || !launcherVisualProof.artworkDragPrevented
    || !launcherVisualProof.bodySelectAllPrevented
  ) {
    throw new Error(`Player footer must match the measured BSG geometry, native two-layer bloom, right fade, corner profile, Install state, and non-selectable shell behavior: ${JSON.stringify(launcherVisualProof)}`);
  }
  await waitFor(client, `
    (() => {
      const quickAction = document.querySelector('.quick-actions [data-tab="settings"]');
      const play = document.querySelector('#playButton');
      return quickAction && play
        && !quickAction.classList.contains('is-disabled')
        && !play.classList.contains('is-disabled')
        && quickAction.getAttribute('aria-disabled') !== 'true'
        && play.getAttribute('aria-disabled') !== 'true';
    })()
  `, 'enabled footer hover targets');
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await sleep(240);
  const hoverTargets = await evaluate(client, `(() => {
    const quickAction = document.querySelector('.quick-actions [data-tab="settings"]');
    const play = document.querySelector('#playButton');
    const action = document.querySelector('.launch-actions');
    const quickActionIcon = quickAction?.querySelector('.button-icon');
    if (!(quickAction && play && action && quickActionIcon)) return false;
    const quickActionRect = quickAction.getBoundingClientRect();
    const playRect = play.getBoundingClientRect();
    return {
      quickAction: { x: quickActionRect.left + quickActionRect.width / 2, y: quickActionRect.top + quickActionRect.height / 2 },
      play: { x: playRect.left + playRect.width / 2, y: playRect.top + playRect.height / 2 },
      neutralQuickActionColor: getComputedStyle(quickAction).color,
      neutralQuickActionIconOpacity: Number.parseFloat(getComputedStyle(quickActionIcon).opacity),
      neutralPlayBackground: getComputedStyle(play).backgroundImage,
      neutralGlow1Background: getComputedStyle(action, '::before').backgroundImage,
      neutralGlow1Opacity: Number.parseFloat(getComputedStyle(action, '::before').opacity),
      neutralGlow2Background: getComputedStyle(action, '::after').backgroundImage,
      neutralGlow2Opacity: Number.parseFloat(getComputedStyle(action, '::after').opacity)
    };
  })()`);
  if (!hoverTargets) throw new Error('Hover proof targets were unavailable.');
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverTargets.quickAction.x, y: hoverTargets.quickAction.y });
  await sleep(260);
  const quickActionHoverProof = await evaluate(client, `(() => {
    const quickAction = document.querySelector('.quick-actions [data-tab="settings"]');
    const icon = quickAction?.querySelector('.button-icon');
    const rect = quickAction?.getBoundingClientRect();
    const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
    return quickAction && icon ? {
      color: getComputedStyle(quickAction).color,
      iconOpacity: Number.parseFloat(getComputedStyle(icon).opacity),
      hovered: quickAction.matches(':hover'),
      disabled: quickAction.classList.contains('is-disabled'),
      hit: hit ? { tag: hit.tagName, id: hit.id, className: String(hit.className || '') } : null
    } : false;
  })()`);
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverTargets.play.x, y: hoverTargets.play.y });
  await sleep(260);
  const playHoverProof = await evaluate(client, `(() => {
    const play = document.querySelector('#playButton');
    const action = document.querySelector('.launch-actions');
    const rect = play?.getBoundingClientRect();
    const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
    return play && action ? {
      background: getComputedStyle(play).backgroundImage,
      glow1Background: getComputedStyle(action, '::before').backgroundImage,
      glow1Opacity: Number.parseFloat(getComputedStyle(action, '::before').opacity),
      glow2Background: getComputedStyle(action, '::after').backgroundImage,
      glow2Opacity: Number.parseFloat(getComputedStyle(action, '::after').opacity),
      hovered: play.matches(':hover'),
      disabled: play.classList.contains('is-disabled'),
      hit: hit ? { tag: hit.tagName, id: hit.id, className: String(hit.className || '') } : null
    } : false;
  })()`);
  if (
    !quickActionHoverProof
    || !quickActionHoverProof.hovered
    || quickActionHoverProof.disabled
    || quickActionHoverProof.color === hoverTargets.neutralQuickActionColor
    || quickActionHoverProof.iconOpacity <= hoverTargets.neutralQuickActionIconOpacity
    || !playHoverProof
    || !playHoverProof.hovered
    || playHoverProof.disabled
    || playHoverProof.background === hoverTargets.neutralPlayBackground
    || playHoverProof.glow1Background !== hoverTargets.neutralGlow1Background
    || playHoverProof.glow1Opacity !== hoverTargets.neutralGlow1Opacity
    || playHoverProof.glow2Background !== hoverTargets.neutralGlow2Background
    || playHoverProof.glow2Opacity !== hoverTargets.neutralGlow2Opacity
  ) {
    throw new Error(`Quick and primary actions must use measured hover lighting while the native BSG footer bloom remains static: ${JSON.stringify({ hoverTargets, quickActionHoverProof, playHoverProof })}`);
  }
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
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
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await evaluate(client, `(() => {
    for (const tile of document.querySelectorAll('.game-list .game-tile')) {
      getComputedStyle(tile).color;
      tile.getAnimations().forEach((animation) => animation.finish());
      for (const child of tile.querySelectorAll('.game-thumb, .game-copy, .game-copy strong')) {
        child.getAnimations().forEach((animation) => animation.finish());
      }
    }
    return true;
  })()`);
  const sidebarStateProof = await evaluate(client, `(() => {
    const describe = (selector) => {
      const tile = document.querySelector(selector);
      const title = tile?.querySelector('.game-copy strong');
      const subtitle = tile?.querySelector('.game-copy small');
      const thumb = tile?.querySelector('.game-thumb');
      const copy = tile?.querySelector('.game-copy');
      if (!(tile && title && subtitle && thumb && copy)) return null;
      const tileRect = tile.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      const tileStyle = getComputedStyle(tile);
      const titleStyle = getComputedStyle(title);
      return {
        active: tile.classList.contains('active'),
        hovered: tile.matches(':hover'),
        tileRect: { left: tileRect.left, top: tileRect.top, width: tileRect.width, height: tileRect.height },
        titleLeft: titleRect.left,
        thumbRect: { left: thumbRect.left, top: thumbRect.top, width: thumbRect.width, height: thumbRect.height },
        backgroundImage: tileStyle.backgroundImage,
        backgroundSize: tileStyle.backgroundSize,
        borderLeftWidth: tileStyle.borderLeftWidth,
        boxShadow: tileStyle.boxShadow,
        transform: tileStyle.transform,
        transitionDuration: tileStyle.transitionDuration,
        animationName: tileStyle.animationName,
        titleColor: titleStyle.color,
        titleFontSize: titleStyle.fontSize,
        titleFontWeight: titleStyle.fontWeight,
        titleTextShadow: titleStyle.textShadow,
        subtitleColor: getComputedStyle(subtitle).color,
        subtitleFontSize: getComputedStyle(subtitle).fontSize,
        thumbOpacity: Number.parseFloat(getComputedStyle(thumb).opacity),
        thumbFilter: getComputedStyle(thumb).filter,
        thumbTransitionDuration: getComputedStyle(thumb).transitionDuration,
        thumbAnimationName: getComputedStyle(thumb).animationName,
        copyOpacity: Number.parseFloat(getComputedStyle(copy).opacity),
        copyFilter: getComputedStyle(copy).filter,
        beforeContent: getComputedStyle(tile, '::before').content,
        afterContent: getComputedStyle(tile, '::after').content
      };
    };
    const sidebar = document.querySelector('.sidebar');
    const sidebarStyle = getComputedStyle(sidebar);
    return {
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      sidebar: {
        backgroundColor: sidebarStyle.backgroundColor,
        backgroundImage: sidebarStyle.backgroundImage,
        borderRightColor: sidebarStyle.borderRightColor,
        boxShadow: sidebarStyle.boxShadow,
        afterContent: getComputedStyle(sidebar, '::after').content
      },
      active: describe('#gameTileButton'),
      neutral: describe('#ptbTileButton')
    };
  })()`);
  const activeSidebar = sidebarStateProof.active;
  const neutralSidebar = sidebarStateProof.neutral;
  const sidebarCloseTo = (actual, expected, tolerance = 0.75) => Math.abs(Number(actual) - Number(expected)) <= tolerance;
  const neutralThumbTransitionSeconds = Number.parseFloat(neutralSidebar?.thumbTransitionDuration);
  const neutralThumbTransitionMatchesMotionPolicy = sidebarStateProof.reducedMotion
    ? Number.isFinite(neutralThumbTransitionSeconds) && neutralThumbTransitionSeconds <= 0.001
    : neutralSidebar?.thumbTransitionDuration === '0.2s';
  if (
    sidebarStateProof.sidebar.backgroundColor !== 'rgb(22, 25, 26)'
    || sidebarStateProof.sidebar.backgroundImage !== 'none'
    || sidebarStateProof.sidebar.borderRightColor !== 'rgba(228, 245, 255, 0.29)'
    || sidebarStateProof.sidebar.boxShadow !== 'none'
    || sidebarStateProof.sidebar.afterContent !== 'none'
    || !activeSidebar?.active
    || neutralSidebar?.active
    || !sidebarCloseTo(activeSidebar.tileRect.width, 232)
    || !sidebarCloseTo(activeSidebar.tileRect.height, 80)
    || !sidebarCloseTo(activeSidebar.tileRect.top, 120)
    || !sidebarCloseTo(neutralSidebar.tileRect.top - activeSidebar.tileRect.top, 80)
    || !sidebarCloseTo(activeSidebar.thumbRect.width, 58)
    || !sidebarCloseTo(activeSidebar.thumbRect.height, 58)
    || !sidebarCloseTo(activeSidebar.titleLeft - activeSidebar.tileRect.left, 96)
    || activeSidebar.borderLeftWidth !== '0px'
    || activeSidebar.boxShadow !== 'none'
    || !activeSidebar.backgroundImage.includes('sidebar-selected-light.png')
    || activeSidebar.backgroundSize !== '195px 80px'
    || activeSidebar.transform !== 'none'
    || activeSidebar.transitionDuration !== '0s'
    || activeSidebar.animationName !== 'none'
    || activeSidebar.titleColor !== 'rgb(225, 238, 244)'
    || activeSidebar.titleFontSize !== '19px'
    || activeSidebar.titleFontWeight !== '400'
    || activeSidebar.titleTextShadow !== 'none'
    || activeSidebar.subtitleColor !== 'rgb(106, 113, 117)'
    || activeSidebar.subtitleFontSize !== '11px'
    || activeSidebar.thumbOpacity !== 1
    || activeSidebar.thumbFilter !== 'none'
    || activeSidebar.thumbTransitionDuration !== '0s'
    || activeSidebar.thumbAnimationName !== 'none'
    || activeSidebar.copyOpacity !== 1
    || activeSidebar.copyFilter !== 'none'
    || activeSidebar.beforeContent !== 'none'
    || activeSidebar.afterContent !== 'none'
    || neutralSidebar.backgroundImage !== 'none'
    || neutralSidebar.boxShadow !== 'none'
    || neutralSidebar.titleColor !== 'rgb(106, 113, 117)'
    || neutralSidebar.titleTextShadow !== 'none'
    || neutralSidebar.subtitleColor !== 'rgb(106, 113, 117)'
    || Math.abs(neutralSidebar.thumbOpacity - 0.75) > 0.001
    || neutralSidebar.thumbFilter !== 'none'
    || !neutralThumbTransitionMatchesMotionPolicy
    || neutralSidebar.copyOpacity !== 1
    || neutralSidebar.copyFilter !== 'none'
  ) {
    throw new Error(`Sidebar neutral and selected states must match the measured BSG box, color, and opacity model: ${JSON.stringify(sidebarStateProof)}`);
  }

  const selectedVisualExpression = `(() => {
    const tile = document.querySelector('#gameTileButton');
    const thumb = tile?.querySelector('.game-thumb');
    const copy = tile?.querySelector('.game-copy');
    const title = tile?.querySelector('.game-copy strong');
    const subtitle = tile?.querySelector('.game-copy small');
    if (!(tile && thumb && copy && title && subtitle)) return false;
    const describe = (node) => {
      const style = getComputedStyle(node);
      return {
        opacity: style.opacity,
        filter: style.filter,
        color: style.color,
        backgroundImage: style.backgroundImage,
        backgroundPosition: style.backgroundPosition,
        backgroundRepeat: style.backgroundRepeat,
        backgroundSize: style.backgroundSize,
        boxShadow: style.boxShadow,
        textShadow: style.textShadow,
        transform: style.transform,
        transitionDuration: style.transitionDuration,
        animationName: style.animationName,
        animationCount: node.getAnimations().length
      };
    };
    return {
      active: tile.classList.contains('active'),
      tile: describe(tile),
      thumb: describe(thumb),
      copy: describe(copy),
      title: describe(title),
      subtitle: describe(subtitle)
    };
  })()`;
  const selectedHoverPoint = {
    x: activeSidebar.tileRect.left + activeSidebar.tileRect.width / 2,
    y: activeSidebar.tileRect.top + activeSidebar.tileRect.height / 2
  };
  // Fully settle the cold PNG raster before using it as a byte-stability baseline.
  // Chromium can resample a newly decoded fractional-size background on a later
  // invalidation even when every computed hover style is identical, so exercise
  // both the initial and delayed raster paths before comparing neutral/hover bytes.
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: selectedHoverPoint.x, y: selectedHoverPoint.y });
  for (const delayMs of [320, 120, 260, 120]) {
    await sleep(delayMs);
    await captureElementPng(client, '#gameTileButton');
  }
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await sleep(120);
  const selectedNeutralVisual = await evaluate(client, selectedVisualExpression);
  const selectedNeutralPixels = await captureElementPng(client, '#gameTileButton');
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: selectedHoverPoint.x, y: selectedHoverPoint.y });
  const selectedHoverVisual = await evaluate(client, selectedVisualExpression);
  const selectedHoverPixels = await captureElementPng(client, '#gameTileButton');
  await sleep(260);
  const selectedHoverSettledVisual = await evaluate(client, selectedVisualExpression);
  const selectedHoverSettledPixels = await captureElementPng(client, '#gameTileButton');
  const selectedHoverProof = {
    hovered: await evaluate(client, `document.querySelector('#gameTileButton')?.matches(':hover') || false`),
    neutralSha256: sha256(selectedNeutralPixels),
    immediateHoverSha256: sha256(selectedHoverPixels),
    settledHoverSha256: sha256(selectedHoverSettledPixels),
    visualStable: JSON.stringify(selectedNeutralVisual) === JSON.stringify(selectedHoverVisual)
      && JSON.stringify(selectedNeutralVisual) === JSON.stringify(selectedHoverSettledVisual),
    pixelsStable: selectedNeutralPixels.equals(selectedHoverPixels)
      && selectedNeutralPixels.equals(selectedHoverSettledPixels)
  };
  if (
    !selectedHoverProof.hovered
    || selectedNeutralVisual?.active !== true
    || !selectedNeutralVisual?.tile?.backgroundImage?.includes('sidebar-selected-light.png')
    || selectedNeutralVisual.tile.animationCount !== 0
    || selectedNeutralVisual.thumb.animationCount !== 0
    || selectedNeutralVisual.copy.animationCount !== 0
    || selectedNeutralVisual.title.animationCount !== 0
    || selectedNeutralVisual.subtitle.animationCount !== 0
    || !selectedHoverProof.visualStable
    || !selectedHoverProof.pixelsStable
  ) {
    const diagnosticDirs = [...new Set([screenshotDir, testEvidenceDir].filter(Boolean))];
    for (const diagnosticDir of diagnosticDirs) {
      await fsp.mkdir(diagnosticDir, { recursive: true });
      await Promise.all([
        fsp.writeFile(path.join(diagnosticDir, 'selected-neutral-diagnostic.png'), selectedNeutralPixels),
        fsp.writeFile(path.join(diagnosticDir, 'selected-hover-diagnostic.png'), selectedHoverPixels),
        fsp.writeFile(path.join(diagnosticDir, 'selected-hover-settled-diagnostic.png'), selectedHoverSettledPixels)
      ]);
    }
    throw new Error(`Selected sidebar lighting must remain byte-identical when hovered: ${JSON.stringify({ selectedHoverProof, selectedNeutralVisual, selectedHoverVisual, selectedHoverSettledVisual })}`);
  }
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  const ptbHoverPoint = {
    x: neutralSidebar.tileRect.left + neutralSidebar.tileRect.width / 2,
    y: neutralSidebar.tileRect.top + neutralSidebar.tileRect.height / 2
  };
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ptbHoverPoint.x, y: ptbHoverPoint.y });
  await evaluate(client, `(() => {
    const tile = document.querySelector('#ptbTileButton');
    getComputedStyle(tile).color;
    tile.getAnimations().forEach((animation) => animation.finish());
    for (const child of tile.querySelectorAll('.game-thumb, .game-copy, .game-copy strong')) {
      child.getAnimations().forEach((animation) => animation.finish());
    }
    return true;
  })()`);
  const sidebarHoverProof = await evaluate(client, `(() => {
    const hovered = document.querySelector('#ptbTileButton');
    const selected = document.querySelector('#gameTileButton');
    const title = hovered.querySelector('.game-copy strong');
    const thumb = hovered.querySelector('.game-thumb');
    return {
      hovered: hovered.matches(':hover'),
      backgroundImage: getComputedStyle(hovered).backgroundImage,
      boxShadow: getComputedStyle(hovered).boxShadow,
      titleColor: getComputedStyle(title).color,
      titleTextShadow: getComputedStyle(title).textShadow,
      thumbOpacity: Number.parseFloat(getComputedStyle(thumb).opacity),
      thumbFilter: getComputedStyle(thumb).filter,
      selectedBackgroundImage: getComputedStyle(selected).backgroundImage,
      selectedTitleColor: getComputedStyle(selected.querySelector('.game-copy strong')).color
    };
  })()`);
  if (
    !sidebarHoverProof.hovered
    || sidebarHoverProof.backgroundImage !== 'none'
    || sidebarHoverProof.boxShadow !== 'none'
    || sidebarHoverProof.titleColor !== 'rgb(176, 186, 193)'
    || sidebarHoverProof.titleTextShadow !== 'none'
    || sidebarHoverProof.thumbOpacity !== 1
    || sidebarHoverProof.thumbFilter !== 'none'
    || !sidebarHoverProof.selectedBackgroundImage.includes('sidebar-selected-light.png')
    || sidebarHoverProof.selectedTitleColor !== 'rgb(225, 238, 244)'
  ) {
    throw new Error(`Sidebar hover must brighten only the icon and title while preserving the selected BSG fade: ${JSON.stringify(sidebarHoverProof)}`);
  }
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await click(client, '#ptbTileButton');
  const ptbActiveProof = await waitFor(client, `
    window.aht.getStatus('ptb').then((status) => {
      const aht = document.querySelector('#gameTileButton');
      const ptb = document.querySelector('#ptbTileButton');
      const latestVersion = document.querySelector('#latestVersion')?.textContent?.trim() || '';
      const removedHeroLabels = !document.querySelector('#playerPackTitle') && !document.querySelector('#versionLine');
      const ptbTitleColor = getComputedStyle(ptb.querySelector('.game-copy strong')).color;
      const ahtTitleColor = getComputedStyle(aht.querySelector('.game-copy strong')).color;
      return ptb?.classList.contains('active') && removedHeroLabels && latestVersion === '10.0.0-ptb.1' && ptbTitleColor === 'rgb(225, 238, 244)' && ahtTitleColor === 'rgb(106, 113, 117)' ? {
        ahtActive: aht.classList.contains('active'),
        ptbActive: ptb.classList.contains('active'),
        activeView: document.querySelector('.view.active')?.id || '',
        removedHeroLabels,
        latestVersion,
        activePack: status.activePack,
        releaseTarget: status.releaseTarget,
        packId: status.config?.packId,
        latestUrl: status.config?.latestUrl,
        instanceDir: status.config?.instanceDir,
        profileId: status.config?.minecraftLauncher?.profileId,
        profileName: status.config?.minecraftLauncher?.profileName,
        feedPackId: status.latest?.packId,
        ptbBackground: getComputedStyle(ptb).backgroundImage,
        ahtBackground: getComputedStyle(aht).backgroundImage,
        ptbTitleColor,
        ptbTitleShadow: getComputedStyle(ptb.querySelector('.game-copy strong')).textShadow,
        ahtTitleColor
      } : false;
    })
  `, 'PTB sidebar selection');
  if (
    ptbActiveProof.ahtActive
    || !ptbActiveProof.ptbActive
    || !ptbActiveProof.removedHeroLabels
    || ptbActiveProof.activeView !== 'player'
    || ptbActiveProof.activePack !== 'ptb'
    || ptbActiveProof.releaseTarget !== 'ptb'
    || ptbActiveProof.packId !== 'a-hard-time-ptb'
    || ptbActiveProof.feedPackId !== 'a-hard-time-ptb'
    || ptbActiveProof.latestUrl !== `${workerEndpoint}/ptb/latest.json`
    || path.resolve(ptbActiveProof.instanceDir) !== path.resolve(ptbInstanceDir)
    || ptbActiveProof.profileId !== 'a-hard-time-ptb'
    || ptbActiveProof.profileName !== 'A Hard Time PTB'
    || !ptbActiveProof.ptbBackground.includes('sidebar-selected-light.png')
    || ptbActiveProof.ahtBackground !== 'none'
    || ptbActiveProof.ptbTitleColor !== 'rgb(225, 238, 244)'
    || ptbActiveProof.ptbTitleShadow !== 'none'
    || ptbActiveProof.ahtTitleColor !== 'rgb(106, 113, 117)'
  ) {
    throw new Error(`PTB selection must use isolated feed, instance, and Minecraft profile state: ${JSON.stringify(ptbActiveProof)}`);
  }
  await click(client, '#gameTileButton');
  const stableRestoredProof = await waitFor(client, `
    window.aht.getStatus('stable').then((status) => {
      const latestVersion = document.querySelector('#latestVersion')?.textContent?.trim() || '';
      const removedHeroLabels = !document.querySelector('#playerPackTitle') && !document.querySelector('#versionLine');
      return document.querySelector('#gameTileButton')?.classList.contains('active') && removedHeroLabels && latestVersion === '9.9.9' ? {
        activePack: status.activePack,
        releaseTarget: status.releaseTarget,
        packId: status.config?.packId,
        latestUrl: status.config?.latestUrl,
        profileId: status.config?.minecraftLauncher?.profileId,
        removedHeroLabels
      } : false;
    })
  `, 'stable sidebar state restored after PTB');
  if (
    stableRestoredProof.activePack !== 'aht'
    || !stableRestoredProof.removedHeroLabels
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
      usernameSurfaceAbsent: !document.querySelector('#accountOverlay')
        && !document.querySelector('#minecraftUsernameInput')
        && !document.querySelector('#playerLabelInput')
        && typeof window.aht.accountRegister === 'undefined',
      playerLabel: document.querySelector('#playerLabelView')?.textContent || ''
    } : false)
  `, 'layout account identity');
  if (!identityProof.username || !identityProof.usernameSurfaceAbsent || identityProof.playerLabel !== identityProof.username) {
    throw new Error(`Automatic identity was not reflected without a manual username surface: ${JSON.stringify(identityProof)}`);
  }
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await sleep(260);
  const chromeLightProof = await evaluate(client, `
    (() => {
      const describeNav = (selector) => {
        const nav = document.querySelector(selector);
        const style = getComputedStyle(nav);
        const marker = getComputedStyle(nav, '::after');
        const rect = nav.getBoundingClientRect();
        return {
          active: nav.classList.contains('active'),
          hovered: nav.matches(':hover'),
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          backgroundImage: style.backgroundImage,
          boxShadow: style.boxShadow,
          color: style.color,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          textShadow: style.textShadow,
          markerContent: marker.content,
          markerHeight: marker.height,
          markerBottom: marker.bottom,
          markerBackgroundImage: marker.backgroundImage,
          markerBoxShadow: marker.boxShadow,
          markerTransform: marker.transform
        };
      };
      const profile = document.querySelector('#profileFriendsButton');
      const activeTile = document.querySelector('.game-tile.active');
      const profileStyle = getComputedStyle(profile);
      const tileStyle = getComputedStyle(activeTile);
      return {
        pointerClasses: document.querySelectorAll('.pointer-light-surface, .is-pointer-lit').length,
        inlinePointerVariables: [...document.querySelectorAll('*')].filter((node) => node.style.getPropertyValue('--pointer-x') || node.style.getPropertyValue('--pointer-y')).length,
        game: describeNav('#gameTab'),
        news: describeNav('#newsTab'),
        settings: describeNav('.nav [data-tab="settings"]'),
        profileBackgroundImage: profileStyle.backgroundImage,
        profileBoxShadow: profileStyle.boxShadow,
        tileBackgroundImage: tileStyle.backgroundImage
      };
    })()
  `);
  const gameRect = chromeLightProof.game.rect;
  const newsRect = chromeLightProof.news.rect;
  const closeTo = (actual, expected, tolerance = 0.75) => Math.abs(Number(actual) - Number(expected)) <= tolerance;
  if (
    chromeLightProof.pointerClasses !== 0
    || chromeLightProof.inlinePointerVariables !== 0
    || !chromeLightProof.game.active
    || chromeLightProof.news.active
    || chromeLightProof.settings.active
    || !closeTo(gameRect.left, 257)
    || !closeTo(gameRect.top, 38)
    || !closeTo(gameRect.height, 41)
    || !closeTo(newsRect.left - gameRect.left, 82, 1)
    || chromeLightProof.game.fontFamily.split(',')[0].replaceAll('"', '').trim() !== 'AHT Bender'
    || chromeLightProof.game.fontSize !== '22.5px'
    || chromeLightProof.game.fontWeight !== '400'
    || chromeLightProof.game.lineHeight !== '22.5px'
    || chromeLightProof.game.backgroundImage !== 'none'
    || chromeLightProof.game.boxShadow !== 'none'
    || !chromeLightProof.game.textShadow.includes('16px')
    || chromeLightProof.game.markerContent === 'none'
    || chromeLightProof.game.markerHeight !== '16px'
    || chromeLightProof.game.markerBottom !== '-26px'
    || !chromeLightProof.game.markerBackgroundImage.includes('linear-gradient')
    || chromeLightProof.game.markerBoxShadow !== 'none'
    || chromeLightProof.game.markerTransform !== 'none'
    || chromeLightProof.news.backgroundImage !== 'none'
    || chromeLightProof.news.boxShadow !== 'none'
    || !chromeLightProof.news.textShadow.includes('8px')
    || chromeLightProof.news.markerContent !== 'none'
    || chromeLightProof.profileBackgroundImage !== 'none'
    || chromeLightProof.profileBoxShadow !== 'none'
    || !chromeLightProof.tileBackgroundImage.includes('sidebar-selected-light.png')
  ) {
    throw new Error(`Launcher navigation did not retain the measured BSG geometry and selected-state fade: ${JSON.stringify(chromeLightProof)}`);
  }
  const navStatePoint = async (selector) => evaluate(client, `(() => {
    const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : false;
  })()`);
  const navStateProof = async (selector) => evaluate(client, `(() => {
    const nav = document.querySelector(${JSON.stringify(selector)});
    if (!nav) return false;
    const style = getComputedStyle(nav);
    const marker = getComputedStyle(nav, '::after');
    return {
      active: nav.classList.contains('active'),
      hovered: nav.matches(':hover'),
      backgroundImage: style.backgroundImage,
      boxShadow: style.boxShadow,
      color: style.color,
      textShadow: style.textShadow,
      markerContent: marker.content,
      markerHeight: marker.height,
      markerBackgroundImage: marker.backgroundImage
    };
  })()`);
  for (const selector of ['#newsTab', '.nav [data-tab="settings"]']) {
    const point = await navStatePoint(selector);
    if (!point) throw new Error(`Navigation hover target was unavailable: ${selector}`);
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await evaluate(client, `(() => {
      const nav = document.querySelector(${JSON.stringify(selector)});
      getComputedStyle(nav).textShadow;
      nav.getAnimations().forEach((animation) => animation.finish());
      return true;
    })()`);
    await sleep(260);
    const hoverProof = await navStateProof(selector);
    if (
      !hoverProof?.hovered
      || hoverProof.active
      || hoverProof.backgroundImage !== 'none'
      || hoverProof.boxShadow !== 'none'
      || hoverProof.color !== 'rgb(255, 255, 255)'
      || hoverProof.textShadow !== chromeLightProof.game.textShadow
      || hoverProof.markerContent !== 'none'
    ) {
      throw new Error(`Unselected navigation hover must add only the measured BSG text glow: ${selector} ${JSON.stringify(hoverProof)}`);
    }
  }
  for (const selector of ['#newsTab', '.nav [data-tab="settings"]', '#gameTab']) {
    await click(client, selector);
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await evaluate(client, `(() => {
      const nav = document.querySelector(${JSON.stringify(selector)});
      getComputedStyle(nav).textShadow;
      nav.getAnimations().forEach((animation) => animation.finish());
      return true;
    })()`);
    await sleep(260);
    const selectedProof = await navStateProof(selector);
    if (
      !selectedProof?.active
      || selectedProof.hovered
      || selectedProof.backgroundImage !== 'none'
      || selectedProof.boxShadow !== 'none'
      || selectedProof.color !== 'rgb(255, 255, 255)'
      || selectedProof.textShadow !== chromeLightProof.game.textShadow
      || selectedProof.markerContent === 'none'
      || selectedProof.markerHeight !== '16px'
      || !selectedProof.markerBackgroundImage.includes('linear-gradient')
    ) {
      throw new Error(`Selected navigation must add the measured BSG bottom fade without a tile background: ${selector} ${JSON.stringify(selectedProof)}`);
    }
  }
  await waitFor(client, "document.querySelector('#updateLogGrid')?.hidden === false", 'layout update logs');
  await click(client, '#newsTab');
  const newsNavigationProof = await waitFor(client, `
    (() => {
      const cards = [...document.querySelectorAll('#newsFeedGrid .feature-card')];
      return document.querySelector('.view.active')?.id === 'news' && cards.length === 3 ? {
        activeView: document.querySelector('.view.active')?.id || '',
        activeTab: document.querySelector('#newsTab')?.classList.contains('active') || false,
        packSelected: document.querySelector('#gameTileButton')?.classList.contains('active') || false,
        count: cards.length,
        firstTitle: cards[0]?.querySelector('strong')?.textContent?.trim() || '',
        redundantHeader: Boolean(document.querySelector('.news-view-header, .news-feed-state')),
        openButtons: cards.reduce((count, card) => count + card.querySelectorAll('.news-card-open').length, 0),
        likeButtons: cards.reduce((count, card) => count + card.querySelectorAll('.news-card-like').length, 0)
      } : false;
    })()
  `, 'dedicated News navigation');
  if (!newsNavigationProof.activeTab || !newsNavigationProof.packSelected || newsNavigationProof.firstTitle !== 'Launcher Stability Pass' || newsNavigationProof.redundantHeader || newsNavigationProof.openButtons !== 2 || newsNavigationProof.likeButtons !== 2) {
    throw new Error(`News navigation must retain pack context and separate each article action from its like action: ${JSON.stringify(newsNavigationProof)}`);
  }
  const refreshedSocialLinks = await evaluate(client, `loadLauncherSocialLinks({ forceRefresh: true })`);
  if (
    refreshedSocialLinks?.source !== 'published'
    || JSON.stringify(refreshedSocialLinks?.links) !== JSON.stringify(launcherSocialLinks)
  ) {
    throw new Error(`Player launcher did not load the published Social Links manifest: ${JSON.stringify(refreshedSocialLinks)}`);
  }
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await evaluate(client, `document.querySelector('#gameTab').focus(); true`);
  await sleep(220);
  const socialMenuRestProof = await evaluate(client, `(() => {
    const menu = document.querySelector('#launcherSocialMenu');
    const discord = document.querySelector('#discordSocialLink');
    const dropdown = document.querySelector('#launcherSocialDropdown');
    const profile = document.querySelector('#profileFriendsButton');
    const style = getComputedStyle(dropdown);
    return {
      source: menu?.dataset.source || '',
      directButtons: [...menu.children].filter((node) => node.matches?.('.social-link')).map((node) => node.id),
      dropdownButtons: [...dropdown.querySelectorAll(':scope > .social-link')].map((node) => node.id),
      profileImmediatelyAfter: menu?.nextElementSibling === profile && profile?.previousElementSibling === menu,
      menuBackground: getComputedStyle(menu).backgroundColor,
      discordBackground: getComputedStyle(discord).backgroundColor,
      dropdownBackground: style.backgroundColor,
      dropdownVisibility: style.visibility,
      dropdownOpacity: Number(style.opacity),
      dropdownPointerEvents: style.pointerEvents,
      expanded: discord?.getAttribute('aria-expanded')
    };
  })()`);
  if (
    socialMenuRestProof.source !== 'published'
    || JSON.stringify(socialMenuRestProof.directButtons) !== JSON.stringify(['discordSocialLink'])
    || JSON.stringify(socialMenuRestProof.dropdownButtons) !== JSON.stringify(['youtubeSocialLink', 'tiktokSocialLink', 'forumSocialLink'])
    || !socialMenuRestProof.profileImmediatelyAfter
    || !/rgba\(0, 0, 0, 0\)|transparent/.test(socialMenuRestProof.menuBackground)
    || !/rgba\(0, 0, 0, 0\)|transparent/.test(socialMenuRestProof.discordBackground)
    || !/rgba\(0, 0, 0, 0\)|transparent/.test(socialMenuRestProof.dropdownBackground)
    || socialMenuRestProof.dropdownVisibility !== 'hidden'
    || socialMenuRestProof.dropdownOpacity !== 0
    || socialMenuRestProof.dropdownPointerEvents !== 'none'
    || socialMenuRestProof.expanded !== 'false'
  ) {
    throw new Error(`Social menu rest state must be one background-free Discord icon immediately left of the profile: ${JSON.stringify(socialMenuRestProof)}`);
  }
  const discordHoverPoint = await evaluate(client, `(() => {
    const rect = document.querySelector('#discordSocialLink').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: discordHoverPoint.x, y: discordHoverPoint.y });
  const socialMenuExpandedProof = await waitFor(client, `(() => {
    const discord = document.querySelector('#discordSocialLink');
    const dropdown = document.querySelector('#launcherSocialDropdown');
    const style = getComputedStyle(dropdown);
    if (style.visibility !== 'visible' || Number(style.opacity) < 0.99) return false;
    const discordRect = discord.getBoundingClientRect();
    const rows = [...dropdown.querySelectorAll(':scope > .social-link')].map((node) => {
      const rect = node.getBoundingClientRect();
      return { id: node.id, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    return {
      expanded: discord.getAttribute('aria-expanded'),
      pointerEvents: style.pointerEvents,
      discordBottom: discordRect.bottom,
      rows
    };
  })()`, 'vertical Social Links dropdown');
  const socialRows = socialMenuExpandedProof.rows || [];
  if (
    socialMenuExpandedProof.expanded !== 'true'
    || socialMenuExpandedProof.pointerEvents !== 'auto'
    || socialRows.length !== 3
    || socialRows[0].top <= socialMenuExpandedProof.discordBottom
    || !(socialRows[0].top < socialRows[1].top && socialRows[1].top < socialRows[2].top)
    || socialRows.some((row) => Math.abs(row.left - socialRows[0].left) > 0.75)
    || socialRows.some((row) => row.width < 40 || row.height < 40)
  ) {
    throw new Error(`Social Links hover/focus menu is not a single vertical column below Discord: ${JSON.stringify(socialMenuExpandedProof)}`);
  }
  const diagonalCorridorPoint = {
    x: socialRows[0].left - 8,
    y: socialMenuExpandedProof.discordBottom + ((socialRows[0].top - socialMenuExpandedProof.discordBottom) / 2)
  };
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: diagonalCorridorPoint.x, y: diagonalCorridorPoint.y });
  await sleep(80);
  const corridorProof = await evaluate(client, `(() => {
    const menu = document.querySelector('#launcherSocialMenu');
    const dropdown = document.querySelector('#launcherSocialDropdown');
    const hit = document.elementFromPoint(${JSON.stringify(diagonalCorridorPoint.x)}, ${JSON.stringify(diagonalCorridorPoint.y)});
    const style = getComputedStyle(dropdown);
    return {
      menuHover: menu.matches(':hover'),
      visible: style.visibility === 'visible' && Number(style.opacity) > 0.5,
      hitInsideDropdown: Boolean(hit?.closest?.('#launcherSocialDropdown')),
      expanded: document.querySelector('#discordSocialLink').getAttribute('aria-expanded')
    };
  })()`);
  if (!corridorProof.menuHover || !corridorProof.visible || !corridorProof.hitInsideDropdown || corridorProof.expanded !== 'true') {
    throw new Error(`Social Links diagonal pointer corridor collapsed between Discord and the dropdown: ${JSON.stringify({ diagonalCorridorPoint, corridorProof })}`);
  }
  const youtubePoint = {
    x: socialRows[0].left + (socialRows[0].width / 2),
    y: socialRows[0].top + (socialRows[0].height / 2)
  };
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: youtubePoint.x, y: youtubePoint.y });
  await sleep(80);
  const youtubeHoverProof = await evaluate(client, `(() => ({
    visible: getComputedStyle(document.querySelector('#launcherSocialDropdown')).visibility,
    hovered: document.querySelector('#youtubeSocialLink').matches(':hover'),
    expanded: document.querySelector('#discordSocialLink').getAttribute('aria-expanded')
  }))()`);
  if (youtubeHoverProof.visible !== 'visible' || !youtubeHoverProof.hovered || youtubeHoverProof.expanded !== 'true') {
    throw new Error(`Social Links dropdown disappeared before the pointer reached YouTube: ${JSON.stringify(youtubeHoverProof)}`);
  }
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await evaluate(client, `document.querySelector('#gameTab').focus(); true`);
  const socialMenuClosedProof = await waitFor(client, `(() => {
    const discord = document.querySelector('#discordSocialLink');
    const dropdown = document.querySelector('#launcherSocialDropdown');
    const style = getComputedStyle(dropdown);
    return style.visibility === 'hidden' && Number(style.opacity) === 0 && discord.getAttribute('aria-expanded') === 'false';
  })()`, 'Social Links dropdown close after focus leaves');
  const externalLinkProof = await evaluate(client, `
    Promise.all(['store', 'discord', 'youtube', 'tiktok', 'forum', 'unapproved'].map(async (destination) => [destination, await window.aht.openExternal(destination)]))
      .then((entries) => Object.fromEntries(entries))
  `);
  if (
    externalLinkProof.store?.ok !== true
    || externalLinkProof.store?.captured !== true
    || externalLinkProof.store?.target !== 'https://ahardtime.net/store'
    || externalLinkProof.discord?.target !== launcherSocialLinks.discord
    || externalLinkProof.youtube?.target !== launcherSocialLinks.youtube
    || externalLinkProof.tiktok?.target !== launcherSocialLinks.tiktok
    || externalLinkProof.forum?.target !== launcherSocialLinks.forum
    || ['discord', 'youtube', 'tiktok', 'forum'].some((key) => externalLinkProof[key]?.ok !== true || externalLinkProof[key]?.captured !== true)
    || externalLinkProof.unapproved?.ok !== false
    || externalLinkProof.unapproved?.opened !== false
  ) {
    throw new Error(`External-link allowlist did not map the exact published social destinations and deny unknown keys: ${JSON.stringify(externalLinkProof)}`);
  }
  await click(client, '#storeTab');
  await click(client, '#gameTab');
  await waitFor(client, "document.querySelector('.view.active')?.id === 'player'", 'return to Game after News and Store checks');

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

  const toastLifetimeProof = await evaluate(client, `
    (async () => {
      const stack = document.querySelector('#toastStack');
      stack.replaceChildren();
      const measureToast = (title, type, options) => new Promise((resolve, reject) => {
        let target = null;
        let insertedAt = 0;
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (
                !target
                && node.nodeType === Node.ELEMENT_NODE
                && node.classList.contains('toast')
                && node.querySelector('strong')?.textContent === title
              ) {
                target = node;
                insertedAt = performance.now();
              }
            }
            if (target && [...record.removedNodes].includes(target)) {
              window.clearTimeout(timeout);
              observer.disconnect();
              resolve({ removed: true, durationMs: performance.now() - insertedAt });
              return;
            }
          }
        });
        const timeout = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error('Toast was not removed: ' + title));
        }, 6000);
        observer.observe(stack, { childList: true });
        showToast(title, 'Player toast lifetime probe', type, options);
      });
      const defaultError = await measureToast('Default error toast lifetime', 'error');
      const overriddenSuccess = await measureToast('Overridden success toast lifetime', 'success', { durationMs: 5200 });
      return { defaultError, overriddenSuccess };
    })()
  `);
  if (
    toastLifetimeProof?.defaultError?.removed !== true
    || toastLifetimeProof?.overriddenSuccess?.removed !== true
    || !Number.isFinite(toastLifetimeProof.defaultError.durationMs)
    || !Number.isFinite(toastLifetimeProof.overriddenSuccess.durationMs)
    || toastLifetimeProof.defaultError.durationMs > 4250
    || toastLifetimeProof.overriddenSuccess.durationMs > 4250
  ) {
    throw new Error(`Regular player toast lifetime exceeded 4250ms: ${JSON.stringify(toastLifetimeProof)}`);
  }

  const reports = [];
  const screenshots = [];
  for (const size of [
    { name: 'fixed', width: 1432, height: 760 }
  ]) {
    await click(client, '.nav [data-tab="player"]');
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(260);
    reports.push(await assertLayout(client, `${size.name}-player`));
    screenshots.push(await captureScreenshot(client, `${size.name}-player`));
    screenshots.push(await captureScreenshot(client, `${size.name}-nav-game-active`));
    screenshots.push(await captureScreenshot(client, `${size.name}-sidebar-aht-active`));
    const ahtSidebarHoverPoint = await evaluate(client, `(() => {
      const rect = document.querySelector('#gameTileButton')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : false;
    })()`);
    if (!ahtSidebarHoverPoint) throw new Error('Selected AHT sidebar hover capture target was unavailable.');
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ahtSidebarHoverPoint.x, y: ahtSidebarHoverPoint.y });
    await sleep(80);
    screenshots.push(await captureScreenshot(client, `${size.name}-sidebar-aht-active-hover`));
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    const ptbSidebarHoverPoint = await evaluate(client, `(() => {
      const rect = document.querySelector('#ptbTileButton')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : false;
    })()`);
    if (!ptbSidebarHoverPoint) throw new Error('PTB sidebar hover capture target was unavailable.');
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ptbSidebarHoverPoint.x, y: ptbSidebarHoverPoint.y });
    await evaluate(client, `(() => {
      const tile = document.querySelector('#ptbTileButton');
      getComputedStyle(tile).color;
      tile.getAnimations().forEach((animation) => animation.finish());
      for (const child of tile.querySelectorAll('.game-thumb, .game-copy, .game-copy strong')) {
        child.getAnimations().forEach((animation) => animation.finish());
      }
      return true;
    })()`);
    await sleep(80);
    screenshots.push(await captureScreenshot(client, `${size.name}-sidebar-ptb-hover`));
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await click(client, '#ptbTileButton');
    screenshots.push(await captureScreenshot(client, `${size.name}-sidebar-ptb-active`));
    await click(client, '#gameTileButton');
    const newsNavHoverPoint = await evaluate(client, `(() => {
      const rect = document.querySelector('#newsTab')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : false;
    })()`);
    if (!newsNavHoverPoint) throw new Error('News navigation hover capture target was unavailable.');
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: newsNavHoverPoint.x, y: newsNavHoverPoint.y });
    await evaluate(client, `(() => {
      const nav = document.querySelector('#newsTab');
      getComputedStyle(nav).textShadow;
      nav.getAnimations().forEach((animation) => animation.finish());
      return true;
    })()`);
    await sleep(260);
    screenshots.push(await captureScreenshot(client, `${size.name}-nav-news-hover`));
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(260);
    const primaryActionState = await evaluate(client, `(() => {
      const button = document.querySelector('#playButton');
      if (!button) return false;
      const saved = {
        className: button.className,
        mode: button.dataset.actionMode || '',
        html: button.innerHTML,
        ariaDisabled: button.getAttribute('aria-disabled'),
        tabIndex: button.getAttribute('tabindex')
      };
      button.classList.remove('is-install-action', 'is-update-action', 'is-disabled');
      button.classList.add('is-play-action');
      button.dataset.actionMode = 'play';
      button.setAttribute('aria-disabled', 'false');
      button.setAttribute('tabindex', '0');
      button.innerHTML = '<span class="button-icon icon-play" aria-hidden="true"></span><span class="primary-action-label">Play</span>';
      return saved;
    })()`);
    if (!primaryActionState) throw new Error('Primary action visual-state capture target was unavailable.');
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(80);
    screenshots.push(await captureScreenshot(client, `${size.name}-player-play`));
    const playStateHoverPoint = await evaluate(client, `(() => {
      const rect = document.querySelector('#playButton')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : false;
    })()`);
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: playStateHoverPoint.x, y: playStateHoverPoint.y });
    await sleep(80);
    screenshots.push(await captureScreenshot(client, `${size.name}-player-play-hover`));
    await evaluate(client, `(() => {
      const button = document.querySelector('#playButton');
      const saved = ${JSON.stringify(primaryActionState)};
      button.className = saved.className;
      button.dataset.actionMode = saved.mode;
      button.innerHTML = saved.html;
      if (saved.ariaDisabled === null) button.removeAttribute('aria-disabled'); else button.setAttribute('aria-disabled', saved.ariaDisabled);
      if (saved.tabIndex === null) button.removeAttribute('tabindex'); else button.setAttribute('tabindex', saved.tabIndex);
      return true;
    })()`);
    const playHoverPoint = await evaluate(client, `(() => {
      const rect = document.querySelector('#playButton')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : false;
    })()`);
    if (!playHoverPoint) throw new Error('Primary action hover capture target was unavailable.');
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: playHoverPoint.x, y: playHoverPoint.y });
    await sleep(260);
    screenshots.push(await captureScreenshot(client, `${size.name}-player-hover`));
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await click(client, '.nav [data-tab="news"]');
    reports.push(await assertLayout(client, `${size.name}-news`));
    screenshots.push(await captureScreenshot(client, `${size.name}-news`));
    screenshots.push(await captureScreenshot(client, `${size.name}-nav-news-active`));
    const settingsNavHoverPoint = await evaluate(client, `(() => {
      const rect = document.querySelector('.nav [data-tab="settings"]')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : false;
    })()`);
    if (!settingsNavHoverPoint) throw new Error('Settings navigation hover capture target was unavailable.');
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: settingsNavHoverPoint.x, y: settingsNavHoverPoint.y });
    await evaluate(client, `(() => {
      const nav = document.querySelector('.nav [data-tab="settings"]');
      getComputedStyle(nav).textShadow;
      nav.getAnimations().forEach((animation) => animation.finish());
      return true;
    })()`);
    await sleep(260);
    screenshots.push(await captureScreenshot(client, `${size.name}-nav-settings-hover`));
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(260);
    await click(client, '.nav [data-tab="settings"]');
    reports.push(await assertLayout(client, `${size.name}-settings`));
    screenshots.push(await captureScreenshot(client, `${size.name}-settings`));
    screenshots.push(await captureScreenshot(client, `${size.name}-nav-settings-active`));
    await click(client, '#downloadsButton');
    const downloadsDecorationProof = await evaluate(client, `(() => {
      const dialog = document.querySelector('.downloads-dialog');
      return dialog ? {
        background: getComputedStyle(dialog).backgroundImage,
        before: getComputedStyle(dialog, '::before').backgroundImage
      } : false;
    })()`);
    if (!downloadsDecorationProof || /(?:115|135)deg/.test(`${downloadsDecorationProof.background} ${downloadsDecorationProof.before}`)) {
      throw new Error(`Downloads must not render either long diagonal decoration line: ${JSON.stringify(downloadsDecorationProof)}`);
    }
    reports.push(await assertLayout(client, `${size.name}-downloads`));
    screenshots.push(await captureScreenshot(client, `${size.name}-downloads`));
    await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    screenshots,
    socialMenu: {
      rest: socialMenuRestProof,
      expanded: socialMenuExpandedProof,
      closed: socialMenuClosedProof,
      externalLinks: externalLinkProof
    },
    toastLifetimeMs: {
      defaultError: toastLifetimeProof.defaultError.durationMs,
      overriddenSuccess: toastLifetimeProof.overriddenSuccess.durationMs
    },
    reports: reports.map(({ label, viewport, activeView }) => ({ label, viewport, activeView }))
  }, null, 2));
} finally {
  if (client) {
    await client.call('Browser.close').catch(() => {});
    client.close();
  }
  child.kill();
  const closePromise = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closePromise;
}
