import test from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreFake, fixture } from './operator-r12-helpers.mjs';
import { createFirestoreMediaStore, eventStoreKey } from '../media-store/firestore-media-store.mjs';
import { readTransactionRecords } from '../media/transaction-reads.mjs';

test('explicit transaction batch uses one native getAll for unique independent records and preserves order/cache isolation', async () => {
  const db = new FirestoreFake(), store = createFirestoreMediaStore({ firestore: db });
  const a = eventStoreKey('batch-a'), b = eventStoreKey('batch-b'), missing = eventStoreKey('batch-missing');
  await store.transaction(async tx => {
    tx.create(a, { id: 'batch-a', value: 'A' }); tx.create(b, { id: 'batch-b', value: 'B' });
  });
  const run = db.runTransaction.bind(db), batches = []; let singleReads = 0;
  db.runTransaction = callback => run(tx => {
    const get = tx.get.bind(tx);
    tx.getAll = (...refs) => { batches.push(refs.map(ref => ref.path)); return Promise.all(refs.map(get)); };
    tx.get = ref => { singleReads++; return get(ref); };
    return callback(tx);
  });
  await store.transaction(async tx => {
    const rows = await tx.getAll([b, a, b, missing]);
    assert.deepEqual(rows, [{ id: 'batch-b', value: 'B' }, { id: 'batch-a', value: 'A' }, { id: 'batch-b', value: 'B' }, undefined]);
    rows[0].value = 'local mutation';
    assert.equal(rows[2].value, 'B'); assert.equal((await tx.get(b)).value, 'B');
    assert.deepEqual(await tx.getAll([a, missing]), [{ id: 'batch-a', value: 'A' }, undefined]);
  });
  assert.equal(batches.length, 1); assert.equal(batches[0].length, 3); assert.equal(singleReads, 0);
});

test('batch cannot read after staged writes or bypass exact hashed key validation', async () => {
  const store = createFirestoreMediaStore({ firestore: new FirestoreFake() });
  await assert.rejects(() => store.transaction(async tx => tx.getAll(['arbitrary/path'])), { code: 'INVALID_MEDIA_STORE_INPUT' });
  await assert.rejects(() => store.transaction(async tx => {
    tx.create(eventStoreKey('staged'), { id: 'staged' }); await tx.getAll([eventStoreKey('staged')]);
  }), { code: 'READS_BEFORE_WRITES' });
  assert.equal(await store.get(eventStoreKey('staged')), undefined);
});

test('native batch transport failure fails closed before any mutation is committed', async () => {
  const db = new FirestoreFake(), store = createFirestoreMediaStore({ firestore: db });
  const run = db.runTransaction.bind(db);
  db.runTransaction = callback => run(tx => {
    tx.getAll = async () => { throw Error('Private transport detail'); }; return callback(tx);
  });
  await assert.rejects(() => store.transaction(async tx => {
    await tx.getAll([eventStoreKey('failed')]); tx.create(eventStoreKey('failed'), { id: 'failed' });
  }), error => error.code === 'MEDIA_STORE_UNAVAILABLE' && !error.message.includes('Private'));
  assert.equal(await store.get(eventStoreKey('failed')), undefined);
});

test('incoming Answer requests its session and reservation in one native batch before provider dispatch', async () => {
  const f = fixture(); await f.incoming();
  const run = f.db.runTransaction.bind(f.db), batches = [];
  f.db.runTransaction = callback => run(tx => {
    const get = tx.get.bind(tx);
    tx.getAll = (...refs) => { batches.push(refs.map(ref => ref.path)); return Promise.all(refs.map(get)); };
    return callback(tx);
  });
  const answer = await f.accept(); assert.ok(answer.join);
  assert.ok(batches.some(paths => paths.length === 2 && paths.some(path => path.includes('_sessions/')) && paths.some(path => path.includes('_reservations/'))));
  assert.equal(f.effects.filter(row => row.kind === 'accept').length, 1);
});

test('legacy store adapter fallback preserves optional slots without reading null keys', async () => {
  const requested = [];
  const result = await readTransactionRecords({ get: async key => { requested.push(key); return key; } }, ['a', null, 'b']);
  assert.deepEqual(requested, ['a', 'b']); assert.deepEqual(result, ['a', undefined, 'b']);
});
