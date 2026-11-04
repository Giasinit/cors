import { loadCalendar, romeTime, selectActive } from './train-calendar.js';
import { collectTrains, fetchTrain } from './train-realtime.js';

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

export function createGetTrain({ calendar = loadCalendar, lookup = fetchTrain, clock = () => new Date() } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let mode, afterMinutes, limit, numbers;
    try {
      mode = scalar(req.query, 'mode') || 'live';
      if (!['live', 'schedule'].includes(mode)) throw new Error('Invalid mode');
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
    try {
      const startedAt = clock();
      const started = performance.now();
      const data = calendar();
      const active = selectActive(data, startedAt, { afterMinutes, numbers });
      const selected = active.slice(0, limit);
      const metadata = {
        startedAt: startedAt.toISOString(), timezone: 'Europe/Rome',
        calendar: { from: data.from, to: data.to, publication: data.publication, sha256: data.source.sha256 },
        active: active.length, selected: selected.length,
      };
      if (mode === 'schedule') return res.json({ ...metadata, trains: selected });
      const trains = await collectTrains(selected, romeTime(startedAt).date, { lookup, clock });
      const errors = trains.filter(t => t.error).length;
      const realtime = trains.filter(t => t.rt === true).length;
      // Compact JSON regardless of the pretty-printed generic proxy errors.
      res.type('application/json').send(JSON.stringify({ ...metadata,
        completedAt: clock().toISOString(), elapsedMs: Math.round(performance.now() - started),
        summary: { realtime, noRealtime: trains.length - errors - realtime, errors }, trains,
      }));
    } catch (error) {
      return res.status(error.code === 'CALENDAR_OUT_OF_RANGE' ? 409 : 500)
        .json({ error: error.code || 'CALENDAR_ERROR', message: error.message });
    }
  };
}
