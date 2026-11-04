import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {createCloudflareFirestoreClient,CloudflareTimestamp} from '../../../operator-cloudflare-client.js';

const key='fixture-only-normal-store-secret-at-least-32-bytes';
const adminKey='fixture-only-migration-secret-at-least-32-bytes';
const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t,{sameKeys=false}={}){
  const mf=new Miniflare({modules:true,scriptPath:fileURLToPath(new URL('../src/worker.mjs',import.meta.url)),compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
    durableObjects:{OPERATOR_STORE:{className:'OperatorStore',useSQLite:true}},
    bindings:{SH_STORE_PREFIX:'sh_operator',SH_STORE_TENANT:'smart-handicrafts',SH_STORE_SECRET:key,SH_STORE_MIGRATION_SECRET:sameKeys?key:adminKey}});
  t.after(()=>mf.dispose());await mf.ready;
  async function request(path,input,{secret=path==='/migration'?adminKey:key,timestamp=String(Date.now()),nonce=randomBytes(18).toString('base64url'),signature,body=JSON.stringify(input)}={}){
    const mac=signature||createHmac('sha256',secret).update(timestamp+'\n'+nonce+'\n'+path+'\n'+hash(body)).digest('hex');
    const response=await mf.dispatchFetch('https://private-store.example.test'+path,{method:'POST',headers:{'Content-Type':'application/json','x-sh-store-timestamp':timestamp,'x-sh-store-nonce':nonce,'x-sh-store-signature':mac},body});
    return{status:response.status,body:await response.json()};
  }
  const migrationId='fixture-worker-migration-01';
  async function activate(){
    assert.equal((await request('/migration',{version:1,op:'begin',migrationId})).status,200);
    const sum=(await request('/migration',{version:1,op:'checksum',migrationId})).body;
    const input={version:1,migrationId,expectedCount:sum.count,expectedChecksum:sum.checksum};
    assert.equal((await request('/migration',{...input,op:'seal'})).status,200);
    assert.equal((await request('/migration',{...input,op:'activate'})).status,200);
  }
  const client=createCloudflareFirestoreClient({endpoint:'https://private-store.example.test',secret:key,fetchImpl:(url,options)=>mf.dispatchFetch(url,options)});
  t.after(()=>client.terminate());return{mf,request,activate,client};
}

test('real workerd verifies HMAC, rejects stale/replayed/cross-endpoint requests, and keeps migration separate',{timeout:60000},async t=>{
  const f=await fixture(t),input={version:1,op:'read',paths:['sh_operator_devices/a']};
  assert.equal((await f.request('/rpc',input)).body.code,'STORE_NOT_ACTIVE');
  assert.equal((await f.request('/migration',{version:1,op:'status'},{secret:key})).status,401);
  assert.equal((await f.request('/rpc',input,{timestamp:String(Date.now()-120000)})).status,401);
  assert.equal((await f.request('/rpc',input,{signature:'a'.repeat(64)})).status,401);
  const nonce=randomBytes(18).toString('base64url'),timestamp=String(Date.now());
  assert.equal((await f.request('/migration',{version:1,op:'status'},{nonce,timestamp})).status,200);
  assert.equal((await f.request('/migration',{version:1,op:'status'},{nonce,timestamp})).body.code,'REPLAY_REJECTED');
  const response=await f.mf.dispatchFetch('https://private-store.example.test/health');assert.equal(response.status,404);
  const text=await response.text();assert.equal(text.includes(key),false);assert.equal(response.headers.has('Access-Control-Allow-Origin'),false);
});
test('normal and migration keys cannot accidentally grant the same authority',{timeout:60000},async t=>{
  const f=await fixture(t,{sameKeys:true});
  assert.equal((await f.request('/rpc',{version:1,op:'read',paths:['sh_operator_devices/a']})).body.code,'NOT_CONFIGURED');
});
test('real worker and Node client preserve bytes/timestamps, transactional contention and query cursors',{timeout:60000},async t=>{
  const f=await fixture(t);await f.activate();const ref=f.client.doc('sh_operator_metadata/counter');await ref.set({n:0,bytes:Buffer.from([1,2,255]),timestamp:new CloudflareTimestamp(1800000000,123456789)});
  await Promise.all(Array.from({length:4},()=>f.client.runTransaction(async tx=>{const before=await tx.get(ref);tx.set(ref,{...before.data(),n:before.data().n+1});})));
  const result=(await ref.get()).data();assert.equal(result.n,4);assert.deepEqual([...result.bytes],[1,2,255]);
  assert.equal(result.timestamp.isEqual(new CloudflareTimestamp(1800000000,123456789)),true);
  const jobs=f.client.collection('sh_operator_media_jobs');await jobs.doc('a').set({availableAtMs:5});await jobs.doc('b').set({availableAtMs:5});await jobs.doc('c').set({availableAtMs:10});
  const first=await jobs.where('availableAtMs','<=',20).orderBy('availableAtMs').limit(2).get();assert.deepEqual(first.docs.map(d=>d.id),['a','b']);
  const second=await jobs.where('availableAtMs','<=',20).orderBy('availableAtMs').startAfter(first.docs[1]).get();assert.deepEqual(second.docs.map(d=>d.id),['c']);
  assert.deepEqual((await jobs.where('availableAtMs','<=',20).limit(1).get()).docs.map(d=>d.id),['a']);
});
