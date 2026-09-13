import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

class BrowserStyleDecoder extends TextDecoder {
  decode(...args) {
    try { return super.decode(...args); }
    catch (error) { throw new TypeError(error.message); }
  }
}

test('strict UTF-8 failures have the same result in Node and Web-standard decoders', async () => {
  const source = (await fs.readFile(new URL('../src/boundedJson.js', import.meta.url), 'utf8')).replace('export async function', 'async function');
  for (const Decoder of [TextDecoder, BrowserStyleDecoder]) {
    const context = vm.createContext({ TextDecoder: Decoder, TextEncoder, TypeError, Error });
    vm.runInContext(source, context);
    const bytes = Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125]);
    await assert.rejects(context.readBoundedJsonResponse(new Response(bytes)), { code: 'AHT_SERVICE_RESPONSE_INVALID' });
  }
});
