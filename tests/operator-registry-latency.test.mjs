import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registryFixture, FirestoreFake, fixture } from './operator-r12-helpers.mjs';
import { createFirestoreMediaStore, eventStoreKey } from '../media-store/firestore-media-store.mjs';
import { createFirestoreDeviceRegistry } from '../operator-firestore-registry.js';
const hash = text => createHash('sha256').update(text).digest('hex');

test('authentication batches the indexed credential and device in a fresh read-only snapshot', async () => {
  const f = registryFixture(), enrollment = await f.enroll();
  const token = enrollment.result.body.deviceToken, id = enrollment.result.body.deviceId;
  const original = f.db.runTransaction.bind(f.db); let snapshots = 0, batches = 0;
  f.db.runTransaction = (callback, options) => {
    assert.deepEqual(options, { readOnly: true }); snapshots++;
    return original(tx => {
      tx.getAll = (...refs) => {
        batches++; assert.deepEqual(refs.map(ref => ref.path), ['sh_operator_credentials/' + hash(token), 'sh_operator_devices/' + id]);
        return Promise.all(refs.map(ref => tx.get(ref)));
      };
      tx.set = tx.create = tx.delete = () => { throw Error('Authentication must never write'); };
      return callback(tx);
    });
  };
  assert.equal((await f.registry.authenticate(token)).id, id);
  assert.equal((await f.registry.authenticate(token)).id, id);
  assert.equal(snapshots, 2); assert.equal(batches, 2);
});

test('a device read selector never overrides credential index, generation, hash or active state', async () => {
  for (const change of [{ active: false }, { generation: 999 }, { deviceId: 'android_wrong_device_123456789' }]) {
    const f = registryFixture(), enrollment = await f.enroll(), token = enrollment.result.body.deviceToken;
    const key = 'sh_operator_credentials/' + hash(token);
    f.db.seed('sh_operator_credentials', hash(token), { ...f.db.dump()[key], ...change });
    await assert.rejects(() => f.registry.authenticate(token), { status: 401, code: 'DEVICE_UNAUTHORIZED' });
  }
  const f = registryFixture(), enrollment = await f.enroll(), token = enrollment.result.body.deviceToken, id = enrollment.result.body.deviceId;
  f.db.seed('sh_operator_devices', id, { ...f.db.dump()['sh_operator_devices/' + id], tokenHash: hash('different-secret') });
  await assert.rejects(() => f.registry.authenticate(token), { status: 401 });
});

test('a revocation after a successful authentication is visible on the next authentication', async () => {
  const f = registryFixture(), enrollment = await f.enroll(), token = enrollment.result.body.deviceToken;
  assert.ok(await f.registry.authenticate(token));
  await f.registry.revokeDevice(enrollment.result.body.deviceId);
  await assert.rejects(() => f.registry.authenticate(token), { status: 401 });
});

test('existing opaque imported credentials keep the indexed lookup and fresh revocation checks', async () => {
  const f = registryFixture(), enrollment = await f.enroll(), id = enrollment.result.body.deviceId;
  const original = enrollment.result.body.deviceToken, opaque = 'opaque_imported_credential_'.repeat(3), digest = hash(opaque);
  f.db.seed('sh_operator_devices', id, { ...f.db.dump()['sh_operator_devices/' + id], tokenHash: digest });
  f.db.seed('sh_operator_credentials', digest, { ...f.db.dump()['sh_operator_credentials/' + hash(original)] });
  assert.equal((await f.registry.authenticate(opaque)).id, id);
  await f.registry.revokeDevice(id);
  await assert.rejects(() => f.registry.authenticate(opaque), { status: 401 });
});

test('authentication storage failures remain closed and do not expose SDK details', async () => {
  const f = registryFixture(), enrollment = await f.enroll();
  f.db.failReads = Error('Private SDK credential value');
  await assert.rejects(() => f.registry.authenticate(enrollment.result.body.deviceToken), error => error.status === 503 && !error.message.includes('Private'));
});

test('independent absent-only media creates use one batch while preserving atomic duplicate rejection', async () => {
  const db = new FirestoreFake(), run = db.runTransaction.bind(db); let batches = 0;
  db.runTransaction = callback => run(tx => {
    tx.getAll = (...refs) => { batches++; assert.equal(refs.length, 2); return Promise.all(refs.map(ref => tx.get(ref))); };
    return callback(tx);
  });
  const store = createFirestoreMediaStore({ firestore: db });
  const write = () => store.transaction(async tx => {
    tx.create(eventStoreKey('batch-event-a'), { id: 'batch-event-a' });
    tx.create(eventStoreKey('batch-event-b'), { id: 'batch-event-b' });
  });
  await write(); assert.equal(batches, 1);
  await assert.rejects(write, { code: 'RECORD_ALREADY_EXISTS' });
  assert.deepEqual(await store.get(eventStoreKey('batch-event-a')), { id: 'batch-event-a' });
});

test('storage and authentication timings contain only fixed labels, elapsed time and outcome', async () => {
  const db = new FirestoreFake(), records = [];
  const f = registryFixture({ db }), enrolled = await f.enroll();
  const registry = createFirestoreDeviceRegistry({ firestore: db, clock: () => 1800000000000, onTiming: row => records.push(row) });
  await registry.authenticate(enrolled.result.body.deviceToken);
  const store = createFirestoreMediaStore({ firestore: db, onTiming: row => records.push(row) });
  await store.transaction(async tx => { tx.create(eventStoreKey('PRIVATE_CUSTOMER_CALL'), { id: 'PRIVATE_CUSTOMER_CALL' }); });
  await store.get(eventStoreKey('PRIVATE_CUSTOMER_CALL'));
  assert.deepEqual(records.map(row => row.stage), ['authenticate', 'transaction', 'read']);
  for (const row of records) {
    assert.deepEqual(Object.keys(row).sort(), ['elapsedMs', 'ok', 'stage']);
    assert.ok(Number.isInteger(row.elapsedMs)); assert.equal(row.ok, true);
  }
  assert.ok(!JSON.stringify(records).includes('PRIVATE'));
  assert.ok(!JSON.stringify(records).includes(enrolled.result.body.deviceToken));
});

test('a diagnostic consumer failure cannot fail successful authentication or media reads', async () => {
  const f = registryFixture(), enrolled = await f.enroll();
  const registry = createFirestoreDeviceRegistry({ firestore: f.db, clock: () => 1800000000000, onTiming: () => { throw Error('log unavailable'); } });
  assert.ok(await registry.authenticate(enrolled.result.body.deviceToken));
  const store = createFirestoreMediaStore({ firestore: f.db, onTiming: () => { throw Error('log unavailable'); } });
  assert.equal(await store.get(eventStoreKey('missing-event')), undefined);
});

test('multi-leg End reads prior cleanup leases in a batch and retains durable recovery', async () => {
  const f = fixture(), connected = await f.connected();
  const invited = await f.runtime.transfer('a', connected.call.sessionId, 'invite', { version: connected.call.version, toDeviceId: 'b', requestId: 'batch-cleanup-invite' });
  const accepted = await f.runtime.transfer('b', connected.call.sessionId, 'accept', { version: invited.call.version, transferId: invited.call.transfer.id });
  assert.ok(accepted.join);
  const run = f.db.runTransaction.bind(f.db), batches = [];
  f.db.runTransaction = callback => run(tx => {
    tx.getAll = (...refs) => { batches.push(refs.map(ref => ref.path)); return Promise.all(refs.map(ref => tx.get(ref))); };
    return callback(tx);
  });
  const ended = await f.runtime.end('a', connected.call.sessionId, { requestId: 'batch-cleanup-end', expectedOwnerLegId: connected.call.ownerLegId });
  assert.ok(ended.call.terminal); assert.equal(ended.call.roomReady, false);
  assert.ok(batches.some(refs => refs.length >= 2 && refs.every(path => path.includes('_jobs/'))));
  await f.runtime.recoverSession(connected.call.sessionId);
  assert.equal((await f.runtime.status('a', connected.call.sessionId)).call.cleanupPending, false);
});
