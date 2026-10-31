import { MediaError, identifier, requireValue } from './errors.mjs';

/** Native unanswered-call rejection uses Meta directly: no customer room has
 * been accepted yet. This adapter is server-only and its URL never comes from a
 * client. The durable runtime owns retries of this exact idempotent rejection. */
export function createBoundedNativeReject({ metaToken, apiVersion, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  requireValue(typeof metaToken === 'string' && metaToken.length > 0 && /^(23|24|25|26)\.0$/.test(apiVersion) &&
    typeof fetchImpl === 'function' && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
  'NATIVE_REJECT_CONFIG', 'Native rejection needs validated server configuration and a bounded timeout.', 503);
  return async ({ callId, phoneNumberId }) => {
    identifier(callId, 'provider call ID'); identifier(phoneNumberId, 'business number ID');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://graph.facebook.com/v${apiVersion}/${encodeURIComponent(phoneNumberId)}/calls`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${metaToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', call_id: callId, action: 'reject' })
      });
      const data = await response.json();
      if (!response.ok || data?.error || data?.success !== true)
        throw new MediaError('NATIVE_REJECT_UNCONFIRMED', 'The provider has not confirmed rejection of this exact call.', 502,
          { operation: 'WhatsAppReject', outcomeUnknown: response.status >= 500 || response.ok });
      return { rejected: true, callId };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError(controller.signal.aborted ? 'NATIVE_REJECT_TIMEOUT' : 'NATIVE_REJECT_UNCONFIRMED',
        'Rejection is awaiting provider confirmation; durable cleanup will reconcile this call.', 502,
        { operation: 'WhatsAppReject', outcomeUnknown: true });
    } finally { clearTimeout(timer); }
  };
}
