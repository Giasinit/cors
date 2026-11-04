import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import { createApp } from '../api/index.js';

let upstream;
let proxy;
let parsedProxy;
let targetBase;
let proxyBase;
let parsedBase;

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return [server, `http://127.0.0.1:${server.address().port}`];
}

before(async () => {
  [upstream, targetBase] = await listen((req, res) => {
    if (req.url === '/broken') return req.socket.destroy();
    if (req.url === '/slow') return; // Wait for the proxy's deadline to close the socket.
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/echo?redirected=yes' });
      return res.end();
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(req.url === '/status' ? 503 : 200, {
        'content-type': 'application/json',
        'access-control-allow-origin': 'https://wrong-origin.example',
        'cache-control': 'public, max-age=3600',
      });
      res.end(JSON.stringify({
        method: req.method, url: req.url, headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
  });
  [proxy, proxyBase] = await listen(createApp({ upstreamTimeoutMs: 300 }));
  // Reproduce Vercel handing an already-consumed JSON body to the Express app.
  const parsed = express();
  parsed.use(express.json());
  parsed.use(createApp({ upstreamTimeoutMs: 300 }));
  [parsedProxy, parsedBase] = await listen(parsed);
});

after(async () => {
  for (const server of [proxy, parsedProxy, upstream]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('raw target preserves escaped query delimiters and plus signs', async () => {
  const query = '/echo?time=00%3A00%2B00%3A00&name=A%26B&literal=A+B';
  const response = await fetch(`${proxyBase}/?url=${targetBase}${query}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.url, query);
  assert.equal(data.headers.host, new URL(targetBase).host);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(Number(response.headers.get('x-proxy-upstream-ms')) >= 0);
});

test('fully encoded target preserves nested query encoding', async () => {
  const target = `${targetBase}/echo?time=00%3A00%2B00%3A00&limit=50`;
  const response = await fetch(`${proxyBase}/?url=${encodeURIComponent(target)}`);
  assert.equal((await response.json()).url, new URL(target).pathname + new URL(target).search);
});

test('POST streams the exact JSON body, content type and Accept to the destination', async () => {
  const body = '{ "trainNumber": "757", "timeGMT": "00:00%2B00:00" }';
  const response = await fetch(`${proxyBase}/?url=${targetBase}/echo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body,
  });
  const data = await response.json();
  assert.equal(data.method, 'POST');
  assert.equal(data.body, body);
  assert.equal(data.headers['content-type'], 'application/json');
  assert.equal(data.headers.accept, 'application/json');
});

test('POST also forwards Vercel-style parsed JSON with a correct byte length', async () => {
  const value = { nome: 'Città', trainNumber: '757' };
  const response = await fetch(`${parsedBase}/?url=${targetBase}/echo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value, null, 4),
  });
  const data = await response.json();
  assert.equal(data.method, 'POST');
  assert.deepEqual(JSON.parse(data.body), value);
  assert.equal(Number(data.headers['content-length']), Buffer.byteLength(data.body));
});

test('browser JSON preflight is answered with CORS headers', async () => {
  const response = await fetch(`${proxyBase}/?url=${targetBase}/echo`, {
    method: 'OPTIONS', headers: {
      Origin: 'https://example.org', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-headers'), /content-type/);
});

test('upstream HTTP errors keep their status and body', async () => {
  const response = await fetch(`${proxyBase}/?url=${targetBase}/status`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).url, '/status');
});

test('a broken upstream connection returns JSON 502 without crashing', async () => {
  const response = await fetch(`${proxyBase}/?url=${targetBase}/broken`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'ECONNRESET');
});

test('a nonresponding upstream returns JSON 504', async () => {
  const response = await fetch(`${proxyBase}/?url=${targetBase}/slow`);
  assert.equal(response.status, 504);
  assert.ok(['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes((await response.json()).code));
});

test('normal GET redirects still work', async () => {
  const response = await fetch(`${proxyBase}/?url=${targetBase}/redirect`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).url, '/echo?redirected=yes');
});

test('missing, malformed and unsupported targets return 400', async () => {
  for (const query of ['', '?url=abc', '?url=file:///etc/passwd', '?url=https%3A%ZZ']) {
    const response = await fetch(proxyBase + '/' + query);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).title, 'CORS Proxy Error');
  }
});
