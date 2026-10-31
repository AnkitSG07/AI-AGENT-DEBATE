// Server-only authority for browser calls and private Hub integrations. A CORS Origin,
// Odoo uid, device label, presence heartbeat or native build is never identity.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const OPERATOR_BROWSER_AUTH_VERSION = 'sh-operator-browser-auth-v1';
export const OPERATOR_BROWSER_TOKEN_TTL_MS = 10 * 60 * 1000;
const PROFILE_MAX_MS = 2 * 60 * 60 * 1000;
const PREFIX = 'shb1';
const AUDIENCE = 'sh-operator-legacy-calls';
const PROFILES = new Set(['SUDO', 'Smart handicrafts']);
export const OPERATOR_BROWSER_SCOPES = Object.freeze(['calls:read', 'calls:write',
  'mail:read', 'mail:write', 'contacts:read', 'contacts:write',
  'documents:read', 'documents:write', 'ai:read', 'ai:write']);
const SCOPES = OPERATOR_BROWSER_SCOPES;
const AUTH_HEADER = 'x-sh-operator-auth';
const DEFAULT_ORIGINS = ['https://www.smarthandicrafts.com', 'https://smarthandicrafts.com', 'https://vaidahi-kala-pvt-ltd.odoo.com'];
const PUSH_HELPERS = new Set(['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/status', '/api/push/test', '/api/push/test-call']);
const PRIVATE_INTEGRATIONS = Object.freeze([
  ['/api/zoho-mail', 'mail'], ['/api/google-contacts', 'contacts'],
  ['/api/odoo-documents', 'documents'], ['/api/ai-mode', 'ai']
]);
const OAUTH_PAGES = new Set(['/zoho/auth', '/zoho/callback', '/google-contacts/auth', '/google-contacts/callback']);
const SERVICE_CALLBACKS = new Set(['/api/odoo/sale-confirmed', '/api/odoo/webhook/sale-confirmed']);
const PRIVATE_PROFILE_TOOLS = new Set(['/api/self-training', '/api/self-training/feedback',
  '/api/product-bot/self-training', '/api/product-bot/routing-telemetry', '/kit-ai-knowledge-status',
  '/kit-ai-training-selection-values', '/kit-ai-approved-rules']);
const QUERY_SECRETS = /^(?:token|access_token|auth_token|authorization|bearer|device_token|devicetoken|browsertoken)$/i;
const READ_METHODS = new Set(['GET', 'HEAD']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const OPAQUE = /^[A-Za-z0-9_:.@+=/-]{1,240}$/;
const STATE = /^[A-Za-z0-9_-]{32,128}$/;
const BASE_ID = /^web_[a-f0-9]{32}$/;
const SESSION_ID = /^tab_[a-f0-9]{24}$/;
const safeObject = value => value && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value > 0;
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const failure = (status, code, message) => Object.assign(new Error(message), { status, code, operatorAuthError: true });
const requireAuth = (condition, status, code, message) => { if (!condition) throw failure(status, code, message); };

function origin(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value && !parsed.username && !parsed.password ? value : '';
  } catch { return ''; }
}
function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
function errorResponse(res, error) {
  headers(res);
  const known = error?.operatorAuthError === true;
  return res.status(known ? error.status : 503).json({ ok: false,
    code: known ? error.code : 'OPERATOR_AUTH_UNAVAILABLE',
    error: known ? error.message : 'Operator authentication is temporarily unavailable.' });
}
function pathname(req) {
  const raw = String(req.originalUrl || req.url || req.path || '');
  try { return new URL(raw, 'https://operator.invalid').pathname.replace(/\/+$/, '').toLowerCase(); }
  catch { return ''; }
}
export function isProtectedOperatorPath(path) {
  const value = String(path || '').replace(/\/+$/, '').toLowerCase();
  return ['/api/whatsapp-calls', '/api/odoo/call-log', '/api/operator-call-locks', '/api/operator-call-transfer', '/api/operator-devices']
    .some(prefix => value === prefix || value.startsWith(`${prefix}/`)) || PUSH_HELPERS.has(value) ||
    PRIVATE_INTEGRATIONS.some(([prefix]) => value === prefix || value.startsWith(`${prefix}/`)) ||
    OAUTH_PAGES.has(value) || value === '/api/debug/webhooks' || value.startsWith('/api/debug/webhooks/') ||
    isPrivateErpPath(value);
}
export function isPrivateErpPath(path) {
  return PRIVATE_PROFILE_TOOLS.has(path) || (!SERVICE_CALLBACKS.has(path) && !path.startsWith('/api/odoo/call-log') &&
    (path === '/api/odoo' || path.startsWith('/api/odoo/') || path === '/api/labels' || path.startsWith('/api/labels/')));
}
export function requiredOperatorScope(path, method = 'GET') {
  const family = PRIVATE_INTEGRATIONS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return `${family?.[1] || 'calls'}:${READ_METHODS.has(method) ? 'read' : 'write'}`;
}
function rejectQueryCredentials(req) {
  const query = new URL(String(req.originalUrl || req.url || req.path || ''), 'https://operator.invalid').searchParams;
  for (const key of query.keys()) requireAuth(!QUERY_SECRETS.test(key), 400, 'CREDENTIAL_IN_URL', 'Credentials must be sent in the Authorization header, never in a URL.');
}
function bearer(req) {
  const value = req.headers?.authorization;
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('Bearer ') || /\s/.test(value.slice(7))) return '';
  return value.slice(7);
}
function nativeReadPath(path) {
  if (['/api/whatsapp-calls/config', '/api/whatsapp-calls/logs', '/api/whatsapp-calls/recent', '/api/whatsapp-calls/incoming'].includes(path)) return true;
  const match = /^\/api\/whatsapp-calls\/([^/]+)$/.exec(path);
  if (!match || ['events', 'diagnostics', 'test', 'note', 'outgoing', 'accept', 'reject', 'terminate', 'cancel-pending-outgoing'].includes(match[1])) return false;
  try { return OPAQUE.test(decodeURIComponent(match[1])); } catch { return false; }
}

const STRING_FIELDS = new Set(['id', 'call_id', 'callId', 'provider_call_id', 'providerCallId', 'session_id', 'sessionId',
  'direction', 'event', 'status', 'state', 'source', 'customer_name', 'customerName', 'caller_name', 'customer_phone',
  'customerPhone', 'phone', 'wa_id', 'from', 'to', 'date', 'created_at', 'updated_at', 'started_at', 'connected_at',
  'ended_at', 'received_at', 'start_time', 'end_time', 'operator_name', 'device_label', 'native_owner_device_id',
  'call_outcome', 'followup_status', 'quotation_status', 'call_note']);
const NUMBER_FIELDS = new Set(['timestamp', 'duration', 'duration_seconds', 'odoo_channel_id', 'channel_id', 'channelId',
  'partner_id', 'odoo_id', 'native_version', 'started_at_ms', 'connected_at_ms', 'ended_at_ms']);
const BOOLEAN_FIELDS = new Set(['active', 'answerable', 'connected', 'missed', 'native_media', 'native_projection',
  'provider_answer_confirmed', 'end_confirmed', 'callback_done', 'locked', 'locked_by_other']);
function callDto(row, depth = 0) {
  if (!safeObject(row)) return null;
  const value = {};
  for (const key of STRING_FIELDS) if (typeof row[key] === 'string') value[key] = row[key].slice(0, key === 'call_note' ? 4000 : 240);
  if (Number.isSafeInteger(row.id) && row.id >= 0) value.id = row.id;
  for (const key of NUMBER_FIELDS) if (Number.isFinite(row[key])) value[key] = row[key];
  for (const key of BOOLEAN_FIELDS) if (typeof row[key] === 'boolean') value[key] = row[key];
  if (depth === 0 && Array.isArray(row.events)) value.events = row.events.slice(0, 160).map(item => callDto(item, 1)).filter(Boolean);
  return value;
}
/** Whitelist projection, not a blacklist. Native WebView history gets no raw
 * webhook, SDP, join token, peer credential, provider response or raw error. */
export function projectNativeCallHistory(payload) {
  if (!safeObject(payload)) return { ok: false, error: 'Call history is unavailable.' };
  if (payload.ok === false) return { ok: false, error: 'Call history is unavailable.' };
  const value = { ok: payload.ok !== false };
  for (const key of ['normalized', 'realtime']) if (typeof payload[key] === 'boolean') value[key] = payload[key];
  for (const key of ['source', 'version']) if (typeof payload[key] === 'string') value[key] = payload[key].slice(0, 100);
  for (const key of ['count', 'since_ms']) if (Number.isFinite(payload[key])) value[key] = payload[key];
  if (Array.isArray(payload.calls)) { value.calls = payload.calls.slice(0, 200).map(item => callDto(item)).filter(Boolean); value.count = value.calls.length; }
  if (safeObject(payload.call)) value.call = callDto(payload.call);
  if (Array.isArray(payload.events)) value.events = payload.events.slice(0, 160).map(item => callDto(item, 1)).filter(Boolean);
  return value;
}

/** Hashing both strings keeps the comparison length constant. Empty/unconfigured
 * passwords are never accepted. The caller still needs the limiter below. */
export function constantTimePasswordEqual(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !expected || supplied.length > 1024 || expected.length > 1024) return false;
  return timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(expected).digest());
}
export function createProfileLoginLimiter({ clock = Date.now, maxAttempts = 8, windowMs = 5 * 60000, maxKeys = 10000 } = {}) {
  const rows = new Map();
  const keyFor = req => hash(String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 160));
  function check(req) {
    const now = clock();
    for (const [key, value] of rows) if (value.until <= now) rows.delete(key);
    const key = keyFor(req);
    requireAuth(rows.has(key) || rows.size < maxKeys, 429, 'LOGIN_RATE_LIMITED', 'Please wait before trying to sign in again.');
    const row = rows.get(key) || { count: 0, until: now + windowMs };
    row.count++; rows.set(key, row);
    requireAuth(row.count <= maxAttempts, 429, 'LOGIN_RATE_LIMITED', 'Please wait before trying to sign in again.');
  }
  function success(req) { rows.delete(keyFor(req)); }
  return Object.freeze({ check, success });
}

export function createOperatorBrowserAuth({ secret, readProfileSession, authenticateNative, authorizeDocumentLink,
  allowedHubOrigins = DEFAULT_ORIGINS, backendOrigin = 'https://ai-agent-debate.onrender.com', clock = Date.now } = {}) {
  const origins = new Set(Array.isArray(allowedHubOrigins) ? allowedHubOrigins.map(origin).filter(Boolean) : []);
  const backend = origin(backendOrigin);
  const configured = typeof secret === 'string' && secret.replace(/\s/g, '').length >= 32 && !!backend && origins.size > 0;
  const signingKey = configured ? Buffer.from(hkdfSync('sha256', Buffer.from(secret),
    Buffer.from('sh-operator-browser-auth'), Buffer.from('capability-signature-v1'), 32)) : null;
  const issuerRates = new Map();
  function ready() { requireAuth(configured, 503, 'BROWSER_AUTH_NOT_CONFIGURED', 'Browser call sign-in is not configured. Ask the administrator to configure the operator session secret.'); }
  function publicConfig() { return { ok: true, version: OPERATOR_BROWSER_AUTH_VERSION, authRequired: true,
    browserAuthReady: configured, browserTokenTtlMs: OPERATOR_BROWSER_TOKEN_TTL_MS, authenticatedEventStream: true }; }
  function sign(claims) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${PREFIX}.${payload}.${createHmac('sha256', signingKey).update(`${PREFIX}.${payload}`).digest('base64url')}`;
  }
  function verifyClaims(token, { expectedOrigin, recoverExpiredAccess = false } = {}) {
    ready();
    requireAuth(typeof token === 'string' && token.length <= 4096, 401, 'BROWSER_AUTH_REQUIRED', 'Connect an authorized operator profile before using call controls.');
    const parts = token.split('.');
    requireAuth(parts.length === 3 && parts[0] === PREFIX && /^[A-Za-z0-9_-]{1,3500}$/.test(parts[1]) &&
      /^[A-Za-z0-9_-]{43}$/.test(parts[2]), 401, 'INVALID_BROWSER_CAPABILITY', 'The browser authorization is invalid.');
    const expected = createHmac('sha256', signingKey).update(`${PREFIX}.${parts[1]}`).digest();
    const supplied = Buffer.from(parts[2], 'base64url');
    requireAuth(supplied.length === expected.length && timingSafeEqual(supplied, expected), 401, 'INVALID_BROWSER_CAPABILITY', 'The browser authorization is invalid.');
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw failure(401, 'INVALID_BROWSER_CAPABILITY', 'The browser authorization is invalid.'); }
    const now = clock();
    requireAuth(safeObject(claims) && claims.v === 1 && claims.aud === AUDIENCE && claims.iss === backend &&
      PROFILES.has(claims.profile) && origins.has(claims.hubOrigin) && BASE_ID.test(claims.baseDeviceId || '') &&
      SESSION_ID.test(claims.operatorSessionId || '') && claims.operatorDeviceId === `${claims.baseDeviceId}::${claims.operatorSessionId}` &&
      typeof claims.jti === 'string' && /^[a-f0-9]{32}$/.test(claims.jti) && Array.isArray(claims.scopes) &&
      claims.scopes.length >= 1 && claims.scopes.length <= SCOPES.length && new Set(claims.scopes).size === claims.scopes.length &&
      claims.scopes.every(scope => SCOPES.includes(scope)) && time(claims.iat) && time(claims.exp) &&
      time(claims.grantIssuedAt) && time(claims.authExpiresAt) && claims.grantIssuedAt <= claims.iat &&
      claims.iat <= now + 30000 && claims.exp > claims.iat && claims.exp - claims.iat <= OPERATOR_BROWSER_TOKEN_TTL_MS &&
      claims.exp <= claims.authExpiresAt && claims.authExpiresAt - claims.grantIssuedAt <= PROFILE_MAX_MS,
    401, 'INVALID_BROWSER_CAPABILITY', 'The browser authorization is invalid.');
    requireAuth((recoverExpiredAccess || now < claims.exp) && now < claims.authExpiresAt,
      401, 'BROWSER_CAPABILITY_EXPIRED', 'Operator authorization expired. Connect your operator profile again.');
    if (expectedOrigin !== undefined) requireAuth(expectedOrigin === claims.hubOrigin, 403, 'BROWSER_ORIGIN_MISMATCH', 'This authorization belongs to another Hub origin.');
    return Object.freeze(claims);
  }
  // The exported verifier never accepts an expired access capability. Only the
  // issuer can recover its actor, after independently verifying a current
  // Render profile, and only within the original absolute authorization lease.
  function verifyToken(token, { expectedOrigin } = {}) { return verifyClaims(token, { expectedOrigin }); }
  function result(claims) { return { ok: true, token: sign(claims), expiresAt: claims.exp, authExpiresAt: claims.authExpiresAt,
    operatorDeviceId: claims.operatorDeviceId, baseDeviceId: claims.baseDeviceId, operatorSessionId: claims.operatorSessionId }; }
  function rateIssue(req, profile) {
    const now = clock();
    for (const [id, row] of issuerRates) if (row.until <= now) issuerRates.delete(id);
    const key = hash(`${req.ip || req.socket?.remoteAddress || 'unknown'}:${profile}`);
    requireAuth(issuerRates.has(key) || issuerRates.size < 10000, 429, 'AUTH_RATE_LIMITED', 'Please wait before connecting again.');
    const row = issuerRates.get(key) || { count: 0, until: now + 60000 }; row.count++; issuerRates.set(key, row);
    requireAuth(row.count <= 12, 429, 'AUTH_RATE_LIMITED', 'Please wait before connecting again.');
  }
  async function profile(req) {
    const session = typeof readProfileSession === 'function' ? await readProfileSession(req) : null;
    requireAuth(session && PROFILES.has(session.profile) && time(session.exp) && session.exp > clock(),
      401, 'OPERATOR_PROFILE_REQUIRED', 'Sign in with the Smart handicrafts or SUDO operator profile.');
    return session;
  }
  function sameOriginWrite(req) {
    requireAuth(req.headers?.origin === backend && req.headers?.[AUTH_HEADER] === '1',
      403, 'SAME_ORIGIN_ACTION_REQUIRED', 'Open this action from the operator sign-in page.');
  }
  async function issue(req) {
    ready(); sameOriginWrite(req); rejectQueryCredentials(req);
    const session = await profile(req); rateIssue(req, session.profile);
    const body = req.body;
    requireAuth(safeObject(body) && origins.has(body.origin) && JSON.stringify(body).length <= 9000,
      400, 'INVALID_AUTH_REQUEST', 'A supported exact Hub origin is required.');
    const prior = body.previousToken ? verifyClaims(body.previousToken, { expectedOrigin: body.origin, recoverExpiredAccess: true }) : null;
    requireAuth(!prior || prior.profile === session.profile, 403, 'PROFILE_CHANGED', 'This browser session belongs to another operator profile. Reconnect without the previous session.');
    const now = clock(), authExpiresAt = Math.min(session.exp, prior?.authExpiresAt || now + PROFILE_MAX_MS);
    const baseDeviceId = prior?.baseDeviceId || `web_${randomBytes(16).toString('hex')}`;
    const operatorSessionId = prior?.operatorSessionId || `tab_${randomBytes(12).toString('hex')}`;
    return result({ v: 1, aud: AUDIENCE, iss: backend, hubOrigin: body.origin, profile: session.profile,
      scopes: prior ? [...prior.scopes] : [...SCOPES], baseDeviceId, operatorSessionId, operatorDeviceId: `${baseDeviceId}::${operatorSessionId}`,
      jti: randomBytes(16).toString('hex'), grantIssuedAt: prior?.grantIssuedAt || now, authExpiresAt,
      iat: now, exp: Math.min(now + OPERATOR_BROWSER_TOKEN_TTL_MS, authExpiresAt) });
  }
  async function refresh(req) {
    ready(); rejectQueryCredentials(req);
    const previous = verifyToken(bearer(req), { expectedOrigin: req.headers?.origin || '' });
    const now = clock();
    // This renews only the existing signed grant. No profile, scope, actor,
    // origin or absolute authorization expiry can be supplied by the caller.
    return result({ ...previous, jti: randomBytes(16).toString('hex'), iat: now,
      exp: Math.min(now + OPERATOR_BROWSER_TOKEN_TTL_MS, previous.authExpiresAt) });
  }
  function bindActor(req, actor) {
    req.operatorAuth = Object.freeze(actor);
    const canonical = { deviceId: actor.baseDeviceId, device_id: actor.baseDeviceId, base_device_id: actor.baseDeviceId,
      operatorDeviceId: actor.operatorDeviceId, operator_device_id: actor.operatorDeviceId, actor_device_id: actor.operatorDeviceId,
      operatorSessionId: actor.operatorSessionId, operator_session_id: actor.operatorSessionId,
      lockDeviceId: actor.operatorDeviceId, lock_device_id: actor.operatorDeviceId,
      operatorLockDeviceId: actor.operatorDeviceId, operator_lock_device_id: actor.operatorDeviceId,
      operator_name: actor.profile, operatorName: actor.profile, client_source: 'odoo_operator_hub' };
    const update = value => ({ ...(safeObject(value) ? value : {}), ...canonical });
    req.body = update(req.body);
    // Express4 has a writable query property. Defining it also supports an
    // Express5 getter without leaving a second untrusted identity read path.
    Object.defineProperty(req, 'query', { configurable: true, enumerable: true, writable: true, value: update(req.query) });
    if (/\/api\/operator-call-transfer\/(?:request|cancel)$/.test(pathname(req))) {
      for (const value of [req.body, req.query]) {
        value.from_operator_device_id = actor.operatorDeviceId; value.from_device_id = actor.operatorDeviceId;
        value.from_operator = actor.profile;
      }
    }
  }
  async function cookieHelperActor(req) {
    ready();
    const session = await profile(req);
    if (!READ_METHODS.has(req.method)) sameOriginWrite(req);
    const seed = createHmac('sha256', signingKey).update(`render-helper:${session.profile}:${session.exp}`).digest('hex');
    const baseDeviceId = `web_${seed.slice(0, 32)}`, operatorSessionId = `tab_${seed.slice(32, 56)}`;
    return { kind: 'profile', profile: session.profile, scopes: [...SCOPES], baseDeviceId, operatorSessionId,
      operatorDeviceId: `${baseDeviceId}::${operatorSessionId}`, authExpiresAt: session.exp };
  }
  async function privateProfileActor(req, { erp = false } = {}) {
    ready();
    const session = erp && typeof readProfileSession === 'function' ? await readProfileSession(req) : await profile(req);
    requireAuth(session && (erp ? ['SUDO', 'Smart handicrafts', 'Accounts'].includes(session.profile) : PROFILES.has(session.profile)) &&
      time(session.exp) && session.exp > clock(), 401, 'OPERATOR_PROFILE_REQUIRED', 'Sign in to the authorized Render profile to continue.');
    // Existing same-origin ERP tools send JSON. Exact Origin plus a non-simple
    // content type protects those writes without requiring an incompatible UI
    // header or trusting a cross-origin Odoo cookie.
    if (!READ_METHODS.has(req.method)) requireAuth(req.headers?.origin === backend &&
      /^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || ''),
    403, 'SAME_ORIGIN_ACTION_REQUIRED', 'Open this action from the signed-in application.');
    const seed = createHmac('sha256', signingKey).update(`private-profile:${session.profile}:${session.exp}`).digest('hex');
    const baseDeviceId = `web_${seed.slice(0,32)}`, operatorSessionId = `tab_${seed.slice(32,56)}`;
    return { kind: 'profile', profile: session.profile, scopes: erp ? ['erp:read', 'erp:write'] : [...SCOPES],
      baseDeviceId, operatorSessionId, operatorDeviceId: `${baseDeviceId}::${operatorSessionId}`, authExpiresAt: session.exp };
  }
  async function guard(req, res, next) {
    const path = pathname(req);
    if (!isProtectedOperatorPath(path) || req.method === 'OPTIONS') return next();
    headers(res);
    try {
      rejectQueryCredentials(req);
      if (READ_METHODS.has(req.method) && /^\/api\/odoo-documents\/(?:view|download)\/[1-9][0-9]*$/.test(path) &&
          typeof authorizeDocumentLink === 'function' && await authorizeDocumentLink(req)) return next();
      // Only an authenticated browser may reach the existing operational
      // configuration. Native history and signed-out callers get the marker.
      if (path === '/api/whatsapp-calls/config' && READ_METHODS.has(req.method) &&
          !bearer(req).startsWith(`${PREFIX}.`)) {
        res.setHeader('X-SH-Call-History', 'sh-call-history-v1');
        return res.json(publicConfig());
      }
      requireAuth(READ_METHODS.has(req.method) || WRITE_METHODS.has(req.method), 405, 'METHOD_NOT_ALLOWED', 'This method is not supported.');
      const raw = bearer(req);
      let actor;
      if (isPrivateErpPath(path) || OAUTH_PAGES.has(path)) {
        // Hub capabilities have no generic service-account RPC permission.
        requireAuth(!raw, 403, 'PROFILE_SESSION_REQUIRED', 'This operation needs its signed Render profile.');
        actor = await privateProfileActor(req, { erp: isPrivateErpPath(path) });
      } else if (raw.startsWith(`${PREFIX}.`)) {
        const claims = verifyToken(raw, { expectedOrigin: req.headers?.origin || '' });
        const needed = requiredOperatorScope(path, req.method);
        requireAuth(claims.scopes.includes(needed), 403, 'OPERATOR_SCOPE_REQUIRED', 'This authorization does not permit that operator operation.');
        if (path === '/api/odoo-documents/share' && String(req.body?.channel || req.body?.mode || '').trim().toLowerCase() === 'email')
          requireAuth(claims.scopes.includes('mail:write'), 403, 'OPERATOR_SCOPE_REQUIRED', 'Email permission is required to send this document.');
        actor = { ...claims, kind: 'browser' };
      } else if (raw) {
        requireAuth(READ_METHODS.has(req.method) && nativeReadPath(path), 403, 'NATIVE_LEGACY_CONTROL_FORBIDDEN', 'Use the authenticated native call controls for this operation.');
        requireAuth(/^android_[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{32,100}$/.test(raw),
          401, 'INVALID_DEVICE_CREDENTIAL', 'A valid enrolled device is required for native history.');
        requireAuth(typeof authenticateNative === 'function', 503, 'DEVICE_AUTH_UNAVAILABLE', 'Device authentication is temporarily unavailable.');
        let device;
        try { device = await authenticateNative(raw, req); }
        catch (error) {
          const denied = error?.registryError && [400, 401, 403].includes(error.status);
          throw failure(denied ? 401 : 503, denied ? 'DEVICE_AUTH_REQUIRED' : 'DEVICE_AUTH_UNAVAILABLE',
            denied ? 'Device enrollment expired or was revoked.' : 'Device authentication is temporarily unavailable.');
        }
        requireAuth(device && /^android_[A-Za-z0-9_-]{16,100}$/.test(device.id || '') && device.id === raw.split('.')[0] && !device.revokedAt &&
          !device.revoked && time(device.tokenExpiresAt) && device.tokenExpiresAt > clock(),
        401, 'DEVICE_AUTH_REQUIRED', 'Device enrollment expired or was revoked.');
        req.operatorAuth = Object.freeze({ kind: 'native-history', deviceId: device.id, scopes: ['calls:read'] });
        res.setHeader('X-SH-Call-History', 'sh-call-history-v1');
        const originalJson = res.json.bind(res);
        res.json = payload => originalJson(projectNativeCallHistory(payload));
        return next();
      } else if (PUSH_HELPERS.has(path)) actor = await cookieHelperActor(req);
      else throw failure(401, 'BROWSER_AUTH_REQUIRED', 'Connect an authorized operator profile before using call controls.');
      if (path === '/api/push/test-call' && READ_METHODS.has(req.method)) throw failure(405, 'POST_REQUIRED', 'Use an authenticated POST for a call notification test.');
      bindActor(req, actor);
      if (isPrivateErpPath(path)) {
        const role = actor.profile === 'SUDO' ? 'admin' : actor.profile === 'Accounts' ? 'finance' : 'sales';
        req.body.role = role; req.query.role = role;
        req.body.user = actor.profile; req.query.user = actor.profile;
      }
      if (path === '/api/ai-mode' || path === '/api/ai-mode/global') req.body.updatedBy = actor.operatorDeviceId;
      return next();
    } catch (error) { return errorResponse(res, error); }
  }
  const handler = action => async (req, res) => {
    headers(res);
    try { return res.json(await action(req)); } catch (error) { return errorResponse(res, error); }
  };
  async function popup(req, res) {
    headers(res);
    try {
      const target = String(req.query?.origin || ''), state = String(req.query?.state || '');
      requireAuth(origins.has(target) && STATE.test(state) && Object.keys(req.query || {}).every(key => ['origin', 'state'].includes(key)),
        400, 'INVALID_AUTH_WINDOW', 'Open operator sign-in from the Smart Handicrafts Hub.');
      const nonce = randomBytes(18).toString('base64');
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const config = JSON.stringify({ backendOrigin: backend, allowedHubOrigins: [...origins] }).replaceAll('<', '\\u003c');
      const html = await readFile(new URL('./public/operator-auth.html', import.meta.url), 'utf8');
      return res.send(html.replaceAll('__SH_OPERATOR_AUTH_NONCE__', nonce).replace('__SH_OPERATOR_AUTH_PUBLIC_CONFIG__', config));
    } catch (error) { return errorResponse(res, error); }
  }
  function registerRoutes(app) {
    app.get('/operator-auth', popup);
    app.get('/operator-auth.html', popup);
    app.post('/api/operator-browser-auth/token', handler(issue));
    app.post('/api/operator-browser-auth/refresh', handler(refresh));
  }
  return Object.freeze({ guard, registerRoutes, verifyToken, publicConfig });
}
