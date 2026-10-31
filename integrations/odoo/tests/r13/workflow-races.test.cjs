'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {context,deferred,node}=require('./production-functions.cjs');
const copy=v=>JSON.parse(JSON.stringify(v));
const channel={id:101,channel_type:'whatsapp',whatsapp_partner_id:[601,'Demo A'],whatsapp_channel_active:true};
function base(extra={}) {
  const calls=[],toasts=[];
  const c={state:{selectedChannel:{...channel},selectedChannelId:101,channels:[{...channel}],destroyed:false,modelFields:{},draftsByChannel:new Map()},
    window:{open(){calls.push({type:'popup'});return{location:{href:''},close(){}};},alert(){}},
    showOperatorToast:m=>toasts.push(m),hideInlineError(){},showInlineError(n,m){n.textContent=m;},hidePanel(){},showPanel(){},
    normalizeCreateResult:r=>Number(r?.[0]||r),partnerIdFromChannel:c=>c?.whatsapp_partner_id?.[0],
    async loadModelFields(){return{};},async createRecord(model,values){calls.push({type:'create',model,values:copy(values)});return 801;},
    async loadChannels(){},async loadMessages(){},async openCustomerFormModal(){},...extra};
  return {c,calls,toasts};
}
test('a duplicate quotation tap while the same customer create is pending creates one draft',async()=>{
  const g=deferred(),f=base();f.c.createRecord=async(model,values)=>{f.calls.push({type:'create',model,values:copy(values)});return g.promise;};
  const c=context(['createQuotationForCurrentCustomer'],f.c);
  const a=c.createQuotationForCurrentCustomer(),b=c.createQuotationForCurrentCustomer();
  await Promise.resolve();g.resolve(801);await Promise.all([a,b]);
  assert.equal(f.calls.filter(x=>x.type==='create').length,1);
  assert.deepEqual(f.calls.find(x=>x.type==='create').values,{partner_id:601});
});
test('quotation completion after chat switching retains the original customer',async()=>{
  const g=deferred(),f=base({loadModelFields:()=>g.promise});
  const c=context(['createQuotationForCurrentCustomer'],f.c),p=c.createQuotationForCurrentCustomer();
  c.state.selectedChannel={...channel,id:102,whatsapp_partner_id:[602,'Demo B']};g.resolve({});await p;
  assert.equal(f.calls.find(x=>x.type==='create').values.partner_id,601);
});
function mailFixture() {
  const f=base({mailToInput:node('a@example.invalid'),mailCcInput:node(),mailSubjectInput:node('Demo subject'),mailBodyInput:node('Demo body'),
    hideMailComposeError(){},htmlFromPlainText:s=>s,ZOHO_MAIL_DEFAULT_FROM:'care@smarthandicrafts.com',
    async zohoMailFetch(url,options){f.calls.push({url,body:copy(options.body)});return {ok:true};},
    closeMailCompose(){f.calls.push({type:'close-compose'});},async loadMailCenter(){},async loadMailUnreadBadge(){} });
  f.c.state.mailComposeMode='new';f.c.state.mailComposeContext={revision:1};
  return f;
}
test('duplicate mail submit cannot send two copies of the same message',async()=>{
  const f=mailFixture(),g=deferred();f.c.zohoMailFetch=async(url,options)=>{f.calls.push({url,body:copy(options.body)});return g.promise;};
  const c=context(['sendMailFromComposeForm'],f.c);
  const a=c.sendMailFromComposeForm(),b=c.sendMailFromComposeForm();g.resolve({ok:true});await Promise.all([a,b]);
  assert.equal(f.calls.filter(x=>x.url).length,1);
});
test('a pending mail send cannot close a newly opened draft',async()=>{
  const f=mailFixture(),g=deferred();f.c.zohoMailFetch=()=>g.promise;
  const c=context(['sendMailFromComposeForm'],f.c),p=c.sendMailFromComposeForm();
  c.state.mailComposeContext={revision:2};c.mailBodyInput.value='New unsent draft';g.resolve({ok:true});await p;
  assert.equal(f.calls.filter(x=>x.type==='close-compose').length,0);
  assert.equal(c.mailBodyInput.value,'New unsent draft');
});
test('mail reply snapshots the exact original message and recipient',async()=>{
  const f=mailFixture();f.c.state.mailComposeMode='reply';f.c.state.mailReplyTarget={zohoMessageId:'mail-A'};
  const c=context(['sendMailFromComposeForm'],f.c);await c.sendMailFromComposeForm();
  assert.equal(f.calls[0].url,'/api/zoho-mail/reply');assert.equal(f.calls[0].body.messageId,'mail-A');assert.equal(f.calls[0].body.toAddress,'a@example.invalid');
});
test('failed mail send retains draft and allows an explicit subsequent attempt',async()=>{
  const f=mailFixture();let tries=0;f.c.zohoMailFetch=async()=>{tries++;throw new Error('Synthetic rejected send');};
  const c=context(['sendMailFromComposeForm'],f.c);
  await assert.rejects(c.sendMailFromComposeForm(),/Synthetic/);await assert.rejects(c.sendMailFromComposeForm(),/Synthetic/);
  assert.equal(tries,2);assert.equal(c.mailBodyInput.value,'Demo body');assert.equal(f.calls.filter(x=>x.type==='close-compose').length,0);
});
test('duplicate group submissions create exactly one Discuss group',async()=>{
  const f=base(),g=deferred();f.c.state.newGroupSelectedPartnerIds=[601,602];f.c.state.modelFields['discuss.channel']={name:{},channel_type:{},channel_partner_ids:{}};
  Object.assign(f.c,{newGroupName:node('Demo team'),createGroupBtn:node(),hideNewGroupError(){},showNewGroupError(){},
    selectionIdsArray:x=>x,closeNewChatCenter(){},newGroupModal:node(),async selectChannel(){},
    createRecord:async(model,values)=>{f.calls.push({model,values:copy(values)});return g.promise;}});
  const c=context(['createNewDiscussGroup'],f.c),a=c.createNewDiscussGroup(),b=c.createNewDiscussGroup();
  await Promise.resolve();g.resolve(104);await Promise.all([a,b]);assert.equal(f.calls.length,1);assert.equal(f.calls[0].values.channel_type,'group');
});
function broadcastFixture() {
  const f=base({hideBroadcastError(){},showBroadcastError(){},broadcastResult:node(),sendBroadcastBtn:node(),selectionIdsArray:x=>[...new Set(x)],
    escapeHtml:String,async fetchPartnerByIdForDirectory(id){return{id,name:'Demo '+id};},findWhatsappChannelForPartner:()=>null,
    async sendWhatsappTemplateToPartnerWithFallbacks(template,id){f.calls.push({type:'send-template',template,id:id.id});}});
  f.c.state.broadcastTemplateId=301;f.c.state.broadcastSelectedPartnerIds=[601,602];return f;
}
test('contact lookup failure in a broadcast is counted and cannot strand the send button',async()=>{
  const f=broadcastFixture();f.c.fetchPartnerByIdForDirectory=async(id)=>{if(id===601)throw new Error('Synthetic denied contact');return{id,name:'Demo B'};};
  const c=context(['sendBroadcastTemplates'],f.c);await c.sendBroadcastTemplates();
  assert.equal(c.sendBroadcastBtn.disabled,false);assert.equal(f.calls.filter(x=>x.type==='send-template').length,1);
  assert.match(c.broadcastResult.innerHTML,/1 sent.*1 failed/);
});
test('workspace destruction during a broadcast lookup prevents further sends',async()=>{
  const f=broadcastFixture(),g=deferred();f.c.fetchPartnerByIdForDirectory=()=>g.promise;
  const c=context(['sendBroadcastTemplates'],f.c),p=c.sendBroadcastTemplates();c.state.destroyed=true;
  g.resolve({id:601,name:'Demo A'});await p;assert.equal(f.calls.filter(x=>x.type==='send-template').length,0);
});
test('double broadcast submission is one captured batch, not duplicate template sends',async()=>{
  const f=broadcastFixture(),g=deferred();f.c.fetchPartnerByIdForDirectory=async id=>{await g.promise;return{id,name:'Demo '+id};};
  const c=context(['sendBroadcastTemplates'],f.c),a=c.sendBroadcastTemplates(),b=c.sendBroadcastTemplates();g.resolve();await Promise.all([a,b]);
  assert.deepEqual(f.calls.filter(x=>x.type==='send-template').map(x=>x.id),[601,602]);
});
function docsFixture() {
  const f=base({showDocsShareError:m=>f.toasts.push(m),docsShareLink:()=> 'https://documents.example.invalid/signed/demo',
    documentShareMessage:()=> 'Demo signed document',docsBackendUrl:s=>'https://backend.example.invalid'+s,closeDocsSharePanel(){},
    isWhatsappWindowOpen:c=>c.whatsapp_channel_active===true,
    async appFetch(url,options){f.calls.push({url,body:JSON.parse(options.body)});return{ok:true,json:async()=>({ok:true})};}});
  f.c.state.docsSelectedDocument={id:701,name:'Demo certificate'};f.c.state.docsSelectedRecipient={type:'chat',channel:{...channel}};return f;
}
test('document share cannot bypass a closed WhatsApp free-text window',async()=>{
  const f=docsFixture();f.c.state.channels[0].whatsapp_channel_active=false;
  const c=context(['shareDocsToSelectedRecipient'],f.c);await c.shareDocsToSelectedRecipient('whatsapp');
  assert.equal(f.calls.length,0);assert.match(f.toasts.join(' '),/window|template/i);
});
test('document sharing keeps captured recipient even when the visible chat differs',async()=>{
  const f=docsFixture();f.c.state.selectedChannelId=102;
  const c=context(['shareDocsToSelectedRecipient'],f.c);await c.shareDocsToSelectedRecipient('whatsapp');assert.equal(f.calls[0].body.channelId,101);
});
test('closed workspace cannot send text through a delayed task',async()=>{
  const f=base({isWhatsappWindowOpen:()=>true,async messagePost(){f.calls.push({type:'message'});}});f.c.state.destroyed=true;
  const c=context(['postTextToChannel'],f.c);assert.equal(await c.postTextToChannel(channel,'Demo text',{reload:false}),false);assert.equal(f.calls.length,0);
});
test('text send consults the latest inbox reply-window state for the captured chat',async()=>{
  const f=base({isWhatsappWindowOpen:c=>c.whatsapp_channel_active,updateComposerState(){},async messagePost(){f.calls.push({type:'message'});}});f.c.state.channels[0].whatsapp_channel_active=false;
  const c=context(['postTextToChannel'],f.c);assert.equal(await c.postTextToChannel(channel,'Demo text',{reload:false}),false);assert.equal(f.calls.length,0);
});
function aiFixture() {
  const f=base({AI_MODE_SERVER_BACKGROUND:true,AI_MODE_BACKEND_BASE:'https://backend.example.invalid',
    shAiRuntime:{syncQueue:Promise.resolve(),revision:0,readRevision:0,confirmedMode:'manual',pending:false},syncAiModeUi(){},
    async appFetch(){return{ok:true,json:async()=>({ok:true,mode:'manual',epoch:'offline-ai',revision:1})};}});return f;
}
test('an older AI status GET cannot overwrite a newer operator toggle',async()=>{
  const f=aiFixture(),g=deferred();f.c.appFetch=()=>g.promise;
  const c=context(['confirmedAiMode','aiModeSnapshot','loadAiModeFromServer'],f.c),p=c.loadAiModeFromServer();
  c.shAiRuntime.revision++;c.shAiRuntime.pending=true;c.state.aiMode='zapier';
  g.resolve({ok:true,json:async()=>({ok:true,mode:'manual',epoch:'offline-ai',revision:1})});await p;assert.equal(c.state.aiMode,'zapier');
});
test('authoritative AI status updates the confirmed rollback mode across devices',async()=>{
  const f=aiFixture();f.c.appFetch=async()=>({ok:true,json:async()=>({ok:true,mode:'zapier',epoch:'offline-ai',revision:1})});
  const c=context(['confirmedAiMode','aiModeSnapshot','loadAiModeFromServer'],f.c);await c.loadAiModeFromServer();assert.equal(c.shAiRuntime.confirmedMode,'zapier');
});
test('stale AI status response loses to a later status response',async()=>{
  const f=aiFixture(),g=deferred();let reads=0;f.c.appFetch=()=>++reads===1?g.promise:Promise.resolve({ok:true,json:async()=>({ok:true,mode:'manual',epoch:'offline-ai',revision:1})});
  const c=context(['confirmedAiMode','aiModeSnapshot','loadAiModeFromServer'],f.c),p=c.loadAiModeFromServer();await c.loadAiModeFromServer();
  g.resolve({ok:true,json:async()=>({ok:true,mode:'zapier',epoch:'offline-ai',revision:1})});await p;assert.equal(c.state.aiMode,'manual');
});
