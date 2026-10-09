import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerFedexRoutes, __fedexTest} from '../fedex-integration.js';
import {checkInvoiceAgainstCustoms} from '../fedex-commercial-invoice.js';

const sample = () => ({
 from:{name:'Warehouse Operator',company:'Smart Handicrafts',phone:'9999999999',line1:'Industrial Area',city:'New Delhi',state:'DL',pin:'110020',country:'IN'},
 to:{name:'Test Recipient',company:'Client Co',phone:'1111111111',line1:'Main Street',city:'New York',state:'NY',pin:'10001',country:'US'},
 package:{weight:1,length:20,width:15,height:10},battery:'none'
});
const sampleCommodities = () => [{description:'LED controller',quantity:1,unitPrice:12.5,currency:'USD',hsCode:'854370',weightKg:0.3,countryOfManufacture:'IN'}];
test('validates shipment and battery safety on server',()=>{
 const ok=__fedexTest.shipment(sample());assert.equal(ok.from.address.countryCode,'IN');
 for(const mode of ['contained','packed','standalone','unknown']) assert.throws(()=>__fedexTest.shipment({...sample(),battery:mode}),/blocked/);
 assert.throws(()=>__fedexTest.shipment({...sample(),to:{...sample().to,country:'IN'}}),/international/);
 assert.throws(()=>__fedexTest.commodities([{description:'A test item',quantity:1,unitPrice:10,currency:'USD',weightKg:0.1,countryOfManufacture:'IN',hsCode:'invalid'}]),/HS code/);
});
test('normalizes nested FedEx amount objects to a numeric quote',()=>{
 const q=__fedexTest.rateNormalize({output:{rateReplyDetails:[{serviceType:'INTERNATIONAL_PRIORITY',ratedShipmentDetails:[{rateType:'ACCOUNT',totalNetCharge:{amount:25.75,currency:'USD'}}]}]}});
 assert.equal(q[0].amount,25.75);assert.equal(q[0].currency,'USD');
});
test('selects FedEx preferred account quote in Odoo order currency instead of billing-currency ACCOUNT quote',()=>{
 const q=__fedexTest.rateNormalize({output:{rateReplyDetails:[{
  serviceType:'INTERNATIONAL_ECONOMY',ratedShipmentDetails:[
   {rateType:'PAYOR_ACCOUNT_SHIPMENT',totalNetCharge:{amount:237.63,currency:'EUR'}},
   {rateType:'PREFERRED_ACCOUNT_SHIPMENT',totalNetCharge:{amount:272.11,currency:'USD'}},
   {rateType:'PREFERRED_LIST_SHIPMENT',totalNetCharge:{amount:310.00,currency:'USD'}}
  ]
 }]}},'USD');
 assert.equal(q.length,1);
 assert.equal(q[0].amount,272.11);
 assert.equal(q[0].currency,'USD');
 assert.equal(q[0].rateType,'PREFERRED_ACCOUNT_SHIPMENT');
 assert.equal(q[0].preferredCurrencyMatched,true);
});
test('preserves FedEx EUR amount if a USD preferred quote is unavailable (never relabels as USD)',()=>{
 const q=__fedexTest.rateNormalize({output:{rateReplyDetails:[{
  serviceType:'INTERNATIONAL_PRIORITY',ratedShipmentDetails:[
   {rateType:'PAYOR_ACCOUNT_SHIPMENT',totalNetCharge:{amount:287.89,currency:'EUR'}},
   {rateType:'LIST',totalNetCharge:{amount:321.89,currency:'EUR'}}
  ]
 }]}},'USD');
 assert.equal(q[0].amount,287.89);
 assert.equal(q[0].currency,'EUR');
 assert.equal(q[0].preferredCurrencyMatched,false);
});
test('FedEx import: Czech full-street format becomes a valid recipient; delivery and service fees are omitted',()=>{
 const order=__fedexTest.fedexImportOrder({
  id:353,ref:'SO-26/27-00353',state:'sale',
  ship_to:{name:'Lukas Jiranek',line1:'Hrobce 142, 411 83 Hrobce',line2:'',city:'',pin:'',country:'Czech Republic',countryCode:'CZ'},
  items:[
    {name:'[AS-B-201-SLD-K] KIT - Rechargeable',qty:10,product_id:1,product_name:'Rechargeable KIT'},
    {name:'[AS-B-202-DLD-K] KIT - Rechargeable',qty:10,product_id:2,product_name:'Rechargeable CCT KIT'},
    {name:'[AS-B-206-55-DLD] DRIVER',qty:2,product_id:3,product_name:'DOB Driver'},
    {name:'[Delivery 007] Standard delivery',qty:1,product_id:99,product_name:'Standard delivery',is_delivery:true,is_service:true},
    {name:'Payment Convenience Fee',qty:1,product_id:100,product_name:'Payment Convenience Fee',is_service:true},
    {name:'Section',qty:0,display_type:'line_section'}
  ]
 });
 assert.equal(order.ship_to.country,'CZ');
 assert.equal(order.ship_to.line1,'Hrobce 142');
 assert.equal(order.ship_to.pin,'41183');
 assert.equal(order.ship_to.city,'Hrobce');
 assert.equal(order.items.length,3);
 assert.equal(order.excludedLines,3);
 assert.equal(order.items[0].qty,10);
 assert.equal(__fedexTest.isNonCommodityOrderLine({name:'[Delivery 007] Standard delivery',product_id:99,qty:1}),true);
});
test('FedEx import suggests discounted tax-exclusive sale-order unit prices and real product metadata',()=>{
 const order=__fedexTest.fedexImportOrder({
   ref:'SO-26/27-00353',state:'sale',currencyCode:'USD',ship_to:{countryCode:'CZ'},
   items:[
     {name:'Rechargeable LED driver',product_id:1,product_name:'LED driver',qty:10,
      sale_price_unit:8,sale_price_subtotal:72,sale_discount_pct:10,
      hsCode:'85437090',countryOfManufacture:'CN',weightKg:0.025},
     {name:'DOB Driver',product_id:2,product_name:'DOB Driver',qty:2,
      sale_price_unit:20,sale_price_subtotal:30,sale_discount_pct:25,
      hsCode:'',countryOfManufacture:'',weightKg:null},
     {name:'Standard Delivery',product_id:3,is_delivery:true,qty:1,
      sale_price_unit:12,sale_price_subtotal:12}
   ]
 });
 assert.equal(order.currencyCode,'USD');
 assert.equal(order.items.length,2);
 assert.equal(order.items[0].unitPrice,7.2);
 assert.equal(order.items[0].currency,'USD');
 assert.equal(order.items[0].hsCode,'85437090');
 assert.equal(order.items[0].countryOfManufacture,'CN');
 assert.equal(order.items[0].weightKg,0.025);
 assert.equal(order.items[1].unitPrice,15);
 assert.equal(order.items[1].hsCode,'');
 assert.equal(order.items[1].countryOfManufacture,'');
 assert.equal(order.items[1].weightKg,null);
 assert.equal(order.excludedLines,1);
});
test('FedEx import leaves zero/unknown sale price and unverified customs data blank',()=>{
 const order=__fedexTest.fedexImportOrder({
   ref:'S00002',ship_to:{countryCode:'US'},items:[
     {name:'Free promotional sample',product_id:1,qty:1,sale_price_unit:50,sale_price_subtotal:0,hsCode:'NOT VERIFIED',weightKg:0,countryOfManufacture:'China'},
     {name:'Item with unknown price',product_id:2,qty:2,weightKg:null},
     {name:'Price fallback without subtotal',product_id:3,qty:3,sale_price_unit:10,sale_discount_pct:20}
   ]
 });
 assert.equal(order.items[0].unitPrice,null);
 assert.equal(order.items[0].hsCode,'');
 assert.equal(order.items[0].weightKg,null);
 assert.equal(order.items[0].countryOfManufacture,'');
 assert.equal(order.items[0].currency,'');
 assert.equal(order.items[1].unitPrice,null);
 assert.equal(order.items[2].unitPrice,8);
});
test('FedEx importer does not guess incomplete non-Czech addresses or overwrite populated structured fields',()=>{
 const us=__fedexTest.fedexImportAddress({line1:'Building 42, Market Street',city:'',pin:'',country:'United States',countryCode:'US'});
 assert.equal(us.country,'US');assert.equal(us.line1,'Building 42, Market Street');assert.equal(us.city,'');assert.equal(us.pin,'');
 const cz=__fedexTest.fedexImportAddress({line1:'Hrobce 142, 411 83 Hrobce',city:'Another City',pin:'99999',countryCode:'CZ'});
 assert.equal(cz.line1,'Hrobce 142, 411 83 Hrobce');assert.equal(cz.city,'Another City');assert.equal(cz.pin,'99999');
});
test('FedEx origin never merges legacy SHIP_FROM_LINE2 with a different pickup location',()=>{
 const old=process.env.SHIP_FROM_LINE2;const specific=process.env.FEDEX_ORIGIN_LINE2;
 try {
  process.env.SHIP_FROM_LINE2='Mayapuri, New Delhi, Delhi, 110020';
  delete process.env.FEDEX_ORIGIN_LINE2;
  assert.equal(__fedexTest.originAddress().line2,'');
  process.env.FEDEX_ORIGIN_LINE2='Building A, Unit 3';
  assert.equal(__fedexTest.originAddress().line2,'Building A, Unit 3');
 } finally {
  if(old===undefined)delete process.env.SHIP_FROM_LINE2;else process.env.SHIP_FROM_LINE2=old;
  if(specific===undefined)delete process.env.FEDEX_ORIGIN_LINE2;else process.env.FEDEX_ORIGIN_LINE2=specific;
 }
});

test('FedEx pickup address inherits existing Label Maker SHIP_FROM values after pre-label update',()=>{
 const keys=['FEDEX_ORIGIN_CONTACT','FEDEX_ORIGIN_COMPANY','FEDEX_ORIGIN_PHONE','FEDEX_ORIGIN_EMAIL','FEDEX_ORIGIN_LINE1','FEDEX_ORIGIN_LINE2','FEDEX_ORIGIN_CITY','FEDEX_ORIGIN_STATE_CODE','FEDEX_ORIGIN_POSTAL','FEDEX_ORIGIN_COUNTRY','SHIP_FROM_NAME','SHIP_FROM_COMPANY','SHIP_FROM_PHONE','SHIP_FROM_EMAIL','SHIP_FROM_LINE1','SHIP_FROM_LINE2','SHIP_FROM_CITY','SHIP_FROM_STATE','SHIP_FROM_PIN','SHIP_FROM_COUNTRY'];
 const saved=new Map(keys.map(k=>[k,process.env[k]]));
 try {
  for(const k of keys) delete process.env[k];
  Object.assign(process.env,{SHIP_FROM_NAME:'Smart Handicrafts',SHIP_FROM_COMPANY:'Vaidahi Kala Pvt Ltd',SHIP_FROM_PHONE:'1234567890',SHIP_FROM_LINE1:'First Floor A23 Okhla Phase I',SHIP_FROM_CITY:'New Delhi',SHIP_FROM_STATE:'DL',SHIP_FROM_PIN:'110020',SHIP_FROM_COUNTRY:'India',SHIP_FROM_LINE2:'Mayapuri, New Delhi'});
  const origin=__fedexTest.originAddress();
  assert.equal(origin.name,'Smart Handicrafts');
  assert.equal(origin.line1,'First Floor A23 Okhla Phase I');
  assert.equal(origin.city,'New Delhi');
  assert.equal(origin.state,'DL');
  assert.equal(origin.pin,'110020');
  assert.equal(origin.country,'IN');
  assert.equal(origin.line2,'','Do not restore conflicting legacy second address line');
  process.env.FEDEX_ORIGIN_STATE_CODE='DL';
  process.env.FEDEX_ORIGIN_LINE2='Actual warehouse suite';
  assert.equal(__fedexTest.originAddress().line2,'Actual warehouse suite');
 } finally {for(const [k,v] of saved){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});

test('Czech destination import drops stale US state code from Odoo',()=>{
 const result=__fedexTest.fedexImportAddress({line1:'Hrobce 142',city:'Hrobce',pin:'41183',countryCode:'CZ',state:'US',stateCode:'US'});
 assert.equal(result.country,'CZ');assert.equal(result.state,'');
 const payload={...sample(),to:{...sample().to,country:'CZ',city:'Hrobce',state:result.state,pin:'41183',line1:'Hrobce 142'}};
 assert.equal(__fedexTest.shipment(payload).to.address.stateOrProvinceCode,undefined);
});
test('pre-label check blocks mistaken Czech state, inconsistent weights, unreviewed details and country names',()=>{
 const base={...sample(),commodities:sampleCommodities(),orderRef:'S0001',service:'INTERNATIONAL_ECONOMY',reviewConfirmed:true};
 assert.equal(__fedexTest.preflightReport(base).passed,true);
 const czBad={...base,to:{...base.to,country:'CZ',state:'US',pin:'41183',city:'Hrobce'}};
 assert.equal(__fedexTest.preflightReport(czBad).passed,false);
 assert.match(__fedexTest.preflightReport(czBad).checks.find(x=>x.status==='block').detail,/State Code blank/);
 const badWeights={...base,commodities:[{...sampleCommodities()[0],weightKg:2}]};
 assert.equal(__fedexTest.preflightReport(badWeights).passed,false);
 assert.match(__fedexTest.preflightReport(badWeights).checks.find(x=>x.name==='Commodity and package weights').detail,/exceeds package/);
 assert.equal(__fedexTest.preflightReport({...base,reviewConfirmed:false}).passed,false);
 assert.throws(()=>__fedexTest.shipment({...base,to:{...base.to,country:'Czech Republic'}}),/two-letter country/);
});
test('preflight approval expires and detects edits before creating label',()=>{
 const previous=process.env.PROFILE_SESSION_SECRET;
 process.env.PROFILE_SESSION_SECRET='test-secret-longer-than-thirty-two-characters';
 const base={...sample(),commodities:sampleCommodities(),orderRef:'S0001',service:'INTERNATIONAL_PRIORITY',reviewConfirmed:true};
 try{
  const preflightToken=__fedexTest.preflightToken(base);
  assert.doesNotThrow(()=>__fedexTest.requirePreflightToken({...base,preflightToken}));
  assert.throws(()=>__fedexTest.requirePreflightToken({...base,package:{...base.package,weight:2},preflightToken}),/changed/);
  assert.throws(()=>__fedexTest.requirePreflightToken({...base,service:'INTERNATIONAL_ECONOMY',preflightToken}),/changed/);
 }finally{if(previous===undefined)delete process.env.PROFILE_SESSION_SECRET;else process.env.PROFILE_SESSION_SECRET=previous;}
});
test('commercial invoice requires a posted invoice and exact customs product/quantity/value',()=>{
  const invoice={status:'ready',invoiceId:7,invoiceNumber:'INV-2026-0004',currency:'USD',goodsTotal:12.5,
    lines:[{productId:101,quantity:1,unitPrice:12.5,subtotal:12.5}]};
  const customs=[{...sampleCommodities()[0],productId:101}];
  assert.equal(checkInvoiceAgainstCustoms(invoice,customs).passed,true);
  assert.equal(checkInvoiceAgainstCustoms({...invoice,status:'missing'},customs).passed,false);
  assert.match(checkInvoiceAgainstCustoms(invoice,[{...customs[0],unitPrice:10}]).detail,/differs from posted invoice/);
  assert.match(checkInvoiceAgainstCustoms(invoice,[{...customs[0],quantity:2}]).detail,/quantity/);
  assert.equal(checkInvoiceAgainstCustoms(invoice,[{...customs[0],productId:null}]).passed,false);
});
test('pre-label invoice check blocks missing posted invoice before contacting FedEx for a label',async()=>{
  const routes={};
  const app={use:()=>{},get:(p,f)=>{routes['GET '+p]=f;},post:(p,f)=>{routes['POST '+p]=f;}};
  const before=process.env.PROFILE_SESSION_SECRET;
  const beforeAccount=process.env.FEDEX_SANDBOX_ACCOUNT;
  process.env.PROFILE_SESSION_SECRET='sandbox-fake-secret-longer-than-32-chars';
  process.env.FEDEX_SANDBOX_ACCOUNT='999999999';
  registerFedexRoutes(app,{readProfileSession:()=>({profile:'SUDO'}),odooGetSaleOrderByRef:async ref=>({ref}),
    odooGetFedexInvoiceForOrder:async()=>({status:'missing',message:'Create and post the customer invoice in Odoo first.'})});
  const req={body:{...sample(),commodities:[{...sampleCommodities()[0],productId:101}],orderRef:'S0001',service:'INTERNATIONAL_PRIORITY',reviewConfirmed:true},get:()=>null};
  let output;
  const res={status(){return this;},json(x){output=x;return this;},set(){return this;}};
  try{await routes['POST /api/fedex/preflight'](req,res);
    assert.equal(output.passed,false);
    assert.ok(output.checks.some(c=>c.status==='block'&&/Create and post/.test(c.detail)));
    assert.equal(output.token,null);
  }finally{if(before===undefined) delete process.env.PROFILE_SESSION_SECRET;else process.env.PROFILE_SESSION_SECRET=before;
    if(beforeAccount===undefined)delete process.env.FEDEX_SANDBOX_ACCOUNT;else process.env.FEDEX_SANDBOX_ACCOUNT=beforeAccount;}
});
test('sandbox mocked end-to-end: rate → create label → pickup → tracking; duplicate blocked',async()=>{
 const previous=globalThis.fetch;
 const path=await mkdtemp(join(tmpdir(),'sh-fedex-test-'));
 const requests=[];
 const before=Object.fromEntries(['FEDEX_MODE','FEDEX_SANDBOX_ACCOUNT','FEDEX_SHIPPING_CLIENT_ID','FEDEX_SHIPPING_CLIENT_SECRET','FEDEX_TRACKING_CLIENT_ID','FEDEX_TRACKING_CLIENT_SECRET','FEDEX_DATA_DIR','PROFILE_SESSION_SECRET'].map(k=>[k,process.env[k]]));
 Object.assign(process.env,{FEDEX_MODE:'sandbox',FEDEX_SANDBOX_ACCOUNT:'999999999',FEDEX_SHIPPING_CLIENT_ID:'test-shipping',FEDEX_SHIPPING_CLIENT_SECRET:'shipping-secret',FEDEX_TRACKING_CLIENT_ID:'test-tracking',FEDEX_TRACKING_CLIENT_SECRET:'tracking-secret',FEDEX_DATA_DIR:path,PROFILE_SESSION_SECRET:'a-long-random-test-secret-not-used-in-production'});
 globalThis.fetch=async(url,init)=>{
  const endpoint=new URL(url).pathname;requests.push({endpoint,body:init.body});
  const result=endpoint==='/oauth/token'?{access_token:'dummy-oauth-token',expires_in:3600}:
    endpoint.endsWith('/rate/v1/rates/quotes')?{output:{rateReplyDetails:[{serviceType:'INTERNATIONAL_PRIORITY',ratedShipmentDetails:[{rateType:'ACCOUNT',totalNetCharge:{amount:51.44,currency:'USD'}}]}]}}:
    endpoint.endsWith('/ship/v1/shipments')?{output:{transactionShipments:[{pieceResponses:[{trackingNumber:'123456789012',packageDocuments:[{encodedLabel:Buffer.from('%PDF-1.4\n'+ 'a'.repeat(150)+'\n%%EOF\n').toString('base64')}]}]}]}}:
    endpoint.endsWith('/pickup/v1/pickups')?{output:{pickupConfirmationCode:'PICKUP-TEST-123'}}:
    endpoint.endsWith('/track/v1/trackingnumbers')?{output:{completeTrackResults:[{trackResults:[{latestStatusDetail:{statusByLocale:'In transit'},scanEvents:[{date:'2026-10-09',eventDescription:'Departed',scanLocation:{city:'Memphis'}}]}]}]}}:{};
  return {ok:true,status:200,json:async()=>result};
 };
 const routes={};const app={use:(path,fn)=>{routes['PROTECT '+path]=fn;},get:(path,fn)=>{routes['GET '+path]=fn;},post:(path,fn)=>{routes['POST '+path]=fn;}};
 registerFedexRoutes(app,{readProfileSession:()=>({profile:'Smart handicrafts'}),odooGetSaleOrderByRef:async ref=>({id:1,ref,state:'sale',ship_to:sample().to,items:[]}),odooGetFedexInvoiceForOrder:async(ref,id)=>({status:'ready',invoiceId:7,invoiceNumber:'INV2026007',currency:'USD',goodsTotal:12.5,lines:[{productId:101,quantity:1,unitPrice:12.5,subtotal:12.5}]}),createCommercialInvoicePdf:async()=>Buffer.from('%PDF-1.4\n'+ 'a'.repeat(1500) +'\n%%EOF\n')});
 async function run(method,pathName,body={},query={}){
  const req={body,query,headers:{host:'test.local'},get(k){return this.headers[k.toLowerCase()];},params:{}};
  let output,statusCode=200;
  const res={status(c){statusCode=c;return this;},json(v){output=v;return this;},set(){return this;},send(v){output=v;return this;}};
  await routes[method+' '+pathName](req,res);
  return {status:statusCode,data:output};
 }
 try{
  const noCustoms=await run('POST','/api/fedex/rates',sample());
  assert.equal(noCustoms.status,400);
  assert.match(noCustoms.data.error,/customs commodities/);
  assert.equal(requests.filter(x=>x.endpoint.endsWith('/rate/v1/rates/quotes')).length,0);
  const {data:q}=await run('POST','/api/fedex/rates',{...sample(),commodities:sampleCommodities()});assert.equal(q.rates[0].amount,51.44);
  const rateCall=requests.find(x=>x.endpoint.endsWith('/rate/v1/rates/quotes'));
  assert.ok(rateCall);
  const rateRequest=JSON.parse(rateCall.body);
  assert.deepEqual(rateRequest.requestedShipment.customsClearanceDetail.customsValue,{amount:12.5,currency:'USD'});
  assert.equal(rateRequest.requestedShipment.preferredCurrency,'USD');
  assert.deepEqual(rateRequest.requestedShipment.rateRequestType,['PREFERRED','LIST']);
  assert.equal(q.requestedCurrency,'USD');
  // Rate currency is driven by the *Odoo order*, not by manually edited customs values.
  const otherQuote=await run('POST','/api/fedex/rates',{...sample(),commodities:sampleCommodities(),orderCurrency:'INR'});
  assert.equal(otherQuote.status,200);
  const requestsToRates=requests.filter(x=>x.endpoint.endsWith('/rate/v1/rates/quotes'));
  assert.equal(JSON.parse(requestsToRates.at(-1).body).requestedShipment.preferredCurrency,'INR');
  assert.equal(otherQuote.data.requestedCurrency,'INR');
  assert.equal(otherQuote.data.rates[0].currency,'USD');
  assert.equal(otherQuote.data.rates[0].preferredCurrencyMatched,false);
  assert.equal(rateRequest.requestedShipment.customsClearanceDetail.commodities[0].harmonizedCode,'854370');
  assert.equal(rateRequest.requestedShipment.customsClearanceDetail.commodities[0].weight.value,0.3);
  const payload={...sample(),commodities:[{...sampleCommodities()[0],productId:101}],service:'INTERNATIONAL_PRIORITY',orderRef:'S0001',invoiceId:7,reviewConfirmed:true,confirm:true,operationId:randomUUID()};
  const checkInvoice=await run('GET','/api/fedex/invoice',{}, {ref:'S0001'});
  assert.equal(checkInvoice.data.invoice.invoiceNumber,'INV2026007');
  const withoutPreflight=await run('POST','/api/fedex/shipments',payload);
  assert.equal(withoutPreflight.status,400);
  const beforeApproval=await run('POST','/api/fedex/preflight',payload);
  assert.equal(beforeApproval.status,200);
  assert.equal(beforeApproval.data.passed,true,JSON.stringify(beforeApproval.data));
  const shipmentPayload={...payload,preflightToken:beforeApproval.data.token};
  const shipment=await run('POST','/api/fedex/shipments',shipmentPayload);
  assert.equal(shipment.status,200,JSON.stringify(shipment.data));
  assert.equal(shipment.data.record.trackingNumber,'123456789012');assert.equal(shipment.data.record.labelAvailable,true);
  const listing=await run('GET','/api/fedex/shipments');assert.equal(listing.data.shipments[0].invoiceAvailable,true);assert.equal(listing.data.shipments[0].invoiceNumber,'INV2026007');
  const again=await run('POST','/api/fedex/shipments',shipmentPayload);assert.equal(again.status,409);
  const all=await run('GET','/api/fedex/shipments');assert.equal(all.data.shipments.length,1);
  const pickup=await run('POST','/api/fedex/pickups',{shipmentId:shipment.data.record.id,date:new Date(Date.now()+2*864e5).toISOString().slice(0,10),ready:'11:00',close:'17:00',confirm:true});
  assert.equal(pickup.status,200,JSON.stringify(pickup.data));assert.equal(pickup.data.pickup.confirmation,'PICKUP-TEST-123');
  const track=await run('POST','/api/fedex/track',{trackingNumber:'123456789012'});
  assert.equal(track.data.status,'In transit');
 } finally {globalThis.fetch=previous;for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(path,{recursive:true,force:true});}
});
