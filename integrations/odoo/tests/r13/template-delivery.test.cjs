'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {context} = require('./production-functions.cjs');
const functions = ['safeId','normalizeCreateResult','partnerIdFromChannel','buildWizardValue',
  'isApprovedWhatsappTemplate','requireApprovedWhatsappTemplate','isUnavailableWhatsappSendMethod',
  'unconfirmedWhatsappTemplateSend','beginWhatsappTemplateDelivery','confirmWhatsappTemplateDelivery',
  'sendWhatsappTemplateWithFallbacks','sendWhatsappTemplateToPartnerWithFallbacks'];
function fixture({result = [], denied = false, ambiguous = false, readFails = false} = {}) {
  const writes = [], reads = [], fields = {
    'whatsapp.composer': {res_model:{type:'char'},res_id:{type:'integer'},template_id:{type:'many2one'},phone:{type:'char'}},
    'whatsapp.message': {id:{},wa_template_id:{},mobile_number:{},state:{},create_uid:{},failure_reason:{},
      failure_type:{selection:[['template_quality','Template Quality Rating Too Low']]}}
  };
  let sent = false;
  const c = context(functions, {
    state:{selectedChannel:{id:101,channel_type:'whatsapp',whatsapp_partner_id:[601,'Customer'],whatsapp_number:'+919999000101'}},
    currentUserId:()=>7,
    loadModelFields:async model => {if(denied && model==='whatsapp.message') throw Error('Status access denied');return fields[model]||{};},
    searchReadAvailable:async (model,domain) => {
      if(model==='whatsapp.template') return [{id:301,status:'approved'}];
      reads.push(JSON.parse(JSON.stringify(domain)));
      if(!sent) return [{id:80}]; // An older failed send must not be reused.
      if(readFails) throw Error('Status read interrupted');
      return ambiguous ? [{id:81,state:'delivered'},{id:82,state:'error'}] : result;
    },
    createRecord:async (model,values)=>{writes.push({model,values:JSON.parse(JSON.stringify(values))});return 801;},
    callKw:async (model,method)=>{writes.push({model,method});sent=true;return false;},
    messagePost:async()=>{throw Error('Generic message route must not run');}
  });
  return {c,writes,reads,send:target=>target==='partner' ? c.sendWhatsappTemplateToPartnerWithFallbacks(301,{id:601,mobile:'+919999000101'}) : c.sendWhatsappTemplateWithFallbacks(301)};
}
for(const target of ['channel','partner']) {
  test(`${target}: wizard success with a failed WhatsApp row reports the real quality failure once`,async()=>{
    const f=fixture({result:[{id:81,state:'error',failure_type:'template_quality'}]});
    await assert.rejects(f.send(target),e=>e.shTemplateSendAttempted===true && /did not deliver.*Template Quality Rating Too Low/.test(e.message));
    assert.equal(f.writes.filter(x=>x.method).length,1);
    assert.ok(f.reads[1].some(x=>x[0]==='id' && x[1]==='>' && x[2]===80));
    assert.ok(f.reads[0].some(x=>x[0]==='wa_template_id' && x[2]===301));
    assert.ok(f.reads[0].some(x=>x[0]==='create_uid' && x[2]===7));
    assert.ok(f.reads[0].some(x=>x[0]==='mobile_number' && x[2].includes('+919999000101')));
  });
  for(const state of ['delivered','read','replied']) test(`${target}: ${state} is backed by the new recipient's delivery row`,async()=>{
    const f=fixture({result:[{id:81,state}]});
    const result=await f.send(target);assert.equal(result.status,state);assert.match(result.message,/delivered/);
    assert.equal(f.writes.filter(x=>x.method).length,1);
  });
  for(const options of [{denied:true},{readFails:true},{ambiguous:true},{result:[]},{result:[{id:81,state:'outgoing'}]}]) {
    test(`${target}: missing or ambiguous delivery evidence stays pending without resending ${JSON.stringify(options)}`,async()=>{
      const f=fixture(options),result=await f.send(target);
      assert.equal(result.status,'pending');assert.match(result.message,/not confirmed/);
      assert.equal(f.writes.filter(x=>x.method).length,1);
    });
  }
  test(`${target}: sent is not misreported as customer delivery`,async()=>{
    const f=fixture({result:[{id:81,state:'sent'}]}),result=await f.send(target);
    assert.equal(result.status,'sent');assert.match(result.message,/delivery is pending/);
  });
}
test('channel phone already beginning with + is not prefixed twice',async()=>{
  const f=fixture();await f.send('channel');assert.equal(f.writes[0].values.phone,'+919999000101');
});
