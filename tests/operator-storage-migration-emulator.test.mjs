// Isolated official Firestore transaction semantics; production is forbidden.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Firestore,FieldValue,FieldPath} from '@google-cloud/firestore';
import {DocumentStore} from '../cloudflare/operator-store/src/store.mjs';
import {createJournaledFirestore} from '../operator-storage-journal.js';
import {createStorageMigrationManager} from '../operator-storage-migration.js';

if(process.env.SH_STORAGE_MIGRATION_EMULATOR_TESTS!=='1'||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8089')
  throw Error('Storage migration race tests require explicit localhost8089 emulator opt-in.');
const source=new Firestore({projectId:'demo-sh-storage-migration'});
after(()=>source.terminate());
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t,{beforeFence,assertNoActiveCalls=()=>true,targetHook,classifyQuietManifest}={}){
  const prefix='cfproof_'+randomUUID().replaceAll('-',''),db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const storage={sql:{exec(sql,...params){if(!params.length&&sql.includes(';')){db.exec(sql);return{toArray:()=>[],[Symbol.iterator]:function*(){}};}
    const statement=db.prepare(sql),rows=statement.columns().length?statement.all(...params):(statement.run(...params),[]);
    return{toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};}},transactionSync(callback){db.exec('BEGIN');try{const value=callback();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const target=new DocumentStore(storage,{prefix});
  const app=createJournaledFirestore({firestore:source,collectionPrefix:prefix,serverTimestamp:()=>FieldValue.serverTimestamp()});
  const config={firestore:source,collectionPrefix:prefix,serverTimestamp:()=>FieldValue.serverTimestamp(),documentIdField:FieldPath.documentId(),pageSize:20,
    targetMigration:async body=>{if(targetHook)await targetHook(body);return target.migration({version:1,...body});},
    classifyQuietManifest:classifyQuietManifest||((rows)=>!rows.some(row=>row.data.data?.active===true)),assertNoActiveCalls,
    ...(beforeFence?{beforeFence}:{}),maxQuietRetries:3};
  const manager=createStorageMigrationManager(config);
  const createCall=()=>{const id='race-call',key=hash(id);return app.collection(prefix+'_media_calls').doc(key).set({schema:1,key:`media_calls/${key}`,data:{id,active:true}});};
  return{prefix,app,manager,target,createCall,gate:()=>source.collection(prefix+'_metadata').doc('storage_migration').get()};
}

test('official source readTime proof activates an empty journal without any historical-media transaction scan',{timeout:60000},async t=>{
  let classified=0;
  const f=fixture(t,{classifyQuietManifest:rows=>{classified++;assert.equal(rows.length,140);return true;}});
  const batch=source.batch();for(let index=0;index<140;index++)batch.set(source.collection(f.prefix+'_metadata').doc('history-'+index),{n:index});await batch.commit();
  await f.manager.prepare();await f.manager.copySnapshot();assert.equal((await f.manager.cutover()).targetReady,true);assert.equal(classified,1);
  await assert.rejects(f.app.collection(f.prefix+'_metadata').doc('stale').set({n:1}),{code:'STORAGE_SOURCE_FENCED'});
});

test('official final transaction detects a new journal phantom committed after preflight and reclassifies the live call',{timeout:60000},async t=>{
  let f,entered=false;
  f=fixture(t,{beforeFence:async()=>{if(!entered){entered=true;await f.createCall();}return()=>{};}});
  await f.manager.prepare();await f.manager.copySnapshot();
  await assert.rejects(f.manager.cutover(),{code:'STORAGE_CALLS_STILL_ACTIVE'});
  assert.equal((await f.gate()).data().mode,'shadow');assert.equal(f.target.meta('mode').state,'staging');
  await f.app.collection(f.prefix+'_metadata').doc('still-working').set({ok:true});
});

test('official preexisting source transaction crossing the gate commits before fence or is retried safely',{timeout:60000},async t=>{
  let f,writer,once=false;const entered=defer(),release=defer();
  f=fixture(t,{beforeFence:async()=>{if(!once){once=true;
    writer=f.app.runTransaction(async tx=>{const ref=f.app.collection(f.prefix+'_metadata').doc('inflight');await tx.get(ref);entered.resolve();await release.promise;tx.set(ref,{active:true});});
    void writer.catch(()=>{});await entered.promise;setTimeout(()=>release.resolve(),100);
  }return()=>{};},classifyQuietManifest:rows=>!rows.some(row=>row.data.active===true)});
  await f.manager.prepare();await f.manager.copySnapshot();
  await assert.rejects(f.manager.cutover(),{code:'STORAGE_CALLS_STILL_ACTIVE'});await writer;
  assert.equal((await f.gate()).data().mode,'shadow');assert.equal(f.target.meta('mode').state,'staging');
});

test('official source write begun after the final journal query cannot commit through the durable fence',{timeout:60000},async t=>{
  let f,writer,checks=0;
  f=fixture(t,{assertNoActiveCalls:()=>{if(++checks===2){writer=f.createCall();void writer.catch(()=>{});}return true;}});
  await f.manager.prepare();await f.manager.copySnapshot();
  const result=await f.manager.cutover();assert.equal(result.targetReady,true);
  await assert.rejects(writer,{code:'STORAGE_SOURCE_FENCED'});
  const rows=await source.collection(f.prefix+'_media_calls').get();assert.equal(rows.empty,true);
  assert.equal((await f.gate()).data().mode,'cloudflare');
});
