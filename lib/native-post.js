import https from 'node:https';
import { EventEmitter } from 'node:events';

// Minimal alternative transport for controlled A/B diagnostics. No request-library
// internals, pooling policy changes, redirects, retries, proxy hop or caller headers.
export function nativePost(options, callback) {
  const events = new EventEmitter();
  let outgoing, aborted = false, settled = false;
  const finish = (error, response, text) => {
    if (settled) return;
    settled = true;
    callback(error, response, text);
  };
  events.abort = () => { aborted = true; outgoing?.destroy(); };
  // Match request.post's asynchronous socket creation so observers can attach
  // before any connection is established.
  queueMicrotask(() => {
    if (aborted) return;
    try {
      outgoing = https.request(options.url, {
        method: 'POST', agent: options.agent,
        // Match request's actual HTTP/1.1 Host spelling/order for wire-equivalent
        // A/B probes, rather than letting Node generate a capitalized Host field.
        headers: { ...options.headers, host: new URL(options.url).host },
        rejectUnauthorized: true,
      }, response => {
        events.emit('response', response);
        const chunks = [];
        response.on('data', chunk => {
          events.emit('data', chunk);
          if (!aborted) chunks.push(chunk);
        });
        response.once('error', error => finish(error));
        response.once('end', () => finish(null, response, Buffer.concat(chunks).toString('utf8')));
      });
      outgoing.once('error', error => finish(error));
      outgoing.setTimeout(options.timeout, () => {
        const error = Object.assign(new Error('Socket inactivity timeout'), { code: 'ESOCKETTIMEDOUT' });
        finish(error); outgoing.destroy();
      });
      events.emit('request', outgoing);
      outgoing.end(options.body);
    } catch (error) { finish(error); }
  });
  return events;
}
