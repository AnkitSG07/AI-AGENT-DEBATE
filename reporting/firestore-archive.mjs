// Private server-only archive for small XLSX + manifest bundles. There is no
// delete API and no storage lookup outside the separate report namespace.
import { MIME_XLSX, canonical, clone, digest, guarded, id, isObject, requireValue, sha256, time } from './schema.mjs';

const HASH = /^[a-f0-9]{64}$/;
const KIND = 'firestore-private-archive';
const SLOTS = ['workbook', 'manifest'];
const descriptor = row => ({ objectId: row.objectId, exportId: row.exportId, name: row.name,
  mimeType: row.mimeType, size: row.size, sha256: row.sha256, slot: row.slot });
const objectPlan = row => ({ schema: 1, tenantId: row.tenantId, ...descriptor(row), chunkBytes: row.chunkBytes,
  chunks: row.chunks, workbook: row.workbook });

export function createFirestoreArchiveAdapter({ firestore, tenantId = 'smart-handicrafts',
  collectionPrefix = 'sh_operator_reports', clock = Date.now, chunkBytes = 192 * 1024,
  maxFileBytes = 2 * 1024 * 1024, maxBundleBytes = 4 * 1024 * 1024 } = {}) {
  requireValue(firestore?.collection && firestore?.runTransaction && id(tenantId) &&
    /^[A-Za-z][A-Za-z0-9_]{0,60}_reports$/.test(collectionPrefix), 'INVALID_ARCHIVE_CONFIG',
  'A private report-only Firestore namespace is required.');
  requireValue(Number.isSafeInteger(chunkBytes) && chunkBytes >= 1024 && chunkBytes <= 192 * 1024 &&
    Number.isSafeInteger(maxFileBytes) && maxFileBytes >= chunkBytes && maxFileBytes <= 2 * 1024 * 1024 &&
    Number.isSafeInteger(maxBundleBytes) && maxBundleBytes >= maxFileBytes && maxBundleBytes <= 4 * 1024 * 1024 &&
    Math.ceil(maxFileBytes / chunkBytes) <= 32, 'INVALID_ARCHIVE_CONFIG', 'Archive sizes must remain small and bounded.');
  const collections = Object.fromEntries(['objects', 'chunks', 'bundles'].map(kind =>
    [kind, firestore.collection(`${collectionPrefix}_archive_${kind}`)]));
  const now = () => { const value = clock(); requireValue(time(value) && value > 0, 'INVALID_CLOCK', 'A valid archive timestamp is required.', 503); return value; };
  const bundleId = exportId => digest({ tenantId, exportId });
  const objectId = file => digest({ tenantId, exportId: file.exportId, name: file.name, sha256: file.sha256 });
  const chunkId = (object, index) => digest({ objectId: object.objectId, index });
  const fail = condition => requireValue(condition, 'ARCHIVE_INTEGRITY_FAILED', 'The private archive is incomplete or its contents changed.', 503);

  function readObject(snapshot) {
    if (!snapshot.exists) return null;
    const row = snapshot.data();
    fail(row?.schema === 1 && row.tenantId === tenantId && row.objectId === snapshot.id && id(row.exportId) &&
      SLOTS.includes(row.slot) && objectId(row) === row.objectId && HASH.test(row.sha256) &&
      row.size > 0 && row.size <= maxFileBytes && Number.isSafeInteger(row.size) && row.chunkBytes === chunkBytes &&
      Array.isArray(row.chunks) && row.chunks.length === Math.ceil(row.size / chunkBytes) && row.chunks.length <= 32 &&
      row.chunks.every((part, index) => part.index === index && HASH.test(part.sha256) &&
        part.size === Math.min(chunkBytes, row.size - index * chunkBytes)) &&
      ['pending', 'complete'].includes(row.state) && time(row.createdAtMs) &&
      (row.state !== 'complete' || time(row.completedAtMs)) && row.planHash === digest(objectPlan(row)));
    return row;
  }
  function readBundle(snapshot, exportId) {
    if (!snapshot.exists) return null;
    const row = snapshot.data();
    fail(row?.schema === 1 && row.tenantId === tenantId && row.exportId === exportId && snapshot.id === bundleId(exportId) &&
      isObject(row.files) && Object.keys(row.files).every(slot => SLOTS.includes(slot)) &&
      ['pending', 'complete'].includes(row.state) && time(row.createdAtMs));
    let total = 0;
    for (const [slot, file] of Object.entries(row.files)) {
      fail(file.slot === slot && file.exportId === exportId && file.objectId === objectId(file) && HASH.test(file.sha256) &&
        Number.isSafeInteger(file.size) && file.size > 0 && file.size <= maxFileBytes);
      total += file.size;
    }
    fail(total <= maxBundleBytes && (row.state !== 'complete' || SLOTS.every(slot => row.files[slot]) && time(row.completedAtMs)));
    return row;
  }
  function validateChunk(snapshot, object, part) {
    fail(snapshot.exists);
    const row = snapshot.data();
    fail(row?.schema === 1 && row.tenantId === tenantId && row.objectId === object.objectId && row.index === part.index &&
      row.sha256 === part.sha256 && row.bytes instanceof Uint8Array && row.bytes.length === part.size && sha256(row.bytes) === part.sha256);
    return Buffer.from(row.bytes);
  }
  async function fullBytes(object, get) {
    const parts = [];
    for (const part of object.chunks) parts.push(validateChunk(await get(collections.chunks.doc(chunkId(object, part.index))), object, part));
    const bytes = Buffer.concat(parts); fail(bytes.length === object.size && sha256(bytes) === object.sha256); return bytes;
  }
  function checkPair(bundle, objects) {
    for (const [slot, object] of Object.entries(objects)) fail(object && canonical(descriptor(object)) === canonical(bundle.files[slot]));
    if (objects.workbook && objects.manifest) fail(canonical(objects.manifest.workbook) === canonical({
      name: objects.workbook.name, mimeType: objects.workbook.mimeType, size: objects.workbook.size, sha256: objects.workbook.sha256 }));
  }
  function prepare(input) {
    requireValue(input && id(input.exportId) && input.bytes instanceof Uint8Array && HASH.test(input.sha256),
      'INVALID_ARCHIVE_FILE', 'A complete hashed export file is required.');
    const bytes = Buffer.from(input.bytes);
    requireValue(bytes.length > 0 && bytes.length <= maxFileBytes && input.size === bytes.length && sha256(bytes) === input.sha256,
      'ARCHIVE_SIZE_OR_HASH', 'The archive file must fit its size limit and match its exact hash.', 413);
    let slot;
    if (input.name === `sh-history-${input.exportId}.xlsx` && input.mimeType === MIME_XLSX &&
      bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) slot = 'workbook';
    if (input.name === `sh-history-${input.exportId}.manifest.json` && input.mimeType === 'application/json') slot = 'manifest';
    requireValue(slot, 'INVALID_ARCHIVE_FILE', 'Only this export workbook and its matching JSON manifest may be archived.');
    let workbook = null;
    if (slot === 'manifest') {
      let parsed;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { /* rejected below */ }
      requireValue(parsed?.schema === 1 && parsed.tenantId === tenantId && parsed.exportId === input.exportId &&
        parsed.workbook?.name === `sh-history-${input.exportId}.xlsx` && parsed.workbook?.mimeType === MIME_XLSX &&
        HASH.test(parsed.workbook?.sha256) && Number.isSafeInteger(parsed.workbook?.size) && parsed.workbook.size > 0 &&
        parsed.workbook.size <= maxFileBytes, 'INVALID_ARCHIVE_MANIFEST', 'The manifest must identify this exact workbook and tenant.');
      workbook = { name: parsed.workbook.name, mimeType: MIME_XLSX, size: parsed.workbook.size, sha256: parsed.workbook.sha256 };
    }
    const row = { schema: 1, tenantId, objectId: objectId(input), exportId: input.exportId, name: input.name,
      mimeType: input.mimeType, size: bytes.length, sha256: input.sha256, slot, chunkBytes, chunks: [], workbook };
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const part = bytes.subarray(offset, offset + chunkBytes); row.chunks.push({ index: row.chunks.length, size: part.length, sha256: sha256(part) });
    }
    return { bytes, row: { ...row, planHash: digest(objectPlan(row)), state: 'pending', createdAtMs: now() } };
  }
  const locator = row => ({ provider: KIND, tenantId, ...descriptor(row) });

  async function put(input) {
    const { bytes, row: planned } = prepare(input), bundleRef = collections.bundles.doc(bundleId(planned.exportId));
    const objectRef = collections.objects.doc(planned.objectId);
    return guarded(async () => {
      const row = await firestore.runTransaction(async tx => {
        const existing = readObject(await tx.get(objectRef));
        const bundle = readBundle(await tx.get(bundleRef), planned.exportId) || { schema: 1, tenantId,
          exportId: planned.exportId, files: {}, state: 'pending', createdAtMs: now() };
        const priorSlot = bundle.files[planned.slot];
        requireValue(!priorSlot || canonical(priorSlot) === canonical(descriptor(planned)), 'ARCHIVE_ALREADY_FINALIZED',
          'This export already reserved different immutable archive bytes.', 409);
        requireValue(!existing || existing.planHash === planned.planHash, 'ARCHIVE_ALREADY_FINALIZED', 'The immutable archive plan changed.', 409);
        fail(bundle.state !== 'complete' || existing?.state === 'complete');
        const next = { ...bundle, files: { ...bundle.files, [planned.slot]: descriptor(planned) } };
        requireValue(Object.values(next.files).reduce((sum, file) => sum + file.size, 0) <= maxBundleBytes,
          'ARCHIVE_BUNDLE_LIMIT', 'The workbook and manifest exceed the private archive bundle limit.', 413);
        if (!existing) tx.create(objectRef, planned);
        if (!priorSlot) tx.set(bundleRef, next);
        return existing || planned;
      });
      // Each bounded chunk is immutable and idempotent across lost responses or
      // simultaneous workers. No I/O other than Firestore occurs in callbacks.
      for (const part of row.chunks) {
        const reference = collections.chunks.doc(chunkId(row, part.index));
        await firestore.runTransaction(async tx => {
          const previous = await tx.get(reference);
          if (previous.exists) { validateChunk(previous, row, part); return; }
          const current = readObject(await tx.get(objectRef));
          fail(current?.planHash === row.planHash && current.state !== 'complete');
          // Read current state so an old pending uploader cannot repair a
          // completed archive after another worker finished it.
          tx.create(reference, { schema: 1, tenantId, objectId: row.objectId, index: part.index, sha256: part.sha256,
            bytes: bytes.subarray(part.index * chunkBytes, part.index * chunkBytes + part.size) });
        });
      }
      await firestore.runTransaction(async tx => {
        const current = readObject(await tx.get(objectRef));
        const bundle = readBundle(await tx.get(bundleRef), row.exportId); fail(current?.planHash === row.planHash && bundle);
        const objects = { [row.slot]: current };
        for (const slot of SLOTS) if (slot !== row.slot && bundle.files[slot])
          objects[slot] = readObject(await tx.get(collections.objects.doc(bundle.files[slot].objectId)));
        checkPair(bundle, objects);
        await fullBytes(current, reference => tx.get(reference));
        const timestamp = now();
        if (current.state !== 'complete') { current.state = 'complete'; current.completedAtMs = timestamp; tx.set(objectRef, current); }
        if (SLOTS.every(slot => objects[slot]?.state === 'complete') && bundle.state !== 'complete')
          tx.set(bundleRef, { ...bundle, state: 'complete', completedAtMs: timestamp });
      });
      return locator(row);
    });
  }
  async function read(receipt) {
    requireValue(receipt?.provider === KIND && receipt.tenantId === tenantId && id(receipt.exportId) &&
      HASH.test(receipt.objectId) && receipt.objectId === objectId(receipt), 'INVALID_ARCHIVE_LOCATOR', 'An exact private archive locator is required.');
    return guarded(async () => {
      const bundle = readBundle(await collections.bundles.doc(bundleId(receipt.exportId)).get(), receipt.exportId);
      fail(bundle?.state === 'complete');
      const objects = {};
      for (const slot of SLOTS) {
        objects[slot] = readObject(await collections.objects.doc(bundle.files[slot].objectId).get());
        fail(objects[slot]?.state === 'complete');
      }
      checkPair(bundle, objects);
      const row = objects[receipt.slot]; fail(row && canonical(locator(row)) === canonical(receipt));
      return fullBytes(row, reference => reference.get());
    });
  }
  return Object.freeze({ durable: true, kind: KIND, tenantId, collectionPrefix,
    limits: Object.freeze({ chunkBytes, maxFileBytes, maxBundleBytes }), put, read });
}
