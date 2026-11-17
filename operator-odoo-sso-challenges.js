import { createHash, randomBytes } from 'node:crypto';

export const ODOO_OPERATOR_CHALLENGE_TTL_MS = 45000;
const challengePattern = /^[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (status, code, message) => Object.assign(new Error(message), { status, code, operatorAuthError: true });

// Per-process, fail-closed nonces. A restart invalidates outstanding challenges;
// there is no timer, durable write, raw credential logging or reusable proof.
export function createOdooOperatorChallenges({ allowedOrigins, clock = Date.now,
  maxChallenges = 1000, maxRateKeys = 1000, limitPerMinute = 20 } = {}) {
  const origins = new Set(allowedOrigins || []), challenges = new Map(), rates = new Map();
  function allowed(origin) {
    if (!origins.has(origin)) throw failure(403, 'ODOO_ORIGIN_REQUIRED', 'Open this action from the authorized Odoo Hub.');
  }
  function sweep(now) {
    for (const [key, row] of challenges) if (row.expiresAt <= now) challenges.delete(key);
    for (const [key, row] of rates) if (row.until <= now) rates.delete(key);
  }
  function rate(origin, ip, phase, now) {
    const key = digest(`${phase}:${origin}:${String(ip || 'unknown').slice(0, 160)}`);
    const prior = rates.get(key);
    if ((!prior && rates.size >= maxRateKeys) || (prior && prior.count >= limitPerMinute))
      throw failure(429, 'ODOO_AUTH_RATE_LIMITED', 'Please wait before reconnecting operator services.');
    const row = prior || { count: 0, until: now + 60000 };
    row.count++; rates.set(key, row);
  }
  function issue({ origin, ip }) {
    allowed(origin);
    const now = clock(); sweep(now); rate(origin, ip, 'issue', now);
    if (challenges.size >= maxChallenges)
      throw failure(429, 'ODOO_AUTH_RATE_LIMITED', 'Please wait before reconnecting operator services.');
    const challenge = randomBytes(32).toString('base64url');
    const row = { origin, issuedAt: now, expiresAt: now + ODOO_OPERATOR_CHALLENGE_TTL_MS };
    challenges.set(digest(challenge), row);
    return { challenge, issuedAt: row.issuedAt, expiresAt: row.expiresAt };
  }
  function consume({ origin, ip, challenge }) {
    allowed(origin);
    if (typeof challenge !== 'string' || !challengePattern.test(challenge))
      throw failure(400, 'INVALID_ODOO_AUTH_REQUEST', 'The Odoo sign-in request is invalid.');
    const now = clock(); sweep(now); rate(origin, ip, 'consume', now);
    const key = digest(challenge), row = challenges.get(key);
    if (!row || row.origin !== origin || row.issuedAt > now || row.expiresAt <= now)
      throw failure(401, 'ODOO_PROOF_CHALLENGE_INVALID', 'The Odoo sign-in challenge expired or was already used.');
    // This synchronous deletion precedes any asynchronous authoritative lookup.
    challenges.delete(key);
    return Object.freeze({ digest: key, issuedAt: row.issuedAt, expiresAt: row.expiresAt });
  }
  return Object.freeze({ issue, consume });
}
