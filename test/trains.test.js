import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { mock, test } from 'node:test';
import requestClient from 'request';
import { createApp } from '../api/index.js';
import { prepareCalendar, selectActive } from '../lib/train-calendar.js';
import { collectTrains, compactTrain, fetchTrain, TrainError } from '../lib/train-realtime.js';

const now = new Date('2026-11-04T12:00:00Z');
const entry = { number: '757', serviceDate: '2026-11-04', originDate: '2026-11-04' };
function detail(number = '757', date = '20261104') {
  return { ServerTime: '2026-11-04T13:00:00+01:00', Trains: [{ TrainHeader: { Id: date + '135947' }, Path: [
    { Place: 10, Arrived: false, Departed: true, Departure: {
      TrainNumber: number, Time: '2026-11-04T12:00:00+01:00', Delay: '3',
    } },
    { Place: 20, Arrived: true, Departed: false, Arrival: {
      TrainNumber: number, Time: '2026-11-04T12:55:00+01:00', Delay: '-2',
    }, Departure: { TrainNumber: number, Time: '2026-11-04T13:00:00+01:00' } },
    { Place: 30, Arrived: false, Departed: false, Arrival: { TrainNumber: number, Time: '2026-11-04T14:00:00+01:00' } },
  ] }] };
}

function calendar(rows = [['757', 0, 86399, 0]]) {
  return prepareCalendar({ version: 1, timezone: 'Europe/Rome', from: '2026-11-03', to: '2026-11-05',
    publication: '2026-10-29T12:00:00Z', source: { sha256: 'fixture' }, maxEnd: Math.max(...rows.map(r => r[2])),
    calendars: [Buffer.from([7]).toString('base64')], trains: rows });
}

test('detail transport calls RFI directly with verified TLS, no proxy hop and no caller headers', async () => {
  let calls = 0;
  const request = mock.method(requestClient, 'post', (options, callback) => {
    calls++;
    const url = new URL(options.url);
    assert.equal(url.hostname, 'salabluplus.rfi.it');
    assert.equal(url.port, '8443');
    assert.equal(url.pathname, '/pic/v2/GetTrainDetailsWtime');
    assert.equal(url.search, '');
    assert.equal(options.strictSSL, true);
    assert.equal(options.proxy, false);
    assert.equal(options.agent.options.rejectUnauthorized, true);
    assert.equal(options.agent.maxSockets, Infinity);
    assert.equal(options.agent.maxTotalSockets, Infinity);
    assert.equal(options.agent.keepAlive, false);
    assert.ok(options.agent.options.ca.some(pem => new X509Certificate(pem).subject
      .includes('DigiCert Global G2 TLS RSA SHA256 2020 CA1')));
    assert.deepEqual(Object.keys(options.headers).sort(), ['Content-Length', 'Content-Type']);
    const req = new EventEmitter();
    assert.deepEqual(JSON.parse(options.body), { trainNumber: '757',
        timeGMT: '2026-11-04T00:00:00%2B00:00', timeUTC: '2026-11-04T00:00:00.000Z' });
    queueMicrotask(() => callback(null, { statusCode: 200 }, JSON.stringify(detail())));
    return req;
  });
  try {
    assert.deepEqual(await fetchTrain(entry, '2026-11-04'), detail());
    assert.equal(calls, 1);
  } finally { request.mock.restore(); }
});

test('calendar honors exact date bits, time window, filtering and duplicate variants', () => {
  const c = calendar([['1', 43200, 50000, 0], ['1', 44000, 50500, 0], ['2', 50001, 60000, 0]]);
  c.masks[0][0] = 2; // Only 4 November.
  assert.deepEqual(selectActive(c, now).map(t => t.number), ['1']);
  assert.equal(selectActive(c, new Date('2026-11-05T12:00:00Z')).length, 0);
  assert.equal(selectActive(c, now, { numbers: new Set(['2']) }).length, 0);
  assert.throws(() => selectActive(c, new Date('2028-01-01T00:00:00Z')), /Calendar valid/);
});

test('direct RFI transport times out and aborts a stalled request', async () => {
  let aborted = 0;
  const transport = mock.method(requestClient, 'post', () => {
    const req = new EventEmitter();
    req.abort = () => { aborted++; };
    return req;
  });
  try {
    await assert.rejects(fetchTrain(entry, '2026-11-04', { timeoutMs: 5 }), e => e.code === 'UPSTREAM_TIMEOUT');
    assert.equal(aborted, 1);
  } finally { transport.mock.restore(); }
});

test('night trains retain yesterday origin date; grace is explicit', () => {
  const c = calendar([['757', 84600, 90000, 0]]);
  c.masks[0][0] = 1; // Only 3 November.
  assert.equal(selectActive(c, new Date('2026-11-04T00:00:00Z'))[0].originDate, '2026-11-03');
  assert.equal(selectActive(c, new Date('2026-11-04T00:10:00Z')).length, 0);
  assert.equal(selectActive(c, new Date('2026-11-04T00:10:00Z'), { afterMinutes: 15 }).length, 1);
});

test('Rome calendar selection uses civil clocks across both DST transitions', () => {
  const c = calendar([['1', 2 * 3600, 3 * 3600, 0]]);
  c.from = '2026-10-25'; c.to = '2026-10-25'; c.masks = [Buffer.from([1])];
  assert.equal(selectActive(c, new Date('2026-10-25T00:30:00Z')).length, 1);
  assert.equal(selectActive(c, new Date('2026-10-25T01:30:00Z')).length, 1);
  c.from = '2027-03-28'; c.to = '2027-03-28';
  assert.equal(selectActive(c, new Date('2027-03-28T00:59:00Z')).length, 0);
  assert.equal(selectActive(c, new Date('2027-03-28T01:01:00Z')).length, 0);
});

test('last completed event uses PIC Place and clearly estimated event time', () => {
  const r = compactTrain(detail(), entry, now.toISOString());
  assert.equal(r.rt, true);
  assert.deepEqual(r.last, { place: 20, event: 'arrival', scheduledTime: '2026-11-04T12:55:00+01:00',
    estimatedTime: '2026-11-04T11:53:00.000Z' });
  assert.equal(r.checkedAt, now.toISOString());
  assert.equal(r.last.time, undefined); // No invented observed detection timestamp.
});

test('missing delay stays unknown, while an explicit zero delay is valid', () => {
  const d = detail(); delete d.Trains[0].Path[1].Arrival.Delay;
  assert.equal(compactTrain(d, entry, now.toISOString()).last.estimatedTime, null);
  d.Trains[0].Path[1].Arrival.Delay = '0';
  assert.equal(compactTrain(d, entry, now.toISOString()).last.estimatedTime, '2026-11-04T11:55:00.000Z');
});

test('scheduled-only data is not labeled realtime', () => {
  const d = detail();
  for (const p of d.Trains[0].Path) {
    p.Arrived = p.Departed = false;
    for (const e of [p.Arrival, p.Departure]) if (e) delete e.Delay;
  }
  const r = compactTrain(d, entry, now.toISOString());
  assert.equal(r.rt, false); assert.equal(r.last, null);
});

test('wrong service date and ambiguous responses are errors', () => {
  assert.throws(() => compactTrain(detail('757', '20261103'), entry, now.toISOString()),
    e => e.code === 'SERVICE_DATE_MISMATCH');
  const d = detail(); d.Trains.push(d.Trains[0]);
  assert.throws(() => compactTrain(d, entry, now.toISOString()), e => e.code === 'AMBIGUOUS_TRAIN');
});

test('1000 lookups start before any one resolves: no concurrency pool or batching', async () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ ...entry, number: String(i + 1) }));
  let started = 0;
  const finish = [];
  const result = collectTrains(entries, '2026-11-04', {
    lookup: e => { started++; return new Promise(resolve => finish.push(() => resolve(detail(e.number)))); },
    clock: () => now,
  });
  assert.equal(started, 1000); // All pending, none completed.
  finish.forEach(resolve => resolve());
  const rows = await result;
  assert.equal(rows.length, 1000);
  assert.ok(rows.every(r => r.rt && !r.error));
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) < 500_000);
});

test('one upstream error does not discard the other trains', async () => {
  const rows = await collectTrains([entry, { ...entry, number: '2' }], '2026-11-04', {
    lookup: e => e.number === '2' ? Promise.reject(new TrainError('UPSTREAM_HTTP', 'Policy Falsified', 500)) : Promise.resolve(detail()),
    clock: () => now,
  });
  assert.equal(rows[0].rt, true);
  assert.deepEqual(rows[1].error, { code: 'UPSTREAM_HTTP', status: 500, message: 'Policy Falsified' });
  assert.equal(rows[1].rt, null);
});

test('real HTTP endpoint applies calendar/filter, forwards all selected calls and keeps HEAD quiet', async () => {
  let calls = 0;
  const app = createApp({ getTrainOptions: { calendar: () => calendar([['757', 0, 86399, 0], ['2', 0, 86399, 0]]),
    lookup: e => { calls++; return Promise.resolve(detail(e.number)); }, clock: () => now } });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/gettrain`;
  try {
    const schedule = await (await fetch(url + '?mode=schedule')).json();
    assert.equal(schedule.selected, 2); assert.equal(calls, 0);
    assert.equal((await fetch(url, { method: 'HEAD' })).status, 405); assert.equal(calls, 0);
    const data = await (await fetch(url + '?limit=1')).json();
    assert.equal(data.selected, 1); assert.equal(calls, 1); assert.equal(data.trains.length, 1);
    await fetch(url + '?numbers=757'); assert.equal(calls, 2);
    assert.equal((await fetch(url + '?limit=-1')).status, 400); assert.equal(calls, 2);
    const all = await (await fetch(url)).json();
    assert.equal(all.selected, 2); assert.equal(calls, 4);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
