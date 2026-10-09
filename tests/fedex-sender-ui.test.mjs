import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

// Reproduce the session-expiry scenario: initial config runs before login,
// then a user signs in and loads an Odoo order from the dashboard.
test('FedEx sender address is retried on order load and existing edits are preserved', async () => {
  const src=await readFile(new URL('../public/fedex.js',import.meta.url),'utf8');
  const elMap=new Map();
  function el(id=''){
    if(elMap.has(id))return elMap.get(id);
    const obj={id,value:'',disabled:false,textContent:'',className:'',dataset:{},children:[],innerHTML:'',style:{},listeners:{},
      classList:{toggle(){},add(){},remove(){}},
      addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);},
      append(...nodes){this.children.push(...nodes);},
      appendChild(node){this.children.push(node);},
      replaceChildren(){this.children=[];},
      querySelectorAll(){return [];},
      querySelector(){return null;},
      scrollIntoView(){},
      remove(){}
    };
    elMap.set(id,obj);return obj;
  }
  const document={getElementById:el,createElement:tag=>el('__'+tag+'_'+Math.random()),querySelectorAll:()=>[],querySelector:()=>null};
  let loggedIn=false; const visited=[];
  const response=(status,data)=>({ok:status===200,status,json:async()=>data});
  async function fetch(url){
    visited.push(url);
    if(url.endsWith('/config')){
      return loggedIn
        ? response(200,{ok:true,mode:'sandbox',shippingConfigured:true,trackingConfigured:true,origin:{name:'Smart Handicrafts',company:'Vaidahi Kala',phone:'9999999999',line1:'Okhla Phase I',city:'New Delhi',state:'DL',pin:'110020',country:'IN'}})
        : response(401,{ok:false,error:'Please sign in.'});
    }
    if(url.endsWith('/history'))return response(200,{ok:true,shipments:[]});
    if(url.includes('/orders?'))return response(200,{ok:true,order:{ref:'SO-26/27-00353',items:[],state:'sale',ship_to:{name:'Lukas',country:'CZ'}}});
    if(url.includes('/invoice?'))return response(200,{ok:true,invoice:{status:'missing',options:[],message:'Create invoice'}});
    throw new Error(`Unexpected request: ${url}`);
  }
  const ctx={document,window:{},fetch,console,Date,Intl,setTimeout,URL,Math,Number,Boolean,String,Array,Object,encodeURIComponent};
  runInNewContext(src,ctx,{filename:'fedex.js'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(el('fxFromLine1').value,'','Initial config failed before login');
  assert.equal(el('fxGetRates').disabled,true);
  loggedIn=true;
  // A manually entered contact is left untouched on refresh.
  el('fxFromName').value='Warehouse Operator';
  el('fxOrderRef').value='SO-26/27-00353';
  const handlers=el('fxLoadOrder').listeners.click;
  assert.ok(handlers?.length);
  await handlers[0]({currentTarget:el('fxLoadOrder')});
  assert.equal(visited.filter(x=>x.endsWith('/config')).length,2,'Config retried after login');
  assert.equal(el('fxFromName').value,'Warehouse Operator');
  assert.equal(el('fxFromLine1').value,'Okhla Phase I');
  assert.equal(el('fxFromState').value,'DL');
  assert.equal(el('fxFromPin').value,'110020');
  assert.equal(el('fxToCountry').value,'CZ');
  assert.equal(el('fxGetRates').disabled,false,'Rates button re-enabled after successful config retry');
});
