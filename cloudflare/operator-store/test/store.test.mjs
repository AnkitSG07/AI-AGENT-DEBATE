import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DocumentStore, digest, LIMITS } from '../src/store.mjs';

function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const storage={sql:{exec(sql,...params){
    if(!params.length&&sql.includes(';')){db.exec(sql);return{toArray:()=>[],[Symbol.iterator]:function*(){}};}
    const statement=db.prepare(sql),result=statement.columns().length?statement.all(...params):(statement.run(...params),[]);
    return{toArray:()=>result,[Symbol.iterator]:()=>result[Symbol.iterator]()};
  }},transactionSync(callback){db.exec('BEGIN');try{const value=callback();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}};
  let now=1800000000000;const store=new DocumentStore(storage,{clock:()=>now});
  const migrationId='test-migration-0001';
  const migration=(op,extra={})=>store.migration({version:1,op,migrationId,...extra});
  const activate=documents=>{
    migration('begin');if(documents?.length)migration('import',{requestId:'test-initial-batch',documents});
    const sum=migration('checksum');migration('seal',{expectedCount:sum.count,expectedChecksum:sum.checksum});
    return migration('activate',{expectedCount:sum.count,expectedChecksum:sum.checksum});
  };
  let sequence=0;const commit=(writes,reads=[],queries=[],requestId='test-commit-'+(++sequence))=>store.rpc({version:1,op:'commit',requestId,reads,queries,writes});
  return{store,db,migration,activate,commit,advance:ms=>now+=ms};
}
const path=id=>'sh_operator_devices/'+id;
const write=(id,data,type='set')=>({type,path:path(id),data});
const source=(id,data,seconds='10',deleted=false)=>({path:path(id),...(deleted?{deleted:true}:{data}),sourceVersion:{seconds,nanos:1}});
const code=expected=>e=>e.code===expected;

test('normal data APIs fail closed until a separately sealed migration activates',t=>{
  const f=fixture(t);assert.throws(()=>f.store.rpc({version:1,op:'read',paths:[path('a')]}),code('STORE_NOT_ACTIVE'));
  assert.throws(()=>f.migration('activate',{expectedCount:0,expectedChecksum:'a'.repeat(64)}),code('INVALID_REQUEST'));
  f.activate([]);assert.equal(f.store.snapshot(path('a')).exists,false);
});
test('snapshot import and committed mutations survive a new store instance',t=>{
  const f=fixture(t);f.activate([source('a',{schema:1})]);
  assert.deepEqual(f.store.snapshot(path('a')),{path:path('a'),exists:true,revision:1,data:{schema:1}});
  f.commit([write('a',{schema:2})],[{path:path('a'),revision:1}]);
  const reloaded=new DocumentStore(f.store.storage);
  assert.equal(reloaded.snapshot(path('a')).data.schema,2);assert.equal(reloaded.meta('mode').state,'active');
});
test('exact commit replay survives a lost acknowledgement without duplicate writes',t=>{
  const f=fixture(t);f.activate([]);
  const a=f.commit([write('a',{n:1},'create')],[],[],'lost-ack-identity');
  const b=f.commit([write('a',{n:1},'create')],[],[],'lost-ack-identity');assert.deepEqual(b,a);
  assert.equal(f.store.snapshot(path('a')).revision,1);
  assert.throws(()=>f.commit([write('a',{n:2})],[],[],'lost-ack-identity'),code('IDEMPOTENCY_MISMATCH'));
});
test('stale read guards reject the whole multi-document write',t=>{
  const f=fixture(t);f.activate([]);f.commit([write('a',{n:1})]);
  const stale=f.store.snapshot(path('a'));f.commit([write('a',{n:2})]);
  assert.throws(()=>f.commit([write('a',{n:3}),write('b',{n:1})],[{path:stale.path,revision:stale.revision}]),code('TRANSACTION_CONFLICT'));
  assert.equal(f.store.snapshot(path('a')).data.n,2);assert.equal(f.store.snapshot(path('b')).exists,false);
});
test('deleted tombstones preserve revisions so delete/recreate ABA cannot satisfy a stale guard',t=>{
  const f=fixture(t);f.activate([]);f.commit([write('a',{n:1})]);const old=f.store.snapshot(path('a'));
  f.commit([{type:'delete',path:path('a')}]);const missing=f.store.snapshot(path('a'));assert.equal(missing.exists,false);assert.equal(missing.revision,2);
  f.commit([write('a',{n:1},'create')]);assert.equal(f.store.snapshot(path('a')).revision,3);
  assert.throws(()=>f.commit([write('b',{n:2})],[{path:old.path,revision:old.revision}]),code('TRANSACTION_CONFLICT'));
  assert.throws(()=>f.commit([write('b',{n:2})],[{path:missing.path,revision:missing.revision}]),code('TRANSACTION_CONFLICT'));
});
test('a conflicting create after earlier staged writes rolls back all of them',t=>{
  const f=fixture(t);f.activate([]);f.commit([write('a',{n:1})]);
  assert.throws(()=>f.commit([write('b',{n:2}),write('a',{n:3},'create')]),code('ALREADY_EXISTS'));
  assert.equal(f.store.snapshot(path('b')).exists,false);
});
test('unfiltered collection guards prevent phantom enrollment while gate count is created',t=>{
  const f=fixture(t);f.activate([]);const before=f.store.query({collection:'sh_operator_devices'});
  f.commit([write('a',{n:1},'create')]);
  assert.throws(()=>f.commit([write('b',{n:2},'create')],[],[before.guard]),code('TRANSACTION_CONFLICT'));
});
test('limited query guards reject changed result revisions and newly inserted earlier rows',t=>{
  const f=fixture(t);f.activate([]);const q={collection:'sh_operator_media_jobs',where:[{field:'availableAtMs',op:'<=',value:100}],orderBy:[{field:'availableAtMs',direction:'asc'}],limit:1};
  f.commit([{type:'set',path:'sh_operator_media_jobs/a',data:{availableAtMs:50}}]);
  const before=f.store.query(q);f.commit([{type:'set',path:'sh_operator_media_jobs/b',data:{availableAtMs:20}}]);
  assert.throws(()=>f.commit([write('a',{n:1})],[],[before.guard]),code('TRANSACTION_CONFLICT'));
});
test('nested terminal-time pagination excludes missing fields and uses document ID tie-break',t=>{
  const f=fixture(t);f.activate([]);const c='sh_operator_media_sessions';
  f.commit(['c','a','b'].map(id=>({type:'set',path:c+'/'+id,data:{data:{terminal:{endedAt:10}}}})).concat([{type:'set',path:c+'/missing',data:{data:{}}}]));
  const query={collection:c,where:[{field:'data.terminal.endedAt',op:'<=',value:20}],orderBy:[{field:'data.terminal.endedAt',direction:'asc'}],limit:2};
  assert.deepEqual(f.store.query(query).docs.map(x=>x.path),[c+'/a',c+'/b']);
  assert.deepEqual(f.store.query({...query,startAfter:{path:c+'/b',values:[10]}}).docs.map(x=>x.path),[c+'/c']);
});
test('scalar range queries do not confuse text, booleans and numbers',t=>{
  const f=fixture(t);f.activate([]);
  f.commit([{type:'set',path:'sh_operator_deliveries/a',data:{messageId:1}},{type:'set',path:'sh_operator_deliveries/b',data:{messageId:true}},{type:'set',path:'sh_operator_deliveries/c',data:{messageId:'1'}}]);
  const docs=f.store.query({collection:'sh_operator_deliveries',where:[{field:'messageId',op:'==',value:1}]}).docs;
  assert.deepEqual(docs.map(x=>x.path),['sh_operator_deliveries/a']);
});
test('read-only guard validation does not create acknowledgement receipt writes',t=>{
  const f=fixture(t);f.activate([]);f.commit([], [{path:path('a'),revision:0}]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM commits').get().n,0);
});
test('read-only replay tracking makes zero SQL writes while mutation nonces survive object eviction',t=>{
  const f=fixture(t),expires=1800000120000;
  const changes=()=>f.db.prepare('SELECT total_changes() AS n').get().n;
  const before=changes();
  for(let index=0;index<1000;index++)f.store.acceptNonce(`read-nonce-${index}`,expires,{persistent:false});
  assert.equal(changes(),before,'authentication/status reads must not write nonce rows');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM nonces').get().n,0);
  assert.throws(()=>f.store.acceptNonce('read-nonce-0',expires,{persistent:false}),code('REPLAY_REJECTED'));
  f.store.acceptNonce('mutation-nonce-1',expires);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM nonces').get().n,1);
  const reloaded=new DocumentStore(f.store.storage,{clock:f.store.clock});
  assert.throws(()=>reloaded.acceptNonce('mutation-nonce-1',expires),code('REPLAY_REJECTED'));
  // Repeating a signed read after eviction is intentionally harmless; it never
  // grants mutation replay or bypasses the HMAC timestamp/endpoint binding.
  reloaded.acceptNonce('read-nonce-0',expires,{persistent:false});
});
test('memory nonce tracking fails closed at its bound and recovers after expiry',t=>{
  const f=fixture(t),expires=1800000001000;
  for(let index=0;index<LIMITS.memoryNonces;index++)f.store.recentNonces.set(`nonce-${index}`,expires);
  assert.throws(()=>f.store.acceptNonce('next-read',expires,{persistent:false}),code('REPLAY_CAPACITY'));
  assert.equal(f.store.recentNonces.size,LIMITS.memoryNonces);
  f.advance(2000);f.store.acceptNonce('next-read',expires+10000,{persistent:false});
  assert.equal(f.store.recentNonces.size,1);
});
test('namespace, SQL expression and record-size boundaries fail before mutation',t=>{
  const f=fixture(t);f.activate([]);
  for(const bad of ['other_devices/a','sh_operator_devices/a/b','sh_operator_unapproved/a'])assert.throws(()=>f.commit([{type:'set',path:bad,data:{}}]),code('INVALID_REQUEST'));
  assert.throws(()=>f.store.query({collection:'sh_operator_devices',where:[{field:"id');DROP TABLE documents;--",op:'==',value:1}]}),code('INVALID_REQUEST'));
  assert.throws(()=>f.commit([write('a',{n:'x'.repeat(1024*1024)})]),code('INVALID_REQUEST'));
  assert.equal(f.store.snapshot(path('a')).exists,false);
});
test('migration discards older replay data and refuses divergent equal-version content atomically',t=>{
  const f=fixture(t);f.migration('begin');
  f.migration('import',{requestId:'snapshot-batch',documents:[source('a',{n:2},'20')]});
  assert.equal(f.migration('import',{requestId:'old-journal-event',documents:[source('a',{n:1},'10')]}).ignored,1);
  assert.throws(()=>f.migration('import',{requestId:'divergent-journal',documents:[source('b',{n:1},'20'),source('a',{n:3},'20')]}),code('SOURCE_VERSION_MISMATCH'));
  const sum=f.migration('checksum');assert.equal(sum.count,1);
  assert.equal(sum.checksum,digest(path('a')+'\n{"n":2}\n'));
});
test('source deletion tombstones prevent older snapshot pages from resurrecting a revoked record',t=>{
  const f=fixture(t);f.migration('begin');f.migration('import',{requestId:'delete-journal',documents:[source('a',null,'30',true)]});
  assert.equal(f.migration('import',{requestId:'old-snapshot-page',documents:[source('a',{n:1},'20')]}).ignored,1);
  const sum=f.migration('checksum');assert.equal(sum.count,0);
  f.migration('seal',{expectedCount:0,expectedChecksum:sum.checksum});f.migration('activate',{expectedCount:0,expectedChecksum:sum.checksum});
  assert.equal(f.store.snapshot(path('a')).exists,false);assert.equal(f.store.snapshot(path('a')).revision,1);
});
test('seal verifies exact content and closes imports; activation never overwrites live data',t=>{
  const f=fixture(t);f.migration('begin');f.migration('import',{requestId:'batch-seal-test',documents:[source('a',{n:1})]});
  assert.throws(()=>f.migration('seal',{expectedCount:1,expectedChecksum:'a'.repeat(64)}),code('INVALID_REQUEST'));
  const sum=f.migration('checksum');f.migration('seal',{expectedCount:sum.count,expectedChecksum:sum.checksum});
  assert.throws(()=>f.migration('import',{requestId:'after-seal-batch',documents:[source('b',{n:2})]}),code('INVALID_REQUEST'));
  f.migration('activate',{expectedCount:sum.count,expectedChecksum:sum.checksum});f.commit([write('a',{n:9})]);
  assert.equal(f.migration('activate',{expectedCount:sum.count,expectedChecksum:sum.checksum}).mode.state,'active');
  assert.equal(f.store.snapshot(path('a')).data.n,9);
  assert.throws(()=>f.migration('begin'),code('INVALID_REQUEST'));
});
test('authentication nonce is single-use across restart and bounded to an expiry window',t=>{
  const f=fixture(t);f.store.acceptNonce('same-nonce-identity',1800000120000);
  assert.throws(()=>new DocumentStore(f.store.storage).acceptNonce('same-nonce-identity',1800000120000),code('REPLAY_REJECTED'));
});
