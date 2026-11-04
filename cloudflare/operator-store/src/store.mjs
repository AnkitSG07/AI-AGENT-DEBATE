import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ bodyBytes: 8 * 1024 * 1024, documentBytes: 1024 * 1024,
  responseBytes: 8 * 1024 * 1024, reads: 1000, writes: 450, queries: 32, queryRows: 1000, memoryNonces: 32768 });
const SUFFIXES = new Set(['devices','installations','credentials','enrollments','rotations','deliveries','metadata','app_messages',
  'call_permissions','ai_reply_receipts','ai_handover_receipts',
  ...['calls','reservations','transfers','jobs','sessions','events'].map(x=>'media_'+x),
  ...['calls','activity','exports','collector','deferred','receipts','retention'].map(x=>'reports_'+x),
  ...['objects','chunks','bundles'].map(x=>'reports_archive_'+x)]);
const FIELDS = new Set(['callId','messageId','transferId','recoveryUntil','availableAtMs','occurredAtMs','data.terminal.endedAt']);
const DIRECTIONS = new Set(['asc','desc']), OPS = new Set(['==','<','<=','>','>=']);
const TOKEN = /^[A-Za-z0-9_-]{8,160}$/, DIGEST = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export class StoreError extends Error {
  constructor(code, message, status = 400) { super(message); this.code=code; this.status=status; }
}
const fail = (code, message, status) => { throw new StoreError(code,message,status); };
const need = (ok, message='Invalid private store request.') => { if(!ok) fail('INVALID_REQUEST',message,400); };
const bytes = value => new TextEncoder().encode(value).byteLength;
export function canonical(value, depth=0) {
  need(depth<=50,'Document nesting exceeds the supported limit.');
  if(value===null || typeof value==='boolean' || typeof value==='string') return JSON.stringify(value);
  if(typeof value==='number' && Number.isFinite(value)) return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(x=>canonical(x,depth+1)).join(',')+']';
  need(object(value),'Only finite JSON values are supported.');
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key],depth+1)).join(',')+'}';
}
export const digest = value => createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const scalar = value => value===null || typeof value==='boolean' || typeof value==='string' || typeof value==='number' && Number.isFinite(value);
const sqlValue = value => typeof value==='boolean'?Number(value):value;
const sourceVersion = value => {
  need(object(value)&&/^(?:0|[1-9]\d{0,12})$/.test(value.seconds)&&Number.isSafeInteger(value.nanos)&&value.nanos>=0&&value.nanos<1000000000,'A precise source document version is required.');
  return{seconds:value.seconds,nanos:value.nanos};
};
const compareVersion = (a,b) => BigInt(a.seconds)<BigInt(b.seconds)?-1:BigInt(a.seconds)>BigInt(b.seconds)?1:Math.sign(a.nanos-b.nanos);
const fieldExpression = field => {
  need(FIELDS.has(field),'Unsupported private query field.');
  return `json_extract(data, '$.${field}')`;
};
const fieldType = field => `json_type(data, '$.${field}')`;

export class DocumentStore {
  constructor(storage, {prefix='sh_operator', clock=Date.now}={}) {
    need(/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(prefix),'Invalid store namespace.');
    this.storage=storage;this.sql=storage.sql;this.prefix=prefix;this.clock=clock;this.nextNonceCleanupAt=0;this.nextMemoryNonceCleanupAt=0;this.recentNonces=new Map();
    storage.transactionSync(()=>{
      this.sql.exec(`CREATE TABLE IF NOT EXISTS documents(path TEXT PRIMARY KEY, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT, revision INTEGER NOT NULL, live INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS documents_collection ON documents(collection, live, id);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS nonce_expiry ON nonces(expires);
        CREATE TABLE IF NOT EXISTS commits(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS commit_created ON commits(created);
        CREATE TABLE IF NOT EXISTS staging(migration_id TEXT NOT NULL, path TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT, source_seconds TEXT NOT NULL, source_nanos INTEGER NOT NULL, live INTEGER NOT NULL, PRIMARY KEY(migration_id,path));
        CREATE TABLE IF NOT EXISTS migration_batches(migration_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(migration_id,request_id));`);
      for(const field of FIELDS) {
        const name=field.replaceAll('.','_');
        this.sql.exec(`CREATE INDEX IF NOT EXISTS documents_${name} ON documents(collection, ${fieldExpression(field)}, id) WHERE live = 1`);
      }
      if(!this.meta('mode')) this.setMeta('mode',{state:'staging',epoch:0});
    });
  }
  meta(key) { const row=this.sql.exec('SELECT value FROM meta WHERE key = ?',key).toArray()[0];return row?JSON.parse(row.value):null; }
  setMeta(key,value) { this.sql.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,canonical(value)); }
  collection(value) { need(typeof value==='string' && value.startsWith(this.prefix+'_') && SUFFIXES.has(value.slice(this.prefix.length+1)),'Collection is outside the private operator namespace.');return value; }
  path(value) {
    need(typeof value==='string' && bytes(value)<=512,'Invalid document path.');
    const pieces=value.split('/');need(pieces.length===2 && pieces[1].length>0 && pieces[1].length<=220 && !/[\u0000-\u001f\u007f]/.test(pieces[1]) && !['.','..'].includes(pieces[1]),'Invalid document path.');
    return {path:value,collection:this.collection(pieces[0]),id:pieces[1]};
  }
  row(path) { this.path(path);return this.sql.exec('SELECT path,data,revision,live FROM documents WHERE path = ?',path).toArray()[0]; }
  snapshot(path) { const row=this.row(path);return {path,exists:!!row?.live,revision:row?.revision||0,...(row?.live?{data:JSON.parse(row.data)}:{})}; }
  active() { const mode=this.meta('mode');if(mode?.state!=='active') fail('STORE_NOT_ACTIVE','The staged operator store is not active.',503);return mode; }
  acceptNonce(nonce,expires,{persistent=true}={}) {
    const now=this.clock();
    // Read replay after eviction can only repeat an already-authorized read
    // during its signature window. Keep those nonces in bounded memory rather
    // than turning every auth/status poll into database writes and deletes.
    // Mutations ALWAYS retain persistent replay protection across restarts.
    if(now>=this.nextMemoryNonceCleanupAt||this.recentNonces.size>=LIMITS.memoryNonces) {
      for(const [key,expiry] of this.recentNonces)if(expiry<now)this.recentNonces.delete(key);
      this.nextMemoryNonceCleanupAt=now+1000;
    }
    if(this.recentNonces.has(nonce))fail('REPLAY_REJECTED','Request nonce was already used.',401);
    if(this.recentNonces.size>=LIMITS.memoryNonces)fail('REPLAY_CAPACITY','Private request replay window is temporarily full.',429);
    if(!persistent){this.recentNonces.set(nonce,expires);return;}
    this.storage.transactionSync(()=>{
      // Indexed, bounded expiry cleanup avoids a table COUNT/scan on every
      // status request. A restart safely repeats this idempotent cleanup.
      if(this.clock()>=this.nextNonceCleanupAt) {
        this.sql.exec('DELETE FROM nonces WHERE nonce IN (SELECT nonce FROM nonces WHERE expires < ? ORDER BY expires ASC LIMIT 500)',this.clock());
        this.nextNonceCleanupAt=this.clock()+30000;
      }
      if(this.sql.exec('SELECT nonce FROM nonces WHERE nonce = ?',nonce).toArray().length) fail('REPLAY_REJECTED','Request nonce was already used.',401);
      this.sql.exec('INSERT INTO nonces(nonce,expires) VALUES(?,?)',nonce,expires);
    });
    this.recentNonces.set(nonce,expires);
  }
  normalizeQuery(value) {
    need(object(value));const collection=this.collection(value.collection);
    const where=value.where||[],orderBy=value.orderBy||[];
    need(Array.isArray(where)&&where.length<=8&&Array.isArray(orderBy)&&orderBy.length<=4);
    const normalized={collection,where:where.map(clause=>{need(object(clause)&&FIELDS.has(clause.field)&&OPS.has(clause.op)&&scalar(clause.value));return{field:clause.field,op:clause.op,value:clause.value};}),
      orderBy:orderBy.map(order=>{need(object(order)&&FIELDS.has(order.field)&&DIRECTIONS.has(order.direction));return{field:order.field,direction:order.direction};})};
    need(new Set(normalized.orderBy.map(x=>x.field)).size===normalized.orderBy.length);
    if(value.limit!==undefined) {need(Number.isSafeInteger(value.limit)&&value.limit>0&&value.limit<=LIMITS.queryRows);normalized.limit=value.limit;}
    if(value.startAfter!==undefined) {
      const cursor=value.startAfter;need(object(cursor)&&Array.isArray(cursor.values)&&cursor.values.length===normalized.orderBy.length&&cursor.values.every(scalar));
      const path=this.path(cursor.path);need(path.collection===collection);normalized.startAfter={path:cursor.path,values:cursor.values};
    }
    return normalized;
  }
  query(query) {
    query=this.normalizeQuery(query);
    const conditions=['collection = ?','live = 1'],params=[query.collection];
    for(const clause of query.where) {
      const expression=fieldExpression(clause.field),type=fieldType(clause.field),operator=clause.op==='=='?'=':clause.op;
      if(clause.value===null) {need(clause.op==='==','Null queries support equality only.');conditions.push(`${type} = 'null'`);}
      else {
        const requiredType=typeof clause.value==='number'?`${type} IN ('integer','real')`:typeof clause.value==='string'?`${type} = 'text'`:`${type} = '${clause.value?'true':'false'}'`;
        conditions.push(`(${requiredType}) AND ${expression} ${operator} ?`);params.push(sqlValue(clause.value));
      }
    }
    const effectiveOrder=query.orderBy.length?query.orderBy:[...new Set(query.where.filter(x=>x.op!=='==').map(x=>x.field))].sort().map(field=>({field,direction:'asc'}));
    for(const order of effectiveOrder) conditions.push(`${fieldType(order.field)} IS NOT NULL`);
    const ordering=effectiveOrder.map(x=>({expression:fieldExpression(x.field),direction:x.direction}));
    ordering.push({expression:'id',direction:effectiveOrder.at(-1)?.direction||'asc'});
    if(query.startAfter) {
      const cursorId=this.path(query.startAfter.path).id,values=[...query.startAfter.values.map(sqlValue),cursorId],parts=[];
      // Lexicographic ordering includes document ID, making pages deterministic
      // when terminal times and due-job times are equal.
      for(let i=0;i<ordering.length;i++) {
        const equal=[];for(let j=0;j<i;j++){equal.push(`${ordering[j].expression} IS ?`);params.push(values[j]);}
        equal.push(`${ordering[i].expression} ${ordering[i].direction==='desc'?'<':'>'} ?`);params.push(values[i]);parts.push('('+equal.join(' AND ')+')');
      }
      conditions.push('('+parts.join(' OR ')+')');
    }
    const requested=query.limit??LIMITS.queryRows;
    const sql=`SELECT path,data,revision FROM documents WHERE ${conditions.join(' AND ')} ORDER BY ${ordering.map(x=>x.expression+' '+x.direction.toUpperCase()).join(', ')} LIMIT ?`;
    params.push(requested+(query.limit===undefined?1:0));
    const rows=this.sql.exec(sql,...params).toArray();
    if(query.limit===undefined&&rows.length>LIMITS.queryRows) fail('QUERY_LIMIT','The collection exceeds the bounded query limit.',503);
    const docs=rows.map(row=>({path:row.path,exists:true,revision:row.revision,data:JSON.parse(row.data)}));
    const fingerprint=digest({query,rows:docs.map(x=>[x.path,x.revision])});
    return {docs,guard:{query,fingerprint}};
  }
  commit(input) {
    need(TOKEN.test(input.requestId),'A stable commit request ID is required.');
    const reads=input.reads||[],queries=input.queries||[],writes=input.writes||[];
    need(Array.isArray(reads)&&reads.length<=LIMITS.reads&&Array.isArray(queries)&&queries.length<=LIMITS.queries&&Array.isArray(writes)&&writes.length<=LIMITS.writes);
    need(new Set(reads.map(x=>x.path)).size===reads.length&&new Set(writes.map(x=>x.path)).size===writes.length);
    for(const read of reads){need(object(read)&&Number.isSafeInteger(read.revision)&&read.revision>=0);this.path(read.path);}
    for(const guard of queries){need(object(guard)&&DIGEST.test(guard.fingerprint));this.normalizeQuery(guard.query);}
    const prepared=writes.map(write=>{
      need(object(write)&&['set','create','delete'].includes(write.type));const scope=this.path(write.path);
      let data=null;if(write.type!=='delete'){need(object(write.data),'A document must be a plain encoded object.');data=canonical(write.data);need(bytes(data)<=LIMITS.documentBytes,'Document is too large.');}
      return{...scope,type:write.type,data};
    });
    const fingerprint=digest({reads,queries,writes});
    return this.storage.transactionSync(()=>{
      this.active();
      const prior=this.sql.exec('SELECT fingerprint,result FROM commits WHERE request_id = ?',input.requestId).toArray()[0];
      if(prior){if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_MISMATCH','Commit identity was reused with a different payload.',409);return JSON.parse(prior.result);}
      for(const read of reads)if(this.snapshot(read.path).revision!==read.revision)fail('TRANSACTION_CONFLICT','A transaction read changed.',409);
      for(const guard of queries)if(this.query(guard.query).guard.fingerprint!==guard.fingerprint)fail('TRANSACTION_CONFLICT','A transaction query changed.',409);
      const revisions=[];
      for(const write of prepared){
        const old=this.row(write.path);if(write.type==='create'&&old?.live)fail('ALREADY_EXISTS','A document already exists.',409);
        const revision=(old?.revision||0)+1;need(Number.isSafeInteger(revision),'Revision limit reached.');
        this.sql.exec('INSERT INTO documents(path,collection,id,data,revision,live) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data,revision=excluded.revision,live=excluded.live',write.path,write.collection,write.id,write.data,revision,write.type==='delete'?0:1);
        revisions.push({path:write.path,revision});
      }
      const result={ok:true,committed:true,revisions};
      if(!writes.length)return result;
      this.sql.exec('INSERT INTO commits(request_id,fingerprint,result,created) VALUES(?,?,?,?)',input.requestId,fingerprint,canonical(result),this.clock());
      // Retain acknowledgement evidence longer than any client retry horizon.
      this.sql.exec('DELETE FROM commits WHERE created < ? AND request_id IN (SELECT request_id FROM commits ORDER BY created ASC LIMIT 100)',this.clock()-7*86400000);
      return result;
    });
  }
  rpc(input) {
    need(object(input)&&input.version===1);this.active();
    if(input.op==='read') {
      need(Array.isArray(input.paths)&&input.paths.length>0&&input.paths.length<=LIMITS.reads);
      return this.storage.transactionSync(()=>({ok:true,docs:input.paths.map(path=>this.snapshot(path))}));
    }
    if(input.op==='query')return{ok:true,...this.query(input.query)};
    if(input.op==='commit')return this.commit(input);
    fail('INVALID_OPERATION','Unsupported private store operation.',400);
  }
  migration(input) {
    need(object(input)&&input.version===1);
    if(input.op==='status')return{ok:true,mode:this.meta('mode'),migration:this.meta('migration'),count:this.sql.exec('SELECT count(*) AS n FROM documents WHERE live = 1').toArray()[0].n};
    const migrationId=input.migrationId;need(TOKEN.test(migrationId));
    return this.storage.transactionSync(()=>{
      const mode=this.meta('mode'),migration=this.meta('migration');
      if(input.op==='begin') {
        need(mode.state!=='active','Active stores cannot be overwritten by migration.');
        if(migration&&migration.id!==migrationId)fail('MIGRATION_EXISTS','A different migration already exists.',409);
        if(!migration)this.setMeta('migration',{id:migrationId,state:'importing',createdAt:this.clock()});
        return{ok:true,migration:this.meta('migration')};
      }
      need(migration?.id===migrationId,'Unknown migration.');
      if(input.op==='import') {
        need(mode.state!=='active'&&migration.state==='importing','Migration import is closed.');
        need(TOKEN.test(input.requestId)&&Array.isArray(input.documents)&&input.documents.length<=LIMITS.writes);
        const prepared=input.documents.map(doc=>{
          need(object(doc)&&(doc.deleted===true||object(doc.data)));const scope=this.path(doc.path),version=sourceVersion(doc.sourceVersion);
          const data=doc.deleted===true?null:canonical(doc.data);if(data!==null)need(bytes(data)<=LIMITS.documentBytes);
          return{...scope,data,version,live:doc.deleted===true?0:1};
        });
        need(new Set(prepared.map(x=>x.path)).size===prepared.length,'Migration paths must be unique.');
        const fingerprint=digest({documents:input.documents});
        const prior=this.sql.exec('SELECT fingerprint FROM migration_batches WHERE migration_id = ? AND request_id = ?',migrationId,input.requestId).toArray()[0];
        if(prior){if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_MISMATCH','Migration batch ID changed.',409);return{ok:true,replayed:true};}
        let imported=0,deleted=0,ignored=0;
        for(const doc of prepared) {
          const previous=this.sql.exec('SELECT data,source_seconds,source_nanos,live FROM staging WHERE migration_id = ? AND path = ?',migrationId,doc.path).toArray()[0];
          if(previous) {
            const order=compareVersion(doc.version,{seconds:previous.source_seconds,nanos:previous.source_nanos});
            if(order<0){ignored++;continue;}
            if(order===0){if(previous.data!==doc.data||previous.live!==doc.live)fail('SOURCE_VERSION_MISMATCH','An equal source version had different contents.',409);ignored++;continue;}
          }
          this.sql.exec('INSERT INTO staging(migration_id,path,collection,id,data,source_seconds,source_nanos,live) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(migration_id,path) DO UPDATE SET data=excluded.data,source_seconds=excluded.source_seconds,source_nanos=excluded.source_nanos,live=excluded.live',migrationId,doc.path,doc.collection,doc.id,doc.data,doc.version.seconds,doc.version.nanos,doc.live);
          if(doc.live)imported++;else deleted++;
        }
        this.sql.exec('INSERT INTO migration_batches(migration_id,request_id,fingerprint) VALUES(?,?,?)',migrationId,input.requestId,fingerprint);
        return{ok:true,imported,deleted,ignored};
      }
      if(input.op==='checksum'||input.op==='seal') {
        need(mode.state!=='active','Active stores cannot be resealed.');
        const summary=this.stagingSummary(migrationId);
        if(input.op==='seal') {
          need(migration.state==='importing','Migration is already sealed.');
          need(input.expectedCount===summary.count&&input.expectedChecksum===summary.checksum,'Migration checksum/count did not match.');
          this.setMeta('migration',{...migration,state:'sealed',...summary,sealedAt:this.clock()});
        }
        return{ok:true,...summary};
      }
      if(input.op==='activate') {
        if(mode.state==='active'&&mode.migrationId===migrationId&&mode.checksum===input.expectedChecksum)return{ok:true,mode};
        need(mode.state!=='active'&&migration.state==='sealed','Migration must be sealed before activation.');
        const summary=this.stagingSummary(migrationId);
        need(summary.checksum===migration.checksum&&input.expectedChecksum===summary.checksum&&input.expectedCount===summary.count,'Sealed migration changed.');
        need(this.sql.exec('SELECT count(*) AS n FROM documents').toArray()[0].n===0,'An existing live store cannot be overwritten.');
        this.sql.exec('INSERT INTO documents(path,collection,id,data,revision,live) SELECT path,collection,id,data,1,live FROM staging WHERE migration_id = ?',migrationId);
        const next={state:'active',epoch:mode.epoch+1,migrationId,checksum:summary.checksum,activatedAt:this.clock()};this.setMeta('mode',next);
        this.setMeta('migration',{...migration,state:'activated',activatedAt:this.clock()});
        return{ok:true,mode:next};
      }
      fail('INVALID_OPERATION','Unsupported migration operation.',400);
    });
  }
  stagingSummary(migrationId) {
    const hash=createHash('sha256');let count=0;
    // Exact algorithm shared with the exporter: UTF-8 path + LF + canonical
    // encoded document JSON + LF, ordered by path, then SHA-256 of that stream.
    for(const row of this.sql.exec('SELECT path,data FROM staging WHERE migration_id = ? AND live = 1 ORDER BY path ASC',migrationId)) {hash.update(row.path+'\n'+row.data+'\n');count++;}
    return{count,checksum:hash.digest('hex')};
  }
}
