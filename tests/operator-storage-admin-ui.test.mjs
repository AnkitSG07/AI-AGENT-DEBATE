// Actual administrator HTML, isolated browser and intercepted synthetic APIs.
// No deployment, persistent credentials or production requests are involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.SH_PLAYWRIGHT_MODULE||'playwright');
const html=await readFile(new URL('../public/operator-admin.html',import.meta.url),'utf8');
const prefix='/api/operator-android/admin',origin='https://operator.example.test';
let browser;
test.before(async()=>{browser=await chromium.launch({executablePath:process.env.SH_TEST_CHROMIUM,headless:true,args:['--no-sandbox']});});
test.after(async()=>{await browser?.close();});

async function fixture(t,{enabled=true,configured=true,unauthorized=false,running=false}={}){
  const context=await browser.newContext({viewport:{width:390,height:844}});
  t.after(()=>context.close());
  const page=await context.newPage(),calls=[];
  const migration={ok:true,enabled,configured,running,job:null,
    migration:{mode:'source',phase:'source',snapshotComplete:false,copied:0,targetReady:false}};
  let rejectAction=false;
  await page.clock.install();
  await page.addInitScript(()=>{
    window.__adminRequests=[];const fetchOriginal=window.fetch;
    window.fetch=(url,options={})=>{window.__adminRequests.push({url,method:options.method||'GET',credentials:options.credentials,cache:options.cache,headers:options.headers,body:options.body});return fetchOriginal(url,options);};
  });
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),method=request.method();
    assert.equal(url.origin,origin,'Every browser request remains inside the isolated fixture.');
    const answer=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(url.pathname==='/operator-admin.html')return route.fulfill({contentType:'text/html',body:html});
    calls.push({path:url.pathname,method,body:request.postDataJSON()});
    if(url.pathname===prefix+'/status')return unauthorized?answer({ok:false,error:'Sign in as administrator.'},401):answer({ok:true,storageAvailable:true,metaSignatureConfigured:true,nativeCallingRequested:true,transferPilotRequested:true,
      devices:[{id:'synthetic-existing-phone',label:'Existing phone',nativeBuild:25,expiresAt:1900000000000,revoked:false}]});
    if(url.pathname==='/api/operator-reports/status')return answer({ok:true,configured:false});
    if(url.pathname===prefix+'/storage-migration'){
      if(method==='POST'){
        if(rejectAction)return answer({ok:false,error:'Sign in as administrator.'},401);
        const action=request.postDataJSON().action;
        if(action==='prepare')migration.migration={...migration.migration,mode:'shadow',phase:'copying'};
        else if(action==='copy')migration.migration={...migration.migration,phase:'ready_to_verify',snapshotComplete:true,copied:12};
        else if(action==='replay')migration.migration={...migration.migration,phase:'ready_to_verify',copied:13};
        else if(action==='cutover')migration.migration={...migration.migration,mode:'cloudflare',phase:'active',targetReady:true,verifiedCount:13};
        else assert.fail('Unexpected migration action: '+action);
        return answer({ok:true,accepted:true});
      }
      return answer(migration);
    }
    assert.fail('Unexpected fixture API: '+url.pathname);
  });
  await page.goto(origin+'/operator-admin.html');
  if(!unauthorized)await page.locator('#workspace').waitFor({state:'visible'});
  return{page,calls,migration,rejectActions:()=>{rejectAction=true;},migrationReads:()=>calls.filter(c=>c.path===prefix+'/storage-migration'&&c.method==='GET').length};
}

test('migration controls stay hidden when disabled and existing enrolled phone remains visible',async t=>{
  const f=await fixture(t,{enabled:false});
  await f.page.getByText('Existing phone',{exact:true}).waitFor();
  assert.equal(await f.page.locator('#storageMigrationSection').isVisible(),false);
  assert.equal(await f.page.locator('#inviteForm').isVisible(),true);
  assert.equal(f.calls.some(c=>c.method==='POST'),false);
});

test('an incomplete migration target disables its actions while normal phone management remains available',async t=>{
  const f=await fixture(t,{configured:false});
  await f.page.getByText('Update configuration is incomplete. The current storage stays selected.',{exact:true}).waitFor();
  for(const id of ['migrationPrepare','migrationCopy','migrationReplay','migrationCutover'])assert.equal(await f.page.locator('#'+id).isDisabled(),true);
  assert.equal(await f.page.locator('#inviteForm').isVisible(),true);
  assert.equal(await f.page.getByRole('button',{name:'Revoke',exact:true}).isEnabled(),true);
  assert.equal(f.calls.some(c=>c.method==='POST'),false);
});

test('the actual admin UI performs prepare, copy, replay and verified switch with explicit same-origin action requests',async t=>{
  const f=await fixture(t);
  await f.page.locator('#migrationPrepare').waitFor({state:'visible'});
  assert.equal(await f.page.locator('#migrationCutover').isDisabled(),true);
  for(const [id,action]of [['migrationPrepare','prepare'],['migrationCopy','copy'],['migrationReplay','replay'],['migrationCutover','cutover']]){
    await f.page.locator('#'+id).click();
    await f.page.waitForFunction(value=>window.__adminRequests.some(r=>r.method==='POST'&&r.url.endsWith('/storage-migration')&&JSON.parse(r.body).action===value),action);
  }
  await f.page.getByText(/New storage active/).waitFor();
  assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(c=>c.body.action),['prepare','copy','replay','cutover']);
  const requests=await f.page.evaluate(()=>__adminRequests.filter(r=>r.method==='POST'));
  for(const request of requests){assert.equal(request.credentials,'same-origin');assert.equal(request.cache,'no-store');assert.equal(request.headers['X-SH-Admin-Action'],'1');}
  await f.page.waitForFunction(()=>['migrationPrepare','migrationCopy','migrationReplay','migrationCutover'].every(id=>document.getElementById(id).disabled),null,{timeout:3000});
  assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});

test('migration status polls only while a job runs and stops after a completed refresh',async t=>{
  const f=await fixture(t,{running:true});
  await f.page.getByText(/Update in progress/).waitFor();
  assert.equal(await f.page.locator('#migrationPrepare').isDisabled(),true);
  const initial=f.migrationReads();
  await f.page.clock.fastForward(3500);
  await f.page.waitForFunction(()=>__adminRequests.filter(r=>r.url.endsWith('/storage-migration')).length>=2);
  assert.ok(f.migrationReads()>initial);
  f.migration.running=false;
  await f.page.locator('#migrationRefresh').click();
  await f.page.waitForFunction(()=>!document.getElementById('migrationStatus').textContent.includes('Update in progress'));
  const completed=f.migrationReads();
  await f.page.clock.fastForward(30000);
  assert.equal(f.migrationReads(),completed,'An idle update must not keep reading storage.');
});

test('an expired administrator session returns to sign-in before any update action can be completed',async t=>{
  const f=await fixture(t);await f.page.locator('#migrationPrepare').waitFor({state:'visible'});
  f.rejectActions();await f.page.locator('#migrationPrepare').click();
  await f.page.locator('#login').waitFor({state:'visible'});
  assert.equal(await f.page.locator('#workspace').isVisible(),false);
  assert.equal(await f.page.locator('#notice').textContent(),'Sign in as administrator.');
  assert.equal(f.migration.migration.mode,'source');
});
