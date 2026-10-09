import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerFedexRoutes, __fedexTest} from '../fedex-integration.js';

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
    endpoint.endsWith('/ship/v1/shipments')?{output:{transactionShipments:[{pieceResponses:[{trackingNumber:'123456789012',packageDocuments:[{encodedLabel:Buffer.from('%PDF-1.4\n'+ 'a'.repeat(150)).toString('base64')}]}]}]}}:
    endpoint.endsWith('/pickup/v1/pickups')?{output:{pickupConfirmationCode:'PICKUP-TEST-123'}}:
    endpoint.endsWith('/track/v1/trackingnumbers')?{output:{completeTrackResults:[{trackResults:[{latestStatusDetail:{statusByLocale:'In transit'},scanEvents:[{date:'2026-10-09',eventDescription:'Departed',scanLocation:{city:'Memphis'}}]}]}]}}:{};
  return {ok:true,status:200,json:async()=>result};
 };
 const routes={};const app={use:(path,fn)=>{routes['PROTECT '+path]=fn;},get:(path,fn)=>{routes['GET '+path]=fn;},post:(path,fn)=>{routes['POST '+path]=fn;}};
 registerFedexRoutes(app,{readProfileSession:()=>({profile:'Smart handicrafts'}),odooGetSaleOrderByRef:async ref=>({id:1,ref,state:'sale',ship_to:sample().to,items:[]})});
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
  assert.equal(rateRequest.requestedShipment.customsClearanceDetail.commodities[0].harmonizedCode,'854370');
  assert.equal(rateRequest.requestedShipment.customsClearanceDetail.commodities[0].weight.value,0.3);
  const payload={...sample(),commodities:sampleCommodities(),service:'INTERNATIONAL_PRIORITY',orderRef:'S0001',confirm:true,operationId:randomUUID()};
  const shipment=await run('POST','/api/fedex/shipments',payload);
  assert.equal(shipment.status,200,JSON.stringify(shipment.data));
  assert.equal(shipment.data.record.trackingNumber,'123456789012');assert.equal(shipment.data.record.labelAvailable,true);
  const again=await run('POST','/api/fedex/shipments',payload);assert.equal(again.status,409);
  const all=await run('GET','/api/fedex/shipments');assert.equal(all.data.shipments.length,1);
  const pickup=await run('POST','/api/fedex/pickups',{shipmentId:shipment.data.record.id,date:new Date(Date.now()+2*864e5).toISOString().slice(0,10),ready:'11:00',close:'17:00',confirm:true});
  assert.equal(pickup.status,200,JSON.stringify(pickup.data));assert.equal(pickup.data.pickup.confirmation,'PICKUP-TEST-123');
  const track=await run('POST','/api/fedex/track',{trackingNumber:'123456789012'});
  assert.equal(track.data.status,'In transit');
 } finally {globalThis.fetch=previous;for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(path,{recursive:true,force:true});}
});
