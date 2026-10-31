import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
function key(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_+/-]+={0,2}$/.test(value) || value.length > 200) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes ? decoded : null;
}
/** The endpoint is a delivery address, not proof of ownership. A signed current
 * actor may manage its own row. A re-authenticated copy of the SAME browser may
 * rebind its subscription only by presenting both existing subscription keys. */
export function canManagePushSubscription(existing, actor, suppliedSubscription) {
  if (!actor || !['browser', 'profile'].includes(actor.kind) || !/^web_[a-f0-9]{32}$/.test(actor.baseDeviceId || '')) return false;
  const endpoint = String(existing?.subscription?.endpoint || existing?.endpoint || '');
  if (!endpoint) return false;
  const owner = String(existing?.device_id || existing?.deviceId || '');
  if (owner && owner === actor.baseDeviceId) return true;
  const prior = existing?.subscription?.keys, supplied = suppliedSubscription?.keys;
  if (suppliedSubscription?.endpoint !== endpoint || !prior || !supplied) return false;
  const oldAuth = key(prior.auth, 16), newAuth = key(supplied.auth, 16);
  const oldPublic = key(prior.p256dh, 65), newPublic = key(supplied.p256dh, 65);
  if (!oldAuth || !newAuth || !oldPublic || !newPublic) return false;
  return timingSafeEqual(digest(oldAuth), digest(newAuth)) && timingSafeEqual(digest(oldPublic), digest(newPublic));
}
export function assertPushSubscriptionOwner(existing, actor, suppliedSubscription) {
  if (!canManagePushSubscription(existing, actor, suppliedSubscription)) {
    const error = new Error('This subscription belongs to another browser. Use that browser to update or remove it.');
    error.statusCode = 403; error.code = 'PUSH_SUBSCRIPTION_OWNER_REQUIRED'; throw error;
  }
}
