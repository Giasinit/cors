import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { rootCertificates } from 'node:tls';
import express from 'express';
import cors from 'cors';
import request from 'request';

// The server omits its public intermediate. Complete the chain without disabling TLS checks.
const salaBluAuthorities = [
  ...rootCertificates,
  readFileSync(new URL('../certificates/digicert-global-g2-tls-rsa-sha256-2020-ca1.pem', import.meta.url), 'utf8'),
];
const hopByHop = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardedHeaders(headers) {
  const excluded = new Set(hopByHop);
  for (const name of (headers.connection || '').split(',')) {
    excluded.add(name.trim().toLowerCase());
  }
  excluded.add('host');
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    !excluded.has(name.toLowerCase()) && !name.toLowerCase().startsWith('access-control-')));
}

function parseTarget(req) {
  // Preserve raw ?url=https://...?...&... and encodeURIComponent(url).
  const value = req.url.match(/[?&]url=(.*)$/)?.[1];
  if (!value) throw new Error('Il parametro url non è stato specificato');
  const target = new URL(/^https?%3a/i.test(value) ? decodeURIComponent(value) : value);
  if (!['https:', 'http:'].includes(target.protocol)) {
    throw new Error('Il parametro url deve usare HTTP o HTTPS');
  }
  return target;
}

export function createApp({ upstreamTimeoutMs = 25_000 } = {}) {
  const app = express();
  app.use(cors({ exposedHeaders: ['X-Proxy-Upstream-Ms'] }));
  app.set('json spaces', 2);

  app.all('/*', (req, res) => {
    let target;
    try {
      target = parseTarget(req);
    } catch (error) {
      return res.status(400).json({ title: 'CORS Proxy Error', detail: error.message });
    }

    const headers = forwardedHeaders(req.headers);
    // Vercel may already have consumed the stream and parsed req.body.
    let body;
    if (req.body !== undefined) {
      if (Buffer.isBuffer(req.body)) body = req.body;
      else if (typeof req.body === 'string') body = Buffer.from(req.body);
      else if (headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
        body = Buffer.from(new URLSearchParams(req.body).toString());
      } else body = Buffer.from(JSON.stringify(req.body));
      headers['content-length'] = String(body.length);
    }

    const started = performance.now();
    res.setHeader('Cache-Control', 'no-store');
    const upstream = request({
      url: target.href,
      method: req.method,
      headers,
      timeout: upstreamTimeoutMs,
      strictSSL: true,
      ...(target.protocol === 'https:' && target.hostname === 'salabluplus.rfi.it'
        ? { agentOptions: { ca: salaBluAuthorities } } : {}),
    });

    const fail = (error) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Encoding');
      res.status(error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT' ? 504 : 502)
        .json({ title: 'CORS Proxy Error', code: error.code || 'UPSTREAM_ERROR', detail: error.message });
    };
    upstream.on('error', fail);
    const deadline = setTimeout(() => {
      fail(Object.assign(new Error('Timeout del server di destinazione'), { code: 'ETIMEDOUT' }));
      upstream.abort();
    }, upstreamTimeoutMs);
    res.on('close', () => {
      clearTimeout(deadline);
      if (!res.writableFinished) upstream.abort();
    });
    req.on('aborted', () => upstream.abort());

    upstream.on('response', (response) => {
      res.status(response.statusCode);
      for (const [name, value] of Object.entries(forwardedHeaders(response.headers))) {
        if (value !== undefined && name.toLowerCase() !== 'cache-control') res.setHeader(name, value);
      }
      res.setHeader('X-Proxy-Upstream-Ms', (performance.now() - started).toFixed(1));
      response.on('error', fail);
      response.pipe(res);
    });

    if (body !== undefined) upstream.end(body);
    else {
      // Prevent request from automatically copying the incoming Host and hop-by-hop headers.
      req.pipe(new PassThrough()).pipe(upstream);
    }
  });
  return app;
}

export default createApp();
