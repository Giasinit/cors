# Vercel CORS Proxy

## National train snapshot: `/gettrain`

`GET https://cors.giaflix.net/gettrain` selects every train currently within its
scheduled operating window and looks them all up concurrently. There is **no
application concurrency cap, queue, batching, retry or cache**. If 1,000 dated
trains are selected, 1,000 promises start without waiting for earlier responses;
the HTTPS agent also has unlimited `maxSockets`/`maxTotalSockets`. Platform and
upstream limits still apply and failures are returned per train.

The path is **caller → Vercel `/gettrain` → RFI**. Each lookup is a direct POST
from the Vercel function to SalaBlu+, with no second CORS proxy/self-request.
The direct RFI connection uses Vercel's egress IP; the collector creates fresh
outbound headers and never forwards caller IPs, cookies or auth. The generic
`?url=…` route separately strips caller-IP/forwarding/platform headers. Local
live checks call only the deployed `/gettrain` endpoint. Proxy providers still
receive the caller's connection; this is not an anonymity or GDPR compliance claim.

The bundled calendar is compiled from `IT-IT-TRENITALIA_L1.xml` (publication
2026-10-29, SHA-256
`1bd846e3bb25c1722824087be3ce0fc02b466c0aa4218a1055eaf24ed0586326`).
The 442,623,139-byte XML becomes a 114,461-byte gzip: 9,367 public train numbers,
14,546 distinct operating windows and 1,761 shared date bitsets. The validity
range is **2026-10-31 through 2027-12-11**. The original XML is not deployed.
3,045 non-rail journeys are excluded. The importer resolves DayType assignments,
weekdays, UIC date bits and explicit date exceptions, and retains day offsets for
overnight trains. Duplicate variants of the same public number/origin date use
one lookup. Selection uses the civil clock in `Europe/Rome`, including midnight
and DST changes. The filename does not identify a live feed: regenerate the
calendar when a new timetable is available.

Small test requests:

```text
/gettrain?mode=schedule              # Calendar selection only: zero RFI calls
/gettrain?limit=3                    # At most three simultaneous lookups
/gettrain?numbers=3496,8418,9425      # Only these numbers, if scheduled now
/gettrain?after=180                  # Also retain trains up to 180 min past scheduled end
```

The default has no `limit` and `after=0`. Eligibility is scheduled activity, not
proof of actual circulation. A train delayed beyond its scheduled end requires
an explicit `after` window. Unsupported dates return HTTP 409. Bad parameters
return HTTP 400. `HEAD /gettrain` returns 405 without starting any lookups.
`/get-train` is an alias. Calls perform one snapshot, not a background polling
loop; repeated calls start independent snapshots.

Responses contain `startedAt`, `completedAt`, `elapsedMs`, calendar provenance,
`active` (after any number filter), `selected`, summary counts and a compact
`trains` array. Each row identifies `number` and `serviceDate` (origin date):

- `rt: true`: completed arrival/departure flags or a numeric delay, including
  explicit zero, provide realtime evidence in this response.
- `rt: false`: no such evidence; `rt: null` means the lookup failed.
- `last`: the last completed event in path order, with its **PIC place ID** and
  arrival/departure kind. It is not a GPS location. `PlaceDescription` on an
  Arrival/Departure describes an origin/destination, so it is not used as the
  current station name.
- `last.scheduledTime`: timetable time of that event.
- `last.estimatedTime`: scheduled time plus numeric delay, explicitly an
  estimate, **not an observed detection timestamp**. It is null when the delay
  is absent; missing delay never means zero. Both timezone offsets and UTC
  timestamps identify instants.
- `checkedAt`: when that response was processed, not when the train was detected.
- `error`: bounded `code`, optional upstream `status`, and `message`; no full
  upstream response, timetable path or stack trace is returned.

The POST uses the current Rome query date and verifies the returned public
number and origin date. It never manufactures a PIC ID from a public number.
Wrong-date/ambiguous results are errors. Each lookup has a 24-second deadline;
the snapshot completes after all selected lookups settle. No guarantee that
every selected train succeeds, or that source data is two seconds old, is made.
The handler emits no per-train console logs.

Rebuild the small bundled calendar locally:

```sh
npm run build:calendar -- ~/Downloads/IT-IT-TRENITALIA_L1.xml
python3 -m unittest discover -s test -p 'test_*.py'
```

`npm test` includes an isolated concurrency check that starts 1,000 pending
lookups before resolving any. That check makes **zero external requests**;
live smoke tests use explicitly small selections.

## Generic proxy

Pass the target URL as the final `url` query parameter. Both the legacy raw URL
and `encodeURIComponent(targetUrl)` work. The proxy forwards the HTTP method,
request body, response status and body; `OPTIONS` preflight is answered locally.

```js
const target = 'https://salabluplus.rfi.it:8443/pic/v2/GetDepartures_v2?placeId=2000&limit=50';
const response = await fetch('https://cors.giaflix.net/?url=' + encodeURIComponent(target));
console.log(await response.json());
console.log('Upstream headers received after (ms):', response.headers.get('X-Proxy-Upstream-Ms'));
```

For train details, POST to the proxy itself:

```js
const target = 'https://salabluplus.rfi.it:8443/pic/v2/GetTrainDetailsWtime';
const response = await fetch('https://cors.giaflix.net/?url=' + encodeURIComponent(target), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    trainNumber: '757',
    timeGMT: '2026-11-04T00:00:00%2B00:00',
    timeUTC: '2026-11-04T00:00:00.000Z',
  }),
});
console.log(await response.json());
```

The example date is fixed to the tested overnight run; choose the query date
explicitly for subsequent tests and verify the returned train ID and dates.
`X-Proxy-Upstream-Ms` measures proxy → upstream response headers, including
connection/TLS and upstream wait. It excludes browser → proxy latency and body
download. It does not isolate PIC's internal processing time. Responses are not cached.

Upstream failures return JSON with HTTP 502; the 25-second exchange deadline
returns HTTP 504. Vercel's function duration is configured as 30 seconds.

## SalaBlu+ certificate chain

SalaBlu+ currently sends its leaf certificate without the intermediate
`DigiCert Global G2 TLS RSA SHA256 2020 CA1`. The bundled public intermediate
completes that chain for **salabluplus.rfi.it only**, alongside Node's normal CA
roots. Certificate validity and hostname verification remain enabled.

Source: [DigiCert's certificate distribution](https://cacerts.digicert.com/DigiCertGlobalG2TLSRSASHA2562020CA1-1.crt).
SHA-256 certificate fingerprint:
`C8:02:5F:9F:C6:5F:DF:C9:5B:3C:A8:CC:78:67:B9:A5:87:B5:27:79:73:95:79:17:46:3F:C8:13:D0:B6:25:A9`.
The intermediate expires on 29 March 2031. A changed upstream issuer may require
updating this public certificate; no TLS verification bypass is used.

## Local checks

```sh
npm install --omit=dev
npm test
```
