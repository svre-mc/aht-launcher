import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../src/utils.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aht-atomic-json-'));
const file = path.join(root, 'state.json');
await writeJsonFile(file, { sequence: -1, payload: 'initial' });

let writing = true;
let reads = 0;
const reader = (async () => {
  while (writing) {
    const value = await readJsonFile(file);
    if (!Number.isInteger(value.sequence) || typeof value.payload !== 'string') {
      throw new Error(`Reader observed an incomplete JSON value: ${JSON.stringify(value)}`);
    }
    reads += 1;
    await new Promise((resolve) => setImmediate(resolve));
  }
})();

const writes = [];
for (let sequence = 0; sequence < 80; sequence += 1) {
  writes.push(writeJsonFile(file, { sequence, payload: `write-${sequence}-${'x'.repeat(2048)}` }));
}
await Promise.all(writes);
writing = false;
await reader;

const finalValue = await readJsonFile(file);
if (finalValue.sequence !== 79) {
  throw new Error(`Serialized JSON writes finished out of order: ${JSON.stringify(finalValue)}`);
}

console.log(JSON.stringify({ ok: true, reads, finalSequence: finalValue.sequence }, null, 2));
