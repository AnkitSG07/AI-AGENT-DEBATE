import { createHash } from 'node:crypto';

export const DAY_MS = 86400000;
export const KINDS = Object.freeze(['calls', 'activity']);
export const MAX_ROWS = 250;
export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const clone = value => structuredClone(value);
export const isObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export const time = value => Number.isSafeInteger(value) && value >= 0;
export const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,220}$/.test(value);
export const externalId = value => typeof value === 'string' && value.length > 0 && value.length <= 220 && !/[\u0000-\u001f\u007f]/.test(value);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export class ReportError extends Error {
  constructor(code, message, statusCode = 409) { super(message); Object.assign(this, { name: 'ReportError', code, statusCode, reportError: true }); }
}
export const requireValue = (value, code, message, status = 400) => { if (!value) throw new ReportError(code, message, status); };
export const unavailable = () => new ReportError('REPORT_STORAGE_UNAVAILABLE', 'Report storage is temporarily unavailable.', 503);
export async function guarded(operation) { try { return await operation(); } catch (error) { if (error instanceof ReportError) throw error; throw unavailable(); } }
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new ReportError('INVALID_REPORT', 'Reports accept finite JSON values only.', 400);
}
export const digest = value => sha256(canonical(value));
const string = (value, maximum, label) => {
  requireValue(typeof value === 'string' && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'INVALID_REPORT', `${label} must be bounded text.`);
  return value;
};
const known = (data, keys) => requireValue(isObject(data) && Object.keys(data).every(key => keys.includes(key)), 'INVALID_REPORT', 'Only explicitly allowed report fields may be stored.');

export function normalizeRecord({ kind, recordId, data, tenantId, createdAtMs }) {
  requireValue(KINDS.includes(kind) && externalId(recordId) && id(tenantId) && time(createdAtMs), 'INVALID_REPORT', 'A known report type and exact IDs are required.');
  let normalized, occurredAtMs;
  if (kind === 'calls') {
    known(data, ['callId', 'direction', 'customerName', 'customerPhone', 'startedAtMs', 'connectedAtMs', 'endedAtMs',
      'outcome', 'operatorLabel', 'operatorDeviceId', 'transferCount']);
    requireValue(externalId(data.callId) && ['incoming', 'outgoing'].includes(data.direction) &&
      ['completed', 'missed', 'rejected', 'failed', 'cancelled'].includes(data.outcome) &&
      time(data.startedAtMs) && time(data.endedAtMs) && data.endedAtMs >= data.startedAtMs &&
      (data.connectedAtMs === null || time(data.connectedAtMs) && data.connectedAtMs >= data.startedAtMs && data.connectedAtMs <= data.endedAtMs) &&
      Number.isSafeInteger(data.transferCount) && data.transferCount >= 0 && data.transferCount <= 64,
    'INVALID_REPORT', 'Only finalized call outcomes and valid timestamps may be reported.');
    normalized = { callId: data.callId, direction: data.direction, customerName: string(data.customerName || '', 160, 'Customer name'),
      customerPhone: string(data.customerPhone || '', 32, 'Customer phone'), startedAtMs: data.startedAtMs, connectedAtMs: data.connectedAtMs,
      endedAtMs: data.endedAtMs, outcome: data.outcome, operatorLabel: string(data.operatorLabel || '', 120, 'Operator label'),
      operatorDeviceId: string(data.operatorDeviceId || '', 220, 'Device ID'), transferCount: data.transferCount,
      durationSeconds: data.connectedAtMs === null ? 0 : Math.floor((data.endedAtMs - data.connectedAtMs) / 1000) };
    occurredAtMs = data.endedAtMs;
  } else {
    known(data, ['eventId', 'callId', 'eventType', 'occurredAtMs', 'operatorLabel', 'status', 'summary']);
    requireValue(externalId(data.eventId) && (data.callId === null || externalId(data.callId)) &&
      ['call_transfer', 'notification_delivery', 'operator_action'].includes(data.eventType) && time(data.occurredAtMs),
    'INVALID_REPORT', 'A finalized operational event is required.');
    normalized = { eventId: data.eventId, callId: data.callId, eventType: data.eventType, occurredAtMs: data.occurredAtMs,
      operatorLabel: string(data.operatorLabel || '', 120, 'Operator label'), status: string(data.status || '', 40, 'Event status'),
      summary: string(data.summary || '', 512, 'Event summary') };
    occurredAtMs = data.occurredAtMs;
  }
  const core = { schema: 1, kind, recordId, tenantId, immutable: true, finalized: true, occurredAtMs, createdAtMs, data: normalized };
  requireValue(Buffer.byteLength(canonical(core)) <= 8192, 'REPORT_LIMIT', 'A report record exceeded its size limit.');
  return { ...core, fingerprint: digest(core) };
}

export function validateRecord(row, { kind, tenantId, documentId } = {}) {
  if (!row || row.schema !== 1 || row.kind !== kind || row.tenantId !== tenantId || !externalId(row.recordId) ||
      row.immutable !== true || row.finalized !== true || !time(row.occurredAtMs) || !time(row.createdAtMs) || !isObject(row.data)) throw unavailable();
  const { fingerprint, ...core } = row;
  if (fingerprint !== digest(core) || documentId !== recordDocumentId(row)) throw unavailable();
  const data = clone(row.data); if (kind === 'calls') delete data.durationSeconds;
  const expected = normalizeRecord({ kind, recordId: row.recordId, data, tenantId, createdAtMs: row.createdAtMs });
  if (expected.fingerprint !== fingerprint) throw unavailable();
  return row;
}
export const recordDocumentId = row => digest({ tenantId: row.tenantId, kind: row.kind, recordId: row.recordId });

export function reportRefs(rows) {
  return rows.map(row => ({ kind: row.kind, documentId: recordDocumentId(row), recordId: row.recordId,
    fingerprint: row.fingerprint, contentHash: digest(row.data), occurredAtMs: row.occurredAtMs }));
}

/** Trusted terminal-summary mapper: private media/auth/SDP fields are never copied. */
export function callReportFromSettled({ session, call = null, operatorLabel = '' }) {
  const terminal = call?.terminal || session?.terminal;
  requireValue(session && !session.terminal?.nativeOnly && terminal?.confirmedAt &&
    (!call || call.active === false) && (session.outbox || []).every(job => job.kind === 'notify' || job.status === 'done') &&
    (!call || (call.outbox || []).every(job => job.status === 'done')) &&
    !Object.values(session.operations || {}).some(operation => ['issued', 'uncertain'].includes(operation.status)),
  'CALL_NOT_SETTLED', 'A call must have confirmed termination and finished cleanup before its immutable report is finalized.', 409);
  const connectedAtMs = session.mediaReadyAt ?? null;
  const reason = session.terminal?.reason || terminal.policyReason || terminal.reason;
  const outcome = connectedAtMs !== null ? 'completed' : reason === 'REJECTED' ? 'rejected' :
    reason === 'FAILED' ? 'failed' : reason === 'TIMED_OUT' || session.direction === 'incoming' && reason === 'USER_INITIATED' ? 'missed' : 'cancelled';
  const historical = Object.values(call?.transferHistory || {}), current = call?.transfer;
  const transfers = new Map([...historical, ...(current ? [current] : [])].map(transfer => [transfer.id, transfer]));
  return { kind: 'calls', recordId: session.providerCallId || session.id,
    data: { callId: session.providerCallId || session.id, direction: session.direction,
      customerName: session.customerName || '', customerPhone: session.customerPhone || '', startedAtMs: session.createdAt,
      connectedAtMs, endedAtMs: terminal.endedAt, outcome, operatorLabel, operatorDeviceId: call?.owner?.deviceId || session.owner?.deviceId || '',
      transferCount: [...transfers.values()].filter(transfer => transfer.status === 'completed').length } };
}
