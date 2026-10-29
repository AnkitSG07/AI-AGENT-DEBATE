// Server-only Firestore storage for native operator device credentials.
// Never serve this module, a service-account credential, or registry documents
// through the public embed/APK. The injected client must use server-side IAM.
import {
  createHash, createCipheriv, createDecipheriv, hkdfSync,
  randomBytes, randomUUID, timingSafeEqual
} from 'node:crypto';

export const FIRESTORE_REGISTRY_VERSION = '2026-10-29-firestore-registry-r10';
export const DEVICE_TOKEN_TTL_MS = 30 * 86400000;
const RECOVERY_WINDOW_MS = 2 * 60000;
const ENROLLMENT_TTL_MS = 15 * 60000;
const DELIVERY_LEASE_MS = 60000;
const HASH = value => createHash('sha256').update(String(value)).digest('hex');
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^android_[A-Za-z0-9_-]{16,100}$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const INSTALL_PATTERN = /^[A-Za-z0-9_-]{16,120}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_.-]{45,240}$/;
const cleanText = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : '';
const fcmToken = value => typeof value === 'string' && value.length >= 20 && value.length <= 4096 && /^[A-Za-z0-9_:\-.]+$/.test(value) ? value : '';
const equal = (a, b) => {
  const first = Buffer.from(String(a)), second = Buffer.from(String(b));
  return first.length === second.length && timingSafeEqual(first, second);
};
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const positiveId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? String(Number(value)) : '';
const callId = value => typeof value === 'string' && value.length > 0 && value.length <= 220 && !/[\s\u0000-\u001f\u007f]/u.test(value) && !/^(?:undefined|null|false|true)$/i.test(value) ? value : '';

/** Only deliberately created errors may be returned verbatim by HTTP adapters. */
export class RegistryError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'RegistryError';
    this.registryError = true;
    this.status = status;
    this.code = code || 'REGISTRY_ERROR';
  }
}
const badInput = message => new RegistryError(400, message, 'INVALID_ARGUMENT');
const unauthorized = () => new RegistryError(401, 'Device enrollment expired or was revoked.', 'DEVICE_UNAUTHORIZED');
const unavailable = () => new RegistryError(503, 'Android device storage is temporarily unavailable. Please retry.', 'REGISTRY_UNAVAILABLE');
const usedCode = () => new RegistryError(409, 'This one-time enrollment code was already used. Ask the administrator for a new code.', 'ENROLLMENT_CONSUMED');

function bearerDigest(value) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) throw unauthorized();
  return HASH(value);
}

function deviceRow(snapshot) {
  if (!snapshot.exists) return null;
  const row = snapshot.data();
  if (!row || row.schema !== 1 || row.id !== snapshot.id || !ID_PATTERN.test(row.id) ||
      !INSTALL_PATTERN.test(row.installationId) || !HASH_PATTERN.test(row.tokenHash) ||
      !safeInteger(row.tokenExpiresAt) || !safeInteger(row.revokedAt) ||
      !safeInteger(row.createdAt) || !safeInteger(row.updatedAt) ||
      !Number.isSafeInteger(row.credentialGeneration) || row.credentialGeneration < 1 ||
      (row.fcmToken !== '' && !fcmToken(row.fcmToken)) ||
      typeof row.receiveCalls !== 'boolean' || typeof row.receiveChats !== 'boolean') throw unavailable();
  return row;
}

function recoveryKey(secret, operation, binding) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.from('sh-operator-registry/r10'),
    Buffer.from(`${operation}:${HASH(binding)}`), 32));
}
function sealRecovery(secret, operation, binding, payload, nonce) {
  const cipher = createCipheriv('aes-256-gcm', recoveryKey(secret, operation, binding), nonce);
  cipher.setAAD(Buffer.from(binding));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { iv: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') };
}
function openRecovery(secret, operation, binding, envelope) {
  try {
    if (!envelope || typeof envelope.data !== 'string' || envelope.data.length > 2048) throw Error('Invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', recoveryKey(secret, operation, binding), Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString('utf8'));
  } catch { throw unavailable(); }
}

/**
 * Accepts a @google-cloud/firestore/Firebase Admin server Firestore instance.
 * Does not parse environment variables, log documents, or use local-file fallbacks.
 * All times are epoch milliseconds, not Firestore Timestamp objects.
 *
 * Collections are separate so history cleanup cannot delete device credentials:
 *   PREFIX_devices / installations / credentials / enrollments / rotations
 *   PREFIX_deliveries / metadata
 *
 * Admin-only methods (issueEnrollment, revokeDevice, pruneExpiredRecoveries)
 * deliberately have no HTTP route. Their caller must supply admin authorization.
 */
export function createFirestoreDeviceRegistry({
  firestore, clock = Date.now, bootstrapEnrollmentCode = '',
  collectionPrefix = 'sh_operator', revokedIds = [], maxDevices = 500,
  tokenTtlMs = DEVICE_TOKEN_TTL_MS, deliveryLeaseMs = DELIVERY_LEASE_MS
} = {}) {
  if (!firestore || typeof firestore.collection !== 'function' || typeof firestore.runTransaction !== 'function') throw new TypeError('A server Firestore client is required.');
  if (!/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(collectionPrefix)) throw new TypeError('Invalid registry collection prefix.');
  if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 500) throw new TypeError('Invalid device limit.');
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs < 60000 || tokenTtlMs > DEVICE_TOKEN_TTL_MS) throw new TypeError('Device credential lifetime must be bounded by 30 days.');
  if (!Number.isSafeInteger(deliveryLeaseMs) || deliveryLeaseMs < 45000 || deliveryLeaseMs > 120000) throw new TypeError('Delivery lease must be between 45 and 120 seconds.');
  const blocked = new Set(revokedIds);
  const bootstrap = CODE_PATTERN.test(bootstrapEnrollmentCode) ? bootstrapEnrollmentCode : '';
  const collections = Object.fromEntries(['devices', 'installations', 'credentials', 'enrollments', 'rotations', 'deliveries', 'metadata']
    .map(name => [name, firestore.collection(`${collectionPrefix}_${name}`)]));
  const gate = collections.metadata.doc('registry');

  async function guarded(operation) {
    try { return await operation(); }
    catch (error) { if (error instanceof RegistryError) throw error; throw unavailable(); }
  }
  function nowMs() {
    const now = clock();
    if (!Number.isSafeInteger(now) || now <= 0) throw unavailable();
    return now;
  }
  function isActive(row, now) {
    return row && !row.revokedAt && !blocked.has(row.id) && row.tokenExpiresAt > now;
  }
  function validateCurrent(row, index, digest, now) {
    if (!row || !index || index.active !== true || index.deviceId !== row.id || index.generation !== row.credentialGeneration ||
        !equal(row.tokenHash, digest) || !isActive(row, now)) throw unauthorized();
    return row;
  }
  async function readCredential(tx, digest) {
    const indexSnapshot = await tx.get(collections.credentials.doc(digest));
    if (!indexSnapshot.exists) throw unauthorized();
    const index = indexSnapshot.data();
    if (!index || !ID_PATTERN.test(index.deviceId || '')) throw unavailable();
    const reference = collections.devices.doc(index.deviceId);
    const row = deviceRow(await tx.get(reference));
    return { row, index, reference };
  }
  async function gateCount(tx, gateSnapshot) {
    if (gateSnapshot.exists) {
      const value = gateSnapshot.data();
      if (value?.schema !== 1 || !safeInteger(value.registeredDeviceCount) || !safeInteger(value.updatedAt)) throw unavailable();
      return value.registeredDeviceCount;
    }
    // Also handles initial adoption of already imported device documents. No
    // credential is guessed or reconstructed from a phone's claimed identity.
    const existing = await tx.get(collections.devices);
    return existing.docs.map(deviceRow).filter(row => !row.revokedAt).length;
  }
  function writeGate(tx, count, now) {
    if (!safeInteger(count)) throw unavailable();
    tx.set(gate, { schema: 1, registeredDeviceCount: count, updatedAt: now });
  }

  /** One non-secret point read. Missing metadata is valid for a fresh database.
   * This proves read availability, not permission to commit future writes.
   */
  async function checkAvailability() {
    return guarded(async () => {
      const snapshot = await gate.get();
      if (snapshot.exists) {
        const value = snapshot.data();
        if (value?.schema !== 1 || !safeInteger(value.registeredDeviceCount) || !safeInteger(value.updatedAt)) throw unavailable();
      }
      return true;
    });
  }

  async function isEnrollmentAvailable(code = bootstrap) {
    return guarded(async () => {
      if (!CODE_PATTERN.test(code || '')) return false;
      const snapshot = await collections.enrollments.doc(HASH(code)).get();
      if (!snapshot.exists) return !!bootstrap && equal(HASH(code), HASH(bootstrap));
      const invite = snapshot.data();
      return invite?.schema === 1 && !invite.consumedAt && !invite.revokedAt && safeInteger(invite.expiresAt) && invite.expiresAt > nowMs();
    });
  }

  /** Protected server-side administrative operation; does not expose a route. */
  async function issueEnrollment({ enrollmentCode, expiresInMs = ENROLLMENT_TTL_MS, installationId = '', label = '' } = {}) {
    const code = enrollmentCode || randomBytes(32).toString('base64url');
    if (!CODE_PATTERN.test(code)) throw badInput('Use a random enrollment code of 32 to 256 URL-safe characters.');
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60000 || expiresInMs > 86400000) throw badInput('Enrollment expiry must be between one minute and one day.');
    if (installationId && !INSTALL_PATTERN.test(installationId)) throw badInput('A valid installation ID is required.');
    const now = nowMs(), ref = collections.enrollments.doc(HASH(code));
    return guarded(() => firestore.runTransaction(async tx => {
      if ((await tx.get(ref)).exists) throw usedCode();
      tx.create(ref, { schema: 1, kind: 'invitation', createdAt: now, expiresAt: now + expiresInMs,
        consumedAt: 0, revokedAt: 0, installationId, label: cleanText(label, 120), recoveryUntil: 0, recoveryEnvelope: null });
      return { enrollmentCode: code, expiresAt: now + expiresInMs };
    }));
  }

  async function enroll(input = {}) {
    const { installationId, fcmToken: registrationFcm, enrollmentCode, requestId = '' } = input;
    const label = cleanText(input.deviceLabel, 120) || 'Android operator device';
    if (!INSTALL_PATTERN.test(installationId || '') || !fcmToken(registrationFcm)) throw badInput('A valid installation ID and Firebase token are required.');
    if (!CODE_PATTERN.test(enrollmentCode || '')) throw new RegistryError(403, 'The enrollment code is invalid or unavailable.', 'INVALID_ENROLLMENT');
    if (requestId && !INSTALL_PATTERN.test(requestId)) throw badInput('A valid enrollment request ID is required.');
    const codeHash = HASH(enrollmentCode), installHash = HASH(installationId);
    const fingerprint = HASH(JSON.stringify({ installationId, fcmHash: HASH(registrationFcm), requestHash: HASH(requestId), label }));
    // Entropy is generated once, outside a callback that Firestore may retry.
    const candidateId = `android_${randomUUID()}`, tokenSecret = randomBytes(32).toString('base64url'), nonce = randomBytes(12);
    const invitationRef = collections.enrollments.doc(codeHash), installationRef = collections.installations.doc(installHash);
    return guarded(() => firestore.runTransaction(async tx => {
      const now = nowMs();
      const invitationSnapshot = await tx.get(invitationRef), installationSnapshot = await tx.get(installationRef);
      const invitation = invitationSnapshot.exists ? invitationSnapshot.data() : null;
      if (invitation && invitation.schema !== 1) throw unavailable();
      const install = installationSnapshot.exists ? installationSnapshot.data() : null;
      if (install && (install.installationId !== installationId || !ID_PATTERN.test(install.deviceId || ''))) throw unavailable();
      const deviceId = install?.deviceId || candidateId, deviceRef = collections.devices.doc(deviceId);
      const existing = deviceRow(await tx.get(deviceRef));
      if (existing && existing.installationId !== installationId) throw unavailable();

      if (invitation?.consumedAt) {
        if (!invitation.revokedAt && invitation.recoveryUntil > now && invitation.recoveryUntil <= invitation.consumedAt + RECOVERY_WINDOW_MS &&
            equal(invitation.fingerprint || '', fingerprint) && invitation.deviceId === deviceId &&
            existing && isActive(existing, now) && invitation.generation === existing.credentialGeneration &&
            equal(invitation.tokenHash || '', existing.tokenHash)) {
          const recovered = openRecovery(enrollmentCode, 'enrollment', invitation.recoveryBinding, invitation.recoveryEnvelope);
          if (recovered.deviceId !== deviceId || !TOKEN_PATTERN.test(recovered.deviceToken || '') || !equal(HASH(recovered.deviceToken), existing.tokenHash)) throw unavailable();
          return { ...recovered, expiresAt: existing.tokenExpiresAt, replayed: true };
        }
        throw usedCode();
      }
      if (invitation) {
        if (invitation.revokedAt || !safeInteger(invitation.expiresAt) || invitation.expiresAt <= now ||
            (invitation.installationId && invitation.installationId !== installationId)) {
          throw new RegistryError(403, 'The enrollment code is invalid or unavailable.', 'INVALID_ENROLLMENT');
        }
      } else if (!bootstrap || !equal(codeHash, HASH(bootstrap))) {
        throw new RegistryError(403, 'The enrollment code is invalid or unavailable.', 'INVALID_ENROLLMENT');
      }
      if (existing && isActive(existing, now)) throw new RegistryError(409, 'This installation is already enrolled.', 'INSTALLATION_ENROLLED');
      if (blocked.has(deviceId)) throw new RegistryError(403, 'This device was revoked by an administrator.', 'DEVICE_BLOCKED');

      const gateSnapshot = await tx.get(gate), count = await gateCount(tx, gateSnapshot);
      const increment = !existing || !!existing.revokedAt ? 1 : 0;
      if (count + increment > maxDevices) throw new RegistryError(503, 'The Android device limit has been reached.', 'DEVICE_LIMIT');
      const generation = (existing?.credentialGeneration || 0) + 1;
      const token = `${deviceId}.${tokenSecret}`, digest = HASH(token), credentialRef = collections.credentials.doc(digest);
      if ((await tx.get(credentialRef)).exists) throw unavailable();
      const expiresAt = now + tokenTtlMs;
      const response = { deviceId, deviceToken: token, expiresAt };
      const binding = JSON.stringify({ operation: 'enrollment', codeHash, fingerprint, deviceId, generation });
      const row = { schema: 1, id: deviceId, installationId, tokenHash: digest, credentialGeneration: generation,
        fcmToken: registrationFcm, deviceLabel: label, createdAt: now, firstCreatedAt: existing?.firstCreatedAt || existing?.createdAt || now,
        updatedAt: now, tokenExpiresAt: expiresAt, revokedAt: 0, receiveCalls: true, receiveChats: true };

      if (existing) tx.set(collections.credentials.doc(existing.tokenHash), { deviceId, generation: existing.credentialGeneration, active: false, updatedAt: now });
      tx.set(deviceRef, row);
      tx.set(installationRef, { schema: 1, installationId, deviceId, updatedAt: now });
      tx.create(credentialRef, { schema: 1, deviceId, generation, active: true, createdAt: now, updatedAt: now });
      tx.set(invitationRef, { schema: 1, kind: invitation?.kind || 'bootstrap', createdAt: invitation?.createdAt || now,
        expiresAt: invitation?.expiresAt || now, consumedAt: now, revokedAt: 0, installationId, deviceId, generation,
        tokenHash: digest, fingerprint, recoveryBinding: binding, recoveryUntil: Math.min(now + RECOVERY_WINDOW_MS, expiresAt),
        recoveryEnvelope: sealRecovery(enrollmentCode, 'enrollment', binding, response, nonce) });
      writeGate(tx, count + increment, now);
      return response;
    }));
  }

  async function authenticate(rawToken) {
    const digest = bearerDigest(rawToken);
    return guarded(() => firestore.runTransaction(async tx => {
      const { row, index } = await readCredential(tx, digest);
      return validateCurrent(row, index, digest, nowMs());
    }));
  }

  async function updateToken(rawToken, patch = {}) {
    const digest = bearerDigest(rawToken), nextFcm = fcmToken(patch.fcmToken);
    if (!nextFcm) throw badInput('A valid Firebase token is required.');
    for (const key of ['receiveCalls', 'receiveChats', 'renewLease']) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw badInput(`A boolean ${key} value is required.`);
    return guarded(() => firestore.runTransaction(async tx => {
      const { row, index, reference } = await readCredential(tx, digest), now = nowMs();
      validateCurrent(row, index, digest, now);
      const next = { ...row, fcmToken: nextFcm, updatedAt: now };
      if (patch.receiveCalls !== undefined) next.receiveCalls = patch.receiveCalls;
      if (patch.receiveChats !== undefined) next.receiveChats = patch.receiveChats;
      if (patch.renewLease === true) next.tokenExpiresAt = Math.max(row.tokenExpiresAt, now + tokenTtlMs);
      tx.set(reference, next);
      return { deviceId: row.id, receiveCalls: next.receiveCalls, receiveChats: next.receiveChats, expiresAt: next.tokenExpiresAt };
    }));
  }

  async function renewLease(rawToken) {
    const digest = bearerDigest(rawToken);
    return guarded(() => firestore.runTransaction(async tx => {
      const { row, index, reference } = await readCredential(tx, digest), now = nowMs();
      validateCurrent(row, index, digest, now);
      const expiresAt = Math.max(row.tokenExpiresAt, now + tokenTtlMs);
      tx.set(reference, { ...row, tokenExpiresAt: expiresAt, updatedAt: now });
      return { deviceId: row.id, expiresAt };
    }));
  }

  async function rotateCredential(rawToken, { requestId } = {}) {
    const digest = bearerDigest(rawToken);
    if (!INSTALL_PATTERN.test(requestId || '')) throw badInput('A stable random rotation request ID is required.');
    const requestHash = HASH(requestId), operationId = HASH(`rotation:${digest}:${requestHash}`);
    const rotationRef = collections.rotations.doc(operationId);
    const tokenSecret = randomBytes(32).toString('base64url'), nonce = randomBytes(12);
    return guarded(() => firestore.runTransaction(async tx => {
      const now = nowMs(), { row, index, reference } = await readCredential(tx, digest);
      const rotationSnapshot = await tx.get(rotationRef), previous = rotationSnapshot.exists ? rotationSnapshot.data() : null;
      if (previous) {
        if (previous.schema === 1 && previous.recoveryUntil > now && previous.recoveryUntil <= previous.createdAt + RECOVERY_WINDOW_MS &&
            previous.deviceId === row?.id && previous.requestHash === requestHash && previous.oldTokenHash === digest &&
            isActive(row, now) && previous.generation === row.credentialGeneration && equal(previous.tokenHash || '', row.tokenHash)) {
          const recovered = openRecovery(rawToken, 'rotation', previous.recoveryBinding, previous.recoveryEnvelope);
          if (recovered.deviceId !== row.id || !TOKEN_PATTERN.test(recovered.deviceToken || '') || !equal(HASH(recovered.deviceToken), row.tokenHash)) throw unavailable();
          return { ...recovered, expiresAt: row.tokenExpiresAt, replayed: true };
        }
        throw unauthorized();
      }
      validateCurrent(row, index, digest, now);
      const token = `${row.id}.${tokenSecret}`, nextDigest = HASH(token), generation = row.credentialGeneration + 1;
      const nextIndex = collections.credentials.doc(nextDigest);
      if ((await tx.get(nextIndex)).exists) throw unavailable();
      const response = { deviceId: row.id, deviceToken: token, expiresAt: now + tokenTtlMs };
      const binding = JSON.stringify({ operation: 'rotation', deviceId: row.id, oldTokenHash: digest, requestHash, generation });
      tx.set(reference, { ...row, tokenHash: nextDigest, credentialGeneration: generation, tokenExpiresAt: response.expiresAt, updatedAt: now });
      tx.set(collections.credentials.doc(digest), { ...index, active: false, updatedAt: now });
      tx.create(nextIndex, { schema: 1, deviceId: row.id, generation, active: true, createdAt: now, updatedAt: now });
      tx.create(rotationRef, { schema: 1, deviceId: row.id, oldTokenHash: digest, tokenHash: nextDigest, requestHash, generation,
        createdAt: now, recoveryUntil: Math.min(now + RECOVERY_WINDOW_MS, response.expiresAt), recoveryBinding: binding,
        recoveryEnvelope: sealRecovery(rawToken, 'rotation', binding, response, nonce) });
      return response;
    }));
  }

  async function revokeInTransaction(tx, row, reference, now) {
    const snapshot = await tx.get(gate), count = await gateCount(tx, snapshot);
    tx.set(reference, { ...row, revokedAt: now, fcmToken: '', updatedAt: now });
    tx.set(collections.credentials.doc(row.tokenHash), { schema: 1, deviceId: row.id, generation: row.credentialGeneration, active: false, updatedAt: now });
    writeGate(tx, Math.max(0, count - 1), now);
    return { revoked: true };
  }
  async function revoke(rawToken) {
    const digest = bearerDigest(rawToken);
    return guarded(() => firestore.runTransaction(async tx => {
      const { row, index, reference } = await readCredential(tx, digest), now = nowMs();
      validateCurrent(row, index, digest, now);
      return revokeInTransaction(tx, row, reference, now);
    }));
  }
  /** Protected server-side admin action; permits revocation of an expired device. */
  async function revokeDevice(deviceId) {
    if (!ID_PATTERN.test(deviceId || '')) throw badInput('A valid device ID is required.');
    return guarded(() => firestore.runTransaction(async tx => {
      const reference = collections.devices.doc(deviceId), row = deviceRow(await tx.get(reference));
      if (!row || row.revokedAt) return { revoked: true };
      return revokeInTransaction(tx, row, reference, nowMs());
    }));
  }

  async function listDevices() {
    return guarded(async () => (await collections.devices.get()).docs.map(deviceRow));
  }
  async function getDevice(deviceId) {
    if (!ID_PATTERN.test(deviceId || '')) throw badInput('A valid device ID is required.');
    return guarded(async () => deviceRow(await collections.devices.doc(deviceId).get()));
  }
  async function clearFcmToken(deviceId, expectedFcmToken) {
    if (!ID_PATTERN.test(deviceId || '') || !fcmToken(expectedFcmToken)) throw badInput('A valid device and Firebase token are required.');
    return guarded(() => firestore.runTransaction(async tx => {
      const reference = collections.devices.doc(deviceId), row = deviceRow(await tx.get(reference));
      if (!row || row.fcmToken !== expectedFcmToken) return { cleared: false };
      tx.set(reference, { ...row, fcmToken: '', updatedAt: nowMs() });
      return { cleared: true };
    }));
  }

  function deliveryIdentity(input) {
    if (!ID_PATTERN.test(input.deviceId || '')) throw badInput('A valid device ID is required.');
    const isCall = input.callId !== undefined, isMessage = input.messageId !== undefined;
    if (isCall === isMessage) throw badInput('One exact call or message ID is required.');
    if (isCall) {
      if (!callId(input.callId) || !['incoming', 'ended'].includes(input.event)) throw badInput('A valid call event is required.');
      return { deviceId: input.deviceId, callId: input.callId, event: input.event };
    }
    const messageId = positiveId(input.messageId), channelId = positiveId(input.channelId);
    if (!messageId || !channelId || input.event !== 'message') throw badInput('A valid message event is required.');
    return { deviceId: input.deviceId, messageId, channelId, event: 'message' };
  }
  const deliveryIdFor = identity => HASH(JSON.stringify([identity.callId ? 'call' : 'message', identity.callId || identity.messageId, identity.event, identity.deviceId]));

  async function getDeliveries({ callId: exactCall, messageId: exactMessage } = {}) {
    if ((exactCall !== undefined) === (exactMessage !== undefined)) throw badInput('One exact call or message ID is required.');
    const field = exactCall !== undefined ? 'callId' : 'messageId';
    const value = field === 'callId' ? callId(exactCall) : positiveId(exactMessage);
    if (!value) throw badInput('A valid call or message ID is required.');
    return guarded(async () => (await collections.deliveries.where(field, '==', value).get()).docs.map(snapshot => ({ ...snapshot.data(), deliveryId: snapshot.id })));
  }

  async function claimDelivery(input = {}) {
    const identity = deliveryIdentity(input), deliveryId = deliveryIdFor(identity), reference = collections.deliveries.doc(deliveryId);
    if (!safeInteger(input.expiresAtMs)) throw badInput('A valid delivery expiration is required.');
    const claimId = randomUUID();
    return guarded(() => firestore.runTransaction(async tx => {
      const now = nowMs();
      if (input.expiresAtMs <= now) return { claimed: false, reason: 'expired', deliveryId };
      if (input.expiresAtMs > now + 5 * 60000) throw badInput('Notification lifetime exceeds five minutes.');
      const row = deviceRow(await tx.get(collections.devices.doc(identity.deviceId)));
      if (!isActive(row, now) || !row.fcmToken) return { claimed: false, reason: 'device_unavailable', deliveryId };
      if ((identity.event === 'incoming' && !row.receiveCalls) || (identity.event === 'message' && !row.receiveChats)) return { claimed: false, reason: 'opted_out', deliveryId };
      const previousSnapshot = await tx.get(reference), previous = previousSnapshot.exists ? previousSnapshot.data() : null;
      if (previous && (previous.schema !== 1 || previous.deviceId !== identity.deviceId || previous.event !== identity.event)) throw unavailable();
      if (previous?.state === 'sent' || previous?.sentAt > 0 || previous?.state === 'cancelled') return { claimed: false, reason: 'already_finished', deliveryId };
      if (previous?.state === 'claimed' && previous.claimUntilMs > now) return { claimed: false, reason: 'in_progress', deliveryId };
      if (identity.callId) {
        const opposite = { ...identity, event: identity.event === 'incoming' ? 'ended' : 'incoming' };
        const oppositeSnapshot = await tx.get(collections.deliveries.doc(deliveryIdFor(opposite)));
        if (identity.event === 'incoming' && oppositeSnapshot.exists) return { claimed: false, reason: 'call_ended', deliveryId };
        if (identity.event === 'ended' && !oppositeSnapshot.exists) return { claimed: false, reason: 'not_previously_alerted', deliveryId };
      }
      const next = { schema: 1, ...identity, state: 'claimed', claimId, claimUntilMs: now + deliveryLeaseMs,
        expiresAtMs: input.expiresAtMs, createdAt: previous?.createdAt || now, updatedAt: now, sentAt: 0,
        attempts: (previous?.attempts || 0) + 1 };
      tx.set(reference, next);
      return { claimed: true, claimId, deliveryId, claimUntilMs: next.claimUntilMs, device: row };
    }));
  }

  async function finishDelivery({ deliveryId, claimId, outcome } = {}) {
    if (!HASH_PATTERN.test(deliveryId || '') || typeof claimId !== 'string' || !/^[a-f0-9-]{36}$/.test(claimId) || !['sent', 'failed', 'cancelled'].includes(outcome)) throw badInput('A valid delivery claim and outcome are required.');
    return guarded(() => firestore.runTransaction(async tx => {
      const reference = collections.deliveries.doc(deliveryId), snapshot = await tx.get(reference);
      if (!snapshot.exists) return { finished: false };
      const row = snapshot.data();
      if (row.state !== 'claimed' || row.claimId !== claimId) return { finished: false };
      const now = nowMs();
      tx.set(reference, { ...row, state: outcome, claimUntilMs: 0, updatedAt: now, sentAt: outcome === 'sent' ? now : 0 });
      return { finished: true };
    }));
  }

  /**
   * Call from a protected maintenance job, separately from history deletion.
   * Removes only expired encrypted replay material. Consumed invitation hashes
   * and inactive credential indexes remain so an old bootstrap code cannot revive.
   */
  async function pruneExpiredRecoveries({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw badInput('A bounded recovery cleanup limit is required.');
    return guarded(async () => {
      let cleared = 0;
      for (const name of ['enrollments', 'rotations']) {
        const now = nowMs();
        const candidates = await collections[name].where('recoveryUntil', '>', 0).where('recoveryUntil', '<=', now).limit(limit).get();
        for (const snapshot of candidates.docs) {
          cleared += await firestore.runTransaction(async tx => {
            const currentSnapshot = await tx.get(snapshot.ref);
            const row = currentSnapshot.exists ? currentSnapshot.data() : null;
            if (!row || !row.recoveryUntil || row.recoveryUntil > nowMs()) return 0;
            tx.set(snapshot.ref, { ...row, recoveryUntil: 0, recoveryEnvelope: null, recoveryBinding: '' });
            return 1;
          });
        }
      }
      return { cleared };
    });
  }

  return Object.freeze({
    version: FIRESTORE_REGISTRY_VERSION, collectionPrefix,
    checkAvailability, isEnrollmentAvailable, issueEnrollment, enroll, authenticate, updateToken, renewLease,
    rotateCredential, revoke, revokeDevice, listDevices, getDevice, clearFcmToken,
    getDeliveries, claimDelivery, finishDelivery, pruneExpiredRecoveries
  });
}
