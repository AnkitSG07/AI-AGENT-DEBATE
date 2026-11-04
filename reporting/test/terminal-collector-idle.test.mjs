// Actual production client + SQLite store, synthetic data and no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DocumentStore } from '../../cloudflare/operator-store/src/store.mjs';
import { createCloudflareFirestoreClient } from '../../operator-cloudflare-client.js';
import { createFirestoreReportStore } from '../firestore-report-store.mjs';
import { createTerminalReportCollector, createFirestoreTerminalReportSource } from '../terminal-collector.mjs';
import { sessionStoreKey } from '../../media-store/firestore-media-store.mjs';

const NOW = 1800000000000, TENANT = 'smart-handicrafts';
const CURSOR_PATH = 'sh_operator_reports_collector/terminal_sessions';
const idleState = cursor => ({ schema: 1, tenantId: TENANT, cursor, claimId: '', workerId: '', leaseUntilMs: 0, generation: 4 });

async function fixture(t) {
  const db = new DatabaseSync(':memory:'), requests = [], sqlWrites = [];
  let timestamp = NOW;
  const storage = {
    sql: { exec(sql, ...parameters) {
      if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) sqlWrites.push(sql);
      if (!parameters.length && sql.includes(';')) { db.exec(sql); return { toArray: () => [], *[Symbol.iterator]() {} }; }
      const statement = db.prepare(sql);
      const rows = statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []);
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    transactionSync(operation) {
      db.exec('BEGIN');
      try { const result = operation(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const backend = new DocumentStore(storage, { clock: () => timestamp });
  const migrationId = 'synthetic-idle-report-migration';
  backend.migration({ version: 1, op: 'begin', migrationId });
  const manifest = backend.migration({ version: 1, op: 'checksum', migrationId });
  backend.migration({ version: 1, op: 'seal', migrationId, expectedCount: manifest.count, expectedChecksum: manifest.checksum });
  backend.migration({ version: 1, op: 'activate', migrationId, expectedCount: manifest.count, expectedChecksum: manifest.checksum });
  const client = createCloudflareFirestoreClient({ endpoint: 'https://synthetic-report-store.test',
    secret: 'synthetic-report-only-secret-at-least-32-bytes', clock: () => timestamp,
    fetchImpl: async (_url, options) => {
      const input = JSON.parse(options.body); requests.push(input);
      const readOnly = ['read', 'query'].includes(input.op) || input.op === 'commit' && !input.writes.length;
      backend.acceptNonce(options.headers['x-sh-store-nonce'], timestamp + 120000, { persistent: !readOnly });
      try { return new Response(JSON.stringify(backend.rpc(input))); }
      catch (error) { return new Response(JSON.stringify({ ok: false, code: error.code }), { status: error.status || 503 }); }
    } });
  t.after(async () => { await client.terminate(); db.close(); });
  const newStore = () => createFirestoreReportStore({ firestore: client, clock: () => timestamp });
  const store = newStore(), source = createFirestoreTerminalReportSource({ firestore: client, clock: () => timestamp });
  const mediaStore = { durable: true, async get(key) {
    const [kind, documentId] = key.split('/');
    const snapshot = await client.collection('sh_operator_' + kind).doc(documentId).get();
    return snapshot.exists ? snapshot.data().data : undefined;
  } };
  const document = path => { const [collection, id] = path.split('/'); return client.collection(collection).doc(id); };
  const seedSession = async (id, endedAt = NOW - 50000) => {
    const key = sessionStoreKey(id), documentId = key.split('/')[1];
    await document('sh_operator_media_sessions/' + documentId).set({ schema: 1, key,
      data: { id, tenantId: TENANT, direction: 'incoming', createdAt: endedAt - 10000,
        terminal: { reason: 'TIMED_OUT', endedAt, confirmedAt: endedAt + 1 }, operations: {}, outbox: [], owner: null } });
    return { documentId, endedAtMs: endedAt };
  };
  const collector = (options = {}) => createTerminalReportCollector({ mediaStore, reportStore: store, source, ...options });
  const reset = () => { requests.length = 0; sqlWrites.length = 0; };
  return { client, store, newStore, source, collector, document, seedSession, reset, requests, sqlWrites,
    advance: milliseconds => { timestamp += milliseconds; } };
}

test('an empty current-cursor scan and restarted scan perform zero domain or SQLite writes', async t => {
  const f = await fixture(t), cursor = await f.seedSession('already-collected');
  await f.document(CURSOR_PATH).set(idleState(cursor));
  const before = (await f.document(CURSOR_PATH).get()).data(); f.reset();
  for (const reportStore of [f.store, f.newStore()]) {
    assert.deepEqual(await f.collector({ reportStore }).scan({ workerId: 'idle-worker' }),
      { busy: false, processed: 0, hasMore: false, results: [] });
  }
  assert.equal(f.requests.some(request => request.op === 'commit'), false);
  assert.equal(f.sqlWrites.length, 0, 'read RPCs must not create nonce rows, receipts or collector mutations');
  assert.ok(f.requests.filter(request => request.op === 'query').every(request => request.query.limit === 16));
  assert.deepEqual((await f.document(CURSOR_PATH).get()).data(), before);
});

test('an empty new database stays read-only without creating collector metadata', async t => {
  const f = await fixture(t); f.reset();
  assert.equal((await f.collector().scan({ workerId: 'empty-startup' })).processed, 0);
  assert.equal(f.sqlWrites.length, 0);
  assert.equal((await f.document(CURSOR_PATH).get()).exists, false);
});

test('work committed just after an empty preflight remains discoverable after restart', async t => {
  const f = await fixture(t); let injected = false, claims = 0;
  const reportStore = { ...f.store, claimCollection(...args) { claims++; return f.store.claimCollection(...args); } };
  const source = { async page(options) {
    const result = await f.source.page(options);
    if (!injected) { injected = true; await f.seedSession('late-terminal'); }
    return result;
  } };
  assert.equal((await f.collector({ source, reportStore }).scan({ workerId: 'first' })).processed, 0);
  assert.equal(claims, 0); assert.equal((await f.document(CURSOR_PATH).get()).exists, false);
  const result = await f.collector({ reportStore: f.newStore() }).scan({ workerId: 'restarted' });
  assert.equal(result.processed, 1); assert.equal(result.results[0].status, 'created');
  assert.equal((await f.store.select({ beforeMs: NOW })).rows[0].recordId, 'late-terminal');
});

test('a stale preflight cannot overwrite another worker cursor and real work uses the fresh claimed cursor', async t => {
  const f = await fixture(t), first = await f.seedSession('first-terminal', NOW - 60000);
  const second = await f.seedSession('second-terminal', NOW - 50000); let raced = false;
  const source = { async page(options) {
    const result = await f.source.page(options);
    if (!raced) {
      raced = true;
      const competing = await f.collector({ reportStore: f.newStore() }).scan({ workerId: 'competitor', limit: 1 });
      assert.equal(competing.results[0].status, 'created');
      assert.deepEqual((await f.document(CURSOR_PATH).get()).data().cursor, first);
    }
    return result;
  } };
  const result = await f.collector({ source }).scan({ workerId: 'stale-preview', limit: 1 });
  assert.equal(result.results[0].status, 'created');
  assert.equal(result.results[0].sessionId, 'second-terminal');
  assert.deepEqual((await f.document(CURSOR_PATH).get()).data().cursor, second);
  assert.equal((await f.store.select({ beforeMs: NOW })).rows.length, 2);
});

test('an active collection lease is respected without writing or querying terminal history', async t => {
  const f = await fixture(t);
  await f.document(CURSOR_PATH).set({ ...idleState(null), claimId: 'other-claim', workerId: 'other-worker', leaseUntilMs: NOW + 60000 });
  f.reset();
  const source = { page: () => assert.fail('An active collector owns discovery.') };
  assert.deepEqual(await f.collector({ source }).scan({ workerId: 'blocked-worker' }), { busy: true, processed: 0 });
  assert.equal(f.requests.length, 1); assert.equal(f.sqlWrites.length, 0);
  f.advance(60001); await f.seedSession('after-lease-expiry');
  assert.equal((await f.collector().scan({ workerId: 'replacement' })).results[0].status, 'created');
});

test('a worker winning the lease after preflight remains authoritative', async t => {
  const f = await fixture(t); await f.seedSession('contended-terminal'); let competing;
  const reportStore = { ...f.store, async claimCollection(workerId) {
    competing = await f.newStore().claimCollection('winning-worker');
    return f.store.claimCollection(workerId);
  } };
  assert.deepEqual(await f.collector({ reportStore }).scan({ workerId: 'losing-worker' }), { busy: true, processed: 0 });
  assert.equal((await f.store.select({ beforeMs: NOW })).rows.length, 0);
  await f.store.finishCollection(competing, null);
  assert.equal((await f.collector().scan({ workerId: 'later-worker' })).results[0].status, 'created');
});

test('an expired collector claim cannot regress a newer worker cursor or create a write', async t => {
  const f = await fixture(t), older = await f.seedSession('older-cursor', NOW - 60000);
  const newer = await f.seedSession('newer-cursor', NOW - 50000);
  const first = await f.store.claimCollection('expired-worker'); f.advance(60001);
  const second = await f.newStore().claimCollection('current-worker');
  assert.equal((await f.store.finishCollection(second, newer)).advanced, true); f.reset();
  assert.deepEqual(await f.store.finishCollection(first, older), { advanced: false });
  assert.equal(f.sqlWrites.length, 0);
  assert.deepEqual((await f.document(CURSOR_PATH).get()).data().cursor, newer);
});

for (const patch of [
  { tenantId: 'wrong-tenant' }, { generation: -1 }, { cursor: { documentId: 'invalid', endedAtMs: 0 } },
  { leaseUntilMs: NOW + 60000 }, { claimId: 'unreleased-without-lease' }
]) test('invalid persisted collector state fails closed before preflight or writes: ' + Object.keys(patch)[0], async t => {
  const f = await fixture(t); await f.document(CURSOR_PATH).set({ ...idleState(null), ...patch }); f.reset();
  await assert.rejects(f.collector({ source: { page: () => assert.fail('Invalid state must fail before discovery.') } }).scan({ workerId: 'invalid-state' }),
    { code: 'REPORT_STORAGE_UNAVAILABLE' });
  assert.equal(f.sqlWrites.length, 0);
});

test('a failed preflight leaves durable progress untouched and a later scan still catches work', async t => {
  const f = await fixture(t); await f.seedSession('retry-terminal'); f.reset();
  await assert.rejects(f.collector({ source: { page: async () => { throw Error('synthetic failed read'); } } }).scan({ workerId: 'failed-preview' }));
  assert.equal(f.sqlWrites.length, 0); assert.equal((await f.document(CURSOR_PATH).get()).exists, false);
  assert.equal((await f.collector().scan({ workerId: 'retry-preview' })).results[0].status, 'created');
});
