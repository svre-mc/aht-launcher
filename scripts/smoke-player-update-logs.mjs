import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 10160);
const endpoint = `http://127.0.0.1:${port}`;
const workerPort = port + 1;
const workerEndpoint = `http://127.0.0.1:${workerPort}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-update-logs-'));
const userData = path.join(root, 'userData');
const instanceDir = path.join(root, 'instance');
const ptbInstanceDir = path.join(root, 'instance-ptb');
const mcRoot = path.join(root, 'minecraft');
const screenshotDir = path.join(root, 'screenshots');
const updateLogArtwork = fs.readFileSync(path.resolve('desktop', 'renderer', 'assets', 'aht-cover.png'));
const updateLogRequests = [];
const likeRequests = [];
let electronExit = null;
let electronOutput = '';
const smokeExe = process.env.AHT_SMOKE_EXE || '';
const electronBin = smokeExe || (process.platform === 'win32'
  ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve('node_modules', '.bin', 'electron'));
const electronArgs = smokeExe
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  : ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
const electronCwd = smokeExe ? path.dirname(smokeExe) : process.cwd();

const logs = [
  {
    id: '00000000-0000-4000-8000-000000000004',
    title: 'Launcher Stability Patch',
    subtitle: 'Cleaner installs, faster update checks, and a readable full log.',
    text: '# Launcher Stability\nNewest update log from developer launcher.\n- Full update-log articles open inside the launcher.\n- Optional media opens in a dedicated player.\n- Cards stay concise on the home screen.',
    version: '2.8.4',
    publishedAt: '2026-06-24T12:04:00.000Z',
    author: 'admin',
    likes: 921,
    image: { type: 'image', url: `${workerEndpoint}/update-media/log-4.webp`, path: 'update-media/log-4.webp' },
    media: { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Launcher patch video' }
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    title: 'Third newest launcher stability update',
    subtitle: 'A written-only update log.',
    text: '# Written Notes\nSecond visible update log.\n- Non-playable logs should open the full article from the card art or title.\n![Patch comparison](https://packs.example.com/update-media/body-shot.webp)',
    version: '2.8.3',
    publishedAt: '2026-06-24T12:03:00.000Z',
    author: 'admin',
    likes: 16,
    metadata: {
      image: { type: 'image', url: `${workerEndpoint}/update-media/log-3.webp`, path: 'update-media/log-3.webp' }
    }
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    title: 'Second newest',
    subtitle: 'A log with an uploaded MP4.',
    text: '# Video Notes\nThird visible update log with a direct video URL.',
    version: '2.8.2',
    publishedAt: '2026-06-24T12:02:00.000Z',
    author: 'admin',
    likes: 2,
    image_url: `${workerEndpoint}/update-media/log-2.webp`,
    media: { type: 'video', url: `${workerEndpoint}/update-media/patch.mp4`, title: 'Direct MP4' }
  },
  {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Old hidden',
    text: 'This older log must not render on the player home screen.',
    version: '2.8.1',
    publishedAt: '2026-06-24T12:01:00.000Z',
    author: 'admin',
    likes: 0
  }
];

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
    if (electronExit) {
      const detail = electronOutput.trim().slice(-4000);
      throw new Error(`Electron exited before exposing a debugger target (${electronExit}).${detail ? `\n${detail}` : ''}`);
    }
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
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.error) {
      reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
    } else {
      resolve(message.result || {});
    }
  });
  socket.addEventListener('close', () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('CDP socket closed'));
    }
    pending.clear();
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve({
        call(method, params = {}) {
          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((callResolve, callReject) => {
            const timer = setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              callReject(new Error(`CDP call timed out: ${method}`));
            }, 30000);
            pending.set(id, { resolve: callResolve, reject: callReject, timer });
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
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
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

async function waitForNewsCarouselSettled(client, expectedIndex, label) {
  return waitFor(client, `(() => {
    const card = document.querySelector('.news-feature-carousel');
    const proof = {
      index: card?.dataset.activeIndex || '',
      title: document.querySelector('.news-carousel-caption-title')?.textContent || '',
      layers: document.querySelectorAll('.news-carousel-slide').length,
      switching: card?.classList.contains('is-switching') || false,
      transform: card ? getComputedStyle(card).transform : ''
    };
    return proof.index === ${JSON.stringify(String(expectedIndex))} && proof.layers === 1 && !proof.switching ? proof : false;
  })()`, label, 20);
}

async function captureScreenshot(client, name) {
  await fsp.mkdir(screenshotDir, { recursive: true });
  const result = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(screenshotDir, `${name}.png`);
  await fsp.writeFile(file, Buffer.from(result.data, 'base64'));
  return file;
}

async function nodeCenter(client, selector) {
  const center = await evaluate(client, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const box = node?.getBoundingClientRect();
    return box && box.width > 0 && box.height > 0
      ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      : null;
  })()`);
  if (!center) throw new Error(`Could not resolve pointer target: ${selector}`);
  return center;
}

async function movePointer(client, selectorOrPoint) {
  const point = typeof selectorOrPoint === 'string' ? await nodeCenter(client, selectorOrPoint) : selectorOrPoint;
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  return point;
}

async function pressPointer(client, point) {
  await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
}

async function releasePointer(client, point) {
  await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function clickNode(client, selector) {
  const point = await movePointer(client, selector);
  await pressPointer(client, point);
  await releasePointer(client, point);
  return point;
}

async function setForcedHover(client, selectors, enabled) {
  const { root: documentNode } = await client.call('DOM.getDocument', { depth: 0, pierce: true });
  for (const selector of selectors) {
    const { nodeId } = await client.call('DOM.querySelector', {
      nodeId: documentNode.nodeId,
      selector
    });
    if (!nodeId) throw new Error(`Could not force hover for missing node: ${selector}`);
    await client.call('CSS.forcePseudoState', {
      nodeId,
      forcedPseudoClasses: enabled ? ['hover'] : []
    });
  }
}

async function ensurePointerHoverOrFocus(client, hoverSelector, focusSelector = hoverSelector, forcedHoverSelectors = [hoverSelector]) {
  const acceptPointerHover = process.env.AHT_TEST_FORCE_CDP_HOVER !== '1';
  const proof = await evaluate(client, `(() => {
    const hoverNode = document.querySelector(${JSON.stringify(hoverSelector)});
    const focusNode = document.querySelector(${JSON.stringify(focusSelector)});
    const pointerHover = ${JSON.stringify(acceptPointerHover)} && Boolean(hoverNode?.matches(':hover'));
    if (!pointerHover && ${JSON.stringify(acceptPointerHover)}) focusNode?.focus({ preventScroll: true });
    return {
      pointerHover,
      focusWithin: Boolean(hoverNode?.matches(':focus-within')),
      activeTag: document.activeElement?.tagName || ''
    };
  })()`);
  if (proof.pointerHover) return 'pointer';
  if (proof.focusWithin) return 'keyboard-focus';
  await setForcedHover(client, forcedHoverSelectors, true);
  return 'cdp-forced-hover';
}

async function clearInteractionFocus(client, forcedHoverSelectors = []) {
  await evaluate(client, `(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return true;
  })()`);
  if (forcedHoverSelectors.length) await setForcedHover(client, forcedHoverSelectors, false);
}

await writeJson(path.join(userData, 'launcher.config.json'), {
  packId: 'a-hard-time-dregora',
  instanceDir,
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
  developer: { adminBaseUrl: `${workerEndpoint}/`, defaultOutDir: path.join(root, 'release'), defaultCacheModsDir: '', r2Bucket: 'ahtlauncher' },
  minecraftLauncher: { enabled: false, rootDir: mcRoot, profileId: 'a-hard-time-dregora', profileName: 'A Hard Time', memoryMb: 6144 },
  playCommand: { command: '', args: [], cwd: instanceDir }
});
await writeJson(path.join(userData, 'identity.json'), {
  installId: 'smoke-install',
  minecraftUsername: 'SmokeUser'
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url, workerEndpoint);
  if (url.pathname === '/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ packId: 'a-hard-time-dregora', name: 'A Hard Time', version: '2.8.4', required: true, zip: { url: 'packs/a-hard-time-2.8.4.zip' } }));
    return;
  }
  if (url.pathname === '/ptb/latest.json') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ packId: 'a-hard-time-ptb', name: 'A Hard Time PTB', version: '2.9.0-ptb.1', channel: 'ptb', required: true, zip: { url: 'ptb/packs/a-hard-time-2.9.0-ptb.1.zip' } }));
    return;
  }
  if (url.pathname === '/api/update-logs') {
    updateLogRequests.push(url.search);
    const limit = Math.max(0, Math.min(Number(url.searchParams.get('limit') || '3'), 50));
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ logs: logs.slice(0, limit) }));
    return;
  }
  if (/^\/update-media\/log-[234]\.webp$/.test(url.pathname)) {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'image/png');
    response.end(updateLogArtwork);
    return;
  }
  const likeMatch = url.pathname.match(/^\/api\/update-logs\/([0-9a-f-]{36})\/like$/i);
  if (request.method === 'POST' && likeMatch) {
    likeRequests.push(likeMatch[1].toLowerCase());
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: true, logId: likeMatch[1], liked: true, likes: 17 }));
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
    AHT_TEST_HOOKS: '1',
    AHT_TEST_USER_DATA: userData,
    AHT_ALLOW_UNENCRYPTED_DEVICE_KEY: '1',
    ELECTRON_ENABLE_LOGGING: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
child.stdout.on('data', (chunk) => { electronOutput = `${electronOutput}${String(chunk)}`.slice(-8000); });
child.stderr.on('data', (chunk) => { electronOutput = `${electronOutput}${String(chunk)}`.slice(-8000); });
child.on('error', (error) => { electronExit = `spawn error: ${error.message || error}`; });
child.on('exit', (code, signal) => { electronExit = signal || `exit code ${code}`; });

let client;
try {
  const screenshots = [];
  const target = await waitForTarget();
  client = await connect(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await client.call('DOM.enable');
  await client.call('CSS.enable');
  await client.call('Page.bringToFront');
  await client.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(client, "document.readyState === 'complete' && window.aht && !document.body.classList.contains('is-booting') && document.querySelector('#startupLoader')?.hidden", 'fully revealed player DOM');
  await waitFor(client, "document.querySelectorAll('#updateLogGrid .feature-card').length === 3", 'three update-log cards');
  await movePointer(client, { x: 1080, y: 74 });
  await clearInteractionFocus(client, ['#updateLogGrid .home-news-card']);
  await sleep(180);
  const unavailableArtworkUrl = `${workerEndpoint}/update-media/intentionally-unavailable.webp`;
  const artworkMetadataProof = await evaluate(client, `(async () => {
    startupFirstInitialization = false;
    const published = {
      image: { type: 'image', url: ${JSON.stringify(unavailableArtworkUrl)} },
      metadata: { image: { url: ${JSON.stringify(`${workerEndpoint}/update-media/nested.webp`)} } }
    };
    const [result] = await preloadStartupNewsArtwork([{ status: 'fulfilled', value: { updateLogs: [published] } }]);
    return {
      retainedImageUrl: result?.value?.updateLogs?.[0]?.image?.url || '',
      resolvedNestedUrl: updateLogImageUrl({ metadata: published.metadata }),
      resolvedSnakeUrl: updateLogImageUrl({ image_url: ${JSON.stringify(`${workerEndpoint}/update-media/snake.webp`)} }),
      resolvedStringUrl: updateLogImageUrl({ image: ${JSON.stringify(`${workerEndpoint}/update-media/string.webp`)} })
    };
  })()`);
  if (
    artworkMetadataProof.retainedImageUrl !== unavailableArtworkUrl
    || !artworkMetadataProof.resolvedNestedUrl.endsWith('/update-media/nested.webp')
    || !artworkMetadataProof.resolvedSnakeUrl.endsWith('/update-media/snake.webp')
    || !artworkMetadataProof.resolvedStringUrl.endsWith('/update-media/string.webp')
  ) {
    throw new Error(`News artwork metadata was discarded or not normalized: ${JSON.stringify(artworkMetadataProof)}`);
  }
  const proof = await evaluate(client, `
    (() => {
      const rect = (node) => {
        const value = node?.getBoundingClientRect();
        return value ? {
          left: Math.round(value.left),
          top: Math.round(value.top),
          right: Math.round(value.right),
          bottom: Math.round(value.bottom),
          width: Math.round(value.width),
          height: Math.round(value.height)
        } : null;
      };
      const cards = [...document.querySelectorAll('#updateLogGrid .feature-card')].map((card) => {
        const art = card.querySelector('.feature-art');
        const copy = card.querySelector('.feature-copy');
        const title = copy?.querySelector('strong');
        const summary = card.querySelector('.feature-summary');
        const copyStyle = getComputedStyle(copy);
        return {
          title: title?.textContent || '',
          meta: card.querySelector('.feature-copy span')?.textContent || '',
          body: summary?.textContent || '',
          large: card.classList.contains('large'),
          playable: Boolean(card.querySelector('.play-glyph')),
          tag: card.tagName,
          nestedButtons: card.querySelectorAll('button').length,
          hasRedundantCta: Boolean(card.querySelector('.feature-cta')),
          cardRect: rect(card),
          artRect: rect(art),
          copyRect: rect(copy),
          titleRect: rect(title),
          summaryRect: rect(summary),
          copyOpacity: copyStyle.opacity,
          copyVisibility: copyStyle.visibility,
          hasImage: art?.classList.contains('has-image') || false,
          backgroundImage: getComputedStyle(art).backgroundImage
        };
      });
      return {
        hidden: document.querySelector('#updateLogGrid').hidden,
        count: cards.length,
        cards,
        gridRect: rect(document.querySelector('#updateLogGrid')),
        fullText: document.querySelector('#updateLogGrid').textContent
      };
    })()
  `);
  const titles = proof.cards.map((card) => card.title);
  if (proof.hidden || proof.count !== 3) {
    throw new Error(`Expected exactly three visible update-log cards: ${JSON.stringify(proof)}`);
  }
  if (titles.join('|') !== 'Launcher Stability Patch|Third newest launcher stability update|Second newest') {
    throw new Error(`Player update logs are not the latest three in order: ${JSON.stringify(proof)}`);
  }
  if (proof.fullText.includes('Old hidden') || proof.fullText.includes('This older log must not render')) {
    throw new Error(`Old fourth log rendered unexpectedly: ${JSON.stringify(proof)}`);
  }
  if (!proof.cards[0].large || proof.cards.slice(1).some((card) => card.large)) {
    throw new Error(`Only the newest update log should be the large card: ${JSON.stringify(proof)}`);
  }
  if (proof.cards.some((card) => card.body.length < 24 || card.body === 'Read more...')) {
    throw new Error(`Home cards should show useful, compact update excerpts: ${JSON.stringify(proof)}`);
  }
  if (proof.cards.some((card) => card.tag !== 'BUTTON' || card.nestedButtons !== 0 || card.hasRedundantCta)) {
    throw new Error(`Update-log cards must use one full-card action without nested or redundant buttons: ${JSON.stringify(proof)}`);
  }
  if (JSON.stringify(proof.cards.map((card) => card.playable)) !== JSON.stringify([true, false, true])) {
    throw new Error(`Play buttons should only render for logs with media: ${JSON.stringify(proof)}`);
  }
  const [leadHomeCard, firstHomeSideCard, secondHomeSideCard] = proof.cards;
  if (
    proof.gridRect?.width !== 1094
    || leadHomeCard?.cardRect?.width !== 482
    || firstHomeSideCard?.cardRect?.width !== 284
    || secondHomeSideCard?.cardRect?.width !== 284
    || !proof.cards.every((card) => card.cardRect?.height === 270)
    || firstHomeSideCard?.artRect?.height !== 158
    || secondHomeSideCard?.artRect?.height !== 158
    || firstHomeSideCard?.artRect?.width !== secondHomeSideCard?.artRect?.width
    || firstHomeSideCard?.copyRect?.height !== secondHomeSideCard?.copyRect?.height
    || firstHomeSideCard?.copyRect?.top !== secondHomeSideCard?.copyRect?.top
    || firstHomeSideCard?.titleRect?.height !== secondHomeSideCard?.titleRect?.height
    || firstHomeSideCard?.summaryRect?.top !== secondHomeSideCard?.summaryRect?.top
    || firstHomeSideCard?.cardRect?.left - leadHomeCard?.cardRect?.right !== 22
    || secondHomeSideCard?.cardRect?.left - firstHomeSideCard?.cardRect?.right !== 22
    || leadHomeCard?.artRect?.width !== leadHomeCard?.cardRect?.width - 2
    || leadHomeCard?.artRect?.height !== leadHomeCard?.cardRect?.height - 2
    || leadHomeCard?.copyOpacity !== '0'
    || leadHomeCard?.copyVisibility !== 'hidden'
    || !firstHomeSideCard?.hasImage
    || !secondHomeSideCard?.hasImage
    || !firstHomeSideCard?.backgroundImage.includes('log-3.webp')
    || !secondHomeSideCard?.backgroundImage.includes('log-2.webp')
  ) {
    throw new Error(`Game News lead/side-card geometry or idle visibility regressed: ${JSON.stringify(proof)}`);
  }

  const fillerGeometryProof = await evaluate(client, `(() => {
    const card = document.querySelectorAll('#updateLogGrid .home-news-card:not(.large)')[1];
    const art = card?.querySelector('.feature-art');
    const before = art?.getBoundingClientRect();
    if (!art || !before) return null;
    const originalClass = art.className;
    const originalBackground = art.style.backgroundImage;
    art.className = 'feature-art patch-art';
    art.style.backgroundImage = '';
    const after = art.getBoundingClientRect();
    const fallbackBackground = getComputedStyle(art).backgroundImage;
    art.className = originalClass;
    art.style.backgroundImage = originalBackground;
    return {
      before: { width: Math.round(before.width), height: Math.round(before.height) },
      after: { width: Math.round(after.width), height: Math.round(after.height) },
      fallbackBackground
    };
  })()`);
  if (
    !fillerGeometryProof
    || fillerGeometryProof.before.width !== fillerGeometryProof.after.width
    || fillerGeometryProof.before.height !== fillerGeometryProof.after.height
    || fillerGeometryProof.after.height !== 158
    || !fillerGeometryProof.fallbackBackground
    || fillerGeometryProof.fallbackBackground === 'none'
  ) {
    throw new Error(`Game News filler artwork must retain the exact side-image box: ${JSON.stringify(fillerGeometryProof)}`);
  }

  screenshots.push(await captureScreenshot(client, 'game-news-idle'));
  const leadHomePoint = await movePointer(client, '#updateLogGrid .home-news-card.large .feature-art');
  await waitFor(client, `(() => {
    const copy = document.querySelector('#updateLogGrid .home-news-card.large .feature-copy');
    return Number(getComputedStyle(copy).opacity) >= 0.99 && getComputedStyle(copy).visibility === 'visible';
  })()`, 'Game News lead copy hover reveal');
  const leadHomeHover = await evaluate(client, `(() => {
    const card = document.querySelector('#updateLogGrid .home-news-card.large');
    const copy = card?.querySelector('.feature-copy');
    return {
      hovered: card?.matches(':hover') || false,
      opacity: getComputedStyle(copy).opacity,
      visibility: getComputedStyle(copy).visibility
    };
  })()`);
  screenshots.push(await captureScreenshot(client, 'game-news-lead-hover'));
  await movePointer(client, { x: 1080, y: 74 });
  await releasePointer(client, { x: 1080, y: 74 });
  await clearInteractionFocus(client, ['#updateLogGrid .home-news-card.large']);
  await sleep(180);
  const leadHomeRestored = await evaluate(client, `(() => {
    const card = document.querySelector('#updateLogGrid .home-news-card.large');
    const copy = card?.querySelector('.feature-copy');
    return {
      hovered: card?.matches(':hover') || false,
      opacity: getComputedStyle(copy).opacity,
      visibility: getComputedStyle(copy).visibility
    };
  })()`);
  if (
    !leadHomeHover.hovered
    || Number(leadHomeHover.opacity) < 0.99
    || leadHomeHover.visibility !== 'visible'
    || leadHomeRestored.hovered
    || leadHomeRestored.opacity !== '0'
    || leadHomeRestored.visibility !== 'hidden'
  ) {
    throw new Error(`Game News lead copy must exist only during actual pointer hover: ${JSON.stringify({ leadHomePoint, leadHomeHover, leadHomeRestored })}`);
  }
  await evaluate(client, `document.querySelector('#newsTab').click(); true`);
  await waitFor(client, "document.querySelector('.view.active')?.id === 'news' && document.querySelectorAll('#newsFeedGrid .feature-card').length === 4", 'dedicated News view');
  await movePointer(client, { x: 250, y: 120 });
  await clearInteractionFocus(client, ['#newsTab']);
  await waitFor(client, "getComputedStyle(document.querySelector('#newsTab')).color === 'rgb(255, 255, 255)'", 'settled active News navigation color');
  const newsProof = await evaluate(client, `(() => {
    const grid = document.querySelector('#newsFeedGrid');
    const featuredBox = document.querySelector('#newsFeedGrid .news-feed-card.large');
    const featured = document.querySelector('#newsFeedGrid .news-carousel-stage');
    const featuredArt = document.querySelector('#newsFeedGrid .news-carousel-slide.is-active');
    const carousel = document.querySelector('#newsFeedGrid .news-feature-carousel');
    const carouselCaption = document.querySelector('#newsFeedGrid .news-carousel-caption-title');
    const carouselArrow = document.querySelector('#newsFeedGrid .news-carousel-next');
    const carouselPager = document.querySelector('#newsFeedGrid .news-carousel-pager');
    const rowArt = document.querySelector('#newsFeedGrid .news-feed-card:not(.large) .feature-art');
    const rowTitle = document.querySelector('#newsFeedGrid .news-feed-card:not(.large) .feature-copy strong');
    const rowHeadline = document.querySelector('#newsFeedGrid .news-feed-card:not(.large) .news-card-headline');
    const rowArrow = document.querySelector('#newsFeedGrid .news-feed-card:not(.large) .news-card-arrow');
    const rowSummary = document.querySelector('#newsFeedGrid .news-feed-card:not(.large) .feature-summary');
    const nav = document.querySelector('#newsTab');
    const rect = (node) => {
      const value = node?.getBoundingClientRect();
      return value ? {
        left: Math.round(value.left),
        top: Math.round(value.top),
        right: Math.round(value.right),
        bottom: Math.round(value.bottom),
        width: Math.round(value.width),
        height: Math.round(value.height)
      } : null;
    };
    return {
      activeView: document.querySelector('.view.active')?.id || '',
      activeTab: nav?.classList.contains('active') || false,
      activePack: document.querySelector('#gameTileButton')?.classList.contains('active') || false,
      count: document.querySelectorAll('#newsFeedGrid .feature-card').length,
      titles: [...document.querySelectorAll('#newsFeedGrid .feature-card strong')].map((node) => node.textContent || ''),
      carouselSlides: document.querySelectorAll('#newsFeedGrid .news-carousel-slide').length,
      carouselPagerButtons: document.querySelectorAll('#newsFeedGrid .news-carousel-pager button').length,
      carouselIndex: carousel?.dataset.activeIndex || '',
      carouselTitle: carouselCaption?.textContent || '',
      carouselTransform: getComputedStyle(carousel).transform,
      carouselArtFilter: getComputedStyle(featuredArt).filter,
      carouselArrowOpacity: getComputedStyle(carouselArrow).opacity,
      carouselPagerOpacity: getComputedStyle(carouselPager).opacity,
      redundantHeader: Boolean(document.querySelector('.news-view-header, .news-feed-state')),
      redundantCtas: document.querySelectorAll('#newsFeedGrid .feature-cta').length,
      featuredLike: Boolean(document.querySelector('#newsFeedGrid .news-feed-card:first-child .news-card-like')),
      rowOpenButtons: document.querySelectorAll('#newsFeedGrid .news-feed-card:not(.large) .news-card-open').length,
      rowLikeButtons: document.querySelectorAll('#newsFeedGrid .news-feed-card:not(.large) .news-card-like').length,
      rowArrows: document.querySelectorAll('#newsFeedGrid .news-feed-card:not(.large) .news-card-arrow').length,
      rowArrowText: rowArrow?.textContent || '',
      rowArrowSeparator: getComputedStyle(rowHeadline).borderBottomWidth,
      rowArrowInline: rowHeadline?.contains(rowTitle) && rowHeadline?.contains(rowArrow),
      rowTitleAfter: getComputedStyle(rowTitle, '::after').content,
      firstRowLikes: document.querySelector('#newsFeedGrid .news-feed-card:nth-child(2) .news-card-like')?.textContent?.trim() || '',
      grid: rect(grid),
      featuredBox: rect(featuredBox),
      featured: rect(featured),
      featuredArt: rect(featuredArt),
      rowArt: rect(rowArt),
      bodyFont: getComputedStyle(document.body).fontFamily,
      navFont: getComputedStyle(nav).fontFamily,
      navColor: getComputedStyle(nav).color,
      rowTitleFont: getComputedStyle(rowTitle).fontFamily,
      rowTitleColor: getComputedStyle(rowTitle).color,
      rowSummaryColor: getComputedStyle(rowSummary).color
    };
  })()`);
  if (newsProof.activeView !== 'news' || !newsProof.activeTab || !newsProof.activePack || newsProof.count !== 4 || newsProof.titles[0] !== 'Launcher Stability Patch' || !newsProof.titles.includes('Old hidden') || newsProof.carouselSlides !== 1 || newsProof.carouselPagerButtons !== 3 || newsProof.carouselIndex !== '0' || newsProof.carouselTitle !== 'Launcher Stability Patch' || newsProof.redundantHeader || newsProof.redundantCtas !== 0 || newsProof.featuredLike || newsProof.rowOpenButtons !== 3 || newsProof.rowLikeButtons !== 3 || newsProof.rowArrows !== 3 || newsProof.rowArrowText !== '\u00BB' || newsProof.rowArrowSeparator !== '1px' || newsProof.firstRowLikes !== '16') {
    throw new Error(`Dedicated News view did not render the full ordered player-safe feed: ${JSON.stringify(newsProof)}`);
  }
  if (!newsProof.rowArrowInline) {
    throw new Error(`News article chevron must stay inline with its headline: ${JSON.stringify(newsProof)}`);
  }
  if (newsProof.rowTitleAfter !== 'none') {
    throw new Error(`News article headline must render exactly one chevron: ${JSON.stringify(newsProof)}`);
  }
  if (
    newsProof.grid?.width !== 664
    || newsProof.featuredBox?.width !== 664
    || newsProof.featured?.width !== 662
    || ![373, 374].includes(newsProof.featured?.height)
    || newsProof.rowArt?.width !== 250
    || newsProof.rowArt?.height !== 140
    || !newsProof.bodyFont.includes('AHT Bender')
    || !newsProof.navFont.includes('AHT Bender')
    || !newsProof.rowTitleFont.includes('AHT Bender')
    || newsProof.navColor !== 'rgb(255, 255, 255)'
    || newsProof.rowTitleColor !== 'rgb(255, 255, 243)'
    || newsProof.rowSummaryColor !== 'rgb(170, 170, 170)'
    || newsProof.carouselTransform !== 'none'
    || newsProof.carouselArtFilter !== 'none'
    || newsProof.carouselArrowOpacity !== '0'
    || newsProof.carouselPagerOpacity !== '0'
  ) {
    throw new Error(`News typography and measured BSG column geometry regressed: ${JSON.stringify(newsProof)}`);
  }

  await movePointer(client, { x: 250, y: 120 });
  await sleep(180);
  const heroNeutral = await evaluate(client, `(() => {
    const card = document.querySelector('.news-feature-carousel');
    const art = card?.querySelector('.news-carousel-slide.is-active');
    const caption = card?.querySelector('.news-carousel-caption');
    const arrow = card?.querySelector('.news-carousel-next');
    const pager = card?.querySelector('.news-carousel-pager');
    return {
      transform: getComputedStyle(card).transform,
      artFilter: getComputedStyle(art).filter,
      captionOpacity: getComputedStyle(caption).opacity,
      arrowOpacity: getComputedStyle(arrow).opacity,
      pagerOpacity: getComputedStyle(pager).opacity
    };
  })()`);
  const heroPoint = await movePointer(client, '.news-carousel-media');
  const heroInteractionMode = await ensurePointerHoverOrFocus(client, '.news-feature-carousel', '.news-carousel-media');
  await waitFor(client, `(() => {
    const card = document.querySelector('.news-feature-carousel');
    const caption = card?.querySelector('.news-carousel-caption');
    const arrow = card?.querySelector('.news-carousel-next');
    const pager = card?.querySelector('.news-carousel-pager');
    return Number(getComputedStyle(caption).opacity) >= 0.99
      && Number(getComputedStyle(arrow).opacity) >= 0.99
      && Number(getComputedStyle(pager).opacity) >= 0.99;
  })()`, 'completed featured News hover transition');
  const heroHover = await evaluate(client, `(() => {
    const card = document.querySelector('.news-feature-carousel');
    const art = card?.querySelector('.news-carousel-slide.is-active');
    const caption = card?.querySelector('.news-carousel-caption');
    const arrow = card?.querySelector('.news-carousel-next');
    const pager = card?.querySelector('.news-carousel-pager');
    return {
      transform: getComputedStyle(card).transform,
      artFilter: getComputedStyle(art).filter,
      captionOpacity: getComputedStyle(caption).opacity,
      arrowOpacity: getComputedStyle(arrow).opacity,
      pagerOpacity: getComputedStyle(pager).opacity
    };
  })()`);
  screenshots.push(await captureScreenshot(client, 'news-hero-hover'));
  await pressPointer(client, heroPoint);
  await sleep(45);
  const heroPressed = await evaluate(client, `({
    transform: getComputedStyle(document.querySelector('.news-feature-carousel')).transform,
    artFilter: getComputedStyle(document.querySelector('.news-carousel-slide.is-active')).filter
  })`);
  await movePointer(client, { x: 250, y: 120 });
  await releasePointer(client, { x: 250, y: 120 });
  await clearInteractionFocus(client, ['.news-feature-carousel']);
  await sleep(180);
  if (
    heroNeutral.transform !== 'none'
    || heroNeutral.artFilter !== 'none'
    || heroNeutral.captionOpacity !== '0'
    || heroNeutral.arrowOpacity !== '0'
    || heroNeutral.pagerOpacity !== '0'
    || heroHover.transform !== 'none'
    || heroHover.artFilter !== 'none'
    || Number(heroHover.captionOpacity) < 0.99
    || Number(heroHover.arrowOpacity) < 0.99
    || Number(heroHover.pagerOpacity) < 0.99
    || heroPressed.transform !== 'none'
    || heroPressed.artFilter !== 'none'
  ) {
    throw new Error(`Featured News hover/press state does not match the measured BSG state: ${JSON.stringify({ heroNeutral, heroHover, heroPressed })}`);
  }

  const rowStateExpression = `(() => {
    const card = document.querySelector('#newsFeedGrid .news-feed-card:not(.large)');
    const art = card?.querySelector('.feature-art');
    const title = card?.querySelector('.feature-copy strong');
    const like = card?.querySelector('.news-card-like');
    const cardStyle = getComputedStyle(card);
    const titleStyle = getComputedStyle(title);
    const likeStyle = getComputedStyle(like);
    return {
      transform: cardStyle.transform,
      background: cardStyle.backgroundColor,
      border: cardStyle.borderColor,
      artFilter: getComputedStyle(art).filter,
      titleColor: titleStyle.color,
      titleShadow: titleStyle.textShadow,
      likeColor: likeStyle.color,
      likeFilter: likeStyle.filter
    };
  })()`;
  await movePointer(client, { x: 250, y: 120 });
  await sleep(180);
  const rowNeutral = await evaluate(client, rowStateExpression);
  const rowPoint = await movePointer(client, '#newsFeedGrid .news-feed-card:not(.large) .feature-art');
  const rowInteractionMode = await ensurePointerHoverOrFocus(
    client,
    '#newsFeedGrid .news-feed-card:not(.large)',
    '#newsFeedGrid .news-feed-card:not(.large) .news-card-open',
    ['#newsFeedGrid .news-feed-card:not(.large)', '#newsFeedGrid .news-feed-card:not(.large) .news-card-open']
  );
  await sleep(180);
  const rowHover = await evaluate(client, rowStateExpression);
  screenshots.push(await captureScreenshot(client, 'news-row-hover'));
  await pressPointer(client, rowPoint);
  await sleep(45);
  const rowPressed = await evaluate(client, rowStateExpression);
  await movePointer(client, { x: 250, y: 120 });
  await releasePointer(client, { x: 250, y: 120 });
  await clearInteractionFocus(client, [
    '#newsFeedGrid .news-feed-card:not(.large)',
    '#newsFeedGrid .news-feed-card:not(.large) .news-card-open'
  ]);
  await sleep(180);
  await movePointer(client, '#newsFeedGrid .news-feed-card:not(.large) .news-card-like');
  await sleep(180);
  const likeHoverState = await evaluate(client, rowStateExpression);
  const unchangedRowKeys = ['transform', 'background', 'border', 'titleColor', 'titleShadow', 'likeColor', 'likeFilter'];
  if (
    rowNeutral.transform !== 'none'
    || !['none', 'brightness(1)'].includes(rowNeutral.artFilter)
    || !rowHover.artFilter.includes('brightness(1.1)')
    || rowPressed.transform !== 'none'
    || !rowPressed.artFilter.includes('brightness(1.1)')
    || unchangedRowKeys.some((key) => rowHover[key] !== rowNeutral[key])
    || unchangedRowKeys.some((key) => rowPressed[key] !== rowNeutral[key])
    || likeHoverState.likeColor !== rowNeutral.likeColor
    || likeHoverState.likeFilter !== rowNeutral.likeFilter
  ) {
    throw new Error(`News row changed outside the measured thumbnail-only lighting state: ${JSON.stringify({ rowNeutral, rowHover, rowPressed, likeHoverState })}`);
  }

  await movePointer(client, '.news-carousel-media');
  const carouselNavigationMode = await ensurePointerHoverOrFocus(client, '.news-feature-carousel', '.news-carousel-media');
  await sleep(180);
  await clickNode(client, '.news-carousel-next');
  const carouselNextProof = await waitForNewsCarouselSettled(client, 1, 'News carousel next-slide crossfade');
  screenshots.push(await captureScreenshot(client, 'news-carousel-slide'));
  if (carouselNextProof.index !== '1' || carouselNextProof.title !== 'Third newest launcher stability update' || carouselNextProof.layers !== 1 || carouselNextProof.transform !== 'none') {
    throw new Error(`News carousel arrow did not complete one fixed-geometry crossfade: ${JSON.stringify(carouselNextProof)}`);
  }
  await clickNode(client, '.news-carousel-pager button:first-child');
  await waitForNewsCarouselSettled(client, 0, 'News carousel first-slide pager crossfade');
  await clickNode(client, '.news-carousel-media');
  const inlineMediaProof = await waitFor(client, `(() => {
    const card = document.querySelector('.news-feature-carousel');
    const stage = document.querySelector('.news-carousel-inline-media');
    const frame = stage?.querySelector('iframe');
    const box = card?.getBoundingClientRect();
    return frame && !stage.hidden ? {
      active: card.classList.contains('is-media-active'),
      index: card.dataset.activeIndex,
      iframeSrc: frame.src,
      width: Math.round(box.width),
      height: Math.round(box.height),
      modalHidden: document.querySelector('#updateLogVideoOverlay').hidden
    } : false;
  })()`, 'inline featured News media');
  screenshots.push(await captureScreenshot(client, 'news-inline-media'));
  if (!inlineMediaProof.active || inlineMediaProof.index !== '0' || !inlineMediaProof.iframeSrc.includes('youtube.com/embed/') || inlineMediaProof.width !== 664 || inlineMediaProof.height !== 374 || !inlineMediaProof.modalHidden) {
    throw new Error(`Playable featured News did not remain inline in the fixed hero: ${JSON.stringify(inlineMediaProof)}`);
  }
  await clickNode(client, '.news-carousel-next');
  await waitForNewsCarouselSettled(client, 1, 'News carousel media-exit crossfade');
  const mediaExitProof = await evaluate(client, `({
    index: document.querySelector('.news-feature-carousel')?.dataset.activeIndex || '',
    mediaHidden: document.querySelector('.news-carousel-inline-media')?.hidden ?? false,
    iframeCount: document.querySelectorAll('.news-carousel-inline-media iframe').length
  })`);
  if (mediaExitProof.index !== '1' || !mediaExitProof.mediaHidden || mediaExitProof.iframeCount !== 0) {
    throw new Error(`Carousel navigation did not stop inline media before changing slides: ${JSON.stringify(mediaExitProof)}`);
  }
  await clickNode(client, '.news-carousel-pager button:first-child');
  await waitForNewsCarouselSettled(client, 0, 'News carousel final first-slide crossfade');
  await movePointer(client, { x: 250, y: 120 });
  await clearInteractionFocus(client, ['.news-feature-carousel']);
  await sleep(180);

  await evaluate(client, `document.querySelector('#newsFeedGrid .news-feed-card:nth-child(2) .news-card-like').click(); true`);
  const likeProof = await waitFor(client, `
    (() => {
      const button = document.querySelector('#newsFeedGrid .news-feed-card:nth-child(2) .news-card-like');
      return button?.classList.contains('is-liked') ? {
        liked: true,
        disabled: button.disabled,
        count: button.textContent.trim()
      } : false;
    })()
  `, 'device-attested news like');
  if (!likeProof.disabled || likeProof.count !== '17' || likeRequests.length !== 1) {
    throw new Error(`News like did not become an idempotent one-device action: ${JSON.stringify({ likeProof, likeRequests })}`);
  }
  await clickNode(client, '#newsFeedGrid .news-feed-card:nth-child(2) .news-card-open');
  await sleep(55);
  const articleExitTransition = await evaluate(client, `({
    switching: document.querySelector('#news')?.classList.contains('is-transitioning') || false,
    leaving: document.querySelector('.news-view-shell')?.classList.contains('news-surface-leaving') || false,
    loaderOpacity: getComputedStyle(document.querySelector('.news-transition-loader')).opacity
  })`);
  if (!articleExitTransition.switching || !articleExitTransition.leaving || Number(articleExitTransition.loaderOpacity) <= 0) {
    throw new Error(`News article click skipped the measured dim/loader transition: ${JSON.stringify(articleExitTransition)}`);
  }
  await waitFor(client, "!document.querySelector('#updateLogOverlay').hidden && !document.querySelector('#news').classList.contains('is-transitioning') && document.querySelector('#updateLogModalTitle')?.textContent === 'Third newest launcher stability update'", 'liked article view');
  const syncedLikeProof = await evaluate(client, `(() => {
    const header = document.querySelector('.update-log-article-header');
    const hero = document.querySelector('#updateLogHero');
    const body = document.querySelector('#updateLogArticleBody');
    const title = document.querySelector('#updateLogModalTitle');
    const footer = document.querySelector('.update-log-article-footer');
    const footerLike = document.querySelector('#updateLogBottomLikeButton');
    const surface = document.querySelector('#updateLogOverlay');
    const rect = (node) => {
      const value = node?.getBoundingClientRect();
      return value ? { width: Math.round(value.width), height: Math.round(value.height) } : null;
    };
    return {
      liked: document.querySelector('#updateLogLikeButton')?.classList.contains('is-liked') || false,
      disabled: document.querySelector('#updateLogLikeButton')?.disabled || false,
      count: document.querySelector('#updateLogLikeCount')?.textContent?.trim() || '',
      header: rect(header),
      hero: rect(hero),
      body: rect(body),
      footer: rect(footer),
      footerLiked: footerLike?.classList.contains('is-liked') || false,
      footerLikeDisabled: footerLike?.disabled || false,
      footerLikeCount: footerLike?.textContent?.trim() || '',
      surfaceBackground: getComputedStyle(surface).backgroundImage,
      titleFont: getComputedStyle(title).fontFamily,
      titleColor: getComputedStyle(title).color,
      bodyFont: getComputedStyle(body).fontFamily,
      bodyColor: getComputedStyle(body).color,
      dateClass: document.querySelector('#updateLogModalMeta > :first-child')?.className || '',
      relativeClass: document.querySelector('#updateLogModalMeta > :nth-child(2)')?.className || ''
    };
  })()`);
  if (!syncedLikeProof.liked || !syncedLikeProof.disabled || syncedLikeProof.count !== '17') {
    throw new Error(`News like did not stay synchronized inside the article: ${JSON.stringify(syncedLikeProof)}`);
  }
  if (
    syncedLikeProof.header?.width !== 664
    || syncedLikeProof.hero?.width !== 664
    || ![373, 374].includes(syncedLikeProof.hero?.height)
    || syncedLikeProof.body?.width !== 640
    || syncedLikeProof.footer?.width !== 0
    || syncedLikeProof.footer?.height !== 0
    || !syncedLikeProof.footerLiked
    || !syncedLikeProof.footerLikeDisabled
    || syncedLikeProof.footerLikeCount !== '17'
    || !syncedLikeProof.surfaceBackground.includes('launcher-background.png')
    || !syncedLikeProof.titleFont.includes('AHT Bender')
    || !syncedLikeProof.bodyFont.includes('AHT Bender')
    || syncedLikeProof.titleColor !== 'rgb(255, 255, 243)'
    || syncedLikeProof.bodyColor !== 'rgb(170, 170, 170)'
    || syncedLikeProof.dateClass !== 'update-log-modal-date'
    || syncedLikeProof.relativeClass !== 'update-log-modal-relative'
  ) {
    throw new Error(`News article typography, metadata roles, or measured BSG geometry regressed: ${JSON.stringify(syncedLikeProof)}`);
  }

  const articleStateExpression = `(() => {
    const back = document.querySelector('#updateLogCloseButton');
    const backIcon = back?.querySelector('span');
    const like = document.querySelector('#updateLogLikeButton');
    const hero = document.querySelector('#updateLogHero');
    const backStyle = getComputedStyle(back);
    const likeStyle = getComputedStyle(like);
    return {
      backColor: backStyle.color,
      backShadow: backStyle.textShadow,
      backTransform: backStyle.transform,
      backBackground: backStyle.backgroundColor,
      backIconTransform: getComputedStyle(backIcon).transform,
      likeColor: likeStyle.color,
      likeFilter: likeStyle.filter,
      likeTransform: likeStyle.transform,
      heroFilter: getComputedStyle(hero).filter,
      heroTransform: getComputedStyle(hero).transform
    };
  })()`;
  await movePointer(client, { x: 250, y: 120 });
  await sleep(180);
  const articleNeutral = await evaluate(client, articleStateExpression);
  const backPoint = await movePointer(client, '#updateLogCloseButton');
  await sleep(180);
  const articleBackHover = await evaluate(client, articleStateExpression);
  screenshots.push(await captureScreenshot(client, 'news-article-back-hover'));
  await pressPointer(client, backPoint);
  await sleep(45);
  const articleBackPressed = await evaluate(client, articleStateExpression);
  await movePointer(client, { x: 250, y: 120 });
  await releasePointer(client, { x: 250, y: 120 });
  await sleep(180);
  await movePointer(client, '#updateLogLikeButton');
  await sleep(180);
  const articleLikeHover = await evaluate(client, articleStateExpression);
  if (
    JSON.stringify(articleBackHover) !== JSON.stringify(articleNeutral)
    || JSON.stringify(articleBackPressed) !== JSON.stringify(articleNeutral)
    || articleLikeHover.likeColor !== articleNeutral.likeColor
    || articleLikeHover.likeFilter !== articleNeutral.likeFilter
    || articleLikeHover.likeTransform !== articleNeutral.likeTransform
    || articleLikeHover.heroFilter !== articleNeutral.heroFilter
    || articleLikeHover.heroTransform !== articleNeutral.heroTransform
  ) {
    throw new Error(`Article Back/like hover or press added lighting absent from BSG: ${JSON.stringify({ articleNeutral, articleBackHover, articleBackPressed, articleLikeHover })}`);
  }

  await clickNode(client, '#updateLogCloseButton');
  await sleep(55);
  const backExitTransition = await evaluate(client, `({
    switching: document.querySelector('#news')?.classList.contains('is-transitioning') || false,
    leaving: document.querySelector('#updateLogOverlay')?.classList.contains('news-surface-leaving') || false,
    loaderOpacity: getComputedStyle(document.querySelector('.news-transition-loader')).opacity
  })`);
  if (!backExitTransition.switching || !backExitTransition.leaving || Number(backExitTransition.loaderOpacity) <= 0) {
    throw new Error(`News Back click skipped the measured dim/loader transition: ${JSON.stringify(backExitTransition)}`);
  }
  await waitFor(client, "document.querySelector('#updateLogOverlay').hidden && !document.querySelector('#news').classList.contains('is-transitioning')", 'return from liked article');
  screenshots.push(await captureScreenshot(client, 'news-view'));
  await clickNode(client, '#gameTab');
  await waitFor(client, "document.querySelector('.view.active')?.id === 'player'", 'return to Game view');
  await clickNode(client, '#ptbTileButton');
  await waitFor(client, "document.querySelector('.view.active')?.id === 'player' && document.querySelector('#ptbTileButton')?.classList.contains('active') && !document.querySelector('.workspace')?.classList.contains('is-sidebar-switching')", 'PTB Game home page');
  await clickNode(client, '#updateLogGrid .feature-card:first-child');
  await waitFor(client, "document.querySelector('.view.active')?.id === 'news' && !document.querySelector('#updateLogOverlay').hidden && document.querySelector('#updateLogModalTitle')?.textContent === 'Launcher Stability Patch'", 'home card routed to its News article');
  const homeArticleProof = await evaluate(client, `({
    activeView: document.querySelector('.view.active')?.id || '',
    activeTab: document.querySelector('#newsTab')?.classList.contains('active') || false,
    activePack: document.querySelector('#ptbTileButton')?.classList.contains('active') || false,
    articleOpen: document.querySelector('#news')?.classList.contains('article-open') || false,
    title: document.querySelector('#updateLogModalTitle')?.textContent || '',
    backLabel: document.querySelector('#updateLogCloseButton')?.getAttribute('aria-label') || '',
    heroDisabled: document.querySelector('#updateLogHero')?.disabled ?? true,
    heroPlayHidden: document.querySelector('#updateLogHeroPlay')?.hidden ?? true,
    videoHidden: document.querySelector('#updateLogVideoOverlay')?.hidden ?? true,
    inlineHidden: document.querySelector('#updateLogInlineMedia')?.hidden ?? true
  })`);
  if (homeArticleProof.activeView !== 'news' || !homeArticleProof.activeTab || !homeArticleProof.activePack || !homeArticleProof.articleOpen || homeArticleProof.title !== 'Launcher Stability Patch' || homeArticleProof.backLabel !== 'Back to Game' || homeArticleProof.heroDisabled || homeArticleProof.heroPlayHidden || !homeArticleProof.videoHidden || !homeArticleProof.inlineHidden) {
    throw new Error(`Home news card did not open the exact article inside the News tab: ${JSON.stringify(homeArticleProof)}`);
  }
  await clickNode(client, '#updateLogHero');
  await waitFor(client, "!document.querySelector('#updateLogInlineMedia').hidden && document.querySelector('#updateLogInlineMedia iframe')", 'inline article YouTube video');
  const videoProof = await evaluate(client, `({
    inlineHidden: document.querySelector('#updateLogInlineMedia').hidden,
    modalHidden: document.querySelector('#updateLogVideoOverlay').hidden,
    iframeSrc: document.querySelector('#updateLogInlineMedia iframe')?.src || '',
    frameActive: document.querySelector('.update-log-hero-frame')?.classList.contains('is-media-active') || false
  })`);
  if (videoProof.inlineHidden || !videoProof.modalHidden || !videoProof.frameActive || !videoProof.iframeSrc.includes('youtube.com/embed/')) {
    throw new Error(`YouTube playable did not stay inline in the article hero: ${JSON.stringify(videoProof)}`);
  }
  await clickNode(client, '#updateLogCloseButton');
  await waitFor(client, "document.querySelector('#updateLogOverlay').hidden && document.querySelector('#updateLogInlineMedia').hidden && document.querySelector('.view.active')?.id === 'player' && document.querySelector('#gameTab')?.classList.contains('active') && document.querySelector('#ptbTileButton')?.classList.contains('active')", 'returned from home article to PTB Game home');
  screenshots.push(await captureScreenshot(client, 'ptb-game-home-after-article-back'));
  await clickNode(client, '#newsTab');
  await waitFor(client, "document.querySelector('.view.active')?.id === 'news' && document.querySelector('#ptbTileButton')?.classList.contains('active')", 'PTB News view for second article');
  await clickNode(client, '#newsFeedGrid .news-feed-card:nth-child(2) .news-card-open');
  await waitFor(client, "document.querySelector('.view.active')?.id === 'news' && !document.querySelector('#updateLogOverlay').hidden && document.querySelector('#updateLogArticleBody')?.textContent.includes('Non-playable logs should open')", 'full update-log article in News');
  const articleProof = await evaluate(client, `({
    title: document.querySelector('#updateLogModalTitle')?.textContent || '',
    subtitleHidden: document.querySelector('#updateLogModalSubtitle')?.hidden,
    body: document.querySelector('#updateLogArticleBody')?.textContent || '',
    articleImage: document.querySelector('#updateLogArticleBody figure img')?.src || '',
    articleCaption: document.querySelector('#updateLogArticleBody figcaption')?.textContent || ''
  })`);
  if (articleProof.title !== 'Third newest launcher stability update' || articleProof.subtitleHidden || !articleProof.body.includes('Second visible update log') || !articleProof.articleImage.includes('/update-media/body-shot.webp') || articleProof.articleCaption !== 'Patch comparison') {
    throw new Error(`Full update-log article did not render expected content: ${JSON.stringify(articleProof)}`);
  }
  screenshots.push(await captureScreenshot(client, 'news-article'));
  const backProof = await evaluate(client, `({
    label: document.querySelector('#updateLogCloseButton')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
    ariaLabel: document.querySelector('#updateLogCloseButton')?.getAttribute('aria-label') || '',
    articleOpen: document.querySelector('#news')?.classList.contains('article-open') || false,
    activeView: document.querySelector('.view.active')?.id || '',
    activePack: document.querySelector('#ptbTileButton')?.classList.contains('active') || false
  })`);
  if (!/Back/i.test(backProof.label) || backProof.ariaLabel !== 'Back to News' || !backProof.articleOpen || backProof.activeView !== 'news' || !backProof.activePack) {
    throw new Error(`Full update-log article must use a clear Back affordance inside the News tab: ${JSON.stringify(backProof)}`);
  }
  await clickNode(client, '#updateLogCloseButton');
  await waitFor(client, "document.querySelector('#updateLogOverlay').hidden && !document.querySelector('#news')?.classList.contains('article-open') && document.querySelector('.view.active')?.id === 'news' && document.querySelector('#ptbTileButton')?.classList.contains('active')", 'returned from full article to PTB News feed');
  if (!updateLogRequests.some((query) => query.includes('limit=12'))) {
    throw new Error(`Player did not request enough update logs for the News view: ${JSON.stringify(updateLogRequests)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    root,
    screenshots,
    requestQueries: updateLogRequests,
    artworkMetadataProof,
    titles,
    cardCount: proof.count,
    gameNewsGeometry: {
      grid: proof.gridRect,
      cards: proof.cards.map((card) => ({
        title: card.title,
        card: card.cardRect,
        art: card.artRect,
        copy: card.copyRect,
        titleRect: card.titleRect,
        summary: card.summaryRect
      }))
    },
    fillerGeometryProof,
    leadHomeHover,
    leadHomeRestored,
    newsCardCount: newsProof.count,
    likeRequests,
    heroNeutral,
    heroHover,
    heroInteractionMode,
    rowInteractionMode,
    carouselNavigationMode,
    rowNeutral,
    rowHover,
    carouselNextProof,
    inlineMediaProof,
    articleExitTransition,
    backExitTransition,
    playable: proof.cards.map((card) => card.playable),
    hidden: proof.hidden
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
