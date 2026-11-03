import { createHash } from 'node:crypto';
import { requireValue } from '../media/errors.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const parse = row => { try { return JSON.parse(Buffer.from(row.datas, 'base64').toString()); } catch { return null; } };
export function monthlySlices(startedAt, durationMs) {
  const slices = []; const end = startedAt + Math.max(10000, durationMs);
  for (let at = startedAt; at < end;) {
    const date = new Date(at), boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const until = Math.min(end, boundary);
    slices.push({ month: date.toISOString().slice(0, 7), milliseconds: until - at }); at = until;
  }
  return slices;
}

/** Cumulative connection observations, not one billable session per upload.
 * Stored in private Odoo attachments; no polling or Firestore usage counter. */
export class MediaUsage {
  constructor({ files, project, now = Date.now }) { this.files = files; this.project = hash(project || 'default').slice(0, 24); this.now = now; }
  async record(connectionId, body, source = 'phone') {
    const { startedAt, durationMs } = body;
    requireValue(Number.isSafeInteger(startedAt) && startedAt > 0 && startedAt <= this.now() + 120000 &&
      startedAt >= this.now() - 8 * 86400000 && Number.isSafeInteger(durationMs) && durationMs >= 0 && durationMs <= 8 * 3600000 &&
      startedAt + durationMs <= this.now() + 120000,
      'INVALID_MEDIA_USAGE', 'Invalid media usage observation.', 400);
    for (const slice of monthlySlices(startedAt, durationMs)) {
      const name = `sh-media-usage-v1-${this.project}-${slice.month}-${hash(connectionId)}.json`;
      await this.files.serial(name, async () => {
        const row = (await this.files.rows(name, ['id', 'name', 'datas'], 3)).find(row => row.name === name);
        const old = row && parse(row);
        requireValue(!old || old.startedAt === startedAt, 'MEDIA_USAGE_CONFLICT', 'A connection start cannot change.', 409);
        if (old && old.milliseconds >= slice.milliseconds) return;
        const value = { ...slice, startedAt, source, updatedAt: this.now(), project: this.project };
        if (row) await this.files.execute('ir.attachment', 'write', [[row.id], { datas: Buffer.from(JSON.stringify(value)).toString('base64') }]);
        else await this.files.put(name, JSON.stringify(value), 'application/json');
      });
    }
    return { saved: true };
  }
  async summary() {
    const month = new Date(this.now()).toISOString().slice(0, 7);
    const rows = await this.files.rows(`sh-media-usage-v1-${this.project}-${month}-`, undefined, 5001);
    const values = rows.map(parse).filter(v => v?.month === month && v.project === this.project);
    const participantMinutes = Math.round(values.reduce((sum, v) => sum + v.milliseconds, 0) / 600) / 100;
    const firstObservedAt = values.length ? Math.min(...values.map(v => v.startedAt)) : null;
    return { month, timezone: 'UTC', participantMinutes, allowanceMinutes: 5000,
      percent: Math.round(participantMinutes / 50), remainingMinutes: Math.max(0, 5000 - participantMinutes),
      firstObservedAt, observations: values.length, partial: true, truncated: rows.length > 5000,
      dataAllowanceGB: 50, dataUsageGB: null, source: 'SH Chat connection estimates',
      notice: 'Estimated phone, media-worker and customer minutes. Customer timing starts when the call is registered. Earlier usage, unupdated devices, browser calls and delayed uploads may be missing. Verify total minutes and data in LiveKit Cloud.' };
  }
}
