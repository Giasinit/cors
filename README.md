# Vercel CORS Proxy

## Bombardier on Vercel, without Node: `/bombardier`

This separate **Go Vercel Function** executes the unmodified upstream Bombardier
binary, pinned to `2d495aca5b233bec0a5334dc4aa3cbdaef6e1bc5`. Its outbound path is
**caller → Vercel Go → Bombardier Go executable → RFI**: neither the Node handler
nor the generic proxy runs on this path. `/gettrain` keeps its existing behavior.

```text
/bombardier?mode=info                         # Executes --version; zero RFI calls
/bombardier?number=3496&c=1                   # One POST, today's Rome query date
/bombardier?number=3496&c=3&client=http1       # Three simultaneous POSTs
/bombardier?number=3496&c=3&client=fasthttp    # Alternative Bombardier client
```

`date=YYYY-MM-DD` overrides the query date. `c` defaults to 1 and accepts 1–20;
each invocation issues exactly `c` requests with `c` workers to the **same train**,
not to `c` different trains. There is no duration loop, automatic polling or
request to another proxy. The only target is the fixed SalaBlu+ detail POST;
arbitrary URLs, CLI flags and incoming credentials/headers are not accepted.
HEAD returns 405 without running a process. OPTIONS makes no upstream request.

The body is the same `trainNumber`/`timeGMT`/`timeUTC` shape used by `/gettrain`.
Both engines use HTTP/1.1 here. `keepalive=0` (default) sends `Connection: close`,
matching the current Node collector; `keepalive=1` permits reuse, but a single
wave with one request per worker does **not** establish warm-connection savings.
Bombardier uses its own HTTP serialization/default headers; this is not an
assertion of byte-identical requests across clients.

TLS certificate/hostname verification remains enabled. The missing public RFI
intermediate is supplied through Go's Linux `SSL_CERT_FILE`; normal system CA
directories remain available. Outbound proxy environment variables are removed.
No caller identity, cookies, tokens or auth are forwarded. Only Vercel contacts
RFI. Request timeout is 24 s; the executable has a 26 s absolute deadline and
is killed if the caller disconnects. Each run uses private temporary files,
cleans them, bounds captured output and prints no per-request server logs.

The response includes `runtime: "go"`, engine/revision, `summary` with HTTP
status categories, transport errors and **milliseconds** for latency, plus the
original Bombardier JSON under `result` (whose raw latency unit is microseconds).
HTTP 200 means the benchmark ran: inspect `summary.http2xx`, `http5xx`,
`transportErrors` and `result.result.errors`. Bombardier **discards bodies**;
HTTP success does not verify train identity, realtime correctness or freshness.
This endpoint measures repeated requests for one train, not national collection.

Rebuild the bundled, checksum-verified Linux amd64/arm64 executables with
`python3 scripts/build_bombardier.py` (requires Git, Go and network access to
GitHub/Go dependencies). This also builds `.vercel/bombardier-local` for local
integration tests. Source revision, toolchain, hashes and upstream MIT license
are in `benchmark/assets/`. The benchmark Go module is standard-library only.
Run `go -C benchmark test -count=1 ./...` after rebuilding to exercise the **real executable**
against loopback HTTP/TLS fixtures, without contacting RFI.
The function module lives in `api/go.mod` and imports `../benchmark` through a
local module replacement. Its module root is below the project's `node_modules`,
so Vercel's generated Go bridge cannot scan Go files shipped by npm packages.

`GET /rfi-protocol` performs one verified TLS handshake from Vercel to the fixed
SalaBlu+ host on port 8443, offering ALPN `h2` and `http/1.1`. It returns the
negotiated protocol (null if none), with an eight-second deadline, and closes
without sending an HTTP/train request. The caller cannot change the destination.
This measures the **Vercel → RFI** leg; HTTP/2 on the caller → Vercel leg is
independent. Both existing train transports (`request` and native `https.request`)
use HTTP/1.1 and are unaffected by this diagnostic.

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

### Results as they arrive: SSE

```sh
curl -N 'https://cors.giaflix.net/gettrain?stream=1&limit=10'
```

Use `stream=1` or `Accept: text/event-stream`. Existing `numbers`, `limit` and
`after` filters apply. The default response is still JSON; add `diagnostics=1`
to include the same network measurements in a JSON response. SSE is live-only;
`mode=schedule&stream=1` is rejected without starting lookups.

This is **one finite batch**, not continuous polling. Every selected lookup
still starts concurrently, with no retries or extra proxy hop. SSE delivers
completed rows early; it does not make RFI respond faster.

| Event | Payload |
| --- | --- |
| `start` | Calendar/run metadata and selected train numbers/service dates, sent before lookups finish. |
| `train` | One compact result or per-train error, `diagnostics`, `completed`, `remaining`; completion order. |
| `progress` | Every 3 seconds: pending trains, current phases and elapsed times. |
| `done` | Final counts, elapsed time and zero remaining; the connection closes. |
| `fatal` | Unexpected stream failure; the connection closes. |

The client should close its `EventSource` on `done`, `fatal` **and connection
error**, rather than automatically repeating a failed batch. Events have IDs;
reconnections carrying `Last-Event-ID` receive HTTP 204 and perform no lookups
because this endpoint does not retain/replay past events. A new connection
without that header starts a new batch. Disconnecting aborts pending upstream
requests. Slow clients exceeding a 1 MiB output buffer are disconnected and
their pending lookups cancelled. Responses disable caching/transformation and
request proxy buffering to be disabled.

```js
const source = new EventSource('https://cors.giaflix.net/gettrain?stream=1&limit=10');
source.addEventListener('train', event => {
  const train = JSON.parse(event.data);
  console.log(train.number, train.error || train.last, train.diagnostics);
});
source.addEventListener('progress', event => console.log('Pending:', JSON.parse(event.data).pending));
source.addEventListener('done', event => { console.log(JSON.parse(event.data)); source.close(); });
source.addEventListener('fatal', event => { console.error(event.data); source.close(); });
source.onerror = () => source.close();
```

`diagnostics.phase` identifies the observed wait: `socket`, `dns`, `tcp`, `tls`,
`request_send`, `response_headers`, `response_body`, or `complete`. An injected
lookup without transport observations reports `unknown` instead of inventing
network timings. `elapsedMs`/`phaseElapsedMs` are monotonic elapsed times.
`milestonesMs` are offsets from that lookup's start; `durationsMs` are differences
between observed milestones, with unobserved/incomplete phases **null**. DNS is
null for a direct IP connection, not assumed zero. `bytesReceived`, optional
`upstreamStatus`, native `causeCode` and `timeoutKind` help distinguish failures.
`outcome` describes the transport/JSON exchange; a valid exchange can still
produce a compact-result error such as `TRAIN_NOT_FOUND` or `SERVICE_DATE_MISMATCH`.

For small controlled client comparisons, `transport=native` uses Node's native
HTTPS client in place of the default `request` library. Endpoint, POST body,
outbound headers, CA verification, connection-close policy and 24-second deadline
remain the same. The default remains `transport=request`; this option is an
experimental diagnostic, not a measured performance improvement. Neither client
retries or routes its requests through a second proxy. `request` explicitly
disables environment-proxy discovery; native uses the configured direct HTTPS
agent. Native also matches request's lowercase `host` wire-header spelling for
controlled comparisons. Diagnostic runtime data reports only whether proxy
environment variables are present (never their values), separately from the
client's disabled outbound-proxy setting.

Diagnostic JSON responses and SSE `done` events include
`runtime.eventLoopDelayMs`: a 20 ms resolution histogram with sample count, max
and p99. These are observed event-loop intervals, including the nominal sampling
resolution; null means no sample. This can expose long Node scheduling stalls
while awaiting responses, but it is not a server-side RFI measurement or an OS
packet trace. HTTP timings and this histogram can narrow possible causes, not
prove which internal RFI component was slow.

A timeout while `response_headers` means the client sent the request but did
not observe HTTP response headers before the deadline. It does **not** locate
the delay inside RFI's gateway/database/backend. `response_body` means headers
arrived and the exchange did not complete. `tls` includes certificate validation.
Request `finish` means data was handed to the operating system, not proof that
RFI processed it. No upstream credentials, full headers, caller IPs or stack
traces are included. Diagnostics do not follow redirects, so a redirect is an
`UPSTREAM_HTTP` result rather than an unmeasured second exchange.

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
