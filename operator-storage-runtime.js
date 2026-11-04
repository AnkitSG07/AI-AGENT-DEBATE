// The public HTTP/APK contract stays unchanged. A Cloudflare cutover is explicit
// and one-way; a target outage must never resurrect stale source credentials.
import {FieldValue} from '@google-cloud/firestore';
import {createOperatorFirestoreRuntime} from './operator-firestore-runtime.js';
import {createFirestoreDeviceRegistry} from './operator-firestore-registry.js';
import {createCloudflareFirestoreClient} from './operator-cloudflare-client.js';
import {createJournaledFirestore} from './operator-storage-journal.js';
import {createOperatorStorageRouter} from './operator-storage-router.js';

export function createOperatorStorageRuntime({env=process.env,logger=console,
  sourceFactory=createOperatorFirestoreRuntime,clientFactory=createCloudflareFirestoreClient,
  registryFactory=createFirestoreDeviceRegistry,journalFactory=createJournaledFirestore}={}) {
  const backend=String(env.SH_ANDROID_REGISTRY_BACKEND||'file').trim().toLowerCase();
  // Every new-build source reader enforces the durable fence, including after
  // an operator disables the migration controls or restarts the service. The
  // flag enables administration; it can never make old credentials live again.
  const shadow=backend==='firestore';
  const migrationEnabled=env.SH_CLOUDFLARE_MIGRATION_ENABLED==='true';
  if(backend!=='cloudflare'&&!shadow)return sourceFactory({env,logger});
  let target,source,registry,store,timer,work;
  const unavailable=()=>({backend,configured:false,deviceRegistry:undefined,close:async()=>{}});
  try {
    const prefix=String(env.SH_OPERATOR_FIRESTORE_PREFIX||'sh_operator').trim();
    if(!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(prefix))throw Error('Invalid prefix');
    let migrationSource;
    if(shadow) {
      source=sourceFactory({env,logger});
      if(!source.configured||!source.firestore)throw Error('Source unavailable');
      migrationSource=journalFactory({firestore:source.firestore,collectionPrefix:prefix,
        serverTimestamp:()=>FieldValue.serverTimestamp()});
    }
    let targetConfigured=true;
    try {
      target=clientFactory({endpoint:env.SH_CLOUDFLARE_STORE_URL,secret:env.SH_CLOUDFLARE_STORE_SECRET,
        onTiming:value=>{if(value.elapsedMs>=750)logger.info?.('SH_CLOUDFLARE_STORAGE_TIMING',JSON.stringify(value));}});
    } catch(error) {
      if(!shadow)throw error;
      // An incomplete staging configuration must leave a healthy source online.
      // Continue to enforce the source fence, so a later restart can never
      // bypass an already committed Cloudflare cutover with stale credentials.
      targetConfigured=false;
      const blocked=()=>{throw Object.assign(new Error('Cloudflare storage is not configured.'),{code:'CLOUDFLARE_STORE_UNAVAILABLE',status:503});};
      target={collection:blocked,getAll:blocked,runTransaction:blocked,terminate:async()=>{}};
      logger.warn?.('Cloudflare migration target is not configured; source routing remains fenced and unchanged.');
    }
    if(shadow) {
      store=createOperatorStorageRouter({source:migrationSource,target,readGate:()=>migrationSource.readGate(),
        onSwitch:value=>logger.info?.('SH_OPERATOR_STORAGE_SWITCH',JSON.stringify({backend:value.mode,epoch:value.epoch}))});
    } else store=target;
    registry=registryFactory({firestore:store,collectionPrefix:prefix,
      revokedIds:String(env.SH_ANDROID_REVOKED_DEVICE_IDS||'').split(',').map(x=>x.trim()).filter(Boolean),
      // Never bootstrap an existing consumed invitation against a new backend.
      bootstrapEnrollmentCode:'',
      onTiming:value=>logger.info?.('SH_CALL_REGISTRY_TIMING',JSON.stringify(value))});
    const sweep=()=>work||(work=Promise.resolve().then(()=>registry.pruneExpiredRecoveries({limit:100}))
      .catch(()=>logger.warn?.('Operator credential cleanup will retry.')).finally(()=>{work=null;}));
    return {
      get backend(){return shadow?store.backend:'cloudflare';},configured:true,collectionPrefix:prefix,
      firestore:store,deviceRegistry:registry,
      // Server-internal migration dependencies. Admin HTTP must return summaries
      // only; document data and service keys never leave the server.
      migration:shadow?{source:source.firestore,journal:migrationSource,target,targetConfigured,enabled:migrationEnabled}:undefined,
      readDatabaseLocation:async()=>shadow&&store.backend==='firestore'?source.readDatabaseLocation?.()||'':'cloudflare',
      startMaintenance:()=>{if(timer)return;void sweep();timer=setInterval(sweep,5*60000);timer.unref?.();},
      close:async()=>{
        if(timer)clearInterval(timer);timer=null;if(work)await work;
        registry.closeAppMessageState?.();
        if(shadow)store.close();
        await target.terminate?.();await source?.close?.();
      }
    };
  } catch {
    logger.warn?.('Cloudflare operator storage configuration is unavailable.');
    void target?.terminate?.();void source?.close?.();return unavailable();
  }
}
