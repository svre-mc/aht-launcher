import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { readNativeGuardLine } from '../src/nativeGuardTransport.js';

let readLine = readNativeGuardLine;
if (process.env.AHT_NATIVE_TRANSPORT_BASELINE) {
  const source = (await fs.readFile(process.env.AHT_NATIVE_TRANSPORT_BASELINE, 'utf8')).replaceAll('\r\n', '\n');
  const start = source.indexOf('function readGuardLine(');
  const end = source.indexOf('\nasync function readInfo(', start);
  const context = vm.createContext({ net, Buffer, MAX_PROBE_RESPONSE_BYTES: 16384 });
  vm.runInContext(source.slice(start, end), context);
  readLine = context.readGuardLine;
}

async function peer(t, handler) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

test('regular partial bytes cannot keep a Phoenix probe pending beyond its absolute deadline', async t => {
  let connection;
  const port = await peer(t, socket => {
    connection = socket;
    const timer = setInterval(() => socket.write('x'), 120);
    socket.on('close', () => clearInterval(timer));
  });
  const pending = readLine(port, 'fixture').then(() => 'resolved', () => 'rejected');
  let timer;
  const observed = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve('stalled'), 1900); })]);
  clearTimeout(timer);
  connection?.destroy();
  await pending;
  assert.equal(observed, 'rejected');
});

test('bounded transport handles split UTF-8 lines without corrupting data', async t => {
  const port = await peer(t, socket => {
    const bytes = Buffer.from('fixture-✓\n');
    socket.write(bytes.subarray(0, bytes.length - 2));
    setImmediate(() => socket.end(bytes.subarray(bytes.length - 2)));
  });
  assert.equal(await readLine(port, 'fixture'), 'fixture-✓');
});

test('closed and oversized replies fail instead of waiting or accepting a partial line', async t => {
  const closed = await peer(t, socket => socket.end('partial'));
  await assert.rejects(readLine(closed, 'fixture'), /closed/i);
  const oversized = await peer(t, socket => socket.end('x'.repeat(65) + '\n'));
  await assert.rejects(readLine(oversized, 'fixture', 64), /too large/i);
});
