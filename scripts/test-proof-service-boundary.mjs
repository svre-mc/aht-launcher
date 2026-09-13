import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { writeLauncherProof } from '../src/launcherProof.js';

test('account recovery header never follows a proof-service redirect', async () => {
  let received = false;
  const destination = http.createServer((_request, response) => {
    received = true;
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end('{"error":"fixture service unavailable"}');
  });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const source = http.createServer((_request, response) => {
    response.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/redirected` });
    response.end();
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  try {
    await assert.rejects(writeLauncherProof({
      config: { instanceDir: process.cwd(), packId: 'fixture', launcherProof: {
        enabled: true, required: true, baseUrl: `http://127.0.0.1:${source.address().port}`
      } },
      identity: { installId: 'fixture-install', minecraftUsername: 'FixturePlayer' },
      recoverySecret: 'test-only-recovery-value-not-a-credential'
    }));
    assert.equal(received, false, 'a different origin received the request carrying the recovery header');
  } finally {
    for (const server of [source, destination]) { server.closeAllConnections(); server.close(); }
  }
});
