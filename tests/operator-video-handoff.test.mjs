import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {VideoLinks} from '../call-runtime/video-links.mjs';
const require = createRequire(import.meta.url);
const engine = process.env.SH_VIDEO_BROWSER_ENGINE || 'chromium';
const browserType = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright')[engine];
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

async function fixture(t, {userAgent = iphone, delay = false, failure = false, clipboardFails = false, native = false, ipad = false} = {}) {
  const service = new VideoLinks({authorize:async()=>({deviceId:'handoff-phone',nativeBuild:25}),
    env:{SH_VIDEO_LINKS_ENABLED:'true',SH_VIDEO_TURN_KEY_ID:'fixture',SH_VIDEO_TURN_API_TOKEN:'fixture'},
    fetchImpl:async()=>({ok:true,json:async()=>({iceServers:[]})})});
  const app = express(); app.use(express.json()); service.mount(app);
  app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  let release; const gate = new Promise(r => {release = r;});
  t.after(()=>{release(); service.close(); server.closeAllConnections(); server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const links=await service.create({}, {requestId:'browser-handoff-001'});
  const link=new URL(native ? links.operatorUrl : links.customerUrl);
  const browser=await browserType.launch(engine==='chromium' ? {executablePath:process.env.SH_TEST_CHROMIUM,headless:true,args:['--no-sandbox']} : {headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:320,height:568},userAgent});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({clipboardFails,native,ipad})=>{
    // Exercise the compatibility path independently of the host engine version.
    Object.defineProperty(crypto,'randomUUID',{configurable:true,value:undefined});
    Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
    if(ipad) Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,value:5});
    window.copied=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{if(clipboardFails)throw new Error('Blocked');window.copied.push(value);}}});
    if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Refused','NotAllowedError');};
    if(native) window.SHVideoNative={postMessage:()=>{}};
  },{clipboardFails,native,ipad});
  // The HTTPS browser origin is fulfilled by the isolated local server. No
  // production requests, real cameras or custom-scheme app launches occur.
  await page.route('https://video.example.test/**',async route=>{
    const request=route.request(), url=new URL(request.url());
    if(url.pathname==='/api/sh-video/invitation') {
      if(delay) await gate;
      if(failure) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'Invitation temporarily unavailable.'})});
    }
    const response=await fetch(base+url.pathname+url.search,{method:request.method(),headers:request.headers(),body:request.postData()||undefined});
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  const url='https://video.example.test'+link.pathname+link.hash;
  await page.goto(url);
  return {page,service,url,release,errors,room:[...service.rooms.values()][0]};
}

test('iPhone browser help is available before slow invitation lookup; opening or copying does not claim a seat',async t=>{
  const f=await fixture(t,{delay:true}), {page}=f;
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Opening your invitation…');
  await page.locator('#browserHelp summary').click();
  assert.equal(await page.locator('#browser').getAttribute('href'),f.url.replace('https:','googlechromes:'));
  assert.match(await page.locator('#browserGuide').innerText(),/Safari/);
  await page.getByRole('button',{name:'Copy link for Safari',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.copied),[f.url]);
  assert.equal(f.room.roles.customer.clientId,undefined);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  f.release(); await page.waitForFunction(()=>!document.getElementById('join').disabled);
  assert.deepEqual(f.errors,[],'missing randomUUID/AbortSignal.timeout cannot strand the page');
});

test('iPhone permission refusal keeps Safari fallback and leaves the invitation unclaimed',async t=>{
  const f=await fixture(t), {page}=f;
  await page.getByRole('button',{name:'Join video call',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Allow camera and microphone access to join.');
  assert.equal(await page.locator('#browserHelp').isVisible(),true);
  assert.equal(await page.locator('#browser').isVisible(),true);
  assert.equal(f.room.roles.customer.clientId,undefined);
  if(process.env.SH_VIDEO_HANDOFF_SCREENSHOT) await page.screenshot({path:process.env.SH_VIDEO_HANDOFF_SCREENSHOT,fullPage:true});
  await page.goto('about:blank');
  assert.equal(f.room.ended,false,'leaving for Safari before Join must not end the operator room');
  assert.deepEqual(f.errors,[]);
});

test('failed lookup and denied clipboard still expose a selectable complete invitation',async t=>{
  const f=await fixture(t,{failure:true,clipboardFails:true}), {page}=f;
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Invitation temporarily unavailable.');
  await page.locator('#browserHelp summary').click();
  await page.getByRole('button',{name:'Copy link for Safari',exact:true}).click();
  assert.equal(await page.locator('#browserUrl').inputValue(),f.url);
  assert.equal(await page.locator('#browserUrl').isVisible(),true);
  assert.match(await page.locator('#browserFeedback').innerText(),/choose Copy/);
  assert.equal(await page.evaluate(()=>{const e=document.getElementById('browserUrl');return e.selectionEnd-e.selectionStart;}),f.url.length);
  assert.equal(f.room.roles.customer.clientId,undefined); assert.deepEqual(f.errors,[]);
});

test('iPad desktop user agent receives the iOS browser route',async t=>{
  const f=await fixture(t,{ipad:true,userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/15.3 Safari/605.1.15'});
  await f.page.locator('#browserHelp summary').click();
  assert.equal(await f.page.locator('#browser').getAttribute('href'),f.url.replace('https:','googlechromes:'));
  assert.equal(await f.page.getByRole('button',{name:'Copy link for Safari',exact:true}).isVisible(),true);
});

test('Android retains its intent link even when the in-app browser is not named in the user agent',async t=>{
  const f=await fixture(t,{userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'});
  await f.page.locator('#browserHelp summary').click();
  const target=await f.page.locator('#browser').getAttribute('href');
  assert.ok(target.startsWith('intent://video.example.test/v/'));
  assert.ok(target.includes('package=com.android.chrome;'));
  assert.ok(target.includes('S.browser_fallback_url='+encodeURIComponent(f.url)+';end'));
  assert.deepEqual(f.errors,[]);
});

test('native operator screen never exposes its private capability in browser handoff controls',async t=>{
  const f=await fixture(t,{native:true});
  await f.page.waitForFunction(()=>document.getElementById('status').textContent==='Allow camera and microphone access to join.');
  assert.equal(await f.page.locator('#browserHelp').isVisible(),false);
  assert.equal(await f.page.locator('#browserUrl').inputValue(),'');
  assert.equal(await f.page.locator('#browser').getAttribute('href'),null);
  assert.deepEqual(f.errors,[]);
});
