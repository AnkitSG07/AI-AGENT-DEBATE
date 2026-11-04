// References stay valid across a one-way, source-fenced storage cutover. This
// routes storage operations, never cached credentials or cached call ownership.
export function createOperatorStorageRouter({source, target, readGate, onSwitch = () => {},
  switchWaitMs=20000,clock=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  let active = source, switched = false, closed = false;
  const isFenced = error => error?.code === 'STORAGE_SOURCE_FENCED';
  const closedError = () => Object.assign(new Error('Operator storage is unavailable.'), {code:'STORAGE_CLOSED',status:503});
  async function run(operation) {
    if (closed) throw closedError();
    const selected = active;
    try { return await operation(selected); }
    catch (error) {
      // Only a positively confirmed source fence can reroute a transaction.
      // Network failures and unknown commit outcomes never select another DB.
      if (selected !== source || !isFenced(error)) throw error;
      let gate = await readGate();
      if (gate.mode !== 'cloudflare' || !gate.migrationId || !Number.isSafeInteger(gate.epoch) || gate.epoch < 1) throw error;
      const deadline=clock()+switchWaitMs;
      while(gate.targetReady!==true) {
        if(clock()>=deadline)throw Object.assign(new Error('The storage update is finishing. Please retry.'),{code:'STORAGE_CUTOVER_PENDING',status:503});
        await wait(150);gate=await readGate();
        if(gate.mode!=='cloudflare')throw error;
      }
      active = target;
      if (!switched) { switched = true; onSwitch({mode:'cloudflare',epoch:gate.epoch,migrationId:gate.migrationId}); }
      return operation(target);
    }
  }
  function describe(value) {
    if (value?._routeStore === api) return value;
    if (typeof value?.path === 'string' && value.path.split('/').length === 2) return document(value.path);
    throw new TypeError('A reference from this operator store is required.');
  }
  function native(db, value) {
    const ref = describe(value);
    if (ref._kind === 'document') {
      const [collection,id] = ref.path.split('/');
      return db.collection(collection).doc(id);
    }
    let query = db.collection(ref.path);
    for (const [method,args] of ref._steps) {
      const values = method === 'startAfter' && typeof db.cursorSnapshot === 'function'
        ? [db.cursorSnapshot({path:args[0].ref.path,data:args[0].data(),revision:args[0].revision||1})] : args;
      query = query[method](...values);
    }
    return query;
  }
  function document(path) {
    if (typeof path !== 'string' || path.split('/').length !== 2 || !path.split('/').every(Boolean)) throw new TypeError('An exact document path is required.');
    const [parent,id] = path.split('/');
    const ref = {_routeStore:api,_kind:'document',path,id,parent:collection(parent),
      get:()=>run(db=>native(db,ref).get()),
      set:(...args)=>run(db=>native(db,ref).set(...args)),
      create:(...args)=>run(db=>native(db,ref).create(...args)),
      update:(...args)=>run(db=>native(db,ref).update(...args)),
      delete:(...args)=>run(db=>native(db,ref).delete(...args))};
    return ref;
  }
  function collection(path,steps=[]) {
    if (typeof path !== 'string' || !path || path.includes('/')) throw new TypeError('An exact collection path is required.');
    const query = {_routeStore:api,_kind:'query',path,id:path,_steps:steps,
      doc:id=>document(path+'/'+id),get:()=>run(db=>native(db,query).get())};
    for (const method of ['where','orderBy','limit','startAfter']) query[method]=(...args)=>collection(path,[...steps,[method,args]]);
    return query;
  }
  const api = {
    collection,doc:document,
    get backend(){return switched?'cloudflare':'firestore';},
    getAll:(...refs)=>run(db=>db.getAll(...refs.flat().map(ref=>native(db,ref)))),
    runTransaction:(callback,options={})=>run(db=>db.runTransaction(async tx=>{
      const proxy = {
        get:ref=>tx.get(native(db,ref)),
        getAll:(...refs)=>tx.getAll(...refs.flat().map(ref=>native(db,ref))),
      };
      for(const method of ['set','create','update','delete']) proxy[method]=(ref,...args)=>{tx[method](native(db,ref),...args);return proxy;};
      return callback(proxy);
    },options)),
    close:()=>{closed=true;},terminate:async()=>{closed=true;},
    status:()=>({backend:switched?'cloudflare':'firestore',switched,closed})
  };
  return api;
}
