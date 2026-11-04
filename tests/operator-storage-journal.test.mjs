import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournaledFirestore, storageJournalHash, readStorageMigrationGate } from '../operator-storage-journal.js';
import { decodeCloudflareValue } from '../operator-cloudflare-client.js';
import { FirestoreFake } from './operator-r12-helpers.mjs';

const migrationId = 'migration_fixture_001';
const gate = mode => ({schema:1,mode,migrationId,epoch:1});
function fixture(mode='shadow') {
  const source = new FirestoreFake();
  if(mode) source.seed('sh_operator_metadata','storage_migration',gate(mode));
  const db=createJournaledFirestore({firestore:source,serverTimestamp:()=>({fakeCommitTimestamp:true})});
  const events=()=>Object.entries(source.dump()).filter(([path])=>path.startsWith('sh_operator_migration_journal/')).map(([,value])=>value);
  return {db,source,events};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('normal source mode preserves existing writes without starting migration',async()=>{
  const f=fixture(null);await f.db.collection('sh_operator_devices').doc('phone').set({label:'Phone'});
  assert.deepEqual((await f.db.collection('sh_operator_devices').doc('phone').get()).data(),{label:'Phone'});
  assert.equal(f.events().length,0);
});
test('device change and replayable after-image commit atomically',async()=>{
  const f=fixture(),ref=f.db.collection('sh_operator_devices').doc('phone');
  await f.db.runTransaction(async tx=>{assert.equal((await tx.get(ref)).exists,false);tx.create(ref,{id:'phone',generation:3});return 91;});
  const [event]=f.events();assert.equal(event.migrationId,migrationId);assert.equal(event.mutations.length,1);
  assert.deepEqual(event.mutations[0],{path:ref.path,value:{id:'phone',generation:3}});
  assert.equal(event.hash,storageJournalHash(event.mutations));assert.deepEqual(event.committedAt,{fakeCommitTimestamp:true});
});
test('failed source commit leaves neither the app write nor journal evidence',async()=>{
  const f=fixture();f.source.failBeforeCommit=Error('Synthetic source failure');
  await assert.rejects(f.db.collection('sh_operator_devices').doc('phone').set({id:'phone'}),/Synthetic/);
  assert.equal(f.source.dump()['sh_operator_devices/phone'],undefined);assert.equal(f.events().length,0);
});
test('lost source acknowledgement retains a journal for every already committed app write',async()=>{
  const f=fixture();f.source.failAfterCommit=Error('Synthetic lost acknowledgement');
  await assert.rejects(f.db.collection('sh_operator_devices').doc('phone').set({id:'phone'}),/Synthetic/);
  assert.equal(f.source.dump()['sh_operator_devices/phone'].id,'phone');assert.equal(f.events().length,1);
});
test('fenced source rejects read and write callbacks before serving stale records',async()=>{
  const f=fixture('cloudflare');let callbackRuns=0;
  await assert.rejects(f.db.runTransaction(()=>{callbackRuns++;}),{code:'STORAGE_SOURCE_FENCED'});
  await assert.rejects(f.db.collection('sh_operator_devices').doc('phone').get(),{code:'STORAGE_SOURCE_FENCED'});
  assert.equal(callbackRuns,0);assert.equal(f.events().length,0);
});
test('source cutover races are detected by the same Firestore transaction fence',async()=>{
  const f=fixture(),started=deferred(),continueWrite=deferred();let calls=0;
  const result=f.db.runTransaction(async tx=>{calls++;started.resolve();await continueWrite.promise;tx.set(f.db.collection('sh_operator_devices').doc('phone'),{id:'phone'});});
  await started.promise;f.source.seed('sh_operator_metadata','storage_migration',gate('cloudflare'));continueWrite.resolve();
  await assert.rejects(result,{code:'STORAGE_SOURCE_FENCED'});assert.equal(calls,1);
  assert.equal(f.source.dump()['sh_operator_devices/phone'],undefined);assert.equal(f.events().length,0);assert.ok(f.source.conflicts>=1);
});
test('source write conflicts retry with one final after-image journal event',async()=>{
  const f=fixture(),started=deferred(),continueWrite=deferred();let calls=0;
  f.source.seed('sh_operator_devices','phone',{id:'phone',count:0});
  const ref=f.db.collection('sh_operator_devices').doc('phone');
  const result=f.db.runTransaction(async tx=>{const before=(await tx.get(ref)).data();if(++calls===1){started.resolve();await continueWrite.promise;}tx.set(ref,{...before,count:before.count+1});});
  await started.promise;f.source.seed('sh_operator_devices','phone',{id:'phone',count:8});continueWrite.resolve();await result;
  assert.equal(f.source.dump()[ref.path].count,9);assert.equal(calls,2);assert.equal(f.events().length,1);assert.equal(f.events()[0].mutations[0].value.count,9);
});
test('multiple changes produce final after-images, byte-safe archives and deletion tombstones',async()=>{
  const f=fixture();f.source.seed('sh_operator_devices','phone',{id:'phone',nested:{old:1}});
  const devices=f.db.collection('sh_operator_devices'),archive=f.db.collection('sh_operator_reports_archive_chunks').doc('part');
  await f.db.runTransaction(async tx=>{tx.update(devices.doc('phone'),{'nested.old':2});tx.create(archive,{bytes:new Uint8Array([0,10,255]),reserved:{__sh_store_bytes_v1:'ordinary value'}});});
  const encoded=f.events()[0].mutations.find(x=>x.path===archive.path).value;
  assert.deepEqual(decodeCloudflareValue(encoded),{bytes:new Uint8Array([0,10,255]),reserved:{__sh_store_bytes_v1:'ordinary value'}});
  assert.equal(f.source.dump()['sh_operator_devices/phone'].nested.old,2);
  await devices.doc('phone').delete();assert.deepEqual(f.events().at(-1).mutations,[{path:'sh_operator_devices/phone',deleted:true}]);
});
test('read-only requests do not create journal entries and cannot stage writes',async()=>{
  const f=fixture();assert.equal((await f.db.collection('sh_operator_devices').get()).size,0);
  assert.deepEqual(await f.db.getAll(f.db.collection('sh_operator_devices').doc('phone')).then(rows=>rows.map(x=>x.exists)),[false]);
  await assert.rejects(f.db.runTransaction(tx=>tx.set(f.db.collection('sh_operator_devices').doc('phone'),{id:'phone'}),{readOnly:true}),{code:'STORAGE_JOURNAL_READ_ONLY'});
  assert.equal(f.events().length,0);
});
test('private migration metadata, foreign references and unsupported transforms cannot be journaled',async()=>{
  const f=fixture();assert.throws(()=>f.db.collection('other_devices'));assert.throws(()=>f.db.collection('sh_operator_migration_journal'));
  assert.throws(()=>f.db.collection('sh_operator_metadata').doc('storage_migration'));
  await assert.rejects(f.db.collection('sh_operator_devices').doc('phone').set({bad:new Map()}));
  await assert.rejects(f.db.runTransaction(tx=>tx.set(f.source.collection('sh_operator_devices').doc('phone'),{id:'phone'})),{code:'STORAGE_JOURNAL_REFERENCE_REQUIRED'});
  assert.equal(f.events().length,0);
});
test('Date-valued handover receipt expiry survives source writes and target encoding',async()=>{
  const f=fixture(),expiry=new Date('2026-12-04T08:30:00.123Z');
  await f.db.collection('sh_operator_ai_handover_receipts').doc('receipt').set({deleteAfter:expiry});
  assert.equal(f.source.dump()['sh_operator_ai_handover_receipts/receipt'].deleteAfter.toISOString(),expiry.toISOString());
  assert.equal(decodeCloudflareValue(f.events()[0].mutations[0].value).deleteAfter.toDate().toISOString(),expiry.toISOString());
});
test('read-after-write and unsupported merge abort before all source mutations',async()=>{
  const f=fixture(),ref=f.db.collection('sh_operator_devices').doc('phone');
  await assert.rejects(f.db.runTransaction(async tx=>{tx.set(ref,{id:'phone'});await tx.get(ref);}),{code:'STORAGE_JOURNAL_READS_BEFORE_WRITES'});
  await assert.rejects(ref.set({id:'phone'},{merge:true}),{code:'STORAGE_JOURNAL_UNSUPPORTED_WRITE'});
  assert.equal(f.events().length,0);
});
test('corrupt source fence fails closed',()=>{
  for(const row of [{schema:1,mode:'invalid',epoch:0,migrationId:''},{schema:1,mode:'cloudflare',epoch:-1,migrationId},{schema:1,mode:'shadow',epoch:1,migrationId:'bad'}])
    assert.throws(()=>readStorageMigrationGate({exists:true,data:()=>row}),{code:'STORAGE_MIGRATION_GATE_INVALID'});
});
test('actual SDK filtered queries retain their private collection scope without relying on Query.path',async()=>{
  const {Firestore}=await import('@google-cloud/firestore');
  const firestore=new Firestore({projectId:'fixture-source-query-only'});
  const raw=firestore.collection('sh_operator_devices').where('revokedAt','==',0).orderBy('updatedAt').limit(5);
  assert.equal(raw.path,undefined,'SDK filtered Query intentionally has no public path');
  let filteredReads=0;
  firestore.runTransaction=async callback=>callback({get:async reference=>{
    if(reference.path==='sh_operator_metadata/storage_migration')return {exists:false};
    assert.equal(reference.path,undefined);assert.equal(reference.constructor.name,'Query');filteredReads++;
    return {docs:[],empty:true,size:0};
  }});
  const db=createJournaledFirestore({firestore,serverTimestamp:()=>({})});
  const query=db.collection('sh_operator_devices').where('revokedAt','==',0).orderBy('updatedAt').limit(5);
  assert.equal((await db.runTransaction(tx=>tx.get(query),{readOnly:true})).empty,true);
  assert.equal((await query.get()).size,0);assert.equal(filteredReads,2);
  await firestore.terminate();
});
test('large multi-call writes split replay evidence while remaining in one source commit',async()=>{
  const f=fixture(),calls=f.db.collection('sh_operator_media_calls'),large='x'.repeat(500*1024);
  await f.db.runTransaction(tx=>{tx.set(calls.doc('first'),{data:large});tx.set(calls.doc('second'),{data:large});});
  assert.equal(f.source.commits,1);assert.equal(f.events().length,2);
  assert.deepEqual(f.events().flatMap(event=>event.mutations.map(m=>m.path)).sort(),['sh_operator_media_calls/first','sh_operator_media_calls/second']);
  assert.equal(new Set(f.events().map(event=>event.eventId)).size,2);
  for(const event of f.events()){assert.ok(Buffer.byteLength(JSON.stringify(event))<900*1024);assert.equal(event.hash,storageJournalHash(event.mutations));}
});
test('previously persisted actual SDK Timestamps keep their SDK type when rewriting source after-images',async()=>{
  const {Firestore,Timestamp}=await import('@google-cloud/firestore');
  const firestore=new Firestore({projectId:'fixture-source-timestamp-only'}),timestamp=new Timestamp(1800000000,123456789);
  const raw=firestore.collection('sh_operator_ai_handover_receipts').doc('receipt');let stored,event;
  firestore.runTransaction=async callback=>callback({get:async reference=>reference.path==='sh_operator_metadata/storage_migration'
    ?{exists:true,data:()=>gate('shadow')}
    :{exists:true,ref:raw,id:'receipt',data:()=>({schema:1,deleteAfter:timestamp})},
    create:(ref,value)=>{event=value;},set:(ref,value)=>{stored=value;}});
  const db=createJournaledFirestore({firestore,serverTimestamp:()=>({commit:true})});
  await db.collection('sh_operator_ai_handover_receipts').doc('receipt').update({state:'complete'});
  assert.equal(stored.deleteAfter,timestamp);assert.equal(stored.deleteAfter instanceof Timestamp,true);
  assert.equal(decodeCloudflareValue(event.mutations[0].value).deleteAfter.nanoseconds,123456789);
  await firestore.terminate();
});
