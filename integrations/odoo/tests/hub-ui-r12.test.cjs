/* Full embed UI verification with synthetic records only.
 * Every HTTP request is fulfilled offline. No real Odoo/provider/FCM action.
 * Only the final init() invocation is replaced with a lexical test export;
 * all HTML, CSS, renderers, event handlers and request functions are production.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { chromium } = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright');

const file = process.env.SH_TEST_EMBED || path.resolve(__dirname, '../smart-handicrafts-whatsapp-embed-r13.html');
const html = fs.readFileSync(file, 'utf8');
const htmlHash = crypto.createHash('sha256').update(html).digest('hex');
const marker = '  init();\n})();';
assert.equal(html.split(marker).length, 2, 'Exactly one application boot call is replaced for the offline fixture');
const testExport = `  window.__hubUiTest = {state, hubLabels, hubPhotoDimensions, hubCallHistory,
    renderChannels, renderMessages, loadMessages, selectChannel, renderSelectedHeader,
    renderCustomerDrawerContent, openCustomerDrawer, loadHubLabels, openHubLabels,
    openHubLabelEditor, saveHubLabelDefinition, saveHubLabelAssignments, applyFiltersAndRender,
    showPanel, hidePanel, openHubActionPicker, openChannelActions, openMailCenter, openMailDrawer,
    openHubCallsPage, renderHubCallsPage, mergeWhatsappCallLogs, destroyOperatorApp, init};
})();`;
const instrumented = html.replace(marker, testExport);
const evidenceDir = path.resolve(__dirname, 'ui-r12-evidence');
fs.mkdirSync(evidenceDir, { recursive: true });
const results = [];
const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SH Operator Hub — OFFLINE DEMO</title>
<style>body{margin:0}#wrapwrap{transform:translateZ(0);width:92%;margin:auto}.container{max-width:1140px;transform:translateZ(0)}#top,#bottom{height:90px;background:red}#oe_main_menu_navbar,.o-livechat-root{position:fixed;bottom:0;right:0;background:red;z-index:999999}</style></head>
<body><div id="oe_main_menu_navbar">DEMO ODOO EDIT BAR</div><div id="wrapwrap"><header id="top">DEMO HOST HEADER</header><main id="wrap"><div class="container">${instrumented}</div></main><footer id="bottom">DEMO HOST FOOTER</footer></div><div class="o-livechat-root">DEMO HOST LIVE CHAT</div></body></html>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#eadfcd"/><path d="M170 340V145q0-60 70-60h160q70 0 70 60v195z" fill="#16805e"/><circle cx="320" cy="220" r="75" fill="#c8af73"/><text x="320" y="415" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#143d2c">DEMO PHOTO · NO CUSTOMER DATA</text></svg>`;
const field = (type = 'char', relation) => ({ type, ...(relation ? { relation } : {}), readonly: false });
const commonFields = Object.fromEntries(['name','display_name','body','preview','date','email','phone','mobile','street','city','vat','state','amount_total','currency_id','date_order','invoice_date','payment_state','move_type','mimetype','type','url','file_size','attachment_ids','author_id','create_uid','starred_partner_ids','needaction_partner_ids'].map(key => [key, field()]));
const channelFields = { ...commonFields, id: field('integer'), channel_type: field(), whatsapp_number: field(),
  whatsapp_partner_id: field('many2one','res.partner'), livechat_conversation_tag_ids: field('many2many','im_livechat.conversation.tag') };
let browser;
test.before(async () => {
  assert.ok(process.env.SH_TEST_CHROMIUM, 'Set SH_TEST_CHROMIUM to the local Chromium executable');
  browser = await chromium.launch({ headless: true, executablePath: process.env.SH_TEST_CHROMIUM, args: ['--no-sandbox'] });
});
test.after(async () => {
  await browser?.close();
  fs.writeFileSync(path.join(evidenceDir, 'results.json'), JSON.stringify({ source: file, sha256: htmlHash,
    environment: 'Offline Chromium; synthetic data; no physical phone/provider/notification testing', results }, null, 2));
});

function messagesFor(channelId) {
  const now = Date.now();
  const date = offset => new Date(now - offset).toISOString().replace('T',' ').replace(/\.\d+Z$/, '');
  return [
    { id: channelId * 10 + 1, model: 'discuss.channel', res_id: channelId, date: date(180000), body: '<p>Hello — this is an offline demonstration.</p>',
      author_id: [channelId + 500, `Demo Customer ${channelId === 101 ? 'A' : 'B'}`], create_uid: [1,'Demo System'], message_type:'whatsapp_message', attachment_ids: [] },
    { id: channelId * 10 + 2, model:'discuss.channel', res_id:channelId, date:date(120000), body:'<p>We can prepare a quotation for your handcrafted lamp.</p>',
      author_id:[7,'Demo Operator'], create_uid:[7,'Demo Operator'], message_type:'whatsapp_message', attachment_ids:[] },
    { id:channelId * 10 + 3, model:'discuss.channel', res_id:channelId, date:date(60000), body:'',
      author_id:[7,'Demo Operator'], create_uid:[7,'Demo Operator'], message_type:'whatsapp_message', attachment_ids:[901] }
  ];
}

async function fixture({ width = 390, height = 844, mobile = true, rights = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: mobile,
    hasTouch: mobile, colorScheme:'light', serviceWorkers:'block',
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' : undefined });
  const page = await context.newPage(), errors = [], requests = [], held = new Map();
  const config = { rights, failMessages: false, holdMessages: new Set(), labels: [{id:501,name:'Demo customer',color:4}],
    assignments: new Map([[101,[501]],[102,[]]]), messages: new Map([[101,messagesFor(101)],[102,messagesFor(102)]]) };
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    requests.push({ url: req.url(), method:req.method(), type:req.resourceType(), body:req.postData() });
    if (req.isNavigationRequest() && url.pathname === '/livechat-api-test') return route.fulfill({ contentType:'text/html; charset=utf-8', body:doc });
    if (req.resourceType() === 'image' || url.pathname.startsWith('/web/image/')) return route.fulfill({ contentType:'image/svg+xml', body:svg });
    if (url.pathname.startsWith('/web/dataset/call_kw/')) {
      let packet; try { packet = JSON.parse(req.postData() || '{}'); } catch { packet = {}; }
      const { model, method, args = [] } = packet.params || {};
      let result = [];
      if (method === 'fields_get') result = model === 'discuss.channel' ? channelFields : model === 'im_livechat.conversation.tag' ? {id:field('integer'),name:field(),color:field('integer')} : {id:field('integer'),...commonFields};
      else if (method === 'has_access') result = config.rights;
      else if (model === 'mail.message' && method === 'search_read') {
        const channelId = Number((args[0] || []).find(item => Array.isArray(item) && item[0] === 'res_id')?.[2]);
        if (config.holdMessages.has(channelId)) { held.set(channelId, {route, packet}); return; }
        if (config.failMessages) return route.fulfill({ status:500, contentType:'application/json', body:JSON.stringify({error:{message:'Synthetic network interruption'}}) });
        result = (config.messages.get(channelId) || []).slice().reverse();
      } else if (model === 'ir.attachment' && method === 'search_read') result = [{id:901,name:'Demo product photo',mimetype:'image/svg+xml',type:'binary',file_size:1024}];
      else if (model === 'im_livechat.conversation.tag' && method === 'search_read') result = config.labels;
      else if (model === 'im_livechat.conversation.tag' && method === 'create') {
        const values = Array.isArray(args[0]) ? args[0][0] : args[0];
        if (!config.rights) return route.fulfill({ contentType:'application/json', body:JSON.stringify({error:{message:'Synthetic AccessError',data:{name:'odoo.exceptions.AccessError',message:'Labels are read-only.'}}}) });
        const id = 600 + config.labels.length; config.labels.push({id,...values}); result = id;
      } else if (model === 'im_livechat.conversation.tag' && method === 'write') {
        for (const id of args[0]) Object.assign(config.labels.find(item => item.id === id), args[1]); result = true;
      } else if (model === 'discuss.channel' && method === 'read') result = (args[0] || []).map(id => ({id,livechat_conversation_tag_ids:config.assignments.get(id) || []}));
      else if (model === 'discuss.channel' && method === 'write') {
        for (const id of args[0] || []) {
          const selected = new Set(config.assignments.get(id) || []);
          for (const [op,labelId] of args[1]?.livechat_conversation_tag_ids || []) { if (op === 4) selected.add(labelId); else if (op === 3) selected.delete(labelId); }
          config.assignments.set(id, [...selected]);
        }
        result = true;
      } else if (model === 'res.partner' && method === 'search_read') result = [{id:601,name:'Demo Customer A',phone:'+919999000101',email:'demo-a@example.invalid',city:'Demo city'}];
      else if (['mark_as_read','channel_seen','set_channel_seen'].includes(method)) result = true;
      return route.fulfill({ contentType:'application/json', body:JSON.stringify({jsonrpc:'2.0',id:packet.id,result}) });
    }
    if (url.pathname === '/web/session/get_session_info') return route.fulfill({ contentType:'application/json', body:JSON.stringify({result:{uid:7,partner_id:7,name:'Demo Operator',db:'offline-demo'}}) });
    // Unknown routes never reach the network, and never receive real authority.
    return route.fulfill({ status:503, contentType:'application/json', body:JSON.stringify({ok:false,error:'Offline fixture: service unavailable.'}) });
  });
  await page.goto('https://www.smarthandicrafts.com/livechat-api-test');
  await page.waitForFunction(() => !!window.__hubUiTest);
  await page.evaluate(({messages,fields}) => {
    const h=window.__hubUiTest, now=Date.now();
    Object.assign(h.state,{session:{uid:7,partner_id:7,name:'Demo Operator',db:'offline-demo'},autoRefreshEnabled:false,
      channels:[
        {id:101,display_name:'Demo Customer A',channel_type:'whatsapp',whatsapp_number:'919999000101',whatsapp_partner_id:[601,'Demo Customer A'],whatsapp_channel_active:true,whatsapp_channel_valid_until:new Date(now+86400000).toISOString(),_uiUnreadCount:3,last_interest_dt:new Date(now-30000).toISOString(),livechat_conversation_tag_ids:[501]},
        {id:102,display_name:'Demo Customer B',channel_type:'whatsapp',whatsapp_number:'919999000102',whatsapp_partner_id:[602,'Demo Customer B'],whatsapp_channel_active:true,whatsapp_channel_valid_until:new Date(now+86400000).toISOString(),_uiUnreadCount:0,last_interest_dt:new Date(now-100000).toISOString(),livechat_conversation_tag_ids:[]},
        {id:103,display_name:'Demo Website Visitor',channel_type:'livechat',_uiUnreadCount:2,last_interest_dt:new Date(now-200000).toISOString()},
        {id:104,display_name:'Demo Handicrafts Team',channel_type:'group',member_count:4,_uiUnreadCount:0,last_interest_dt:new Date(now-300000).toISOString()}
      ],latestMessagesByChannel:{101:messages[0],102:{...messages[1],res_id:102},103:{id:1,body:'<p>Offline website enquiry</p>',date:new Date(now-200000).toISOString()},104:{id:2,body:'<p>Demo team follow-up</p>',date:new Date(now-300000).toISOString()}},
      modelFields:{'discuss.channel':fields,'mail.message':{'id':{type:'integer'},'starred_partner_ids':{type:'many2many'}}},
      attachmentsById:{901:{id:901,name:'Demo product photo',mimetype:'image/svg+xml',type:'binary',file_size:1024}}
    });
    document.getElementById('shAuthState').classList.add('is-hidden');document.getElementById('shAppLayout').classList.remove('is-hidden');
    h.applyFiltersAndRender();
  }, {messages:messagesFor(101),fields:channelFields});
  await page.waitForFunction(() => document.querySelector('#shChannelList [data-channel-id="101"]')?.getBoundingClientRect().width > 0);
  async function releaseMessages(id, rows = config.messages.get(id)) {
    const pending = held.get(id); assert.ok(pending, `Message request ${id} was held`); held.delete(id); config.holdMessages.delete(id);
    await pending.route.fulfill({contentType:'application/json',body:JSON.stringify({jsonrpc:'2.0',id:pending.packet.id,result:rows.slice().reverse()})});
  }
  return {page,context,errors,requests,config,held,releaseMessages,close:()=>context.close()};
}
async function screenshot(page,name) { await page.screenshot({path:path.join(evidenceDir,`${name}.png`),fullPage:false}); }
function check(name, run) {
  test(name, async () => {
    try { await run(); results.push({name,status:'Passed',evidence:'Offline full-embed Chromium test'}); }
    catch (error) { results.push({name,status:'Failed',error:String(error.message)}); throw error; }
  });
}

check('all production inline scripts parse and full embed initializes with synthetic state', async () => {
  let count=0;
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if(/type\s*=\s*["']application\/(?:json|ld\+json)/i.test(match[1]) || !match[2].trim())continue;
    new vm.Script(match[2],{filename:`production-inline-${++count}.js`});
  }
  assert.ok(count>0);
  const f=await fixture();
  try { assert.deepEqual(f.errors,[]); assert.equal(await f.page.locator('#shChannelList [data-channel-id]').count(),4); }
  finally {await f.close();}
});

check('390px inbox is a single app surface with modern Chats heading and hidden Odoo host chrome', async () => {
  const f=await fixture();try {
    const g=await f.page.evaluate(()=>{
      const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,b:r.bottom,right:r.right};};
      return {app:box('shOperatorApp'),list:box('shChannelList'),vw:innerWidth,vh:innerHeight,
        host:['top','bottom','oe_main_menu_navbar'].map(id=>getComputedStyle(document.getElementById(id)).display),
        widget:getComputedStyle(document.querySelector('.o-livechat-root')).display,
        title:document.querySelector('.sh-op-inbox-title-row h3').textContent,
        titleSize:parseFloat(getComputedStyle(document.querySelector('.sh-op-inbox-title-row h3')).fontSize),
        overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.equal(g.title,'Chats');assert.ok(g.titleSize>=30);assert.deepEqual(g.host,['none','none','none']);assert.equal(g.widget,'none');
    assert.equal(g.app.x,0);assert.equal(g.app.y,0);assert.equal(g.app.w,390);assert.equal(g.app.h,844);assert.equal(g.overflow,false);
    assert.ok(g.list.b<=844);await screenshot(f.page,'mobile-inbox-light-demo');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('desktop renders inbox and selected chat as two non-overlapping panels', async()=>{
  const f=await fixture({width:1366,height:900,mobile:false});try{
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    const g=await f.page.evaluate(()=>{const a=document.querySelector('.sh-op-inbox').getBoundingClientRect(),b=document.getElementById('shChatPanel').getBoundingClientRect();return{a:{x:a.x,w:a.width,right:a.right,h:a.height},b:{x:b.x,w:b.width,right:b.right,h:b.height},vw:innerWidth};});
    assert.ok(g.a.w>250&&g.a.w<550);assert.ok(g.b.w>650);assert.ok(g.b.x>=g.a.right-1);assert.ok(g.b.right<=g.vw+1);assert.ok(g.a.h>700&&g.b.h>700);
    await screenshot(f.page,'desktop-two-panel-demo');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('mobile composer stays within resized viewport and keeps the draft when keyboard space is reduced', async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    await f.page.locator('#shMessageInput').fill('Demo unsent draft — preserve while typing');
    await f.page.setViewportSize({width:390,height:480});
    await f.page.waitForFunction(()=>document.getElementById('shOperatorApp').style.getPropertyValue('--sh-app-height')==='480px');
    const g=await f.page.evaluate(()=>{const input=document.getElementById('shMessageInput'),r=input.getBoundingClientRect(),c=document.querySelector('.sh-op-composer').getBoundingClientRect(),thread=document.getElementById('shMessageThread').getBoundingClientRect();return{input:{x:r.x,right:r.right,top:r.top,bottom:r.bottom},composer:{top:c.top,bottom:c.bottom},thread:{top:thread.top,bottom:thread.bottom},draft:input.value,keyboard:document.getElementById('shOperatorApp').classList.contains('sh-keyboard-open')};});
    assert.equal(g.draft,'Demo unsent draft — preserve while typing');assert.equal(g.keyboard,true);
    assert.ok(g.input.top>=0&&g.input.bottom<=480);assert.ok(g.input.x>=0&&g.input.right<=390);assert.ok(g.composer.bottom<=481);assert.ok(g.thread.bottom<=g.composer.top+1);
    await screenshot(f.page,'mobile-resized-keyboard-space-demo');
    await f.page.setViewportSize({width:390,height:844});
    await f.page.waitForFunction(()=>document.getElementById('shOperatorApp').style.getPropertyValue('--sh-app-height')==='844px');
    assert.equal(await f.page.locator('#shMessageInput').inputValue(),'Demo unsent draft — preserve while typing');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('late message response for chat A cannot replace selected chat B', async()=>{
  const f=await fixture();try{
    f.config.messages.get(101)[0].body='<p>DEMO A LATE RESPONSE</p>';
    f.config.messages.get(102)[0].body='<p>DEMO B CURRENT CONVERSATION</p>';
    f.config.holdMessages.add(101);
    await f.page.evaluate(()=>{window.__pendingSelectA=__hubUiTest.selectChannel(101);});
    await f.page.waitForFunction(()=>__hubUiTest.state.messageRequests.has('101'));
    await f.page.evaluate(()=>__hubUiTest.selectChannel(102));
    await f.releaseMessages(101);await f.page.evaluate(()=>window.__pendingSelectA);
    assert.equal(await f.page.locator('#shSelectedName').innerText(),'Demo Customer B');
    assert.equal(await f.page.locator('#shMessageThread').getAttribute('data-channel-id'),'102');
    assert.match(await f.page.locator('#shMessageThread').innerText(),/DEMO B CURRENT CONVERSATION/);
    assert.doesNotMatch(await f.page.locator('#shMessageThread').innerText(),/DEMO A LATE RESPONSE/);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.messages.every(m=>m.res_id===102)),true);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('drafts are kept independently when switching chats and refreshing messages', async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));await f.page.locator('#shMessageInput').fill('Draft A — no send');
    await f.page.evaluate(()=>__hubUiTest.selectChannel(102));assert.equal(await f.page.locator('#shMessageInput').inputValue(),'');
    await f.page.locator('#shMessageInput').fill('Draft B — no send');
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));assert.equal(await f.page.locator('#shMessageInput').inputValue(),'Draft A — no send');
    await f.page.evaluate(()=>__hubUiTest.loadMessages(101,{force:true}));assert.equal(await f.page.locator('#shMessageInput').inputValue(),'Draft A — no send');
    await f.page.evaluate(()=>__hubUiTest.selectChannel(102));assert.equal(await f.page.locator('#shMessageInput').inputValue(),'Draft B — no send');
    assert.equal(f.requests.some(r=>String(r.body).includes('message_post')),false);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('failed thread refresh keeps the rendered messages and photo instead of blanking the conversation', async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    await f.page.evaluate(()=>{window.__beforeFailureArticle=document.querySelector('[data-message-id="1011"]');window.__beforeFailureImage=document.querySelector('#shMessageThread img');});
    f.config.failMessages=true;
    const success=await f.page.evaluate(()=>__hubUiTest.loadMessages(101,{force:true}));assert.equal(success,false);
    assert.match(await f.page.locator('#shThreadSyncStatus').innerText(),/conversation is kept/);
    assert.equal(await f.page.evaluate(()=>window.__beforeFailureArticle===document.querySelector('[data-message-id="1011"]')&&window.__beforeFailureImage===document.querySelector('#shMessageThread img')),true);
    assert.equal(await f.page.locator('#shMessageThread').getAttribute('aria-busy'),'false');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('reading an older message keeps its visible anchor when a new message and missed call arrive', async()=>{
  const f=await fixture();try{
    const base=messagesFor(101)[0],now=Date.now();
    f.config.messages.set(101,Array.from({length:45},(_,index)=>({...base,id:1100+index,body:`<p>Demo history line ${index+1}. Synthetic conversation content for scroll verification.</p>`,date:new Date(now-(45-index)*60000).toISOString()})));
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    const result=await f.page.evaluate(()=>{
      const h=__hubUiTest,thread=document.getElementById('shMessageThread');thread.scrollTop=thread.scrollHeight*.45;
      const top=thread.getBoundingClientRect().top,node=[...thread.children].find(n=>n.hasAttribute('data-render-key')&&n.getBoundingClientRect().bottom>top+1),before=node.getBoundingClientRect().top-top,key=node.dataset.renderKey;
      h.state.messages.push({...h.state.messages.at(-1),id:1200,body:'<p>Demo newly arrived message</p>',date:new Date().toISOString()});
      h.mergeWhatsappCallLogs([{call_id:'demo-scroll-missed',event:'missed',direction:'incoming',customer_phone:'919999000101',timestamp:Date.now()/1000}]);
      h.renderMessages({scrollToBottom:false});
      return{same:node===thread.querySelector(`[data-render-key="${key}"]`),before,after:node.getBoundingClientRect().top-thread.getBoundingClientRect().top,nearBottom:thread.scrollHeight-thread.scrollTop-thread.clientHeight<88};
    });
    assert.equal(result.same,true);assert.ok(Math.abs(result.after-result.before)<=1);assert.equal(result.nearBottom,false);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('sent/received photos and photo albums have no extra frame and survive 100 missed-call refreshes', async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    await f.page.evaluate(()=>{
      const h=__hubUiTest,base=h.state.messages.at(-1);
      h.state.attachmentsById[902]={id:902,name:'Demo second photo',mimetype:'image/svg+xml'};
      h.state.messages.push({...base,id:1014,author_id:[601,'Demo Customer A'],attachment_ids:[902],date:new Date().toISOString()},
        {...base,id:1015,attachment_ids:[901,902],date:new Date().toISOString()});
      h.mergeWhatsappCallLogs([{call_id:'demo-missed-1',event:'missed',direction:'incoming',customer_phone:'919999000101',customer_name:'Demo Customer A',timestamp:Date.now()/1000}]);h.renderMessages({scrollToBottom:true});
    });
    await f.page.waitForFunction(()=>[...document.querySelectorAll('#shMessageThread img')].every(img=>img.complete&&img.naturalWidth>0));
    await f.page.evaluate(()=>__hubUiTest.renderMessages());
    const g=await f.page.evaluate(()=>{
      const h=__hubUiTest,thread=document.getElementById('shMessageThread'),images=[...thread.querySelectorAll('img')],cards=[...thread.querySelectorAll('[data-message-id]')],call=thread.querySelector('.sh-wa-call-thread-card');
      const frames=[...thread.querySelectorAll('.sh-op-attachment-image,.sh-op-media-frame')].map(node=>{const s=getComputedStyle(node);return{border:s.borderWidth,shadow:s.boxShadow,padding:s.padding};});
      const bubbles=[...thread.querySelectorAll('[data-photo-layout]>.sh-op-bubble')].map(node=>{const s=getComputedStyle(node);return{border:s.borderWidth,padding:s.padding};});
      const observer=new MutationObserver(()=>{});observer.observe(thread,{subtree:true,childList:true,characterData:true,attributes:true});
      const existingCall={...h.state.whatsappCallLogs.find(c=>c.call_id==='demo-missed-1')};
      for(let i=0;i<100;i++){h.mergeWhatsappCallLogs([existingCall]);h.renderMessages({scrollToBottom:false});}
      const mutations=observer.takeRecords().length;observer.disconnect();
      return{imagesStable:images.every((node,i)=>node===thread.querySelectorAll('img')[i]),cardsStable:cards.every((node,i)=>node===thread.querySelectorAll('[data-message-id]')[i]),callStable:call===thread.querySelector('.sh-wa-call-thread-card'),mutations,frames,bubbles,layouts:[...thread.querySelectorAll('[data-photo-layout]')].map(n=>n.dataset.photoLayout)};
    });
    assert.equal(g.imagesStable,true);assert.equal(g.cardsStable,true);assert.equal(g.callStable,true);assert.equal(g.mutations,0);
    assert.ok(g.layouts.includes('single')&&g.layouts.includes('album'));for(const s of g.frames){assert.equal(s.border,'0px');assert.equal(s.shadow,'none');assert.equal(s.padding,'0px');}for(const s of g.bubbles){assert.equal(s.border,'0px');assert.equal(s.padding,'0px');}
    await screenshot(f.page,'mobile-photo-album-demo');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('tapping the actual chat name opens contact info with customer and sales tools', async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));await f.page.locator('#shSelectedContactInfo').click();
    await f.page.waitForFunction(()=>document.querySelector('#shCustomerDrawerBody .sh-contact-profile h2')?.textContent==='Demo Customer A');
    const text=await f.page.locator('#shCustomerDrawer').innerText();assert.match(text,/Contact info/);assert.match(text,/Demo Customer A/);assert.match(text,/Quotation|quotation/);assert.match(text,/Follow|follow/);assert.match(text,/Media, links/);
    const box=await f.page.locator('#shCustomerDrawer').boundingBox();assert.equal(box.x,0);assert.equal(box.y,0);assert.equal(box.width,390);assert.ok(box.height<=844);
    await screenshot(f.page,'mobile-contact-info-demo');
    await f.page.locator('#shCustomerDrawer [data-close-panel="shCustomerDrawer"]').click();
    assert.equal(await f.page.locator('#shCustomerDrawer').isVisible(),false);assert.equal(await f.page.locator('#shChatPanel').isVisible(),true);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('labels are created with a chosen colour, confirmed by Odoo mock, then applied without replacing unrelated labels', async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>__hubUiTest.openHubLabels(101));
    await f.page.locator('#shLabelCreateBtn').click();
    await f.page.locator('#shLabelNameInput').fill('Demo priority');await f.page.locator('[data-label-color="5"]').click();
    assert.equal(await f.page.locator('[data-label-color="5"]').getAttribute('aria-pressed'),'true');
    assert.equal(await f.page.locator('#shLabelColourPalette button').count(),12);await screenshot(f.page,'mobile-label-colour-demo');
    await f.page.locator('#shLabelEditorSave').click();
    await f.page.waitForFunction(()=>__hubUiTest.hubLabels.records.some(r=>r.name==='Demo priority')&&!__hubUiTest.hubLabels.editor.saving);
    assert.equal(f.config.labels.find(r=>r.name==='Demo priority').color,5);
    await f.page.locator('#shLabelsSaveBtn').click();
    await f.page.waitForFunction(()=>!__hubUiTest.hubLabels.view.saving&&document.getElementById('shLabelsPanel').classList.contains('is-hidden'));
    assert.deepEqual(f.config.assignments.get(101),[501,601]);
    const writes=f.requests.filter(r=>r.body&&r.url.includes('/discuss.channel/write')).map(r=>JSON.parse(r.body).params.args[1]);
    assert.deepEqual(writes,[{livechat_conversation_tag_ids:[[4,601,0]]}]);
    assert.match(await f.page.locator('#shChannelList [data-channel-id="101"]').innerText(),/Demo priority/);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('read-only Odoo label permissions disable create/edit/apply instead of pretending a local save succeeded', async()=>{
  const f=await fixture({rights:false});try{
    await f.page.evaluate(()=>__hubUiTest.openHubLabels(101));
    assert.equal(await f.page.locator('#shLabelCreateBtn').isDisabled(),true);assert.equal(await f.page.locator('#shLabelsSaveBtn').isDisabled(),true);
    assert.match(await f.page.locator('#shLabelsError').innerText(),/cannot change/);
    await f.page.evaluate(()=>__hubUiTest.openHubLabelEditor());
    assert.equal(await f.page.locator('#shLabelEditorPanel').isVisible(),false);
    assert.equal(f.requests.some(r=>/\/(create|write)$/.test(new URL(r.url).pathname)),false);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('system dark mode changes live without reloading images or losing a draft', async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));await f.page.locator('#shMessageInput').fill('Draft survives theme switch');
    const light=await f.page.locator('.sh-op-inbox').evaluate(node=>getComputedStyle(node).backgroundColor);
    await f.page.evaluate(()=>{window.__themePhoto=document.querySelector('#shMessageThread img');});
    await f.page.emulateMedia({colorScheme:'dark'});await f.page.waitForFunction(()=>document.getElementById('shOperatorApp').dataset.systemTheme==='dark');
    const dark=await f.page.locator('.sh-op-inbox').evaluate(node=>getComputedStyle(node).backgroundColor);
    assert.notEqual(dark,light);assert.equal(await f.page.locator('#shMessageInput').inputValue(),'Draft survives theme switch');
    assert.equal(await f.page.evaluate(()=>window.__themePhoto===document.querySelector('#shMessageThread img')),true);
    await screenshot(f.page,'mobile-chat-dark-demo');
    await f.page.emulateMedia({colorScheme:'light'});await f.page.waitForFunction(()=>document.getElementById('shOperatorApp').dataset.systemTheme==='light');
    assert.equal(await f.page.locator('.sh-op-inbox').evaluate(node=>getComputedStyle(node).backgroundColor),light);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('missed-call page filters real rendered history rows and preserves them on unchanged refresh', async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>{const h=__hubUiTest;h.mergeWhatsappCallLogs([
      {call_id:'demo-call-missed',event:'missed',direction:'incoming',customer_phone:'919999000101',customer_name:'Demo Customer A',timestamp:Date.now()/1000},
      {call_id:'demo-call-ended',event:'terminate',direction:'outgoing',customer_phone:'919999000102',customer_name:'Demo Customer B',timestamp:Date.now()/1000-60,duration_seconds:64}
    ]);h.hubCallHistory.loadedAt=Date.now();return h.openHubCallsPage();});
    assert.equal(await f.page.locator('#shCallsPageList [data-call-history-key]').count(),2);
    await f.page.locator('#shCallsPage [data-call-filter="missed"]').click();assert.equal(await f.page.locator('#shCallsPageList [data-call-history-key]').count(),1);
    assert.match(await f.page.locator('#shCallsPageList').innerText(),/Demo Customer A/);
    const stable=await f.page.evaluate(()=>{const node=document.querySelector('#shCallsPageList [data-call-history-key]');for(let n=0;n<100;n++)__hubUiTest.renderHubCallsPage();return node===document.querySelector('#shCallsPageList [data-call-history-key]');});
    assert.equal(stable,true);await screenshot(f.page,'mobile-missed-calls-demo');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('mail folder, camera picker and conversation menus render clean text and SVG icons', async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>__hubUiTest.openMailCenter());await f.page.evaluate(()=>__hubUiTest.openMailDrawer());
    const mail=await f.page.locator('#shMailDrawer').innerText();assert.match(mail,/Mail folders/);assert.match(mail,/All mail/);assert.match(mail,/Starred/);assert.doesNotMatch(mail,/â|Ã|Â·|ðŸ/);
    assert.ok(await f.page.locator('#shMailDrawer svg').count()>3);await screenshot(f.page,'mobile-mail-folders-demo');
    await f.page.evaluate(()=>{__hubUiTest.hidePanel(document.getElementById('shMailDrawer'));__hubUiTest.hidePanel(document.getElementById('shMailCenter'));__hubUiTest.openHubActionPicker('camera');});
    assert.equal(await f.page.locator('#shHubPickerTitle').innerText(),'Camera — choose chat');
    assert.doesNotMatch(await f.page.locator('#shHubActionPickerPanel').innerText(),/â|Ã|Â·|ðŸ/);
    await screenshot(f.page,'mobile-camera-picker-demo');
    await f.page.evaluate(()=>{__hubUiTest.hidePanel(document.getElementById('shHubActionPickerPanel'));__hubUiTest.openChannelActions(101);});
    const actions=await f.page.locator('#shChannelActionPanel').innerText();assert.match(actions,/Add to favorites/);assert.match(actions,/Contact info/);assert.doesNotMatch(actions,/â|Ã|Â·|ðŸ/);assert.ok(await f.page.locator('#shChannelActionPanel svg').count()>3);
    await screenshot(f.page,'mobile-conversation-actions-demo');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('touch chrome suppresses selection, message long press exposes Copy, and desktop message selection remains available', async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    const g=await f.page.evaluate(()=>{
      const title=document.getElementById('shSelectedName'),input=document.getElementById('shMessageInput'),text=document.querySelector('.sh-op-bubble-text');
      const event=new Event('selectstart',{bubbles:true,cancelable:true});title.dispatchEvent(event);
      const editEvent=new Event('selectstart',{bubbles:true,cancelable:true});input.dispatchEvent(editEvent);
      const chatEvent=new Event('selectstart',{bubbles:true,cancelable:true});text.dispatchEvent(chatEvent);
      return{titleSelect:getComputedStyle(title).userSelect,textSelect:getComputedStyle(text).userSelect,inputSelect:getComputedStyle(input).userSelect,
        outsidePrevented:event.defaultPrevented,inputPrevented:editEvent.defaultPrevented,textPrevented:chatEvent.defaultPrevented,
        viewport:document.querySelector('meta[name="viewport"]').content};
    });
    assert.equal(g.titleSelect,'none');assert.equal(g.textSelect,'none');assert.equal(g.inputSelect,'text');assert.equal(g.outsidePrevented,true);assert.equal(g.inputPrevented,false);assert.equal(g.textPrevented,false);
    assert.match(g.viewport,/user-scalable=no/);assert.match(g.viewport,/viewport-fit=cover/);assert.deepEqual(f.errors,[]);
    await f.page.evaluate(()=>{
      const node=document.querySelector('[data-message-id="1011"] .sh-op-bubble'),r=node.getBoundingClientRect();
      const touch=new Touch({identifier:1,target:node,clientX:r.x+10,clientY:r.y+10});
      node.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,cancelable:true,touches:[touch],targetTouches:[touch],changedTouches:[touch]}));
    });
    await f.page.locator('#shMessageActionPanel [data-message-action="copy"]').waitFor({state:'visible'});
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.selectedActionMessageId),1011);
  }finally{await f.close();}
  const desktop=await fixture({width:1366,height:900,mobile:false});try{
    await desktop.page.evaluate(()=>__hubUiTest.selectChannel(101));
    assert.equal(await desktop.page.locator('.sh-op-bubble-text').first().evaluate(node=>getComputedStyle(node).userSelect),'text');
  }finally{await desktop.close();}
});
