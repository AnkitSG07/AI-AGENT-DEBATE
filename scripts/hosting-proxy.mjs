// Standalone compatibility edge. Deliberately imports no application, database,
// provider, notification or background-worker runtime.
import { createServer } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const HOP_MARKER = 'x-sh-hosting-proxy-hop';
const RENDER_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onrender\.com$/;

function limit(value, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw Error('Invalid hosting proxy timeout');
  return value;
}

export function readHostingProxyConfig(env = process.env) {
  let upstream, publicUrl;
  try {
    upstream = new URL(env.SH_HOSTING_PROXY_UPSTREAM || '');
    publicUrl = new URL(env.APP_URL || '');
  } catch { throw Error('Invalid hosting proxy configuration'); }
  if (upstream.protocol !== 'https:' || !RENDER_HOST.test(upstream.hostname) || upstream.port ||
      upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash ||
      publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.port ||
      publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash)
    throw Error('Invalid hosting proxy configuration');
  const externalHost = String(env.RENDER_EXTERNAL_HOSTNAME || '').trim().toLowerCase().replace(/\.$/, '');
  if (upstream.hostname === publicUrl.hostname.replace(/\.$/, '') || externalHost && upstream.hostname === externalHost)
    throw Error('Hosting proxy upstream cannot be this service');
  return Object.freeze({ hostname: upstream.hostname, origin: upstream.origin });
}

function endToEndHeaders(source) {
  const blocked = new Set(HOP_HEADERS);
  for (const token of String(source.connection || '').split(',')) {
    const name = token.trim().toLowerCase();
    if (name) blocked.add(name);
  }
  const headers = {};
  for (const [name, value] of Object.entries(source))
    if (!blocked.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  return headers;
}

export function createHostingProxy({ env = process.env, requestFactory = httpsRequest,
  connectTimeoutMs = 5000, responseTimeoutMs = 30000, streamIdleTimeoutMs = 120000 } = {}) {
  const config = readHostingProxyConfig(env);
  limit(connectTimeoutMs, 30000); limit(responseTimeoutMs, 120000); limit(streamIdleTimeoutMs, 300000);
  const agent = new Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16 });
  const active = new Set();
  let closing = false, listening, closeWork;
  const server = createServer((req, res) => {
    const errorResponse = status => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: status === 504 ? 'Upstream request timed out.' :
        status === 508 ? 'Proxy loop refused.' : status === 400 ? 'Invalid request target.' : 'Upstream service unavailable.' }));
    };
    // The request target is passed as a path, never resolved against the fixed
    // upstream as a URL. Absolute-form targets cannot select another host.
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || /[\u0000-\u0020\u007f#]/.test(req.url)) {
      req.resume(); errorResponse(400); return;
    }
    if (req.headers[HOP_MARKER] !== undefined) { req.resume(); errorResponse(508); return; }
    if (closing) { req.resume(); errorResponse(503); return; }
    const headers = endToEndHeaders(req.headers);
    headers.host = config.hostname;
    headers[HOP_MARKER] = '1';
    let upstream, response, connectTimer, responseTimer, settled = false;
    const clearTimers = () => { clearTimeout(connectTimer); clearTimeout(responseTimer); };
    const finish = () => {
      if (settled) return;
      settled = true; clearTimers(); active.delete(cancel);
    };
    const cancel = () => {
      finish();
      if (upstream) req.unpipe(upstream);
      if (!req.destroyed) req.resume();
      response?.destroy(); upstream?.destroy();
    };
    const fail = status => { if (!settled) { cancel(); errorResponse(status); } };
    active.add(cancel);
    try {
      // Node's request API performs one attempt. There is no redirect handler or
      // retry path: a mutation may have committed before a connection failure.
      upstream = requestFactory({ protocol: 'https:', hostname: config.hostname, port: 443,
        method: req.method, path: req.url, headers, agent }, incoming => {
        if (settled || res.destroyed) { incoming.destroy(); return; }
        response = incoming; clearTimers();
        response.setTimeout(streamIdleTimeoutMs, () => fail(504));
        response.once('error', () => fail(502));
        response.once('aborted', () => fail(502));
        response.once('end', finish);
        try { res.writeHead(response.statusCode || 502, endToEndHeaders(response.headers)); }
        catch { fail(502); return; }
        // Flush status and headers promptly for SSE; pipe preserves streaming
        // backpressure and the exact bytes without buffering or decompression.
        res.flushHeaders();
        response.pipe(res);
      });
      upstream.once('error', () => fail(502));
      upstream.once('socket', socket => {
        if (!socket.connecting) clearTimeout(connectTimer);
        else socket.once('secureConnect', () => clearTimeout(connectTimer));
      });
      connectTimer = setTimeout(() => fail(504), connectTimeoutMs);
      responseTimer = setTimeout(() => fail(504), responseTimeoutMs);
      req.once('aborted', cancel);
      req.once('error', cancel);
      res.once('error', cancel);
      res.once('close', () => { if (!res.writableFinished) cancel(); });
      req.pipe(upstream);
    } catch { fail(502); }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n'); socket.destroySoon();
  });
  server.on('connect', (_req, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'); socket.destroySoon();
  });
  const start = ({ port = Number(env.PORT || 10000), host = '0.0.0.0' } = {}) => {
    if (closing) return Promise.reject(Error('Hosting proxy is closed'));
    if (listening) return listening;
    if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(Error('Invalid hosting proxy port'));
    listening = new Promise((resolveListen, rejectListen) => {
      const failed = () => rejectListen(Error('Hosting proxy listener unavailable'));
      server.once('error', failed);
      server.listen(port, host, () => { server.removeListener('error', failed); resolveListen(server.address()); });
    });
    return listening;
  };
  const close = () => {
    if (closeWork) return closeWork;
    closing = true;
    closeWork = new Promise(resolveClose => {
      for (const cancel of active) cancel();
      agent.destroy();
      server.close(() => resolveClose());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
    return closeWork;
  };
  return Object.freeze({ server, start, close });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let proxy;
  try { proxy = createHostingProxy(); }
  catch { console.error('SH_HOSTING_PROXY_CONFIGURATION_FAILED'); process.exitCode = 1; }
  if (proxy) {
    const shutdown = () => { void proxy.close().finally(() => process.exit(process.exitCode || 0)); };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    proxy.start().then(() => console.log('SH_HOSTING_PROXY_READY')).catch(() => {
      console.error('SH_HOSTING_PROXY_START_FAILED'); process.exitCode = 1; shutdown();
    });
  }
}
