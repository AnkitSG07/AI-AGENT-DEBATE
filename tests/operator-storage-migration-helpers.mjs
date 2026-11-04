import { FirestoreFake } from './operator-r12-helpers.mjs';
import { createJournaledFirestore } from '../operator-storage-journal.js';
const copy=value=>structuredClone(value);
export function createStorageMigrationSourceFixture(){
  const source=new FirestoreFake(),rawCollection=source.collection.bind(source),rawTransaction=source.runTransaction.bind(source),rawWrite=source.write.bind(source),rawSnapshot=source.snapshot.bind(source);
  const times=new Map();let tick=1800000000,currentTime={seconds:tick,nanoseconds:0};
  source.write=(ref,value,remove)=>{const materialize=v=>v?.__serverTimestamp===true?copy(currentTime):Array.isArray(v)?v.map(materialize):v&&Object.getPrototypeOf(v)===Object.prototype?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,materialize(x)])):v;
    rawWrite(ref,materialize(value),remove);times.set(ref.path,copy(currentTime));};
  source.runTransaction=(callback,options)=>rawTransaction(async tx=>{const result=await callback(tx);currentTime={seconds:++tick,nanoseconds:0};return result;},options);
  source.snapshot=(ref,records)=>{const value=rawSnapshot(ref,records);value.updateTime=times.get(ref.path);return value;};
  const pathValue=(value,path)=>path==='__name__'?value.ref.id:path.split('.').reduce((v,k)=>v?.[k],value.data());
  const comparable=value=>value&&typeof value==='object'&&'seconds'in value?BigInt(value.seconds)*1000000000n+BigInt(value.nanoseconds):value;
  function query(collection,orders=[],limit=Infinity,cursor=null,filters=[]) {
    return {path:collection,id:collection,doc:id=>rawCollection(collection).doc(id),
      orderBy:(field,dir='asc')=>query(collection,[...orders,[field,dir]],limit,cursor,filters),limit:n=>query(collection,orders,n,cursor,filters),startAfter:s=>query(collection,orders,limit,s,filters),where:(field,op,value)=>query(collection,orders,limit,cursor,[...filters,[field,op,value]]),
      get:async()=>{const rows=[...source.documents.keys()].filter(p=>p.split('/').slice(0,-1).join('/')===collection).map(p=>source.snapshot(rawCollection(collection).doc(p.split('/').at(-1))));
        const compare=(a,b)=>{for(const [field,dir]of orders){const x=comparable(pathValue(a,field)),y=comparable(pathValue(b,field));if(x<y)return dir==='asc'?-1:1;if(x>y)return dir==='asc'?1:-1;}return a.ref.path<b.ref.path?-1:a.ref.path>b.ref.path?1:0;};
        rows.sort(compare);const docs=rows.filter(s=>(!cursor||compare(s,cursor)>0)&&filters.every(([field,op,value])=>{const a=comparable(pathValue(s,field)),b=comparable(value);return op==='>='?a>=b:op==='=='?a===b:false;})).slice(0,limit);return {docs,size:docs.length,empty:!docs.length};}};
  }
  source.collection=name=>query(name);
  source.listCollections=async()=>[...new Set([...source.documents.keys()].map(p=>p.split('/')[0]))].map(name=>source.collection(name));
  const serverTimestamp=()=>({__serverTimestamp:true});
  const app=createJournaledFirestore({firestore:source,serverTimestamp});
  return {source,app,serverTimestamp,seed:(collection,id,value)=>{currentTime={seconds:++tick,nanoseconds:0};source.seed(collection,id,value);}};
}
