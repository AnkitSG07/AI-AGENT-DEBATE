'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { context, deferred } = require('./production-functions.cjs');
function unreadFixture() {
  let now = 1000, calls = [], version = 1;
  const runtime = { channels:new Map(), pending:new Map(), lists:new Map(), sequence:0 };
  const c = context(['refreshAppMessageStates'], {
    Date: { now:()=>now }, document:{hidden:false},
    state:{destroyed:false,channels:[{id:73},{id:74}],latestMessagesByChannel:{73:{id:801},74:{id:802}}},
    appUnreadRuntime:runtime, appMessageStateAvailable:()=>true,
    requestAppMessageState:async (_,body)=>{calls.push([...body.channelIds]);return {ok:true,channels:body.channelIds.map(channelId=>({channelId,stateVersion:version}))};},
    applyAppMessageState:body=>{for(const row of body.channels)runtime.channels.set(row.channelId,row);}
  });
  return {c,calls,runtime,setNow:value=>{now=value;},setVersion:value=>{version=value;}};
}
test('unchanged twelve-second inbox refreshes do not reread every unread document',async()=>{
  const f=unreadFixture(); await f.c.refreshAppMessageStates();
  for(let elapsed=12000;elapsed<300000;elapsed+=12000){f.setNow(1000+elapsed);await f.c.refreshAppMessageStates();}
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],[73,74]);
  f.setNow(301001);await f.c.refreshAppMessageStates();assert.equal(f.calls.length,2,'a bounded repair still catches missing cross-device hints');
});
test('only a conversation with a changed Odoo preview needs its unread state reread',async()=>{
  const f=unreadFixture();await f.c.refreshAppMessageStates();f.c.state.latestMessagesByChannel[74].id=803;
  await f.c.refreshAppMessageStates();assert.deepEqual(f.calls,[[73,74],[74]]);
});
test('hidden inboxes defer unread queries and a foreground repair bypasses the idle budget',async()=>{
  const f=unreadFixture();f.c.document.hidden=true;await f.c.refreshAppMessageStates();assert.equal(f.calls.length,0);
  f.c.document.hidden=false;await f.c.refreshAppMessageStates({force:true});assert.equal(f.calls.length,1);
  await f.c.refreshAppMessageStates({channelIds:[74],force:true});assert.deepEqual(f.calls[1],[74]);
});
test('a message hint arriving during a list snapshot is followed by one fresh snapshot',async()=>{
  const f=unreadFixture(),gate=deferred();let reads=0;
  f.c.requestAppMessageState=async(_,body)=>{f.calls.push([...body.channelIds]);if(++reads===1)await gate.promise;return {ok:true,channels:body.channelIds.map(channelId=>({channelId,stateVersion:reads}))};};
  const first=f.c.refreshAppMessageStates();const hint=f.c.refreshAppMessageStates({channelIds:[73],force:true});
  gate.resolve();await Promise.all([first,hint]);assert.deepEqual(f.calls,[[73,74],[73]]);
});
test('a storage failure does not produce one unread retry on every inbox tick',async()=>{
  const f=unreadFixture();let attempts=0;
  f.c.requestAppMessageState=async()=>{attempts++;throw Error('Synthetic storage unavailable');};
  await f.c.refreshAppMessageStates().catch(()=>{});for(let i=1;i<=20;i++)await f.c.refreshAppMessageStates().catch(()=>{});
  assert.equal(attempts,1);f.setNow(7001);await f.c.refreshAppMessageStates().catch(()=>{});assert.equal(attempts,2);
});
function callFixture(native=false) {
  let now=1000,calls=[];
  const runtime={pollPromise:null,lastHistoryAttemptMs:0,session:null,presenceConfirmed:false,notified:new Set(),lookedUpCallKeys:new Set(),realtimeReady:!native};
  const c=context(['pollRecentWhatsappCalls'],{Date:{now:()=>now},document:{hidden:false},state:{destroyed:false,autoRefreshEnabled:true},whatsappCallsRuntime:runtime,
    hubNativeRoomCapabilities:()=>native?{nativeRoomCalls:true,callChangeHints:true}:null,findIncomingWhatsappCall:()=>null,
    whatsappOperatorIdentity:()=>({operator_device_id:'test'}),fetchWhatsappCallJson:async path=>{calls.push(path);return {ok:true};},
    whatsappCallsFromResponse:()=>[],normalizeWhatsappCallRecord:x=>x,mergeWhatsappCallLogs:()=>false,whatsappOperatorAvailable:()=>false,renderWhatsappCallPanel(){},renderMessages(){}
  });return{c,calls,runtime,setNow:value=>{now=value;}};
}
for(const native of [false,true])test(`${native?'native FCM':'healthy SSE'} idle calls have a bounded hourly repair budget`,async()=>{
  const f=callFixture(native);await f.c.pollRecentWhatsappCalls();
  for(let elapsed=2000;elapsed<3600000;elapsed+=2000){f.setNow(1000+elapsed);await f.c.pollRecentWhatsappCalls({background:true});}
  assert.ok(f.calls.length<=122,`idle hour made ${f.calls.length} requests`);
});
test('a realtime hint bypasses the idle budget and fetches current calls immediately',async()=>{
  const f=callFixture();await f.c.pollRecentWhatsappCalls();const previous=f.calls.length;
  f.setNow(1001);await f.c.pollRecentWhatsappCalls();assert.ok(f.calls.length>previous);
});
test('active call fallback stays fast and healthy hidden idle clients do no repair polling',async()=>{
  const f=callFixture();await f.c.pollRecentWhatsappCalls();const before=f.calls.length;
  f.c.document.hidden=true;f.setNow(120001);await f.c.pollRecentWhatsappCalls({background:true});assert.equal(f.calls.length,before);
  f.c.document.hidden=false;f.runtime.session={callId:'active'};await f.c.pollRecentWhatsappCalls({background:true});assert.ok(f.calls.length>before);
});
test('failed idle call polls back off instead of retrying every two seconds forever',async()=>{
  const f=callFixture();f.runtime.realtimeReady=false;let attempts=0;f.c.fetchWhatsappCallJson=async()=>{attempts++;throw Error('Synthetic unavailable');};
  for(let elapsed=0;elapsed<120000;elapsed+=2000){f.setNow(1000+elapsed);await f.c.pollRecentWhatsappCalls({background:true});}
  assert.ok(attempts<=16,`unavailable two-minute window made ${attempts} requests`);
});
test('a realtime incoming hint is not held behind an unrelated stalled inbox poll',async()=>{
  const gate=deferred(),reads=[];let renders=0;
  const runtime={pollPromise:gate.promise,callReads:new Map(),realtimeCallIds:new Set(),session:null};
  const c=context(['queueWhatsappCallRealtimeRefresh'],{state:{destroyed:false,autoRefreshEnabled:true},whatsappCallsRuntime:runtime,
    whatsappOpaqueId:x=>x,whatsappOperatorIdentity:()=>({operator_device_id:'device'}),fetchWhatsappCallById:async id=>{reads.push(id);},
    pollRecentWhatsappCalls:()=>gate.promise,renderWhatsappCallPanel(){renders++;}});
  const pending=c.queueWhatsappCallRealtimeRefresh('new-customer');await Promise.resolve();await Promise.resolve();
  const startedBeforeOldPollReturned=reads.includes('new-customer');await pending;const renderedBeforeOldPollReturned=renders>0;gate.resolve();
  assert.equal(startedBeforeOldPollReturned,true,'new-customer GET must start before the unrelated old poll completes');
  assert.equal(renderedBeforeOldPollReturned,true,'fresh incoming UI cannot wait for that unrelated poll either');
});
test('a new hint starts a fresh same-call read immediately and a late old snapshot cannot undo it',async()=>{
  const old=deferred(),fresh=deferred(),merges=[];let requests=0;
  const runtime={callReads:new Map()};
  const c=context(['fetchWhatsappCallById'],{state:{destroyed:false,whatsappCallLogs:[]},whatsappCallsRuntime:runtime,
    whatsappOperatorIdentity:()=>({operator_device_id:'device'}),whatsappProviderCallId:x=>x.call_id,whatsappCallsFromResponse:x=>x.calls,
    fetchWhatsappCallJson:()=>++requests===1?old.promise:fresh.promise,
    mergeWhatsappCallLogs:rows=>{merges.push(rows[0].lock.owner);c.state.whatsappCallLogs=rows;}});
  const first=c.fetchWhatsappCallById('call');const hint=c.fetchWhatsappCallById('call',{afterPending:true});
  const concurrent=requests===2;
  if(concurrent){fresh.resolve({calls:[{call_id:'call',lock:{owner:'new'}}]});await hint;old.resolve({calls:[{call_id:'call',lock:{owner:'old'}}]});}
  else{old.resolve({calls:[{call_id:'call',lock:{owner:'old'}}]});await first;fresh.resolve({calls:[{call_id:'call',lock:{owner:'new'}}]});}
  await Promise.all([first,hint]);assert.equal(concurrent,true,'same-call hint must not wait for an obsolete GET');
  assert.deepEqual(merges,['new']);assert.equal(c.state.whatsappCallLogs[0].lock.owner,'new');
});
test('SSE readiness enables idle suppression only after ready and an error restores bounded fallback',()=>{
  const handlers=new Map(),source={addEventListener:(name,fn)=>handlers.set(name,fn),close(){}};let repairs=0,retries=0;
  const runtime={presenceConfirmed:true,eventSource:null,realtimeRetryTimer:null,realtimeCallIds:new Set(),realtimeFailures:0,session:null};
  const c=context(['startWhatsappCallRealtime','stopWhatsappCallRealtime'],{state:{destroyed:false,autoRefreshEnabled:true},whatsappCallsRuntime:runtime,
    window:{SHOperatorAuth:{openCallEvents:()=>source}},AI_MODE_BACKEND_BASE:'https://example.com',whatsappOperatorIdentity:()=>({operator_device_id:'device'}),
    whatsappOpaqueId:x=>x,queueWhatsappCallRealtimeRefresh:()=>{repairs++;return Promise.resolve();},setTimeout:()=>++retries,clearTimeout(){}});
  c.startWhatsappCallRealtime();assert.notEqual(runtime.realtimeReady,true);handlers.get('ready')();assert.equal(runtime.realtimeReady,true);assert.equal(repairs,1);
  source.onerror();assert.equal(runtime.realtimeReady,false);assert.equal(runtime.eventSource,null);assert.equal(retries,1);
  c.stopWhatsappCallRealtime();assert.equal(runtime.realtimeReady,false);assert.equal(runtime.realtimeRetryTimer,null);
});
test('a late global inbox snapshot cannot overwrite a newer exact event read',async()=>{
  const f=callFixture(),gate=deferred();f.runtime.callReadWatermarks=new Map();f.runtime.callReadSerial=0;const merged=[];
  f.c.fetchWhatsappCallJson=()=>gate.promise;f.c.whatsappCallsFromResponse=x=>x.calls;
  f.c.whatsappProviderCallId=x=>x.call_id;f.c.whatsappCallHasRemoteOffer=()=>true;f.c.normalizedWhatsappCallEvent=x=>x;
  f.c.mergeWhatsappCallLogs=rows=>{merged.push(...rows);return false;};
  const old=f.c.pollRecentWhatsappCalls();f.runtime.callReadSerial=1;f.runtime.callReadWatermarks.set('call',1);
  gate.resolve({calls:[{call_id:'call',event:'connect',lock:{owner:'old'}}]});await old;assert.equal(merged.length,0);
});
test('native foreground call hints immediately refresh only their exact validated call without issuing an action',async()=>{
  const reads=[];let trusted=true;
  const c=context(['receiveHubNativeCallChanged','whatsappOpaqueId'],{state:{destroyed:false,session:{uid:7}},hubNativeRuntime:{ready:true},hasHubNativeBridge:()=>trusted,
    queueWhatsappCallRealtimeRefresh:id=>{reads.push(id);return Promise.resolve();}});
  for(const event of ['incoming','ended',''])c.receiveHubNativeCallChanged({detail:{callId:'wacid.exact-call',transferId:'',event}});
  assert.deepEqual(reads,['wacid.exact-call','wacid.exact-call','wacid.exact-call']);
  for(const detail of [{callId:'bad id',event:'incoming'},{callId:'undefined',event:'incoming'},{callId:'wacid.exact-call',event:'accept'},
      {callId:'wacid.exact-call',event:'terminate'},{callId:'wacid.exact-call'},{callId:{id:'wacid.exact-call'},event:'incoming'},null])
    c.receiveHubNativeCallChanged({detail});
  assert.equal(reads.length,3);
  trusted=false;c.receiveHubNativeCallChanged({detail:{callId:'wacid.exact-call',event:'incoming'}});trusted=true;
  c.hubNativeRuntime.ready=false;c.receiveHubNativeCallChanged({detail:{callId:'wacid.exact-call',event:'incoming'}});c.hubNativeRuntime.ready=true;
  c.state.destroyed=true;c.receiveHubNativeCallChanged({detail:{callId:'wacid.exact-call',event:'incoming'}});c.state.destroyed=false;
  c.state.session=null;c.receiveHubNativeCallChanged({detail:{callId:'wacid.exact-call',event:'incoming'}});assert.equal(reads.length,3);
});

test('R19 without an explicit native foreground hint capability retains fast incoming fallback',async()=>{
  const f=callFixture(true);f.c.hubNativeRoomCapabilities=()=>({nativeRoomCalls:true,nativeBuild:19});
  await f.c.pollRecentWhatsappCalls();const first=f.calls.length;f.setNow(3001);await f.c.pollRecentWhatsappCalls({background:true});
  assert.ok(f.calls.length>first,'old installed APKs cannot silently lose their foreground call updates');
  f.c.hubNativeRoomCapabilities=()=>({nativeRoomCalls:true,nativeBuild:20,callChangeHints:false});
  const second=f.calls.length;f.setNow(5002);await f.c.pollRecentWhatsappCalls({background:true});assert.ok(f.calls.length>second,'version alone cannot claim support');
});
