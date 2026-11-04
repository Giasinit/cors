import https from 'node:https';
import { salaBluAuthorities } from './salablu-tls.js';

// /gettrain runs on Vercel: connect straight to RFI from that server, never via a second proxy.
const DETAIL = 'https://salabluplus.rfi.it:8443/pic/v2/GetTrainDetailsWtime';
const agent = new https.Agent({
  keepAlive: true, maxSockets: Infinity, maxTotalSockets: Infinity, maxFreeSockets: 16,
  ca: salaBluAuthorities, rejectUnauthorized: true,
});

export class TrainError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export function fetchTrain(entry, queryDate, { timeoutMs = 24_000 } = {}) {
  const body = JSON.stringify({
    trainNumber: entry.number, timeGMT: `${queryDate}T00:00:00%2B00:00`, timeUTC: `${queryDate}T00:00:00.000Z`,
  });
  return new Promise((resolve, reject) => {
    const req = https.request(DETAIL, {
      agent, method: 'POST', rejectUnauthorized: true,
      // Never forward caller IPs, cookies, auth or incoming request headers.
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) req.destroy(new TrainError('RESPONSE_TOO_LARGE', 'RFI response exceeds 1 MiB'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          const fault = text.match(/<faultstring>([^<]*)<\/faultstring>/)?.[1];
          return reject(new TrainError('UPSTREAM_HTTP', (fault || text || 'Upstream request failed').slice(0, 160), response.statusCode));
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new TrainError('INVALID_RESPONSE', text.slice(0, 160) || 'Empty RFI response')); }
      });
    });
    // Absolute deadline, not just socket inactivity; all requests start immediately.
    const deadline = setTimeout(() => req.destroy(new TrainError('UPSTREAM_TIMEOUT', 'RFI request timed out')), timeoutMs);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(body);
  });
}

function delay(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function canonical(number) { return String(number).replace(/^0+(?=\d)/, ''); }

export function compactTrain(data, entry, checkedAt) {
  if (!Array.isArray(data?.Trains)) throw new TrainError('INVALID_RESPONSE', 'Missing Trains array');
  const byNumber = data.Trains.filter(train => Array.isArray(train.Path) && train.Path.some(point =>
    [point.Arrival, point.Departure].some(event => event?.TrainNumber !== undefined
      && canonical(event.TrainNumber) === canonical(entry.number))));
  const matches = byNumber.filter(train => String(train.TrainHeader?.Id || '').startsWith(entry.originDate.replaceAll('-', '')));
  if (matches.length !== 1) {
    throw new TrainError(matches.length > 1 ? 'AMBIGUOUS_TRAIN' : byNumber.length ? 'SERVICE_DATE_MISMATCH' : 'TRAIN_NOT_FOUND',
      'No unique detail matching the public number and origin date');
  }
  const train = matches[0];
  let rt = false;
  let last = null;
  for (const point of train.Path) {
    for (const event of [point.Arrival, point.Departure]) {
      if (event && delay(event.Delay) !== null) rt = true;
    }
    const kind = point.Departed === true && point.Departure ? 'departure'
      : point.Arrived === true && point.Arrival ? 'arrival' : null;
    if (!kind) continue;
    if (!Number.isInteger(point.Place) || point.Place < 0) throw new TrainError('INVALID_RESPONSE', 'Missing PIC place ID');
    rt = true;
    const event = kind === 'departure' ? point.Departure : point.Arrival;
    const scheduled = typeof event.Time === 'string' && Number.isFinite(Date.parse(event.Time)) ? event.Time : null;
    const minutes = delay(event.Delay);
    last = {
      place: point.Place, event: kind, scheduledTime: scheduled,
      // This is not an observed event timestamp. A missing delay is never assumed zero.
      estimatedTime: scheduled !== null && minutes !== null
        ? new Date(Date.parse(scheduled) + minutes * 60_000).toISOString() : null,
    };
  }
  return { number: entry.number, serviceDate: entry.originDate, rt, last, checkedAt };
}

export async function collectTrains(entries, queryDate, { lookup = fetchTrain, clock = () => new Date() } = {}) {
  // No pool, queue, batching or concurrency cap: one promise starts per selected train.
  return Promise.all(entries.map(async entry => {
    try {
      return compactTrain(await lookup(entry, queryDate), entry, clock().toISOString());
    } catch (error) {
      return {
        number: entry.number, serviceDate: entry.originDate, rt: null, last: null,
        checkedAt: clock().toISOString(),
        error: { code: error.code || 'LOOKUP_ERROR', ...(error.status !== undefined ? { status: error.status } : {}),
          message: String(error.message || 'Train lookup failed').slice(0, 160) },
      };
    }
  }));
}
