import { DurableObject } from 'cloudflare:workers';
import { DocumentStore, LIMITS, StoreError, digest } from './store.mjs';

const json = (value,status=200) => {
  const body=JSON.stringify(value);
  if(new TextEncoder().encode(body).byteLength>LIMITS.responseBytes)return new Response('{"ok":false,"code":"RESPONSE_LIMIT","message":"Private response exceeded its bounded size."}',{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  return new Response(body,{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
};
const reject = (code,message,status=401) => {throw new StoreError(code,message,status);};
async function authenticate(request,env) {
  const url=new URL(request.url);
  if(request.method!=='POST'||!['/rpc','/migration'].includes(url.pathname)||url.search)reject('NOT_FOUND','Private store endpoint not found.',404);
  const key=url.pathname==='/rpc'?env.SH_STORE_SECRET:env.SH_STORE_MIGRATION_SECRET;
  if(env.SH_STORE_SECRET&&env.SH_STORE_SECRET===env.SH_STORE_MIGRATION_SECRET)reject('NOT_CONFIGURED','Normal and migration credentials must be separate.',503);
  if(typeof key!=='string'||key.length<32||key.length>512)reject('NOT_CONFIGURED','Private store authentication is not configured.',503);
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')reject('CONTENT_TYPE','JSON is required.',415);
  const timestamp=request.headers.get('x-sh-store-timestamp')||'',nonce=request.headers.get('x-sh-store-nonce')||'',signature=request.headers.get('x-sh-store-signature')||'';
  if(!/^\d{13}$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>60000||!/^[A-Za-z0-9_-]{20,100}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(signature))reject('AUTH_REQUIRED','Private store authentication failed.');
  const declared=Number(request.headers.get('content-length')||0);if(declared>LIMITS.bodyBytes)reject('BODY_LIMIT','Request body is too large.',413);
  const reader=request.body?.getReader();if(!reader)reject('INVALID_REQUEST','JSON request body is required.',400);
  const chunks=[];let total=0;
  for(;;){const{done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>LIMITS.bodyBytes){await reader.cancel();reject('BODY_LIMIT','Request body is too large.',413);}chunks.push(value);}
  const buffer=new Uint8Array(total);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
  const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer),bodyHash=digest(text);
  const message=timestamp+'\n'+nonce+'\n'+url.pathname+'\n'+bodyHash;
  const cryptoKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const mac=Uint8Array.from(signature.match(/../g),x=>parseInt(x,16));
  if(!await crypto.subtle.verify('HMAC',cryptoKey,mac,new TextEncoder().encode(message)))reject('AUTH_REQUIRED','Private store authentication failed.');
  let input;try{input=JSON.parse(text);}catch{reject('INVALID_REQUEST','Invalid JSON request.',400);}
  return{input,nonce,expires:Number(timestamp)+120000,path:url.pathname};
}
function errorResponse(error) {
  if(error instanceof StoreError)return json({ok:false,code:error.code,message:error.message},error.status);
  // No SDK exception/record/credential material is exposed in failures or logs.
  return json({ok:false,code:'STORE_UNAVAILABLE',message:'Private operator storage is temporarily unavailable.'},503);
}
function readOnlyRequest({path,input}) {
  if(!input||input.version!==1)return false;
  if(path==='/migration')return ['status','checksum'].includes(input.op);
  if(path==='/rpc')return ['read','query'].includes(input.op)||
    input.op==='commit'&&Array.isArray(input.writes)&&input.writes.length===0;
  return false;
}
export class OperatorStore extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.env=env;this.store=new DocumentStore(ctx.storage,{prefix:env.SH_STORE_PREFIX});}
  async fetch(request){
    try{
      const auth=await authenticate(request,this.env);
      this.store.acceptNonce(auth.nonce,auth.expires,{persistent:!readOnlyRequest(auth)});
      return json(auth.path==='/rpc'?this.store.rpc(auth.input):this.store.migration(auth.input));
    }catch(error){return errorResponse(error);}
  }
}
export default {
  async fetch(request,env){
    try{
      const tenant=env.SH_STORE_TENANT;
      if(typeof tenant!=='string'||!/^[A-Za-z0-9_-]{3,80}$/.test(tenant))reject('NOT_CONFIGURED','Private operator scope is not configured.',503);
      // Authenticate at the public edge before invoking a billable Durable Object.
      // The DO authenticates again rather than trusting a forgeable proxy header.
      await authenticate(request.clone(),env);
      return await env.OPERATOR_STORE.get(env.OPERATOR_STORE.idFromName(tenant)).fetch(request);
    }catch(error){return errorResponse(error);}
  }
};
