import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHostingPreflight } from '../scripts/hosting-preflight.mjs';
import { createOperatorFirestoreRuntime } from '../operator-firestore-runtime.js';

const secret = 'PRIVATE_PREFLIGHT_CREDENTIAL_CANARY';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { SH_ANDROID_REGISTRY_BACKEND: 'firestore', SH_ANDROID_FIREBASE_PROJECT_ID: 'demo-preflight-private',
  SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', project_id: 'demo-preflight-private',
    client_email: 'test@demo-preflight-private.iam.gserviceaccount.com', private_key: privateKey }) };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  const state = { reads: 0, metadata: 0, closes: 0, maintenance: 0, logs: [] };
  const runtime = { backend: 'firestore', configured: true,
    deviceRegistry: { checkAvailability: async () => { state.reads++; return true; } },
    readDatabaseLocation: async () => { state.metadata++; return 'asia-south1'; },
    startMaintenance() { state.maintenance++; throw Error(secret); },
    close: async () => { state.closes++; } };
  const app = createHostingPreflight({ env: {}, runtimeFactory: () => runtime,
    logger: { info: (...args) => state.logs.push(args) }, ...options });
  return { app, state, runtime };
}
async function request(app, path = '/health', method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null, cacheControl: response.headers.get('cache-control') };
}
function assertPrivate(value) {
  const text = JSON.stringify(value);
  for (const forbidden of [secret, privateKey, 'demo-preflight-private', 'iam.gserviceaccount.com', '(default)']) {
    assert.equal(text.includes(forbidden), false);
  }
}

test('production runtime path only reads registry metadata and database location; no maintenance or writes', async () => {
  const state = { reads: 0, metadata: 0, writes: 0, scans: 0, maintenance: 0, terminated: 0, adminClosed: 0, logs: [] };
  const forbidWrite = () => { state.writes++; throw Error(secret); };
  class Data {
    collection(name) {
      return {
        where() { state.scans++; throw Error(secret); },
        doc(id) { return {
          async get() {
            assert.equal(name, 'sh_operator_metadata'); assert.equal(id, 'registry'); state.reads++;
            return { exists: false, data() { throw Error(secret); } };
          },
          set: forbidWrite, create: forbidWrite, update: forbidWrite, delete: forbidWrite
        }; }
      };
    }
    runTransaction = forbidWrite;
    batch = forbidWrite;
    async terminate() { state.terminated++; }
  }
  class Admin {
    async getDatabase(input) {
      state.metadata++; assert.equal(input.name, 'projects/demo-preflight-private/databases/(default)');
      return [{ locationId: 'asia-south1', privateMetadata: secret }];
    }
    async close() { state.adminClosed++; }
  }
  const app = createHostingPreflight({ env, logger: { info: (...args) => state.logs.push(args) },
    runtimeFactory: options => {
      const runtime = createOperatorFirestoreRuntime({ ...options, FirestoreClass: Data, FirestoreAdminClass: Admin });
      runtime.startMaintenance = () => { state.maintenance++; throw Error(secret); };
      return runtime;
    } });
  try {
    assert.deepEqual(await app.run(), { ok: true, configured: true });
    assert.equal(state.reads, 3); assert.equal(state.metadata, 1); assert.equal(state.adminClosed, 1);
    assert.equal(state.writes, 0); assert.equal(state.scans, 0); assert.equal(state.maintenance, 0);
    const records = state.logs.map(([tag, text]) => { assert.equal(tag, 'SH_HOSTING_PREFLIGHT'); return JSON.parse(text); });
    assert.deepEqual(records.slice(0, 3).map(row => [row.event, row.sample, row.warm, row.ok]), [
      ['database_read', 1, false, true], ['database_read', 2, true, true], ['database_read', 3, true, true]
    ]);
    assert.deepEqual(records[3], { event: 'database_location', ok: true, elapsedMs: records[3].elapsedMs, locationId: 'asia-south1' });
    assert.ok(records.slice(0, 4).every(row => Number.isInteger(row.elapsedMs) && row.elapsedMs >= 0));
    assertPrivate(state.logs);
  } finally { await app.close(); }
  await app.close(); assert.equal(state.terminated, 1);
});

test('/health is cached, returns only booleans, and exposes no application routes or database details', async () => {
  const pending = deferred();
  const { app, runtime, state } = fixture();
  runtime.deviceRegistry.checkAvailability = async () => { state.reads++; if (state.reads === 1) await pending.promise; return true; };
  try {
    await app.start({ port: 0, host: '127.0.0.1' });
    const before = await request(app);
    assert.equal(before.status, 503); assert.deepEqual(before.body, { ok: false, configured: true });
    assert.equal(state.reads, 1); pending.resolve(); await app.run();
    for (let index = 0; index < 8; index++) {
      const health = await request(app);
      assert.equal(health.status, 200); assert.deepEqual(health.body, { ok: true, configured: true });
      assert.equal(health.cacheControl, 'no-store'); assert.equal(health.text.includes('asia-south1'), false); assertPrivate(health);
    }
    assert.equal((await request(app, '/health', 'HEAD')).text, '');
    for (const [path, method] of [['/', 'GET'], ['/api/operator-android/config', 'GET'], ['/health', 'POST'], ['/health?details=true', 'GET']]) {
      const result = await request(app, path, method); assert.equal(result.status, 404); assert.deepEqual(result.body, { ok: false });
    }
    assert.equal(state.reads, 3); assert.equal(state.metadata, 1); assert.equal(state.maintenance, 0);
  } finally { pending.resolve(); await app.close(); }
  assert.equal(state.closes, 1); assert.deepEqual(app.status(), { ok: false, configured: true });
});

test('missing configuration does not issue reads or disclose configuration exceptions', async () => {
  for (const runtimeFactory of [() => { throw Error(secret); }, () => ({ backend: 'file', configured: false })]) {
    const logs = [], app = createHostingPreflight({ runtimeFactory, env: { PRIVATE_VALUE: secret }, logger: { info: (...args) => logs.push(args) } });
    try {
      await app.start({ port: 0, host: '127.0.0.1' });
      assert.deepEqual(await app.run(), { ok: false, configured: false });
      assert.deepEqual((await request(app)).body, { ok: false, configured: false }); assertPrivate(logs);
    } finally { await app.close(); }
  }
});

test('a failed availability read stops sampling, closes the runtime once, and hides the error', async () => {
  const { app, runtime, state } = fixture();
  runtime.deviceRegistry.checkAvailability = async () => { state.reads++; throw Error(secret); };
  assert.deepEqual(await app.run(), { ok: false, configured: true });
  assert.deepEqual(await app.run(), { ok: false, configured: true });
  assert.equal(state.reads, 1); assert.equal(state.metadata, 0); assert.equal(state.closes, 1); assertPrivate(state.logs);
  await app.close(); assert.equal(state.closes, 1);
});

test('metadata failure or unexpected data never reaches health or log output', async () => {
  for (const result of [Error(secret), `projects/${secret}/databases/private`, { locationId: 'asia-south1', secret }]) {
    const { app, runtime, state } = fixture();
    runtime.readDatabaseLocation = async () => { state.metadata++; if (result instanceof Error) throw result; return result; };
    try {
      assert.deepEqual(await app.run(), { ok: false, configured: true });
      assert.equal(state.reads, 3); assert.equal(state.metadata, 1); assertPrivate(state.logs);
      const metadata = state.logs.map(row => JSON.parse(row[1])).find(row => row.event === 'database_location');
      assert.deepEqual(Object.keys(metadata).sort(), ['elapsedMs', 'event', 'ok']); assert.equal(metadata.ok, false);
    } finally { await app.close(); }
    assert.equal(state.closes, 1);
  }
});

test('a stalled point read is bounded and never produces overlapping or repeated samples', { timeout: 1000 }, async () => {
  const pending = deferred(), { app, runtime, state } = fixture({ operationTimeoutMs: 10, shutdownTimeoutMs: 10 });
  runtime.deviceRegistry.checkAvailability = async () => { state.reads++; return pending.promise; };
  assert.deepEqual(await app.run(), { ok: false, configured: true });
  assert.equal(state.reads, 1); assert.equal(state.metadata, 0); assert.equal(state.closes, 1);
  pending.reject(Error(secret)); await new Promise(resolve => setImmediate(resolve));
  await app.run(); await app.close(); assert.equal(state.reads, 1); assert.equal(state.closes, 1); assertPrivate(state.logs);
});

test('metadata and shutdown deadlines settle even when third-party clients never return', { timeout: 1000 }, async () => {
  const { app, runtime, state } = fixture({ operationTimeoutMs: 10, shutdownTimeoutMs: 10 });
  runtime.readDatabaseLocation = () => { state.metadata++; return new Promise(() => {}); };
  runtime.close = () => { state.closes++; return new Promise(() => {}); };
  assert.deepEqual(await app.run(), { ok: false, configured: true });
  await app.close(); assert.equal(state.reads, 3); assert.equal(state.metadata, 1); assert.equal(state.closes, 1);
  assertPrivate(state.logs);
});

test('shutdown interrupts sampling and prevents further reads; logging failures do not affect cleanup', { timeout: 1000 }, async () => {
  const pending = deferred(), { app, runtime, state } = fixture({ logger: { info() { throw Error(secret); } } });
  runtime.deviceRegistry.checkAvailability = async () => { state.reads++; return pending.promise; };
  const run = app.run(); await new Promise(resolve => setImmediate(resolve));
  await Promise.all([app.close(), app.close()]);
  assert.deepEqual(await run, { ok: false, configured: true });
  pending.resolve(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.reads, 1); assert.equal(state.metadata, 0); assert.equal(state.closes, 1); assert.equal(state.maintenance, 0);
});

test('successful diagnostics tolerate a broken logger and concurrent listener shutdown closes the port', { timeout: 1000 }, async () => {
  const success = fixture({ logger: { info() { throw Error(secret); } } });
  assert.deepEqual(await success.app.run(), { ok: true, configured: true });
  await success.app.close(); assert.equal(success.state.closes, 1);
  const { app, state } = fixture();
  const listen = app.start({ port: 0, host: '127.0.0.1' });
  await Promise.all([listen, app.close()]);
  assert.equal(app.server.listening, false); assert.equal(state.reads, 0); assert.equal(state.closes, 1);
});

test('the entrypoint has no application/worker imports and importing it cannot start a listener', async () => {
  const script = new URL('../scripts/hosting-preflight.mjs', import.meta.url), source = await readFile(script, 'utf8');
  const imports = [...source.matchAll(/^import .*? from '([^']+)'/gm)].map(match => match[1]);
  assert.deepEqual(imports.filter(name => !name.startsWith('node:')), ['../operator-firestore-runtime.js']);
  assert.equal(/\bsetInterval\s*\(/.test(source), false);
  assert.equal(/\.startMaintenance\s*\(/.test(source), false);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(script.href)}); console.log('import-only');`],
    { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, PORT: 'invalid', SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON: secret } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'import-only'); assert.equal(result.stderr, '');
  for (const sampleCount of [0, 6, Infinity]) assert.throws(() => fixture({ sampleCount }), /Invalid preflight limit/);
});
