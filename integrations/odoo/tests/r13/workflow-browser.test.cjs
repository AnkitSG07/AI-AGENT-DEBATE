'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {launch,finish,fixture,messagesFor,screenshot,sourceHash}=require('./workflow-harness.cjs');
const {Simulator}=require('./odoo-render-simulator.cjs');
const results=[];
test.before(launch);
test.after(async()=>{await finish();fs.writeFileSync(path.join(__dirname,'workflow-evidence/results.json'),JSON.stringify({sourceHash,scope:'Actual full-embed Chromium UI with stateful simulated Odoo/Render services; synthetic profiles and records; no production delivery.',results},null,2));});
function check(name,run){test(name,async()=>{try{await run();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.message});throw e;}});}
async function fresh(options={}) {
  const sim=new Simulator();for(const id of [101,102])sim.models['mail.message'].push(...messagesFor(id));
  const f=await fixture({...options,services:sim.route.bind(sim),connect:true});
  await f.page.evaluate(()=>{__hubUiTest.state.modelFields={};__hubUiTest.state.extendedCapabilitiesLoaded=false;});
  return {...f,sim};
}
const methods=(f,model,method)=>f.sim.calls.filter(c=>c.model===model&&c.method===method);
const writes=f=>f.sim.backendWrites.filter(c=>!['/api/operator-devices/heartbeat','/api/ai-mode'].includes(c.path));

check('full session/capability bootstrap loads the unified inbox using real application init',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.init());
    assert.equal(await f.page.locator('#shChannelList [data-channel-id]').count(),4);
    assert.equal(await f.page.locator('#shAppLayout').evaluate(n=>n.classList.contains('is-hidden')),false);
    assert.ok(methods(f,'discuss.channel','search_read').length);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('opening a second Hub reads the shared AI mode without turning an enabled server OFF',async()=>{
  const f=await fresh();try{
    f.sim.aiMode='zapier';f.sim.aiRevision=4;
    await f.page.evaluate(()=>__hubUiTest.init());
    await f.page.waitForFunction(()=>!__hubUiTest.shAiRuntime.pending);
    assert.equal(f.sim.backendWrites.filter(x=>x.path==='/api/ai-mode').length,0);
    assert.equal(f.sim.aiMode,'zapier');
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.aiMode),'zapier');
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('reconnecting operator services reads current AI state without a startup write',async()=>{
  const f=await fresh();try{
    f.sim.aiMode='zapier';f.sim.aiRevision=4;
    await f.page.evaluate(()=>window.dispatchEvent(new Event('sh-operator-auth-connected')));
    await f.page.waitForFunction(()=>__hubUiTest.shAiRuntime.confirmedMode!==null);
    assert.equal(f.sim.backendWrites.filter(x=>x.path==='/api/ai-mode').length,0);
    assert.equal(f.sim.aiMode,'zapier');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
for(const [channelId,type]of [[101,'whatsapp_message'],[103,'comment'],[104,'comment']])check(`send/read in channel ${channelId} uses ${type} and preserves message body`,async()=>{
  const f=await fresh();try{
    await f.page.evaluate(id=>__hubUiTest.selectChannel(id),channelId);
    await f.page.locator('#shMessageInput').fill('Offline message <safe> & exact');
    await f.page.evaluate(()=>__hubUiTest.sendCurrentMessage());
    const sent=methods(f,'discuss.channel','message_post');assert.equal(sent.length,1);assert.equal(sent[0].kwargs.message_type,type);
    assert.match(sent[0].kwargs.body,/Offline message/);assert.equal(sent[0].args[0][0],channelId);
    assert.equal(await f.page.locator('#shMessageInput').inputValue(),'');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('network send failure retains the exact draft and performs no automatic resend',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    f.sim.failOnce('discuss.channel.message_post');await f.page.locator('#shMessageInput').fill('Keep this draft');
    await f.page.evaluate(()=>__hubUiTest.sendCurrentMessage());
    assert.equal(methods(f,'discuss.channel','message_post').length,1);assert.equal(await f.page.locator('#shMessageInput').inputValue(),'Keep this draft');
    assert.equal(await f.page.locator('#shSendButton').isDisabled(),false);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('message star, quote, copy, edit and delete operate on the captured message only',async()=>{
  const f=await fresh();try{await f.context.grantPermissions(['clipboard-read','clipboard-write']);await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    const result=await f.page.evaluate(async()=>{const h=__hubUiTest,m=h.state.messages.find(m=>m.id===1012);await h.toggleMessageStar(m);h.quoteMessageIntoComposer(m);await h.copyMessageText(m);return{draft:document.getElementById('shMessageInput').value,copy:await navigator.clipboard.readText()};});
    assert.match(result.draft,/quotation/);assert.match(result.copy,/quotation/);assert.equal(methods(f,'mail.message','write')[0].args[0][0],1012);
    f.page.once('dialog',d=>d.accept('Edited offline text'));await f.page.evaluate(()=>__hubUiTest.editMessageBody(__hubUiTest.state.messages.find(m=>m.id===1012)));
    assert.equal(f.sim.models['mail.message'].find(m=>m.id===1012).body,'Edited offline text');
    f.page.once('dialog',d=>d.accept());await f.page.evaluate(()=>__hubUiTest.deleteMessageRecord(__hubUiTest.state.messages.find(m=>m.id===1012)));
    assert.equal(f.sim.models['mail.message'].some(m=>m.id===1012),false);assert.equal(f.sim.models['mail.message'].some(m=>m.id===1011),true);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('quotation creates one draft for the selected customer without order confirmation',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.selectChannel(101));await f.page.evaluate(()=>__hubUiTest.createQuotationForCurrentCustomer());
    assert.equal(methods(f,'sale.order','create').length,1);const row=f.sim.models['sale.order'].at(-1);assert.equal(row.partner_id,601);assert.equal(row.state,'draft');
    assert.equal(f.sim.calls.some(c=>/confirm/.test(c.method)),false);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('follow-up form creates customer activity with chosen date and summary',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.selectChannel(101));await f.page.evaluate(()=>__hubUiTest.openFollowupModal());
    await f.page.locator('#shFollowupSummary').fill('Offline follow-up');await f.page.locator('#shFollowupDate').fill('2026-11-10');
    await f.page.evaluate(()=>__hubUiTest.saveFollowupActivity());
    const activity=methods(f,'mail.activity','create')[0]?.args[0];assert.ok(activity);assert.equal(activity.res_id,601);assert.equal(activity.date_deadline,'2026-11-10');assert.equal(activity.summary,'Offline follow-up');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('new group creates an internal Odoo Discuss group with chosen members',async()=>{
  const f=await fresh();try{await f.page.evaluate(async()=>{const h=__hubUiTest;await h.loadModelFields('discuss.channel');await h.openNewGroupModal();h.state.newGroupSelectedPartnerIds=[601,602];});
    await f.page.locator('#shNewGroupName').fill('Offline internal team');await f.page.evaluate(()=>__hubUiTest.createNewDiscussGroup());
    const values=methods(f,'discuss.channel','create')[0]?.args[0];assert.ok(values);assert.equal(values.channel_type,'group');assert.deepEqual(values.channel_partner_ids,[[6,0,[601,602]]]);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('contact directory browses without mutating Odoo and selected Google import is one record',async()=>{
  const f=await fresh();try{
    await f.page.evaluate(()=>__hubUiTest.loadOdooContactDirectory({reset:true,term:'Demo'}));assert.equal(await f.page.locator('[data-new-chat-partner-id]').count(),2);
    await f.page.evaluate(()=>__hubUiTest.loadGmailContactDirectory({reset:true,term:''}));assert.equal(writes(f).length,0);
    assert.equal(methods(f,'res.partner','create').length,0);
    const partner=await f.page.evaluate(()=>__hubUiTest.importGmailContactToOdoo(__hubUiTest.state.gmailContacts[0]));
    assert.ok(partner.id);assert.equal(f.sim.backendWrites.filter(x=>x.path==='/api/google-contacts/import-to-odoo').length,1);assert.deepEqual(f.errors,[]);
    await screenshot(f.page,'r13-google-contacts-demo');
  }finally{await f.close();}
});
check('approved template selection excludes rejected templates and sends one composer action',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.selectChannel(101));await f.page.evaluate(()=>__hubUiTest.loadWhatsappTemplates());
    assert.deepEqual(await f.page.evaluate(()=>__hubUiTest.state.whatsappTemplates.map(x=>x.id)),[301]);
    await f.page.evaluate(()=>__hubUiTest.sendWhatsappTemplateWithFallbacks(301,__hubUiTest.state.selectedChannel));
    assert.equal(methods(f,'whatsapp.composer','create').length,1);assert.equal(methods(f,'whatsapp.composer','action_send_whatsapp_template').length,1);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('broadcast sends separate approved template messages to two captured customers',async()=>{
  const f=await fresh();try{await f.page.evaluate(async()=>{const h=__hubUiTest;h.state.broadcastTemplateId=301;h.state.broadcastSelectedPartnerIds=[601,602];await h.sendBroadcastTemplates();});
    assert.equal(methods(f,'whatsapp.composer','action_send_whatsapp_template').length,2);assert.equal(methods(f,'whatsapp.composer','create').length,2);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('Zoho inbox, body, reply and new compose use the actual mailbox adapters',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.openMailCenter());
    const rows=await f.page.evaluate(()=>__hubUiTest.state.mailMessages);assert.equal(rows.length,1);assert.equal(rows[0].sourceModel,'zoho.mail');
    await f.page.evaluate(()=>__hubUiTest.openMailDetail(__hubUiTest.state.mailMessages[0]));assert.match(await f.page.locator('#shMailDetailBody').innerText(),/Demo email content/);
    await f.page.evaluate(()=>{const h=__hubUiTest;h.replyToSelectedMail();document.getElementById('shMailBodyInput').value='Offline reply';});
    await f.page.evaluate(()=>__hubUiTest.sendMailFromComposeForm());assert.equal(f.sim.backendWrites.filter(x=>x.path==='/api/zoho-mail/reply').length,1);
    await f.page.evaluate(()=>{__hubUiTest.openMailCompose({to:'b@example.invalid',subject:'Offline compose',body:'No real email is sent'});});
    await f.page.evaluate(()=>__hubUiTest.sendMailFromComposeForm());assert.equal(f.sim.backendWrites.filter(x=>x.path==='/api/zoho-mail/send').length,1);assert.deepEqual(f.errors,[]);
    await screenshot(f.page,'r13-mail-demo');
  }finally{await f.close();}
});
check('documents browse folders and filters and email sharing prepares a draft only',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.openDocsCenter());
    await f.page.waitForFunction(()=>__hubUiTest.state.docsDocuments.length===2);
    await f.page.evaluate(()=>{const h=__hubUiTest;h.selectDocsFolder(700);h.state.docsFilter='pdf';h.renderDocsList();});
    assert.equal(await f.page.locator('#shDocsList [data-doc-id]').count(),1);
    await f.page.evaluate(async()=>{const h=__hubUiTest;h.state.docsSelectedDocument=h.findDocById(701);h.state.docsSelectedRecipient={type:'odoo',partner:{id:601,name:'Demo Customer A',email:'a@example.invalid'}};await h.shareDocsToSelectedRecipient('email');});
    assert.equal(f.sim.backendWrites.filter(x=>/zoho-mail\/(send|reply)$/.test(x.path)).length,0);
    assert.match(await f.page.locator('#shMailBodyInput').inputValue(),/Demo safety certificate/);assert.deepEqual(f.errors,[]);
    await screenshot(f.page,'r13-document-email-draft-demo');
  }finally{await f.close();}
});
check('document sharing through chat blocks closed windows before any request',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.loadDocsTree());await f.page.evaluate(async()=>{const h=__hubUiTest;h.state.channels[0].whatsapp_channel_active=false;h.state.docsSelectedDocument=h.findDocById(701);h.state.docsSelectedRecipient={type:'chat',channel:h.state.channels[0]};await h.shareDocsToSelectedRecipient('whatsapp');});
    assert.equal(f.sim.backendWrites.filter(x=>x.path==='/api/odoo-documents/share').length,0);assert.match(await f.page.locator('#shDocsShareError').textContent(),/window is closed/);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('cross-device AI status reconciliation updates the UI without an automatic enable',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.initializeAiModeFromServer());f.sim.aiMode='zapier';await f.page.evaluate(()=>__hubUiTest.loadAiModeFromServer());
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.aiMode),'zapier');f.sim.aiMode='manual';await f.page.evaluate(()=>__hubUiTest.loadAiModeFromServer());
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.aiMode),'manual');assert.equal(f.sim.backendWrites.filter(x=>x.path==='/api/ai-mode'&&x.body.mode==='zapier').length,0);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

for(const [name,payload]of [
  ['newline-obfuscated script link','<a href="java&#10;script:window.__emailExecuted=true">unsafe</a>'],
  ['svg animation link','<svg><a><animate attributeName="href" values="javascript:window.__emailExecuted=true"/><text>x</text></a></svg>'],
  ['global email CSS','<div><style>#shOperatorApp{display:none!important}</style><p style="position:fixed;inset:0;z-index:999999">cover</p></div>'],
  ['forms and host identity clobbering','<form id="shOperatorApp"><input name="SHNative"><button autofocus>submit</button></form><p id="shMailDetailBody" class="is-hidden">text</p>'],
  ['active embeds','<iframe srcdoc="<script>parent.__emailExecuted=true</script>"></iframe><object data="javascript:alert(1)"></object><img src=x onerror="window.__emailExecuted=true">'],
  ['mixed namespaces','<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=window.__emailExecuted=true>">']
])check(`email sanitizer removes ${name} without changing the Hub`,async()=>{
  const f=await fresh();try{const out=await f.page.evaluate(payload=>{
    const clean=__hubUiTest.sanitizeEmailHtml(payload),box=document.createElement('div');box.innerHTML=clean;document.body.append(box);
    const bad=!!box.querySelector('script,style,svg,math,iframe,object,embed,form,input,button,[id],[name],[style],[class]');
    const scriptLinks=[...box.querySelectorAll('[href]')].some(a=>/^javascript:/i.test(a.href));
    const eventHandlers=[...box.querySelectorAll('*')].some(n=>[...n.attributes].some(a=>a.name.startsWith('on')));box.remove();
    return{clean,bad,scriptLinks,eventHandlers,executed:window.__emailExecuted===true,appVisible:getComputedStyle(document.getElementById('shOperatorApp')).display!=='none',version:window.SHMailSanitizer?.version};
  },payload);assert.equal(out.bad,false);assert.equal(out.scriptLinks,false);assert.equal(out.eventHandlers,false);assert.equal(out.executed,false);assert.equal(out.appVisible,true);assert.equal(out.version,'3.4.17');
  }finally{await f.close();}
});
check('safe email formatting, tables and HTTPS links remain readable after sanitization',async()=>{
  const f=await fresh();try{const clean=await f.page.evaluate(()=>__hubUiTest.sanitizeEmailHtml('<p>Hello <strong>customer</strong></p><table><tr><td>Quote</td><td>1200</td></tr></table><a href="https://example.invalid/quote">Open quote</a>'));
    assert.match(clean,/<strong>customer<\/strong>/);assert.match(clean,/<td>1200<\/td>/);assert.match(clean,/href="https:\/\/example.invalid\/quote"/);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('document URLs must be current exact-record signed links, never an anonymous raw ID fallback',async()=>{
  const f=await fresh();try{const links=await f.page.evaluate(()=>{const h=__hubUiTest,doc={id:701,view_url:'https://ai-agent-debate.onrender.com/api/odoo-documents/view/701?share=demo',link_expires_at:Date.now()+60000};return[
    h.docsShareLink(doc),h.docsShareLink({id:701}),h.docsShareLink({...doc,link_expires_at:1}),h.docsShareLink({...doc,view_url:'javascript:alert(1)'}),h.docsShareLink({...doc,view_url:'https://ai-agent-debate.onrender.com/api/odoo-documents/view/702?share=demo'})];});
    assert.match(links[0],/view\/701\?share=/);assert.deepEqual(links.slice(1),['','','','']);
  }finally{await f.close();}
});

check('optional model fields can be absent without breaking inbox or message reads',async()=>{
  const f=await fresh();try{f.sim.strictFields=true;await f.page.evaluate(()=>__hubUiTest.init());await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    assert.equal(await f.page.locator('#shChannelList [data-channel-id]').count(),4);assert.equal(await f.page.locator('#shMessageThread [data-message-id]').count(),3);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('inbox can load beyond 250 channels without losing the selection or duplicating rows',async()=>{
  const f=await fresh();try{const base=f.sim.models['discuss.channel'][0];f.sim.models['discuss.channel']=Array.from({length:281},(_,i)=>({...base,id:101+i,name:'Demo '+i,display_name:'Demo '+i}));
    await f.page.evaluate(()=>__hubUiTest.loadChannels());assert.equal(await f.page.locator('#shChannelList [data-channel-id]').count(),250);
    await f.page.evaluate(()=>__hubUiTest.selectChannel(150));await f.page.evaluate(()=>Promise.all([__hubUiTest.loadMoreChannels(),__hubUiTest.loadMoreChannels()]));
    assert.equal(await f.page.locator('#shChannelList [data-channel-id]').count(),281);assert.equal(await f.page.evaluate(()=>__hubUiTest.state.selectedChannelId),150);
    assert.equal(await f.page.locator('[data-load-more-channels]').count(),0);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
function seedHistory(f,count=345){const base=messagesFor(101)[0];f.sim.models['mail.message']=Array.from({length:count},(_,i)=>({...base,id:10000+i,body:`<p>Offline history ${i}</p>`,date:new Date(Date.now()-(count-i)*60000).toISOString()}));}
check('older chat pages cross the 160-message limit and survive ordinary polling',async()=>{
  const f=await fresh();try{seedHistory(f);await f.page.evaluate(()=>__hubUiTest.selectChannel(101));assert.equal(await f.page.evaluate(()=>__hubUiTest.state.messages.length),160);
    await f.page.evaluate(()=>Promise.all([__hubUiTest.loadOlderMessages(),__hubUiTest.loadOlderMessages()]));assert.equal(await f.page.evaluate(()=>__hubUiTest.state.messages.length),320);
    await f.page.evaluate(()=>__hubUiTest.loadOlderMessages());assert.equal(await f.page.evaluate(()=>__hubUiTest.state.messages.length),345);
    await f.page.evaluate(()=>__hubUiTest.loadMessages(101,{force:true}));assert.equal(await f.page.evaluate(()=>__hubUiTest.state.messages.length),345);
    assert.equal(await f.page.locator('[data-load-older-messages]').count(),0);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('late older-history page cannot render into another chat, and new refresh rows win',async()=>{
  const f=await fresh();try{seedHistory(f,190);await f.page.evaluate(()=>__hubUiTest.selectChannel(101));const release=f.sim.hold('mail.message.search_read');
    await f.page.evaluate(()=>{window.__olderPending=__hubUiTest.loadOlderMessages();});
    await f.page.waitForFunction(()=>__hubUiTest.state.olderMessageRequests.has('101'));
    await f.page.evaluate(()=>{__hubUiTest.state.selectedChannelId=102;__hubUiTest.state.selectedChannel=__hubUiTest.state.channels.find(c=>c.id===102);__hubUiTest.state.selectionEpoch++;__hubUiTest.state.messages=[];});
    release();await f.page.evaluate(()=>window.__olderPending);assert.equal(await f.page.evaluate(()=>__hubUiTest.state.messages.length),0);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.messagesByChannel.get('101').length),190);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('older-history failure leaves existing messages and a usable retry action',async()=>{
  const f=await fresh();try{seedHistory(f,180);await f.page.evaluate(()=>__hubUiTest.selectChannel(101));f.sim.failOnce('mail.message.search_read');
    assert.equal(await f.page.evaluate(()=>__hubUiTest.loadOlderMessages()),false);assert.equal(await f.page.evaluate(()=>__hubUiTest.state.messages.length),160);
    assert.equal(await f.page.locator('[data-load-older-messages]').isDisabled(),false);await f.page.evaluate(()=>__hubUiTest.loadOlderMessages());
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.messages.length),180);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('switching contact source during a slow Odoo search loads Google and rejects stale results',async()=>{
  const f=await fresh();try{const release=f.sim.hold('res.partner.search_read');
    await f.page.evaluate(()=>{window.__directoryPending=__hubUiTest.loadOdooContactDirectory({reset:true,term:'Demo A'});});
    await f.page.waitForFunction(()=>__hubUiTest.state.isLoadingContactDirectory);
    await f.page.evaluate(()=>__hubUiTest.loadGmailContactDirectory({reset:true,term:'Google'}));
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.gmailContacts.length),1);
    release();await f.page.evaluate(()=>window.__directoryPending);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.contactDirectorySource),'gmail');assert.equal(await f.page.evaluate(()=>__hubUiTest.state.contactDirectorySearchTerm),'Google');
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.isLoadingContactDirectory),false);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('contact drawer loads only the selected customer quotations and invoices',async()=>{
  const f=await fresh();try{f.sim.models['sale.order'].push({id:999,name:'Other customer private quote',partner_id:[602,'Demo B'],state:'draft'});
    await f.page.evaluate(()=>__hubUiTest.selectChannel(101));await f.page.evaluate(()=>__hubUiTest.openCustomerDrawer());
    const text=await f.page.locator('#shCustomerDrawerBody').innerText();assert.match(text,/DEMO-Q-001/);assert.doesNotMatch(text,/Other customer private quote/);
    await f.page.locator('[data-contact-doc-tab="invoices"]').click();assert.match(await f.page.locator('[data-contact-doc-panel="invoices"]').innerText(),/DEMO-INV-001/);assert.deepEqual(f.errors,[]);
    await screenshot(f.page,'r13-customer-business-context-demo');
  }finally{await f.close();}
});
check('new customer form creates and links one contact before quotation actions',async()=>{
  const f=await fresh();try{await f.page.evaluate(async()=>{const h=__hubUiTest;await h.selectChannel(103);await h.openCustomerFormModal();});
    await f.page.locator('#shCustomerName').fill('New offline visitor');await f.page.locator('#shCustomerEmail').fill('visitor@example.invalid');
    await f.page.evaluate(()=>__hubUiTest.saveCustomerFromForm());
    const created=methods(f,'res.partner','create');assert.equal(created.length,1);const partner=f.sim.models['res.partner'].find(p=>p.name==='New offline visitor');assert.ok(partner);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.partnerIdFromChannel(__hubUiTest.state.selectedChannel)),partner.id);
    await f.page.evaluate(()=>__hubUiTest.createQuotationForCurrentCustomer());assert.equal(methods(f,'sale.order','create').at(-1).args[0].partner_id,partner.id);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('attachment upload keeps its original conversation while the operator switches chats',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    const release=f.sim.hold('upload');
    await f.page.evaluate(()=>{window.__pendingUpload=__hubUiTest.sendAttachmentsFromInput([new File(['offline image'],'demo.svg',{type:'image/svg+xml'})]);});
    await f.page.waitForFunction(()=>__hubUiTest.state.isUploadingAttachment);
    await f.page.evaluate(()=>__hubUiTest.selectChannel(102));release();await f.page.evaluate(()=>window.__pendingUpload);
    assert.equal(f.sim.backendWrites.filter(x=>x.path==='/mail/attachment/upload').length,1);
    const post=methods(f,'discuss.channel','message_post')[0];assert.ok(post);assert.equal(post.args[0][0],101);assert.deepEqual(post.kwargs.attachment_ids,[901]);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.selectedChannelId),102);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('predefined quick replies are available as drafts without sending by themselves',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.selectChannel(101));
    const replies=await f.page.evaluate(()=>__hubUiTest.getBuiltInQuickMessages());assert.ok(replies.length);assert.match(replies[0].body,/quotation|customer/i);
    assert.equal(methods(f,'discuss.channel','message_post').length,0);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('a slow inbox result cannot replace the newly selected Sent folder',async()=>{
  const f=await fresh();try{
    const release=f.sim.hold('/api/zoho-mail/messages?Inbox');
    await f.page.evaluate(()=>{window.__oldMailLoad=__hubUiTest.loadMailCenter('inbox');});
    await f.page.waitForFunction(()=>__hubUiTest.state.isMailLoading);
    await f.page.evaluate(()=>__hubUiTest.loadMailCenter('sent'));
    release();await f.page.evaluate(()=>window.__oldMailLoad);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.mailFolder),'sent');
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.mailMessages.length),0);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('a mailbox refresh failure preserves visible messages and reports the error',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.loadMailCenter('inbox'));
    f.sim.failOnce('/api/zoho-mail/messages','Offline mailbox temporarily unavailable');
    await f.page.evaluate(()=>__hubUiTest.loadMailCenter('inbox'));
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.mailMessages.length),1);
    assert.match(await f.page.locator('#shMailStatus').innerText(),/Could not load mail/);
    assert.match(await f.page.locator('#shMailList').innerText(),/Demo quotation enquiry/);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('All mail does not report an empty successful mailbox when a provider folder fails',async()=>{
  const f=await fresh();try{f.sim.failOnce('/api/zoho-mail/messages?Sent','Offline access denied');
    await f.page.evaluate(()=>__hubUiTest.loadMailCenter('all'));
    assert.match(await f.page.locator('#shMailStatus').innerText(),/Could not load mail/);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.isMailLoading),false);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('a slow document-recipient search cannot replace the selected source',async()=>{
  const f=await fresh();try{const release=f.sim.hold('res.partner.search_read');
    await f.page.evaluate(()=>{window.__oldDocContacts=__hubUiTest.loadDocsRecipientsForSource('odoo');});
    await f.page.evaluate(()=>__hubUiTest.loadDocsRecipientsForSource('gmail'));
    release();await f.page.evaluate(()=>window.__oldDocContacts);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.docsRecipientSource),'gmail');
    assert.match(await f.page.locator('#shDocsRecipientList').innerText(),/Demo Google A/);
    assert.doesNotMatch(await f.page.locator('#shDocsRecipientList').innerText(),/Demo Customer A/);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('closing document sharing during a Google import cannot send or retarget a new panel',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.openDocsCenter());
    await f.page.evaluate(()=>{const h=__hubUiTest;h.openDocsSharePanel(h.state.docsDocuments.find(d=>d.id===701));});
    await f.page.evaluate(()=>__hubUiTest.loadDocsRecipientsForSource('gmail'));
    await f.page.evaluate(()=>__hubUiTest.selectDocsRecipient('gmail',0));
    const release=f.sim.hold('/api/google-contacts/import-to-odoo');
    await f.page.evaluate(()=>{window.__oldDocShare=__hubUiTest.shareDocsToSelectedRecipient('whatsapp');});
    await f.page.waitForFunction(()=>__hubUiTest.state.docsShareSending);
    await f.page.evaluate(()=>{const h=__hubUiTest;h.closeDocsSharePanel();h.openDocsSharePanel(h.state.docsDocuments.find(d=>d.id===701));h.selectDocsRecipient('chat',102);});
    release();await f.page.evaluate(()=>window.__oldDocShare);
    assert.equal(f.sim.backendWrites.filter(x=>x.path==='/api/odoo-documents/share').length,0);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.docsSelectedRecipient.channel.id),102);
    assert.equal(await f.page.locator('#shDocsSharePanel').isVisible(),true);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('document share duplicate taps issue one captured send and preserve a newer share panel',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.openDocsCenter());
    await f.page.evaluate(()=>{const h=__hubUiTest;h.openDocsSharePanel(h.state.docsDocuments.find(d=>d.id===701));h.selectDocsRecipient('chat',101);});
    const release=f.sim.hold('/api/odoo-documents/share');
    await f.page.evaluate(()=>{window.__firstDocShare=__hubUiTest.shareDocsToSelectedRecipient('whatsapp');});
    await f.page.waitForFunction(()=>__hubUiTest.state.docsShareSending);
    await f.page.evaluate(()=>__hubUiTest.shareDocsToSelectedRecipient('whatsapp'));
    await f.page.evaluate(()=>{const h=__hubUiTest;h.closeDocsSharePanel();h.openDocsSharePanel(h.state.docsDocuments.find(d=>d.id===701));h.selectDocsRecipient('chat',102);});
    release();await f.page.evaluate(()=>window.__firstDocShare);
    const requests=f.sim.backendWrites.filter(x=>x.path==='/api/odoo-documents/share');
    assert.equal(requests.length,1);assert.equal(requests[0].body.channelId,101);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.docsSelectedRecipient.channel.id),102);assert.equal(await f.page.locator('#shDocsSharePanel').isVisible(),true);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
check('stale-device AI toggle reports the authoritative mode and requires a new explicit action',async()=>{
  const f=await fresh();try{await f.page.evaluate(()=>__hubUiTest.loadAiModeFromServer());
    f.sim.aiMode='zapier';f.sim.aiRevision++;
    assert.equal(await f.page.evaluate(()=>__hubUiTest.setAiMode('manual')),false);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.aiMode),'zapier');
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.aiModeSyncError),'');
    let writes=f.sim.backendWrites.filter(x=>x.path==='/api/ai-mode');assert.equal(writes.length,1);
    assert.equal(writes[0].body.expectedEpoch,'offline-ai');assert.equal(writes[0].body.expectedRevision,1);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.setAiMode('manual')),true);
    assert.equal(f.sim.aiMode,'manual');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

check('a slow contact action lookup cannot replace a later selected contact',async()=>{
  const f=await fresh(),release=f.sim.hold('res.partner.search_read:601');try{
    await f.page.evaluate(()=>{__hubUiTest.state.contactDirectory=[];window.__oldContact=__hubUiTest.openContactActionModal({id:601,name:'Demo Customer A'});});
    await release.entered;
    await f.page.evaluate(()=>__hubUiTest.openContactActionModal({id:602,name:'Demo Customer B'}));
    release();await f.page.evaluate(()=>window.__oldContact);
    assert.equal(await f.page.evaluate(()=>__hubUiTest.state.contactActionRootPartnerId),602);
    assert.match(await f.page.locator('#shContactActionTitle').innerText(),/Demo Customer B/);assert.deepEqual(f.errors,[]);
  }finally{release();await f.close();}
});
check('closing a contact action while lookup is pending cannot reopen the old screen',async()=>{
  const f=await fresh(),release=f.sim.hold('res.partner.search_read:601');try{
    await f.page.evaluate(()=>{__hubUiTest.state.contactDirectory=[];window.__oldContact=__hubUiTest.openContactActionModal({id:601,name:'Demo Customer A'});});
    await release.entered;
    await f.page.evaluate(()=>__hubUiTest.hidePanel(document.getElementById('shContactActionModal')));
    release();await f.page.evaluate(()=>window.__oldContact);
    assert.equal(await f.page.locator('#shContactActionModal').isVisible(),false);assert.deepEqual(f.errors,[]);
  }finally{release();await f.close();}
});
check('quick contact save uses one captured write and cannot close a later contact editor',async()=>{
  const f=await fresh(),release=f.sim.hold('res.partner.write');try{
    await f.page.evaluate(async()=>{const h=__hubUiTest;await h.loadModelFields('res.partner');await h.openPartnerQuickUpdateModal({id:601,name:'Demo Customer A',email:'a@example.invalid'});document.getElementById('shPartnerQuickEmail').value='updated-a@example.invalid';window.__saveOldContact=h.savePartnerQuickUpdate();});
    await release.entered;
    await f.page.evaluate(()=>__hubUiTest.savePartnerQuickUpdate());
    await f.page.evaluate(()=>__hubUiTest.openPartnerQuickUpdateModal({id:602,name:'Demo Customer B',email:'b@example.invalid'}));
    release();await f.page.evaluate(()=>window.__saveOldContact);
    const writes=methods(f,'res.partner','write');assert.equal(writes.length,1);assert.deepEqual(writes[0].args[0],[601]);
    assert.equal(await f.page.locator('#shPartnerQuickEmail').inputValue(),'b@example.invalid');assert.equal(await f.page.locator('#shPartnerQuickUpdateModal').isVisible(),true);assert.deepEqual(f.errors,[]);
  }finally{release();await f.close();}
});
