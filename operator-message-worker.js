// Notification discovery is independent of AI/history work. Idle scans touch
// Odoo only. Exact message receipts/backoff remain in the push bridge.
export function createMessageNotificationWorker({ scan, hydrate, publish, now = Date.now,
  intervalMs = 1000, maxConcurrent = 4, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  onError = () => {} }) {
  const recent = new Map(), inFlight = new Set();
  let scanning = null, timer = null, started = false, stopped = false, dirty = false, failures = 0;
  function schedule(delay) {
    if (!started || stopped) return;
    if (timer) clearTimeoutImpl(timer);
    timer = setTimeoutImpl(() => { timer = null; void tick(); }, delay); timer?.unref?.();
  }
  function tick() {
    if (stopped) return Promise.resolve();
    if (scanning) { dirty = true; return scanning; }
    scanning = (async () => {
      try {
        const at = now();
        for (const [id, state] of recent) if (state.expiresAt <= at) recent.delete(id);
        const rows = await scan();
        const selected = rows.filter(row => !inFlight.has(row.id) && (recent.get(row.id)?.nextAt || 0) <= now())
          .slice(0, Math.max(0, maxConcurrent - inFlight.size));
        const hydrated = selected.length ? await hydrate(selected) : [];
        for (const row of hydrated) {
          if (inFlight.has(row.id) || inFlight.size >= maxConcurrent) continue;
          inFlight.add(row.id);
          const prior = recent.get(row.id);
          void Promise.resolve().then(() => publish(row)).then(result => {
            const expiresAt = now() + 300000;
            const nextAt = result?.ok ? expiresAt : Math.max(now() + 1000, result?.retryAtMs || now() + 5000);
            recent.set(row.id, { nextAt, expiresAt, failures: 0 });
          }).catch(() => {
            const attempts = (prior?.failures || 0) + 1;
            recent.set(row.id, { nextAt: now() + Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)),
              expiresAt: now() + 300000, failures: attempts });
            onError();
          }).finally(() => {
            inFlight.delete(row.id);
            while (recent.size > 1000) recent.delete(recent.keys().next().value);
          });
        }
        failures = 0;
      } catch { failures++; onError(); }
      finally {
        scanning = null;
        const delay = dirty ? 0 : failures ? Math.min(30000, intervalMs * 2 ** Math.min(failures, 5)) : intervalMs;
        dirty = false; schedule(delay);
      }
    })();
    return scanning;
  }
  return {
    tick,
    start() { if (started) return; started = true; void tick(); },
    wake() { if (scanning) dirty = true; else schedule(0); },
    close() { stopped = true; if (timer) clearTimeoutImpl(timer); timer = null; }
  };
}
