import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred } from './operator-r12-helpers.mjs';

async function actionFixture(action) {
  const f = fixture();
  if (action === 'accept') {
    await f.incoming();
    return { f, context: 'a', invoke: () => f.accept() };
  }
  if (action === 'ready') {
    await f.incoming();
    const accepted = await f.accept();
    return { f, context: 'a', invoke: () => f.ready(accepted) };
  }
  const connected = await f.connected();
  if (action === 'end') return { f, context: 'a', invoke: () => f.runtime.end('a', connected.call.sessionId,
    { expectedOwnerLegId: connected.call.ownerLegId, requestId: 'parallel-end-01' }) };
  const invited = await f.runtime.transfer('a', connected.call.sessionId, 'invite', {
    version: connected.call.version, toDeviceId: 'b', requestId: 'parallel-invite-01'
  });
  return { f, context: 'b', invoke: () => f.runtime.transfer('b', connected.call.sessionId, 'accept',
    { version: invited.call.version, transferId: invited.call.transfer.id }) };
}

for (const action of ['accept', 'ready', 'end', 'transfer']) {
  test(`${action} starts its non-authoritative lookup with authentication and waits for both`, { timeout: 5000 }, async () => {
    const { f, context, invoke } = await actionFixture(action);
    const authEntered = deferred(), lookupEntered = deferred(), releaseAuth = deferred(), releaseLookup = deferred();
    const actor = f.runtime.actor.bind(f.runtime), locate = f.runtime.locate.bind(f.runtime);
    let gateAuth = true, gateLookup = true;
    f.runtime.actor = async (...args) => {
      if (gateAuth && args[0] === context) { gateAuth = false; authEntered.resolve(); await releaseAuth.promise; }
      return actor(...args);
    };
    f.runtime.locate = async (...args) => {
      if (gateLookup) { gateLookup = false; lookupEntered.resolve(); await releaseLookup.promise; }
      return locate(...args);
    };
    const transactions = f.db.transactionRuns, effects = f.effects.length;
    let settled = false;
    const result = invoke().finally(() => { settled = true; });
    await Promise.all([authEntered.promise, lookupEntered.promise]);
    assert.equal(f.db.transactionRuns, transactions, 'no mutation may run before authentication');
    assert.equal(f.effects.length, effects, 'no provider or notification work may run before authentication');
    releaseAuth.resolve(); await Promise.resolve();
    assert.equal(settled, false, 'authentication alone cannot finish the action');
    releaseLookup.resolve();
    const response = await result;
    assert.ok(response.call);
  });
}

test('rejected authentication takes precedence and consumes an independently rejected lookup', async () => {
  const f = fixture(), release = deferred();
  let lookupDone = false;
  const denial = Object.assign(Error('Denied synthetic credential'), { code: 'UNAUTHENTICATED_DEVICE' });
  f.runtime.actor = async () => { await release.promise; throw denial; };
  f.runtime.locate = async () => { lookupDone = true; throw Error('Private lookup failure'); };
  const response = f.runtime.accept('unknown', 'private-call', { requestId: 'parallel-denied-01' });
  await Promise.resolve();
  assert.equal(lookupDone, true);
  release.resolve();
  await assert.rejects(response, error => error === denial);
  assert.equal(f.db.transactionRuns, 0); assert.deepEqual(f.effects, []);
});

test('authentication denial does not wait for a slow private lookup and its later failure is consumed', async () => {
  const f = fixture(), release = deferred(), entered = deferred();
  const denial = Object.assign(Error('Denied synthetic credential'), { code: 'UNAUTHENTICATED_DEVICE' });
  f.runtime.actor = async () => { throw denial; };
  f.runtime.locate = async () => { entered.resolve(); await release.promise; throw Error('Later private lookup failure'); };
  const response = f.runtime.accept('unknown', 'private-call', { requestId: 'parallel-slow-denied-01' });
  await entered.promise;
  await assert.rejects(response, error => error === denial);
  release.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.db.transactionRuns, 0); assert.deepEqual(f.effects, []);
});

test('terminal event during initial authentication defeats a previously located incoming call', async () => {
  const f = fixture(); await f.incoming();
  const authEntered = deferred(), release = deferred(), located = deferred();
  const actor = f.runtime.actor.bind(f.runtime), locate = f.runtime.locate.bind(f.runtime);
  let gateAuth = true, gateLookup = true;
  f.runtime.actor = async (...args) => {
    if (gateAuth) { gateAuth = false; authEntered.resolve(); await release.promise; }
    return actor(...args);
  };
  f.runtime.locate = async (...args) => {
    const result = await locate(...args);
    if (gateLookup) { gateLookup = false; located.resolve(); }
    return result;
  };
  const answer = f.accept();
  await Promise.all([authEntered.promise, located.promise]);
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: 'parallel-terminal-01', type: 'terminate',
    callId: 'call-in-1', phoneNumberId: 'business-1', occurredAtMs: f.now() });
  release.resolve();
  await assert.rejects(answer, { code: 'CALL_ENDED' });
  assert.equal(f.effects.filter(effect => effect.kind === 'accept').length, 0);
});

test('revocation during an overlapping lookup still prevents provider Accept', async () => {
  const f = fixture(); await f.incoming();
  const lookupEntered = deferred(), release = deferred();
  const locate = f.runtime.locate.bind(f.runtime);
  let gate = true;
  f.runtime.locate = async (...args) => {
    const result = await locate(...args);
    if (gate) { gate = false; lookupEntered.resolve(); await release.promise; }
    return result;
  };
  const answer = f.accept();
  await lookupEntered.promise;
  f.devices.get('a').revoked = true; release.resolve();
  await assert.rejects(answer, { code: 'DEVICE_BINDING_INVALID' });
  assert.equal(f.effects.filter(effect => effect.kind === 'accept').length, 0);
});
