// New call actions always create immediately due work. Only failed cleanup of
// an already terminal call backs off after its first five minutes. Preserve the
// exact job, ownership fence and unconfirmed outcome until an acknowledgement.
export function cleanupRetryDelay(attempts, terminal, now) {
  const stale = Number.isSafeInteger(terminal?.endedAt) && now - terminal.endedAt >= 300000;
  return Math.min(stale ? 3600000 : 30000, 1000 * 2 ** Math.min(Math.max(0, attempts), 12));
}
