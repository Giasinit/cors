import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { test } from 'node:test';
import { probeRfiProtocol } from '../lib/rfi-protocol.js';

const cert = readFileSync(new URL('./fixtures/localhost-cert.pem', import.meta.url));
const key = readFileSync(new URL('./fixtures/localhost-key.pem', import.meta.url));

for (const [name, protocols, expected] of [
  ['HTTP/2', ['h2', 'http/1.1'], 'h2'],
  ['HTTP/1.1 only', ['http/1.1'], 'http/1.1'],
  ['no ALPN', undefined, null],
]) {
  test(`TLS probe distinguishes ${name} without sending application data`, async () => {
    let bytes = 0;
    const server = tls.createServer({ key, cert, ALPNProtocols: protocols }, socket => {
      socket.on('error', () => {});
      socket.on('data', data => { bytes += data.length; });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await probeRfiProtocol({ host: '127.0.0.1',
        port: server.address().port, servername: 'localhost', ca: cert });
      assert.equal(result.negotiated, expected);
      assert.equal(result.certificateVerified, true);
      assert.equal(bytes, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}
