import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorKeepAlive, readKeepAliveTarget } from '../operator-keep-alive.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_,reject) => { timer=setTimeout(() => reject(Error('Heartbeat test did not settle')),500); })]); }
  finally { clearTimeout(timer); }
}
function fixture(extra = {}) {
  let tick, interval, intervals=0, unref=0, clears=0;
  const records=[];
  const timer={ unref() { unref++; } };
  const keepAlive=createOperatorKeepAlive({ env:{ RENDER_EXTERNAL_URL:'https://own-service.onrender.com', APP_URL:'https://public-app.example' },
    fetchImpl: async () => new Response('{"ok":true}'),
    logger:{ info:(label,value) => records.push([label,JSON.parse(value)]) },
    setIntervalImpl:(fn,ms) => { tick=fn;interval=ms;intervals++;return timer; },
    clearIntervalImpl:value => { assert.equal(value,timer);clears++; },
    ...extra });
  return { keepAlive, records, tick:() => tick(), get interval() { return interval; },
    get intervals() { return intervals; }, get unref() { return unref; }, get clears() { return clears; } };
}

test('health target prefers this Render service and accepts only a root HTTPS origin', () => {
  assert.deepEqual(readKeepAliveTarget({ RENDER_EXTERNAL_URL:'https://own.onrender.com/', APP_URL:'https://other.example' }),
    { url:'https://own.onrender.com/health',source:'render' });
  for (const bad of ['http://bad.example','https://name:secret@bad.example','https://bad.example/path',
    'https://bad.example?secret=1','https://bad.example#secret','https://bad.example:8443','not a url'])
    assert.deepEqual(readKeepAliveTarget({ RENDER_EXTERNAL_URL:bad,APP_URL:'https://fallback.example/' }),
      { url:'https://fallback.example/health',source:'app' });
  assert.deepEqual(readKeepAliveTarget({ APP_URL:'https://name:secret@bad.example' }), { url:'',source:'none' });
});

test('construction and startup do not fetch, and schedule one unreferenced five-second timer', async () => {
  let calls=0;
  const f=fixture({ fetchImpl:async () => { calls++;return new Response('{}'); } });
  assert.equal(calls,0);assert.equal(f.intervals,0);
  f.keepAlive.start();f.keepAlive.start();
  assert.equal(calls,0);assert.equal(f.intervals,1);assert.equal(f.interval,5000);assert.equal(f.unref,1);
  assert.equal(f.keepAlive.status().timeoutMs,4000);
  f.tick();await settle();
  assert.equal(calls,1);await bounded(f.keepAlive.ping());
  f.keepAlive.close();f.keepAlive.close();assert.equal(f.clears,1);
});

test('successful health requests drain and release their body without sending credentials or following redirects', async () => {
  let supplied, response;
  const f=fixture({ fetchImpl:async (url,options) => { supplied={url,options};response=new Response('{"ok":true}');return response; } });
  f.keepAlive.start();assert.equal(await bounded(f.keepAlive.ping()),true);
  assert.equal(supplied.url,'https://own-service.onrender.com/health');
  assert.deepEqual(supplied.options.headers,{ Accept:'application/json' });
  assert.equal(supplied.options.redirect,'error');assert.equal(supplied.options.signal.aborted,false);
  assert.equal(response.bodyUsed,true);assert.equal(response.body.locked,false);
  assert.equal(f.keepAlive.status().succeeded,1);f.keepAlive.close();
});

test('overlapping timer ticks reuse the outstanding request and never stack network calls', async () => {
  const gate=deferred();let calls=0;
  const f=fixture({ fetchImpl:() => { calls++;return gate.promise; } });
  f.keepAlive.start();const first=f.keepAlive.ping();await settle();f.tick();
  assert.equal(f.keepAlive.ping(),first);assert.equal(calls,1);assert.equal(f.keepAlive.status().skipped,2);
  gate.resolve(new Response('{}'));assert.equal(await bounded(first),true);
  assert.equal(f.keepAlive.status().inFlight,false);f.keepAlive.close();
});

test('deadline aborts a stalled fetch, records no exception data and permits recovery', async () => {
  let calls=0,signal;
  const f=fixture({ intervalMs:50,timeoutMs:10,fetchImpl:(_url,options) => {
    calls++;signal=options.signal;
    if(calls>1)return Promise.resolve(new Response('{}'));
    return new Promise((_,reject) => signal.addEventListener('abort',() => reject(Error('private bearer and SDK details')),{ once:true }));
  } });
  f.keepAlive.start();assert.equal(await bounded(f.keepAlive.ping()),false);assert.equal(signal.aborted,true);
  await settle();assert.equal(f.keepAlive.status().outcome,'timeout');assert.equal(f.keepAlive.status().failed,1);
  assert.equal(await bounded(f.keepAlive.ping()),true);assert.equal(calls,2);
  assert.equal(JSON.stringify(f.records).includes('private'),false);f.keepAlive.close();
});

test('a fetch ignoring abort holds the single-flight slot after its bounded result', async () => {
  const gate=deferred();let calls=0;
  const f=fixture({ intervalMs:50,timeoutMs:10,fetchImpl:() => { calls++;return calls===1?gate.promise:Promise.resolve(new Response('{}')); } });
  f.keepAlive.start();assert.equal(await bounded(f.keepAlive.ping()),false);
  assert.equal(f.keepAlive.status().inFlight,true);f.tick();
  assert.equal(await bounded(f.keepAlive.ping()),false);assert.equal(calls,1);
  gate.resolve(new Response('{}'));await settle();
  assert.equal(f.keepAlive.status().inFlight,false);assert.equal(await bounded(f.keepAlive.ping()),true);
  assert.equal(calls,2);f.keepAlive.close();
});

test('the deadline also covers a stalled response body and releases its reader', async () => {
  let response;
  const f=fixture({ intervalMs:50,timeoutMs:10,fetchImpl:async (_url,{signal}) => {
    let controller;
    const body=new ReadableStream({ start(value) { controller=value; } });
    signal.addEventListener('abort',() => controller.error(Error('private response data')),{ once:true });
    response=new Response(body);return response;
  } });
  f.keepAlive.start();assert.equal(await bounded(f.keepAlive.ping()),false);await settle();
  assert.equal(f.keepAlive.status().outcome,'timeout');assert.equal(response.body.locked,false);f.keepAlive.close();
});

test('shutdown aborts active work and disables future ticks without waiting for a remote response', async () => {
  let signal,calls=0;
  const f=fixture({ fetchImpl:(_url,options) => {
    calls++;signal=options.signal;
    return new Promise((_,reject) => signal.addEventListener('abort',() => reject(Error('closed')),{ once:true }));
  } });
  f.keepAlive.start();const pending=f.keepAlive.ping();await settle();
  assert.equal(f.keepAlive.close(),undefined);assert.equal(signal.aborted,true);assert.equal(f.clears,1);
  assert.equal(await bounded(pending),false);f.tick();assert.equal(await f.keepAlive.ping(),false);
  f.keepAlive.start();assert.equal(f.intervals,1);assert.equal(calls,1);assert.equal(f.keepAlive.status().failed,0);
});

test('HTTP failures still drain bodies, and response contents never enter telemetry', async () => {
  let response;
  const f=fixture({ fetchImpl:async () => { response=new Response('private secret contents',{ status:503 });return response; } });
  f.keepAlive.start();assert.equal(await bounded(f.keepAlive.ping()),false);
  assert.equal(response.bodyUsed,true);assert.equal(response.body.locked,false);
  assert.equal(f.keepAlive.status().outcome,'http_error');assert.equal(f.keepAlive.status().status,503);
  assert.equal(JSON.stringify(f.records).includes('private'),false);f.keepAlive.close();
});

test('oversized health responses are cancelled rather than buffered indefinitely', async () => {
  let cancelled=false;
  const body=new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9000)); },cancel() { cancelled=true; } });
  const f=fixture({ fetchImpl:async () => new Response(body) });
  f.keepAlive.start();assert.equal(await bounded(f.keepAlive.ping()),false);
  assert.equal(cancelled,true);assert.equal(f.keepAlive.status().outcome,'response_too_large');f.keepAlive.close();
});

test('steady results log at most once a minute while state transitions remain visible', async () => {
  let at=1000,fail=false;
  const f=fixture({ env:{ APP_URL:'https://private-host.example' },clock:() => at,
    fetchImpl:async () => { if(fail)throw Error('private credential');return new Response('{}'); } });
  f.keepAlive.start();await f.keepAlive.ping();assert.equal(f.records.length,2);
  for(let i=0;i<10;i++){ at+=5000;await f.keepAlive.ping(); }
  assert.equal(f.records.length,2);at=61000;await f.keepAlive.ping();assert.equal(f.records.length,3);
  fail=true;at=62000;await f.keepAlive.ping();assert.equal(f.records.length,4);
  at=63000;await f.keepAlive.ping();assert.equal(f.records.length,4);
  assert.ok(f.records.every(([label]) => label==='SH_KEEP_ALIVE'));
  assert.equal(JSON.stringify(f.records).includes('private'),false);f.keepAlive.close();
});

test('missing configuration and broken diagnostic loggers cannot start requests or wedge a valid heartbeat', async () => {
  let calls=0;
  const disabled=fixture({ env:{},fetchImpl:async () => { calls++;return new Response('{}'); } });
  disabled.keepAlive.start();assert.equal(await disabled.keepAlive.ping(),false);assert.equal(disabled.intervals,0);
  assert.equal(disabled.keepAlive.status().running,false);assert.equal(calls,0);disabled.keepAlive.close();
  const valid=fixture({ logger:{ info() { throw Error('logger unavailable'); } } });
  valid.keepAlive.start();assert.equal(await bounded(valid.keepAlive.ping()),true);valid.keepAlive.close();
});
