import { createHash } from 'node:crypto';
import { requireValue } from '../media/errors.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const callPrefix = id => `sh-call-v1-${hash(id)}-`;
const parse = row => {
  try { return JSON.parse(Buffer.from(row.datas || '', 'base64').toString('utf8')); }
  catch { return null; }
};

/** Private Odoo attachments, only accessed through the enrolled call API.
 * No public attachment URLs, Firebase audio, per-keystroke writes or AI. */
export class OdooCallFiles {
  constructor({ execute, now = Date.now }) { this.execute = execute; this.now = now; this.pending = new Map(); this.locks = new Map(); }
  async serial(key, operation) {
    const work = (this.locks.get(key) || Promise.resolve()).catch(() => {}).then(operation);
    this.locks.set(key, work);
    try { return await work; } finally { if (this.locks.get(key) === work) this.locks.delete(key); }
  }
  async rows(prefix, fields = ['id', 'name', 'datas'], limit = 100) {
    return this.execute('ir.attachment', 'search_read', [[['name', '=like', `${prefix}%`], ['public', '=', false]]],
      { fields, limit, order: 'id desc' });
  }
  async once(name, operation) {
    if (this.pending.has(name)) return this.pending.get(name);
    const work = Promise.resolve().then(operation);
    this.pending.set(name, work);
    try { return await work; } finally { if (this.pending.get(name) === work) this.pending.delete(name); }
  }
  async put(name, bytes, mimetype, description = '', expectedJson = null) {
    return this.once(name, async () => {
      const rows = await this.rows(name, expectedJson ? ['id', 'name', 'datas'] : ['id', 'name'], 3);
      const existing = rows.find(row => row.name === name);
      if (existing) {
        if (expectedJson) {
          const prior = parse(existing);
          requireValue(prior && Object.entries(expectedJson).every(([key, value]) => prior[key] === value),
            'NOTE_SAVE_CONFLICT', 'This save identity was already used for a different note. Try saving again.', 409);
        }
        return existing.id;
      }
      return this.execute('ir.attachment', 'create', [{ name, type: 'binary', public: false,
        mimetype, datas: Buffer.from(bytes).toString('base64'), description }]);
    });
  }
  async notes(callId) {
    const rows = await this.rows(`${callPrefix(callId)}note-`, undefined, 80);
    const latest = new Map();
    for (const row of rows) {
      const note = parse(row);
      if (note?.callId !== callId || typeof note.noteId !== 'string' || latest.has(note.noteId)) continue;
      latest.set(note.noteId, { id: note.noteId, text: String(note.text || '').slice(0, 4000),
        updatedAt: note.updatedAt, deviceId: note.deviceId });
    }
    return [...latest.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  }
  async saveNote(callId, actor, { text, noteId, requestId }) {
    requireValue(typeof text === 'string' && text.length <= 4000 && text.trim().length > 0,
      'INVALID_NOTE', 'Write a note of up to 4,000 characters.', 400);
    for (const id of [noteId, requestId]) requireValue(typeof id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(id),
      'INVALID_REQUEST_ID', 'The note needs a stable save identity.', 400);
    const prefix = `${callPrefix(callId)}note-${hash(noteId)}-`;
    return this.serial(prefix, async () => {
      const current = parse((await this.rows(prefix, undefined, 1))[0] || {});
      requireValue(!current || current.deviceId === actor.deviceId,
        'NOTE_OWNER_REQUIRED', 'Only the author can edit this note. Add your own note instead.', 403);
      const fields = { callId, noteId, text: text.trim(), deviceId: actor.deviceId };
      const body = { ...fields, updatedAt: this.now() };
      await this.put(`${prefix}${hash(requestId)}.json`, JSON.stringify(body), 'application/json', '', fields);
      return this.notes(callId);
    });
  }
  async beginRecording(callId, recordingId, metadata) {
    await this.put(`${callPrefix(callId)}record-${recordingId}.json`, JSON.stringify({ callId, recordingId, ...metadata }), 'application/json');
  }
  async recordingMetadata(callId, recordingId) {
    const name = `${callPrefix(callId)}record-${recordingId}.json`;
    const row = (await this.rows(name, undefined, 3)).find(row => row.name === name);
    const value = row && parse(row);
    return value?.callId === callId && value.recordingId === recordingId ? value : null;
  }
  async saveDevicePart(callId, recordingId, deviceId, metadata, pcm) {
    const { segmentId, index, capturedAt } = metadata;
    const suffix = `${String(capturedAt).padStart(13, '0')}-${hash(deviceId + ':' + segmentId).slice(0, 24)}-${String(index).padStart(6, '0')}`;
    const name = `${callPrefix(callId)}audio-${recordingId}-${suffix}.wav`;
    const description = JSON.stringify({ mode: 'device', deviceId, ...metadata, sha256: hash(pcm.toString('base64')) });
    // Retry the exact immutable bytes. Never silently overwrite a segment.
    return this.serial(name, async () => {
      const old = (await this.rows(name, ['id', 'name', 'description'], 3)).find(row => row.name === name);
      if (old) {
        requireValue(old.description === description, 'RECORDING_PART_CONFLICT', 'Recording segment conflicts with an earlier upload.', 409);
        return old.id;
      }
      return this.put(name, Buffer.concat([wavHeader(pcm.length), pcm]), 'audio/wav', description);
    });
  }
  async savePart(callId, recordingId, index, pcm) {
    requireValue(Buffer.isBuffer(pcm) && pcm.length > 0 && pcm.length <= 1920000 && pcm.length % 2 === 0,
      'INVALID_RECORDING_PART', 'Invalid recording audio.', 400);
    const name = `${callPrefix(callId)}audio-${recordingId}-${String(index).padStart(6, '0')}.wav`;
    return this.put(name, Buffer.concat([wavHeader(pcm.length), pcm]), 'audio/wav');
  }
  async recordings(callId) {
    const [records, parts] = await Promise.all([
      this.rows(`${callPrefix(callId)}record-`, undefined, 30),
      this.rows(`${callPrefix(callId)}audio-`, ['id', 'name', 'file_size'], 500)
    ]);
    return records.map(parse).filter(record => record?.callId === callId).map(record => ({
      id: record.recordingId, startedAt: record.startedAt, deviceId: record.deviceId, mode: record.mode || 'server',
      parts: parts.filter(part => part.name.startsWith(`${callPrefix(callId)}audio-${record.recordingId}-`))
        .sort((a, b) => a.name.localeCompare(b.name)).map(part => ({ id: part.id, bytes: part.file_size,
          durationSeconds: Math.max(0, (part.file_size - 44) / 32000) }))
    }));
  }
  async recent() {
    const rows = await this.execute('ir.attachment', 'search_read', [[['name', '=like', 'sh-call-v1-%'],
      ['mimetype', '=', 'application/json'], ['public', '=', false]]],
    { fields: ['id', 'datas'], limit: 80, order: 'id desc' });
    const unique = new Map();
    for (const row of rows) {
      const item = parse(row);
      if (item?.callId && !unique.has(item.callId)) unique.set(item.callId,
        { callId: item.callId, updatedAt: item.startedAt || item.updatedAt || 0 });
    }
    return [...unique.values()].slice(0, 30);
  }
  async audio(callId, recordingId, attachmentId) {
    requireValue(/^[a-zA-Z0-9_-]{8,100}$/.test(recordingId) && Number.isSafeInteger(attachmentId) && attachmentId > 0,
      'RECORDING_NOT_FOUND', 'Recording not found.', 404);
    const rows = await this.execute('ir.attachment', 'read', [[attachmentId], ['id', 'name', 'datas', 'public', 'mimetype']]);
    const row = rows?.[0];
    requireValue(row?.id === attachmentId && row.public === false && row.mimetype === 'audio/wav' &&
      row.name.startsWith(`${callPrefix(callId)}audio-${recordingId}-`),
      'RECORDING_NOT_FOUND', 'Recording not found.', 404);
    const bytes = Buffer.from(row.datas || '', 'base64');
    requireValue(bytes.length >= 44 && bytes.length <= 1920044 && bytes.toString('ascii', 0, 4) === 'RIFF',
      'RECORDING_UNAVAILABLE', 'The saved audio is unavailable.', 503);
    return bytes;
  }
}

export function wavHeader(length) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(length + 36, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(length, 40);
  return buffer;
}
