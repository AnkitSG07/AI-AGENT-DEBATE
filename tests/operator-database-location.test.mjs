import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createOperatorFirestoreRuntime } from '../operator-firestore-runtime.js';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { SH_ANDROID_REGISTRY_BACKEND: 'firestore', SH_ANDROID_FIREBASE_PROJECT_ID: 'demo-location-test',
  SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', project_id: 'demo-location-test',
    client_email: 'test@demo-location-test.iam.gserviceaccount.com', private_key: privateKey }) };
function make(result, loggerFailure = false) {
  const state = { reads: 0, closed: 0, logs: [] };
  class Data { async terminate() {} }
  class Admin {
    async getDatabase(request, options) {
      state.reads++; assert.equal(request.name, 'projects/demo-location-test/databases/(default)');
      assert.equal(options.timeout, 5000); assert.equal(options.retry, null);
      if (result instanceof Error) throw result;
      return [{ locationId: result, secret: 'PRIVATE_SERVER_METADATA' }];
    }
    async close() { state.closed++; }
  }
  const runtime = createOperatorFirestoreRuntime({ env, FirestoreClass: Data, FirestoreAdminClass: Admin,
    registryFactory: () => ({}), logger: { warn() {}, info: (...args) => { if (loggerFailure) throw Error('log unavailable'); state.logs.push(args); } } });
  return { runtime, state };
}
test('location probe is lazy, single-flight, read-only and logs only immutable region metadata', async () => {
  const { runtime, state } = make('asia-south1'); assert.equal(state.reads, 0);
  assert.deepEqual(await Promise.all([runtime.readDatabaseLocation(), runtime.readDatabaseLocation()]), ['asia-south1', 'asia-south1']);
  assert.equal(state.reads, 1); assert.equal(state.closed, 1);
  assert.deepEqual(state.logs, [['SH_CALL_DATABASE_LOCATION', JSON.stringify({ status: 'ok', locationId: 'asia-south1' })]]);
  assert.ok(!JSON.stringify(state.logs).includes(privateKey)); assert.ok(!JSON.stringify(state.logs).includes('PRIVATE_SERVER_METADATA'));
  await runtime.close();
});
test('denied metadata permission and invalid responses do not disable calling or leak SDK details', async () => {
  for (const result of [Error('PRIVATE_SDK_ERROR'), 'bad/location', undefined]) {
    const { runtime, state } = make(result); assert.equal(await runtime.readDatabaseLocation(), '');
    assert.equal(runtime.configured, true); assert.equal(state.closed, 1);
    assert.deepEqual(state.logs, [['SH_CALL_DATABASE_LOCATION', JSON.stringify({ status: 'unavailable' })]]);
    await runtime.close();
  }
});
test('a logging failure cannot change the diagnostic result or device runtime', async () => {
  const { runtime, state } = make('nam5', true); assert.equal(await runtime.readDatabaseLocation(), 'nam5');
  assert.equal(runtime.configured, true); assert.equal(state.closed, 1); await runtime.close();
});
