import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStorageMigrationAdministration } from '../operator-storage-admin.js';
import { FirestoreFake } from './operator-r12-helpers.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const env = { SH_CLOUDFLARE_MIGRATION_ENABLED: 'true', SH_CLOUDFLARE_STORE_URL: 'https://private.example.test',
  SH_CLOUDFLARE_STORE_SECRET: 'fixture-normal-store-secret-at-least-32-characters',
  SH_CLOUDFLARE_MIGRATION_SECRET: 'fixture-migration-secret-different-at-least-32' };
const done = row => ({ id: 'done-job', status: 'done', ...row });
const settledSession = (id = 'session-1') => ({ id, tenantId: 'tenant-1', providerCallId: 'call-1', phase: 'ended',
  terminal: { endedAt: 10, confirmedAt: 11 }, operations: { dial: { status: 'provider-ended' } }, outbox: [done()] });
const settledCall = (id = 'call-1') => ({ id, tenantId: 'tenant-1', active: false, terminal: { endedAt: 10, confirmedAt: 11 }, outbox: [done()], transfer: null });
const legacySession = () => ({ ...settledSession(), direction: 'incoming', phase: 'answered_elsewhere', routeChoice: 'legacy',
  terminal: { reason: 'LEGACY_CLAIMED', nativeOnly: true, endedAt: 10 }, legacyClaim: { operationId: 'legacy-operation', claimedAt: 10 },
  operations: {}, outbox: [done({ kind: 'notify' })] });
function fixture({ videoQuiet = () => true, operation, source = new FirestoreFake() } = {}) {
  source.listCollections = async () => [];
  let captured, held = 0, releases = 0;
  const runtime = { configured: true, collectionPrefix: 'sh_operator',
    firestore: { runTransaction() { throw Error('Routed target must not be used by the quiet point.'); } },
    migration: { source, enabled: true, targetConfigured: true, assertNoActiveVideoCalls: videoQuiet,
      beginVideoCutoverGuard: () => { held++; return () => { held--; releases++; }; } } };
  const managerFactory = config => {
    captured = config;
    const run = async action => { if (operation) await operation(action); };
    return { status: async () => ({ mode: 'shadow', phase: 'replaying', epoch: 2, copied: 7, data: { secret: 'private-document' }, token: 'private-token' }),
      prepare: () => run('prepare'), copySnapshot: () => run('copy'), replay: () => run('replay'),
      cutover: async () => {
        if (config.classifyQuietManifest(manifest(), { collectionPrefix: 'sh_operator', migrationId: 'fixture-migration', epoch: 2 }) !== true)
          throw Object.assign(Error('Phone is in a call.'), { code: 'STORAGE_CALLS_STILL_ACTIVE' });
        const release = await config.beforeFence();
        try { const quiet = await source.runTransaction(tx => config.assertNoActiveCalls(tx));
          if (quiet !== true) throw Object.assign(Error('Phone is in a call.'), { code: 'STORAGE_CALLS_STILL_ACTIVE' });
          await run('cutover');
        } finally { release(); }
      } };
  };
  const manifest = () => JSON.parse(JSON.stringify([...source.documents].map(([path, data]) => ({ path, data }))));
  const admin = createStorageMigrationAdministration({ runtime, env, managerFactory, transportFactory: () => async () => ({ ok: true }) });
  const seed = (kind, row) => {
    if (kind === 'events') row = { tenantId: 'tenant-1', ...row };
    const id = hash(row.id || row.deviceId || 'reservation');
    source.seed(`sh_operator_media_${kind}`, id, { schema: 1, key: `media_${kind}/${id}`, revision: 1, updatedAt: 12, data: row });
    return id;
  };
  return { source, runtime, admin, seed, quiet: async () => captured.classifyQuietManifest(manifest()),
    localQuiet: tx => captured.assertNoActiveCalls(tx), guard: () => captured.beforeFence(), stats: () => ({ held, releases }) };
}
async function finished(admin) { for (let i = 0; i < 20; i++) { const status = await admin.status(); if (!status.running) return status;
  await new Promise(resolve => setImmediate(resolve)); } throw Error('Background action did not finish.'); }

test('the admin only accepts four bounded actions, returning before the background operation finishes', async () => {
  let finish, started = false;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = fixture({ operation: async () => { started = true; await gate; } });
  const accepted = f.admin.run('copy');
  assert.equal(accepted.accepted, true); assert.equal(accepted.job.action, 'copy'); assert.equal(started, false);
  assert.throws(() => f.admin.run('fence'), { code: 'STORAGE_MIGRATION_ACTION_INVALID' });
  assert.throws(() => f.admin.run('completeCutover'), { code: 'STORAGE_MIGRATION_ACTION_INVALID' });
  assert.throws(() => f.admin.run('replay'), { code: 'STORAGE_MIGRATION_BUSY', status: 409 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(started, true);
  let closed = false; const close = f.admin.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  assert.throws(() => f.admin.run('prepare'), { code: 'STORAGE_MIGRATION_CLOSED' });
  finish(); await close; assert.equal((await f.admin.status()).job.state, 'succeeded');
});
test('status and background failures never expose document data, credentials or exception messages', async () => {
  const f = fixture({ operation: async () => { throw Object.assign(Error('private-record-and-service-key'), { code: 'STORAGE_TARGET_MANIFEST_MISMATCH', details: { token: 'secret' } }); } });
  f.admin.run('prepare'); const status = await finished(f.admin), serialized = JSON.stringify(status);
  assert.equal(status.job.errorCode, 'STORAGE_TARGET_MANIFEST_MISMATCH'); assert.equal(status.migration.copied, 7);
  for (const secret of ['private-record', 'service-key', 'private-document', 'private-token', 'details']) assert.equal(serialized.includes(secret), false);
});
test('configuration is fail closed without disabling the existing source runtime', async () => {
  for (const override of [{ SH_CLOUDFLARE_MIGRATION_ENABLED: 'false' }, { SH_CLOUDFLARE_MIGRATION_SECRET: env.SH_CLOUDFLARE_STORE_SECRET },
    { SH_CLOUDFLARE_STORE_URL: 'http://private.example.test' }, { SH_CLOUDFLARE_MIGRATION_SECRET: '' }]) {
    const f = fixture(); const admin = createStorageMigrationAdministration({ runtime: f.runtime, env: { ...env, ...override } });
    assert.equal((await admin.status()).configured, false); assert.throws(() => admin.run('prepare'), /Storage administration/);
    assert.equal(f.runtime.configured, true); assert.equal(f.runtime.migration.targetConfigured, true);
  }
  const f = fixture(); f.runtime.migration.targetConfigured = false;
  const admin = createStorageMigrationAdministration({ runtime: f.runtime, env });
  assert.equal((await admin.status()).errorCode, 'STORAGE_MIGRATION_NOT_CONFIGURED');
});
test('empty and fully settled source call state passes pure preflight classification', async () => {
  const f = fixture(); assert.equal(await f.quiet(), true);
  f.seed('calls', settledCall()); f.seed('sessions', settledSession());
  f.seed('events', { id: 'answer:call-1', kind: 'pending-answer', providerCallId: 'call-1' });
  f.source.seed('sh_operator_media_jobs', 'session-projection', { workType: 'session', sessionId: 'session-1', data: { phase: 'ended' } });
  f.source.seed('sh_operator_media_jobs', 'cleanup-projection', { workType: 'cleanup', callId: 'call-1', data: done() });
  assert.equal(await f.quiet(), true);
});
for (const [label, kind, row] of [
  ['ringing before a canonical call exists', 'sessions', { ...settledSession(), terminal: undefined, phase: 'ringing' }],
  ['joining an outgoing call', 'sessions', { ...settledSession(), terminal: undefined, phase: 'joining' }],
  ['terminal cleanup still running', 'sessions', { ...settledSession(), outbox: [{ status: 'running' }] }],
  ['an ambiguous provider leg after hangup', 'sessions', { ...settledSession(), operations: { dial: { status: 'uncertain' } } }],
  ['an unconfirmed hangup', 'sessions', { ...settledSession(), terminal: { endedAt: 10 } }],
  ['a connected canonical call', 'calls', { ...settledCall(), active: true, terminal: undefined }],
  ['a pending transfer after termination', 'calls', { ...settledCall(), transfer: { status: 'connecting' } }],
  ['an expired device reservation', 'reservations', { deviceId: 'phone', expiresAt: 0, kind: 'invite' }],
  ['an orphaned early answer', 'events', { id: 'early-answer', kind: 'pending-answer', providerCallId: 'unknown-call' }],
  ['an accepted customer leg not yet correlated', 'events', { id: 'accepted', kind: 'customer-accepted', providerCallId: 'unknown-call' }],
  ['a native-only legacy claim', 'sessions', { ...settledSession(), phase: 'answered_elsewhere', terminal: { nativeOnly: true, endedAt: 10 } }]
]) test(`cutover waits for ${label}`, async () => {
  const f = fixture(); f.seed(kind, row); assert.equal(await f.quiet(), false);
  f.admin.run('cutover'); const status = await finished(f.admin);
  assert.equal(status.job.state, 'failed'); assert.equal(status.job.errorCode, 'STORAGE_CALLS_STILL_ACTIVE');
  assert.deepEqual(f.stats(), { held: 0, releases: 0 });
});
test('the final gate callback only checks process-local video and never reads media history', async () => {
  const f = fixture(); f.source.failReads = Error('No media reads are permitted under the source gate.');
  assert.equal(f.localQuiet({ get() { throw Error('No final transaction history scan.'); } }), true);
  f.admin.run('cutover'); assert.equal((await finished(f.admin)).job.state, 'succeeded');
  assert.deepEqual(f.stats(), { held: 0, releases: 1 });
});
test('retained history beyond 100 records classifies outside the gate without blocking cutover', async () => {
  const f = fixture();
  for (let index = 0; index < 240; index++) {
    f.seed('calls', settledCall(`call-${index}`));
    f.seed('sessions', { ...settledSession(`session-${index}`), providerCallId: `call-${index}` });
    f.seed('events', { id: `terminal:call-${index}`, kind: 'terminal', providerCallId: `call-${index}`, createdAt: 20 });
  }
  const transactionsBefore = f.source.transactionRuns; f.admin.run('cutover');
  assert.equal((await finished(f.admin)).job.state, 'succeeded');
  assert.equal(f.source.transactionRuns, transactionsBefore + 1); assert.deepEqual(f.stats(), { held: 0, releases: 1 });
});
test('activity beyond the first 100 historical records is still examined and blocks cutover', async () => {
  const f = fixture();
  for (let index = 0; index < 240; index++)
    f.seed('events', { id: `terminal:old-${index}`, kind: 'terminal', providerCallId: `old-${index}`, createdAt: 20 });
  f.seed('sessions', { ...settledSession('latest-ringing'), terminal: undefined, phase: 'ringing' });
  assert.equal(await f.quiet(), false); f.admin.run('cutover');
  assert.equal((await finished(f.admin)).job.errorCode, 'STORAGE_CALLS_STILL_ACTIVE');
  assert.deepEqual(f.stats(), { held: 0, releases: 0 });
});
test('video admission and an explicit synchronous quiet callback are required before the fence', async () => {
  const active = fixture({ videoQuiet: () => false }); active.admin.run('cutover');
  assert.equal((await finished(active.admin)).job.errorCode, 'STORAGE_CALLS_STILL_ACTIVE'); assert.equal(active.stats().held, 0);
  const invalid = fixture({ videoQuiet: async () => true });
  assert.throws(() => invalid.localQuiet(), { code: 'STORAGE_VIDEO_QUIET_CHECK_INVALID' });
  const absent = fixture(); delete absent.runtime.migration.beginVideoCutoverGuard;
  assert.throws(() => absent.admin.run('cutover'), { code: 'STORAGE_VIDEO_QUIET_CHECK_REQUIRED' });
});
test('a legacy answered-elsewhere row settles only with its exact durable tenant and provider terminal marker', async () => {
  const f = fixture(); f.seed('sessions', legacySession());
  f.seed('events', { id: 'terminal:call-1', kind: 'terminal', providerCallId: 'call-1', createdAt: 20 });
  assert.equal(await f.quiet(), true); f.admin.run('cutover'); assert.equal((await finished(f.admin)).job.state, 'succeeded');
});
for (const [label, sessionPatch, terminal] of [
  ['a terminal marker for another tenant', {}, { tenantId: 'other-tenant', id: 'terminal:call-1', providerCallId: 'call-1' }],
  ['a terminal marker for another provider call', {}, { id: 'terminal:other-call', providerCallId: 'other-call' }],
  ['a generic provider-event termination hint', {}, { id: 'event-terminate', kind: 'provider-event', eventType: 'terminate', providerCallId: 'call-1' }],
  ['no provider call binding', { providerCallId: '' }, { id: 'terminal:call-1', providerCallId: 'call-1' }],
  ['an uncertain media operation', { operations: { dial: { status: 'uncertain' } } }, { id: 'terminal:call-1', providerCallId: 'call-1' }],
  ['unacknowledged notification cleanup', { outbox: [{ kind: 'notify', status: 'pending' }] }, { id: 'terminal:call-1', providerCallId: 'call-1' }],
  ['a fabricated legacy phase without its claim', { legacyClaim: undefined }, { id: 'terminal:call-1', providerCallId: 'call-1' }]
]) test(`legacy history remains blocking with ${label}`, async () => {
  const f = fixture(); f.seed('sessions', { ...legacySession(), ...sessionPatch });
  f.seed('events', { kind: 'terminal', createdAt: 20, ...terminal }); assert.equal(await f.quiet(), false);
});
test('a malformed terminal marker cannot fabricate provider-ended evidence', async () => {
  const f = fixture(); f.seed('sessions', legacySession());
  f.seed('events', { id: 'wrong-marker-id', kind: 'terminal', providerCallId: 'call-1', createdAt: 20 });
  await assert.rejects(f.quiet(), { code: 'STORAGE_QUIET_RECORD_INVALID' });
});
test('a fabricated confirmed terminal field cannot replace exact provider-ended evidence for a legacy claim', async () => {
  const f = fixture(); const legacy = legacySession();
  f.seed('sessions', { ...legacy, phase: 'ended', terminal: { ...legacy.terminal, confirmedAt: 11 } });
  assert.equal(await f.quiet(), false);
});
test('unknown or malformed durable media state cannot be treated as quiet', async () => {
  const f = fixture(); f.source.seed('sh_operator_media_sessions', 'malformed', { data: { phase: 'ended' } });
  await assert.rejects(f.quiet(), { code: 'STORAGE_QUIET_RECORD_INVALID' });
  const events = fixture(); events.seed('events', { id: 'future-event', kind: 'new-media-leg' });
  await assert.rejects(events.quiet(), { code: 'STORAGE_QUIET_EVENT_UNSUPPORTED' });
  const jobs = fixture(); jobs.source.seed('sh_operator_media_jobs', 'future-job', { workType: 'video', data: {} });
  await assert.rejects(jobs.quiet(), { code: 'STORAGE_QUIET_JOB_UNSUPPORTED' });
});
