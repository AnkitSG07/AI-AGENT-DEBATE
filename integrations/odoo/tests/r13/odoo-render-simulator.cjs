'use strict';
// Stateful protocol simulator, not a substitute for Odoo/Zoho/provider acceptance.
// All records are invented. No route is forwarded to an external service.
const crypto=require('node:crypto');
const clone=v=>JSON.parse(JSON.stringify(v));
const f=(type='char',relation)=>({type,readonly:false,...(relation?{relation}:{})});
const scalar=v=>Array.isArray(v)&&v.length===2&&typeof v[1]==='string'?v[0]:v;
function compare(row,term) {
  const [field,op,want]=term;let got=scalar(row[field]);if(got===undefined)got=false;
  switch(op) {
    case '=':return got===want;case '!=':return got!==want;
    case 'in':return Array.isArray(got)?got.some(x=>want.includes(scalar(x))):want.includes(got);
    case 'not in':return !compare(row,[field,'in',want]);
    case 'ilike':return String(got||'').toLowerCase().includes(String(want).replaceAll('%','').toLowerCase());
    case 'like':return String(got||'').includes(String(want).replaceAll('%',''));
    case '>':return got>want;case '<':return got<want;case '>=':return got>=want;case '<=':return got<=want;
    case 'child_of':return got===want||row.commercial_partner_id?.[0]===want;
    default:throw new Error('Simulator does not implement domain operator: '+op);
  }
}
function matches(row,domain=[]) {
  let i=0;
  const take=()=>{const x=domain[i++];if(x==='|'){const a=take(),b=take();return a||b;}if(x==='&'){const a=take(),b=take();return a&&b;}if(x==='!')return !take();return compare(row,x);};
  let result=true;while(i<domain.length){const part=take();result=result&&part;}return result;
}
class Simulator {
  constructor(){
    this.calls=[];this.unexpected=[];this.holds=new Map();this.faults=[];this.nextId=2000;this.backendReads=[];this.backendWrites=[];this.aiMode='manual';this.aiRevision=1;
    const now=new Date().toISOString();
    this.models={
      'res.partner':[
        {id:601,name:'Demo Customer A',display_name:'Demo Customer A',phone:'919999000101',mobile:'919999000101',email:'a@example.invalid',active:true,city:'Demo city',parent_id:false,commercial_partner_id:[601,'Demo Customer A'],is_company:false,write_date:now},
        {id:602,name:'Demo Customer B',display_name:'Demo Customer B',phone:'919999000102',mobile:'919999000102',email:'b@example.invalid',active:true,parent_id:false,commercial_partner_id:[602,'Demo Customer B'],is_company:false,write_date:now}
      ],
      'discuss.channel':[
        {id:101,name:'Demo Customer A',display_name:'Demo Customer A',channel_type:'whatsapp',whatsapp_number:'919999000101',whatsapp_partner_id:[601,'Demo Customer A'],whatsapp_channel_active:true,whatsapp_channel_valid_until:new Date(Date.now()+86400000).toISOString(),active:true,last_interest_dt:now,write_date:now,message_ids:[]},
        {id:102,name:'Demo Customer B',display_name:'Demo Customer B',channel_type:'whatsapp',whatsapp_number:'919999000102',whatsapp_partner_id:[602,'Demo Customer B'],whatsapp_channel_active:true,whatsapp_channel_valid_until:new Date(Date.now()+86400000).toISOString(),active:true,last_interest_dt:now,write_date:now,message_ids:[]},
        {id:103,name:'Demo Website Visitor',display_name:'Demo Website Visitor',channel_type:'livechat',active:true,last_interest_dt:now,write_date:now,message_ids:[]},
        {id:104,name:'Demo Handicrafts Team',display_name:'Demo Handicrafts Team',channel_type:'group',active:true,last_interest_dt:now,write_date:now,message_ids:[]}
      ],
      'mail.message':[], 'ir.attachment':[{id:901,name:'Demo photo.svg',mimetype:'image/svg+xml',type:'binary',file_size:1024}],
      'sale.order':[{id:801,name:'DEMO-Q-001',partner_id:[601,'Demo Customer A'],state:'draft',amount_total:1200,currency_id:[1,'INR'],date_order:now}],
      'account.move':[{id:811,name:'DEMO-INV-001',partner_id:[601,'Demo Customer A'],state:'posted',move_type:'out_invoice',amount_total:1200,currency_id:[1,'INR'],invoice_date:now.slice(0,10),payment_state:'not_paid'}],
      'mail.activity':[], 'mail.activity.type':[{id:7,name:'Call',category:'phonecall'}], 'ir.model':[{id:88,model:'res.partner',name:'Contact'}],
      'whatsapp.template':[{id:301,name:'Demo approved greeting',display_name:'Demo greeting',status:'approved',body:'Hello from the offline simulator',lang_code:'en_US'},{id:302,name:'Demo rejected',status:'rejected',body:'Not approved'}],
      'whatsapp.composer':[], 'mail.shortcode':[{id:701,substitution:'Demo quick reply',source:':demo:',description:'Demo quick'}],
      'mail.canned.response':[{id:701,source:':demo:',substitution:'Demo quick reply',description:'Demo quick'}],
      'im_livechat.conversation.tag':[{id:501,name:'Demo customer',color:4}], 'discuss.channel.member':[], 'mail.mail':[], 'res.users':[{id:7,name:'Demo Operator',partner_id:[7,'Demo Operator']}],
      'res.country':[{id:104,name:'India',code:'IN'}], 'res.country.state':[{id:10,name:'Demo state',country_id:[104,'India']}]
    };
    this.fields={};
    for(const [model,rows]of Object.entries(this.models))this.fields[model]=Object.fromEntries([...new Set(['id',...rows.flatMap(Object.keys)])].map(k=>[k,f(k==='id'?'integer':'char')]));
    Object.assign(this.fields['discuss.channel'],{channel_partner_ids:f('many2many','res.partner'),channel_member_ids:f('one2many','discuss.channel.member'),whatsapp_partner_id:f('many2one','res.partner'),livechat_conversation_tag_ids:f('many2many','im_livechat.conversation.tag')});
    Object.assign(this.fields['res.partner'],Object.fromEntries(['name','email','phone','mobile','street','street2','city','zip','vat','website'].map(k=>[k,f()])));
    Object.assign(this.fields['mail.message'],Object.fromEntries(['id','res_id','model','body','preview','date','message_type','subject','attachment_ids','author_id','create_uid','starred_partner_ids','needaction_partner_ids','email_from','outgoing_email_to','incoming_email_to','partner_ids'].map(k=>[k,f(k.endsWith('_ids')?'many2many':'char')])));
    Object.assign(this.fields['mail.activity'],Object.fromEntries(['res_model_id','res_id','activity_type_id','summary','note','date_deadline','user_id'].map(k=>[k,f()])));
    Object.assign(this.fields['whatsapp.composer'],{res_model:f(),res_id:f('integer'),template_id:f('many2one','whatsapp.template')});
    this.fields['im_livechat.conversation.tag'].color=f('integer');
    this.google=[{resourceName:'people/demo-a',name:'Demo Google A',display_name:'Demo Google A',displayName:'Demo Google A',phone:'919999000201',email:'google-a@example.invalid',names:[{displayName:'Demo Google A'}],phoneNumbers:[{value:'919999000201'}],emailAddresses:[{value:'google-a@example.invalid'}]}];
    this.documents=[{id:700,name:'Demo Certificates',type:'folder',is_folder:true,folder_id:false},
      {id:701,name:'Demo safety certificate.pdf',type:'binary',folder_id:700,mimetype:'application/pdf',file_extension:'pdf',file_size:2048,view_url:'https://ai-agent-debate.onrender.com/api/odoo-documents/view/701?share=demo-signed-view',download_url:'https://ai-agent-debate.onrender.com/api/odoo-documents/download/701?share=demo-signed-download',link_expires_at:Date.now()+3600000}];
    this.zohoMessages=[{messageId:'mail-a',subject:'Demo quotation enquiry',fromAddress:'Demo Customer A <a@example.invalid>',toAddress:'care@smarthandicrafts.com',receivedTime:String(Date.now()),summary:'Please prepare an offline quotation',status:'0',folderId:'inbox',hasAttachment:false}];
  }
  hold(key){let release,markEntered;const promise=new Promise(r=>release=r),entered=new Promise(r=>markEntered=r);this.holds.set(key,{promise,release,markEntered});const done=()=>{this.holds.delete(key);release();};done.entered=entered;return done;}
  failOnce(key,message='Synthetic provider interruption'){this.faults.push({key,message});}
  async gate(key){const i=this.faults.findIndex(x=>x.key===key);if(i>=0)throw new Error(this.faults.splice(i,1)[0].message);const hold=this.holds.get(key);if(hold){hold.markEntered();await hold.promise;}}
  async rpc(packet){
    const {model,method,args=[],kwargs={}}=packet.params||{};this.calls.push(clone({model,method,args,kwargs}));await this.gate(model+'.'+method);
    const exactId=(args[0]||[]).find?.(term=>Array.isArray(term)&&term[0]==='id'&&term[1]==='=')?.[2];
    if(exactId)await this.gate(model+'.'+method+':'+exactId);
    if(!this.models[model])throw new Error('Simulator model unsupported: '+model);
    const rows=this.models[model];
    if(method==='fields_get')return this.fields[model];
    if(['has_access','check_access_rights'].includes(method))return true;
    if(method==='search_read'||method==='search_count'||method==='search'){
      if(method==='search_read'&&this.strictFields){for(const name of args[1]||kwargs.fields||[])if(!this.fields[model][name])throw new Error('Unknown model field: '+model+'.'+name);}
      let selected=rows.filter(r=>matches(r,args[0]||kwargs.domain||[]));
      if(method==='search_count')return selected.length;
      if(kwargs.order)selected=selected.sort((a,b)=>{for(const clause of kwargs.order.split(',')){const [key,dir]=clause.trim().split(/\s+/);const x=scalar(a[key]),y=scalar(b[key]);if(x===y)continue;return(x>y?1:-1)*(dir==='desc'?-1:1);}return 0;});
      selected=selected.slice(kwargs.offset||0,kwargs.limit?(kwargs.offset||0)+kwargs.limit:undefined);
      if(method==='search')return selected.map(x=>x.id);
      return clone(selected);
    }
    if(method==='read')return clone(rows.filter(r=>(args[0]||[]).includes(r.id)));
    if(method==='create'){
      const many=Array.isArray(args[0]);const entries=many?args[0]:[args[0]];
      const ids=entries.map(v=>{const id=++this.nextId;rows.push({id,...clone(v),...(model==='sale.order'?{state:'draft'}:{}),...(model==='discuss.channel'?{display_name:v.name,active:true,last_interest_dt:new Date().toISOString()}:{} )});return id;});return many?ids:ids[0];
    }
    if(method==='write'){
      for(const row of rows.filter(r=>(args[0]||[]).includes(r.id)))for(const [key,value]of Object.entries(args[1]||{})){
        if(Array.isArray(value)&&value.every(x=>Array.isArray(x))){let ids=[...(row[key]||[])];for(const [op,id,list]of value){if(op===4&&!ids.includes(id))ids.push(id);if(op===3)ids=ids.filter(x=>x!==id);if(op===6)ids=[...list];}row[key]=ids;}else row[key]=clone(value);
      }return true;
    }
    if(method==='unlink'){this.models[model]=rows.filter(r=>!args[0].includes(r.id));return true;}
    if(model==='discuss.channel'&&method==='message_post'){
      const id=++this.nextId;const channelId=Number(Array.isArray(args[0])?args[0][0]:args[0]);this.models['mail.message'].push({id,model:'discuss.channel',res_id:channelId,date:new Date().toISOString(),author_id:[7,'Demo Operator'],create_uid:[7,'Demo Operator'],attachment_ids:[],...clone(kwargs)});return id;
    }
    if(['mark_as_read','channel_seen','set_channel_seen'].includes(method))return true;
    if(model==='whatsapp.composer'&&['action_send_whatsapp_template','action_send_whatsapp_message'].includes(method))return true;
    this.unexpected.push({model,method});throw new Error('Unimplemented simulator RPC: '+model+'.'+method);
  }
  async route(route,url,req){
    const json=(data,status=200)=>route.fulfill({status,contentType:'application/json; charset=utf-8',body:JSON.stringify(data)});
    if(url.pathname==='/operator-auth'){
      const state=url.searchParams.get('state');
      await route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset=utf-8><title>Offline profile simulator</title><p>Simulated signed profile, no real credentials.</p><script>const state=${JSON.stringify(state)};window.addEventListener('message',e=>{if(e.origin!=='https://www.smarthandicrafts.com'||e.source!==opener||e.data.state!==state)return;opener.postMessage({type:'sh-operator-browser-auth',state,token:'SIMULATED_ONLY_${crypto.randomBytes(30).toString('hex')}',expiresAt:Date.now()+600000,authExpiresAt:Date.now()+3600000,operatorDeviceId:'offline::demo'},'https://www.smarthandicrafts.com');});opener.postMessage({type:'sh-operator-auth-ready',state},'https://www.smarthandicrafts.com');</script>`});return true;
    }
    if(url.pathname.startsWith('/web/dataset/call_kw/')){
      const packet=JSON.parse(req.postData()||'{}');try{await json({jsonrpc:'2.0',id:packet.id,result:await this.rpc(packet)});}catch(e){await json({jsonrpc:'2.0',id:packet.id,error:{message:e.message,data:{name:'odoo.exceptions.AccessError',message:e.message}}});}return true;
    }
    // Odoo19 AttachmentController returns data.attachment_id, not a bare id.
    if(url.pathname==='/mail/attachment/upload'){this.backendWrites.push({path:url.pathname,method:req.method(),body:req.postData()});await this.gate('upload');await json({data:{attachment_id:901,store_data:{'ir.attachment':[this.models['ir.attachment'][0]]}}});return true;}
    if(!url.pathname.startsWith('/api/'))return false;
    const authorized=/^Bearer SIMULATED_ONLY_[a-f0-9]{60}$/.test(req.headers().authorization||'');
    const item={path:url.pathname,query:Object.fromEntries(url.searchParams),method:req.method(),body:req.postData()?JSON.parse(req.postData()):null,authorized};
    (req.method()==='GET'?this.backendReads:this.backendWrites).push(item);
    if(/^\/api\/(zoho-mail|google-contacts|odoo-documents|ai-mode)(\/|$)/.test(url.pathname)&&!authorized){await json({ok:false,error:'Offline simulator requires the operator capability'},401);return true;}
    try{await this.gate(url.pathname);if(url.search)await this.gate(url.pathname+'?'+url.searchParams.get('folderType'));}catch(e){await json({ok:false,error:e.message},503);return true;}
    let data;
    switch(url.pathname){
      case '/api/zoho-mail/status':data={ok:true,authorized:true,account:{emailAddress:'care@smarthandicrafts.com'}};break;
      case '/api/zoho-mail/folders':data={ok:true,folders:[{folderId:'inbox',folderType:'Inbox',folderName:'Inbox'},{folderId:'sent',folderType:'Sent',folderName:'Sent'}]};break;
      case '/api/zoho-mail/messages':data={ok:true,messages:url.searchParams.get('folderType')==='Sent'?[]:this.zohoMessages,folderId:'inbox'};break;
      case '/api/zoho-mail/send':case '/api/zoho-mail/reply':data={ok:true,messageId:'sent-demo'};break;
      case '/api/google-contacts/status':data={ok:true,authorized:true,account_email:'offline@example.invalid'};break;
      case '/api/google-contacts/search':data={ok:true,contacts:this.google,account_email:'offline@example.invalid'};break;
      case '/api/google-contacts/import-to-odoo':{const partner={id:++this.nextId,name:'Demo Google A',phone:'919999000201',email:'google-a@example.invalid'};this.models['res.partner'].push(partner);data={ok:true,partner,partner_id:partner.id};break;}
      case '/api/odoo-documents/tree':data={ok:true,documents:this.documents,tree:[{...this.documents[0],children:[]}]};break;
      case '/api/odoo-documents/share':data={ok:true,link:this.documents[1].view_url};break;
      case '/api/ai-mode':
        if(req.method()==='POST'){
          if(typeof item.body.expectedEpoch!=='string'||!item.body.expectedEpoch||!Number.isSafeInteger(item.body.expectedRevision)||item.body.expectedRevision<0){
            await json({ok:false,code:'INVALID_AI_REVISION',error:'Reload the current AI mode before changing it.'},400);return true;
          }
          if(item.body.expectedEpoch!=='offline-ai'||item.body.expectedRevision!==this.aiRevision){
            await json({ok:false,code:'AI_MODE_CHANGED',mode:this.aiMode,epoch:'offline-ai',revision:this.aiRevision},409);return true;
          }
          this.aiMode=item.body.mode;this.aiRevision++;
        }
        data={ok:true,mode:this.aiMode,epoch:'offline-ai',revision:this.aiRevision};break;
      case '/api/whatsapp-calls/config':data={ok:true,auth_required:true};break;
      default:if(url.pathname.startsWith('/api/zoho-mail/message/'))data={ok:true,message:{content:'<p>Demo email content</p>',fromAddress:'a@example.invalid',toAddress:'care@smarthandicrafts.com'}};else if(/\/api\/(whatsapp-calls|operator-devices|push|operator-call-locks)\//.test(url.pathname))data={ok:true,logs:[],calls:[]};else{this.unexpected.push({path:url.pathname});data={ok:false,error:'Unimplemented simulator API'};}
    }
    await json(data,data.ok?200:503);return true;
  }
}
module.exports={Simulator,matches};
