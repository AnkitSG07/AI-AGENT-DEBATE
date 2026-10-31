/* Offline browser regression tests against functions extracted from the shipped
 * Odoo embed. All requests are fulfilled locally; no customer call is placed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { androidDir, backendDir } = require('./source-paths.cjs');
const vm = require('node:vm');
const { chromium } = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright');
const html = fs.readFileSync(process.env.SH_TEST_EMBED || path.resolve(__dirname, '../smart-handicrafts-whatsapp-embed-r13.html'), 'utf8');
const bridge = fs.readFileSync(path.join(androidDir, 'app/src/main/assets/sh-native-room-bridge.js'), 'utf8');
function fn(name) {
  const start = html.indexOf(`  function ${name}(`);
  assert(start >= 0, `production function ${name} exists`);
  const end = html.indexOf('\n  }', start);
  assert(end > start, `production function ${name} has its own closing brace`);
  const source = html.slice(start, end + 4);
  new vm.Script(source);
  return source;
}
const functions = ['escapeHtml', 'hasHubNativeBridge', 'hubNativeRoomCapabilities', 'whatsappOpaqueId',
  'whatsappNativeProviderId', 'whatsappCallKey', 'setWhatsappCallAttribute', 'setWhatsappCallClass',
  'bindWhatsappCallControlIds', 'closeReleasedNativeCallUi', 'syncWhatsappIncomingUi',
  'findIncomingWhatsappCall', 'findAnswerableWhatsappCall', 'whatsappCallIsOpenForAnswer',
  'normalizedWhatsappCallEvent', 'whatsappCallLockedByOther', 'whatsappCallEventTimeMs',
  'whatsappCallTimeMs', 'whatsappCallHasRemoteOffer', 'whatsappCallRemoteOffer',
  'stopWhatsappRingtone', 'syncWhatsappRingtone', 'whatsappSoundButtonLabel',
  'closeWhatsappCallPanel', 'whatsappCallIconMarkup', 'renderNodeKey', 'reconcileChildren', 'patchKeyedChildren'];
const production = functions.map(fn).join('\n');
let browser;
test.before(async () => { browser = await chromium.launch({headless:true, executablePath:process.env.SH_TEST_CHROMIUM, args:['--no-sandbox']}); });
test.after(async () => { await browser?.close(); });
async function fixture() {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><style>.is-hidden{display:none}</style>
    <div id="shOperatorApp"><div id="shWhatsappIncomingBanner"></div><div id="shWhatsappCallPanel">
    <div id="shWhatsappCallCurrent"></div><button id="shWhatsappCallAcceptBtn">Accept</button>
    <button id="shWhatsappCallRejectBtn">Decline</button><button id="shWhatsappCallEndBtn">End call</button>
    <button id="shWhatsappCallTransferBtn">Transfer call</button><button id="shWhatsappCallClose">Close</button></div></div>`}));
  await page.goto('https://www.smarthandicrafts.com/livechat-api-test');
  await page.addScriptTag({content:`
    var byId=id=>document.getElementById(id), appRoot=byId('shOperatorApp');
    var whatsappCallPanel=byId('shWhatsappCallPanel'), whatsappCallCurrent=byId('shWhatsappCallCurrent');
    var whatsappCallAcceptBtn=byId('shWhatsappCallAcceptBtn'), whatsappCallRejectBtn=byId('shWhatsappCallRejectBtn');
    var whatsappCallEndBtn=byId('shWhatsappCallEndBtn'), whatsappCallTransferBtn=byId('shWhatsappCallTransferBtn');
    var state={destroyed:false,autoRefreshEnabled:true,whatsappCallLogs:[],selectedChannel:null,whatsappCallPanelOpen:true,session:{uid:7}};
    var whatsappCallsRuntime={suppressed:new Set(),notified:new Set(),toneNodes:new Set(),soundMuted:false,notificationReadOnlyKey:''};
    var focusedWhatsappCall=()=>state.focused||null, whatsappOperatorAvailable=()=>true;
    var isPendingWhatsappSourceTransfer=()=>false, callEventMatchesChannel=()=>true;
    var whatsappOperatorIdentity=()=>({operator_device_id:'synthetic-device'});
    var whatsappCallParty=call=>({name:call.customer_name||'Synthetic caller',phone:call.customer_phone||'',channel:null});
    var whatsappCallCurrentStatus=()=> 'Incoming WhatsApp call', setTextIfChanged=(node,value)=>{if(node&&node.textContent!==String(value))node.textContent=String(value)};
    var hidePanel=panel=>panel.classList.add('is-hidden'), parseOdooUtc=value=>new Date(value), normalizePhoneForCompare=value=>String(value||'').replace(/\\D/g,'');
    var ringPulses=0, playWhatsappRingPulse=()=>ringPulses++;
    window.sent=[];window.SHNative={postMessage:message=>sent.push(JSON.parse(message))};
    window.SHNativeCapabilities={nativeRoomCalls:true,protocol:'sh-room-audio-v1',activeCall:false};
    ${production}
    document.getElementById('shWhatsappCallClose').onclick=closeWhatsappCallPanel;
    ${bridge}
  `});
  return page;
}

test('every inline JavaScript block in the release embed parses', () => {
  let count=0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/type\s*=\s*["']application\/(?:json|ld\+json)/i.test(match[1]) || !match[2].trim()) continue;
    new vm.Script(match[2],{filename:`embed-script-${++count}.js`});
  }
  assert(count>0);
});

test('panel buttons preserve the actual displayed provider ID and rendered key separately', async () => {
  const p=await fixture();
  await p.evaluate(()=>{var call={call_id:'wa:panel',event:'connect'};bindWhatsappCallControlIds(call,call);});
  assert.deepEqual(await p.evaluate(()=>[whatsappCallPanel.dataset.callId,whatsappCallAcceptBtn.dataset.callKey,whatsappCallAcceptBtn.dataset.providerCallId]),['wa:panel','session:wa:panel','wa:panel']);
  await p.click('#shWhatsappCallAcceptBtn');await p.click('#shWhatsappCallRejectBtn');
  assert.deepEqual(await p.evaluate(()=>sent.map(x=>[x.action,x.callId])),[['accept','wa:panel'],['reject','wa:panel']]);
  await p.close();
});

test('conflicting call ID aliases and generic event rows cannot create native call controls', async () => {
  const p=await fixture();
  assert.deepEqual(await p.evaluate(()=>[
    whatsappNativeProviderId({call_id:'one',callId:'two'}),whatsappNativeProviderId({id:'log-row-3'}),
    whatsappNativeProviderId({call_id:'session:opaque',callId:'session:opaque'})]),['','','session:opaque']);
  await p.evaluate(()=>bindWhatsappCallControlIds({id:'row-3'},{id:'row-3'}));
  await p.click('#shWhatsappCallEndBtn'); assert.equal(await p.evaluate(()=>sent[0].action),'unavailable');await p.close();
});

test('native outgoing attempt can be reopened before the provider ID arrives', async () => {
  const p=await fixture();
  await p.evaluate(()=>{Object.assign(SHNativeCapabilities,{activeCall:true,callDisplayName:'Synthetic caller',callState:'preparing'});syncWhatsappIncomingUi();});
  assert.match(await p.locator('#shWhatsappIncomingBanner').innerText(),/Connecting audio/);
  await p.click('[data-whatsapp-call-action="native-current"]');
  assert.deepEqual(await p.evaluate(()=>sent[0]),{type:'native-call',action:'current'});await p.close();
});

test('native banner uses actual audio state and preserves nodes through 100 unchanged refreshes', async () => {
  const p=await fixture();
  const result=await p.evaluate(()=>{
    Object.assign(SHNativeCapabilities,{activeCall:true,activeCallId:'native-1',activeProviderCallId:'wa:1',callDisplayName:'Customer',callState:'ringing'});
    syncWhatsappIncomingUi();const banner=byId('shWhatsappIncomingBanner'),name=banner.querySelector('strong'),button=banner.querySelector('button');
    const ringing=banner.textContent;const observer=new MutationObserver(()=>{});observer.observe(banner,{subtree:true,childList:true,characterData:true,attributes:true});
    for(let n=0;n<100;n++)syncWhatsappIncomingUi();const unchanged=observer.takeRecords().length;observer.disconnect();
    SHNativeCapabilities.callState='connected';syncWhatsappIncomingUi();const connected=banner.textContent;
    SHNativeCapabilities.callState='reconnecting';syncWhatsappIncomingUi();
    return {ringing,connected,reconnecting:banner.textContent,unchanged,sameName:name===banner.querySelector('strong'),sameButton:button===banner.querySelector('button')};
  });
  assert.match(result.ringing,/Ringing/);assert.doesNotMatch(result.ringing,/in progress/);assert.match(result.connected,/Call in progress/);assert.match(result.reconnecting,/Reconnecting audio/);
  assert.equal(result.unchanged,0);assert.equal(result.sameName,true);assert.equal(result.sameButton,true);await p.close();
});

test('native close immediately dismisses the matching panel without inventing a terminal history event', async () => {
  const p=await fixture();
  const result=await p.evaluate(()=>{
    const call={call_id:'wa:1',event:'connect',direction:'incoming',timestamp:Date.now()/1000,sdp_type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};
    state.whatsappCallLogs=[call];state.focused=call;bindWhatsappCallControlIds(call,call);
    closeReleasedNativeCallUi({localReleased:true,callId:'native-1',providerCallId:'wa:1'});
    return {closed:whatsappCallPanel.classList.contains('is-hidden'),open:state.whatsappCallPanelOpen,event:call.event,suppressed:whatsappCallsRuntime.suppressed.has('session:wa:1'),answerable:whatsappCallIsOpenForAnswer(call),bannerHidden:byId('shWhatsappIncomingBanner').classList.contains('is-hidden')};
  });
  assert.deepEqual(result,{closed:true,open:false,event:'connect',suppressed:true,answerable:false,bannerHidden:true});await p.close();
});

test('closing an older call does not dismiss the different displayed customer', async () => {
  const p=await fixture();
  await p.evaluate(()=>{state.focused={call_id:'wa:new',event:'accepted'};state.whatsappCallLogs=[state.focused];bindWhatsappCallControlIds(state.focused,null);closeReleasedNativeCallUi({localReleased:true,providerCallId:'wa:old'});});
  assert.equal(await p.locator('#shWhatsappCallPanel').evaluate(node=>node.classList.contains('is-hidden')),false);await p.close();
});

test('browser ringtone is silent when native audio controls the app', async () => {
  const p=await fixture();
  const pulses=await p.evaluate(()=>{whatsappCallsRuntime.audioContext={state:'running'};syncWhatsappRingtone({call_id:'wa:ring'});return ringPulses;});
  assert.equal(pulses,0);await p.close();
});

test('old ringing records cannot offer Answer for the native call already in progress', async () => {
  const p=await fixture();
  const result=await p.evaluate(()=>{
    const call={call_id:'wa:1',event:'connect',direction:'incoming',timestamp:Date.now()/1000,sdp_type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};
    Object.assign(SHNativeCapabilities,{activeCall:true,activeCallId:'native-1',activeProviderCallId:'wa:1'});
    return [whatsappCallIsOpenForAnswer(call),whatsappCallIsOpenForAnswer({...call,call_id:'wa:2'})];
  });
  assert.deepEqual(result,[false,true]);await p.close();
});

test('End is stamped with the displayed native attempt and ownership leg', async () => {
  const p=await fixture();
  await p.evaluate(()=>{
    Object.assign(SHNativeCapabilities,{activeCall:true,activeCallId:'native-1',activeProviderCallId:'wa:1',activeAttemptId:'00000000-0000-4000-8000-000000000001',activeOwnerLegId:'leg-1',callState:'connected'});
    syncWhatsappIncomingUi();
  });
  await p.click('#shWhatsappIncomingBanner [data-whatsapp-call-action="end"]');
  assert.deepEqual(await p.evaluate(()=>sent[0]),{type:'native-call',action:'end',callId:'native-1',clientAttemptId:'00000000-0000-4000-8000-000000000001',ownerLegId:'leg-1'});await p.close();
});

test('a delayed first-leg close cannot suppress the same call transferred back to this phone', async () => {
  const p=await fixture();
  const result=await p.evaluate(()=>{
    Object.assign(SHNativeCapabilities,{activeCall:true,activeCallId:'native-1',activeProviderCallId:'wa:1',activeAttemptId:'00000000-0000-4000-8000-000000000003',activeOwnerLegId:'leg-3'});
    state.focused={call_id:'wa:1',event:'accepted'};state.whatsappCallLogs=[state.focused];
    closeReleasedNativeCallUi({localReleased:true,callId:'native-1',providerCallId:'wa:1',clientAttemptId:'00000000-0000-4000-8000-000000000001',ownerLegId:'leg-1'});
    return {closed:whatsappCallPanel.classList.contains('is-hidden'),suppressed:whatsappCallsRuntime.suppressed.has('session:wa:1')};
  });
  assert.deepEqual(result,{closed:false,suppressed:false});await p.close();
});
