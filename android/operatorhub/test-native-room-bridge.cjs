/* Synthetic offline DOM routing tests. No real Odoo, Render, LiveKit or customer requests. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright');
const bridge = fs.readFileSync(process.env.SH_TEST_BRIDGE || path.join(__dirname, 'app/src/main/assets/sh-native-room-bridge.js'), 'utf8');
const guard = fs.readFileSync(process.env.SH_TEST_TRANSFER_GUARD || path.join(__dirname, 'app/src/main/assets/sh-call-transfer-guard.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'tests/fixtures/r8-native-call-entry.html'), 'utf8');
let browser;
test.before(async () => {
  const cached = '/root/.cache/hyperframes/chrome/chrome-headless-shell/linux-152.0.7977.30/chrome-headless-shell-linux64/chrome-headless-shell';
  const executablePath = process.env.SH_TEST_CHROMIUM || (fs.existsSync(cached) ? cached : undefined);
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); });
async function fixture({ enabled = true, url = 'https://www.smarthandicrafts.com/livechat-api-test' } = {}) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.addInitScript({ content: `window.sent=[];window.legacy=0;window.SHNative={postMessage:s=>window.sent.push(JSON.parse(s))};window.SHNativeCapabilities={nativeRoomCalls:${enabled},protocol:'sh-room-audio-v1'};\n${bridge}\n${guard}\ndocument.addEventListener('click',()=>window.legacy++);` });
  await page.goto(url); return page;
}
test('capability false preserves existing call click', async () => {
  const p = await fixture({ enabled: false }); await p.click('#shWhatsappCallBtn');
  assert.deepEqual(await p.evaluate(() => [sent.length, legacy]), [0, 1]); await p.close();
});
test('actual R8 header routes exact phone/channel once before old handlers', async () => {
  const p = await fixture(); await p.click('#shWhatsappCallBtn');
  assert.deepEqual(await p.evaluate(() => sent), [{ type: 'native-call', action: 'start', phone: '919999000001', channelId: 101, displayName: 'Synthetic Customer' }]);
  assert.equal(await p.evaluate(() => legacy), 0); await p.close();
});
test('a phone in a name is never inferred when explicit phone is absent', async () => {
  const p = await fixture(); await p.evaluate(() => { document.querySelector('#shSelectedName').textContent='Name (919999000099)'; document.querySelector('#shSelectedSubline').textContent='WhatsApp'; });
  await p.click('#shWhatsappCallBtn'); assert.equal(await p.evaluate(() => sent[0].action), 'dial'); assert.equal(await p.evaluate(() => sent[0].phone), ''); await p.close();
});
test('contact drawer uses its explicit number, not a different selected chat', async () => {
  const p = await fixture(); await p.click('[data-drawer-action="call"]'); assert.equal(await p.evaluate(() => sent[0].phone), '919999000002'); assert.equal(await p.evaluate(() => sent[0].channelId), 0); await p.close();
});
test('history callback uses exact call key and no stale selected phone', async () => {
  const p = await fixture(); await p.click('[data-call-history-dial]');
  assert.deepEqual(await p.evaluate(() => sent[0]), { type:'native-call',action:'callback',callId:'wa:history-1' }); await p.close();
});
test('keyed Accept and Reject preserve the exact incoming ID', async () => {
  const p = await fixture(); await p.click('[data-whatsapp-call-action="accept"]'); await p.click('[data-whatsapp-call-action="reject"]');
  assert.deepEqual(await p.evaluate(() => sent.map(x => [x.action,x.callId])), [['accept','wa:incoming-1'],['reject','wa:incoming-1']]); await p.close();
});
test('unkeyed old panel never guesses an incoming call', async () => {
  const p = await fixture(); await p.click('#shWhatsappCallAcceptBtn'); assert.deepEqual(await p.evaluate(() => sent[0]), { type:'native-call',action:'incoming' }); await p.close();
});
test('native active call opens rather than placing another call', async () => {
  const p = await fixture(); await p.evaluate(() => SHNativeCapabilities.activeCallId='out_current'); await p.click('#shWhatsappCallBtn');
  assert.deepEqual(await p.evaluate(() => sent[0]), { type:'native-call',action:'open',callId:'out_current' }); await p.close();
});
test('manual dial uses the explicit input and unrelated tools remain untouched', async () => {
  const p = await fixture(); await p.click('#shWhatsappCallStartBtn'); await p.click('#ordinary');
  assert.equal(await p.evaluate(() => sent[0].phone), '919999000003'); assert.equal(await p.evaluate(() => legacy), 1); await p.close();
});
test('untrusted synthetic click does not trigger native media entry', async () => {
  const p = await fixture(); await p.evaluate(() => document.querySelector('#shWhatsappCallBtn').click()); assert.equal(await p.evaluate(() => sent.length), 0); await p.close();
});
test('bridge is disabled outside the exact Hub page', async () => {
  const p = await fixture({ url:'https://www.smarthandicrafts.com/web/login' }); await p.click('#shWhatsappCallBtn'); assert.equal(await p.evaluate(() => sent.length), 0); await p.close();
});

test('stale keyed End preserves its original ID instead of the new active call', async () => {
  const p = await fixture(); await p.evaluate(() => { SHNativeCapabilities.activeCallId='new-native-call'; const button=document.querySelector('#shWhatsappCallEndBtn');button.setAttribute('data-whatsapp-call-action','end');button.setAttribute('data-call-key','old-provider-call'); });
  await p.click('#shWhatsappCallEndBtn'); assert.deepEqual(await p.evaluate(() => sent[0]), { type:'native-call',action:'end',callId:'old-provider-call' }); await p.close();
});
test('local release closes only the exact keyed old call panel and banner', async () => {
  const p = await fixture(); await p.evaluate(() => {
    const panel=document.getElementById('shWhatsappCallPanel');document.getElementById('shWhatsappCallCurrent').setAttribute('data-call-id','wa:incoming-1');
    const button=document.createElement('button');button.id='shWhatsappCallClose';button.onclick=()=>panel.classList.add('is-hidden');panel.append(button);
    window.dispatchEvent(new CustomEvent('sh-native-call-closed',{detail:{localReleased:true,callId:'native-session',providerCallId:'wa:incoming-1'}}));
  });
  assert.deepEqual(await p.evaluate(() => [document.getElementById('shWhatsappCallPanel').classList.contains('is-hidden'),document.getElementById('shWhatsappIncomingBanner').classList.contains('is-hidden'),sent.length]), [true,true,0]);await p.close();
});
test('release of a different call leaves current panels and unrelated chat alone', async () => {
  const p = await fixture(); await p.evaluate(() => { document.getElementById('shWhatsappCallCurrent').setAttribute('data-call-id','wa:different-call');window.dispatchEvent(new CustomEvent('sh-native-call-closed',{detail:{localReleased:true,callId:'ended-session',providerCallId:'ended-provider'}})); });
  assert.deepEqual(await p.evaluate(() => [document.getElementById('shWhatsappCallPanel').classList.contains('is-hidden'),document.getElementById('shWhatsappIncomingBanner').classList.contains('is-hidden'),sent.length]), [false,false,0]);await p.close();
});

test('keyed panel Accept and Decline route the displayed call without opening a chooser', async () => {
  const p = await fixture();
  await p.evaluate(() => {
    document.getElementById('shWhatsappCallCurrent').dataset.callId='wa:displayed';
    document.getElementById('shWhatsappCallAcceptBtn').dataset.callKey='wa:displayed';
    document.getElementById('shWhatsappCallRejectBtn').dataset.callKey='wa:displayed';
  });
  await p.click('#shWhatsappCallAcceptBtn'); await p.click('#shWhatsappCallRejectBtn');
  assert.deepEqual(await p.evaluate(() => sent.map(x=>[x.action,x.callId])), [['accept','wa:displayed'],['reject','wa:displayed']]);
  await p.close();
});

test('an outgoing attempt without a provider ID reopens the native call instead of starting another', async () => {
  const p = await fixture();
  await p.evaluate(() => { SHNativeCapabilities.activeCall=true; SHNativeCapabilities.activeCallId=''; });
  await p.click('#shWhatsappCallBtn'); await p.click('#shWhatsappNewCallBtn');
  assert.deepEqual(await p.evaluate(() => sent), [{type:'native-call',action:'current'},{type:'native-call',action:'current'}]);
  await p.close();
});

test('native transfer capability enables the exact current call while legacy transfer endpoints remain blocked', async () => {
  const p = await fixture();
  await p.evaluate(() => {
    document.getElementById('shWhatsappCallCurrent').dataset.callId='wa:current';
    document.getElementById('shWhatsappCallTransferBtn').dataset.nativeAttemptId='00000000-0000-4000-8000-000000000001';
    Object.assign(SHNativeCapabilities,{activeCall:true,activeCallId:'native-current',activeProviderCallId:'wa:current',activeAttemptId:'00000000-0000-4000-8000-000000000001',canTransfer:true});
    window.dispatchEvent(new CustomEvent('sh-native-capabilities',{detail:SHNativeCapabilities}));
  });
  assert.equal(await p.locator('#shWhatsappCallTransferBtn').isEnabled(), true);
  await p.click('#shWhatsappCallTransferBtn');
  assert.deepEqual(await p.evaluate(() => sent[0]), {type:'native-call',action:'transfer',callId:'native-current',clientAttemptId:'00000000-0000-4000-8000-000000000001'});
  assert.equal(await p.evaluate(async()=> (await fetch('https://ai-agent-debate.onrender.com/api/operator-call-transfer/request',{method:'POST',body:'{}'})).status),501);
  await p.close();
});

test('a different call panel cannot transfer the active native call', async () => {
  const p = await fixture();
  await p.evaluate(() => {
    document.getElementById('shWhatsappCallCurrent').dataset.callId='wa:old';
    Object.assign(SHNativeCapabilities,{activeCall:true,activeCallId:'native-current',activeProviderCallId:'wa:current',canTransfer:true});
    window.dispatchEvent(new CustomEvent('sh-native-capabilities',{detail:SHNativeCapabilities}));
  });
  assert.equal(await p.locator('#shWhatsappCallTransferBtn').isEnabled(),false);
  assert.equal(await p.evaluate(()=>sent.length),0); await p.close();
});

test('native capability revocation disables transfer immediately', async () => {
  const p = await fixture();
  await p.evaluate(() => {
    document.getElementById('shWhatsappCallCurrent').dataset.callId='wa:current';
    document.getElementById('shWhatsappCallTransferBtn').dataset.nativeAttemptId='00000000-0000-4000-8000-000000000001';
    Object.assign(SHNativeCapabilities,{activeCall:true,activeCallId:'native-current',activeProviderCallId:'wa:current',activeAttemptId:'00000000-0000-4000-8000-000000000001',canTransfer:true});
    window.dispatchEvent(new CustomEvent('sh-native-capabilities',{detail:SHNativeCapabilities}));
  });
  assert.equal(await p.locator('#shWhatsappCallTransferBtn').isEnabled(),true);
  await p.evaluate(() => { SHNativeCapabilities.canTransfer=false; window.dispatchEvent(new CustomEvent('sh-native-capabilities',{detail:SHNativeCapabilities})); });
  assert.equal(await p.locator('#shWhatsappCallTransferBtn').isEnabled(),false); await p.close();
});

test('a generic event row ID cannot answer, reject, or end the newer native call', async () => {
  const p = await fixture();
  await p.evaluate(() => {
    SHNativeCapabilities.activeCallId='new-call';
    for (const id of ['shWhatsappCallAcceptBtn','shWhatsappCallRejectBtn','shWhatsappCallEndBtn']) document.getElementById(id).dataset.callKey='event:log-row-17';
  });
  await p.click('#shWhatsappCallAcceptBtn'); await p.click('#shWhatsappCallRejectBtn'); await p.click('#shWhatsappCallEndBtn');
  assert.deepEqual(await p.evaluate(()=>sent.map(x=>x.action)),['unavailable','unavailable','unavailable']);
  assert.equal(await p.evaluate(()=>legacy),0); await p.close();
});

test('an explicit opaque provider ID is preserved even when it begins with session:', async () => {
  const p = await fixture();
  await p.evaluate(() => {
    const b=document.getElementById('shWhatsappCallAcceptBtn'); b.dataset.providerCallId='session:opaque-provider'; b.dataset.callKey='session:session:opaque-provider';
  });
  await p.click('#shWhatsappCallAcceptBtn');
  assert.deepEqual(await p.evaluate(()=>sent[0]),{type:'native-call',action:'accept',callId:'session:opaque-provider'}); await p.close();
});

test('event-only call history opens the dialer without submitting the row ID to the call API', async () => {
  const p = await fixture(); await p.evaluate(()=>document.querySelector('[data-call-history-key]').dataset.callHistoryKey='event:log-row-9');
  await p.click('[data-call-history-dial]'); assert.deepEqual(await p.evaluate(()=>sent[0]),{type:'native-call',action:'dial'}); await p.close();
});

test('history with an explicit customer phone starts directly without a redundant call lookup', async () => {
  const p=await fixture();
  await p.evaluate(()=>{const row=document.querySelector('[data-call-history-key]');row.dataset.callHistoryPhone='+91 99990 00005';row.dataset.callHistoryName='History customer';});
  await p.click('[data-call-history-dial]');
  assert.deepEqual(await p.evaluate(()=>sent[0]),{type:'native-call',action:'start',phone:'919999000005',displayName:'History customer'}); await p.close();
});

test('return-to-call banner opens the early native attempt before it has a provider ID', async () => {
  const p=await fixture();
  await p.evaluate(()=>{SHNativeCapabilities.activeCall=true;const b=document.createElement('button');b.dataset.whatsappCallAction='native-current';b.textContent='Return to call';document.getElementById('shOperatorApp').append(b);});
  await p.click('[data-whatsapp-call-action="native-current"]');
  assert.deepEqual(await p.evaluate(()=>sent[0]),{type:'native-call',action:'current'}); await p.close();
});

test('an old same-call End keeps its captured attempt and ownership leg instead of adopting the new ones', async () => {
  const p=await fixture();
  await p.evaluate(()=>{
    Object.assign(SHNativeCapabilities,{activeCall:true,activeCallId:'same-call',activeAttemptId:'00000000-0000-4000-8000-000000000003',activeOwnerLegId:'leg-3'});
    const b=document.getElementById('shWhatsappCallEndBtn');b.dataset.callKey='session:same-call';b.dataset.nativeAttemptId='00000000-0000-4000-8000-000000000001';b.dataset.ownerLegId='leg-1';
  });
  await p.click('#shWhatsappCallEndBtn');
  assert.deepEqual(await p.evaluate(()=>sent[0]),{type:'native-call',action:'end',callId:'same-call',clientAttemptId:'00000000-0000-4000-8000-000000000001',ownerLegId:'leg-1'});await p.close();
});

test('a delayed close from the first A leg does not hide the call after A to B to A transfer', async () => {
  const p=await fixture();
  await p.evaluate(()=>{
    const panel=document.getElementById('shWhatsappCallPanel');document.getElementById('shWhatsappCallCurrent').dataset.callId='wa:incoming-1';
    const b=document.createElement('button');b.id='shWhatsappCallClose';b.onclick=()=>panel.classList.add('is-hidden');panel.append(b);
    Object.assign(SHNativeCapabilities,{activeCall:true,activeCallId:'same-call',activeProviderCallId:'wa:incoming-1',activeAttemptId:'00000000-0000-4000-8000-000000000003',activeOwnerLegId:'leg-3'});
    window.dispatchEvent(new CustomEvent('sh-native-call-closed',{detail:{localReleased:true,callId:'same-call',providerCallId:'wa:incoming-1',clientAttemptId:'00000000-0000-4000-8000-000000000001',ownerLegId:'leg-1'}}));
  });
  assert.equal(await p.locator('#shWhatsappCallPanel').evaluate(node=>node.classList.contains('is-hidden')),false);
  assert.equal(await p.locator('#shWhatsappIncomingBanner').evaluate(node=>node.classList.contains('is-hidden')),false);await p.close();
});

test('an old transfer control stays disabled after the same call returns on a new attempt', async () => {
  const p=await fixture();
  await p.evaluate(()=>{
    document.getElementById('shWhatsappCallCurrent').dataset.callId='wa:current';
    document.getElementById('shWhatsappCallTransferBtn').dataset.nativeAttemptId='00000000-0000-4000-8000-000000000001';
    Object.assign(SHNativeCapabilities,{activeCall:true,activeCallId:'native-current',activeProviderCallId:'wa:current',activeAttemptId:'00000000-0000-4000-8000-000000000003',canTransfer:true});
    window.dispatchEvent(new CustomEvent('sh-native-capabilities',{detail:SHNativeCapabilities}));
  });
  assert.equal(await p.locator('#shWhatsappCallTransferBtn').isEnabled(),false);await p.close();
});
