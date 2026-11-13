import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ANDROID_ACCESS_CHALLENGE_TTL_MS = 60000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const sha = value => createHash('sha256').update(value).digest();
const fail = (status, code, message) => Object.assign(new Error(message), { status, code, operatorAuthError: true });

// The native bridge sees only a public nonce. The private verifier remains in
// the requesting Hub page and can never appear in a history URL or response.
export function createAndroidAccessChallenges({ clock = Date.now, maxChallenges = 2000,
  maxRateKeys = 4096, maxPerMinute = 120 } = {}) {
  const challenges = new Map(), rates = new Map();
  function sweep(now) {
    for (const [key, row] of challenges) if (row.expiresAt <= now) challenges.delete(key);
    for (const [key, row] of rates) if (row.until <= now) rates.delete(key);
  }
  function limit(ip, phase, now) {
    const key = sha(`${phase}:${String(ip || 'unknown').slice(0, 160)}`).toString('hex');
    const prior = rates.get(key);
    if ((!prior && rates.size >= maxRateKeys) || (prior && prior.count >= maxPerMinute))
      throw fail(429, 'ANDROID_AUTH_RATE_LIMITED', 'Please wait before reconnecting this device.');
    const row = prior || { count: 0, until: now + 60000 };
    row.count++; rates.set(key, row);
  }
  function find(challenge) {
    if (typeof challenge !== 'string' || !TOKEN.test(challenge))
      throw fail(400, 'INVALID_ANDROID_AUTH_REQUEST', 'The device sign-in request is invalid.');
    const key = sha(challenge).toString('hex'), row = challenges.get(key);
    if (!row || row.expiresAt <= clock()) {
      challenges.delete(key);
      throw fail(410, 'ANDROID_CHALLENGE_EXPIRED', 'This device sign-in request expired. Please try again.');
    }
    return { key, row };
  }
  function issue({ origin, ip }) {
    const now = clock(); sweep(now); limit(ip, 'issue', now);
    if (challenges.size >= maxChallenges)
      throw fail(429, 'ANDROID_AUTH_RATE_LIMITED', 'Please wait before reconnecting this device.');
    const challenge = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const expiresAt = now + ANDROID_ACCESS_CHALLENGE_TTL_MS;
    challenges.set(sha(challenge).toString('hex'), { origin, verifierHash: sha(verifier), expiresAt, proof: null });
    return { challenge, verifier, expiresAt };
  }
  function inspectMarker({ challenge, ip }) {
    const now = clock(); sweep(now); limit(ip, 'marker', now); find(challenge);
  }
  function acknowledge({ challenge, deviceId, credentialGeneration }) {
    const { row } = find(challenge);
    if (row.proof && (row.proof.deviceId !== deviceId || row.proof.credentialGeneration !== credentialGeneration))
      throw fail(409, 'ANDROID_CHALLENGE_CONFLICT', 'This sign-in request belongs to another device.');
    row.proof = Object.freeze({ deviceId, credentialGeneration });
  }
  function consume({ origin, ip, challenge, verifier }) {
    const now = clock(); sweep(now); limit(ip, 'consume', now);
    if (typeof verifier !== 'string' || !TOKEN.test(verifier))
      throw fail(400, 'INVALID_ANDROID_AUTH_REQUEST', 'The device sign-in request is invalid.');
    const { key, row } = find(challenge);
    if (row.origin !== origin || !timingSafeEqual(row.verifierHash, sha(verifier)))
      throw fail(403, 'ANDROID_CHALLENGE_INVALID', 'The device sign-in request could not be verified.');
    if (!row.proof) throw fail(409, 'ANDROID_CHALLENGE_PENDING', 'The enrolled device has not confirmed this sign-in request yet.');
    // Consume before any asynchronous registry lookup or signing can occur.
    challenges.delete(key);
    return Object.freeze({ ...row.proof, expiresAt: row.expiresAt });
  }
  return Object.freeze({ issue, inspectMarker, acknowledge, consume });
}
