import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportNamespace, importNamespace, verifySource, verifyDestination, validateManifest, verifyBindings,
  encodeDocument, decodeDocument, scanNamespace } from '../scripts/sh-firestore-migration.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clock = { seconds: '1800000000', nanos: 123456789 };
const sourceIdentity = { projectId: 'source-project', databaseId: '(default)' };
const targetIdentity = { projectId: 'target-project', databaseId: '(default)' };
const root = identity => `projects/${identity.projectId}/databases/${identity.databaseId}/documents/`;
function value(data) {
  if (data === null) return { nullValue: 'NULL_VALUE' };
  if (data instanceof Uint8Array) return { bytesValue: data };
  if (typeof data === 'boolean') return { booleanValue: data };
  if (typeof data === 'bigint' || Number.isSafeInteger(data) && !Object.is(data, -0)) return { integerValue: String(data) };
  if (typeof data === 'number') return { doubleValue: data };
  if (typeof data === 'string') return { stringValue: data };
  if (Array.isArray(data)) return { arrayValue: { values: data.map(value) } };
  return { mapValue: { fields: fields(data) } };
}
const fields = data => Object.fromEntries(Object.entries(data).map(([key, data]) => [key, value(data)]));
class FakeProject {
  constructor(identity = sourceIdentity) { this.identity = identity; this.docs = new Map(); this.commits = 0; this.scans = 0; this.failAfterCommit = false; }
  seed(path, data, raw = false) { this.docs.set(path, { name: root(this.identity) + path, fields: raw ? data : fields(data), createTime: clock, updateTime: clock }); return this; }
  async *listCollections(parent) {
    if (!parent) { this.scans++; this.onScan?.(this.scans); }
    const names = new Set();
    for (const path of this.docs.keys()) {
      const relative = parent ? path.startsWith(parent + '/') ? path.slice(parent.length + 1) : '' : path;
      if (relative.includes('/')) names.add(relative.split('/')[0]);
    }
    yield* [...names].sort();
  }
  async *listDocuments(collection) {
    const paths = new Set();
    for (const path of this.docs.keys()) if (path.startsWith(collection + '/')) paths.add(collection + '/' + path.slice(collection.length + 1).split('/')[0]);
    for (const path of [...paths].sort()) yield structuredClone(this.docs.get(path) || { name: root(this.identity) + path });
  }
  async commitCreates(documents) {
    for (const document of documents) if (this.docs.has(document.name.slice(root(this.identity).length))) throw Error('Synthetic exists:false conflict');
    this.commits++;
    for (const document of documents) this.seed(document.name.slice(root(this.identity).length), document.fields, true);
    if (this.failAfterCommit) { this.failAfterCommit = false; throw Error('Synthetic lost commit acknowledgement with PRIVATE SDK DETAIL'); }
  }
}
function fixture() {
  const source = new FakeProject(), deviceId = 'android_example_0123456789', tokenHash = 'a'.repeat(64);
  source.seed('sh_operator_devices/' + deviceId, { schema: 1, id: deviceId, tokenHash, credentialGeneration: 1, fcmToken: 'PRIVATE_FCM_TOKEN' });
  source.seed('sh_operator_credentials/' + tokenHash, { active: true, deviceId, generation: 1 });
  source.seed('sh_operator_app_messages/73', { schema: 1, stateVersion: 5, pendingIds: [100], preview: 'PRIVATE_MESSAGE' });
  source.seed('sh_operator_media_sessions/' + hash('pending-call'), { schema: 1, key: 'media_sessions/' + hash('pending-call'), data: { id: 'pending-call', terminal: { confirmedAt: 123 } } });
  source.seed('sh_operator_media_events/' + hash('evt:private'), { schema: 1, key: 'media_events/' + hash('evt:private'), data: { id: 'evt:private' } });
  source.seed('sh_operator_media_reservations/' + hash(deviceId), { schema: 1, key: 'media_reservations/' + hash(deviceId), data: { deviceId, callId: 'pending-call' } });
  const bytes = Buffer.from([0, 1, 254, 255]);
  source.seed('sh_operator_reports_archive_chunks/chunk1', { bytes, sha256: hash(bytes) });
  source.seed('sh_operator_metadata/missing/child/record', {
    int64: { integerValue: '9223372036854775807' }, stamp: { timestampValue: clock },
    bytes: { bytesValue: bytes }, negativeZero: { doubleValue: -0 }, nan: { doubleValue: NaN }, infinity: { doubleValue: Infinity },
    geo: { geoPointValue: { latitude: 0, longitude: 77.5 } },
    local: { referenceValue: root(sourceIdentity) + 'sh_operator_app_messages/73' },
    external: { referenceValue: 'projects/another-project/databases/(default)/documents/private/outside' },
    literalTag: value({ __shType: 'bytes', value: 'ordinary user object' })
  }, true);
  source.seed('other_application/secret', { ignored: true });
  return { source, target: new FakeProject(targetIdentity) };
}
const exported = source => exportNamespace(source, { sourceWritesPaused: true });
const importing = (target, manifest, extra = {}) => importNamespace(target, manifest, {
  expectedHash: manifest.hash, sourceWritesPaused: true, destinationWritesPaused: true, ...extra
});

test('two stable scoped passes preserve bytes, int64, nanoseconds, special doubles, references and orphan subcollections', async () => {
  const { source, target } = fixture(), manifest = await exported(source);
  assert.equal(source.scans, 2); assert.equal(manifest.documents.length, 8);
  assert.ok(manifest.collections.includes('sh_operator_metadata/missing/child'));
  assert.ok(!manifest.documents.some(row => row.path.startsWith('other_application/')));
  assert.deepEqual(verifyBindings(manifest), { devices: 1, activeCredentials: 1, heldReservations: 1, unsettledSessions: 0, archiveChunks: 1 });
  const result = await importing(target, manifest, { batchSize: 2 });
  assert.equal(result.created, 8); assert.equal(result.destinationVerified, true);
  const special = target.docs.get('sh_operator_metadata/missing/child/record').fields;
  assert.equal(special.int64.integerValue, '9223372036854775807'); assert.deepEqual(special.stamp.timestampValue, clock);
  assert.deepEqual(Buffer.from(special.bytes.bytesValue), Buffer.from([0, 1, 254, 255]));
  assert.ok(Object.is(special.negativeZero.doubleValue, -0)); assert.ok(Number.isNaN(special.nan.doubleValue));
  assert.equal(special.local.referenceValue, root(targetIdentity) + 'sh_operator_app_messages/73');
  assert.equal(special.external.referenceValue, source.docs.get('sh_operator_metadata/missing/child/record').fields.external.referenceValue);
  assert.ok(!target.docs.has('sh_operator_metadata/missing'), 'Do not create a document that was absent in the source');
});
test('an export requires stopped source writers and detects source changes between passes', async () => {
  const { source } = fixture();
  await assert.rejects(exportNamespace(source), { migrationCode: 'SOURCE_WRITES_MUST_BE_PAUSED' }); assert.equal(source.scans, 0);
  source.onScan = number => { if (number === 2) source.seed('sh_operator_app_messages/new', { changed: true }); };
  await assert.rejects(exported(source), { migrationCode: 'SOURCE_CHANGED_DURING_EXPORT' });
});
test('source verification detects same-value writes by updateTime and never mutates source', async () => {
  const { source } = fixture(), manifest = await exported(source);
  assert.equal((await verifySource(source, manifest, { sourceWritesPaused: true })).sourceVerified, true);
  source.docs.get('sh_operator_app_messages/73').updateTime = { seconds: clock.seconds, nanos: clock.nanos + 1 };
  await assert.rejects(verifySource(source, manifest, { sourceWritesPaused: true }), { migrationCode: 'SOURCE_CHANGED_SINCE_EXPORT' });
  assert.equal(source.commits, 0);
});
test('import uses exact-hash create-only resume after a lost commit ACK', async () => {
  const { source, target } = fixture(), manifest = await exported(source); target.failAfterCommit = true;
  await assert.rejects(importing(target, manifest, { batchSize: 2 }), { migrationCode: 'DESTINATION_COMMIT_UNCERTAIN_RESCAN_BEFORE_RESUMING' });
  assert.equal(target.docs.size, 2);
  const result = await importing(target, manifest, { batchSize: 2 }); assert.equal(result.alreadyPresent, 2); assert.equal(result.created, 6);
  const again = await importing(target, manifest); assert.equal(again.created, 0); assert.equal(again.alreadyPresent, 8);
});
test('conflicting or extra target documents block migration before any writes', async () => {
  const { source, target } = fixture(), manifest = await exported(source);
  target.seed('sh_operator_app_messages/73', { conflicting: true });
  await assert.rejects(importing(target, manifest), { migrationCode: 'DESTINATION_CONFLICT' }); assert.equal(target.commits, 0);
  target.docs.clear(); target.seed('sh_operator_unknown/extra', { neverOverwrite: true });
  await assert.rejects(importing(target, manifest), { migrationCode: 'DESTINATION_CONFLICT' }); assert.equal(target.commits, 0);
});
test('same-project imports, wrong hashes and missing maintenance confirmations fail closed', async () => {
  const { source, target } = fixture(), manifest = await exported(source);
  await assert.rejects(importing(source, manifest), { migrationCode: 'DESTINATION_MUST_BE_A_DIFFERENT_PROJECT' });
  await assert.rejects(importing(target, manifest, { expectedHash: 'wrong' }), { migrationCode: 'MANIFEST_HASH_MISMATCH' });
  await assert.rejects(importing(target, manifest, { destinationWritesPaused: false }), { migrationCode: 'BOTH_PROJECT_WRITERS_MUST_BE_PAUSED' });
  await assert.rejects(verifyDestination(target, manifest), { migrationCode: 'DESTINATION_INCOMPLETE' });
});
test('credential and media identity mismatches cannot be certified for cutover', async () => {
  const { source } = fixture(); source.docs.get('sh_operator_credentials/' + 'a'.repeat(64)).fields.generation = value(2);
  await assert.rejects(exported(source), { migrationCode: 'CREDENTIAL_GENERATION_MISMATCH' });
});
test('manifest tampering and bounded inventory limits are rejected', async () => {
  const { source } = fixture(), manifest = await exported(source);
  const changed = structuredClone(manifest); changed.documents[0].fields.push(['zz_private', ['string', 'tampered']]);
  assert.throws(() => validateManifest(changed), { migrationCode: 'MANIFEST_HASH_MISMATCH' });
  await assert.rejects(scanNamespace(source, 'sh_operator', { maxDocuments: 1 }), { migrationCode: 'DOCUMENT_LIMIT' });
  await assert.rejects(scanNamespace(source, 'sh_operator', { maxBytes: 1 }), { migrationCode: 'EXPORT_BYTE_LIMIT' });
});
class ReorderedProject extends FakeProject {
  constructor(source, reverse = false) {
    super(source.identity); this.docs = source.docs; this.reverse = reverse;
    this.active = 0; this.maximumActive = 0; this.pending = []; this.completed = []; this.calls = [];
    this.activeByKind = { collections: 0, documents: 0 }; this.maximumByKind = { collections: 0, documents: 0 };
  }
  async readDelay(kind, path) {
    this.calls.push([kind, path]); this.active++; this.maximumActive = Math.max(this.maximumActive, this.active);
    this.activeByKind[kind]++; this.maximumByKind[kind] = Math.max(this.maximumByKind[kind], this.activeByKind[kind]);
    await new Promise(resolve => {
      this.pending.push({ key: kind + ':' + path, kind, resolve });
      if (!this.flush) this.flush = setImmediate(() => {
        this.flush = null;
        const batch = this.pending.splice(0).sort((a, b) => a.key.localeCompare(b.key));
        if (this.reverse) batch.reverse();
        for (const item of batch) { this.active--; this.activeByKind[item.kind]--; this.completed.push(item.key); item.resolve(); }
      });
    });
  }
  async *listCollections(parent) {
    await this.readDelay('collections', parent); yield* super.listCollections(parent);
  }
  async *listDocuments(collection) {
    await this.readDelay('documents', collection); yield* super.listDocuments(collection);
  }
}
test('parent discovery is bounded to 32 concurrent reads and hashes are independent of completion order', async () => {
  const { source } = fixture();
  for (let index = 0; index < 48; index++) {
    const parent = 'sh_operator_probe/' + String(index).padStart(2, '0');
    if (index % 3) source.seed(parent, { index });
    // Every third parent is missing but still owns a child collection.
    source.seed(parent + '/children/record', { index, nested: true });
  }
  const expected = await scanNamespace(source), forward = new ReorderedProject(source), reverse = new ReorderedProject(source, true);
  const first = await scanNamespace(forward), second = await scanNamespace(reverse);
  assert.deepEqual(first, expected); assert.deepEqual(second, expected);
  assert.equal(forward.maximumActive, 32); assert.equal(reverse.maximumActive, 32);
  assert.notDeepEqual(forward.completed, reverse.completed);
  assert.equal(first.documents.length, 88); // Eight fixture docs, 32 parents, 48 descendants.
  assert.equal(first.collections.filter(path => path.endsWith('/children')).length, 48);
  assert.equal(forward.active, 0); assert.equal(reverse.active, 0);
  assert.ok(!forward.calls.some(([, path]) => path.startsWith('other_application')));
});
test('concurrent traversal shares global bounds, drains failed waves and admits no later work', async () => {
  const source = new FakeProject();
  for (let index = 0; index < 16; index++) source.seed('sh_operator_probe/' + index + '/children/record', { index });
  const delayed = new ReorderedProject(source, true);
  await assert.rejects(scanNamespace(delayed, 'sh_operator', { maxDocuments: 17 }), { migrationCode: 'DOCUMENT_LIMIT' });
  assert.equal(delayed.active, 0, 'all started reads are drained before the rejection');
  assert.ok(delayed.maximumActive <= 32);
  assert.equal(delayed.calls.filter(([kind, path]) => kind === 'collections' && path.endsWith('/children/record')).length, 0,
    'a failed wave must not begin the next breadth-first level');
  assert.equal(delayed.commits, 0);
});
test('root collection documents and parent discovery share the same 32-read ceiling', async () => {
  const source = new FakeProject();
  for (let index = 0; index < 48; index++) {
    const parent = 'sh_operator_root_' + String(index).padStart(2, '0') + '/record';
    source.seed(parent, { index }); source.seed(parent + '/children/nested', { index, nested: true });
  }
  const expected = await scanNamespace(source), forward = new ReorderedProject(source), reverse = new ReorderedProject(source, true);
  assert.deepEqual(await scanNamespace(forward), expected); assert.deepEqual(await scanNamespace(reverse), expected);
  assert.equal(expected.documents.length, 96); assert.equal(expected.collections.length, 96);
  for (const observed of [forward, reverse]) {
    assert.equal(observed.maximumActive, 32);
    assert.equal(observed.maximumByKind.documents, 32, 'root collection document reads must run concurrently');
    assert.equal(observed.maximumByKind.collections, 32);
    assert.equal(observed.active, 0); assert.deepEqual(observed.activeByKind, { collections: 0, documents: 0 });
    assert.equal(observed.commits, 0);
  }
});
test('the wire codec honors the official oneof discriminator and rejects malformed types', () => {
  const document = { name: root(sourceIdentity) + 'sh_operator_test/types', createTime: clock, updateTime: clock,
    fields: { zero: { integerValue: '0', booleanValue: false, stringValue: '', valueType: 'integerValue' } } };
  const encoded = encodeDocument(document, sourceIdentity, 'sh_operator');
  assert.deepEqual(decodeDocument(encoded, targetIdentity, 'sh_operator').fields.zero, { integerValue: '0' });
  assert.throws(() => encodeDocument({ ...document, fields: { invalid: { integerValue: '9223372036854775808' } } }, sourceIdentity, 'sh_operator'), { migrationCode: 'INVALID_INTEGER' });
});
test('offline inspection emits counts and hashes without customer content, FCM tokens or credential material', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sh-migration-'));
  try {
    const { source } = fixture(), manifest = await exported(source), file = join(directory, 'private-export.json');
    await writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
    const result = spawnSync(process.execPath, ['scripts/migrate-sh-firestore.mjs', 'inspect', '--file', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); const summary = JSON.parse(result.stdout); assert.equal(summary.documents, 8);
    assert.ok(!result.stdout.includes('PRIVATE_FCM_TOKEN')); assert.ok(!result.stdout.includes('PRIVATE_MESSAGE'));
    assert.ok(!result.stdout.includes('android_example')); assert.equal(result.stderr, '');
    await chmod(file, 0o644);
    const blocked = spawnSync(process.execPath, ['scripts/migrate-sh-firestore.mjs', 'inspect', '--file', file], { encoding: 'utf8' });
    assert.equal(blocked.status, 1); assert.equal(JSON.parse(blocked.stderr).code, 'PRIVATE_FILE_REQUIRED_MODE_0600');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
