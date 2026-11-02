// Discovery only. Exact call/webhook wakes still dispatch work immediately.
// No call state, credential, ownership or provider result is cached here.
export function createRecoveryCadence({ now = Date.now } = {}) {
  let nextAt = 0, generation = 0, failures = 0;
  return {
    begin() { return now() < nextAt ? null : { generation }; },
    wake() { generation++; failures = 0; nextAt = 0; },
    finish(ticket, { count = 0, failed = false } = {}) {
      // A new committed action while discovery was in flight wins over idle
      // or error backoff calculated from an older scan.
      if (ticket.generation !== generation) return;
      failures = failed ? failures + 1 : 0;
      const delay = failed ? Math.min(300000, 15000 * 2 ** Math.min(failures, 5)) : count ? 15000 : 60000;
      nextAt = now() + delay;
    }
  };
}
