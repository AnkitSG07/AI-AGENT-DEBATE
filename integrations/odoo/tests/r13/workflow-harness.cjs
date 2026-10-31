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

const file = process.env.SH_TEST_EMBED || path.resolve(__dirname, '../../smart-handicrafts-whatsapp-embed-r13.html');
const html = fs.readFileSync(file, 'utf8');
const htmlHash = crypto.createHash('sha256').update(html).digest('hex');
const marker = '  init();\n})();';
assert.equal(html.split(marker).length, 2, 'Exactly one application boot call is replaced for the offline fixture');
const main = html.slice(html.lastIndexOf('<script', html.indexOf('  init();\n})();')), html.indexOf('  init();\n})();'));
const exportedNames = [...new Set([...main.matchAll(/^  (?:async )?function ([A-Za-z0-9_$]+)\(/gm)].map(m=>m[1]))];
const testExport = '  window.__hubUiTest = {state, hubLabels, hubPhotoDimensions, hubCallHistory, shAiRuntime,' + exportedNames.join(',') + '};\n})();';
const instrumented = html.replace(marker, testExport);
const evidenceDir = path.resolve(__dirname, 'workflow-evidence');
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
async function launch() {
  browser = await chromium.launch({ headless:true, executablePath:process.env.SH_TEST_CHROMIUM, args:['--no-sandbox'] });
  return browser;
}
async function finish() { await browser?.close(); }

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

async function fixture({ width = 390, height = 844, mobile = true, rights = true, services = null, connect = false } = {}) {
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
    if (services && await services(route, url, req)) return;
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
  if (connect) await page.evaluate(() => window.SHOperatorAuth?.connect());
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
module.exports = { launch, finish, fixture, messagesFor, screenshot, sourceHash: htmlHash, exportedNames };
