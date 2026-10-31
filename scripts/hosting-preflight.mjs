// An isolated, read-only hosting check. This entrypoint deliberately does not
// import the application, call gateway, recovery jobs, or background workers.
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOperatorFirestoreRuntime } from '../operator-firestore-runtime.js';

const stopped = Symbol('stopped');
const deadline = Symbol('deadline');
const silentLogger = Object.freeze({ info() {}, warn() {} });

function boundedInteger(value, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw Error('Invalid preflight limit');
  return value;
}

export function createHostingPreflight({
  env = process.env, logger = console, runtimeFactory = createOperatorFirestoreRuntime,
  clock = () => performance.now(), sampleCount = 3, operationTimeoutMs = 7000, shutdownTimeoutMs = 5000
} = {}) {
  boundedInteger(sampleCount, 5);
  boundedInteger(operationTimeoutMs, 30000);
  boundedInteger(shutdownTimeoutMs, 10000);
  let runtime;
  // The existing factory validates server credentials. Its logger is muted so
  // only the deliberately whitelisted records below reach preflight logs.
  try { runtime = runtimeFactory({ env, logger: silentLogger }); } catch { /* fail closed */ }
  const configured = runtime?.backend === 'firestore' && runtime.configured === true &&
    typeof runtime.deviceRegistry?.checkAvailability === 'function' && typeof runtime.readDatabaseLocation === 'function';
  let healthy = false, closing = false, work, listening, settleListening, closeWork, runtimeCloseWork;
  let stop;
  const stopWork = new Promise(resolveStop => { stop = () => resolveStop(stopped); });
  const status = () => ({ ok: healthy && !closing, configured });
  const report = value => {
    try { logger.info?.('SH_HOSTING_PREFLIGHT', JSON.stringify(value)); } catch { /* diagnostics only */ }
  };
  const elapsed = started => {
    const value = clock() - started;
    return Number.isFinite(value) ? Math.max(0, Math.min(60000, Math.round(value))) : 0;
  };
  async function limited(action, timeoutMs, interruptible = true) {
    let timer;
    try {
      const choices = [Promise.resolve().then(action),
        new Promise(resolveDeadline => { timer = setTimeout(() => resolveDeadline(deadline), timeoutMs); })];
      if (interruptible) choices.push(stopWork);
      const result = await Promise.race(choices);
      if (result === stopped || result === deadline) throw result;
      return result;
    } finally { clearTimeout(timer); }
  }
  function closeRuntime() {
    if (!runtimeCloseWork) runtimeCloseWork = limited(() => runtime?.close?.(), shutdownTimeoutMs, false)
      .catch(() => { report({ event: 'shutdown', ok: false }); });
    return runtimeCloseWork;
  }
  function run() {
    if (work) return work;
    work = (async () => {
      let completed = 0;
      if (!configured || closing) {
        report({ event: 'complete', ok: false, configured, samples: completed });
        return status();
      }
      // A fixed, sequential sample distinguishes connection setup from warm
      // reads. Health requests never create more database operations.
      for (let index = 0; index < sampleCount && !closing; index++) {
        const started = clock(); let ok = false;
        try { ok = await limited(() => runtime.deviceRegistry.checkAvailability(), operationTimeoutMs) === true; }
        catch { /* no SDK/configuration exception can enter logs or responses */ }
        report({ event: 'database_read', sample: index + 1, warm: index > 0, ok, elapsedMs: elapsed(started) });
        if (!ok || closing) {
          // A deadline does not itself cancel a Firestore RPC. Stop sampling
          // and terminate its client rather than stacking further reads.
          await closeRuntime();
          report({ event: 'complete', ok: false, configured, samples: completed });
          return status();
        }
        completed++;
      }
      if (closing) return status();
      const started = clock(); let locationId = '';
      try { locationId = await limited(() => runtime.readDatabaseLocation(), operationTimeoutMs); }
      catch { /* metadata permission/transport failures remain non-secret */ }
      const metadataOk = typeof locationId === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(locationId);
      report({ event: 'database_location', ok: metadataOk, elapsedMs: elapsed(started),
        ...(metadataOk ? { locationId } : {}) });
      healthy = !closing && completed === sampleCount && metadataOk;
      if (!healthy) await closeRuntime();
      report({ event: 'complete', ok: healthy, configured, samples: completed });
      return status();
    })();
    return work;
  }
  const server = createServer((req, res) => {
    const healthRequest = (req.method === 'GET' || req.method === 'HEAD') && req.url === '/health';
    const value = healthRequest ? status() : { ok: false };
    res.statusCode = healthRequest ? (value.ok ? 200 : 503) : 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    req.resume();
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 100;
  server.on('error', () => { healthy = false; report({ event: 'listener', ok: false }); });
  function start({ port = Number(env.PORT || 10000), host = '0.0.0.0' } = {}) {
    if (closing) return Promise.reject(Error('Preflight is closed'));
    if (listening) return listening;
    if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(Error('Invalid preflight port'));
    listening = new Promise((resolveListen, rejectListen) => {
      let settled = false;
      const finish = (error, address = null) => {
        if (settled) return;
        settled = true;
        server.removeListener('error', onError); server.removeListener('close', onClose);
        settleListening = undefined;
        if (error) rejectListen(error); else resolveListen(address);
      };
      const onError = () => finish(Error('Preflight listener unavailable'));
      const onClose = () => finish();
      settleListening = () => finish();
      server.once('error', onError);
      server.once('close', onClose);
      server.listen(port, host, () => {
        if (closing) { server.close(); finish(); return; }
        void run();
        finish(null, server.address());
      });
    });
    return listening;
  }
  function close() {
    if (closeWork) return closeWork;
    closing = true; healthy = false; stop();
    // Node may suppress the listen callback when close races initial binding.
    // Explicitly settle the pending start promise before closing the listener.
    settleListening?.();
    closeWork = (async () => {
      const serverClosed = new Promise(resolveClose => {
        server.close(() => resolveClose());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
      await Promise.all([
        limited(() => serverClosed, shutdownTimeoutMs, false).catch(() => {}),
        closeRuntime()
      ]);
      // Interruptible sampling settles even if an underlying SDK call hangs.
      if (work) await work;
    })();
    return closeWork;
  }
  return Object.freeze({ server, start, run, close, status });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const preflight = createHostingPreflight();
  let exiting = false;
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    await preflight.close();
    // A timed-out third-party RPC must not keep this isolated process alive
    // after its bounded cleanup has finished.
    process.exit(process.exitCode || 0);
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  preflight.start().catch(async () => {
    console.error('SH_HOSTING_PREFLIGHT_START_FAILED');
    process.exitCode = 1;
    await shutdown();
  });
}
