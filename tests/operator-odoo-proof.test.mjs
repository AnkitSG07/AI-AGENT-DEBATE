import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createOdooOperatorProofVerifier } from '../operator-odoo-proof.js';

const NOW = Date.parse('2026-11-13T09:21:23.650Z');
const PROOF = { proofId: 31, digest: 'd'.repeat(64), issuedAt: NOW - 100, expiresAt: NOW + 45000 };
const STAMP = { id: 31, x_name: PROOF.digest, create_uid: [7, 'Operator'], create_date: '2026-11-13 09:21:23' };
const STAFF = { id: 7, active: true, share: false, company_ids: [5, 8] };
const GRANTS = '{"7":["mail:read","ai:draft"],"8":["documents:read"]}';

function fixture({ proofRows = [STAMP], userRows = [STAFF], grantsJson = GRANTS, companyId,
  clock = () => NOW, failure } = {}) {
  const calls = [];
  const verify = createOdooOperatorProofVerifier({ grantsJson, companyId, clock,
    execute: async (model, method, args, kwargs) => {
      calls.push({ model, method, args, kwargs });
      if (failure) throw failure;
      if (model === 'x_sh_operator_proof') return proofRows;
      if (model === 'res.users') return userRows;
      throw new Error('Unexpected model');
    }
  });
  return { verify, calls };
}

test('verifies the exact Odoo proof and loads only the creator’s explicitly approved scopes', async () => {
  const f = fixture({ companyId: '5' });
  const grant = await f.verify({ ...PROOF, uid: 8, scopes: ['mail:write'] });
  assert.deepEqual(grant, { uid: 7, scopes: ['mail:read', 'ai:draft'] });
  assert.ok(Object.isFrozen(grant) && Object.isFrozen(grant.scopes));
  assert.deepEqual(f.calls, [
    { model: 'x_sh_operator_proof', method: 'search_read', args: [[['id', '=', 31]]],
      kwargs: { fields: ['id', 'x_name', 'create_uid', 'create_date'], limit: 1 } },
    { model: 'res.users', method: 'search_read', args: [[['id', '=', 7]]],
      kwargs: { fields: ['id', 'active', 'share', 'company_ids'], limit: 1 } }
  ]);
});

test('rejects missing, stale, future, malformed and other users’ proof records before looking up staff', async () => {
  for (const proofRows of [[], [{ ...STAMP, id: 32 }], [{ ...STAMP, x_name: 'f'.repeat(64) }],
    [{ ...STAMP, create_uid: [55, 'Unapproved'] }], [{ ...STAMP, create_uid: ['7', 'Spoof'] }],
    [{ ...STAMP, create_date: '2026-11-13 09:21:20' }], [{ ...STAMP, create_date: '2026-11-13 09:21:27' }],
    [{ ...STAMP, create_date: '2026-02-30 09:21:23' }], [{ ...STAMP, create_date: '2026-11-13T09:21:23Z' }]]) {
    const f = fixture({ proofRows });
    assert.equal(await f.verify(PROOF), null);
    assert.equal(f.calls.length, 1);
  }
});

test('requires an active internal user, and checks company membership when pinned', async () => {
  for (const userRows of [[], [{ ...STAFF, id: 8 }], [{ ...STAFF, active: false }],
    [{ ...STAFF, share: true }], [{ ...STAFF, share: undefined }], [{ ...STAFF, company_ids: [8] }]]) {
    const f = fixture({ userRows, companyId: 5 });
    assert.equal(await f.verify(PROOF), null);
    assert.equal(f.calls.length, 2);
  }
});

test('invalid grant configuration and unusable challenges never query Odoo', async () => {
  for (const grantsJson of ['', '{', '[]', 'null', '{"07":["mail:read"]}', '{"7":[]}',
    '{"7":["ai:write"]}', '{"7":["mail:read","mail:read"]}', '{"7":["mail:read"],"8":["admin"]}']) {
    const f = fixture({ grantsJson });
    assert.equal(await f.verify(PROOF), null);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  for (const proof of [{ ...PROOF, proofId: '31' }, { ...PROOF, digest: 'd'.repeat(63) },
    { ...PROOF, expiresAt: NOW }, { ...PROOF, expiresAt: NOW + 180000 }]) {
    assert.equal(await f.verify(proof), null);
  }
  assert.equal(f.calls.length, 0);
  const invalidCompany = fixture({ companyId: 'all' });
  assert.equal(await invalidCompany.verify(PROOF), null);
  assert.equal(invalidCompany.calls.length, 0);
});

test('time spent waiting on Odoo cannot extend the grant window', async () => {
  let now = NOW;
  const verify = createOdooOperatorProofVerifier({ grantsJson: GRANTS, clock: () => now,
    execute: async model => {
      if (model === 'x_sh_operator_proof') return [STAMP];
      now = PROOF.expiresAt;
      return [STAFF];
    }
  });
  assert.equal(await verify(PROOF), null);
});

test('Odoo infrastructure failures surface as a generic unavailable error', async () => {
  const f = fixture({ failure: new Error('Private provider diagnostic should not leave the verifier') });
  await assert.rejects(f.verify(PROOF), {
    code: 'ODOO_PROOF_UNAVAILABLE', message: 'Odoo operator verification is temporarily unavailable.'
  });
});

test('cleanup runs in the background at most hourly and unlinks only bounded proof search results', async () => {
  let now = NOW;
  let releaseCleanup;
  const cleanupCalls = [];
  const verify = createOdooOperatorProofVerifier({ grantsJson: GRANTS, clock: () => now,
    execute: async (model, method, args, kwargs) => {
      if (model === 'res.users') return [STAFF];
      if (args[0][0]?.[0] === 'id') return [{ ...STAMP,
        create_date: new Date(now).toISOString().slice(0, 19).replace('T', ' ') }];
      cleanupCalls.push({ model, method, args, kwargs });
      if (method === 'search_read') {
        await new Promise(resolve => { releaseCleanup = resolve; });
        return [{ id: 17 }, { id: 17 }, { id: -1 }, { id: '18' }, null];
      }
      throw new Error('Cleanup failure must not surface');
    }
  });
  const verifyAt = async () => verify({ ...PROOF, issuedAt: now - 100, expiresAt: now + 45000 });
  assert.ok(await verifyAt());
  assert.equal(cleanupCalls.length, 0);
  assert.ok(await verifyAt());
  await setImmediate();
  assert.deepEqual(cleanupCalls, [{ model: 'x_sh_operator_proof', method: 'search_read',
    args: [[['create_date', '<', '2026-11-12 09:21:23']]],
    kwargs: { fields: ['id'], limit: 250, order: 'create_date asc, id asc' } }]);
  releaseCleanup();
  await setImmediate();
  assert.deepEqual(cleanupCalls[1], { model: 'x_sh_operator_proof', method: 'unlink', args: [[17]], kwargs: {} });
  now += 59 * 60000;
  assert.ok(await verifyAt());
  await setImmediate();
  assert.equal(cleanupCalls.length, 2);
  now += 60000;
  assert.ok(await verifyAt());
  await setImmediate();
  assert.equal(cleanupCalls.length, 3);
  releaseCleanup();
});
