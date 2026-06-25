#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildRelease } from './releaseBuilder.js';
import { installPack } from './installer.js';
import { hasFlag, isPathInside, pickArg } from './utils.js';

function printUsage() {
  console.log(`Usage:
  node src/cli.js build-release --pack-zip <zip> --out <dir> [--base-url <url>] [--channel stable] [--cache-mods <mods dir or instance dir>]
  node src/cli.js install --latest <latest.json or url> --instance <dir> [--cf-proxy <url>] [--dry-run]
  node src/cli.js serve-release --dir <dir> [--port 8787] [--host 127.0.0.1]`);
}

async function serveRelease(dir, port, host) {
  const root = path.resolve(dir);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const rel = decodeURIComponent(url.pathname === '/' ? '/latest.json' : url.pathname);
      const target = path.resolve(root, `.${rel}`);
      if (!isPathInside(root, target)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const data = await fs.readFile(target);
      const ext = path.extname(target).toLowerCase();
      const type = ext === '.json' ? 'application/json' : ext === '.zip' ? 'application/zip' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500);
      res.end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(`Serving ${root} at http://${host}:${port}/latest.json`);
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (!command || command === '--help' || command === '-h' || hasFlag(args, 'help')) {
    printUsage();
    return;
  }

  if (command === 'build-release') {
    const result = await buildRelease({
      packZip: pickArg(args, 'pack-zip'),
      outDir: pickArg(args, 'out'),
      baseUrl: pickArg(args, 'base-url', ''),
      channel: pickArg(args, 'channel', 'stable'),
      cacheModsDir: pickArg(args, 'cache-mods', ''),
      copyZip: !hasFlag(args, 'no-copy')
    });
    console.log(JSON.stringify(result.report, null, 2));
    return;
  }

  if (command === 'install') {
    const result = await installPack({
      latestSource: pickArg(args, 'latest'),
      instanceDir: pickArg(args, 'instance'),
      cfProxyBaseUrl: pickArg(args, 'cf-proxy', ''),
      dryRun: hasFlag(args, 'dry-run')
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'serve-release') {
    await serveRelease(pickArg(args, 'dir'), Number(pickArg(args, 'port', '8787')), pickArg(args, 'host', '127.0.0.1'));
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
