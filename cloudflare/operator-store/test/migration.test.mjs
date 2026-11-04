import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {createStorageMigrationSourceFixture} from '../../../tests/operator-storage-migration-helpers.mjs';
import {createStorageMigrationManager,createCloudflareMigrationTransport} from '../../../operator-storage-migration.js';
import {createCloudflareFirestoreClient} from '../../../operator-cloudflare-client.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const key='fixture-only-normal-worker-store-secret-at-least-32';
const migrationKey='fixture-only-separate-worker-migration-secret-at-least-32';
async function fixture(t,{loseAcknowledgement='',loseRecoveryStatus=false,finalTail=false}={}){
  const source=createStorageMigrationSourceFixture();let fault=loseAcknowledgement,tailWritten=false,statusFault=false;
  const mf=new Miniflare({modules:true,scriptPath:fileURLToPath(new URL('../src/worker.mjs',import.meta.url)),compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
    durableObjects:{OPERATOR_STORE:{className:'OperatorStore',useSQLite:true}},
    bindings:{SH_STORE_PREFIX:'sh_operator',SH_STORE_TENANT:'smart-handicrafts',SH_STORE_SECRET:key,SH_STORE_MIGRATION_SECRET:migrationKey}});
  t.after(()=>mf.dispose());await mf.ready;
  const transport=createCloudflareMigrationTransport({endpoint:'https://private-store.example.test',secret:migrationKey,storeSecret:key,transportAttempts:1,
    fetchImpl:async(url,options)=>{
      const input=JSON.parse(options.body);
      if(input.op==='status'&&statusFault){statusFault=false;throw Error('Recovery status unavailable after process loss');}
      if(finalTail&&input.op==='checksum'&&!tailWritten){tailWritten=true;await source.app.collection('sh_operator_app_messages').doc('last-second').set({manualUnread:true,pendingIds:[99]});}
      const response=await mf.dispatchFetch(url,options);
      if(fault===input.op&&response.ok){fault='';statusFault=loseRecoveryStatus;await response.text();throw Error('Lost acknowledgement after committed worker mutation');}
      return response;
    }});
  const config={firestore:source.source,serverTimestamp:source.serverTimestamp,targetMigration:transport,assertNoActiveCalls:async()=>true,pageSize:2};
  const manager=createStorageMigrationManager(config);
  const client=createCloudflareFirestoreClient({endpoint:'https://private-store.example.test',secret:key,fetchImpl:(url,options)=>mf.dispatchFetch(url,options)});
  t.after(()=>client.terminate());return{...source,mf,transport,manager,config,client};
}

test('real migration copies live phones, replays credential changes and activates after a bounded final tail',{timeout:60000},async t=>{
  const f=await fixture(t,{finalTail:true}),oldHash=hash('old-fixture-token'),newHash=hash('new-fixture-token');
  f.seed('sh_operator_devices','phone',{schema:1,id:'phone',installationId:'stable-installation',tokenHash:oldHash,credentialGeneration:1,revokedAt:0});
  f.seed('sh_operator_credentials',oldHash,{schema:1,deviceId:'phone',generation:1,active:true});
  f.seed('sh_operator_installations','stable-installation',{schema:1,installationId:'stable-installation',deviceId:'phone'});
  f.seed('sh_operator_enrollments','consumed-invitation',{schema:1,consumedAt:1800000000,deviceId:'phone',requestHash:hash('consumed-evidence')});
  const bytes=Buffer.from('private recorded call report');
  f.seed('sh_operator_reports_archive_chunks','part-1',{schema:1,bytes,sha256:hash(bytes)});
  const callId='terminal-call',id=hash(callId);
  f.seed('sh_operator_media_sessions',id,{schema:1,key:`media_sessions/${id}`,revision:3,updatedAt:1800000000,data:{id:callId,phase:'ended',terminal:{confirmedAt:1800000000}}});
  f.seed('sh_operator_ai_handover_receipts','receipt',{schema:1,deleteAfter:new Date('2026-12-01T00:00:00.000Z')});
  await assert.rejects(f.client.collection('sh_operator_devices').doc('phone').get(),{code:'CLOUDFLARE_STORE_UNAVAILABLE'});
  await f.manager.prepare();await f.manager.copySnapshot();
  await f.app.runTransaction(async tx=>{
    const device=f.app.collection('sh_operator_devices').doc('phone');await tx.get(device);
    tx.update(device,{tokenHash:newHash,credentialGeneration:2});
    tx.set(f.app.collection('sh_operator_credentials').doc(oldHash),{schema:1,deviceId:'phone',generation:1,active:false});
    tx.create(f.app.collection('sh_operator_credentials').doc(newHash),{schema:1,deviceId:'phone',generation:2,active:true});
    tx.set(f.app.collection('sh_operator_app_messages').doc('chat-1'),{manualUnread:true,pendingIds:[73]});
  });
  await f.manager.replay();
  const listCollections=f.source.listCollections;
  f.source.listCollections=async()=>{assert.notEqual(f.source.dump()['sh_operator_metadata/storage_migration'].mode,'cloudflare');return listCollections();};
  const result=await f.manager.cutover();assert.equal(result.targetReady,true);
  const device=(await f.client.collection('sh_operator_devices').doc('phone').get()).data();
  assert.equal(device.id,'phone');assert.equal(device.installationId,'stable-installation');assert.equal(device.tokenHash,newHash);assert.equal(device.credentialGeneration,2);
  assert.equal((await f.client.collection('sh_operator_credentials').doc(oldHash).get()).data().active,false);
  assert.deepEqual((await f.client.collection('sh_operator_app_messages').doc('last-second').get()).data().pendingIds,[99]);
  assert.equal((await f.client.collection('sh_operator_enrollments').doc('consumed-invitation').get()).data().requestHash,hash('consumed-evidence'));
  assert.deepEqual(Buffer.from((await f.client.collection('sh_operator_reports_archive_chunks').doc('part-1').get()).data().bytes),bytes);
  assert.equal((await f.client.collection('sh_operator_ai_handover_receipts').doc('receipt').get()).data().deleteAfter.toDate().toISOString(),'2026-12-01T00:00:00.000Z');
  await assert.rejects(f.app.collection('sh_operator_devices').doc('phone').set({schema:1,id:'phone'}),{code:'STORAGE_SOURCE_FENCED'});
  await f.client.collection('sh_operator_metadata').doc('working').set({ok:true});
  assert.equal(JSON.stringify(result).includes(newHash),false);
});

for(const operation of ['seal','activate'])test(`real migration immediately recovers after a lost ${operation} response without an external retry`,{timeout:60000},async t=>{
  const f=await fixture(t,{loseAcknowledgement:operation});
  f.seed('sh_operator_devices','phone',{schema:1,id:'phone'});
  await f.manager.prepare();await f.manager.copySnapshot();
  assert.equal((await f.manager.cutover()).targetReady,true);
  await f.client.collection('sh_operator_devices').doc('phone').update({label:'new active target write'});
  const restarted=createStorageMigrationManager(f.config);assert.equal((await restarted.cutover()).targetReady,true);
  assert.equal((await f.client.collection('sh_operator_devices').doc('phone').get()).data().label,'new active target write');
});
test('real migration can resume after activation response and immediate recovery status are both lost',{timeout:60000},async t=>{
  const f=await fixture(t,{loseAcknowledgement:'activate',loseRecoveryStatus:true});
  f.seed('sh_operator_devices','phone',{schema:1,id:'phone'});
  await f.manager.prepare();await f.manager.copySnapshot();
  await assert.rejects(f.manager.cutover(),{code:'STORAGE_MIGRATION_TRANSPORT_UNAVAILABLE'});
  await f.client.collection('sh_operator_devices').doc('phone').update({label:'survives restart'});
  const restarted=createStorageMigrationManager(f.config);assert.equal((await restarted.cutover()).targetReady,true);
  assert.equal((await f.client.collection('sh_operator_devices').doc('phone').get()).data().label,'survives restart');
});
