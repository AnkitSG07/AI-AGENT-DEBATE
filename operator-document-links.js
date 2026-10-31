// Explicit, document-only sharing authority. These short signed links are not
// operator login tokens, and cannot read another record or any JSON endpoint.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

const VERSION = 'shd1';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ID = /^[1-9][0-9]{0,15}$/;
const reject = (status, code, message) => Object.assign(new Error(message), { status, code, operatorAuthError: true });
const validId = value => ID.test(String(value)) && Number.isSafeInteger(Number(value));

export function safeDocumentRedirect(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

export function documentContentDisposition(filename, action = 'inline') {
  const name = String(filename || 'document').replace(/[\x00-\x1f\x7f]/g, '').replace(/[\\"]/g, '_').slice(0, 240) || 'document';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return `${action === 'attachment' ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function createOperatorDocumentLinks({ secret, backendOrigin = 'https://ai-agent-debate.onrender.com', clock = Date.now } = {}) {
  const backend = safeDocumentRedirect(backendOrigin);
  const configured = typeof secret === 'string' && secret.replace(/\s/g, '').length >= 32 && backend && new URL(backend).origin === backendOrigin;
  const key = configured ? Buffer.from(hkdfSync('sha256', Buffer.from(secret),
    Buffer.from('sh-operator-document-links'), Buffer.from('document-link-v1'), 32)) : null;
  const sign = payload => createHmac('sha256', key).update(`${VERSION}.${payload}`).digest('base64url');
  function issue(id, action = 'view') {
    if (!configured) throw reject(503, 'DOCUMENT_SHARING_NOT_CONFIGURED', 'Document sharing requires the operator session secret.');
    if (!validId(id) || !['view', 'download'].includes(action)) throw reject(400, 'INVALID_DOCUMENT_LINK', 'A valid document is required.');
    const issuedAt = clock(), expiresAt = issuedAt + MAX_AGE_MS;
    const payload = Buffer.from(JSON.stringify({ id: String(id), action, issuedAt, expiresAt })).toString('base64url');
    return { url: `${backendOrigin}/api/odoo-documents/${action}/${id}?share=${VERSION}.${payload}.${sign(payload)}`, expiresAt };
  }
  function authorize(req) {
    const url = new URL(String(req.originalUrl || req.url || req.path || ''), backendOrigin);
    if (!url.searchParams.has('share')) return false;
    if (!configured) throw reject(503, 'DOCUMENT_SHARING_NOT_CONFIGURED', 'Document sharing is temporarily unavailable.');
    const match = /^\/api\/odoo-documents\/(view|download)\/([1-9][0-9]{0,15})$/.exec(url.pathname.toLowerCase());
    if (!match || !['GET','HEAD'].includes(req.method) || url.searchParams.getAll('share').length !== 1 ||
      [...url.searchParams.keys()].some(name => name !== 'share')) throw reject(403, 'INVALID_DOCUMENT_LINK', 'This document link is invalid.');
    const token = url.searchParams.get('share'), parts = token.split('.');
    if (token.length > 1500 || parts.length !== 3 || parts[0] !== VERSION || !/^[A-Za-z0-9_-]{1,1000}$/.test(parts[1]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw reject(403, 'INVALID_DOCUMENT_LINK', 'This document link is invalid.');
    const expected = Buffer.from(sign(parts[1]), 'base64url'), actual = Buffer.from(parts[2], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw reject(403, 'INVALID_DOCUMENT_LINK', 'This document link is invalid.');
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw reject(403, 'INVALID_DOCUMENT_LINK', 'This document link is invalid.'); }
    if (!claims || typeof claims !== 'object' || claims.id !== match[2] || claims.action !== match[1] || !validId(claims.id) ||
      !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt) ||
      claims.issuedAt > clock() + 30000 || claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > MAX_AGE_MS)
      throw reject(403, 'INVALID_DOCUMENT_LINK', 'This document link is invalid.');
    if (clock() >= claims.expiresAt) throw reject(410, 'DOCUMENT_LINK_EXPIRED', 'This document link expired. Ask the sender for a new link.');
    req.operatorDocumentGrant = Object.freeze({ id: Number(claims.id), action: claims.action, expiresAt: claims.expiresAt });
    return true;
  }
  return Object.freeze({ issue, authorize, configured: !!configured });
}
