// Offline reference: use the existing Node implementations, never the network.
import { prepareCalendar, selectActive, loadCalendar } from '../lib/train-calendar.js';
import { compactTrain } from '../lib/train-realtime.js';

const calendars = [];
function calendarCase(data, now, options = {}) {
  const prepared = prepareCalendar(data);
  let expected, error;
  try { expected = selectActive(prepared, new Date(now), { ...options, numbers: options.numbers && new Set(options.numbers) }); }
  catch (e) { error = e.code; }
  const { masks, ...raw } = prepared;
  calendars.push({ data: raw, now, options, expected, error });
}
const real = loadCalendar();
const { masks, ...rawReal } = real;
for (const now of ['2026-11-04T00:05:00Z', '2026-11-04T12:00:00Z', '2026-11-04T16:00:00Z', '2026-11-04T23:15:00Z', '2027-03-28T01:05:00Z']) {
  for (const afterMinutes of [0, 180]) calendarCase(rawReal, now, { afterMinutes });
  calendarCase(rawReal, now, { numbers: ['3496', '757', '5583'] });
}
const fixture = { version: 1, timezone: 'Europe/Rome', from: '2026-11-03', to: '2026-11-05',
  calendars: ['Bw=='], maxEnd: 90000, trains: [['757', 84600, 90000, 0], ['2', 0, 86399, 0], ['2', 100, 86399, 0], ['3', 87000, 90000, 0]] };
for (const now of ['2026-11-04T00:00:00Z', '2026-11-04T00:10:00Z', '2026-11-05T23:30:00Z']) {
  for (const afterMinutes of [0, 15]) calendarCase(fixture, now, { afterMinutes });
}
for (const [date, times] of [['2026-10-25', ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']], ['2027-03-28', ['2027-03-28T00:59:00Z', '2027-03-28T01:01:00Z']]]) {
  for (const now of times) calendarCase({ ...fixture, from: date, to: date, calendars: ['AQ=='], maxEnd: 10800, trains: [['1', 7200, 10800, 0]] }, now);
}
calendarCase(fixture, '2028-01-01T00:00:00Z');

const entry = { number: '757', serviceDate: '2026-11-04', originDate: '2026-11-04' };
const checkedAt = '2026-11-04T12:00:00.000Z';
const base = { Trains: [{ TrainHeader: { Id: '20261104123456' }, Path: [
  { Place: 10, Arrived: false, Departed: true, Departure: { TrainNumber: '757', Time: '2026-11-04T12:00:00+01:00', Delay: '3' } },
  { Place: 20, Arrived: true, Departed: false, Arrival: { TrainNumber: '757', Time: '2026-11-04T12:55:00+01:00', Delay: '-2' }, Departure: { TrainNumber: '757', Time: '2026-11-04T13:00:00+01:00' } },
  { Place: 30, Arrived: false, Departed: false, Arrival: { TrainNumber: '757', Time: '2026-11-04T14:00:00+01:00' } },
] }] };
const details = [];
function detailCase(mutate = () => {}) {
  const data = structuredClone(base); mutate(data);
  let expected, error;
  try { expected = compactTrain(data, entry, checkedAt); }
  catch (e) { error = e.code || 'LOOKUP_ERROR'; }
  details.push({ data, entry, checkedAt, expected, error });
}
detailCase();
for (const delay of [undefined, null, 0, '0', '-20', '+180', ' 3.5 ', '3e2', true, 'false']) {
  detailCase(d => { d.Trains[0].Path[1].Arrival.Delay = delay; });
}
detailCase(d => { for (const p of d.Trains[0].Path) { p.Arrived = p.Departed = false; for (const e of [p.Arrival, p.Departure]) if (e) delete e.Delay; } });
detailCase(d => { d.Trains[0].TrainHeader.Id = '20261103123456'; });
detailCase(d => { d.Trains.push(structuredClone(d.Trains[0])); });
detailCase(d => { for (const p of d.Trains[0].Path) for (const e of [p.Arrival, p.Departure]) if (e) e.TrainNumber = '758'; });
detailCase(d => { d.Trains[0].Path[1].Place = null; });
detailCase(d => { delete d.Trains[0].Path[1].Place; });
detailCase(d => { d.Trains[0].Path[1].Place = '20'; });
detailCase(d => { d.Trains[0].Path[1].Arrival.Time = 'invalid'; });
detailCase(d => { d.Trains[0].Path[1].Departed = true; });
detailCase(d => { d.Trains[0].Path[1].Arrival.TrainNumber = 757; });
process.stdout.write(JSON.stringify({ calendars, details }));
