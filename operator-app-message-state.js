// Team-wide SH Chat read state. Odoo website read flags never enter this ledger.
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const copy = value => structuredClone(value);
const MAX_PENDING = 10000, MAX_RECENT = 512;
const stateError = (status, code) => Object.assign(new Error('SH Chat message state is temporarily unavailable.'), { status, code, registryError: true });

export function createAppMessageState({ firestore, collectionPrefix, clock = Date.now, makeError = stateError }) {
  const error = makeError;
  const collection = firestore.collection(`${collectionPrefix}_app_messages`);
  const blank = channelId => ({ schema: 1, stateVersion: 0, channelId, latestMessageId: 0, readThroughMessageId: 0,
    pendingIds: [], seenIds: [], replayFloor: 0, overflow: false, manualUnread: false, updatedAt: 0 });
  const row = (snapshot, channelId) => {
    if (!snapshot.exists) return blank(channelId);
    const value = snapshot.data();
    if (!value || value.schema !== 1 || value.channelId !== channelId || !Array.isArray(value.pendingIds) || value.pendingIds.length > MAX_PENDING ||
        !Array.isArray(value.seenIds) || value.seenIds.length > MAX_RECENT ||
        !Number.isSafeInteger(value.latestMessageId) || !Number.isSafeInteger(value.readThroughMessageId) ||
        !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 0 ||
        value.latestMessageId < 0 || value.readThroughMessageId < 0 || value.readThroughMessageId > value.latestMessageId ||
        !Number.isSafeInteger(value.replayFloor) || value.replayFloor < 0 ||
        typeof value.manualUnread !== 'boolean' || typeof value.overflow !== 'boolean' ||
        !value.pendingIds.every(id => Number.isSafeInteger(id) && id > value.readThroughMessageId) ||
        !value.seenIds.every(id => Number.isSafeInteger(id) && id > 0)) throw error(503, 'APP_MESSAGE_STATE_UNAVAILABLE');
    return copy(value);
  };
  const projection = value => ({ channelId: value.channelId, stateVersion: value.stateVersion, latestMessageId: value.latestMessageId,
    readThroughMessageId: value.readThroughMessageId,
    unreadCount: Math.max(value.pendingIds.length, value.overflow || value.manualUnread ? 1 : 0) });
  const id = value => { const result = positive(value); if (!result || result > 2147483647) throw error(400, 'INVALID_CHANNEL_ID'); return result; };
  const observe = async ({ channelId, messageIds }) => {
    channelId = id(channelId);
    if (!Array.isArray(messageIds) || messageIds.length > 100 || !messageIds.every(positive)) throw error(400, 'INVALID_MESSAGE_IDS');
    return firestore.runTransaction(async tx => {
      const ref = collection.doc(String(channelId)), value = row(await tx.get(ref), channelId);
      const seen = new Set(value.seenIds), pending = new Set(value.pendingIds); let changed = false;
      for (const raw of [...messageIds].map(Number).sort((a,b) => a-b)) {
        if (seen.has(raw) || raw <= value.replayFloor) continue;
        changed = true; seen.add(raw); value.latestMessageId = Math.max(value.latestMessageId, raw);
        if (raw > value.readThroughMessageId) pending.add(raw);
      }
      if (!changed) return projection(value);
      value.seenIds = [...seen].sort((a,b) => a-b);
      while (value.seenIds.length > MAX_RECENT) value.replayFloor = Math.max(value.replayFloor, value.seenIds.shift());
      value.pendingIds = [...pending].sort((a,b) => a-b);
      if (value.pendingIds.length > MAX_PENDING) { value.pendingIds = value.pendingIds.slice(-MAX_PENDING); value.overflow = true; }
      value.updatedAt = clock(); value.stateVersion++; tx.set(ref, value); return projection(value);
    });
  };
  const list = async channelIds => {
    if (!Array.isArray(channelIds) || channelIds.length > 100) throw error(400, 'INVALID_CHANNEL_IDS');
    const ids = [...new Set(channelIds.map(id))];
    if (!ids.length) return [];
    return firestore.runTransaction(async tx => {
      const refs = ids.map(value => collection.doc(String(value)));
      const snapshots = typeof tx.getAll === 'function' ? await tx.getAll(...refs) : await Promise.all(refs.map(ref => tx.get(ref)));
      return ids.map((value, index) => projection(row(snapshots[index], value)));
    }, { readOnly: true });
  };
  // Authorization callback runs within this same transaction before its writes.
  const change = async ({ channelId, throughMessageId, unread = false, expectedStateVersion }, authorize) => {
    channelId = id(channelId);
    if (!unread && !positive(throughMessageId)) throw error(400, 'INVALID_MESSAGE_ID');
    if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) throw error(400, 'INVALID_STATE_VERSION');
    return firestore.runTransaction(async tx => {
      if (authorize) await authorize(tx);
      const ref = collection.doc(String(channelId)), value = row(await tx.get(ref), channelId);
      if (expectedStateVersion !== value.stateVersion) throw error(409, 'APP_MESSAGE_STATE_CHANGED');
      if (unread) value.manualUnread = true;
      else {
        const through = Math.min(Number(throughMessageId), value.latestMessageId);
        value.readThroughMessageId = Math.max(value.readThroughMessageId, through);
        value.pendingIds = value.pendingIds.filter(messageId => messageId > value.readThroughMessageId);
        if (value.readThroughMessageId >= value.latestMessageId) value.overflow = false;
        value.manualUnread = false;
      }
      value.updatedAt = clock(); value.stateVersion++; tx.set(ref, value); return projection(value);
    });
  };
  return { observe, list, change };
}
