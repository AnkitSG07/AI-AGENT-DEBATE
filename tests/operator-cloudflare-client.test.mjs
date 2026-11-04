import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createCloudflareFirestoreClient,encodeCloudflareValue,decodeCloudflareValue,CloudflareStoreError,CloudflareTimestamp} from '../operator-cloudflare-client.js';

const secret='synthetic-server-only-store-secret-001';
const sha=value=>createHash('sha256').update(value).digest('hex');
const valueAt=(value,path)=>path.split('.').reduce((v,key)=>v?.[key],value);
function fixture(options={}) {
  const rows=new Map(),versions=new Map(),receipts=new Map(),requests=[];
  let beforeCommit=options.beforeCommit,lost=options.lost||0,readHook=options.readHook;
  const put=(path,data)=>{versions.set(path,(versions.get(path)||0)+1);if(data===undefined)rows.delete(path);else rows.set(path,structuredClone(data));};
  const snapshot=path=>({path,exists:rows.has(path),revision:versions.get(path)||0,...(rows.has(path)?{data:structuredClone(rows.get(path))}:{})});
  const query=q=>{
    let docs=[...rows.keys()].filter(path=>path.split('/')[0]===q.collection).map(snapshot).filter(row=>q.where.every(({field,op,value})=>{
      const actual=valueAt(row.data,field);if(actual===undefined)return false;
      return op==='=='?actual===value:op==='!='?actual!==value:op==='<'?actual<value:op==='<='?actual<=value:op==='>'?actual>value:op==='>='?actual>=value:false;
    })).filter(row=>q.orderBy.every(({field})=>valueAt(row.data,field)!==undefined));
    const compare=(a,b)=>{for(const order of q.orderBy){const av=valueAt(a.data,order.field),bv=valueAt(b.data,order.field),c=av<bv?-1:av>bv?1:0;if(c)return order.direction==='desc'?-c:c;}return a.path.localeCompare(b.path);};
    docs.sort(compare);
    if(q.startAfter){const cursor={path:q.startAfter.path,data:{}};q.orderBy.forEach((order,i)=>{let v=cursor.data;const keys=order.field.split('.');for(const key of keys.slice(0,-1))v=v[key]||=( {} );v[keys.at(-1)]=q.startAfter.values[i];});docs=docs.filter(row=>compare(row,cursor)>0);}
    docs=docs.slice(0,q.limit||1000);
    return {docs,guard:{query:q,fingerprint:sha(JSON.stringify([q,docs.map(row=>[row.path,row.revision])]))}};
  };
  const respond=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  const fetchImpl=async(url,opts)=>{
    const body=JSON.parse(opts.body),headers=opts.headers;
    assert.equal(new URL(url).pathname,'/rpc');assert.equal(body.version,1);
    assert.equal(headers['x-sh-store-signature'],createHmac('sha256',secret).update(headers['x-sh-store-timestamp']+'\n'+headers['x-sh-store-nonce']+'\n/rpc\n'+sha(opts.body)).digest('hex'));
    assert.equal(opts.redirect,'error');assert.equal(opts.cache,'no-store');
    requests.push({url,body,headers,raw:opts.body});
    if(options.override)return options.override({url,opts,body,respond});
    if(body.op==='read'){const docs=body.paths.map(snapshot);await readHook?.(body,put);return respond({ok:true,docs});}
    if(body.op==='query')return respond({ok:true,...query(body.query)});
    assert.equal(body.op,'commit');
    const prior=receipts.get(body.requestId);
    if(prior){assert.equal(prior.raw,opts.body);if(lost-->0)throw Error('acknowledgement lost');return respond(prior.value);}
    await beforeCommit?.(body,put);beforeCommit=null;
    if(body.reads.some(read=>(versions.get(read.path)||0)!==read.revision)||body.queries.some(g=>query(g.query).guard.fingerprint!==g.fingerprint))return respond({ok:false,code:'TRANSACTION_CONFLICT'},409);
    if(body.writes.some(write=>write.type==='create'&&rows.has(write.path)))return respond({ok:false,code:'ALREADY_EXISTS'},409);
    for(const write of body.writes)put(write.path,write.type==='delete'?undefined:write.data);
    const result={ok:true,committed:true};receipts.set(body.requestId,{raw:opts.body,value:result});
    if(lost-->0)throw Error('acknowledgement lost');
    return respond(result);
  };
  const client=createCloudflareFirestoreClient({endpoint:'https://store.example.test',secret,fetchImpl,...options.client});
  return {client,rows,versions,receipts,requests,put,query,respond};
}

test('every request uses endpoint-bound HMAC, fresh nonce and no credential in URL/body',async()=>{
  const f=fixture(),ref=f.client.collection('sh_operator_metadata').doc('registry');
  f.put(ref.path,{count:1});await ref.get();await ref.get();
  assert.notEqual(f.requests[0].headers['x-sh-store-nonce'],f.requests[1].headers['x-sh-store-nonce']);
  assert.equal(JSON.stringify(f.requests.map(({url,body})=>({url,body}))).includes(secret),false);
});
test('lost commit acknowledgement retries the same durable operation without replaying callback',async()=>{
  const f=fixture({lost:1}),ref=f.client.collection('sh_operator_metadata').doc('counter');f.put(ref.path,{count:0});let callbacks=0;
  await f.client.runTransaction(async tx=>{callbacks++;const row=await tx.get(ref);tx.set(ref,{count:row.data().count+1});});
  assert.equal(callbacks,1);assert.equal(f.rows.get(ref.path).count,1);
  const commits=f.requests.filter(r=>r.body.op==='commit');assert.equal(commits.length,2);assert.equal(commits[0].raw,commits[1].raw);assert.equal(f.receipts.size,1);
});
test('unresolved commit ambiguity never causes callback replay or a second increment',async()=>{
  const f=fixture({lost:3}),ref=f.client.collection('sh_operator_metadata').doc('counter');f.put(ref.path,{count:0});let callbacks=0;
  await assert.rejects(f.client.runTransaction(async tx=>{callbacks++;const row=await tx.get(ref);tx.set(ref,{count:row.data().count+1});}),e=>e.outcomeUnknown===true&&e.status===503);
  assert.equal(callbacks,1);assert.equal(f.rows.get(ref.path).count,1);assert.equal(f.receipts.size,1);
});
test('only confirmed transaction conflicts rerun a callback with fresh data',async()=>{
  const path='sh_operator_metadata/counter',f=fixture({beforeCommit:(_,put)=>put(path,{count:10})}),ref=f.client.doc(path);f.put(path,{count:0});let callbacks=0;
  const result=await f.client.runTransaction(async tx=>{callbacks++;const row=await tx.get(ref);const count=row.data().count+1;tx.set(ref,{count});return count;});
  assert.equal(result,11);assert.equal(callbacks,2);assert.equal(f.rows.get(path).count,11);
});
test('create conflict is a semantic precondition and does not replay callback',async()=>{
  const f=fixture(),ref=f.client.doc('sh_operator_metadata/once');f.put(ref.path,{existing:true});let callbacks=0;
  await assert.rejects(f.client.runTransaction(tx=>{callbacks++;tx.create(ref,{existing:false});}),{code:'ALREADY_EXISTS',status:409});
  assert.equal(callbacks,1);assert.equal(f.rows.get(ref.path).existing,true);
});
test('read-only transactions validate all versions before publishing a result',async()=>{
  const path='sh_operator_credentials/hash',f=fixture({beforeCommit:(_,put)=>put(path,{active:false})}),ref=f.client.doc(path);f.put(path,{active:true});let callbacks=0;
  const active=await f.client.runTransaction(async tx=>{callbacks++;const row=await tx.get(ref);await tx.get(f.client.doc('sh_operator_devices/phone'));return row.data().active;},{readOnly:true});
  assert.equal(active,false);assert.equal(callbacks,2);
  assert.equal(f.requests.filter(r=>r.body.op==='commit').every(r=>r.body.writes.length===0),true);
});
test('read-only writes reject before any mutation and fresh requests do not reuse authorization',async()=>{
  const f=fixture(),ref=f.client.doc('sh_operator_credentials/hash');f.put(ref.path,{active:true});
  await assert.rejects(f.client.runTransaction(tx=>tx.set(ref,{active:false}),{readOnly:true}),{code:'INVALID_STORE_INPUT'});
  assert.equal((await ref.get()).data().active,true);f.put(ref.path,{active:false});assert.equal((await ref.get()).data().active,false);
});
test('an empty-query phantom invalidates a transaction before it can publish stale capacity',async()=>{
  const path='sh_operator_devices/phone',f=fixture({beforeCommit:(_,put)=>put(path,{active:true})});let callbacks=0;
  const count=await f.client.runTransaction(async tx=>{callbacks++;const size=(await tx.get(f.client.collection('sh_operator_devices'))).size;tx.set(f.client.doc('sh_operator_metadata/count'),{size});return size;});
  assert.equal(count,1);assert.equal(callbacks,2);
});
test('deleted records retain their revision guard and detect missing-create-delete ABA',async()=>{
  const path='sh_operator_metadata/missing',f=fixture({beforeCommit:(_,put)=>{put(path,{value:2});put(path,undefined);}}),ref=f.client.doc(path);
  f.put(path,{value:1});f.put(path,undefined);let callbacks=0;
  await f.client.runTransaction(async tx=>{callbacks++;assert.equal((await tx.get(ref)).exists,false);tx.set(f.client.doc('sh_operator_metadata/result'),{missing:true});});
  const commits=f.requests.filter(r=>r.body.op==='commit');assert.equal(commits[0].body.reads[0].revision,2);assert.equal(commits[1].body.reads[0].revision,4);assert.equal(callbacks,2);
});
test('nested ordering and snapshot cursor keep same-time history rows without duplicates',async()=>{
  const f=fixture(),collection=f.client.collection('sh_operator_media_sessions');
  for(const id of ['a','b','c'])f.put(collection.path+'/'+id,{data:{terminal:{endedAt:100}}});
  f.put(collection.path+'/missing',{data:{terminal:{}}});
  const ordered=collection.where('data.terminal.endedAt','<=',100).orderBy('data.terminal.endedAt','asc');
  const first=await ordered.limit(1).get();assert.equal(first.docs[0].id,'a');
  const next=await ordered.startAfter(first.docs[0]).limit(2).get();assert.deepEqual(next.docs.map(d=>d.id),['b','c']);
  assert.equal(first.docs[0].ref.path,collection.path+'/a');
});
test('archive byte arrays and reserved-tag user objects survive writes and reads exactly',async()=>{
  const value={bytes:Buffer.from([0,1,254,255]),nested:[{__sh_store_bytes_v1:'ordinary-user-text'},{__sh_store_object_v1:[['x','ordinary']]}]};
  const encoded=encodeCloudflareValue(value),decoded=decodeCloudflareValue(encoded);
  assert.ok(decoded.bytes instanceof Uint8Array);assert.deepEqual([...decoded.bytes],[0,1,254,255]);assert.deepEqual(decoded.nested,value.nested);
  const f=fixture(),ref=f.client.doc('sh_operator_reports_archive_chunks/chunk');await ref.create(value);
  const result=(await ref.get()).data();assert.deepEqual([...result.bytes],[0,1,254,255]);assert.deepEqual(result.nested,value.nested);
  result.bytes[0]=99;assert.equal((await ref.get()).data().bytes[0],0);
});
test('merge and dotted updates preserve other data and missing update cannot create a record',async()=>{
  const f=fixture(),ref=f.client.doc('sh_operator_metadata/state');f.put(ref.path,{nested:{keep:1,change:1},other:2});
  await ref.set({nested:{change:3}},{merge:true});await ref.update({'nested.new':4});
  assert.deepEqual((await ref.get()).data(),{nested:{keep:1,change:3,new:4},other:2});
  await assert.rejects(f.client.doc('sh_operator_metadata/absent').update({x:1}),{code:'NOT_FOUND'});
});
test('malformed and wrong-document responses fail closed without leaking server response',async()=>{
  for(const override of [()=>new Response('private service account data',{status:503}),({respond})=>respond({ok:true,docs:[{path:'sh_operator_devices/other',exists:true,revision:1,data:{}}]})]){
    const f=fixture({override});await assert.rejects(f.client.doc('sh_operator_devices/phone').get(),e=>e.status===503&&!e.message.includes('private service'));
  }
});
test('foreign references and unsupported values are rejected before transport',async()=>{
  const a=fixture(),b=fixture();await assert.rejects(a.client.getAll(b.client.doc('sh_operator_metadata/x')),{code:'INVALID_STORE_INPUT'});
  for(const value of [{bad:undefined},{bad:NaN},{bad:new Date(NaN)}])await assert.rejects(a.client.doc('sh_operator_metadata/x').set(value),{code:'INVALID_STORE_INPUT'});
  assert.equal(a.requests.length,0);assert.throws(()=>a.client.collection('sh_operator_devices/path'),{code:'INVALID_STORE_INPUT'});
});
test('Date and Firestore-compatible timestamps preserve seconds and nanoseconds through archive migration',async()=>{
  const precise=new CloudflareTimestamp(1800000000,123456789),date=new Date('2026-11-04T12:34:56.123Z');
  const f=fixture(),ref=f.client.doc('sh_operator_metadata/time');await ref.set({precise,date,literal:{__sh_store_timestamp_v1:'ordinary text'}});
  const result=(await ref.get()).data();assert.equal(result.precise.seconds,1800000000);assert.equal(result.precise.nanoseconds,123456789);
  assert.ok(result.precise instanceof CloudflareTimestamp);assert.equal(result.date.toDate().getTime(),date.getTime());
  assert.deepEqual(result.literal,{__sh_store_timestamp_v1:'ordinary text'});
  assert.deepEqual(encodeCloudflareValue(result.precise),encodeCloudflareValue(precise));
});
test('server-held source cursors can be rebuilt without granting any transaction authority',async()=>{
  const f=fixture(),collection=f.client.collection('sh_operator_media_sessions');f.put(collection.path+'/a',{data:{terminal:{endedAt:10}}});f.put(collection.path+'/b',{data:{terminal:{endedAt:20}}});
  const cursor=f.client.cursorSnapshot({path:collection.path+'/a',data:{data:{terminal:{endedAt:10}}}});
  const next=await collection.orderBy('data.terminal.endedAt').startAfter(cursor).get();assert.deepEqual(next.docs.map(row=>row.id),['b']);
});
test('one atomic getAll authorization snapshot does not issue a no-op commit',async()=>{
  const f=fixture();const a=f.client.doc('sh_operator_credentials/hash'),b=f.client.doc('sh_operator_devices/phone');
  await f.client.runTransaction(tx=>tx.getAll(a,b),{readOnly:true});assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.op,'read');
});
test('range queries include implicit field ordering before server fingerprint validation',async()=>{
  const f=fixture(),collection=f.client.collection('sh_operator_enrollments');
  f.put(collection.path+'/a',{recoveryUntil:20});f.put(collection.path+'/b',{recoveryUntil:10});
  const result=await collection.where('recoveryUntil','>',0).where('recoveryUntil','<=',20).limit(10).get();
  assert.deepEqual(result.docs.map(row=>row.id),['b','a']);assert.deepEqual(f.requests[0].body.query.orderBy,[{field:'recoveryUntil',direction:'asc'}]);
});
test('a stalled response body is bounded even if an injected transport ignores abort',async()=>{
  let cancelled=false;
  const hold=setTimeout(()=>{},2000);
  try{
    const f=fixture({client:{timeoutMs:100,transportAttempts:1},override:()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:200})});
    const began=Date.now();await assert.rejects(f.client.doc('sh_operator_metadata/x').get(),{code:'CLOUDFLARE_STORE_UNAVAILABLE'});
    assert.ok(Date.now()-began<1500);assert.equal(cancelled,true);
  }finally{clearTimeout(hold);}
});
test('configuration and closed-client requests cannot reach untrusted endpoints',async()=>{
  for(const endpoint of ['http://example.test','https://example.test/path','https://user:secret@example.test','https://example.test/?key=x','https://127.0.0.1'])assert.throws(()=>createCloudflareFirestoreClient({endpoint,secret}),CloudflareStoreError);
  const f=fixture();await f.client.terminate();await assert.rejects(f.client.doc('sh_operator_metadata/x').get(),{code:'CLOUDFLARE_STORE_UNAVAILABLE'});assert.equal(f.requests.length,0);
});
