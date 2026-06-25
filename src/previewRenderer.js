#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPathInside } from './utils.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'renderer');
const port = Number(process.argv[2] || '7891');
const host = process.argv[3] || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.resolve(root, `.${rel}`);
    if (!isPathInside(root, target)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const data = await fs.readFile(target);
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500);
    res.end(error.message);
  }
});

server.listen(port, host, () => {
  console.log(`Renderer preview: http://${host}:${port}/`);
});
