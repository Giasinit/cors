import https from 'node:https';
import { isIP } from 'node:net';
import request from 'request';
import { salaBluAuthorities } from './salablu-tls.js';
import { requestDiagnostics } from './request-diagnostics.js';

// /gettrain runs on Vercel: connect straight to RFI from that server, never via a second proxy.
const DETAIL = 'https://salabluplus.rfi.it:8443/pic/v2/GetTrainDetailsWtime';
const agent = new https.Agent({
  keepAlive: false, maxSockets: Infinity, maxTotalSockets: Infinity, maxFreeSockets: 16,
  ca: salaBluAuthorities, rejectUnauthorized: true,
});

export class TrainError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// Endpoint/agent are injectable only by server code, for real local HTTPS simulations.
export function createTrainLookup({ endpoint = DETAIL, httpsAgent = agent } = {}) {
  return function fetchTrain(entry, queryDate, { timeoutMs = 24_000, signal, onDiagnostic } = {}) {
    const body = JSON.stringify({
      trainNumber: entry.number, timeGMT: `${queryDate}T00:00:00%2B00:00`, timeUTC: `${queryDate}T00:00:00.000Z`,
    });
    return new Promise((resolve, reject) => {
      let deadline, req, settled = false;
      const trace = requestDiagnostics(onDiagnostic);
      trace.start();
      const finish = (error, value, timeoutKind) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        trace.finish(error, timeoutKind);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => {
        finish(new TrainError('CLIENT_ABORTED', 'Client disconnected'));
        req?.abort();
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      // Use the same HTTP client and connection-close behavior as the working generic proxy,
      // but connect from this function directly to RFI. No self-request or second proxy.
      req = request.post({
        url: endpoint, agent: httpsAgent, strictSSL: true, timeout: timeoutMs, body,
        // A diagnostic must describe this request, not an unobserved redirect chain.
        followRedirect: false,
        // Never forward caller IPs, cookies, auth or incoming request headers.
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(body) },
      }, (error, response, text) => {
        if (error) {
          const timedOut = ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error.code);
          const kind = timedOut ? (error.code === 'ESOCKETTIMEDOUT' ? 'socket_inactivity'
            : error.connect ? 'connection_timeout' : 'transport_timeout') : undefined;
          // Keep the native cause separate from the compact public error code.
          if (timedOut) {
            trace.finish(error, kind);
            return finish(new TrainError('UPSTREAM_TIMEOUT', 'RFI request timed out'));
          }
          return finish(error);
        }
        trace.end();
        if (response.statusCode !== 200) {
          const fault = text.match(/<faultstring>([^<]*)<\/faultstring>/)?.[1];
          return finish(new TrainError('UPSTREAM_HTTP', (fault || text || 'Upstream request failed').slice(0, 160), response.statusCode));
        }
        try { finish(null, JSON.parse(text)); }
        catch { finish(new TrainError('INVALID_RESPONSE', text.slice(0, 160) || 'Empty RFI response')); }
      });
      req.on('request', outgoing => {
        outgoing.once('socket', socket => trace.socket(socket, !isIP(new URL(endpoint).hostname)));
        outgoing.once('finish', trace.sent);
      });
      req.on('response', response => trace.response(response.statusCode));
      let bytes = 0;
      req.on('data', chunk => {
        trace.data(chunk);
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          finish(new TrainError('RESPONSE_TOO_LARGE', 'RFI response exceeds 1 MiB'));
          req.abort();
        }
      });
      // Absolute deadline, not just socket inactivity; all requests start immediately.
      deadline = setTimeout(() => {
        finish(new TrainError('UPSTREAM_TIMEOUT', 'RFI request timed out'), undefined, 'absolute_deadline');
        req.abort();
      }, timeoutMs);
    });
  };
}

export const fetchTrain = createTrainLookup();

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

export async function collectTrains(entries, queryDate, {
  lookup = fetchTrain, clock = () => new Date(), signal, diagnostics = false, onResult, onDiagnostic,
} = {}) {
  // No pool, queue, batching or concurrency cap: one promise starts per selected train.
  return Promise.all(entries.map(async entry => {
    const started = performance.now();
    let row, latest;
    try {
      const data = await lookup(entry, queryDate, { signal, onDiagnostic: state => {
        latest = state;
        onDiagnostic?.(entry, state);
      } });
      row = compactTrain(data, entry, clock().toISOString());
    } catch (error) {
      row = {
        number: entry.number, serviceDate: entry.originDate, rt: null, last: null,
        checkedAt: clock().toISOString(),
        error: { code: error.code || 'LOOKUP_ERROR', ...(error.status !== undefined ? { status: error.status } : {}),
          message: String(error.message || 'Train lookup failed').slice(0, 160) },
      };
    }
    if (diagnostics) row.diagnostics = latest || {
      elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      phase: 'unknown', outcome: row.error ? 'error' : 'success',
    };
    onResult?.(row);
    return row;
  }));
}
