'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {context}=require('./production-functions.cjs');
function fixture(){let now=100000,requests=0;const timers=new Map();let next=0,visible=true;
 const state={destroyed:false,whatsappCallLogs:[{call_id:'saved'}]};const history={loadedAt:0,error:'',request:null};
 const c=context(['loadHubCallHistory'],{state,hubCallHistory:history,Date:{now:()=>now},document:{hidden:false},byId:()=>({}),hubScreenVisible:()=>visible,
  setTimeout:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},clearTimeout:id=>timers.delete(id),
  fetchWhatsappCallJson:async()=>{requests++;if(requests===1)throw Object.assign(Error('Storage unavailable'),{status:503});return{calls:[{call_id:'fresh'}]};},
  whatsappCallsFromResponse:body=>body.calls,mergeWhatsappCallLogs:rows=>{state.whatsappCallLogs=rows;},renderHubCallsPage(){}});
 return{c,state,history,timers,setNow:value=>{now=value;},hide:()=>{visible=false;},get requests(){return requests;}};
}
test('a temporary Calls-page outage retains old rows, labels them stale and automatically repairs once storage returns',async()=>{
 const f=fixture();await f.c.loadHubCallHistory();assert.equal(f.state.whatsappCallLogs[0].call_id,'saved');assert.match(f.history.error,/previously loaded|previous calls/i);
 assert.equal(f.timers.size,1);const timer=[...f.timers.values()][0];assert.equal(timer.delay,5000);f.timers.clear();f.setNow(105001);await timer.fn();
 assert.equal(f.requests,2);assert.equal(f.history.error,'');assert.equal(f.state.whatsappCallLogs[0].call_id,'fresh');assert.equal(f.timers.size,0);
});
test('hidden Calls-page retry consumes no query and explicit retry can recover later',async()=>{
 const f=fixture();await f.c.loadHubCallHistory();const timer=[...f.timers.values()][0];f.hide();f.setNow(106000);await timer.fn();assert.equal(f.requests,1);
 await f.c.loadHubCallHistory({force:true});assert.equal(f.requests,2);assert.equal(f.history.error,'');
});
test('authorization failure does not produce an automatic storage retry loop',async()=>{
 const f=fixture();f.c.fetchWhatsappCallJson=async()=>{throw Object.assign(Error('Authorization expired'),{status:401});};
 await f.c.loadHubCallHistory();assert.equal(f.timers.size,0);assert.match(f.history.error,/Authorization/);
});
test('selected-chat history failure backs off and silent success clears only its own stale warning',async()=>{
 let now=100000,requests=0;const warning={textContent:''};const state={destroyed:false,selectedChannel:{id:73,channel_type:'whatsapp'},selectedChannelId:73,whatsappCallLogs:[{call_id:'saved'}]};
 const runtime={requests:new Map(),loadedAt:new Map()};
 const c=context(['loadWhatsappCallLogsForSelected'],{state,whatsappCallsRuntime:runtime,Date:{now:()=>now},selectedWhatsappPhone:()=> '919999999999',callEventMatchesChannel:()=>true,
  fetchWhatsappCallJson:async()=>{requests++;if(requests===1)throw Object.assign(Error('Storage unavailable'),{status:503});return{calls:[{call_id:'fresh'}]};},
  whatsappCallsFromResponse:body=>body.calls,mergeWhatsappCallLogs:rows=>{state.whatsappCallLogs=rows;return true;},whatsappCallError:warning,
  showInlineError:(node,text)=>{node.textContent=text;},hideInlineError:node=>{node.textContent='';},renderWhatsappCallPanel(){},renderMessages(){}});
 await c.loadWhatsappCallLogsForSelected();assert.match(warning.textContent,/previously loaded|previous calls/i);assert.equal(state.whatsappCallLogs[0].call_id,'saved');
 for(let i=0;i<10;i++)await c.loadWhatsappCallLogsForSelected({silent:true});assert.equal(requests,1);
 now+=5001;await c.loadWhatsappCallLogsForSelected({silent:true});assert.equal(requests,2);assert.equal(warning.textContent,'');assert.equal(state.whatsappCallLogs[0].call_id,'fresh');
 runtime.historyErrors.set('919999999999','old history warning');warning.textContent='The call could not be ended';now+=10001;
 await c.loadWhatsappCallLogsForSelected({silent:true});assert.equal(warning.textContent,'The call could not be ended');
});
