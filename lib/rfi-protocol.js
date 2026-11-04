import { connect } from 'node:tls';
import { salaBluAuthorities } from './salablu-tls.js';

// TLS negotiation only: no train query and no caller-controlled destination.
export function probeRfiProtocol({
  host = 'salabluplus.rfi.it', port = 8443, servername = host,
  ca = salaBluAuthorities, timeoutMs = 8_000,
} = {}) {
  const started = performance.now();
  const offered = ['h2', 'http/1.1'];
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host, port, servername, ca,
      rejectUnauthorized: true, ALPNProtocols: offered });
    const deadline = setTimeout(() => finish(Object.assign(
      new Error('TLS negotiation timed out'), { code: 'TLS_TIMEOUT' })), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      const result = {
        target: `${host}:${port}`, offered,
        negotiated: socket.alpnProtocol || null,
        certificateVerified: socket.authorized,
        tlsVersion: socket.getProtocol(),
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      };
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.once('error', finish);
    socket.once('secureConnect', () => finish());
  });
}

export async function rfiProtocolHandler(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ checkedAt: new Date().toISOString(),
      leg: 'Vercel to SalaBlu+', ...await probeRfiProtocol() });
  } catch (error) {
    res.status(502).json({ error: error.code || 'TLS_ERROR' });
  }
}
