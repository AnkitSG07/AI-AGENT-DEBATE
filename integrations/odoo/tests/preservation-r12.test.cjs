/* Bounded preservation tests against functions extracted unmodified from the
 * release embed. All Odoo/backend operations are synthetic, with no network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(process.env.SH_TEST_EMBED || path.resolve(__dirname, '../smart-handicrafts-whatsapp-embed-r13.html'), 'utf8');
const START = 1800000000000;
const copy = value => JSON.parse(JSON.stringify(value));
function fn(name) {
  const marker = [`  function ${name}(`, `  async function ${name}(`].find(value => html.includes(value));
  assert.ok(marker, `Production function ${name} exists`);
  const start = html.indexOf(marker), end = html.indexOf('\n  }', start);
  assert.ok(end > start, `Production function ${name} has its own closing brace`);
  const result = html.slice(start, end + 4); new vm.Script(result); return result;
}
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
function fixture(names, extras = {}) {
  let clock = START;
  const calls = [], toasts = [], fields = {}, storage = new Map();
  const channel = {id:101,channel_type:'whatsapp',whatsapp_number:'919999000101',whatsapp_channel_active:true,whatsapp_channel_valid_until:new Date(START+60000).toISOString()};
  const node = () => ({value:'',disabled:false,textContent:'',classList:{add(){},remove(){},contains(){return true;}},setAttribute(){}});
  const c = {
    Date: class extends Date { static now(){return clock;} }, console: {warn(){},log(){}},
    state:{selectedChannel:channel,selectedChannelId:101,channels:[channel],destroyed:false,customerLinksByChannel:new Map(),partnerCache:{},modelFields:{},aiMode:'manual',aiServerGlobal:{mode:'manual',epoch:'demo-ai',revision:0},latestMessagesByChannel:{101:{id:1}},aiProcessedMessageIds:{}},
    messageInput:{value:'Offline caption'},attachFileBtn:node(),attachmentInput:node(),composerWarning:node(),
    updateComposerState(){calls.push({kind:'composer-state'});},showOperatorToast(message){toasts.push(message);},autoGrowTextarea(){},
    async messagePost(id,values){calls.push({kind:'message',id,values:copy(values)});return 1;},
    async uploadAttachmentToCurrentThread(file,target){calls.push({kind:'upload',id:target.id});return 901;},
    async loadMessages(){},async loadChannels(){},
    async loadModelFields(model){return fields[model]||{};},
    async callKw(model,method,args){calls.push({kind:'method',model,method,args:copy(args)});return true;},
    async createRecord(model,values){calls.push({kind:'create',model,values:copy(values)});return model==='sale.order'?801:601;},
    async writeRecords(model,ids,values){calls.push({kind:'write',model,ids:copy(ids),values:copy(values)});return true;},
    async searchReadAvailable(model,domain){calls.push({kind:'read',model,domain:copy(domain)});return model==='whatsapp.template'?[{id:301,status:'approved',name:'Offline approved template'}]:[];},
    renderWhatsappTemplatePanel(){},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    AI_MODE_SERVER_BACKGROUND:true,AI_MODE_BACKEND_BASE:'https://backend.invalid',
    shAiRuntime:{syncQueue:Promise.resolve(),revision:0,readRevision:0,confirmedMode:null,pending:false},syncAiModeUi(){},
    async appFetch(url,options){const body=options.body?JSON.parse(options.body):null;calls.push({kind:'fetch',url,method:options.method,body:copy(body)});return {ok:true,json:async()=>body?({ok:true,mode:body.mode,epoch:body.expectedEpoch,revision:body.expectedRevision+1}):({ok:true,mode:'manual',epoch:'demo-ai',revision:0})};},
    customerFormContext:null,customerSaveBtn:node(),customerFormError:node(),customerFormModal:node(),customerDrawer:null,
    customerFormFields:()=>[],gatherCustomerFormValues:()=>({name:'Offline customer'}),
    hideInlineError(){},showInlineError(target,message){target.textContent=message;},hidePanel(){},showPanel(){},
    byId:()=>null,setTextIfChanged(){},openCustomerDrawer:async()=>{},openCustomerFormModal:async()=>{calls.push({kind:'open-customer'});},
    window:{open(){return {location:{href:''},close(){}};},alert(message){toasts.push(message);}},
    followupError:node(),followupModal:node(),followupSaveBtn:node(),followupDateInput:node(),followupSummaryInput:node(),followupNoteInput:node(),followupTypeInput:{value:'7'},
    defaultFollowupDate:()=> '2027-01-17',loadFollowupOptions:async()=>{},currentUserId:()=>7,channelDisplayName:c=>c.display_name||'Offline customer',
    ...extras
  };
  // New helpers are included only when present, so the same behavior tests can
  // also execute the captured old entrypoints without inventing old guards.
  const helpers=['isApprovedWhatsappTemplate','requireApprovedWhatsappTemplate','confirmedAiMode','aiModeSnapshot','loadAiModeFromServer']
    .filter(name=>html.includes(`  function ${name}(`)||html.includes(`  async function ${name}(`));
  vm.createContext(c); vm.runInContext([...new Set([...names,...helpers])].map(fn).join('\n\n'),c,{timeout:1000});
  return {c,calls,toasts,fields,storage,channel,setClock:value=>{clock=value;}};
}
const windowFns=['parseOdooUtc','isWhatsappWindowOpen','postTextToChannel','sendAttachmentsFromInput'];
const templateFns=['safeId','normalizeCreateResult','partnerIdFromChannel','buildWizardValue','isUnavailableWhatsappSendMethod','unconfirmedWhatsappTemplateSend','sendWhatsappTemplateWithFallbacks','sendWhatsappTemplateToPartnerWithFallbacks'];
const aiFns=['normalizeAiMode','isAiReplyEnabledMode','syncAiModeToServer','saveAiProcessedMessageIds','markAiMessageProcessed','markCurrentInboxLatestAsProcessed','setAiMode','initializeAiModeFromServer'];

test('closed WhatsApp window blocks both free text and attachments before any Odoo operation',async()=>{
  const f=fixture(windowFns);f.channel.whatsapp_channel_active=false;
  assert.equal(await f.c.postTextToChannel(f.channel,'offline text'),false);
  await f.c.sendAttachmentsFromInput([{name:'offline.jpg'}]);
  assert.equal(f.calls.some(c=>c.kind==='message'||c.kind==='upload'),false);
});
test('reply window uses strict expiry and explicit inactive flag, leaving Live Chat comments available',async()=>{
  const f=fixture(windowFns);
  f.channel.whatsapp_channel_valid_until=new Date(START).toISOString();assert.equal(f.c.isWhatsappWindowOpen(f.channel),false);
  f.channel.whatsapp_channel_valid_until=new Date(START+1).toISOString();assert.equal(f.c.isWhatsappWindowOpen(f.channel),true);
  f.channel.whatsapp_channel_active=false;assert.equal(f.c.isWhatsappWindowOpen(f.channel),false);
  await f.c.postTextToChannel({id:102,channel_type:'livechat'},'offline text',{reload:false});
  assert.equal(f.calls.find(c=>c.kind==='message').values.message_type,'comment');
});
test('attachment upload spanning window expiry must not post a WhatsApp message',async()=>{
  const gate=deferred(),f=fixture(windowFns,{uploadAttachmentToCurrentThread:()=>gate.promise});
  const pending=f.c.sendAttachmentsFromInput([{name:'offline.jpg'}]);
  f.setClock(START+60001);gate.resolve(901);await pending;
  assert.equal(f.calls.filter(c=>c.kind==='message').length,0,'Expired reply window must be checked after uploads.');
  assert.equal(f.c.messageInput.value,'Offline caption');
});
test('fresh inbox closure of the original channel during upload must stop the attachment send',async()=>{
  const gate=deferred(),f=fixture(windowFns,{uploadAttachmentToCurrentThread:()=>gate.promise});
  const pending=f.c.sendAttachmentsFromInput([{name:'offline.jpg'}]);
  f.c.state.channels=[{...f.channel,whatsapp_channel_active:false}];f.c.state.selectedChannel=f.c.state.channels[0];
  gate.resolve(901);await pending;
  assert.equal(f.calls.filter(c=>c.kind==='message').length,0,'Latest known status for the captured target must be honored.');
  assert.equal(f.c.messageInput.value,'Offline caption');
});
test('two overlapping attachment actions share a single upload attempt and cannot double-send',async()=>{
  const gate=deferred(),f=fixture(windowFns);let uploads=0;
  f.c.uploadAttachmentToCurrentThread=()=>{uploads++;return gate.promise;};
  const first=f.c.sendAttachmentsFromInput([{name:'offline.jpg'}]);
  const second=f.c.sendAttachmentsFromInput([{name:'offline.jpg'}]);
  gate.resolve(901);await Promise.all([first,second]);
  assert.equal(uploads,1);assert.equal(f.calls.filter(c=>c.kind==='message').length,1);
});
test('failed attachment upload keeps the draft and never posts a message',async()=>{
  const f=fixture(windowFns,{uploadAttachmentToCurrentThread:async()=>{throw new Error('Synthetic upload failure');}});
  await f.c.sendAttachmentsFromInput([{name:'offline.jpg'}]);
  assert.equal(f.c.messageInput.value,'Offline caption');assert.equal(f.calls.filter(c=>c.kind==='message').length,0);
  assert.match(f.c.composerWarning.textContent,/Synthetic upload failure/);assert.equal(f.c.attachFileBtn.disabled,false);
});
test('closing the workspace while upload is pending prevents a late message send',async()=>{
  const gate=deferred(),f=fixture(windowFns,{uploadAttachmentToCurrentThread:()=>gate.promise});
  const pending=f.c.sendAttachmentsFromInput([{name:'offline.jpg'}]);f.c.state.destroyed=true;
  gate.resolve(901);await pending;
  assert.equal(f.calls.filter(c=>c.kind==='message').length,0);assert.equal(f.c.messageInput.value,'Offline caption');
});
test('upload failure after switching chats cannot replace the other conversation warning',async()=>{
  const gate=deferred(),f=fixture(windowFns,{uploadAttachmentToCurrentThread:()=>gate.promise});
  const pending=f.c.sendAttachmentsFromInput([{name:'offline.jpg'}]);
  f.c.state.selectedChannel={id:102,channel_type:'whatsapp'};f.c.state.selectedChannelId=102;
  f.c.composerWarning.textContent='Other conversation window warning';
  gate.reject(new Error('Original customer upload failed'));await pending;
  assert.equal(f.c.composerWarning.textContent,'Other conversation window warning');assert.equal(f.calls.filter(c=>c.kind==='message').length,0);
});
test('window expiry between files stops the remaining uploads as well as the final send',async()=>{
  const f=fixture(windowFns);let uploads=0;
  f.c.uploadAttachmentToCurrentThread=async()=>{uploads++;f.setClock(START+60001);return 901;};
  await f.c.sendAttachmentsFromInput([{name:'one.jpg'},{name:'two.jpg'}]);
  assert.equal(uploads,1);assert.equal(f.calls.filter(c=>c.kind==='message').length,0);
});
test('switching conversations during upload cannot send to the new selected customer or clear its draft',async()=>{
  const gate=deferred(),f=fixture(windowFns,{uploadAttachmentToCurrentThread:()=>gate.promise});
  const pending=f.c.sendAttachmentsFromInput([{name:'offline.jpg'}]);
  f.c.state.selectedChannel={...f.channel,id:102};f.c.state.selectedChannelId=102;f.c.messageInput.value='Other customer draft';
  gate.resolve(901);await pending;
  assert.equal(f.calls.find(c=>c.kind==='message').id,101);assert.equal(f.c.messageInput.value,'Other customer draft');
});

function templateFixture(){const f=fixture(templateFns);f.fields['whatsapp.composer']={res_model:{type:'char'},res_id:{type:'integer'},template_id:{type:'many2one'}};return f;}
const dispatchMissing=method=>Object.assign(new Error(`'whatsapp.composer' object has no attribute '${method}'`),{odooRpcError:true,odooErrorName:'builtins.AttributeError'});
for(const target of ['channel','partner']) {
  const invoke=f=>target==='channel'?f.c.sendWhatsappTemplateWithFallbacks(301,f.channel):f.c.sendWhatsappTemplateToPartnerWithFallbacks(301,{id:601,mobile:'919999000101'});
  test(`${target} template fallback advances only after an exact missing-method RPC error`,async()=>{
    const f=templateFixture();f.c.callKw=async(model,method)=>{f.calls.push({kind:'method',method});if(method==='action_send_whatsapp_template')throw dispatchMissing(method);return true;};
    assert.equal(await invoke(f),true);assert.deepEqual(f.calls.filter(c=>c.kind==='method').map(c=>c.method),['action_send_whatsapp_template','action_send_whatsapp_message']);
    assert.equal(f.calls.filter(c=>c.kind==='message').length,0);
  });
  for(const kind of ['network','validation','unrelated-attribute'])test(`${target} template ${kind} failure cannot trigger a second send route`,async()=>{
    const f=templateFixture();f.c.callKw=async(model,method)=>{f.calls.push({kind:'method',method});
      if(kind==='network')throw new Error('Synthetic lost acknowledgement');
      if(kind==='validation')throw Object.assign(new Error('Synthetic validation failure'),{odooRpcError:true,odooErrorName:'odoo.exceptions.ValidationError'});
      throw dispatchMissing('a_different_method');};
    await assert.rejects(invoke(f),error=>error.shTemplateSendAttempted===true);
    assert.equal(f.calls.filter(c=>c.kind==='method').length,1);assert.equal(f.calls.filter(c=>c.kind==='message').length,0);
  });
}
test('template success cannot reopen the local reply window',async()=>{
  const f=templateFixture();f.channel.whatsapp_channel_active=false;const before=JSON.stringify(f.channel);
  await f.c.sendWhatsappTemplateWithFallbacks(301,f.channel);assert.equal(JSON.stringify(f.channel),before);
});
test('channel template generic fallback is reached once only after all four methods are absent',async()=>{
  const f=templateFixture();f.c.callKw=async(model,method)=>{f.calls.push({kind:'method',method});throw dispatchMissing(method);};
  await f.c.sendWhatsappTemplateWithFallbacks(301,f.channel);
  assert.equal(f.calls.filter(c=>c.kind==='method').length,4);assert.equal(f.calls.filter(c=>c.kind==='message').length,1);
});
test('template list excludes draft, rejected, unknown and missing approval statuses',async()=>{
  const f=fixture(['loadWhatsappTemplates'],{searchReadAvailable:async()=>[
    {id:301,status:'approved'},{id:302,status:'APPROVED'},{id:303,state:'approved'},
    {id:304,status:'draft'},{id:305,status:'rejected'},{id:306,status:'pending'},{id:307},
    {id:308,status:'unexpected'}]});
  await f.c.loadWhatsappTemplates();assert.deepEqual(copy(f.c.state.whatsappTemplates.map(t=>t.id)),[301,302,303]);
});
for(const target of ['channel','partner'])test(`${target} template revalidates exact approval and cannot send a stale or unknown template`,async()=>{
  const f=templateFixture();f.c.state.whatsappTemplates=[{id:301,status:'approved'}];
  for(const rows of [[{id:301,status:'pending'}],[{id:301,status:'rejected'}],[{id:301}],[],[{id:999,status:'approved'}]]){
    f.c.searchReadAvailable=async()=>rows;
    const pending=target==='channel'?f.c.sendWhatsappTemplateWithFallbacks(301,f.channel):f.c.sendWhatsappTemplateToPartnerWithFallbacks(301,{id:601,mobile:'919999000101'});
    await assert.rejects(pending,/not confirmed as approved/);
  }
  assert.equal(f.calls.filter(c=>['method','message','create'].includes(c.kind)).length,0);
});
test('template approval read failure cannot fall through to a generic send route',async()=>{
  const f=templateFixture();f.c.searchReadAvailable=async()=>{throw new Error('Synthetic approval read failure');};
  await assert.rejects(f.c.sendWhatsappTemplateWithFallbacks(301,f.channel),/Synthetic approval read failure/);
  assert.equal(f.calls.filter(c=>['method','message','create'].includes(c.kind)).length,0);
});
test('asynchronous template approval lookup preserves the originally chosen conversation',async()=>{
  const gate=deferred(),f=templateFixture();f.c.searchReadAvailable=()=>gate.promise;
  const pending=f.c.sendWhatsappTemplateWithFallbacks(301);
  f.c.state.selectedChannel={...f.channel,id:102};f.c.state.selectedChannelId=102;
  gate.resolve([{id:301,status:'approved'}]);await pending;
  assert.equal(f.calls.find(c=>c.kind==='create').values.res_id,101);
});

const customerFns=['safeId','normalizeCreateResult','partnerIdFromChannel','linkCustomerToConversation','saveCustomerFromForm','createQuotationForCurrentCustomer','openFollowupModal','saveFollowupActivity'];
test('new customer is immediately available to draft quotation and follow-up even when persistent channel linkage is denied',async()=>{
  const f=fixture(customerFns);f.fields['discuss.channel']={whatsapp_partner_id:{type:'many2one',relation:'res.partner',readonly:false}};
  f.fields['mail.activity']={res_model_id:{},res_id:{},activity_type_id:{},summary:{},date_deadline:{},user_id:{}};
  f.c.state.resPartnerModelId=88;f.c.customerFormContext={channel:f.channel,partnerId:null,ready:true,saving:false};
  f.c.writeRecords=async()=>{throw new Error('Synthetic Odoo link permission denied');};
  await f.c.saveCustomerFromForm();
  assert.equal(f.c.partnerIdFromChannel(f.channel),601);assert.equal(f.c.state.customerLinksByChannel.get('101').persistent,false);
  await f.c.createQuotationForCurrentCustomer();await f.c.openFollowupModal();await f.c.saveFollowupActivity();
  const quote=f.calls.find(c=>c.kind==='create'&&c.model==='sale.order'),activity=f.calls.find(c=>c.kind==='create'&&c.model==='mail.activity');
  assert.deepEqual(quote.values,{partner_id:601});assert.equal(activity.values.res_id,601);assert.equal(activity.values.res_model_id,88);
});
test('new customer creation remains bound to the original form conversation after a chat switch',async()=>{
  const gate=deferred(),f=fixture(customerFns);
  f.fields['discuss.channel']={whatsapp_partner_id:{type:'many2one',relation:'res.partner',readonly:false}};
  f.c.customerFormContext={channel:f.channel,partnerId:null,ready:true,saving:false};
  f.c.createRecord=async()=>gate.promise;
  const pending=f.c.saveCustomerFromForm();f.c.state.selectedChannel={id:102,channel_type:'whatsapp'};f.c.state.selectedChannelId=102;
  gate.resolve(601);await pending;
  const link=f.calls.find(c=>c.kind==='write');assert.deepEqual(link.ids,[101]);assert.equal(link.values.whatsapp_partner_id,601);
  assert.equal(f.c.partnerIdFromChannel(f.channel),601);assert.equal(f.c.partnerIdFromChannel(f.c.state.selectedChannel),null);
});
test('read-only or absent channel relation retains honest temporary linkage without an invalid Odoo write',async()=>{
  const f=fixture(customerFns);f.fields['discuss.channel']={whatsapp_partner_id:{type:'many2one',relation:'res.partner',readonly:true}};
  const result=await f.c.linkCustomerToConversation(f.channel,601,'Offline customer');
  assert.equal(result.persistent,false);assert.equal(f.c.partnerIdFromChannel(f.channel),601);assert.equal(f.calls.filter(c=>c.kind==='write').length,0);
});

test('server-background mode disables both browser automatic scanners before they process any message',async()=>{
  const f=fixture(['maybeHandleGlobalAiModeAfterInbox','maybeHandleAiModeAfterMessages'],{getAiMode(){throw new Error('Browser scanner should not inspect mode in server-owned automation');}});
  await f.c.maybeHandleGlobalAiModeAfterInbox();await f.c.maybeHandleAiModeAfterMessages();assert.equal(f.calls.length,0);
});
test('a delayed startup read cannot undo a later explicit ON or write OFF to the server',async()=>{
  const first=deferred(),f=fixture(aiFns);let reads=0;
  f.c.appFetch=async(url,options)=>{
    const body=options.body?JSON.parse(options.body):null;f.calls.push({method:options.method,body});
    if(options.method==='GET')return ++reads===1?first.promise:{ok:true,json:async()=>({ok:true,mode:'manual',epoch:'demo-ai',revision:0})};
    return {ok:true,json:async()=>({ok:true,mode:body.mode,epoch:'demo-ai',revision:1})};
  };
  const initial=f.c.initializeAiModeFromServer();assert.equal(await f.c.setAiMode('zapier'),true);
  first.resolve({ok:true,json:async()=>({ok:true,mode:'manual',epoch:'demo-ai',revision:0})});await initial;
  assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(c=>c.body.mode),['zapier']);assert.equal(f.c.state.aiProcessedMessageIds['101'],1);
  assert.equal(f.c.shAiRuntime.confirmedMode,'zapier');assert.equal(f.c.shAiRuntime.pending,false);
});
test('failed startup status read leaves visible uncertainty without claiming the server is OFF',async()=>{
  const f=fixture(aiFns,{appFetch:async()=>{throw new Error('Synthetic offline response');}});
  assert.equal(await f.c.initializeAiModeFromServer(),null);assert.equal(f.c.shAiRuntime.confirmedMode,null);
  assert.match(f.c.state.aiModeSyncError,/Shared AI status is unavailable/);
});
test('malformed AI toggle acknowledgement must not be reported as confirmed',async()=>{
  const f=fixture(aiFns,{appFetch:async()=>({ok:true,json:async()=>({})})});
  assert.equal(await f.c.setAiMode('zapier'),false,'A successful HTTP status without a valid mode acknowledgement is not confirmation.');
  assert.equal(f.c.shAiRuntime.confirmedMode,null);assert.match(f.c.state.aiModeSyncError,/could not be confirmed/);
});
test('wrong mode and incomplete AI acknowledgements cannot confirm the requested setting',async()=>{
  for(const body of [{ok:true,mode:'manual'},{ok:true,mode:'unexpected'},{mode:'zapier'},{ok:true},{ok:true,mode:'zapier',epoch:'demo-ai',revision:0},{ok:true,mode:'zapier',epoch:'old-ai',revision:1}]) {
    const f=fixture(aiFns,{appFetch:async()=>({ok:true,json:async()=>body})});
    assert.equal(await f.c.setAiMode('zapier'),false);assert.equal(f.c.shAiRuntime.confirmedMode,null);
    assert.match(f.c.state.aiModeSyncError,/could not be confirmed/);
  }
});
test('opening another app reads the global mode and cannot disable another operator AI session',async()=>{
  let globalMode='zapier';const methods=[];const f=fixture(aiFns,{appFetch:async(url,options)=>{methods.push(options.method);if(options.body)globalMode=JSON.parse(options.body).mode;return {ok:true,json:async()=>({ok:true,mode:globalMode,epoch:'demo-ai',revision:5})};}});
  await f.c.initializeAiModeFromServer();assert.equal(globalMode,'zapier');assert.equal(f.c.state.aiMode,'zapier');assert.deepEqual(methods,['GET']);
});
test('a first toggle with unknown version reads fresh state and failed reads cannot issue a write',async()=>{
  const methods=[],f=fixture(aiFns,{appFetch:async(url,options)=>{methods.push(options.method);return {ok:false,status:503,json:async()=>({ok:false})};}});
  f.c.state.aiServerGlobal=null;
  assert.equal(await f.c.setAiMode('zapier'),false);assert.deepEqual(methods,['GET']);assert.equal(f.c.state.aiServerGlobal,null);
});
test('contradictory AI mode, enable flag or version representations never confirm a server snapshot',()=>{
  const f=fixture(aiFns),valid={ok:true,mode:'zapier',aiEnabled:true,epoch:'demo-ai',revision:1};
  assert.equal(f.c.aiModeSnapshot(valid).mode,'zapier');
  assert.equal(f.c.aiModeSnapshot({...valid,mode:'assist',aiEnabled:false}).mode,'assist','Suggestions do not claim automatic reply is enabled');
  assert.equal(f.c.aiModeSnapshot({...valid,mode:'chat'}).mode,'chat');
  for(const body of [
    {...valid,aiEnabled:false},
    {...valid,ai_enabled:false},
    {...valid,aiMode:'manual'},
    {...valid,global:{mode:'manual',epoch:'demo-ai',revision:1}},
    {...valid,global:{mode:'zapier',epoch:'other-epoch',revision:1}},
    {...valid,global:{mode:'zapier',epoch:'demo-ai',revision:2}},
    {...valid,global:{mode:'zapier',aiEnabled:false,epoch:'demo-ai',revision:1}}
  ])assert.equal(f.c.aiModeSnapshot(body),null);
});
test('destroying the Hub during a first-toggle status lookup prevents the queued mutation',async()=>{
  const gate=deferred(),methods=[],f=fixture(aiFns,{appFetch:async(url,options)=>{methods.push(options.method);return gate.promise;}});
  f.c.state.aiServerGlobal=null;const pending=f.c.setAiMode('zapier');await Promise.resolve();await Promise.resolve();
  f.c.state.destroyed=true;gate.resolve({ok:true,json:async()=>({ok:true,mode:'manual',epoch:'demo-ai',revision:0})});
  assert.equal(await pending,false);assert.deepEqual(methods,['GET']);
});
