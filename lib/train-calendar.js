import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const locale = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const DAY = 86_400_000;
let bundled;

export function romeTime(now) {
  const p = Object.fromEntries(locale.formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, seconds: +p.hour * 3600 + +p.minute * 60 + +p.second };
}

export function addDays(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);
}

export function prepareCalendar(data) {
  if (data.version !== 1 || data.timezone !== 'Europe/Rome') throw new Error('Unsupported calendar');
  return { ...data, masks: data.calendars.map(x => Buffer.from(x, 'base64')) };
}

export function loadCalendar() {
  bundled ??= prepareCalendar(JSON.parse(gunzipSync(readFileSync(
    new URL('../data/train-calendar.json.gz', import.meta.url),
  )).toString('utf8')));
  return bundled;
}

export function selectActive(data, now, { afterMinutes = 0, numbers } = {}) {
  const local = romeTime(now);
  if (local.date < data.from || local.date > data.to) {
    throw Object.assign(new Error(`Calendar valid ${data.from} through ${data.to}`), { code: 'CALENDAR_OUT_OF_RANGE' });
  }
  const lookback = Math.ceil((data.maxEnd + afterMinutes * 60) / 86400);
  const selected = new Map();
  for (let offset = 0; offset <= lookback; offset++) {
    const serviceDate = addDays(local.date, -offset);
    const index = Math.round((Date.parse(serviceDate + 'T00:00:00Z') - Date.parse(data.from + 'T00:00:00Z')) / DAY);
    if (index < 0) continue;
    const civilSeconds = offset * 86400 + local.seconds;
    for (const [number, start, end, calendar] of data.trains) {
      if (numbers && !numbers.has(number)) continue;
      if (civilSeconds < start || civilSeconds > end + afterMinutes * 60) continue;
      if (!(data.masks[calendar][index >> 3] & (1 << (index & 7)))) continue;
      const originDate = addDays(serviceDate, Math.floor(start / 86400));
      const key = originDate + '/' + number;
      // Variants of the same public train and origin date need one PIC query.
      if (!selected.has(key)) selected.set(key, { number, serviceDate, originDate });
    }
  }
  return [...selected.values()].sort((a, b) => a.originDate.localeCompare(b.originDate)
    || a.number.localeCompare(b.number, 'en', { numeric: true }));
}
