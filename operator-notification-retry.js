// Fixed, non-sensitive FCM result codes only. Generic IAM/403 failures must not
// erase tokens; an exact sender mismatch cannot succeed in this project.
const CODES = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH', 'QUOTA_EXCEEDED',
  'UNAVAILABLE', 'INTERNAL', 'INVALID_ARGUMENT', 'THIRD_PARTY_AUTH_ERROR']);
export function fcmFailure(body, status, retryAfter, now = Date.now()) {
  const code = body?.error?.details?.find(item =>
    item?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && CODES.has(item.errorCode))?.errorCode || '';
  const seconds = /^\d+$/.test(String(retryAfter || '')) ? Number(retryAfter) * 1000 : Date.parse(retryAfter || '') - now;
  return { status, code, unregistered: code === 'UNREGISTERED', senderMismatch: code === 'SENDER_ID_MISMATCH',
    retryAfterMs: Math.min(300000, Math.max(status === 429 ? 60000 : 0, Number.isFinite(seconds) ? seconds : 0)) };
}
export function notificationRetryDelay(attempts, error = {}) {
  return Math.min(300000, Math.max(error.retryAfterMs || 0,
    error.status === 429 || error.status === 403 ? 60000 : 0,
    Math.min(60000, 1000 * 2 ** Math.min(Math.max(1, attempts || 1), 6))));
}
