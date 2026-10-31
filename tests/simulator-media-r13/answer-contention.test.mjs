import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred } from '../operator-r12-helpers.mjs';
import { CallRuntime } from '../../call-runtime/call-runtime.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function observedStore(store) {
  let active=0,peak=0;
  return {durable:true,get:key=>store.get(key),
    transaction:async operation=>{active++;peak=Math.max(peak,active);try{await pause(20);return await store.transaction(operation);}finally{active--; }},
    peak:()=>peak};
}

test('same-session Answer claims avoid concurrent same-process transaction locks and release before provider work',async()=>{
  const entered=deferred(),release=deferred();
  const f=fixture({provider:{acceptIncoming:async data=>{f.effects.push({kind:'accept',...data});entered.resolve();await release.promise;return {callId:data.callId,roomName:data.roomName,customerIdentity:'test-customer'};}}});
  await f.incoming();const store=observedStore(f.store);f.runtime.store=store;
  const outcomes=[];
  const a=f.accept('call-in-1','a').then(v=>{outcomes.push({device:'a',ok:true});return v;},e=>{outcomes.push({device:'a',code:e.code});throw e;});
  const b=f.accept('call-in-1','b').then(v=>{outcomes.push({device:'b',ok:true});return v;},e=>{outcomes.push({device:'b',code:e.code});throw e;});
  const both=Promise.allSettled([a,b]);await entered.promise;await pause(100);
  const losingPhoneAnsweredBeforeProviderAck=outcomes.some(row=>row.code==='CALL_ANSWERED_ELSEWHERE');
  release.resolve();const settled=await both;
  assert.equal(settled.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(f.effects.filter(row=>row.kind==='accept').length,1);
  assert.equal(losingPhoneAnsweredBeforeProviderAck,true,'loser feedback cannot wait for network/media acceptance');
  assert.equal(store.peak(),1,'same-process competing answer claims should not contend for the same Firestore lock');
});

test('a different incoming call is not blocked by another call claim or provider delay',async()=>{
  const f=fixture();await f.incoming('first-call');await f.incoming('second-call');
  const store=observedStore(f.store);f.runtime.store=store;
  const result=await Promise.all([f.accept('first-call','a'),f.accept('second-call','b')]);
  assert.equal(result.length,2);assert.ok(store.peak()>=2,'claim ordering must be per-call, not a global call queue');
});

test('independent coordinators still use durable arbitration and cannot both accept one customer',async()=>{
  const f=fixture();await f.incoming();
  const other=new CallRuntime({...f.runtime,capabilities:f.runtime.capabilityProvider});
  const results=await Promise.allSettled([f.accept('call-in-1','a'),other.accept('b','call-in-1',{requestId:'other-process-accept'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(f.effects.filter(row=>row.kind==='accept').length,1);
});

test('a rejected Answer claim releases its local queue for the next authorized claim',async()=>{
  const f=fixture();await f.incoming();f.devices.get('a').revoked=true;
  await assert.rejects(f.accept('call-in-1','a'),{code:'DEVICE_BINDING_INVALID'});
  const good=await f.accept('call-in-1','b');assert.equal(good.call.ownerDeviceId,'b');
});
