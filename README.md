# Vercel CORS Proxy

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
