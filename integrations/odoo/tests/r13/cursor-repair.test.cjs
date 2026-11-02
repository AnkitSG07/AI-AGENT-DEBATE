'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {context}=require('./production-functions.cjs');
function fixture(){let visible={channelId:73,throughMessageId:801,epoch:1},queries=0,queued=0,next=0;const timers=new Map();
 const r={channels:new Map([[73,{latestMessageId:800}]]),intents:new Map(),acknowledged:new Map(),lastReadAttempts:new Map([[73,{requestedThrough:801,observedLatest:800}]])};
 const c=context(['queueAppMessageCursorRepair'],{state:{destroyed:false},appUnreadRuntime:r,appMessageStateAvailable:()=>true,visibleAppMessageCursor:()=>visible,
  setTimeout:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},clearTimeout:id=>timers.delete(id),
  refreshAppMessageStates:async values=>{queries++;assert.deepEqual([...values.channelIds],[73]);assert.equal(values.force,true);},queueVisibleAppMessageRead:()=>{queued++;}});
 return{c,r,timers,setVisible:value=>{visible=value;},get queries(){return queries;},get queued(){return queued;},async fire(){const [id,timer]=timers.entries().next().value;timers.delete(id);await timer.fn();}};
}
test('a push-before-ledger race repairs the one visible cursor and resumes the existing CAS read when ingestion catches up',async()=>{
 const f=fixture();f.c.queueAppMessageCursorRepair({channelId:73,throughMessageId:801,epoch:1},0);
 assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,500);await f.fire();assert.equal(f.queries,1);assert.equal(f.queued,0);
 f.r.channels.set(73,{latestMessageId:801});await f.fire();assert.equal(f.queries,2);assert.equal(f.queued,1);assert.equal(f.r.lastReadAttempts.has(73),false);
});
test('lagged cursor repair is strictly bounded even if ledger ingestion or storage stays unavailable',async()=>{
 const f=fixture();f.c.refreshAppMessageStates=async()=>{throw Error('Synthetic unavailable');};f.c.queueAppMessageCursorRepair({channelId:73,throughMessageId:801,epoch:1},0);
 const delays=[];while(f.timers.size){delays.push([...f.timers.values()][0].delay);await f.fire();}
 assert.deepEqual(delays,[500,1000,2000]);assert.equal(f.queued,0);
 f.c.queueAppMessageCursorRepair({channelId:73,throughMessageId:801,epoch:1},0);assert.equal(f.timers.size,0,'same visible cursor cannot restart an unlimited loop');
});
test('leaving the viewport, changing chats or changing manual-unread intent cancels a scheduled repair before its query',async()=>{
 for(const change of [f=>f.setVisible(null),f=>f.setVisible({channelId:74,throughMessageId:900,epoch:2}),f=>f.r.intents.set(73,1)]){
  const f=fixture();f.c.queueAppMessageCursorRepair({channelId:73,throughMessageId:801,epoch:1},0);change(f);await f.fire();assert.equal(f.queries,0);assert.equal(f.queued,0);assert.equal(f.timers.size,0);
 }
});
test('a confirmed read or newer view wins while a targeted repair request is in flight',async()=>{
 const f=fixture();f.c.refreshAppMessageStates=async()=>{f.r.channels.set(73,{latestMessageId:801});f.r.acknowledged.set(73,801);};
 f.c.queueAppMessageCursorRepair({channelId:73,throughMessageId:801,epoch:1},0);await f.fire();assert.equal(f.queued,0);assert.equal(f.timers.size,0);
});
