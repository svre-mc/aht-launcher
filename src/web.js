#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPack } from './installer.js';
import { hasFlag, isPathInside, pathExists, pickArg, readJsonFile, readJsonFromSource } from './utils.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value, null, 2));
}

async function loadConfig(configPath) {
  return readJsonFile(configPath);
}

async function status(config) {
  const latest = await readJsonFromSource(config.latestUrl);
  const installedPath = path.join(config.instanceDir, '.aht-launcher', 'installed.json');
  const installed = await pathExists(installedPath) ? await readJsonFile(installedPath) : null;
  return {
    packId: latest.packId,
    name: latest.name,
    latestVersion: latest.version,
    installedVersion: installed?.version || null,
    updateRequired: installed?.version !== latest.version,
    instanceDir: config.instanceDir,
    playConfigured: Boolean(config.playCommand?.command)
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = path.resolve(root, 'public', `.${pathname}`);
  const publicRoot = path.resolve(root, 'public');
  if (!isPathInside(publicRoot, target)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    const type = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/html';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, 'help')) {
    console.log('Usage: node src/web.js --config <launcher.config.json> [--port 7878] [--host 127.0.0.1]');
    return;
  }

  const configPath = path.resolve(pickArg(args, 'config', 'launcher.config.json'));
  const port = Number(pickArg(args, 'port', '7878'));
  const host = pickArg(args, 'host', '127.0.0.1');
  let updateRunning = false;
  let lastUpdate = null;

  const server = http.createServer(async (req, res) => {
    try {
      const config = await loadConfig(configPath);
      if (req.method === 'GET' && req.url.startsWith('/api/status')) {
        sendJson(res, await status(config));
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/update-log')) {
        sendJson(res, { running: updateRunning, lastUpdate });
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/api/update')) {
        const body = await readBody(req);
        if (updateRunning) {
          sendJson(res, { ok: false, error: 'Update already running' }, 409);
          return;
        }
        updateRunning = true;
        lastUpdate = { startedAt: new Date().toISOString(), lines: [] };
        installPack({
          latestSource: config.latestUrl,
          instanceDir: config.instanceDir,
          cfProxyBaseUrl: config.curseforge?.proxyBaseUrl || '',
          cfApiKey: process.env[config.curseforge?.apiKeyEnv || 'CURSEFORGE_API_KEY'] || '',
          forceRepair: Boolean(body.forceRepair),
          logger: { log: (line) => lastUpdate.lines.push(String(line)) }
        }).then((result) => {
          lastUpdate.finishedAt = new Date().toISOString();
          lastUpdate.result = result;
        }).catch((error) => {
          lastUpdate.finishedAt = new Date().toISOString();
          lastUpdate.error = error.message;
        }).finally(() => {
          updateRunning = false;
        });
        sendJson(res, { ok: true });
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/api/play')) {
        if (!config.playCommand?.command) {
          sendJson(res, { ok: false, error: 'Play command is not configured' }, 400);
          return;
        }
        const child = spawn(config.playCommand.command, config.playCommand.args || [], {
          cwd: config.playCommand.cwd || config.instanceDir,
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        sendJson(res, { ok: true });
        return;
      }
      await serveStatic(req, res);
    } catch (error) {
      sendJson(res, { ok: false, error: error.message }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(`Launcher UI: http://${host}:${port}`);
  console.log(`Config: ${configPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
