import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorAiControls, validOperatorAiFeatures } from '../operator-ai-controls.js';

const configured = { drafts: true, productSuggestions: true, voiceFallback: true, autoReplies: true };

function fixture() {
  let document;
  let failedWrite = false;
  let failedRead = false;
  let availability = configured;
  const snapshot = () => ({ exists: !!document, data: () => structuredClone(document) });
  const ref = { get: async () => {
    if (failedRead) throw new Error('fixture read unavailable');
    return snapshot();
  } };
  const db = { runTransaction: async callback => {
    const result = await callback({ get: async () => snapshot(), set: (_, data) => { document = structuredClone(data); } });
    if (failedWrite) throw new Error('fixture write acknowledgement lost');
    return result;
  } };
  const create = () => createOperatorAiControls({ getStore: () => ({ db, ref }), getAvailability: () => availability });
  function change(controls, patch) {
    const { masterEnabled, features, legacyMode, epoch, revision } = controls.view();
    return controls.update({ masterEnabled, features, legacyMode, expectedEpoch: epoch, expectedRevision: revision, ...patch });
  }
  return { create, change, failWrite: () => { failedWrite = true; }, failRead: () => { failedRead = true; },
    setAvailability: value => { availability = value; } };
}

test('master off cancels all admitted work and persists through a fresh backend process', async () => {
  const f = fixture(), controls = f.create();
  assert.equal(controls.startRequest('voiceFallback'), null);
  await controls.ready();
  assert.equal(await f.change(controls, { features: configured }), 'saved');
  const leases = Object.keys(configured).map(feature => controls.startRequest(feature));
  assert.ok(leases.every(lease => !lease.signal.aborted));
  assert.equal(await f.change(controls, { masterEnabled: false }), 'saved');
  assert.ok(leases.every(lease => lease.signal.aborted));
  const restarted = f.create();
  await restarted.ready();
  assert.equal(restarted.view().masterEnabled, false);
  assert.deepEqual(restarted.view().features, configured);
  assert.ok(Object.keys(configured).every(feature => restarted.startRequest(feature) === null));
  assert.equal(await f.change(restarted, { masterEnabled: true }), 'saved');
  assert.ok(Object.keys(configured).every(feature => restarted.enabled(feature)));
});

test('feature selection cancels only its own work and configuration still controls availability', async () => {
  const f = fixture(), controls = f.create();
  await controls.ready();
  assert.equal(controls.startRequest('autoReplies'), null);
  const draft = controls.startRequest('drafts');
  const voice = controls.startRequest('voiceFallback');
  assert.equal(await f.change(controls, { features: { ...configured, voiceFallback: false } }), 'saved');
  assert.equal(voice.signal.aborted, true);
  assert.equal(draft.signal.aborted, false);
  assert.equal(controls.startRequest('voiceFallback'), null);
  assert.ok(controls.startRequest('productSuggestions'));
  f.setAvailability({ ...configured, productSuggestions: false });
  assert.equal(controls.startRequest('productSuggestions'), null);
  assert.deepEqual(controls.view().availableFeatures, { ...configured, productSuggestions: false });
  draft.finish();
  assert.equal(await f.change(controls, { masterEnabled: false }), 'saved');
  assert.equal(draft.signal.aborted, false);
  assert.equal(validOperatorAiFeatures({ ...configured, video: true }), false);
  assert.equal(validOperatorAiFeatures({ ...configured, drafts: 'false' }), false);
});

test('competing or stale clients cannot overwrite the stored selection', async () => {
  const f = fixture(), a = f.create(), b = f.create();
  await Promise.all([a.ready(), b.ready()]);
  assert.equal(await f.change(a, { masterEnabled: false }), 'saved');
  assert.equal(await f.change(b, { masterEnabled: true }), 'conflict');
  assert.equal(b.view().masterEnabled, false);
  assert.equal(await f.change(b, { expectedEpoch: a.view().epoch }), 'conflict');
});

test('lost write acknowledgement suspends work and re-reads persisted state', async () => {
  const f = fixture(), controls = f.create();
  await controls.ready();
  const draft = controls.startRequest('drafts');
  f.failWrite();
  assert.equal(await f.change(controls, { masterEnabled: false }), 'unavailable');
  assert.equal(draft.signal.aborted, true);
  await controls.ready();
  assert.equal(controls.view().masterEnabled, false);
  assert.equal(controls.startRequest('drafts'), null);
});

test('storage read failures admit no AI work or writes', async () => {
  const f = fixture(), controls = f.create();
  f.failRead();
  await controls.ready();
  assert.equal(controls.view().settingsReady, false);
  assert.equal(controls.startRequest('drafts'), null);
  assert.equal(await f.change(controls, { masterEnabled: true }), 'unavailable');
});
