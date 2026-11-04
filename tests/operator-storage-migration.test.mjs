import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { createStorageMigrationSourceFixture } from './operator-storage-migration-helpers.mjs';
import {encodeCloudflareValue} from '../operator-cloudflare-client.js';
import { createStorageMigrationManager, sourceStorageVersion, storageManifestSummary,validateStorageIdentityBindings,createCloudflareMigrationTransport } from '../operator-storage-migration.js';

const copy=value=>structuredClone(value);
function fixture({quiet=true,failAfter='',failStatusAfterAck=false,tamperChecksum=false,importHook,targetHook}={}) {
  const {source,app,serverTimestamp,seed}=createStorageMigrationSourceFixture();
  const rows=new Map(),live=new Map(),requests=new Set();let migration=null,mode={state:'inactive'},fault=failAfter,activations=0,statusFault=false,checksumCalls=0;
  const summary=()=>storageManifestSummary([...rows].filter(([,r])=>!r.deleted).map(([path,r])=>({path,data:r.data})));
  const target=async input=>{
    if(targetHook)await targetHook({input,app,source});
    if(input.op==='status'){if(statusFault){statusFault=false;throw Error('Recovery status unavailable');}return {ok:true,mode:copy(mode),migration:copy(migration)};}
    if(input.op==='begin'){migration ||= {id:input.migrationId,state:'importing'};return {ok:true,migration:copy(migration)};}
    if(input.op==='import'){
      if(migration?.state!=='importing')throw Error('Import closed');
      if(!requests.has(input.requestId)){for(const doc of input.documents){const previous=rows.get(doc.path),cmp=previous?BigInt(doc.sourceVersion.seconds)-BigInt(previous.sourceVersion.seconds):1n;
        if(cmp>0n)rows.set(doc.path,copy(doc));else if(cmp===0n)assert.deepEqual(doc,previous,'same source version cannot change payload');}requests.add(input.requestId);}
      if(importHook)await importHook({input,app,source});return {ok:true};
    }
    if(input.op==='checksum')return {ok:true,...summary(),...(tamperChecksum&&++checksumCalls>1?{checksum:'bad'}:{})};
    if(input.op==='seal'){const s=summary();assert.equal(input.expectedChecksum,s.checksum);assert.equal(input.expectedCount,s.count);migration={...migration,state:'sealed',...s};if(fault==='seal'){fault='';statusFault=failStatusAfterAck;throw Error('Lost seal acknowledgement');}return {ok:true,...s};}
    if(input.op==='activate'){assert.equal(migration.state,'sealed');mode={state:'active',migrationId:migration.id,checksum:migration.checksum};migration.state='activated';for(const [path,row]of rows)if(!row.deleted)live.set(path,copy(row.data));activations++;if(fault==='activate'){fault='';statusFault=failStatusAfterAck;throw Error('Lost activation acknowledgement');}return {ok:true,mode:copy(mode)};}
    throw Error('Unsupported op');
  };
  const config={firestore:source,serverTimestamp,targetMigration:target,assertNoActiveCalls:async()=>quiet,classifyQuietManifest:()=>true,pageSize:2,maxJournalPasses:100};
  const manager=createStorageMigrationManager(config);
  return {source,app,manager,config,rows,live,stats:()=>({activations}),seed};
}

test('live source writes during snapshot are replayed without changing phone identity, revocation or unread',async()=>{
  let changed=false;
  const f=fixture({importHook:async({app})=>{if(changed)return;changed=true;await app.collection('sh_operator_devices').doc('phone').update({revokedAt:1800000001});}});
  f.seed('sh_operator_devices','phone',{schema:1,id:'phone',tokenHash:'same-private-digest',credentialGeneration:9,revokedAt:0});
  f.seed('sh_operator_app_messages','73',{channelId:73,manualUnread:true,pendingIds:[21]});
  await f.manager.prepare();await f.manager.copySnapshot();await f.manager.replay();const result=await f.manager.cutover();
  assert.equal(result.targetReady,true);assert.equal(f.live.get('sh_operator_devices/phone').credentialGeneration,9);assert.equal(f.live.get('sh_operator_devices/phone').revokedAt,1800000001);
  assert.deepEqual(f.live.get('sh_operator_app_messages/73').pendingIds,[21]);assert.equal(f.stats().activations,1);
  assert.equal(JSON.stringify(result).includes('same-private-digest'),false,'public status must not expose documents or credentials');
});
test('a deletion after snapshot cannot be resurrected by a repeated older snapshot import',async()=>{
  const f=fixture();f.seed('sh_operator_devices','retired',{schema:1,id:'retired'});await f.manager.prepare();await f.manager.copySnapshot();
  await f.app.collection('sh_operator_devices').doc('retired').delete();await f.manager.replay();await f.manager.cutover();
  assert.equal(f.live.has('sh_operator_devices/retired'),false);assert.equal(f.rows.get('sh_operator_devices/retired').deleted,true);
});
test('active calls block the fence while the existing backend remains writable',async()=>{
  const f=fixture({quiet:false});f.seed('sh_operator_devices','phone',{schema:1,id:'phone'});await f.manager.prepare();await f.manager.copySnapshot();
  await assert.rejects(f.manager.cutover(),{code:'STORAGE_CALLS_STILL_ACTIVE'});assert.equal((await f.manager.status()).mode,'shadow');
  await f.app.collection('sh_operator_devices').doc('phone').update({label:'Still working'});assert.equal(f.source.dump()['sh_operator_devices/phone'].label,'Still working');
});
for(const operation of ['seal','activate'])test(`a lost ${operation} acknowledgement resumes from durable target state after process restart`,async()=>{
  const f=fixture({failAfter:operation,failStatusAfterAck:true});f.seed('sh_operator_devices','phone',{schema:1,id:'phone'});await f.manager.prepare();await f.manager.copySnapshot();
  await assert.rejects(f.manager.cutover(),/Lost/);const replacement=createStorageMigrationManager(f.config);const status=await replacement.cutover();
  assert.equal(status.targetReady,true);assert.equal(f.stats().activations,1);
});
for(const operation of ['seal','activate'])test(`combined cutover finishes immediately after one lost ${operation} acknowledgement`,async()=>{
  const f=fixture({failAfter:operation});f.seed('sh_operator_devices','phone',{schema:1,id:'phone'});await f.manager.prepare();await f.manager.copySnapshot();
  assert.equal((await f.manager.cutover()).targetReady,true);assert.equal(f.stats().activations,1);
});
test('an integrity mismatch never activates the target or silently returns to the source',async()=>{
  const f=fixture({tamperChecksum:true});f.seed('sh_operator_devices','phone',{schema:1,id:'phone'});await f.manager.prepare();await f.manager.copySnapshot();
  await assert.rejects(f.manager.cutover(),{code:'STORAGE_TARGET_MANIFEST_MISMATCH'});assert.equal(f.stats().activations,0);
  assert.equal((await f.manager.status()).mode,'cloudflare');assert.equal((await f.manager.status()).targetReady,false);
  await assert.rejects(f.app.collection('sh_operator_devices').doc('phone').set({id:'stale overwrite'}),{code:'STORAGE_SOURCE_FENCED'});
});
test('empty databases can complete a verified migration and missing snapshot cannot fence',async()=>{
  const f=fixture();await f.manager.prepare();await assert.rejects(f.manager.cutover(),{code:'STORAGE_SNAPSHOT_REQUIRED'});
  await f.manager.copySnapshot();assert.equal((await f.manager.cutover()).verifiedCount,0);
});
test('missing source update times and duplicate manifest paths fail instead of producing unverifiable snapshots',()=>{
  assert.throws(()=>sourceStorageVersion(undefined),{code:'STORAGE_SOURCE_VERSION_INVALID'});
  assert.throws(()=>storageManifestSummary([{path:'x/y',data:{}},{path:'x/y',data:{}}]),{code:'STORAGE_MANIFEST_INVALID'});
});
test('combined cutover verifies live then catches the final tail without scanning while source is fenced',async()=>{
  let written=false;
  const f=fixture({targetHook:async({input,app})=>{if(input.op==='checksum'&&!written){written=true;await app.collection('sh_operator_app_messages').doc('tail').set({unread:true});}}});
  f.seed('sh_operator_devices','phone',{schema:1,id:'phone'});
  await f.manager.prepare();await f.manager.copySnapshot();
  const originalList=f.source.listCollections;
  f.source.listCollections=async()=>{assert.notEqual(f.source.dump()['sh_operator_metadata/storage_migration'].mode,'cloudflare','normal cutover cannot inventory the whole source while fenced');return originalList();};
  assert.equal((await f.manager.cutover()).targetReady,true);assert.equal(f.live.get('sh_operator_app_messages/tail').unread,true);
});
test('combined cutover fails safely before fencing when a phone is still in a call',async()=>{
  const f=fixture({quiet:false});await f.manager.prepare();await f.manager.copySnapshot();
  await assert.rejects(f.manager.cutover(),{code:'STORAGE_CALLS_STILL_ACTIVE'});assert.equal((await f.manager.status()).mode,'shadow');
});
test('credential, media identity and private archive byte bindings are verified before activation',()=>{
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const documents=[{path:'sh_operator_devices/phone',data:{schema:1,id:'phone',tokenHash:'token-digest',credentialGeneration:3}},
    {path:'sh_operator_credentials/token-digest',data:{schema:1,deviceId:'phone',generation:3,active:true}},
    {path:`sh_operator_media_sessions/${hash('call-1')}`,data:{schema:1,key:`media_sessions/${hash('call-1')}`,data:{id:'call-1'}}},
    {path:'sh_operator_reports_archive_chunks/part-1',data:encodeCloudflareValue({bytes:Buffer.from('private-report'),sha256:hash('private-report')})}];
  assert.deepEqual(validateStorageIdentityBindings(documents),{devices:1,credentials:1,sessions:1,archiveChunks:1});
  const invalid=copy(documents);invalid[1].data.generation=2;
  assert.throws(()=>validateStorageIdentityBindings(invalid),{code:'STORAGE_CREDENTIAL_BINDING_MISMATCH'});
  invalid[1].data.generation=3;delete invalid[2].data.data.id;
  assert.throws(()=>validateStorageIdentityBindings(invalid),{code:'STORAGE_MEDIA_BINDING_MISMATCH'});
  invalid[2]=copy(documents[2]);invalid[3].data.sha256=hash('tampered');
  assert.throws(()=>validateStorageIdentityBindings(invalid),{code:'STORAGE_ARCHIVE_CHUNK_MISMATCH'});
});
test('migration transport keeps its separate HMAC scope and identical body across lost acknowledgements',async()=>{
  const requests=[];let count=0;
  const secret='fixture-only-separate-migration-secret-at-least-32';
  const transport=createCloudflareMigrationTransport({endpoint:'https://private.example.test',secret,storeSecret:'different-key',fetchImpl:async(url,options)=>{
    requests.push({url,...options});if(count++===0)throw Error('Lost acknowledgement');return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}});}});
  assert.equal((await transport({op:'import',migrationId:'fixture-migration-id',requestId:'same-body',documents:[]})).ok,true);
  assert.equal(requests.length,2);assert.equal(requests[0].body,requests[1].body);assert.notEqual(requests[0].headers['x-sh-store-nonce'],requests[1].headers['x-sh-store-nonce']);
  assert.equal(requests[0].url,'https://private.example.test/migration');assert.equal(requests[0].redirect,'error');
  assert.throws(()=>createCloudflareMigrationTransport({endpoint:'https://private.example.test/unsafe',secret}),TypeError);
  assert.throws(()=>createCloudflareMigrationTransport({endpoint:'https://private.example.test',secret,storeSecret:secret}),TypeError);
});
test('video admission guard wraps the atomic quiet-point fence and releases on success or active-call rejection',async()=>{
  for(const quiet of [true,false]){
    const f=fixture({quiet});let paused=false,released=0;
    const manager=createStorageMigrationManager({...f.config,beforeFence:()=>{assert.equal(paused,false);paused=true;return()=>{paused=false;released++;};},
      assertNoActiveCalls:async()=>{assert.equal(paused,true);return quiet;}});
    await manager.prepare();await manager.copySnapshot();
    if(quiet)assert.equal((await manager.cutover()).targetReady,true);
    else await assert.rejects(manager.cutover(),{code:'STORAGE_CALLS_STILL_ACTIVE'});
    assert.equal(paused,false);assert.equal(released,1);
  }
});
test('quiet proof checks recent metadata only after classifying a large retained media inventory',async()=>{
  const f=fixture(),hash=value=>createHash('sha256').update(value).digest('hex');let classified=0;
  for(let index=0;index<350;index++){const id=`old-event-${index}`,key=hash(id);
    f.seed('sh_operator_media_events',key,{schema:1,key:`media_events/${key}`,revision:1,data:{id,kind:'terminal',providerCallId:`old-call-${index}`}});}
  const manager=createStorageMigrationManager({...f.config,classifyQuietManifest:documents=>{classified++;assert.ok(documents.length>=350);
    assert.equal(f.source.dump()['sh_operator_metadata/storage_migration'].mode,'shadow');return true;}});
  await manager.prepare();await manager.copySnapshot();
  const originalQuery=f.source.query;
  f.source.query=(query,records)=>{assert.equal(query.path,'sh_operator_migration_journal','final native transaction must not scan media history');
    assert.deepEqual(query.__migrationQuery.projection,['schema','eventId','migrationId','epoch','hash','committedAt']);return originalQuery(query,records);};
  assert.equal((await manager.cutover()).targetReady,true);assert.equal(classified,1);
});
test('a call created after preflight is reclassified before fencing and leaves source calls working',async()=>{
  const hash=value=>createHash('sha256').update(value).digest('hex');let created=false;
  const f=fixture({targetHook:async({input,app})=>{if(input.op==='checksum'&&!created){created=true;const id='new-ringing',key=hash(id);
    await app.collection('sh_operator_media_calls').doc(key).set({schema:1,key:`media_calls/${key}`,data:{id,active:true}});}}});
  let classifications=0;
  const manager=createStorageMigrationManager({...f.config,classifyQuietManifest:documents=>{classifications++;return !documents.some(row=>row.data.data?.active===true);}});
  await manager.prepare();await manager.copySnapshot();
  await assert.rejects(manager.cutover(),{code:'STORAGE_CALLS_STILL_ACTIVE'});
  assert.equal(classifications,2);assert.equal((await manager.status()).mode,'shadow');assert.equal(f.stats().activations,0);
  await f.app.collection('sh_operator_metadata').doc('still-writable').set({ok:true});
});
test('continuous journal changes exhaust a bounded proof retry without freezing current app writes',async()=>{
  let changes=0;
  const f=fixture({targetHook:async({input,app})=>{if(input.op==='checksum')await app.collection('sh_operator_metadata').doc('churn').set({n:++changes});}});
  await f.manager.prepare();await f.manager.copySnapshot();
  await assert.rejects(f.manager.cutover(),{code:'STORAGE_QUIET_PROOF_CHANGED'});assert.equal(changes,3);
  assert.equal((await f.manager.status()).mode,'shadow');assert.equal(f.stats().activations,0);
});
test('combined cutover requires an explicit complete-manifest classifier',async()=>{
  const f=fixture();const manager=createStorageMigrationManager({...f.config,classifyQuietManifest:undefined});
  await manager.prepare();await manager.copySnapshot();await assert.rejects(manager.cutover(),{code:'STORAGE_QUIET_PROOF_REQUIRED'});
  assert.equal((await manager.status()).mode,'shadow');
});

test('public manager cannot bypass combined quiet proof through a standalone fence or activation method',()=>{const f=fixture();assert.equal(f.manager.fence,undefined);assert.equal(f.manager.completeCutover,undefined);});
test('a quiet proof from a superseded migration epoch cannot fence the replacement source workflow',async()=>{
  const f=fixture();
  const manager=createStorageMigrationManager({...f.config,beforeFence:()=>{const current=f.source.dump()['sh_operator_metadata/storage_migration'];
    f.seed('sh_operator_metadata','storage_migration',{...current,migrationId:'replacement_migration_001',epoch:current.epoch+1});return()=>{};}});
  await manager.prepare();await manager.copySnapshot();await assert.rejects(manager.cutover(),{code:'STORAGE_MIGRATION_CHANGED'});
  assert.equal((await manager.status()).mode,'shadow');assert.equal(f.stats().activations,0);
});
