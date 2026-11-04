import { loadCalendar, romeTime, selectActive } from './train-calendar.js';
import { collectTrains, fetchTrain, createTrainLookup } from './train-realtime.js';
import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { nativePost } from './native-post.js';

const fetchTrainNative = createTrainLookup({ post: nativePost });

function scalar(query, name) {
  const value = query[name];
  if (value !== undefined && typeof value !== 'string') throw new Error(`Invalid ${name}`);
  return value;
}

function integer(query, name, fallback) {
  const value = scalar(query, name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${name}`);
  return Number(value);
}

export function createGetTrain({
  calendar = loadCalendar, lookup = fetchTrain, nativeLookup = fetchTrainNative,
  clock = () => new Date(), progressIntervalMs = 3000,
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let mode, afterMinutes, limit, numbers, stream, diagnostics, transport;
    try {
      mode = scalar(req.query, 'mode') || 'live';
      if (!['live', 'schedule'].includes(mode)) throw new Error('Invalid mode');
      const streaming = scalar(req.query, 'stream');
      if (streaming !== undefined && !['0', '1'].includes(streaming)) throw new Error('Invalid stream');
      stream = streaming === undefined ? req.accepts(['json', 'text/event-stream']) === 'text/event-stream' : streaming === '1';
      const diagnostic = scalar(req.query, 'diagnostics');
      if (diagnostic !== undefined && !['0', '1'].includes(diagnostic)) throw new Error('Invalid diagnostics');
      diagnostics = stream || diagnostic === '1';
      transport = scalar(req.query, 'transport') || 'request';
      if (!['request', 'native'].includes(transport)) throw new Error('Invalid transport');
      if (stream && mode === 'schedule') throw new Error('SSE requires live mode');
      afterMinutes = integer(req.query, 'after', 0);
      if (afterMinutes > 1440) throw new Error('after must be at most 1440 minutes');
      limit = integer(req.query, 'limit', Infinity);
      const filter = scalar(req.query, 'numbers');
      if (filter !== undefined) {
        if (!/^\d+(?:,\d+)*$/.test(filter)) throw new Error('Invalid numbers');
        numbers = new Set(filter.split(','));
      }
    } catch (error) {
      return res.status(400).json({ error: 'INVALID_QUERY', message: error.message });
    }
    // This is a finite run, not a replayable feed. Stop EventSource reconnects
    // carrying our last event ID instead of silently launching another batch.
    if (stream && req.get('Last-Event-ID')) return res.status(204).end();
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnected);
    let heartbeat, emit, loopDelay;
    try {
      const startedAt = clock();
      const started = performance.now();
      const data = calendar();
      const active = selectActive(data, startedAt, { afterMinutes, numbers });
      const selected = active.slice(0, limit);
      // One abort listener per selected lookup; each removes itself on completion.
      setMaxListeners(selected.length + 1, controller.signal);
      if (diagnostics) {
        loopDelay = monitorEventLoopDelay({ resolution: 20 });
        loopDelay.enable();
      }
      const metadata = {
        startedAt: startedAt.toISOString(), timezone: 'Europe/Rome',
        calendar: { from: data.from, to: data.to, publication: data.publication, sha256: data.source.sha256 },
        active: active.length, selected: selected.length,
        ...(diagnostics ? { transport } : {}),
      };
      if (mode === 'schedule') return res.json({ ...metadata, trains: selected });
      const pending = new Map(selected.map(entry => [entry.originDate + '/' + entry.number, {
        number: entry.number, serviceDate: entry.originDate, observedAt: performance.now(),
        diagnostics: { elapsedMs: 0, phase: 'starting', phaseElapsedMs: 0, outcome: 'pending' },
      }]));
      let completed = 0;
      if (stream) {
        res.set({ 'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const runId = randomUUID();
        let sequence = 0;
        emit = (event, data) => {
          if (res.destroyed || res.writableEnded || controller.signal.aborted) return;
          // Node buffers writes for a slow reader. Bound that buffer rather than
          // keeping upstream sockets alive indefinitely after a stalled client.
          if (res.writableLength > 1024 * 1024) {
            controller.abort();
            res.destroy();
            return;
          }
          res.write(`id: ${runId}:${sequence++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        res.write('retry: 60000\n\n');
        emit('start', { ...metadata, trains: selected.map(e => ({ number: e.number, serviceDate: e.originDate })) });
        heartbeat = setInterval(() => {
          const now = performance.now();
          emit('progress', { elapsedMs: Math.round(now - started), completed, remaining: pending.size,
            pending: [...pending.values()].map(({ observedAt, diagnostics: d, ...identity }) => ({ ...identity,
              diagnostics: { ...d, elapsedMs: Math.round(d.elapsedMs + now - observedAt),
                phaseElapsedMs: Math.round((d.phaseElapsedMs || 0) + now - observedAt) },
            })),
          });
        }, progressIntervalMs);
        heartbeat.unref?.();
      }
      const trains = await collectTrains(selected, romeTime(startedAt).date, {
        lookup: transport === 'native' ? nativeLookup : lookup,
        clock, signal: controller.signal, diagnostics,
        onDiagnostic: (entry, state) => {
          const item = pending.get(entry.originDate + '/' + entry.number);
          if (item) { item.diagnostics = state; item.observedAt = performance.now(); }
        },
        onResult: row => {
          completed++;
          pending.delete(row.serviceDate + '/' + row.number);
          emit?.('train', { ...row, completed, remaining: pending.size });
        },
      });
      const errors = trains.filter(t => t.error).length;
      const realtime = trains.filter(t => t.rt === true).length;
      loopDelay?.disable();
      const result = { ...metadata,
        completedAt: clock().toISOString(), elapsedMs: Math.round(performance.now() - started),
        summary: { realtime, noRealtime: trains.length - errors - realtime, errors },
        ...(loopDelay ? { runtime: {
          environmentProxyConfigured: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
            .some(name => Boolean(process.env[name])),
          configuredOutboundProxy: false,
          eventLoopDelayMs: { resolutionMs: 20, samples: loopDelay.count,
          max: loopDelay.count ? Math.round(loopDelay.max / 1e5) / 10 : null,
          p99: loopDelay.count ? Math.round(loopDelay.percentile(99) / 1e5) / 10 : null,
        } } } : {}),
      };
      if (stream) {
        emit('done', { ...result, completed, remaining: 0 });
        res.end();
      } else if (!res.destroyed) {
        // Compact JSON regardless of the pretty-printed generic proxy errors.
        res.type('application/json').send(JSON.stringify({ ...result, trains }));
      }
    } catch (error) {
      controller.abort();
      if (res.destroyed) return;
      if (res.headersSent) {
        // emit normally suppresses writes after cancellation; this final message
        // is safe only while the downstream is still open.
        res.write(`event: fatal\ndata: ${JSON.stringify({ error: error.code || 'STREAM_ERROR',
          message: String(error.message).slice(0, 160) })}\n\n`);
        return res.end();
      }
      return res.status(error.code === 'CALENDAR_OUT_OF_RANGE' ? 409 : 500)
        .json({ error: error.code || 'CALENDAR_ERROR', message: error.message });
    } finally {
      clearInterval(heartbeat);
      loopDelay?.disable();
      res.off('close', disconnected);
    }
  };
}
