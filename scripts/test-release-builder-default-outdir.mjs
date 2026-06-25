import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = await readFile(path.join(root, 'desktop', 'main.js'), 'utf8');

const checks = [
  ['defaultReleaseOutDir helper exists', /function defaultReleaseOutDir\(\)\s*{\s*return path\.join\(app\.getPath\('userData'\), 'release-builder'\);/],
  ['resolveReleaseOutDir helper exists', /function resolveReleaseOutDir\(value = ''\)/],
  ['default config uses internal release folder', /defaultOutDir:\s*defaultReleaseOutDir\(\)/],
  ['merged configs normalize blank output folder', /merged\.developer\.defaultOutDir = resolveReleaseOutDir\(merged\.developer\?\.defaultOutDir\);/],
  ['build release normalizes payload output folder', /const outDir = resolveReleaseOutDir\(payload\?\.outDir \|\| config\.developer\?\.defaultOutDir\);/],
  ['R2 sync normalizes payload output folder', /const outDir = resolveReleaseOutDir\(payload\.outDir \|\| config\.developer\?\.defaultOutDir\);/],
  ['validate release normalizes payload output folder', /outDir: resolveReleaseOutDir\(payload\?\.outDir \|\| config\.developer\?\.defaultOutDir\)/]
];

const missing = checks
  .filter(([, pattern]) => !pattern.test(mainSource))
  .map(([label]) => label);

if (missing.length) {
  throw new Error(`Missing release-builder default output guards: ${missing.join(', ')}`);
}

if (/ensureDir\(payload\.outDir\)/.test(mainSource) || /outDir:\s*payload\.outDir/.test(mainSource)) {
  throw new Error('Release builder still passes payload.outDir directly');
}

console.log(JSON.stringify({ ok: true, checks: checks.length }, null, 2));
