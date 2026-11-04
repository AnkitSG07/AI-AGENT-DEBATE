// Internal migration workflow. Public administration must return status() only;
// document bodies, device tokens and source snapshots never leave this module
// except through the private, authenticated target transport supplied below.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { encodeCloudflareValue, decodeCloudflareValue } from './operator-cloudflare-client.js';
import { readStorageMigrationGate, storageJournalHash } from './operator-storage-journal.js';

const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const fail = code => Object.assign(new Error('Storage migration needs verification before the current backend can be changed.'), {code,status:503,storageMigrationError:true});
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const digest = text => createHash('sha256').update(text).digest('hex');
// Separate authority from normal store RPC. Reuse the exact serialized body on
// ambiguous transport retries; only the nonce/signature change between sends.
export function createCloudflareMigrationTransport({endpoint,secret,storeSecret,fetchImpl=fetch,clock=Date.now,
  timeoutMs=10000,transportAttempts=2}={}) {
  let base;try{base=new URL(endpoint);}catch{throw TypeError('A private storage HTTPS origin is required.');}
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.port||
    !['','/'].includes(base.pathname)||['localhost','127.0.0.1','0.0.0.0'].includes(base.hostname)||
    typeof secret!=='string'||Buffer.byteLength(secret)<32||Buffer.byteLength(secret)>256||secret===storeSecret||
    typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000||
    !Number.isSafeInteger(transportAttempts)||transportAttempts<1||transportAttempts>3)throw TypeError('Invalid private storage migration transport configuration.');
  const request=async payload=>{
    if(!plain(payload)||!['status','begin','import','checksum','seal','activate'].includes(payload.op))throw fail('STORAGE_MIGRATION_REQUEST_INVALID');
    const body=JSON.stringify({...payload,version:1});if(Buffer.byteLength(body)>8*1024*1024)throw fail('STORAGE_MIGRATION_REQUEST_TOO_LARGE');
    for(let attempt=0;attempt<transportAttempts;attempt++){
      const timestamp=String(clock()),nonce=randomBytes(18).toString('base64url');
      if(!/^\d{10,16}$/.test(timestamp))throw fail('STORAGE_MIGRATION_CLOCK');
      const signature=createHmac('sha256',secret).update(timestamp+'\n'+nonce+'\n/migration\n'+digest(body)).digest('hex');
      const controller=new AbortController();let rejectDeadline;
      const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
      const timer=setTimeout(()=>{controller.abort();rejectDeadline(fail('STORAGE_MIGRATION_TRANSPORT_UNAVAILABLE'));},timeoutMs);timer.unref?.();
      try{
        const response=await Promise.race([fetchImpl(new URL('/migration',base).href,{method:'POST',redirect:'error',cache:'no-store',
          headers:{'Content-Type':'application/json','x-sh-store-timestamp':timestamp,'x-sh-store-nonce':nonce,'x-sh-store-signature':signature},body,signal:controller.signal}),deadline]);
        const reader=response.body?.getReader();if(!reader)throw fail('STORAGE_MIGRATION_TRANSPORT_UNAVAILABLE');
        const chunks=[];let bytes=0;
        try{for(;;){const next=await Promise.race([reader.read(),deadline]);if(next.done)break;bytes+=next.value.byteLength;
          if(bytes>8*1024*1024){controller.abort();throw fail('STORAGE_MIGRATION_RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(next.value));}}
        finally{if(controller.signal.aborted)void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
        let value;try{value=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}catch{throw fail('STORAGE_MIGRATION_TRANSPORT_UNAVAILABLE');}
        if(!response.ok||value?.ok!==true){const error=fail(typeof value?.code==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(value.code)?value.code:'STORAGE_MIGRATION_TARGET_REJECTED');
          error.status=[400,401,403,404,409,413,429,503].includes(response.status)?response.status:503;throw error;}
        return value;
      }catch(error){if(error?.storageMigrationError&&error.status<500)throw error;if(attempt+1===transportAttempts)throw fail('STORAGE_MIGRATION_TRANSPORT_UNAVAILABLE');}
      finally{clearTimeout(timer);}
    }
  };
  return request;
}
export function sourceStorageVersion(timestamp) {
  const seconds = timestamp?.seconds ?? timestamp?._seconds, nanos = timestamp?.nanoseconds ?? timestamp?._nanoseconds ?? timestamp?.nanos;
  if ((typeof seconds !== 'string' && !Number.isSafeInteger(seconds)) || !/^-?(?:0|[1-9][0-9]*)$/.test(String(seconds)) ||
      !Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1000000000) throw fail('STORAGE_SOURCE_VERSION_INVALID');
  return {seconds:String(seconds),nanos};
}
export function storageManifestSummary(documents) {
  const hash=createHash('sha256');
  const entries=[...documents].sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let previous;
  for(const row of entries) {
    if(typeof row.path!=='string'||row.path===previous||!plain(row.data))throw fail('STORAGE_MANIFEST_INVALID');
    hash.update(row.path+'\n'+canonical(row.data)+'\n');previous=row.path;
  }
  return {count:entries.length,checksum:hash.digest('hex')};
}
export function validateStorageIdentityBindings(documents,prefix='sh_operator') {
  const rows=new Map(documents.map(row=>[row.path,decodeCloudflareValue(row.data)]));
  let devices=0,credentials=0,sessions=0,archiveChunks=0;
  for(const [path,row]of rows){const [collection,id]=path.split('/');
    if(collection===`${prefix}_devices`){if(row.schema!==1||row.id!==id)throw fail('STORAGE_DEVICE_BINDING_MISMATCH');devices++;}
    if(collection===`${prefix}_credentials`&&row.active===true){const device=rows.get(`${prefix}_devices/${row.deviceId}`);
      if(!device||device.tokenHash!==id||device.credentialGeneration!==row.generation)throw fail('STORAGE_CREDENTIAL_BINDING_MISMATCH');credentials++;}
    const kind=collection.startsWith(`${prefix}_media_`)?collection.slice(`${prefix}_media_`.length):'';
    if(['calls','sessions','events','reservations'].includes(kind)){
      if(row.schema!==1||row.key!==`media_${kind}/${id}`||!plain(row.data))throw fail('STORAGE_MEDIA_BINDING_MISMATCH');
      if(['calls','sessions','events'].includes(kind)&&(typeof row.data.id!=='string'||digest(row.data.id)!==id))throw fail('STORAGE_MEDIA_BINDING_MISMATCH');
      if(kind==='sessions')sessions++;
      if(kind==='reservations'&&row.data.deviceId&&(typeof row.data.deviceId!=='string'||digest(row.data.deviceId)!==id))throw fail('STORAGE_RESERVATION_BINDING_MISMATCH');
    }
    if(collection===`${prefix}_reports_archive_chunks`){if(!(row.bytes instanceof Uint8Array)||digest(row.bytes)!==row.sha256)throw fail('STORAGE_ARCHIVE_CHUNK_MISMATCH');archiveChunks++;}
  }
  return {devices,credentials,sessions,archiveChunks};
}

export function createStorageMigrationManager({firestore,collectionPrefix='sh_operator',serverTimestamp,
  targetMigration,documentIdField='__name__',clock=Date.now,maxDocuments=20000,maxBytes=64*1024*1024,
  maxDurationMs=10*60000,pageSize=50,maxJournalPasses=1000,assertNoActiveCalls,classifyQuietManifest,
  maxQuietProofRows=100,maxQuietProofBytes=128*1024,maxQuietRetries=3,onActivated=async()=>{},beforeFence=()=>()=>{}}={}) {
  if(!firestore?.collection||!firestore?.runTransaction||typeof firestore.listCollections!=='function'||
    typeof serverTimestamp!=='function'||typeof targetMigration!=='function'||typeof beforeFence!=='function'||
    !/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(collectionPrefix)||
    !Number.isInteger(maxDocuments)||maxDocuments<1||maxDocuments>100000||
    !Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>256*1024*1024||
    !Number.isInteger(pageSize)||pageSize<1||pageSize>100||
    !Number.isInteger(maxJournalPasses)||maxJournalPasses<1||maxJournalPasses>4000||
    !Number.isInteger(maxQuietProofRows)||maxQuietProofRows<1||maxQuietProofRows>500||
    !Number.isInteger(maxQuietProofBytes)||maxQuietProofBytes<1024||maxQuietProofBytes>512*1024||
    !Number.isInteger(maxQuietRetries)||maxQuietRetries<1||maxQuietRetries>10||
    classifyQuietManifest!==undefined&&typeof classifyQuietManifest!=='function'||
    !Number.isInteger(maxDurationMs)||maxDurationMs<1000||maxDurationMs>30*60000)throw TypeError('Invalid storage migration configuration.');
  const gateRef=firestore.collection(`${collectionPrefix}_metadata`).doc('storage_migration');
  const journal=firestore.collection(`${collectionPrefix}_migration_journal`);
  const gatePath=gateRef.path,journalPath=journal.path;
  let running=null,lastError='';
  const scoped=path=>typeof path==='string'&&path.split('/').length===2&&path.split('/')[0].startsWith(collectionPrefix+'_')&&path!==gatePath&&path.split('/')[0]!==journalPath;
  const now=()=>{const t=clock();if(!Number.isSafeInteger(t)||t<=0)throw fail('STORAGE_MIGRATION_CLOCK');return t;};
  const target=async body=>{const result=await targetMigration(body);if(!result?.ok)throw fail('STORAGE_TARGET_REJECTED');return result;};
  const safeGate=gate=>({mode:gate.mode,migrationId:gate.migrationId,epoch:gate.epoch,phase:gate.phase||gate.mode,
    targetReady:gate.targetReady===true,snapshotComplete:gate.snapshotComplete===true,copied:Number(gate.copied||0),replayed:Number(gate.replayed||0),
    verifiedCount:Number(gate.verifiedCount||0),verifiedChecksum:gate.verifiedChecksum||'',lastError,running:!!running});
  const readGate=async()=>readStorageMigrationGate(await gateRef.get());
  async function updateGate(expected,patch) {
    return firestore.runTransaction(async tx=>{const current=readStorageMigrationGate(await tx.get(gateRef));
      if(current.migrationId!==expected.migrationId||current.epoch!==expected.epoch||current.mode!==expected.mode)throw fail('STORAGE_MIGRATION_CHANGED');
      const next={...current,...patch,updatedAtMs:now()};tx.set(gateRef,next);return next;});
  }
  async function exclusive(operation) {
    if(running)throw fail('STORAGE_MIGRATION_BUSY');
    const promise=Promise.resolve().then(operation);running=promise;lastError='';
    try{return await promise;}catch(error){lastError=error?.storageMigrationError?String(error.code):'STORAGE_MIGRATION_FAILED';throw error;}
    finally{running=null;}
  }
  async function prepare() {
    return exclusive(async()=>{
      const existing=await readGate();
      if(existing.mode==='cloudflare')return safeGate(existing);
      const migrationId=existing.mode==='shadow'?existing.migrationId:randomUUID().replaceAll('-','');
      await target({op:'begin',migrationId});
      const gate=await firestore.runTransaction(async tx=>{const current=readStorageMigrationGate(await tx.get(gateRef));
        if(current.mode==='cloudflare'||current.mode==='shadow'&&current.migrationId!==migrationId)throw fail('STORAGE_MIGRATION_CHANGED');
        if(current.mode==='shadow')return current;
        const next={schema:1,mode:'shadow',migrationId,epoch:current.epoch+1,phase:'copying',targetReady:false,
          createdAtMs:now(),updatedAtMs:now(),startedAt:serverTimestamp()};tx.set(gateRef,next);return next;});
      return safeGate(gate);
    });
  }
  async function scanNamespace() {
    const started=now(),documents=[];let bytes=0;
    const guard=()=>{if(now()-started>maxDurationMs)throw fail('STORAGE_MIGRATION_TIME_LIMIT');};
    const collections=(await firestore.listCollections()).filter(ref=>ref.path.startsWith(collectionPrefix+'_')&&ref.path!==journalPath).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    if(collections.length>500)throw fail('STORAGE_MIGRATION_COLLECTION_LIMIT');
    for(const collection of collections) {
      if(collection.path.includes('/'))throw fail('STORAGE_MIGRATION_SUBCOLLECTION_UNSUPPORTED');
      let cursor=null;
      for(;;){guard();let query=collection.orderBy(documentIdField).limit(pageSize);if(cursor)query=query.startAfter(cursor);
        const page=await query.get();
        for(const doc of page.docs){if(doc.ref.path===gatePath)continue;if(!scoped(doc.ref.path))throw fail('STORAGE_MIGRATION_PATH_INVALID');
          // Subcollections cannot silently disappear during a top-level import.
          if(typeof doc.ref.listCollections==='function'&&(await doc.ref.listCollections()).length)throw fail('STORAGE_MIGRATION_SUBCOLLECTION_UNSUPPORTED');
          const row={path:doc.ref.path,data:encodeCloudflareValue(doc.data()),sourceVersion:sourceStorageVersion(doc.updateTime)};
          bytes+=Buffer.byteLength(JSON.stringify(row));documents.push(row);
          if(documents.length>maxDocuments||bytes>maxBytes)throw fail('STORAGE_MIGRATION_SIZE_LIMIT');}
        if(page.docs.length<pageSize)break;cursor=page.docs.at(-1);
      }
    }
    guard();return documents;
  }
  async function importDocuments(migrationId,documents,label) {
    let chunk=[],bytes=0;
    const flush=async()=>{if(!chunk.length)return;const requestId=`${label}_${digest(canonical(chunk))}`;
      await target({op:'import',migrationId,requestId,documents:chunk});chunk=[];bytes=0;};
    for(const row of documents){const size=Buffer.byteLength(JSON.stringify(row));if(size>1024*1024)throw fail('STORAGE_MIGRATION_DOCUMENT_LIMIT');
      if(chunk.length>=pageSize||bytes+size>7*1024*1024)await flush();chunk.push(row);bytes+=size;}
    await flush();
  }
  async function copySnapshot() {
    return exclusive(async()=>{const gate=await readGate();if(gate.mode!=='shadow')throw fail('STORAGE_SOURCE_NOT_SHADOWING');
      // A live scan can span a credential rotation; verify bindings only after
      // the atomic journal has brought every scanned row to one consistent cut.
      const documents=await scanNamespace();await importDocuments(gate.migrationId,documents,'snapshot');
      const next=await updateGate(gate,{phase:'replaying',copied:documents.length,snapshotComplete:true});return safeGate(next);});
  }
  function versionedManifest(documents) {
    const rows=new Map(documents.map(row=>[row.path,row]));
    const apply=documents=>{for(const row of documents){const previous=rows.get(row.path);
      const compare=previous?BigInt(row.sourceVersion.seconds)*1000000000n+BigInt(row.sourceVersion.nanos)-
        (BigInt(previous.sourceVersion.seconds)*1000000000n+BigInt(previous.sourceVersion.nanos)):1n;
      if(compare>0n)rows.set(row.path,row);
      else if(compare===0n&&canonical(row)!==canonical(previous))throw fail('STORAGE_SOURCE_VERSION_MISMATCH');}};
    return {apply,live:()=>[...rows.values()].filter(row=>row.deleted!==true)};
  }
  const versionCompare=(left,right)=>BigInt(left.seconds)*1000000000n+BigInt(left.nanos)-
    (BigInt(right.seconds)*1000000000n+BigInt(right.nanos));
  function proofRecord(doc) {
    const row=doc.data();
    if(row?.schema!==1||row.eventId!==doc.id||!validId(row.migrationId)||!Number.isSafeInteger(row.epoch)||row.epoch<1||
      typeof row.hash!=='string'||!/^[a-f0-9]{64}$/.test(row.hash))throw fail('STORAGE_JOURNAL_INVALID');
    return {id:doc.id,migrationId:row.migrationId,epoch:row.epoch,hash:row.hash,committedAt:sourceStorageVersion(row.committedAt)};
  }
  function boundProofRecords(records) {
    if(records.length>maxQuietProofRows||Buffer.byteLength(canonical(records))>maxQuietProofBytes)throw fail('STORAGE_QUIET_PROOF_LIMIT');
    return records;
  }
  async function verifyQuietProof(tx,proof) {
    if(!proof?.readTime||!Array.isArray(proof.records))throw fail('STORAGE_QUIET_PROOF_REQUIRED');
    sourceStorageVersion(proof.readTime);boundProofRecords(proof.records);
    // The replay readTime is a server snapshot boundary. A metadata projection
    // keeps this final transaction independent of retained media/history size.
    const query=journal.where('committedAt','>=',proof.readTime).orderBy('committedAt','asc').orderBy(documentIdField,'asc')
      .select('schema','eventId','migrationId','epoch','hash','committedAt').limit(maxQuietProofRows+1);
    const found=await tx.get(query);
    if(!Array.isArray(found?.docs))throw fail('STORAGE_QUIET_PROOF_INVALID');
    const records=boundProofRecords(found.docs.map(proofRecord));
    if(canonical(records)!==canonical(proof.records))throw fail('STORAGE_QUIET_PROOF_CHANGED');
  }
  async function replayInternal(gate,{manifest,since,quietProof=false}={}) {
    const started=now();let events=0,lastCursor=null,lastCommittedAt=since,latestVersion=null,boundaryRecords=[];
    // Starting at the beginning is deliberate: repeated copies/replays are
    // monotonic at the target and cannot miss same-timestamp events on restart.
    for(let pass=0;pass<maxJournalPasses;pass++) {
      // Single-field ordering uses the ordinary Firestore index. A new composite
      // index must not become a hidden deployment prerequisite for migration.
      let query=journal.orderBy('committedAt','asc').orderBy(documentIdField,'asc').limit(pageSize);
      // Include the entire boundary timestamp: separate commits can share one
      // timestamp, so a document-ID cursor alone is not a safe final checkpoint.
      if(since)query=query.where('committedAt','>=',since);
      if(lastCursor)query=query.startAfter(lastCursor);
      const page=await query.get();
      for(const doc of page.docs){const event=doc.data();
        if(quietProof){const record=proofRecord(doc),compare=latestVersion?versionCompare(record.committedAt,latestVersion):1n;
          if(compare>0n){latestVersion=record.committedAt;boundaryRecords=[];}
          if(compare>=0n)boundaryRecords.push(record);}
        if(event?.migrationId!==gate.migrationId)continue;
        if(event?.schema!==1||event.eventId!==doc.id||event.migrationId!==gate.migrationId||event.epoch!==gate.epoch||
          !Array.isArray(event.mutations)||event.mutations.length>450||event.hash!==storageJournalHash(event.mutations))throw fail('STORAGE_JOURNAL_INVALID');
        const sourceVersion=sourceStorageVersion(event.committedAt);
        const documents=event.mutations.map(mutation=>{if(!scoped(mutation.path)||
          (mutation.deleted!==true&&!plain(mutation.value))||mutation.deleted===true&&Object.hasOwn(mutation,'value'))throw fail('STORAGE_JOURNAL_INVALID');
          return mutation.deleted?{path:mutation.path,deleted:true,sourceVersion}:{path:mutation.path,data:mutation.value,sourceVersion};});
        await target({op:'import',migrationId:gate.migrationId,requestId:`journal_${event.eventId}`,documents});
        manifest?.apply(documents);lastCommittedAt=event.committedAt;events++;}
      if(page.docs.length<pageSize){let proof;
        if(quietProof){const readVersion=sourceStorageVersion(page.readTime);
          if(latestVersion&&versionCompare(latestVersion,readVersion)>0n)throw fail('STORAGE_QUIET_READ_TIME_INVALID');
          proof={migrationId:gate.migrationId,epoch:gate.epoch,readTime:page.readTime,
            records:boundProofRecords(latestVersion&&versionCompare(latestVersion,readVersion)===0n?boundaryRecords:[])};}
        return {events,drained:true,lastCommittedAt,proof};}lastCursor=page.docs.at(-1);
      if(now()-started>maxDurationMs)throw fail('STORAGE_MIGRATION_TIME_LIMIT');
    }
    throw fail('STORAGE_JOURNAL_PASS_LIMIT');
  }
  async function replay() {
    return exclusive(async()=>{const gate=await readGate();if(!['shadow','cloudflare'].includes(gate.mode))throw fail('STORAGE_SOURCE_NOT_SHADOWING');
      const result=await replayInternal(gate);const next=await updateGate(gate,{replayed:result.events,phase:gate.mode==='shadow'?'ready_to_verify':'fenced'});return safeGate(next);});
  }
  async function fenceInternal(proof) {
      if(!proof)throw fail('STORAGE_QUIET_PROOF_REQUIRED');
      if(typeof assertNoActiveCalls!=='function')throw fail('STORAGE_QUIET_POINT_CHECK_REQUIRED');
      const existing=await readGate();if(existing.mode==='cloudflare')return safeGate(existing);
      const gate=await firestore.runTransaction(async tx=>{const current=readStorageMigrationGate(await tx.get(gateRef));
        if(current.mode!=='shadow'||current.snapshotComplete!==true)throw fail('STORAGE_SNAPSHOT_REQUIRED');
        if(current.migrationId!==proof.migrationId||current.epoch!==proof.epoch)throw fail('STORAGE_MIGRATION_CHANGED');
        if(await assertNoActiveCalls(tx)!==true)throw fail('STORAGE_CALLS_STILL_ACTIVE');
        if(proof)await verifyQuietProof(tx,proof);
        if(proof&&await assertNoActiveCalls(tx)!==true)throw fail('STORAGE_CALLS_STILL_ACTIVE');
        const next={...current,mode:'cloudflare',phase:'fenced',targetReady:false,fencedAt:serverTimestamp(),updatedAtMs:now()};tx.set(gateRef,next);return next;});
      return safeGate(gate);
  }
  async function completeCutoverInternal({manifest,since}={}) {
      let gate=await readGate();if(gate.mode!=='cloudflare')throw fail('STORAGE_SOURCE_NOT_FENCED');
      if(gate.targetReady){await onActivated();return safeGate(gate);}
      const remote=await target({op:'status'});
      if(remote.mode?.state==='active'||remote.migration?.state==='sealed') {
        if(remote.migration?.id!==gate.migrationId||!Number.isSafeInteger(gate.verifiedCount)||!gate.verifiedChecksum||
          remote.migration.count!==gate.verifiedCount||remote.migration.checksum!==gate.verifiedChecksum)throw fail('STORAGE_TARGET_MANIFEST_MISMATCH');
        if(remote.mode?.state!=='active')await target({op:'activate',migrationId:gate.migrationId,expectedCount:gate.verifiedCount,expectedChecksum:gate.verifiedChecksum});
        gate=await updateGate(gate,{phase:'active',targetReady:true,activatedAtMs:now()});await onActivated();return safeGate(gate);
      }
      // All source app writers are fenced. Replay every known journal entry,
      // then compare a fresh exact source manifest, including deletion results.
      await replayInternal(gate,{manifest,since});
      const source=manifest?manifest.live():await scanNamespace();validateStorageIdentityBindings(source,collectionPrefix);const summary=storageManifestSummary(source);
      const current=await target({op:'checksum',migrationId:gate.migrationId});
      if(current.count!==summary.count||current.checksum!==summary.checksum)throw fail('STORAGE_TARGET_MANIFEST_MISMATCH');
      gate=await updateGate(gate,{phase:'verified',verifiedCount:summary.count,verifiedChecksum:summary.checksum});
      try{
        await target({op:'seal',migrationId:gate.migrationId,expectedCount:summary.count,expectedChecksum:summary.checksum});
        await target({op:'activate',migrationId:gate.migrationId,expectedCount:summary.count,expectedChecksum:summary.checksum});
      }catch(error){
        // A committed seal/activate can lose its HTTP response. Observe durable
        // target state once and finish the same verified transition immediately;
        // never reimport over live writes or ask the app to use stale source.
        let observed;try{observed=await target({op:'status'});}catch{throw error;}
        if(observed.migration?.id!==gate.migrationId||observed.migration.count!==summary.count||
          observed.migration.checksum!==summary.checksum||
          !(observed.mode?.state==='active'||observed.migration.state==='sealed'))throw error;
        if(observed.mode?.state!=='active')await target({op:'activate',migrationId:gate.migrationId,expectedCount:summary.count,expectedChecksum:summary.checksum});
      }
      gate=await updateGate(gate,{phase:'active',targetReady:true,activatedAtMs:now()});await onActivated();return safeGate(gate);
  }
  async function cutover() {
    return exclusive(async()=>{
      const gate=await readGate();
      if(gate.mode==='cloudflare')return completeCutoverInternal();
      if(gate.mode!=='shadow'||gate.snapshotComplete!==true)throw fail('STORAGE_SNAPSHOT_REQUIRED');
      if(typeof classifyQuietManifest!=='function')throw fail('STORAGE_QUIET_PROOF_REQUIRED');
      // Expensive inventory and integrity work runs while the existing app is
      // fully usable. Only the final bounded journal tail is inside the fence.
      const manifest=versionedManifest(await scanNamespace());
      let since;
      for(let attempt=0;attempt<maxQuietRetries;attempt++){
        const replay=await replayInternal(gate,{manifest,since,quietProof:true});
        validateStorageIdentityBindings(manifest.live(),collectionPrefix);
        // Full retained history is classified while source calls/messages keep
        // working. Only an exact, bounded recent journal proof enters the fence.
        const quiet=classifyQuietManifest(manifest.live(),{collectionPrefix,migrationId:gate.migrationId,epoch:gate.epoch});
        if(quiet!==true)throw fail(quiet===false?'STORAGE_CALLS_STILL_ACTIVE':'STORAGE_QUIET_PROOF_INVALID');
        const summary=storageManifestSummary(manifest.live());
        const current=await target({op:'checksum',migrationId:gate.migrationId});
        if(current.count!==summary.count||current.checksum!==summary.checksum)throw fail('STORAGE_TARGET_MANIFEST_MISMATCH');
        const release=await beforeFence();
        if(typeof release!=='function')throw fail('STORAGE_ADMISSION_GUARD_INVALID');
        try{await fenceInternal(replay.proof);return await completeCutoverInternal({manifest,since:replay.proof.readTime});}
        catch(error){if(!['STORAGE_QUIET_PROOF_CHANGED','STORAGE_QUIET_PROOF_LIMIT'].includes(error?.code)||attempt+1===maxQuietRetries)throw error;
          since=replay.proof.readTime;}
        finally{try{await release();}catch{/* durable fence remains authoritative */}}
      }
    });
  }
  return {prepare,copySnapshot,replay,cutover,status:async()=>safeGate(await readGate()),
    // Private internal diagnostics for exhaustive isolated tests, never routes.
    scanNamespace};
}
