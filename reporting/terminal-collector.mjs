import { sessionStoreKey } from '../media-store/firestore-media-store.mjs';
import { callStoreKey } from '../media/transfer-controller.mjs';
import { callReportFromSettled, digest, id, externalId, time, guarded, unavailable, requireValue } from './schema.mjs';

/** Read-only bounded projection source. Requires a single field index exception
 * for media session `data.terminal.endedAt`; does not index private SDP. */
export function createFirestoreTerminalReportSource({ firestore, collectionPrefix = 'sh_operator_media',
  tenantId = 'smart-handicrafts', clock = Date.now } = {}) {
  requireValue(firestore?.collection && /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(collectionPrefix) && id(tenantId),
    'INVALID_REPORT_SOURCE', 'A private media-session source is required.');
  const sessions = firestore.collection(`${collectionPrefix}_sessions`);
  async function page({ cursor = null, limit = 16 } = {}) {
    requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 32 &&
      (!cursor || /^[a-f0-9]{64}$/.test(cursor.documentId) && time(cursor.endedAtMs)), 'INVALID_REPORT_CURSOR', 'Use a bounded terminal-session cursor.');
    return guarded(async () => {
      let query = sessions.where('data.terminal.endedAt', '<=', clock()).orderBy('data.terminal.endedAt', 'asc').limit(limit);
      if (cursor) {
        const snapshot = await sessions.doc(cursor.documentId).get();
        if (!snapshot.exists || snapshot.data()?.data?.terminal?.endedAt !== cursor.endedAtMs) throw unavailable();
        query = query.startAfter(snapshot);
      }
      const result = await query.get();
      const sessionIds = result.docs.map(snapshot => {
        const row = snapshot.data(), value = row?.data;
        if (row.schema !== 1 || value?.tenantId !== tenantId || !externalId(value.id) || !time(value.terminal?.endedAt) ||
            row.key !== sessionStoreKey(value.id) || row.key.split('/')[1] !== snapshot.id) throw unavailable();
        return value.id;
      });
      const last = result.docs.at(-1);
      return { sessionIds, nextCursor: last ? { documentId: last.id, endedAtMs: last.data().data.terminal.endedAt } : cursor,
        hasMore: result.size === limit };
    });
  }
  return Object.freeze({ page });
}

export function createTerminalReportCollector({ mediaStore, reportStore, source = null } = {}) {
  requireValue(mediaStore?.durable === true && reportStore?.durable === true, 'INVALID_REPORT_CONFIG', 'Durable media and report stores are required.');
  async function collectSession(sessionId) {
    const session = await mediaStore.get(sessionStoreKey(sessionId));
    if (!session || session.tenantId !== reportStore.tenantId || session.terminal?.nativeOnly) {
      await reportStore.setDeferred(sessionId, false); return { status: 'ignored' };
    }
    // Never turn active or unconfirmed signaling into finalized history.
    if (!session.terminal) return { status: 'active' };
    const call = session.providerCallId ? await mediaStore.get(callStoreKey(session.providerCallId)) : null;
    let record;
    try { record = callReportFromSettled({ session, call, operatorLabel: session.operatorLabel || '' }); }
    catch (error) {
      if (error.code !== 'CALL_NOT_SETTLED') throw error;
      await reportStore.setDeferred(sessionId, true); return { status: 'deferred' };
    }
    const result = await reportStore.append(record);
    const transfers = new Map([...Object.values(call?.transferHistory || {}), ...(call?.transfer ? [call.transfer] : [])].map(row => [row.id, row]));
    let activitiesCreated = 0;
    for (const transfer of transfers.values()) {
      if (transfer.status !== 'completed') continue;
      const eventId = `transfer_${digest({ callId: record.data.callId, transferId: transfer.id })}`;
      const activity = await reportStore.append({ kind: 'activity', recordId: eventId, data: { eventId, callId: record.data.callId,
        eventType: 'call_transfer', occurredAtMs: transfer.completedAt || transfer.updatedAt || record.data.endedAtMs,
        operatorLabel: '', status: 'completed', summary: `Transferred from ${transfer.fromDeviceId} to ${transfer.toDeviceId}` } });
      if (activity.created) activitiesCreated++;
    }
    await reportStore.setDeferred(sessionId, false);
    return { status: result.created ? 'created' : 'exists', activitiesCreated };
  }
  async function scan({ workerId, limit = 16 } = {}) {
    requireValue(source?.page && id(workerId) && Number.isInteger(limit) && limit >= 1 && limit <= 32,
      'INVALID_REPORT_SOURCE', 'A bounded terminal source and worker identity are required.');
    const claim = await reportStore.claimCollection(workerId);
    if (!claim) return { busy: true, processed: 0 };
    let nextCursor = claim.cursor;
    const results = [];
    try {
      const [page, deferred] = await Promise.all([source.page({ cursor: claim.cursor, limit }), reportStore.deferredSessions(limit)]);
      for (const sessionId of new Set([...deferred, ...page.sessionIds])) results.push({ sessionId, ...await collectSession(sessionId) });
      nextCursor = page.nextCursor;
      return { busy: false, processed: results.length, hasMore: page.hasMore, results };
    } finally { await reportStore.finishCollection(claim, nextCursor); }
  }
  return Object.freeze({ collectSession, scan });
}
