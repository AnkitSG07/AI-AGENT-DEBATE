// Server-only transactional document transport. Domain validation remains in
// the existing registry, call and reporting adapters. No credential is cached.
import {createHash, createHmac, randomBytes, randomUUID} from 'node:crypto';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENTS = 1000;
const MAX_WRITES = 450;
const BYTES = '__sh_store_bytes_v1', OBJECT = '__sh_store_object_v1', TIMESTAMP = '__sh_store_timestamp_v1';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => value === undefined ? undefined : decodeCloudflareValue(encodeCloudflareValue(value));
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';

export class CloudflareStoreError extends Error {
  constructor(code, message = 'Durable operator storage is temporarily unavailable.', status = 503, outcomeUnknown = false) {
    super(message); this.name = 'CloudflareStoreError'; this.code = code;
    this.status = status; this.statusCode = status; this.outcomeUnknown = outcomeUnknown;
  }
}
const invalid = message => new CloudflareStoreError('INVALID_STORE_INPUT', message, 400);
const unavailable = unknown => new CloudflareStoreError('CLOUDFLARE_STORE_UNAVAILABLE', undefined, 503, unknown);
const conflict = () => new CloudflareStoreError('TRANSACTION_CONFLICT', 'The operator storage transaction changed.', 409);
function requireValue(condition, message) { if (!condition) throw invalid(message); }
function collectionPath(value) {
  requireValue(typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,120}$/.test(value), 'An exact operator collection is required.');
  return value;
}
function documentId(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\/\u0000-\u001f\u007f]/.test(value), 'An exact document ID is required.');
  return value;
}
function fieldPath(value) {
  requireValue(typeof value === 'string' && /^(?:[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value), 'A supported field path is required.');
  return value;
}
function fieldValue(value, path) {
  for (const part of path.split('.')) { if (!plain(value) || !own(value, part)) return undefined; value = value[part]; }
  return value;
}

export class CloudflareTimestamp {
  constructor(seconds,nanoseconds) {
    requireValue(Number.isSafeInteger(seconds)&&seconds>=-62135596800&&seconds<=253402300799&&
      Number.isSafeInteger(nanoseconds)&&nanoseconds>=0&&nanoseconds<=999999999,'Invalid stored timestamp.');
    this.seconds=seconds;this.nanoseconds=nanoseconds;Object.freeze(this);
  }
  toMillis(){return this.seconds*1000+this.nanoseconds/1000000;}
  toDate(){return new Date(this.toMillis());}
  isEqual(other){return other?.seconds===this.seconds&&other?.nanoseconds===this.nanoseconds;}
}

// Firestore byte fields occur in verified report archives. Preserve them rather
// than accidentally serializing Buffer.toJSON() into an ordinary JSON object.
export function encodeCloudflareValue(value, depth = 0) {
  requireValue(depth <= 40, 'The stored record is too deeply nested.');
  if (value instanceof Uint8Array) return {[BYTES]: Buffer.from(value).toString('base64')};
  if(value instanceof Date){
    const ms=value.getTime();requireValue(Number.isFinite(ms),'Invalid stored timestamp.');
    const seconds=Math.floor(ms/1000);return encodeCloudflareValue(new CloudflareTimestamp(seconds,(ms-seconds*1000)*1000000),depth);
  }
  if(value instanceof CloudflareTimestamp || value?.constructor?.name==='Timestamp'&&typeof value.toDate==='function'){
    const timestamp=new CloudflareTimestamp(value.seconds,value.nanoseconds);
    return {[TIMESTAMP]:{seconds:String(timestamp.seconds),nanos:timestamp.nanoseconds}};
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => encodeCloudflareValue(item, depth + 1));
  requireValue(plain(value), 'Stored records accept finite JSON values and byte arrays only.');
  const entries = Object.entries(value).map(([key, item]) => [key, encodeCloudflareValue(item, depth + 1)]);
  if (entries.length === 1 && [BYTES, OBJECT, TIMESTAMP].includes(entries[0][0])) return {[OBJECT]: entries};
  return Object.fromEntries(entries);
}
export function decodeCloudflareValue(value, depth = 0) {
  requireValue(depth <= 40, 'The stored record is too deeply nested.');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => decodeCloudflareValue(item, depth + 1));
  if (Object.keys(value).length === 1 && own(value, BYTES)) {
    requireValue(typeof value[BYTES] === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value[BYTES]), 'Invalid stored byte encoding.');
    return new Uint8Array(Buffer.from(value[BYTES], 'base64'));
  }
  if(Object.keys(value).length===1&&own(value,TIMESTAMP)){
    const timestamp=value[TIMESTAMP];
    requireValue(plain(timestamp)&&typeof timestamp.seconds==='string'&&/^-?\d{1,12}$/.test(timestamp.seconds)&&Object.keys(timestamp).every(key=>['seconds','nanos'].includes(key)),'Invalid stored timestamp.');
    return new CloudflareTimestamp(Number(timestamp.seconds),timestamp.nanos);
  }
  if (Object.keys(value).length === 1 && own(value, OBJECT)) {
    requireValue(Array.isArray(value[OBJECT]) && value[OBJECT].every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string'), 'Invalid stored object encoding.');
    return Object.fromEntries(value[OBJECT].map(([key, item]) => [key, decodeCloudflareValue(item, depth + 1)]));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeCloudflareValue(item, depth + 1)]));
}
function mergeObjects(before, patch) {
  const entries = new Map(Object.entries(plain(before) ? before : {}));
  for (const [key, value] of Object.entries(patch)) entries.set(key, plain(value) ? mergeObjects(entries.get(key), value) : clone(value));
  return Object.fromEntries(entries);
}
function updateObject(before, patch) {
  let next = clone(before);
  for (const [path, value] of Object.entries(patch)) {
    fieldPath(path);
    const put = (target, parts) => {
      const [key, ...rest] = parts;
      return Object.fromEntries([...Object.entries(plain(target) ? target : {}).filter(([name]) => name !== key),
        [key, rest.length ? put(plain(target) && own(target, key) ? target[key] : undefined, rest) : clone(value)]]);
    };
    next = put(next, path.split('.'));
  }
  return next;
}
function orderedQuery(query) {
  return query.orderBy.length ? query : {...query,orderBy:[...new Set(query.where.filter(clause=>clause.op!=='==').map(clause=>clause.field))].sort().map(field=>({field,direction:'asc'}))};
}

class DocumentSnapshot {
  constructor(ref, row) {
    if (!row || row.path !== ref.path || typeof row.exists !== 'boolean' || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
        row.exists && (row.revision < 1 || !plain(row.data))) throw unavailable();
    this.ref = ref; this.id = ref.id; this.exists = row.exists;
    this._revision = row.revision;
    try{this._value = row.exists ? decodeCloudflareValue(row.data) : undefined;}catch{throw unavailable();}
  }
  data() { return this.exists ? clone(this._value) : undefined; }
  get(field) { return this.exists ? clone(fieldValue(this._value, fieldPath(field))) : undefined; }
}
class QuerySnapshot {
  constructor(query, docs, guard) { this.query = query; this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; this._guard = guard; }
  forEach(callback, thisArg) { this.docs.forEach(callback, thisArg); }
}
class Query {
  constructor(client, query) { this._client = client; this._query = clone(query); }
  where(field, op, value) {
    fieldPath(field); requireValue(['==','<','<=','>','>='].includes(op), 'Unsupported query comparison.');
    return new Query(this._client, {...this._query, where:[...this._query.where, {field,op,value:encodeCloudflareValue(value)}]});
  }
  orderBy(field, direction = 'asc') {
    fieldPath(field); requireValue(['asc','desc'].includes(direction), 'Unsupported ordering.');
    return new Query(this._client, {...this._query, orderBy:[...this._query.orderBy, {field,direction}]});
  }
  limit(limit) {
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_DOCUMENTS, 'Query limit must be between 1 and 1000.');
    return new Query(this._client, {...this._query, limit});
  }
  startAfter(snapshot) {
    requireValue(snapshot instanceof DocumentSnapshot && snapshot.exists && snapshot.ref._client === this._client &&
      snapshot.ref.parent.path === this._query.collection, 'A snapshot from this collection is required.');
    const values = orderedQuery(this._query).orderBy.map(order => fieldValue(snapshot.data(), order.field));
    requireValue(values.every(value => value !== undefined), 'The cursor is missing an ordered field.');
    return new Query(this._client, {...this._query, startAfter:{path:snapshot.ref.path,values:encodeCloudflareValue(values)}});
  }
  get() { return this._client._query(this); }
}
class CollectionReference extends Query {
  constructor(client, path) { super(client,{collection:path,where:[],orderBy:[]}); this.path=path; this.id=path; }
  doc(id) { return new DocumentReference(this._client,this,documentId(id)); }
}
class DocumentReference {
  constructor(client, parent, id) { this._client=client; this.parent=parent; this.id=id; this.path=parent.path+'/'+id; }
  get() { return this._client.getAll(this).then(rows=>rows[0]); }
  set(data, options) { return this._client.runTransaction(tx=>{tx.set(this,data,options);}); }
  create(data) { return this._client.runTransaction(tx=>{tx.create(this,data);}); }
  update(data) { return this._client.runTransaction(tx=>{tx.update(this,data);}); }
  delete() { return this._client.runTransaction(tx=>{tx.delete(this);}); }
}
class Transaction {
  constructor(client, readOnly) { this.client=client; this.readOnly=readOnly; this.reads=new Map(); this.queries=[]; this.writes=[]; this.closed=false; this.remoteReads=0; }
  ref(ref) { requireValue(ref instanceof DocumentReference && ref._client===this.client,'A document from this store is required.'); return ref; }
  remember(snapshot) {
    const before=this.reads.get(snapshot.ref.path);
    if(before && before._revision!==snapshot._revision) throw conflict();
    this.reads.set(snapshot.ref.path,snapshot); return snapshot;
  }
  async get(ref) {
    requireValue(!this.closed,'Transaction is already closed.');
    if(ref instanceof Query) {
      requireValue(ref._client===this.client,'A query from this store is required.');
      this.remoteReads++; const result=await this.client._query(ref); this.queries.push(result._guard);
      result.docs.forEach(row=>this.remember(row)); return result;
    }
    return (await this.getAll(ref))[0];
  }
  async getAll(...refs) {
    requireValue(!this.closed && refs.length<=MAX_DOCUMENTS,'Transaction reads must be bounded.'); refs.forEach(ref=>this.ref(ref));
    const missing=[...new Map(refs.filter(ref=>!this.reads.has(ref.path)).map(ref=>[ref.path,ref])).values()];
    if(missing.length) { this.remoteReads++; (await this.client.getAll(...missing)).forEach(row=>this.remember(row)); }
    return refs.map(ref=>this.reads.get(ref.path));
  }
  write(type, ref, data, options) {
    requireValue(!this.closed && !this.readOnly,'Writes are not allowed in this transaction.'); this.ref(ref);
    requireValue(this.writes.length<MAX_WRITES,'Too many writes in one transaction.');
    if(type!=='delete') { requireValue(plain(data),'Stored documents must be plain objects.'); encodeCloudflareValue(data); }
    if(options!==undefined) requireValue(plain(options) && Object.keys(options).every(key=>key==='merge') && typeof options.merge==='boolean','Only the merge set option is supported.');
    this.writes.push({type,ref,data:clone(data),merge:options?.merge===true}); return this;
  }
  set(ref,data,options) { return this.write('set',ref,data,options); }
  create(ref,data) { return this.write('create',ref,data); }
  update(ref,data) { return this.write('update',ref,data); }
  delete(ref) { return this.write('delete',ref); }
  async prepare() {
    const needing=this.writes.filter(w=>w.type==='update'||w.merge).map(w=>w.ref);
    if(needing.length) await this.getAll(...needing);
    const values=new Map([...this.reads].map(([path,snapshot])=>[path,snapshot.data()]));
    const writes=[];
    for(const write of this.writes) {
      const path=write.ref.path; let value=write.data, type=write.type;
      if(type==='update') {
        if(values.get(path)===undefined) throw new CloudflareStoreError('NOT_FOUND','The document no longer exists.',404);
        value=updateObject(values.get(path),value); type='set';
      } else if(write.merge) value=mergeObjects(values.get(path),value);
      values.set(path,type==='delete'?undefined:value);
      writes.push({type,path,...(type==='delete'?{}:{data:encodeCloudflareValue(value)})});
    }
    this.closed=true;
    return {reads:[...this.reads].map(([path,snapshot])=>({path,revision:snapshot._revision})),queries:this.queries,writes};
  }
}

export function createCloudflareFirestoreClient({endpoint,secret,fetchImpl=fetch,clock=Date.now,
  timeoutMs=5000,maxAttempts=5,transportAttempts=2,onTiming=()=>{}}={}) {
  let base;
  try { base=new URL(endpoint); } catch { throw invalid('A private Cloudflare store HTTPS endpoint is required.'); }
  requireValue(base.protocol==='https:' && !base.username && !base.password && !base.search && !base.hash && !base.port &&
    (base.pathname==='/'||base.pathname==='') && !['localhost','127.0.0.1','0.0.0.0'].includes(base.hostname), 'A private Cloudflare store HTTPS origin is required.');
  requireValue(typeof secret==='string' && Buffer.byteLength(secret)>=32 && Buffer.byteLength(secret)<=256,'A server-only store secret of at least 32 bytes is required.');
  requireValue(Number.isSafeInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=30000&&Number.isSafeInteger(maxAttempts)&&maxAttempts>=1&&maxAttempts<=10&&
    Number.isSafeInteger(transportAttempts)&&transportAttempts>=1&&transportAttempts<=3,'Invalid store request bounds.');
  const controllers=new Set(); let closed=false;
  const refPath=path=>{const parts=typeof path==='string'?path.split('/'):[];requireValue(parts.length===2,'Invalid stored document path.');return client.collection(parts[0]).doc(parts[1]);};
  async function rpc(payload) {
    if(closed) throw unavailable();
    const body=JSON.stringify({version:1,...payload}); requireValue(Buffer.byteLength(body)<=MAX_BYTES,'The store request is too large.');
    const started=clock();
    for(let attempt=0;attempt<transportAttempts;attempt++) {
      const timestamp=String(clock()),nonce=randomBytes(18).toString('base64url');
      const signature=createHmac('sha256',secret).update(timestamp+'\n'+nonce+'\n/rpc\n'+hash(body)).digest('hex');
      const controller=new AbortController();controllers.add(controller);
      let timeoutReject;
      const deadline=new Promise((_,reject)=>{timeoutReject=reject;});
      controller.signal.addEventListener('abort',()=>timeoutReject(unavailable(payload.op==='commit')),{once:true});
      const timer=setTimeout(()=>{controller.abort();timeoutReject(unavailable(payload.op==='commit'));},timeoutMs);timer.unref?.();
      try {
        const response=await Promise.race([fetchImpl(new URL('/rpc',base).href,{method:'POST',redirect:'error',cache:'no-store',
          headers:{'Content-Type':'application/json','x-sh-store-timestamp':timestamp,'x-sh-store-nonce':nonce,'x-sh-store-signature':signature},
          body,signal:controller.signal}),deadline]);
        const reader=response.body?.getReader();if(!reader)throw unavailable(payload.op==='commit');
        const chunks=[];let bytes=0;
        try {
          for(;;){const item=await Promise.race([reader.read(),deadline]);if(item.done)break;bytes+=item.value.byteLength;
            if(bytes>MAX_BYTES){controller.abort();void reader.cancel().catch(()=>{});throw unavailable(payload.op==='commit');}chunks.push(item.value);}
        } finally {if(controller.signal.aborted)void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
        const content=Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),bytes).toString('utf8');
        let value;try{value=JSON.parse(content);}catch{throw unavailable(payload.op==='commit');}
        if(!response.ok || value?.ok!==true) {
          const safeCode=typeof value?.code==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(value.code)?value.code:'CLOUDFLARE_STORE_UNAVAILABLE';
          const status=[400,401,403,404,409,413,429,503].includes(response.status)?response.status:503;
          throw new CloudflareStoreError(safeCode,undefined,status,payload.op==='commit'&&status>=500);
        }
        try{onTiming({operation:payload.op,elapsedMs:Math.max(0,clock()-started),ok:true});}catch{}
        return value;
      } catch(error) {
        // Retry the same exact commit request ID/body; the object persists its
        // result. Never replay the transaction callback after an uncertain send.
        if(error instanceof CloudflareStoreError && error.status<500) throw error;
        if(closed||attempt+1===transportAttempts) throw unavailable(payload.op==='commit');
      } finally {clearTimeout(timer);controllers.delete(controller);}
    }
  }
  const client={
    backend:'cloudflare',
    collection:path=>new CollectionReference(client,collectionPath(path)),
    doc:refPath,
    cursorSnapshot({path,data,revision=1}={}) {
      // A server-held source SDK cursor is only an ordering bound, never
      // authorization or a transaction read. This supports staged cutover.
      requireValue(plain(data),'A plain cursor record is required.');
      return new DocumentSnapshot(refPath(path),{path,exists:true,revision,data:encodeCloudflareValue(data)});
    },
    async getAll(...refs) {
      requireValue(refs.length<=MAX_DOCUMENTS&&refs.every(ref=>ref instanceof DocumentReference&&ref._client===client),'Reads require bounded document references from this store.');
      if(!refs.length)return[];
      const result=await rpc({op:'read',paths:refs.map(ref=>ref.path)});
      if(!Array.isArray(result.docs)||result.docs.length!==refs.length)throw unavailable();
      return result.docs.map((row,index)=>new DocumentSnapshot(refs[index],row));
    },
    async _query(query) {
      const spec=orderedQuery(query._query),result=await rpc({op:'query',query:spec});
      if(!Array.isArray(result.docs)||result.docs.length>MAX_DOCUMENTS||!result.guard||canonical(result.guard.query)!==canonical(spec)||
        !/^[a-f0-9]{64}$/.test(result.guard.fingerprint||''))throw unavailable();
      const docs=result.docs.map(row=>new DocumentSnapshot(refPath(row.path),row));
      if(docs.some(row=>!row.exists||row.ref.parent.path!==spec.collection)||new Set(docs.map(row=>row.ref.path)).size!==docs.length)throw unavailable();
      return new QuerySnapshot(query,docs,result.guard);
    },
    async runTransaction(callback,options={}) {
      requireValue(typeof callback==='function'&&plain(options)&&Object.keys(options).every(key=>['readOnly','maxAttempts'].includes(key)), 'A transaction callback and supported options are required.');
      const attempts=options.maxAttempts??maxAttempts; requireValue(Number.isSafeInteger(attempts)&&attempts>=1&&attempts<=10,'Invalid transaction attempts.');
      for(let attempt=0;attempt<attempts;attempt++) {
        const tx=new Transaction(client,options.readOnly===true);
        try {
          const value=await callback(tx),prepared=await tx.prepare();
          // One read RPC is already an atomic snapshot. Additional sequential
          // reads need validation, even when the callback does not write.
          if(prepared.writes.length||tx.remoteReads>1) await rpc({op:'commit',requestId:randomUUID(),...prepared});
          return value;
        } catch(error) {
          tx.closed=true;
          if(!(error instanceof CloudflareStoreError)||error.code!=='TRANSACTION_CONFLICT'||error.status!==409||attempt+1===attempts)throw error;
        }
      }
    },
    batch() {
      const queued=[];let committed=false;
      const batch={};for(const method of ['set','create','update','delete'])batch[method]=(...args)=>{requireValue(!committed,'Batch already committed.');queued.push([method,args]);return batch;};
      batch.commit=()=>{requireValue(!committed,'Batch already committed.');committed=true;return client.runTransaction(tx=>{for(const[method,args]of queued)tx[method](...args);});};
      return batch;
    },
    async terminate(){closed=true;for(const controller of controllers)controller.abort();controllers.clear();}
  };
  return client;
}
