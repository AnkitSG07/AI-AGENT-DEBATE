// Real SQLite-backed Durable Object + production Node transport + existing
// domain adapters. All identities, tokens, provider actions and data are local.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createCloudflareFirestoreClient,encodeCloudflareValue} from '../operator-cloudflare-client.js';
import {createFirestoreDeviceRegistry} from '../operator-firestore-registry.js';
import {createFirestoreMediaStore} from '../media-store/firestore-media-store.mjs';
import {createAppMessageState} from '../operator-app-message-state.js';
import {createOperatorStorageRuntime} from '../operator-storage-runtime.js';
import {createOperatorStorageRouter} from '../operator-storage-router.js';
import {fixture as mediaFixture,FirestoreFake,fakeFcmToken} from './operator-r12-helpers.mjs';
import {callStoreKey,deviceReservationKey} from '../media/transfer-controller.mjs';

const require=createRequire(new URL('../cloudflare/operator-store/package.json',import.meta.url));
const {Miniflare}=require('miniflare');
const ROOT=fileURLToPath(new URL('../cloudflare/operator-store/src/',import.meta.url));
const SECRET='synthetic-runtime-transport-only-'+ 'r'.repeat(40);
const MIGRATION_SECRET='synthetic-runtime-import-only-'+ 'm'.repeat(40);
const NOW=1800000000000;

async function cloudflareFixture(t,{documents=[]}={}) {
  const mf=new Miniflare({modules:true,scriptPath:ROOT+'worker.mjs',
    compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
    durableObjects:{OPERATOR_STORE:{className:'OperatorStore',useSQLite:true}},
    bindings:{SH_STORE_PREFIX:'sh_operator',SH_STORE_TENANT:'synthetic-runtime',
      SH_STORE_SECRET:SECRET,SH_STORE_MIGRATION_SECRET:MIGRATION_SECRET}});
  let offline=false,loseCommitResponse=false,requests=0,lost=0;
  t.after(()=>mf.dispose());
  const migration=async input=>{
    const body=JSON.stringify({version:1,...input}),timestamp=String(Date.now()),nonce=randomUUID();
    const signed=timestamp+'\n'+nonce+'\n/migration\n'+createHash('sha256').update(body).digest('hex');
    const response=await mf.dispatchFetch('https://operator-store.test/migration',{method:'POST',
      headers:{'Content-Type':'application/json','x-sh-store-timestamp':timestamp,'x-sh-store-nonce':nonce,
        'x-sh-store-signature':createHmac('sha256',MIGRATION_SECRET).update(signed).digest('hex')},body});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
  };
  const migrationId='runtime-fixture-'+randomUUID();
  await migration({op:'begin',migrationId});
  if(documents.length) await migration({op:'import',migrationId,requestId:'initial-domain-import',documents:documents.map(([path,data])=>({path,data:encodeCloudflareValue(data),sourceVersion:{seconds:String(Math.floor(NOW/1000)),nanos:0}}))});
  const manifest=await migration({op:'checksum',migrationId});
  await migration({op:'seal',migrationId,expectedCount:manifest.count,expectedChecksum:manifest.checksum});
  await migration({op:'activate',migrationId,expectedCount:manifest.count,expectedChecksum:manifest.checksum});
  const makeClient=()=>createCloudflareFirestoreClient({endpoint:'https://operator-store.test',secret:SECRET,
    fetchImpl:async(url,options)=>{
      requests++;
      if(offline) return new Response('{"ok":false,"code":"STORE_UNAVAILABLE"}',{status:503,headers:{'Content-Type':'application/json'}});
      const response=await mf.dispatchFetch(url,options);
      const input=JSON.parse(options.body);
      if(loseCommitResponse&&input.op==='commit'&&input.writes.length&&response.status===200){loseCommitResponse=false;lost++;throw Error('Synthetic lost acknowledgement after durable commit');}
      return response;
    }});
  const client=makeClient();t.after(()=>client.terminate());
  return {client,makeClient,migration,manifest,stats:()=>({requests,lost}),
    offline:value=>{offline=value;},loseNextCommitResponse:()=>{loseCommitResponse=true;}};
}
async function enroll(registry,suffix) {
  const invitation=await registry.issueEnrollment({label:'Synthetic phone '+suffix});
  const input={installationId:'installation_'+suffix,requestId:'enrollment_request_'+suffix,
    fcmToken:fakeFcmToken+'_'+suffix,enrollmentCode:invitation.enrollmentCode,deviceLabel:'Synthetic phone',
    nativeBuild:25,mediaProtocol:'sh-room-audio-v1'};
  return {input,device:await registry.enroll(input)};
}

test('existing device bearers, labels, revocations and consumed invitations survive the backend migration',async t=>{
  const source=new FirestoreFake(),before=createFirestoreDeviceRegistry({firestore:source,clock:()=>NOW});
  const a=await enroll(before,'old_phone_0001'),b=await enroll(before,'old_phone_0002');
  await before.revokeDevice(b.device.deviceId);
  const f=await cloudflareFixture(t,{documents:[...source.documents]}),after=createFirestoreDeviceRegistry({firestore:f.client,clock:()=>NOW});
  t.after(()=>after.closeAppMessageState());
  const authenticated=await after.authenticate(a.device.deviceToken);
  assert.equal(authenticated.id,a.device.deviceId);
  assert.equal(authenticated.deviceLabel,'Synthetic phone old_phone_0001');
  assert.equal(authenticated.tokenExpiresAt,a.device.expiresAt);
  await assert.rejects(after.authenticate(b.device.deviceToken),{status:401});
  await assert.rejects(after.enroll({...a.input,installationId:'installation_stolen_code_0001'}),{code:'ENROLLMENT_CONSUMED'});
  const replay=await after.enroll(a.input);
  assert.deepEqual(replay,{...a.device,replayed:true},'A valid bounded lost-enrollment replay retains the same existing device and bearer.');
  assert.equal((await after.listDevices()).length,2);
});

test('Cloudflare enrollment and immediate revocation remain authoritative across independent server clients',async t=>{
  const f=await cloudflareFixture(t),other=f.makeClient();t.after(()=>other.terminate());
  const a=createFirestoreDeviceRegistry({firestore:f.client,clock:()=>NOW}),b=createFirestoreDeviceRegistry({firestore:other,clock:()=>NOW});
  t.after(()=>{a.closeAppMessageState();b.closeAppMessageState();});
  const registration=await enroll(a,'new_phone_0001');
  assert.equal((await b.authenticate(registration.device.deviceToken)).id,registration.device.deviceId);
  await a.revokeDevice(registration.device.deviceId);
  await assert.rejects(b.authenticate(registration.device.deviceToken),{status:401});
  await assert.rejects(a.enroll({...registration.input,installationId:'installation_revived_0001'}),{code:'ENROLLMENT_CONSUMED'});
});

test('a temporary Cloudflare outage fails safely and recovery retains enrollment and unread state',async t=>{
  const f=await cloudflareFixture(t),registry=createFirestoreDeviceRegistry({firestore:f.client,clock:()=>NOW});
  t.after(()=>registry.closeAppMessageState());
  const {device}=await enroll(registry,'outage_phone_0001');
  await registry.observeAppMessages({channelId:73,messageIds:[101,102]});
  f.offline(true);
  await assert.rejects(registry.authenticate(device.deviceToken),{status:503,code:'REGISTRY_UNAVAILABLE'});
  await assert.rejects(registry.listAppMessageState([73]),{status:503});
  f.offline(false);
  assert.equal((await registry.authenticate(device.deviceToken)).id,device.deviceId);
  assert.equal((await registry.listAppMessageState([73]))[0].unreadCount,2);
  assert.equal((await registry.listDevices()).length,1,'An outage must not issue another identity or discard enrollment.');
});

test('app unread changes preserve exact versions and cannot be cleared by a stale second device',async t=>{
  const f=await cloudflareFixture(t),other=f.makeClient();t.after(()=>other.terminate());
  const a=createAppMessageState({firestore:f.client,collectionPrefix:'sh_operator',clock:()=>NOW}),b=createAppMessageState({firestore:other,collectionPrefix:'sh_operator',clock:()=>NOW});
  t.after(()=>{a.close();b.close();});
  await a.observe({channelId:73,messageIds:[101,102]});
  const stale=(await b.list([73]))[0];
  await a.observe({channelId:73,messageIds:[103]});
  await assert.rejects(b.change({channelId:73,throughMessageId:102,expectedStateVersion:stale.stateVersion}),{code:'APP_MESSAGE_STATE_CHANGED'});
  const current=(await b.list([73]))[0];assert.equal(current.unreadCount,3);
  await b.change({channelId:73,throughMessageId:102,expectedStateVersion:current.stateVersion});
  assert.equal((await a.list([73]))[0].unreadCount,1);
});

test('competing native Answers over Cloudflare acquire one call owner and one provider leg',async t=>{
  const cf=await cloudflareFixture(t),store=createFirestoreMediaStore({firestore:cf.client,collectionPrefix:'sh_operator_media',clock:()=>NOW});
  const f=mediaFixture({store});await f.incoming();
  const answers=await Promise.allSettled([
    f.runtime.accept('a','call-in-1',{requestId:'cloudflare_answer_phone_a'}),
    f.runtime.accept('b','call-in-1',{requestId:'cloudflare_answer_phone_b'})]);
  assert.equal(answers.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(answers.filter(x=>x.status==='rejected').length,1);
  assert.equal(f.effects.filter(x=>x.kind==='accept').length,1);
  const accepted=answers.find(x=>x.status==='fulfilled').value;
  await f.ready(accepted,accepted.call.ownerDeviceId);
  const canonical=await store.get(callStoreKey('call-in-1'));
  assert.equal(canonical.owner.deviceId,accepted.call.ownerDeviceId);
  const loser=canonical.owner.deviceId==='a'?'b':'a';
  assert.equal(await store.get(deviceReservationKey(loser)),undefined);
});

test('instant transfer over Cloudflare preserves the customer call and excludes a stale source End',async t=>{
  const cf=await cloudflareFixture(t),store=createFirestoreMediaStore({firestore:cf.client,collectionPrefix:'sh_operator_media',clock:()=>NOW});
  const f=mediaFixture({store}),connected=await f.connected();
  const old=await store.get(callStoreKey('call-in-1'));
  const invited=await f.runtime.transfer('a',connected.call.sessionId,'invite',{
    version:connected.call.version,toDeviceId:'b',requestId:'cloudflare_transfer_0001'});
  const accepted=await f.runtime.transfer('b',connected.call.sessionId,'accept',{
    version:invited.call.version,transferId:invited.call.transfer.id});
  const ready=await f.runtime.transfer('b',connected.call.sessionId,'ready',{
    version:accepted.call.version,transferId:accepted.call.transfer.id,readinessNonce:accepted.readinessNonce,evidence:{unitTest:true}});
  assert.equal(ready.call.ownerDeviceId,'b');
  await assert.rejects(f.runtime.end('a',connected.call.sessionId,{requestId:'cloudflare_stale_end_0001',expectedOwnerLegId:old.owner.legId}),
    error=>['NOT_CALL_OWNER','CALL_LEG_CHANGED'].includes(error.code));
  await f.controller.drainOutbox('call-in-1');
  assert.equal((await store.get(callStoreKey('call-in-1'))).active,true);
  assert.equal(f.effects.some(x=>x.kind==='terminate'),false);
  assert.equal(f.effects.filter(x=>x.kind==='detach'&&x.identity===old.owner.identity).length,1);
});

test('lost HTTP commit acknowledgement cannot enroll a second device identity',async t=>{
  const cf=await cloudflareFixture(t),registry=createFirestoreDeviceRegistry({firestore:cf.client,clock:()=>NOW});
  t.after(()=>registry.closeAppMessageState());
  const invitation=await registry.issueEnrollment({label:'Lost response phone'});
  const input={installationId:'installation_lost_response_0001',requestId:'enroll_lost_response_0001',
    fcmToken:fakeFcmToken,enrollmentCode:invitation.enrollmentCode,deviceLabel:'Lost response phone',nativeBuild:25,mediaProtocol:'sh-room-audio-v1'};
  cf.loseNextCommitResponse();
  const registered=await registry.enroll(input);
  assert.equal(cf.stats().lost,1);
  assert.equal((await registry.listDevices()).length,1);
  assert.equal((await registry.authenticate(registered.deviceToken)).id,registered.deviceId);
  assert.deepEqual(await registry.enroll(input),{...registered,replayed:true});
});

const quietLogger=()=>{
  const entries=[];
  return{entries,info:(...args)=>entries.push(args),warn:(...args)=>entries.push(args)};
};
const targetEnv={SH_ANDROID_REGISTRY_BACKEND:'cloudflare',SH_CLOUDFLARE_STORE_URL:'https://operator-store.test',SH_CLOUDFLARE_STORE_SECRET:SECRET};

test('unchanged file configurations delegate to the original runtime',async()=>{
  for(const backend of [undefined,'file']){
    const env=backend?{SH_ANDROID_REGISTRY_BACKEND:backend}:{},logger=quietLogger();
    const expected={backend:backend||'file',configured:true};
    const actual=createOperatorStorageRuntime({env,logger,sourceFactory:input=>{
      assert.equal(input.env,env);assert.equal(input.logger,logger);return expected;
    },clientFactory:()=>assert.fail('An unchanged deployment must not invoke Cloudflare.')});
    assert.equal(actual,expected);
  }
});

test('standalone Cloudflare runtime uses no Firebase credentials and retains enrollment guard configuration',async()=>{
  let configuration,closed=0,registryClosed=0;
  const target={terminate:async()=>{closed++;}},registry={closeAppMessageState:()=>{registryClosed++;}};
  const runtime=createOperatorStorageRuntime({env:{...targetEnv,SH_ANDROID_REVOKED_DEVICE_IDS:' old-phone, other-phone ,,',SH_ANDROID_BOOTSTRAP_CODE:'consumed-old-code'},logger:quietLogger(),
    sourceFactory:()=>assert.fail('Cloudflare storage must not create a Firebase client.'),
    clientFactory:input=>{assert.equal(input.endpoint,targetEnv.SH_CLOUDFLARE_STORE_URL);assert.equal(input.secret,SECRET);return target;},
    registryFactory:input=>{configuration=input;return registry;}});
  assert.equal(runtime.configured,true);assert.equal(runtime.backend,'cloudflare');
  assert.equal(runtime.firestore,target);assert.equal(runtime.deviceRegistry,registry);
  assert.equal(await runtime.readDatabaseLocation(),'cloudflare');
  assert.equal(configuration.firestore,target);assert.equal(configuration.bootstrapEnrollmentCode,'');
  assert.deepEqual(configuration.revokedIds,['old-phone','other-phone']);
  await runtime.close();assert.equal(closed,1);assert.equal(registryClosed,1);
});

test('invalid Cloudflare configuration is unavailable without exposing secrets or creating Firebase',async()=>{
  for(const patch of [{SH_CLOUDFLARE_STORE_URL:'http://operator-store.test'},
    {SH_CLOUDFLARE_STORE_URL:'https://operator-store.test/rpc'},
    {SH_CLOUDFLARE_STORE_SECRET:'short-private-value'},
    {SH_OPERATOR_FIRESTORE_PREFIX:'outside/scope'}]){
    const logger=quietLogger(),env={...targetEnv,...patch};
    const runtime=createOperatorStorageRuntime({env,logger,
      sourceFactory:()=>assert.fail('Invalid standalone configuration must not create Firebase.'),
      registryFactory:()=>assert.fail('An invalid target must not issue any device registry.')});
    assert.equal(runtime.configured,false);assert.equal(runtime.deviceRegistry,undefined);
    assert.equal(JSON.stringify(logger.entries).includes(env.SH_CLOUDFLARE_STORE_SECRET),false);
    assert.equal(JSON.stringify(logger.entries).includes(env.SH_CLOUDFLARE_STORE_URL),false);
    await runtime.close();
  }
});

for(const enabled of ['true','false'])test('an incomplete target preserves healthy source and honors its fence with migration controls '+enabled,async()=>{
  const source=new FirestoreFake(),logger=quietLogger();
  source.seed('sh_operator_metadata','routing',{origin:'source'});
  const runtime=createOperatorStorageRuntime({env:{SH_ANDROID_REGISTRY_BACKEND:'firestore',SH_CLOUDFLARE_MIGRATION_ENABLED:enabled},logger,
    sourceFactory:()=>({configured:true,firestore:source,close:async()=>{}}),
    registryFactory:()=>({closeAppMessageState(){}})});
  assert.equal(runtime.configured,true);assert.equal(runtime.backend,'firestore');
  assert.equal(runtime.migration.enabled,enabled==='true');
  assert.equal(runtime.migration.targetConfigured,false);
  const ref=runtime.firestore.collection('sh_operator_metadata').doc('routing');
  assert.deepEqual((await ref.get()).data(),{origin:'source'});
  source.seed('sh_operator_metadata','storage_migration',{schema:1,mode:'cloudflare',migrationId:'fixture-runtime-cutover-0001',epoch:1,targetReady:true});
  await assert.rejects(ref.get(),{code:'CLOUDFLARE_STORE_UNAVAILABLE',status:503});
  assert.equal(runtime.backend,'cloudflare');
  source.seed('sh_operator_metadata','routing',{origin:'stale-source'});
  await assert.rejects(ref.get(),{code:'CLOUDFLARE_STORE_UNAVAILABLE',status:503});
  await runtime.close();
});

test('captured runtime references and transactions route once to Cloudflare and never return to stale source',async()=>{
  const source=new FirestoreFake(),target=new FirestoreFake(),logger=quietLogger();
  source.seed('sh_operator_metadata','routing',{origin:'source',n:1});
  target.seed('sh_operator_metadata','routing',{origin:'cloudflare',n:2});
  const runtime=createOperatorStorageRuntime({env:{...targetEnv,SH_ANDROID_REGISTRY_BACKEND:'firestore',SH_CLOUDFLARE_MIGRATION_ENABLED:'true'},logger,
    sourceFactory:()=>({configured:true,firestore:source,readDatabaseLocation:async()=> 'source-test',close:async()=>{}}),
    clientFactory:()=>target,registryFactory:()=>({closeAppMessageState(){}})});
  const ref=runtime.firestore.collection('sh_operator_metadata').doc('routing');
  const query=runtime.firestore.collection('sh_operator_metadata').where('origin','==','cloudflare');
  assert.equal((await ref.get()).data().origin,'source');
  assert.equal(await runtime.readDatabaseLocation(),'source-test');
  source.seed('sh_operator_metadata','storage_migration',{schema:1,mode:'cloudflare',migrationId:'fixture-runtime-cutover-0001',epoch:1,targetReady:true});
  assert.equal((await ref.get()).data().origin,'cloudflare');
  assert.equal((await query.get()).size,1);
  await runtime.firestore.runTransaction(async tx=>{const current=await tx.get(ref);tx.set(current.ref,{...current.data(),n:3});});
  assert.equal(target.documents.get(ref.path).n,3);assert.equal(source.documents.get(ref.path).n,1);
  assert.equal(runtime.backend,'cloudflare');assert.equal(await runtime.readDatabaseLocation(),'cloudflare');
  const sourceRuns=source.transactionRuns;
  target.failReads=Object.assign(Error('Synthetic target unavailable'),{status:503});
  await assert.rejects(ref.get(),{status:503});
  assert.equal(source.transactionRuns,sourceRuns);
  assert.equal(logger.entries.filter(row=>row[0]==='SH_OPERATOR_STORAGE_SWITCH').length,1);
  await runtime.close();
  await assert.rejects(ref.get(),{code:'STORAGE_CLOSED',status:503});
});

test('ordinary source failures and unknown commit outcomes never reroute a transaction to another database',async()=>{
  const source=new FirestoreFake(),target=new FirestoreFake();
  source.seed('sh_operator_metadata','routing',{n:1});target.seed('sh_operator_metadata','routing',{n:0});
  let gateReads=0,callbacks=0;
  const router=createOperatorStorageRouter({source,target,readGate:async()=>{gateReads++;return{mode:'cloudflare',migrationId:'fixture-runtime-cutover-0001',epoch:1};}});
  const ref=router.collection('sh_operator_metadata').doc('routing');
  source.failAfterCommit=Object.assign(Error('Synthetic unknown commit outcome'),{code:'DEADLINE_EXCEEDED',outcomeUnknown:true,status:503});
  await assert.rejects(router.runTransaction(async tx=>{callbacks++;const current=await tx.get(ref);tx.set(ref,{n:current.data().n+1});}),{code:'DEADLINE_EXCEEDED'});
  assert.equal(callbacks,1);assert.equal(gateReads,0);assert.equal(router.backend,'firestore');
  assert.equal(source.documents.get(ref.path).n,2);assert.equal(target.documents.get(ref.path).n,0);
  source.failReads=Object.assign(Error('Synthetic network error'),{code:'UNAVAILABLE',status:503});
  await assert.rejects(ref.get(),{code:'UNAVAILABLE'});
  assert.equal(gateReads,0);assert.equal(target.transactionRuns,0);router.close();
});

test('a confirmed cutover waits for target activation without accepting a stale source or premature target',async()=>{
  const source=new FirestoreFake(),target=new FirestoreFake();
  source.failReads=Object.assign(Error('Source is fenced'),{code:'STORAGE_SOURCE_FENCED',status:503});
  target.seed('sh_operator_metadata','routing',{origin:'cloudflare'});
  let now=0,gateReads=0,targetReads=0;
  const read=target.get.bind(target);target.get=ref=>{targetReads++;return read(ref);};
  const router=createOperatorStorageRouter({source,target,switchWaitMs:500,clock:()=>now,wait:async ms=>{now+=ms;},
    readGate:async()=>({mode:'cloudflare',migrationId:'fixture-runtime-cutover-0001',epoch:1,targetReady:++gateReads>=3})});
  assert.equal((await router.doc('sh_operator_metadata/routing').get()).data().origin,'cloudflare');
  assert.equal(gateReads,3);assert.equal(now,300);assert.equal(targetReads,1);router.close();
  const pending=createOperatorStorageRouter({source,target,switchWaitMs:300,clock:()=>now,wait:async ms=>{now+=ms;},
    readGate:async()=>({mode:'cloudflare',migrationId:'fixture-runtime-cutover-0001',epoch:1,targetReady:false})});
  await assert.rejects(pending.doc('sh_operator_metadata/routing').get(),{code:'STORAGE_CUTOVER_PENDING',status:503});
  assert.equal(targetReads,1);assert.equal(pending.backend,'firestore');pending.close();
});

for(const enabled of ['true','false'])test('an existing app bearer follows real cutover without stale-source fallback with migration controls '+enabled,async t=>{
  const source=new FirestoreFake(),before=createFirestoreDeviceRegistry({firestore:source,clock:()=>NOW});
  t.after(()=>before.closeAppMessageState());
  const {device}=await enroll(before,'runtime_cutover_phone_0001');
  const cf=await cloudflareFixture(t,{documents:[...source.documents]});
  const runtime=createOperatorStorageRuntime({env:{...targetEnv,SH_ANDROID_REGISTRY_BACKEND:'firestore',SH_CLOUDFLARE_MIGRATION_ENABLED:enabled},logger:quietLogger(),
    sourceFactory:()=>({configured:true,firestore:source,close:async()=>{}}),clientFactory:()=>cf.client,
    registryFactory:options=>createFirestoreDeviceRegistry({...options,clock:()=>NOW})});
  t.after(()=>runtime.close());
  assert.equal((await runtime.deviceRegistry.authenticate(device.deviceToken)).id,device.deviceId);
  source.seed('sh_operator_metadata','storage_migration',{schema:1,mode:'cloudflare',migrationId:'fixture-runtime-cutover-0001',epoch:1,targetReady:true});
  assert.equal((await runtime.deviceRegistry.authenticate(device.deviceToken)).id,device.deviceId);
  assert.equal(runtime.backend,'cloudflare');
  await runtime.deviceRegistry.revokeDevice(device.deviceId);
  assert.equal((await before.authenticate(device.deviceToken)).id,device.deviceId,'The stale source intentionally still contains a valid bearer.');
  await assert.rejects(runtime.deviceRegistry.authenticate(device.deviceToken),{status:401});
  cf.offline(true);
  await assert.rejects(runtime.deviceRegistry.authenticate(device.deviceToken),{status:503,code:'REGISTRY_UNAVAILABLE'});
  assert.equal(runtime.backend,'cloudflare');
});
