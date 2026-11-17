// The user's authenticated Odoo session creates a proof record. Render reads
// the record and its Odoo-managed creator through its own service account.
import { timingSafeEqual } from 'node:crypto';

const PROOF_MODEL = 'x_sh_operator_proof';
const DIGEST = /^[a-f0-9]{64}$/;
export const ODOO_OPERATOR_SCOPES = Object.freeze(['calls:read', 'calls:write', 'mail:read', 'mail:write',
  'contacts:read', 'contacts:write', 'documents:read', 'documents:write', 'ai:draft', 'ai:settings']);
const GRANT_SCOPES = new Set(ODOO_OPERATOR_SCOPES);
const ODOO_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const MAX_GRANT_USERS = 500;
const MAX_CHALLENGE_MS = 120000;
const CLOCK_TOLERANCE_MS = 2000;
const CLEANUP_INTERVAL_MS = 60 * 60000;
const PROOF_RETENTION_MS = 24 * CLEANUP_INTERVAL_MS;
const CLEANUP_LIMIT = 250;
const positiveId = value => Number.isSafeInteger(value) && value > 0;

function readGrants(value) {
  const grants = new Map();
  if (typeof value !== 'string' || !value.trim() || value.length > 100000) return grants;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return grants;
    const entries = Object.entries(parsed);
    if (entries.length > MAX_GRANT_USERS) return grants;
    for (const [id, scopes] of entries) {
      if (!positiveId(Number(id)) || String(Number(id)) !== id || !Array.isArray(scopes) ||
          scopes.length < 1 || scopes.length > GRANT_SCOPES.size ||
          new Set(scopes).size !== scopes.length || !scopes.every(scope => GRANT_SCOPES.has(scope))) return new Map();
      grants.set(Number(id), Object.freeze([...scopes]));
    }
  } catch { return new Map(); }
  return grants;
}

function parseOdooDate(value) {
  if (typeof value !== 'string' || !ODOO_DATETIME.test(value)) return NaN;
  const iso = value.replace(' ', 'T') + '.000Z';
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? time : NaN;
}

function matchesDigest(actual, expected) {
  return typeof actual === 'string' && DIGEST.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function createOdooOperatorProofVerifier({ grantsJson, execute, companyId, clock = Date.now } = {}) {
  const grants = readGrants(grantsJson);
  const hasCompanyPin = companyId !== undefined && companyId !== null && companyId !== '';
  const company = typeof companyId === 'string' && /^[1-9][0-9]*$/.test(companyId) ? Number(companyId) : companyId;
  const configured = grants.size > 0 && typeof execute === 'function' && (!hasCompanyPin || positiveId(company));
  let cleanupAfter = 0;
  let cleanupRunning = false;

  function scheduleProofCleanup() {
    const now = clock();
    if (cleanupRunning || now < cleanupAfter) return;
    cleanupAfter = now + CLEANUP_INTERVAL_MS;
    cleanupRunning = true;
    setImmediate(async () => {
      try {
        const cutoff = new Date(now - PROOF_RETENTION_MS).toISOString().slice(0, 19).replace('T', ' ');
        const rows = await execute(PROOF_MODEL, 'search_read', [[['create_date', '<', cutoff]]], {
          fields: ['id'], limit: CLEANUP_LIMIT, order: 'create_date asc, id asc'
        });
        if (!Array.isArray(rows) || rows.length > CLEANUP_LIMIT) return;
        const ids = [...new Set(rows.map(row => row?.id).filter(positiveId))];
        if (ids.length) await execute(PROOF_MODEL, 'unlink', [ids], {});
      } catch { /* Optional maintenance must not affect sign-in or expose Odoo errors. */ }
      finally { cleanupRunning = false; }
    }).unref();
  }

  async function verifyOdooOperatorProof({ proofId, digest, issuedAt, expiresAt } = {}) {
    if (!configured || !positiveId(proofId) || typeof digest !== 'string' || !DIGEST.test(digest) ||
        !positiveId(issuedAt) || !positiveId(expiresAt) || expiresAt <= issuedAt ||
        expiresAt - issuedAt > MAX_CHALLENGE_MS || clock() >= expiresAt) return null;

    try {
      const proofRows = await execute(PROOF_MODEL, 'search_read', [[['id', '=', proofId]]], {
        fields: ['id', 'x_name', 'create_uid', 'create_date'], limit: 1
      });
      if (!Array.isArray(proofRows)) throw new Error();
      if (proofRows.length !== 1) return null;
      const proof = proofRows[0];
      if (proof?.id !== proofId || !matchesDigest(proof.x_name, digest)) return null;
      const createdAt = parseOdooDate(proof.create_date);
      if (!Number.isFinite(createdAt) || createdAt < issuedAt - CLOCK_TOLERANCE_MS || createdAt > expiresAt ||
          createdAt > clock() + CLOCK_TOLERANCE_MS) return null;
      const uid = Array.isArray(proof.create_uid) ? proof.create_uid[0] : null;
      const scopes = grants.get(uid);
      if (!scopes) return null;

      const userRows = await execute('res.users', 'search_read', [[['id', '=', uid]]], {
        fields: ['id', 'active', 'share', ...(hasCompanyPin ? ['company_ids'] : [])], limit: 1
      });
      if (!Array.isArray(userRows)) throw new Error();
      if (userRows.length !== 1 || clock() >= expiresAt) return null;
      const user = userRows[0];
      if (user?.id !== uid || user.active !== true || user.share !== false) return null;
      if (hasCompanyPin && (!Array.isArray(user.company_ids) || !user.company_ids.includes(company))) return null;
      scheduleProofCleanup();
      return Object.freeze({ uid, scopes });
    } catch {
      throw Object.assign(new Error('Odoo operator verification is temporarily unavailable.'), {
        code: 'ODOO_PROOF_UNAVAILABLE'
      });
    }
  }
  return Object.freeze(Object.assign(verifyOdooOperatorProof, {
    configured, scopesFor: uid => grants.get(uid)
  }));
}
