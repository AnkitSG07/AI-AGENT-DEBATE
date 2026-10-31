// A best-effort health heartbeat, not an uptime guarantee. A stopped process
// cannot run its own timer; Render Free restarts and usage limits still apply.
export const KEEP_ALIVE_INTERVAL_MS = 5000;
export const KEEP_ALIVE_TIMEOUT_MS = 4000;
const MAX_HEALTH_BYTES = 8192;
const TIMEOUT = Symbol('heartbeat timeout');
const TOO_LARGE = Symbol('health response too large');
const STOPPED = Symbol('heartbeat stopped');

function healthUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
        url.port || url.search || url.hash || url.pathname !== '/') return '';
    return `${url.origin}/health`;
  } catch { return ''; }
}

export function readKeepAliveTarget(env = process.env) {
  const own = healthUrl(env.RENDER_EXTERNAL_URL);
  if (own) return { url: own, source: 'render' };
  const fallback = healthUrl(env.APP_URL);
  return { url: fallback, source: fallback ? 'app' : 'none' };
}

async function drainHealth(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      bytes += value.byteLength;
      if (bytes > MAX_HEALTH_BYTES) { await reader.cancel(); throw TOO_LARGE; }
    }
  } finally { reader.releaseLock(); }
}

export function createOperatorKeepAlive({
  env = process.env, fetchImpl = fetch, logger = console, clock = Date.now,
  intervalMs = KEEP_ALIVE_INTERVAL_MS, timeoutMs = KEEP_ALIVE_TIMEOUT_MS,
  reportIntervalMs = 60000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= intervalMs ||
      !Number.isInteger(reportIntervalMs) || reportIntervalMs < intervalMs || reportIntervalMs > 3600000)
    throw TypeError('Invalid heartbeat timing');
  const target = readKeepAliveTarget(env);
  const configured = !!target.url && typeof fetchImpl === 'function';
  const counts = { attempts: 0, succeeded: 0, failed: 0, skipped: 0 };
  let timer, started = false, closed = false, inFlight = null;
  let lastOutcome = 'idle', lastStatus = 0, lastReportAt, lastReportedOutcome;
  const now = () => { try { const value = clock(); return Number.isFinite(value) ? value : 0; } catch { return 0; } };
  function report(outcome, force = false) {
    const at = now();
    if (!force && outcome === lastReportedOutcome && lastReportAt !== undefined &&
        at >= lastReportAt && at - lastReportAt < reportIntervalMs) return;
    lastReportAt = at; lastReportedOutcome = outcome;
    // Fixed labels/counts only: never log the target, credentials, response body
    // or arbitrary fetch/SDK exceptions. Repeated success logs at most once/min.
    try { logger.info?.('SH_KEEP_ALIVE', JSON.stringify({ configured, source: target.source,
      intervalMs, timeoutMs, outcome, status: lastStatus, ...counts })); } catch { /* diagnostics only */ }
  }
  const status = () => ({ configured, running: configured && started && !closed, inFlight: !!inFlight,
    source: target.source, intervalMs, timeoutMs, outcome: lastOutcome, status: lastStatus, ...counts });
  function ping() {
    if (!configured || !started || closed) return Promise.resolve(false);
    if (inFlight) { counts.skipped++; report(lastOutcome); return inFlight.result; }
    const attempt = { controller: new AbortController(), result: null };
    inFlight = attempt; counts.attempts++;
    // The underlying operation retains its single-flight slot even if an
    // injected/nonconforming fetch ignores abort. Deadlines never stack calls.
    const request = Promise.resolve().then(async () => {
      if (closed) throw STOPPED;
      const response = await fetchImpl(target.url, { method: 'GET', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: attempt.controller.signal });
      await drainHealth(response);
      return { ok: response.ok === true, status: Number.isInteger(response.status) &&
        response.status >= 100 && response.status <= 599 ? response.status : 0 };
    });
    request.finally(() => { if (inFlight === attempt) inFlight = null; }).catch(() => {});
    attempt.result = (async () => {
      let deadline, timedOut = false;
      try {
        const response = await Promise.race([request, new Promise((_, reject) => {
          deadline = setTimeout(() => { timedOut = true; attempt.controller.abort(); reject(TIMEOUT); }, timeoutMs);
          deadline.unref?.();
        })]);
        if (closed) return false;
        lastStatus = response.status; lastOutcome = response.ok ? 'ok' : 'http_error';
        if (response.ok) counts.succeeded++; else counts.failed++;
        report(lastOutcome); return response.ok;
      } catch (error) {
        if (closed || error === STOPPED) return false;
        counts.failed++; lastStatus = 0;
        lastOutcome = timedOut || error === TIMEOUT ? 'timeout' : error === TOO_LARGE ? 'response_too_large' : 'request_failed';
        report(lastOutcome); return false;
      } finally { clearTimeout(deadline); }
    })();
    return attempt.result;
  }
  function start() {
    if (started || closed) return;
    started = true;
    report(configured ? 'configured' : 'disabled', true);
    if (!configured) return;
    // First request is scheduled after listen(), and never blocks startup/calls.
    timer = setIntervalImpl(() => { void ping(); }, intervalMs);
    timer.unref?.();
  }
  function close() {
    if (closed) return;
    closed = true; started = false;
    if (timer !== undefined) clearIntervalImpl(timer);
    timer = undefined; inFlight?.controller.abort();
  }
  return Object.freeze({ start, ping, close, status });
}
