import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveKitWhatsAppProvider, operatorIdentity } from '../../media/livekit-provider.mjs';

// The local SFU cannot emulate this Cloud-only feature. This contract simulator
// implements the documented +/-60-second constraint independently of the code.
// https://docs.livekit.io/reference/other/roomservice-api/#removeparticipant
const start = 1800000000123;
const identity = operatorIdentity('device-a','original-exact-leg');
function adapter() {
  let now = start;
  const calls = [];
  const rooms = { async removeParticipant(room, participant, options) {
    const cutoff = Number(options.revokeTokenTs), currentSecond = now / 1000;
    if (Math.abs(cutoff-currentSecond)>60) {
      const error = new Error('Documented LiveKit Cloud revocation cutoff is outside the 60-second window.');
      error.code = 'invalid_argument'; error.status = 400; throw error;
    }
    calls.push({room,identity:participant,cutoff,currentSecond});
  } };
  const provider = new LiveKitWhatsAppProvider({origin:'https://synthetic-project.livekit.cloud',
    apiKey:'test',apiSecret:'synthetic-not-a-secret'}, {now:()=>now,clients:{rooms,connector:{}}});
  return {provider,calls,setTime:value=>{now=value;}};
}

for (const delayMs of [0, 1000, 59000, 120000, 600000, 86400000]) {
  test(`exact operator cleanup remains valid after ${delayMs}ms durable queue delay`,async()=>{
    const a=adapter();a.setTime(start+delayMs);
    const result=await a.provider.detachOperator({roomName:'exact-room',identity,revokeBeforeMs:start});
    assert.equal(result.detached,true);assert.equal(a.calls.length,1);
    const call=a.calls[0];assert.equal(call.identity,identity);assert.equal(call.room,'exact-room');
    assert.ok(call.cutoff>Math.floor((start+delayMs)/1000),'strictly includes a same-second freshly refreshed old-leg token');
    assert.ok(call.cutoff<=(start+delayMs)/1000+2,'fresh cutoff stays well inside Cloud validation bound');
  });
}

test('retry recomputes revocation cutoff while preserving the exact immutable participant',async()=>{
  const a=adapter();await a.provider.detachOperator({roomName:'exact-room',identity,revokeBeforeMs:start});
  a.setTime(start+600000);await a.provider.detachOperator({roomName:'exact-room',identity,revokeBeforeMs:start});
  assert.equal(a.calls[1].cutoff-a.calls[0].cutoff,600);assert.equal(a.calls[1].identity,a.calls[0].identity);
});

test('future persisted timestamps cannot move a cleanup request outside the Cloud time bound',async()=>{
  const a=adapter();await a.provider.detachOperator({roomName:'exact-room',identity,revokeBeforeMs:start+300000});
  assert.ok(Math.abs(a.calls[0].cutoff-start/1000)<2);
});

test('invalid clock fails before sending a revocation request',async()=>{
  const a=adapter();a.setTime(NaN);
  await assert.rejects(a.provider.detachOperator({roomName:'exact-room',identity,revokeBeforeMs:start}),{code:'INVALID_PROVIDER_CLOCK'});
  assert.equal(a.calls.length,0);
});

test('customer identities remain ineligible for operator detach',async()=>{
  const a=adapter();await assert.rejects(a.provider.detachOperator({roomName:'exact-room',identity:'sh-customer-01234567890123456789012345678901',revokeBeforeMs:start}),{code:'INVALID_OPERATOR_LEG'});
  assert.equal(a.calls.length,0);
});
