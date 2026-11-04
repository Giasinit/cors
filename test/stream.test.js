import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { test } from 'node:test';
import { createApp } from '../api/index.js';
import { createTrainLookup } from '../lib/train-realtime.js';
import { nativePost } from '../lib/native-post.js';
import { prepareCalendar } from '../lib/train-calendar.js';

// These publicly committed keys belong only to a loopback test server.
const key = readFileSync(new URL('./fixtures/localhost-key.pem', import.meta.url));
const cert = readFileSync(new URL('./fixtures/localhost-cert.pem', import.meta.url));
const now = new Date('2026-11-04T12:00:00Z');
const entry = { number: '1', originDate: '2026-11-04', serviceDate: '2026-11-04' };
const calendar = prepareCalendar({ version: 1, timezone: 'Europe/Rome', from: '2026-11-04', to: '2026-11-04',
  publication: 'fixture', source: { sha256: 'fixture' }, maxEnd: 86399,
  calendars: [Buffer.from([1]).toString('base64')],
  trains: ['1', '2', '3'].map(n => [n, 0, 86399, 0]),
});
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const detail = n => JSON.stringify({ Trains: [{ TrainHeader: { Id: '20261104123456' }, Path: [
  { Place: 2000, Arrived: false, Departed: true,
    Departure: { TrainNumber: n, Time: now.toISOString(), Delay: '0' } },
] }] });
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
async function* events(body) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let position;
    while ((position = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, position); buffer = buffer.slice(position + 2);
      const name = frame.match(/^event: (.*)$/m)?.[1];
      if (name) yield { event: name, id: frame.match(/^id: (.*)$/m)?.[1],
        data: JSON.parse(frame.match(/^data: (.*)$/m)[1]) };
    }
  }
}

for (const [transport, post] of [['request', undefined], ['native', nativePost]]) {
test(`real HTTPS → collector → SSE streams fast trains before a stalled peer and diagnoses its timeout [${transport}]`, async () => {
  const waiting = new Map();
  const receivedAll = deferred();
  const upstream = https.createServer({ key, cert }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.method, 'POST');
    assert.equal(body.timeUTC, '2026-11-04T00:00:00.000Z');
    assert.equal(req.headers['x-forwarded-for'], undefined);
    waiting.set(body.trainNumber, res);
    if (waiting.size === 3) receivedAll.resolve();
  });
  const port = await listen(upstream);
  const agent = new https.Agent({ ca: cert, keepAlive: false, maxSockets: Infinity });
  const lookup = createTrainLookup({ endpoint: `https://127.0.0.1:${port}/detail`, httpsAgent: agent, post });
  const localLookup = (e, date, options) => lookup(e, date, { ...options, timeoutMs: 2000 });
  const app = http.createServer(createApp({ getTrainOptions: {
    calendar: () => calendar, clock: () => now, progressIntervalMs: 25,
    lookup: localLookup, nativeLookup: localLookup,
  } }));
  const appPort = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/gettrain?stream=1&limit=3&transport=${transport}`);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(response.headers.get('cache-control'), /no-transform/);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const stream = events(response.body);
    const first = (await stream.next()).value;
    assert.equal(first.event, 'start'); assert.equal(first.data.selected, 3);
    assert.equal(first.data.transport, transport);
    assert.ok(first.id);
    await receivedAll.promise; // All requests started while no upstream has replied.
    waiting.get('2').end(detail('2'));
    const observed = [];
    let frame;
    do {
      frame = (await stream.next()).value; observed.push(frame);
    } while (frame.event !== 'train');
    assert.equal(frame.data.number, '2');
    assert.equal(frame.data.remaining, 2);
    assert.equal(frame.data.diagnostics.outcome, 'success');
    assert.equal(frame.data.diagnostics.phase, 'complete');
    assert.ok(frame.data.diagnostics.milestonesMs.tls >= frame.data.diagnostics.milestonesMs.tcp);
    assert.equal(frame.data.diagnostics.durationsMs.dns, null); // IP literal: no fabricated DNS timing.
    do {
      frame = (await stream.next()).value; observed.push(frame);
    } while (frame.event !== 'progress' || !frame.data.pending.some(t => t.diagnostics.phase === 'response_headers'));
    assert.deepEqual(frame.data.pending.map(t => t.number).sort(), ['1', '3']);
    assert.ok(frame.data.pending.every(t => t.diagnostics.elapsedMs >= 0));
    waiting.get('1').end(detail('1'));
    for await (const next of stream) observed.push(next);
    const trains = observed.filter(e => e.event === 'train');
    assert.deepEqual(trains.map(e => e.data.number), ['2', '1', '3']);
    const failed = trains[2].data;
    assert.equal(failed.error.code, 'UPSTREAM_TIMEOUT');
    assert.equal(failed.diagnostics.phase, 'response_headers');
    assert.equal(failed.diagnostics.outcome, 'timeout');
    assert.ok(failed.diagnostics.timeoutKind);
    assert.ok(failed.diagnostics.milestonesMs.requestSent >= 0);
    assert.equal(failed.diagnostics.milestonesMs.responseHeaders, undefined);
    assert.equal(observed.at(-1).event, 'done');
    assert.deepEqual(observed.at(-1).data.summary, { realtime: 2, noRealtime: 0, errors: 1 });
    assert.equal(observed.at(-1).data.completed, 3);
    assert.ok(observed.at(-1).data.runtime.eventLoopDelayMs.samples > 0);
    assert.ok(Number.isFinite(observed.at(-1).data.runtime.eventLoopDelayMs.max));
  } finally { agent.destroy(); await close(app); await close(upstream); }
});

test(`a stalled response body is distinguished from waiting for response headers [${transport}]`, async () => {
  const upstream = https.createServer({ key, cert }, (req, res) => {
    req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"Trains":');
  });
  const port = await listen(upstream);
  const agent = new https.Agent({ ca: cert, keepAlive: false });
  let last;
  try {
    const lookup = createTrainLookup({ endpoint: `https://127.0.0.1:${port}/`, httpsAgent: agent, post });
    await assert.rejects(lookup(entry, '2026-11-04', { timeoutMs: 200, onDiagnostic: d => { last = d; } }),
      e => e.code === 'UPSTREAM_TIMEOUT');
    assert.equal(last.phase, 'response_body');
    assert.equal(last.upstreamStatus, 200);
    assert.ok(last.bytesReceived > 0);
    assert.equal(last.milestonesMs.bodyEnd, undefined);
  } finally { agent.destroy(); await close(upstream); }
});

test(`a TLS handshake stall is attributed to TLS, not to backend response time [${transport}]`, async () => {
  const sockets = new Set();
  const upstream = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const port = await listen(upstream);
  const agent = new https.Agent({ ca: cert, keepAlive: false });
  let last;
  try {
    const lookup = createTrainLookup({ endpoint: `https://127.0.0.1:${port}/`, httpsAgent: agent, post });
    await assert.rejects(lookup(entry, '2026-11-04', { timeoutMs: 150, onDiagnostic: d => { last = d; } }),
      e => e.code === 'UPSTREAM_TIMEOUT');
    assert.equal(last.phase, 'tls');
    assert.ok(last.milestonesMs.tcp >= 0);
    assert.equal(last.milestonesMs.tls, undefined);
  } finally { agent.destroy(); for (const s of sockets) s.destroy(); await close(upstream); }
});

test(`certificate verification errors retain their native cause and TLS phase [${transport}]`, async () => {
  const upstream = https.createServer({ key, cert }, (req, res) => res.end(detail('1')));
  const port = await listen(upstream);
  const agent = new https.Agent({ keepAlive: false }); // Deliberately does not trust fixture CA.
  let last;
  try {
    const lookup = createTrainLookup({ endpoint: `https://127.0.0.1:${port}/`, httpsAgent: agent, post });
    await assert.rejects(lookup(entry, '2026-11-04', { onDiagnostic: d => { last = d; } }),
      e => /CERT|SELF_SIGNED/.test(e.code));
    assert.equal(last.phase, 'tls');
    assert.match(last.causeCode, /CERT|SELF_SIGNED/);
    assert.equal(last.outcome, 'error');
  } finally { agent.destroy(); await close(upstream); }
});

test(`DNS failure is reported before TCP/TLS without accessing external DNS [${transport}]`, async () => {
  const agent = new https.Agent({ ca: cert, lookup: (hostname, options, callback) => {
    queueMicrotask(() => callback(Object.assign(new Error('Fixture DNS failure'), { code: 'ENOTFOUND' })));
  } });
  let last;
  try {
    const lookup = createTrainLookup({ endpoint: 'https://fixture.invalid/detail', httpsAgent: agent, post });
    await assert.rejects(lookup(entry, '2026-11-04', { onDiagnostic: d => { last = d; } }), e => e.code === 'ENOTFOUND');
    assert.equal(last.phase, 'dns'); assert.equal(last.causeCode, 'ENOTFOUND');
    assert.equal(last.milestonesMs.tcp, undefined); assert.equal(last.milestonesMs.tls, undefined);
  } finally { agent.destroy(); }
});

test(`completed upstream HTTP and invalid JSON errors keep response diagnostics [${transport}]`, async () => {
  const upstream = https.createServer({ key, cert }, (req, res) => {
    req.resume();
    if (req.url === '/fault') { res.writeHead(500); res.end('<faultstring>Fixture fault</faultstring>'); }
    else res.end('invalid JSON');
  });
  const port = await listen(upstream);
  const agent = new https.Agent({ ca: cert, keepAlive: false });
  try {
    for (const [path, code, status] of [['/fault', 'UPSTREAM_HTTP', 500], ['/json', 'INVALID_RESPONSE', 200]]) {
      let last;
      const lookup = createTrainLookup({ endpoint: `https://127.0.0.1:${port}${path}`, httpsAgent: agent, post });
      await assert.rejects(lookup(entry, '2026-11-04', { onDiagnostic: d => { last = d; } }), e => e.code === code);
      assert.equal(last.upstreamStatus, status); assert.equal(last.outcome, 'error');
      assert.ok(last.milestonesMs.bodyEnd >= last.milestonesMs.responseHeaders);
      assert.ok(last.bytesReceived > 0);
    }
  } finally { agent.destroy(); await close(upstream); }
});

test(`closing SSE aborts the real in-flight upstream socket [${transport}]`, async () => {
  const received = deferred(), closed = deferred();
  const upstream = https.createServer({ key, cert }, (req, res) => {
    req.resume(); res.on('close', closed.resolve); received.resolve();
  });
  const port = await listen(upstream);
  const agent = new https.Agent({ ca: cert, keepAlive: false });
  const lookup = createTrainLookup({ endpoint: `https://127.0.0.1:${port}/`, httpsAgent: agent, post });
  let last;
  const app = http.createServer(createApp({ getTrainOptions: {
    calendar: () => calendar, clock: () => now,
    lookup: (e, date, options) => lookup(e, date, { ...options, onDiagnostic: state => {
      last = state; options.onDiagnostic(state);
    } }),
  } }));
  const appPort = await listen(app);
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/gettrain?stream=1&limit=1`, { signal: controller.signal });
    const reader = response.body.getReader(); await reader.read();
    await received.promise;
    controller.abort();
    await Promise.race([closed.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream not cancelled')), 1000).unref())]);
    assert.equal(last.outcome, 'aborted'); assert.equal(last.causeCode, 'CLIENT_ABORTED');
  } finally { controller.abort(); agent.destroy(); await close(app); await close(upstream); }
});

}

test('both clients send identical HTTP request fields and body to the HTTPS peer', async () => {
  const captures = [];
  const upstream = https.createServer({ key, cert }, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captures.push({ method: req.method, url: req.url, httpVersion: req.httpVersion,
      rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString('utf8') });
    res.end(detail('1'));
  });
  const port = await listen(upstream);
  const agent = new https.Agent({ ca: cert, keepAlive: false });
  try {
    for (const post of [undefined, nativePost]) {
      await createTrainLookup({ endpoint: `https://127.0.0.1:${port}/detail`, httpsAgent: agent, post })(entry, '2026-11-04');
    }
    assert.deepEqual(captures[0], captures[1]);
  } finally { agent.destroy(); await close(upstream); }
});

test('SSE negotiation, finite-run reconnection, validation and empty batches make no unexpected lookups', async () => {
  let calls = 0, nativeCalls = 0;
  const app = http.createServer(createApp({ getTrainOptions: {
    calendar: () => calendar, clock: () => now,
    lookup: async e => { calls++; return JSON.parse(detail(e.number)); },
    nativeLookup: async e => { nativeCalls++; return JSON.parse(detail(e.number)); },
  } }));
  const port = await listen(app);
  const url = `http://127.0.0.1:${port}/gettrain`;
  try {
    const response = await fetch(url + '?limit=0', { headers: { Accept: 'text/event-stream' } });
    const frames = []; for await (const frame of events(response.body)) frames.push(frame);
    assert.deepEqual(frames.map(f => f.event), ['start', 'done']);
    assert.equal(frames[1].data.remaining, 0);
    const retry = await fetch(url + '?stream=1', { headers: { 'Last-Event-ID': frames[1].id } });
    assert.equal(retry.status, 204);
    assert.equal((await fetch(url + '?stream=1', { method: 'HEAD' })).status, 405);
    for (const query of ['?stream=2', '?stream=1&mode=schedule', '?diagnostics=yes', '?transport=invalid']) {
      assert.equal((await fetch(url + query)).status, 400);
    }
    assert.equal(calls, 0);
    const normal = await (await fetch(url + '?limit=1')).json();
    assert.equal(normal.trains[0].diagnostics, undefined);
    const diagnostic = await (await fetch(url + '?limit=1&diagnostics=1')).json();
    assert.ok(diagnostic.trains[0].diagnostics.elapsedMs >= 0);
    assert.equal(diagnostic.trains[0].diagnostics.phase, 'unknown');
    assert.equal(calls, 2);
    const native = await (await fetch(url + '?limit=1&diagnostics=1&transport=native')).json();
    assert.equal(native.transport, 'native'); assert.equal(nativeCalls, 1); assert.equal(calls, 2);
  } finally { await close(app); }
});
