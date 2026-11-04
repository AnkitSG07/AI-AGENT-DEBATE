// A temporary source-side bridge for an online storage migration. Every app
// mutation and its after-image journal record commit in the SAME Firestore
// transaction. This module never sends records to an HTTP client or logs them.
import { createHash, randomUUID } from 'node:crypto';
import { encodeCloudflareValue } from './operator-cloudflare-client.js';

const rawReference = Symbol('sourceReference');
const sourceCollection = Symbol('sourceCollection');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const fail = code => Object.assign(new Error('Storage migration coordination is temporarily unavailable.'), { code, storageMigrationError: true, status: 503 });
const clone = value => value instanceof Date ? new Date(value.getTime())
  : value instanceof Uint8Array ? Buffer.from(value)
  : Array.isArray(value) ? value.map(clone)
  : plain(value) ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)]))
  : value; // SDK Timestamp values are immutable; retain their supported type.
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
export const storageJournalHash = value => createHash('sha256').update(canonical(value)).digest('hex');

// Reuse exactly the same byte and reserved-key codec as the target transport.
export const encodeStorageJournalValue = encodeCloudflareValue;

export function readStorageMigrationGate(snapshot) {
  if (!snapshot?.exists) return { schema: 1, mode: 'source', migrationId: '', epoch: 0 };
  const row = snapshot.data();
  if (!plain(row) || row.schema !== 1 || !['source', 'shadow', 'cloudflare'].includes(row.mode) ||
      !Number.isSafeInteger(row.epoch) || row.epoch < 0 || typeof row.migrationId !== 'string' ||
      (row.mode !== 'source' && !/^[A-Za-z0-9_-]{16,128}$/.test(row.migrationId))) throw fail('STORAGE_MIGRATION_GATE_INVALID');
  return row;
}

function applyUpdate(before, patch) {
  if (!plain(before) || !plain(patch) || !Object.keys(patch).length) throw fail('STORAGE_JOURNAL_INVALID_UPDATE');
  const value = clone(before);
  for (const [path, entry] of Object.entries(patch)) {
    const parts = path.split('.');
    if (parts.some(key => !key || ['__proto__', 'constructor', 'prototype'].includes(key))) throw fail('STORAGE_JOURNAL_INVALID_UPDATE');
    let parent = value;
    for (const key of parts.slice(0, -1)) { if (!plain(parent[key])) parent[key] = {}; parent = parent[key]; }
    parent[parts.at(-1)] = clone(entry);
  }
  return value;
}

export function createJournaledFirestore({ firestore, collectionPrefix = 'sh_operator', serverTimestamp,
  encodeValue = encodeStorageJournalValue, onGate = () => {}, maxWrites = 450, maxJournalBytes = 900 * 1024 } = {}) {
  if (!firestore?.collection || !firestore?.runTransaction || typeof serverTimestamp !== 'function' ||
      !/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(collectionPrefix) || !Number.isInteger(maxWrites) || maxWrites < 1 || maxWrites > 450 ||
      !Number.isInteger(maxJournalBytes) || maxJournalBytes < 1024 || maxJournalBytes > 950 * 1024) throw TypeError('Invalid source migration journal configuration.');
  const gatePath = `${collectionPrefix}_metadata/storage_migration`;
  const journalCollection = `${collectionPrefix}_migration_journal`;
  const gateRef = firestore.collection(`${collectionPrefix}_metadata`).doc('storage_migration');
  const scope = path => typeof path === 'string' && path.split('/').length === 2 &&
    path.split('/').every(part => part && part.length <= 1500 && !/[\u0000-\u001f\u007f]/.test(part)) &&
    path.split('/')[0].startsWith(collectionPrefix + '_') && path !== gatePath && path.split('/')[0] !== journalCollection;
  const unwrap = ref => {
    const raw = ref?.[rawReference],path=raw?.path||ref?.[sourceCollection];
    // SDK Query instances deliberately have no .path. Trust only the private
    // collection identity carried forward by this wrapper while chaining.
    if (!raw || !path || !(scope(path) || !path.includes('/') && path.startsWith(collectionPrefix + '_') && path !== journalCollection))
      throw fail('STORAGE_JOURNAL_REFERENCE_REQUIRED');
    return raw;
  };
  const assertWritableGate = async native => {
    const gate = readStorageMigrationGate(await native.get(gateRef));
    try { onGate({ mode: gate.mode, migrationId: gate.migrationId, epoch: gate.epoch }); } catch { /* observation only */ }
    if (gate.mode === 'cloudflare') throw fail('STORAGE_SOURCE_FENCED');
    return gate;
  };
  const snapshot = raw => {
    const value = { id: raw.id, exists: raw.exists, ref: document(raw.ref),
      updateTime: raw.updateTime, readTime: raw.readTime, data: () => raw.data() };
    Object.defineProperty(value, '__sourceSnapshot', { value: raw });
    return value;
  };
  const result = raw => raw?.docs ? { docs: raw.docs.map(snapshot), empty: raw.empty, size: raw.size,
    forEach(callback, thisArg) { this.docs.forEach(row => callback.call(thisArg, row)); } } : snapshot(raw);
  const read = reference => firestore.runTransaction(async native => { await assertWritableGate(native); return result(await native.get(reference)); }, { readOnly: true });
  function query(raw,collectionPath=raw.path) {
    const value = {
      [rawReference]: raw,[sourceCollection]:collectionPath,path:collectionPath,id:raw.id,
      get: () => read(raw),
      where: (...args) => query(raw.where(...args),collectionPath), orderBy: (...args) => query(raw.orderBy(...args),collectionPath),
      limit: (...args) => query(raw.limit(...args),collectionPath),
      startAfter: cursor => query(raw.startAfter(cursor?.ref?.[rawReference] ? cursor.__sourceSnapshot : cursor),collectionPath),
      doc: id => document(raw.doc(id || randomUUID().replaceAll('-', '')))
    };
    // A source watcher is a projection, never an authorization decision. Root
    // routing owns closing/recreating projections when the active store changes.
    if (typeof raw.onSnapshot === 'function') value.onSnapshot = (...args) => raw.onSnapshot(...args);
    return value;
  }
  function document(raw) {
    if (!raw?.path || !scope(raw.path)) throw fail('STORAGE_JOURNAL_PATH_OUTSIDE_SCOPE');
    const value = { [rawReference]: raw, id: raw.id, path: raw.path,
      get: () => read(raw),
      set: (data, options) => runTransaction(tx => { tx.set(value, data, options); }),
      create: data => runTransaction(tx => { tx.create(value, data); }),
      update: data => runTransaction(tx => { tx.update(value, data); }),
      delete: () => runTransaction(tx => { tx.delete(value); }) };
    if (typeof raw.onSnapshot === 'function') value.onSnapshot = (...args) => raw.onSnapshot(...args);
    return value;
  }
  async function runTransaction(callback, options = {}) {
    if (typeof callback !== 'function' || options?.readOnly !== undefined && typeof options.readOnly !== 'boolean') throw TypeError('A transaction callback is required.');
    const eventId = randomUUID().replaceAll('-', ''), eventRef = firestore.collection(journalCollection).doc(eventId);
    return firestore.runTransaction(async native => {
      const gate = await assertWritableGate(native), changes = [], initial = new Map(); let writing = false;
      const get = async reference => {
        if (writing) throw fail('STORAGE_JOURNAL_READS_BEFORE_WRITES');
        const raw = unwrap(reference), found = await native.get(raw);
        if (scope(raw.path)) initial.set(raw.path, found);
        const projected = result(found);
        return projected;
      };
      const write = (kind, reference, data, settings) => {
        if (options.readOnly) throw fail('STORAGE_JOURNAL_READ_ONLY');
        const raw = unwrap(reference);
        if (!scope(raw.path) || settings && (Object.keys(settings).length && !(Object.keys(settings).length === 1 && settings.merge === false))) throw fail('STORAGE_JOURNAL_UNSUPPORTED_WRITE');
        if (kind !== 'delete') { encodeValue(data); if (!plain(data)) throw fail('STORAGE_JOURNAL_INVALID_DOCUMENT'); }
        writing = true; changes.push({ kind, ref: raw, data: kind === 'delete' ? undefined : clone(data) });
        if (changes.length > maxWrites) throw fail('STORAGE_JOURNAL_WRITE_LIMIT');
        return transaction;
      };
      const transaction = {
        get,
        getAll: async (...references) => {
          if (writing) throw fail('STORAGE_JOURNAL_READS_BEFORE_WRITES');
          const raws = references.map(unwrap);
          if (raws.some(ref => !scope(ref.path))) throw fail('STORAGE_JOURNAL_REFERENCE_REQUIRED');
          const rows = typeof native.getAll === 'function' ? await native.getAll(...raws) : await Promise.all(raws.map(ref => native.get(ref)));
          return rows.map((row,index) => { initial.set(raws[index].path,row); return result(row); });
        },
        set: (ref,data,settings) => write('set',ref,data,settings), create: (ref,data) => write('create',ref,data),
        update: (ref,data) => write('update',ref,data), delete: ref => write('delete',ref)
      };
      const answer = await callback(transaction);
      if (!changes.length) return answer;
      const missing = [...new Map(changes.filter(change => !initial.has(change.ref.path)).map(change => [change.ref.path, change.ref])).values()];
      const rows = missing.length ? (typeof native.getAll === 'function' ? await native.getAll(...missing) : await Promise.all(missing.map(ref => native.get(ref)))) : [];
      rows.forEach((row,index) => initial.set(missing[index].path,row));
      const after = new Map();
      for (const change of changes) {
        const before = after.has(change.ref.path) ? after.get(change.ref.path) : initial.get(change.ref.path).exists ? initial.get(change.ref.path).data() : undefined;
        if (change.kind === 'create' && before !== undefined) throw Object.assign(fail('STORAGE_DOCUMENT_ALREADY_EXISTS'), { code: 6 });
        if (change.kind === 'update' && before === undefined) throw Object.assign(fail('STORAGE_DOCUMENT_NOT_FOUND'), { code: 5 });
        after.set(change.ref.path, change.kind === 'delete' ? undefined : change.kind === 'update' ? applyUpdate(before,change.data) : change.data);
      }
      const mutations = [...after].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([path,data]) => data === undefined ? { path, deleted: true } : { path, value: encodeValue(data) });
      if (gate.mode === 'shadow') {
        // Large multi-call transfers may have more than one Firestore-sized
        // after-image. Split their evidence into bounded immutable rows, all in
        // the very same commit as the app mutations and sharing its timestamp.
        const groups=[];let group=[],bytes=1024;
        for(const mutation of mutations){const size=Buffer.byteLength(JSON.stringify(mutation))+1;
          if(size+1024>maxJournalBytes)throw fail('STORAGE_JOURNAL_EVENT_TOO_LARGE');
          if(group.length&&bytes+size>maxJournalBytes){groups.push(group);group=[];bytes=1024;}
          group.push(mutation);bytes+=size;}
        if(group.length)groups.push(group);
        if(after.size+groups.length>500)throw fail('STORAGE_JOURNAL_WRITE_LIMIT');
        for(let index=0;index<groups.length;index++){
          const id=groups.length===1?eventId:`${eventId}_${String(index).padStart(3,'0')}`;
          const event={schema:1,eventId:id,migrationId:gate.migrationId,epoch:gate.epoch,mutations:groups[index],
            hash:storageJournalHash(groups[index]),committedAt:serverTimestamp()};
          native.create(groups.length===1?eventRef:firestore.collection(journalCollection).doc(id),event);
        }
      }
      for (const [path,data] of after) {
        const ref = initial.get(path).ref;
        if (data === undefined) native.delete(ref); else if (initial.get(path).exists) native.set(ref,data); else native.create(ref,data);
      }
      return answer;
    }, options);
  }
  const api = { collection: name => {
    if (typeof name !== 'string' || !name.startsWith(collectionPrefix + '_') || name.includes('/') || name === journalCollection) throw fail('STORAGE_JOURNAL_PATH_OUTSIDE_SCOPE');
    return query(firestore.collection(name));
  }, runTransaction,
  getAll: (...refs) => runTransaction(tx => tx.getAll(...refs), { readOnly: true }),
  async readGate() { return readStorageMigrationGate(await gateRef.get()); },
  close() {}, terminate: async () => {},
  journal: Object.freeze({ gatePath, collection: journalCollection }) };
  return api;
}
