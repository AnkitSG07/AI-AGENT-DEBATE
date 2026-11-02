// Private, explicit migration primitives. No runtime imports or background work.
// Values use Firestore's wire types so bytes, nanoseconds and int64s survive.
import { createHash } from 'node:crypto';

export const MIGRATION_VERSION = 'sh-firestore-migration-v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = code => { throw Object.assign(new Error(code), { migrationCode: code }); };
const requireValue = (value, code) => { if (!value) fail(code); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const project = value => typeof value === 'string' && /^[a-z][a-z0-9-]{4,62}$/.test(value);
const database = value => typeof value === 'string' && /^(?:\(default\)|[a-z][a-z0-9-]{2,62})$/.test(value);
const prefixValid = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(value);
const scoped = (path, prefix) => path.split('/')[0].startsWith(prefix + '_');
const pathValid = path => typeof path === 'string' && Buffer.byteLength(path) <= 6000 &&
  path.split('/').every(part => part && part !== '.' && part !== '..' && !/[\u0000-\u001f\u007f]/u.test(part));
const documentPath = path => pathValid(path) && path.split('/').length % 2 === 0;
const rootName = identity => `projects/${identity.projectId}/databases/${identity.databaseId}/documents`;
const identityValid = value => plain(value) && project(value.projectId) && database(value.databaseId);
const integer = value => typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value) &&
  BigInt(value) >= -(2n ** 63n) && BigInt(value) <= 2n ** 63n - 1n;
function timestamp(value) {
  requireValue(plain(value), 'INVALID_TIMESTAMP');
  const seconds = String(value.seconds ?? 0), nanos = Number(value.nanos ?? 0);
  requireValue(integer(seconds) && Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9, 'INVALID_TIMESTAMP');
  return [seconds, nanos];
}
const float = value => Number.isNaN(value) ? 'NaN' : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : Object.is(value, -0) ? '-0' : String(value);
function parseFloatExact(value) {
  requireValue(typeof value === 'string', 'INVALID_DOUBLE');
  const number = value === 'NaN' ? NaN : value === '-0' ? -0 : Number(value);
  requireValue(float(number) === value, 'INVALID_DOUBLE'); return number;
}
function encodeFields(fields, identity, prefix, depth) {
  requireValue(plain(fields) && depth <= 25, 'INVALID_FIELDS');
  return Object.keys(fields).sort(compare).map(key => [key, encodeValue(fields[key], identity, prefix, depth + 1)]);
}
function encodeValue(value, identity, prefix, depth) {
  requireValue(plain(value) && depth <= 25, 'INVALID_FIRESTORE_VALUE');
  // The v1 client returns a discriminator plus only the selected wire field.
  const tags = ['nullValue', 'booleanValue', 'integerValue', 'doubleValue', 'timestampValue', 'stringValue',
    'bytesValue', 'referenceValue', 'geoPointValue', 'arrayValue', 'mapValue'];
  const present = value.valueType !== undefined ? tags.filter(key => key === value.valueType && own(value, key)) :
    tags.filter(key => own(value, key) && value[key] !== null && value[key] !== undefined);
  requireValue(present.length === 1, 'INVALID_FIRESTORE_VALUE');
  const tag = present[0], data = value[tag];
  if (tag === 'nullValue') return ['null'];
  if (tag === 'booleanValue') { requireValue(typeof data === 'boolean', 'INVALID_BOOLEAN'); return ['boolean', data]; }
  if (tag === 'integerValue') { const number = String(data); requireValue(integer(number), 'INVALID_INTEGER'); return ['integer', number]; }
  if (tag === 'doubleValue') { requireValue(typeof data === 'number', 'INVALID_DOUBLE'); return ['double', float(data)]; }
  if (tag === 'timestampValue') return ['timestamp', ...timestamp(data)];
  if (tag === 'stringValue') { requireValue(typeof data === 'string', 'INVALID_STRING'); return ['string', data]; }
  if (tag === 'bytesValue') {
    requireValue(data instanceof Uint8Array || typeof data === 'string', 'INVALID_BYTES');
    const bytes = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(data, 'base64');
    requireValue(data instanceof Uint8Array || bytes.toString('base64') === data, 'INVALID_BYTES');
    return ['bytes', bytes.toString('base64')];
  }
  if (tag === 'referenceValue') {
    requireValue(typeof data === 'string' && /^projects\/[^/]+\/databases\/[^/]+\/documents\/.+/.test(data), 'INVALID_REFERENCE');
    const base = rootName(identity) + '/';
    const path = data.startsWith(base) ? data.slice(base.length) : '';
    return documentPath(path) && scoped(path, prefix) ? ['local-reference', path] : ['reference', data];
  }
  if (tag === 'geoPointValue') {
    requireValue(Number.isFinite(data.latitude) && Number.isFinite(data.longitude) &&
      Math.abs(data.latitude) <= 90 && Math.abs(data.longitude) <= 180, 'INVALID_GEOPOINT');
    return ['geopoint', float(data.latitude), float(data.longitude)];
  }
  if (tag === 'arrayValue') {
    const values = data.values || []; requireValue(Array.isArray(values), 'INVALID_ARRAY');
    return ['array', values.map(entry => encodeValue(entry, identity, prefix, depth + 1))];
  }
  return ['map', encodeFields(data.fields || {}, identity, prefix, depth + 1)];
}
function decodeFields(entries, target, prefix, depth) {
  requireValue(Array.isArray(entries) && depth <= 25, 'INVALID_FIELDS');
  let previous;
  return Object.fromEntries(entries.map(entry => {
    requireValue(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' &&
      (previous === undefined || compare(previous, entry[0]) < 0), 'INVALID_FIELDS');
    previous = entry[0]; return [entry[0], decodeValue(entry[1], target, prefix, depth + 1)];
  }));
}
function decodeValue(value, target, prefix, depth) {
  requireValue(Array.isArray(value) && typeof value[0] === 'string' && depth <= 25, 'INVALID_VALUE_ENCODING');
  const [tag, data] = value;
  if (tag === 'null') { requireValue(value.length === 1, 'INVALID_VALUE_ENCODING'); return { nullValue: 'NULL_VALUE' }; }
  if (tag === 'boolean') { requireValue(value.length === 2 && typeof data === 'boolean', 'INVALID_BOOLEAN'); return { booleanValue: data }; }
  if (tag === 'integer') { requireValue(value.length === 2 && integer(data), 'INVALID_INTEGER'); return { integerValue: data }; }
  if (tag === 'double') { requireValue(value.length === 2, 'INVALID_DOUBLE'); return { doubleValue: parseFloatExact(data) }; }
  if (tag === 'timestamp') { requireValue(value.length === 3, 'INVALID_TIMESTAMP'); timestamp({ seconds: data, nanos: value[2] }); return { timestampValue: { seconds: data, nanos: value[2] } }; }
  if (tag === 'string') { requireValue(value.length === 2 && typeof data === 'string', 'INVALID_STRING'); return { stringValue: data }; }
  if (tag === 'bytes') {
    requireValue(value.length === 2 && typeof data === 'string' && Buffer.from(data, 'base64').toString('base64') === data, 'INVALID_BYTES');
    return { bytesValue: Buffer.from(data, 'base64') };
  }
  if (tag === 'local-reference') {
    requireValue(value.length === 2 && documentPath(data) && scoped(data, prefix), 'INVALID_REFERENCE');
    return { referenceValue: rootName(target) + '/' + data };
  }
  if (tag === 'reference') {
    requireValue(value.length === 2 && typeof data === 'string' && /^projects\/[^/]+\/databases\/[^/]+\/documents\/.+/.test(data), 'INVALID_REFERENCE');
    return { referenceValue: data };
  }
  if (tag === 'geopoint') {
    requireValue(value.length === 3, 'INVALID_GEOPOINT'); const latitude = parseFloatExact(data), longitude = parseFloatExact(value[2]);
    requireValue(Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180, 'INVALID_GEOPOINT');
    return { geoPointValue: { latitude, longitude } };
  }
  if (tag === 'array') { requireValue(value.length === 2 && Array.isArray(data), 'INVALID_ARRAY'); return { arrayValue: { values: data.map(entry => decodeValue(entry, target, prefix, depth + 1)) } }; }
  if (tag === 'map') { requireValue(value.length === 2, 'INVALID_FIELDS'); return { mapValue: { fields: decodeFields(data, target, prefix, depth + 1) } }; }
  fail('INVALID_VALUE_ENCODING');
}
export function encodeDocument(document, identity, prefix) {
  const base = rootName(identity) + '/';
  requireValue(typeof document.name === 'string' && document.name.startsWith(base), 'FOREIGN_DOCUMENT');
  const path = document.name.slice(base.length);
  requireValue(documentPath(path) && scoped(path, prefix), 'DOCUMENT_OUTSIDE_SCOPE');
  const fields = encodeFields(document.fields || {}, identity, prefix, 0);
  return { path, fields, updated: timestamp(document.updateTime), hash: digest([path, fields]) };
}
export function decodeDocument(document, target, prefix) {
  requireValue(identityValid(target) && documentPath(document.path) && scoped(document.path, prefix), 'INVALID_DOCUMENT');
  return { name: rootName(target) + '/' + document.path, fields: decodeFields(document.fields, target, prefix, 0) };
}
const limitsOf = options => {
  const limits = { maxDocuments: 20000, maxCollections: 500, maxBytes: 64 * 1024 * 1024, maxDurationMs: 10 * 60000, ...options };
  for (const [key, max] of [['maxDocuments', 100000], ['maxCollections', 2000], ['maxBytes', 256 * 1024 * 1024], ['maxDurationMs', 30 * 60000]])
    requireValue(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= max, 'INVALID_LIMITS');
  return limits;
};
export async function scanNamespace(transport, prefix = 'sh_operator', options = {}) {
  requireValue(identityValid(transport.identity) && prefixValid(prefix), 'INVALID_SCOPE');
  const limits = limitsOf(options), started = Date.now(), collections = new Set(), documents = [], seen = new Set(); let bytes = 0;
  const guard = () => requireValue(Date.now() - started <= limits.maxDurationMs, 'SCAN_TIME_LIMIT');
  // Each parent requires ListCollectionIds even when it has no children. Keep
  // that discovery (including absent parents) complete without serializing one
  // network round trip per document. Collection listing uses the same bounded
  // task queue, so enumerating the root does not serialize every collection's
  // document pages. All counters remain global and checked before work queues.
  const concurrency = 32;
  let tasks = [{ kind: 'parent', parent: '', depth: 0 }], stopped = false;
  const check = () => { requireValue(!stopped, 'SCAN_WAVE_STOPPED'); guard(); };
  const discoverParent = async ({ parent, depth }, next) => {
    check(); requireValue(depth <= 12, 'SUBCOLLECTION_DEPTH_LIMIT');
    for await (const name of transport.listCollections(parent)) {
      check(); requireValue(typeof name === 'string' && pathValid(name) && !name.includes('/'), 'INVALID_COLLECTION');
      const collection = parent ? parent + '/' + name : name;
      if (!parent && !name.startsWith(prefix + '_')) continue;
      requireValue(!collections.has(collection), 'DUPLICATE_COLLECTION'); collections.add(collection);
      requireValue(collections.size <= limits.maxCollections, 'COLLECTION_LIMIT');
      next.push({ kind: 'collection', collection, depth });
    }
    // Empty iterators must still honor the duration bound after their RPC.
    check();
  };
  const listCollection = async ({ collection, depth }, next) => {
    check();
    for await (const raw of transport.listDocuments(collection)) {
      check(); const base = rootName(transport.identity) + '/';
      requireValue(typeof raw.name === 'string' && raw.name.startsWith(base), 'FOREIGN_DOCUMENT');
      const path = raw.name.slice(base.length);
      requireValue(documentPath(path) && path.split('/').slice(0, -1).join('/') === collection && !seen.has(path), 'INVALID_DOCUMENT'); seen.add(path);
      requireValue(seen.size <= limits.maxDocuments, 'DOCUMENT_LIMIT');
      // showMissing includes non-existing parents which contain subcollections.
      if (raw.createTime) {
        const document = encodeDocument(raw, transport.identity, prefix); bytes += Buffer.byteLength(JSON.stringify(document));
        requireValue(bytes <= limits.maxBytes, 'EXPORT_BYTE_LIMIT'); documents.push(document);
      }
      next.push({ kind: 'parent', parent: path, depth: depth + 1 });
    }
    check();
  };
  while (tasks.length) {
    const next = [];
    for (let offset = 0; offset < tasks.length; offset += concurrency) {
      let firstError, failed = false;
      // A rejected read must not leave other workers running after this scan
      // returns. Stop admitting further work, drain this bounded wave, then
      // propagate the original failure rather than a sibling's stop marker.
      await Promise.allSettled(tasks.slice(offset, offset + concurrency).map(async item => {
        try { await (item.kind === 'parent' ? discoverParent(item, next) : listCollection(item, next)); }
        catch (error) { if (!failed) { firstError = error; failed = true; } stopped = true; }
      }));
      if (failed) throw firstError;
    }
    tasks = next;
  }
  guard(); documents.sort((a, b) => compare(a.path, b.path));
  const collectionNames = [...collections].sort(compare);
  return { collections: collectionNames, documents, bytes,
    dataHash: digest(documents.map(row => [row.path, row.hash])),
    sourceHash: digest([collectionNames, documents.map(row => [row.path, row.hash, row.updated])]) };
}
function toPlain(value) {
  const [tag, data] = value;
  if (tag === 'map') return Object.fromEntries(data.map(([key, entry]) => [key, toPlain(entry)]));
  if (tag === 'array') return data.map(toPlain);
  if (tag === 'integer') { const number = Number(data); return Number.isSafeInteger(number) ? number : BigInt(data); }
  if (tag === 'double') return parseFloatExact(data);
  if (tag === 'null') return null;
  if (tag === 'bytes') return Buffer.from(data, 'base64');
  return data;
}
export function verifyBindings(manifest) {
  const prefix = manifest.prefix, rows = new Map(manifest.documents.map(doc => [doc.path, toPlain(['map', doc.fields])]));
  let devices = 0, activeCredentials = 0, heldReservations = 0, unsettledSessions = 0, archiveChunks = 0;
  for (const [path, row] of rows) {
    const [collection, id] = path.split('/'); if (path.split('/').length !== 2) continue;
    if (collection === prefix + '_devices') {
      requireValue(row.id === id && row.schema === 1, 'DEVICE_ID_BINDING_MISMATCH'); devices++;
    }
    if (collection === prefix + '_credentials' && row.active === true) {
      const device = rows.get(prefix + '_devices/' + row.deviceId);
      requireValue(device && device.tokenHash === id && device.credentialGeneration === row.generation, 'CREDENTIAL_GENERATION_MISMATCH'); activeCredentials++;
    }
    const mediaKind = collection.startsWith(prefix + '_media_') ? collection.slice((prefix + '_media_').length) : '';
    if (['calls', 'sessions', 'reservations', 'events'].includes(mediaKind)) {
      requireValue(row.schema === 1 && row.key === `media_${mediaKind}/${id}` && plain(row.data), 'MEDIA_KEY_BINDING_MISMATCH');
      if (['calls', 'sessions', 'events'].includes(mediaKind)) requireValue(digestId(row.data.id) === id, 'MEDIA_ID_BINDING_MISMATCH');
      if (mediaKind === 'reservations') { if (row.data.deviceId) requireValue(digestId(row.data.deviceId) === id, 'RESERVATION_DEVICE_MISMATCH'); heldReservations++; }
      if (mediaKind === 'sessions' && (!row.data.terminal || !row.data.terminal.confirmedAt)) unsettledSessions++;
    }
    if (collection === prefix + '_reports_archive_chunks') {
      requireValue(row.bytes instanceof Uint8Array && createHash('sha256').update(row.bytes).digest('hex') === row.sha256, 'ARCHIVE_CHUNK_HASH_MISMATCH'); archiveChunks++;
    }
  }
  return { devices, activeCredentials, heldReservations, unsettledSessions, archiveChunks };
}
const digestId = value => { requireValue(typeof value === 'string' && value.length > 0, 'MISSING_MEDIA_ID'); return createHash('sha256').update(value).digest('hex'); };
function bodyOf(manifest) { const { hash, ...body } = manifest; return body; }
export function validateManifest(manifest, expectedHash) {
  requireValue(plain(manifest) && manifest.version === MIGRATION_VERSION && identityValid(manifest.source) &&
    prefixValid(manifest.prefix) && manifest.sourceWritesPaused === 'operator-confirmed' && manifest.stablePasses === 2 &&
    Array.isArray(manifest.documents) && Array.isArray(manifest.collections), 'INVALID_MANIFEST');
  requireValue(manifest.hash === digest(bodyOf(manifest)) && (!expectedHash || expectedHash === manifest.hash), 'MANIFEST_HASH_MISMATCH');
  let previous;
  const collections = new Set(); let previousCollection;
  for (const collection of manifest.collections) {
    requireValue(pathValid(collection) && scoped(collection, manifest.prefix) && collection.split('/').length % 2 === 1 &&
      (previousCollection === undefined || compare(previousCollection, collection) < 0), 'INVALID_COLLECTION_INVENTORY');
    collections.add(collection); previousCollection = collection;
  }
  for (const document of manifest.documents) {
    requireValue(documentPath(document.path) && scoped(document.path, manifest.prefix) &&
      (previous === undefined || compare(previous, document.path) < 0) && document.hash === digest([document.path, document.fields]), 'DOCUMENT_HASH_MISMATCH');
    requireValue(collections.has(document.path.split('/').slice(0, -1).join('/')), 'INVALID_COLLECTION_INVENTORY');
    previous = document.path; timestamp({ seconds: document.updated?.[0], nanos: document.updated?.[1] });
    decodeDocument(document, manifest.source, manifest.prefix);
  }
  requireValue(manifest.dataHash === digest(manifest.documents.map(row => [row.path, row.hash])) &&
    manifest.sourceHash === digest([manifest.collections, manifest.documents.map(row => [row.path, row.hash, row.updated])]), 'MANIFEST_HASH_MISMATCH');
  verifyBindings(manifest); return manifest;
}
export async function exportNamespace(source, { prefix = 'sh_operator', sourceWritesPaused = false, limits } = {}) {
  requireValue(sourceWritesPaused === true, 'SOURCE_WRITES_MUST_BE_PAUSED');
  const first = await scanNamespace(source, prefix, limits), second = await scanNamespace(source, prefix, limits);
  requireValue(first.sourceHash === second.sourceHash, 'SOURCE_CHANGED_DURING_EXPORT');
  const body = { version: MIGRATION_VERSION, source: source.identity, prefix, createdAt: new Date().toISOString(),
    sourceWritesPaused: 'operator-confirmed', stablePasses: 2, collections: first.collections,
    documents: first.documents, dataHash: first.dataHash, sourceHash: first.sourceHash };
  const manifest = { ...body, hash: digest(body) }; validateManifest(manifest); return manifest;
}
export async function verifySource(source, manifest, { sourceWritesPaused = false, limits } = {}) {
  validateManifest(manifest); requireValue(sourceWritesPaused === true, 'SOURCE_WRITES_MUST_BE_PAUSED');
  requireValue(source.identity.projectId === manifest.source.projectId && source.identity.databaseId === manifest.source.databaseId, 'SOURCE_IDENTITY_MISMATCH');
  const current = await scanNamespace(source, manifest.prefix, limits);
  requireValue(current.sourceHash === manifest.sourceHash, 'SOURCE_CHANGED_SINCE_EXPORT');
  return { sourceVerified: true, documents: current.documents.length, dataHash: current.dataHash, manifestHash: manifest.hash };
}
async function targetState(destination, manifest, limits) {
  const current = await scanNamespace(destination, manifest.prefix, limits), expected = new Map(manifest.documents.map(row => [row.path, row.hash]));
  for (const document of current.documents) requireValue(expected.get(document.path) === document.hash, 'DESTINATION_CONFLICT');
  return current;
}
export async function importNamespace(destination, manifest, { expectedHash, sourceWritesPaused = false, destinationWritesPaused = false,
  batchSize = 100, limits } = {}) {
  validateManifest(manifest, expectedHash);
  requireValue(expectedHash === manifest.hash, 'EXPECTED_MANIFEST_HASH_REQUIRED');
  requireValue(sourceWritesPaused === true && destinationWritesPaused === true, 'BOTH_PROJECT_WRITERS_MUST_BE_PAUSED');
  requireValue(identityValid(destination.identity) && destination.identity.projectId !== manifest.source.projectId, 'DESTINATION_MUST_BE_A_DIFFERENT_PROJECT');
  requireValue(Number.isSafeInteger(batchSize) && batchSize > 0 && batchSize <= 100, 'INVALID_BATCH_SIZE');
  const bounds = limitsOf(limits);
  requireValue(manifest.documents.length <= bounds.maxDocuments && manifest.collections.length <= bounds.maxCollections &&
    Buffer.byteLength(JSON.stringify(manifest.documents)) <= bounds.maxBytes, 'IMPORT_LIMIT');
  const before = await targetState(destination, manifest, limits), present = new Set(before.documents.map(row => row.path));
  let batch = [], bytes = 0, created = 0;
  const commit = async () => {
    if (!batch.length) return;
    // The adapter uses exists:false for every write. Never overwrite; an
    // uncertain commit may be resumed only after reading exact target hashes.
    try { await destination.commitCreates(batch); } catch { fail('DESTINATION_COMMIT_UNCERTAIN_RESCAN_BEFORE_RESUMING'); }
    created += batch.length; batch = []; bytes = 0;
  };
  for (const document of manifest.documents) {
    if (present.has(document.path)) continue;
    const encodedBytes = Buffer.byteLength(JSON.stringify(document.fields));
    requireValue(encodedBytes <= 2 * 1024 * 1024, 'DOCUMENT_BYTE_LIMIT');
    if (batch.length >= batchSize || bytes + encodedBytes > 7 * 1024 * 1024) await commit();
    batch.push(decodeDocument(document, destination.identity, manifest.prefix)); bytes += encodedBytes;
  }
  await commit();
  return { created, alreadyPresent: present.size, ...await verifyDestination(destination, manifest, { limits }) };
}
export async function verifyDestination(destination, manifest, { limits } = {}) {
  validateManifest(manifest);
  requireValue(identityValid(destination.identity) && destination.identity.projectId !== manifest.source.projectId, 'DESTINATION_MUST_BE_A_DIFFERENT_PROJECT');
  const current = await targetState(destination, manifest, limits);
  requireValue(current.documents.length === manifest.documents.length && current.dataHash === manifest.dataHash, 'DESTINATION_INCOMPLETE');
  verifyBindings({ ...manifest, documents: current.documents });
  return { destinationVerified: true, documents: current.documents.length, dataHash: current.dataHash, manifestHash: manifest.hash };
}
