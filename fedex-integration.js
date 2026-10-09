/** Smart Handicrafts FedEx REST API integration (sandbox-first).
 *  No credentials or FedEx network calls are made in the browser.
 *  Production mutations require a separate explicit server-side enable switch.
 */
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ISO = /^[A-Z]{2}$/;
const SERVICES = new Set(['INTERNATIONAL_PRIORITY','INTERNATIONAL_ECONOMY','FEDEX_INTERNATIONAL_PRIORITY','FEDEX_INTERNATIONAL_ECONOMY','INTERNATIONAL_FIRST','FEDEX_INTERNATIONAL_CONNECT_PLUS','FEDEX_INTERNATIONAL_PRIORITY_EXPRESS']);
const MAX_LABEL_BYTES = 2_000_000;
const safeStr = (v, n = 120) => String(v ?? '').trim().slice(0, n);
const num = (v, label, min = 0.001, max = 1000000) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${label}.`); return n; };
const country = v => { const c = safeStr(v, 2).toUpperCase(); if (!ISO.test(c)) throw new Error('Use a two-letter country code (e.g. US, IN).'); return c; };
const env = name => String(process.env[name] || '').trim();
const urlBase = () => env('FEDEX_MODE') === 'production' ? 'https://apis.fedex.com' : 'https://apis-sandbox.fedex.com';
const isProduction = () => env('FEDEX_MODE') === 'production';
const account = () => env(isProduction() ? 'FEDEX_ACCOUNT_NUMBER' : 'FEDEX_SANDBOX_ACCOUNT');
// Shipping dates must use the dispatch country's calendar day, not the UTC day.
function todayIndia(){ const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()); const part=t=>parts.find(p=>p.type===t)?.value||'';return `${part('year')}-${part('month')}-${part('day')}`; }
const credentials = (kind) => ({
  id: env(kind === 'tracking' ? (isProduction() ? 'FEDEX_TRACKING_PROD_CLIENT_ID' : 'FEDEX_TRACKING_CLIENT_ID') : (isProduction() ? 'FEDEX_SHIPPING_PROD_CLIENT_ID' : 'FEDEX_SHIPPING_CLIENT_ID')),
  secret: env(kind === 'tracking' ? (isProduction() ? 'FEDEX_TRACKING_PROD_CLIENT_SECRET' : 'FEDEX_TRACKING_CLIENT_SECRET') : (isProduction() ? 'FEDEX_SHIPPING_PROD_CLIENT_SECRET' : 'FEDEX_SHIPPING_CLIENT_SECRET'))
});
const cache = new Map();
function fail(message, status=400) { const e=new Error(message); e.status=status; throw e; }
function originAddress() { return {
  name: env('FEDEX_ORIGIN_CONTACT') || env('SHIP_FROM_NAME'),
  company: env('FEDEX_ORIGIN_COMPANY') || env('SHIP_FROM_COMPANY'),
  phone: env('FEDEX_ORIGIN_PHONE') || env('SHIP_FROM_PHONE'),
  email: env('FEDEX_ORIGIN_EMAIL') || env('SHIP_FROM_EMAIL'),
  line1: env('FEDEX_ORIGIN_LINE1') || env('SHIP_FROM_LINE1'),
  // Do not combine a warehouse street with an unrelated legacy address line.
  // Configure FEDEX_ORIGIN_LINE2 explicitly if your FedEx pickup address
  // genuinely has a second street line; otherwise leave it blank.
  line2: env('FEDEX_ORIGIN_LINE2'),
  city: env('FEDEX_ORIGIN_CITY') || env('SHIP_FROM_CITY'),
  state: env('FEDEX_ORIGIN_STATE_CODE'),
  pin: env('FEDEX_ORIGIN_POSTAL') || env('SHIP_FROM_PIN'),
  country: env('FEDEX_ORIGIN_COUNTRY') || 'IN'
}; }

// Normalize the Odoo data for FedEx only. Never rewrite Odoo contact records.
// Prefer canonical country/state codes loaded from Odoo, and leave any
// ambiguous address elements blank for human review rather than inventing them.
function fedexImportAddress(source = {}) {
  const a = { ...source };
  const fallback = {
    'INDIA':'IN', 'CZECH REPUBLIC':'CZ', 'CZECHIA':'CZ',
    'UNITED STATES':'US', 'UNITED STATES OF AMERICA':'US', 'USA':'US',
    'UNITED KINGDOM':'GB', 'GREAT BRITAIN':'GB', 'GERMANY':'DE',
    'FRANCE':'FR', 'CANADA':'CA', 'UNITED ARAB EMIRATES':'AE',
    'UAE':'AE', 'BRAZIL':'BR'
  };
  const originalCountry = String(a.country || '').trim().toUpperCase();
  a.country = String(a.countryCode || fallback[originalCountry] || a.country || '').trim().toUpperCase();
  a.state = a.stateCode || (a.country === 'CZ' ? '' : a.state || '');

  // Some legacy Odoo partners store their *entire* Czech address in `street`,
  // e.g. "Hrobce 142, 411 83 Hrobce" while leaving city and ZIP blank.
  // Extract only this unambiguous CZ pattern; don't guess for other countries.
  if (a.country === 'CZ') {
    const street = String(a.line1 || '').trim();
    const m = street.match(/^(.*?),\s*(\d{3})\s?(\d{2})\s+([^,\d][^,]*)$/u);
    if (m && m[1].trim()) {
      const streetZip = m[2] + m[3];
      const sameZip = !a.pin || String(a.pin).replace(/\s/g, '') === streetZip;
      const sameCity = !a.city || String(a.city).trim().toLocaleLowerCase() === m[4].trim().toLocaleLowerCase();
      if (sameZip && sameCity) {
        a.line1 = m[1].trim();
        a.pin = a.pin || streetZip;
        a.city = a.city || m[4].trim();
      }
    }
  }
  return a;
}

function isNonCommodityOrderLine(item = {}) {
  if (item.is_delivery === true || item.is_service === true || item.display_type) return true;
  if (!item.product_id) return true;
  const desc = String(item.product_name || item.name || '').trim();
  // Safety fallback for older Odoo data with missing product-type flags.
  // Match clear shipping/fee products, not generic products with "delivery"
  // appearing somewhere in their description.
  return /^\s*(?:\[[^\]]*(?:delivery|shipping|freight)[^\]]*\]\s*)?(?:standard delivery|delivery charges?|shipping charges?|shipping fees?|payment convenience fee|courier charges?|freight charges?)\b/i.test(desc)
    || /^\s*\[(?:delivery|shipping|freight)[^\]]*\]/i.test(desc);
}

// Suggest a declared unit value from the sales-order line, NOT the catalog
// price or order total. Odoo's price_subtotal includes line discounts and
// excludes tax. Free/zero-value lines must be reviewed and priced manually.
function suggestedUnitValue(line = {}) {
  const qty = Number(line.qty);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const subtotal = line.sale_price_subtotal;
  let netUnit;
  if (subtotal !== undefined && subtotal !== null && subtotal !== false && subtotal !== '') {
    netUnit = Number(subtotal) / qty;
  } else {
    const listUnit = Number(line.sale_price_unit);
    const discount = Number(line.sale_discount_pct || 0);
    netUnit = listUnit * (1 - discount / 100);
  }
  if (!Number.isFinite(netUnit) || netUnit <= 0) return null;
  const rounded = Number(netUnit.toFixed(2));
  return rounded >= 0.01 ? rounded : null;
}

function fedexImportOrder(order = {}) {
  const items = (order.items || []).filter(i =>
    Number(i.qty) > 0 && !isNonCommodityOrderLine(i)
  );
  return {
    id: order.id,
    ref: order.ref,
    state: order.state,
    ship_to: fedexImportAddress(order.ship_to),
    currencyCode: /^[A-Z]{3}$/.test(String(order.currencyCode || '').toUpperCase()) ? String(order.currencyCode).toUpperCase() : '',
    items: items.map(i => ({
      name: i.name, qty: i.qty, product_name: i.product_name,
      unitPrice: suggestedUnitValue(i),
      currency: /^[A-Z]{3}$/.test(String(order.currencyCode || '').toUpperCase()) ? String(order.currencyCode).toUpperCase() : '',
      hsCode: /^\d{6,12}$/.test(String(i.hsCode || '').replace(/\s/g,'')) ? String(i.hsCode).replace(/\s/g,'') : '',
      weightKg: Number(i.weightKg) >= 0.001 ? Number(i.weightKg) : null,
      countryOfManufacture: /^[A-Z]{2}$/.test(String(i.countryOfManufacture || '').toUpperCase()) ? String(i.countryOfManufacture).toUpperCase() : ''
    })),
    excludedLines: (order.items || []).length - items.length
  };
}
function asAddress(a, requiredContact=true) {
  if (!a || typeof a !== 'object') fail('Please enter a shipment address.');
  const c = country(a.country);
  const phone = safeStr(a.phone, 25).replace(/[^0-9+]/g, '');
  const record = { contact: { personName: safeStr(a.name,70), companyName: safeStr(a.company || a.name,70), phoneNumber: phone },
    address: { streetLines: [safeStr(a.line1,35), safeStr(a.line2,35)].filter(Boolean), city: safeStr(a.city,35), postalCode: safeStr(a.pin,15), countryCode: c } };
  const state = safeStr(a.state,4).toUpperCase();
  if (state) record.address.stateOrProvinceCode = state;
  const email = safeStr(a.email,100); if (email) record.contact.emailAddress=email;
  if (!record.address.streetLines.length || !record.address.city || !record.address.postalCode || (requiredContact && (!record.contact.personName || !phone))) fail('Complete street, city, postal code, contact name and phone for both addresses.');
  if (c === 'US' && !state) fail('US addresses require a two-letter state code.');
  return record;
}
function packageDetails(pkg) {
  if (!pkg || typeof pkg !== 'object') fail('Enter package weight and dimensions.');
  return { weight: { units:'KG', value: num(pkg.weight,'package weight',0.01,1000) }, dimensions: { units:'CM', length:num(pkg.length,'length',1,300), width:num(pkg.width,'width',1,300), height:num(pkg.height,'height',1,300) } };
}
function batteryCheck(value) {
  const kind = safeStr(value,40);
  if (!['none','contained','packed','standalone','unknown'].includes(kind)) fail('Select the lithium-battery declaration.');
  if (kind !== 'none') fail('Battery-containing, standalone and unverified shipments are blocked until FedEx approves the applicable IATA dangerous-goods workflow. Do not classify batteries as “none” to bypass this check.');
}
function shipment(body) {
  if (!body || typeof body !== 'object') fail('Shipment details are required.');
  const from = asAddress(body.from), to = asAddress(body.to), pkg=packageDetails(body.package);
  if (from.address.countryCode !== 'IN') fail('This workflow is configured for exports originating in India only.');
  if (to.address.countryCode === 'IN') fail('Select an international destination.');
  batteryCheck(body.battery);
  return { from, to, pkg };
}
function commodities(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) fail('Enter 1–30 customs commodities.');
  const normalized = items.map((x,i) => {
    const d=safeStr(x.description, 120); if (d.length<5) fail(`Commodity ${i+1}: enter an accurate detailed description.`);
    const hs=safeStr(x.hsCode,14).replace(/\s/g,''); if (!/^\d{6,12}$/.test(hs)) fail(`Commodity ${i+1}: enter a verified 6–12 digit HS code.`);
    const count=num(x.quantity,`commodity ${i+1} quantity`,1,100000);
    if (!Number.isInteger(count)) fail('Commodity quantity must be a whole number.');
    const currencyCode=safeStr(x.currency,3).toUpperCase(); if (!/^[A-Z]{3}$/.test(currencyCode)) fail('Enter a 3-letter customs currency.');
    const unitPrice=num(x.unitPrice, `commodity ${i+1} unit value`,0.01,1e8);
    const origin=country(x.countryOfManufacture);
    const perWeight=num(x.weightKg,`commodity ${i+1} weight per unit (kg)`,0.001,1000);
    return { description:d, quantity:count, quantityUnits:'PCS', unitPrice:{amount:unitPrice,currency:currencyCode}, customsValue:{amount:Number((unitPrice*count).toFixed(2)),currency:currencyCode}, weight:{units:'KG',value:Number((perWeight*count).toFixed(3))}, countryOfManufacture:origin, harmonizedCode:hs };
  });
  const cur=normalized[0].unitPrice.currency;
  if (normalized.some(x=>x.unitPrice.currency!==cur)) fail('All customs commodities must use the same currency.');
  return { normalized, value:{amount:Number(normalized.reduce((s,c)=>s+c.customsValue.amount,0).toFixed(2)),currency:cur} };
}
async function sendFedex(path, data, kind='shipping') {
  const {id,secret}=credentials(kind);
  if (!id || !secret) fail(`FedEx ${kind} API credentials are not configured in Render.`,503);
  const cached=cache.get(kind);
  let token=cached && Date.now() < cached.exp ? cached.token : null;
  if (!token) {
    const form=new URLSearchParams({grant_type:'client_credentials',client_id:id,client_secret:secret});
    const auth=await fetch(urlBase()+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(20000)});
    const obj=await auth.json().catch(()=>({}));
    if (!auth.ok || !obj.access_token) fail(`FedEx ${kind} authorization failed (${auth.status}). ${safeStr(obj.error_description||obj.errors?.[0]?.message||obj.error,200)}`,502);
    token=obj.access_token;
    cache.set(kind,{token,exp:Date.now()+Math.max(0,(Number(obj.expires_in)||3600)-120)*1000});
  }
  const response=await fetch(urlBase()+path,{method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json','X-locale':'en_US'},body:JSON.stringify(data),signal:AbortSignal.timeout(30000)});
  const obj=await response.json().catch(()=>({}));
  if (!response.ok || (Array.isArray(obj.errors) && obj.errors.length)) {
    const msgs=(obj.errors||[]).slice(0,4).map(e=>`${e.code||''}: ${e.message||''}`).join(' | ');
    fail(`FedEx ${kind} request failed (${response.status}). ${safeStr(msgs||obj.message||obj.error,500)}`,502);
  }
  return obj;
}
function rateNormalize(resp) {
  return (resp.output?.rateReplyDetails||[]).map(r=>{
    const rated=r.ratedShipmentDetails||[];
    const best=rated.find(s=>s.rateType==='ACCOUNT' || s.rateType==='PAYOR_ACCOUNT_SHIPMENT') || rated[0] || {};
    const amountObj=best.totalNetChargeWithDutiesAndTaxes ?? best.totalNetCharge ?? best.totalBaseCharge;
    const amount=amountObj && typeof amountObj==='object' ? amountObj.amount : amountObj;
    const transit=r.commit || r.operationalDetail || {};
    return {service:r.serviceType, name:r.serviceName||r.serviceType, amount: Number.isFinite(Number(amount))?Number(amount):null, currency:(amountObj && typeof amountObj==='object' ? amountObj.currency : null) || best.currency || best.currencyCode || null, transit:transit.dateDetail?.dayFormat||transit.dateDetail?.dayOfWeek||transit.dateDetail?.dayCxsFormat||transit.deliveryDate||transit.transitTime||null, rateType:best.rateType||''};
  }).filter(r=>r.service);
}
function fxModeAssert(mutating) {
  if (!['sandbox','production',''].includes(env('FEDEX_MODE'))) fail('Invalid FEDEX_MODE; use sandbox or production.',503);
  if (!account()) fail(`Configure ${isProduction()?'FEDEX_ACCOUNT_NUMBER':'FEDEX_SANDBOX_ACCOUNT'} in Render.`,503);
  if (mutating && isProduction() && env('FEDEX_ENABLE_LIVE_ACTIONS') !== 'true') fail('Live FedEx shipment/pickup actions are disabled. Configure FEDEX_ENABLE_LIVE_ACTIONS=true only after production approval.',403);
}
const dir=()=> env('FEDEX_DATA_DIR') || './fedex-data';
const ledgerPath=id=>join(dir(),`${id}.json`);
async function getRecord(id) { try {return JSON.parse(await readFile(ledgerPath(id),'utf8'));} catch {return null;} }
async function listRecords() { const {readdir}=await import('node:fs/promises'); try { const ids=(await readdir(dir())).filter(s=>/^[-a-f0-9]{36}\.json$/.test(s)).slice(-500); const all=await Promise.all(ids.map(s=>getRecord(s.slice(0,-5)))); return all.filter(Boolean).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,100).map(({id,orderRef,trackingNumber,service,createdAt,status,pickup,labelAvailable,mode})=>({id,orderRef,trackingNumber,service,createdAt,status,pickup,labelAvailable,mode})); }catch{return [];} }
async function allocate(id,rec) { await mkdir(dir(),{recursive:true}); const file=await open(ledgerPath(id),'wx',0o600); try {await file.writeFile(JSON.stringify(rec));}finally {await file.close();} }
async function updateRecord(id,patch){const old=await getRecord(id);if(!old)fail('Shipment record not found.',404); const next={...old,...patch};await writeFile(ledgerPath(id),JSON.stringify(next),{mode:0o600}); return next;}
const withError =fn => async(req,res)=>{try{await fn(req,res);}catch(e){const msg=e.name==='TimeoutError'?'FedEx timed out. Check the shipment history BEFORE attempting again.':(e?.message||'FedEx operation failed');res.status(e.status||500).json({ok:false,error:msg});}};

export function registerFedexRoutes(app, { readProfileSession, odooGetSaleOrderByRef }) {
  const protect=(req,res,next)=>{
    if (!env('PROFILE_SESSION_SECRET') || env('PROFILE_SESSION_SECRET').length < 32) return res.status(503).json({ok:false,error:'Set a random PROFILE_SESSION_SECRET of at least 32 characters in Render before enabling FedEx operations.'});
    const session=readProfileSession(req);
    if(!session || !['Smart handicrafts','SUDO'].includes(session.profile)) return res.status(403).json({ok:false,error:'Authorized Smart handicrafts or SUDO session required.'});
    if(req.method!=='GET') {
      const origin=req.get('origin');
      const host=req.get('host');
      if (origin) {
        try { if (new URL(origin).host !== host) return res.status(403).json({ok:false,error:'Cross-origin FedEx operations are blocked.'}); }
        catch { return res.status(403).json({ok:false,error:'Invalid origin.'}); }
      }
    }
    res.set('Cache-Control','private, no-store');
    next();
  };
  app.use('/api/fedex',protect);
  app.get('/api/fedex/config',withError(async(req,res)=>{
    res.json({ok:true,mode:isProduction()?'production':'sandbox',liveEnabled:isProduction()&&env('FEDEX_ENABLE_LIVE_ACTIONS')==='true',shippingConfigured:!!(credentials('shipping').id&&credentials('shipping').secret&&account()),trackingConfigured:!!(credentials('tracking').id&&credentials('tracking').secret),origin:originAddress()});
  }));
  app.get('/api/fedex/orders',withError(async(req,res)=>{
    const q=safeStr(req.query.ref,80); if(!q || !/^[\w\-/ ]{2,80}$/.test(q)) fail('Enter a valid sales order reference.');
    const order=await odooGetSaleOrderByRef(q);
    res.json({ok:true,order:fedexImportOrder(order)});
  }));
  app.post('/api/fedex/rates',withError(async(req,res)=>{
    fxModeAssert(false);
    const data=shipment(req.body);
    // International merchandise quotes require a customs-clearance declaration.
    // Use the *same validated* commodity values at rating and label creation.
    // Never silently invent customs values from the sales-order total.
    const declared=commodities(req.body.commodities);
    const rateRequest={accountNumber:{value:account()},rateRequestControlParameters:{returnTransitTimes:true},requestedShipment:{shipper:{address:data.from.address},recipient:{address:data.to.address},pickupType:'CONTACT_FEDEX_TO_SCHEDULE',packagingType:'YOUR_PACKAGING',rateRequestType:['ACCOUNT','LIST'],requestedPackageLineItems:[{groupPackageCount:1,...data.pkg}],totalPackageCount:1,customsClearanceDetail:{commodities:declared.normalized,customsValue:declared.value,commercialInvoice:{shipmentPurpose:'SOLD'}}}};
    const raw=await sendFedex('/rate/v1/rates/quotes',rateRequest);
    res.json({ok:true,mode:isProduction()?'production':'sandbox',rates:rateNormalize(raw),warnings:raw.output?.alerts||[]});
  }));
  app.post('/api/fedex/shipments',withError(async(req,res)=>{
    fxModeAssert(true);
    if(req.body?.confirm !== true) fail('Shipment creation requires explicit confirmation.');
    const id=safeStr(req.body?.operationId,50);
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) fail('Invalid shipment operation ID.');
    const existing=await getRecord(id); if(existing) return res.status(409).json({ok:false,error:'This shipment request has already been submitted. Check shipment history to prevent duplicate labels.',record:existing.id});
    const data=shipment(req.body); const declared=commodities(req.body.commodities);
    const service=safeStr(req.body.service,75);if(!SERVICES.has(service)) fail('Choose one of the FedEx international services from your rate quote.');
    const ref=safeStr(req.body.orderRef,80); if(!ref || !/^[\w\-/ ]{2,80}$/.test(ref)) fail('Load a valid sales order first.');
    // Never create a label for an invented reference (the address itself can still be edited).
    await odooGetSaleOrderByRef(ref);
    const prior=(await listRecords()).find(r=>r.orderRef===ref && r.mode===(isProduction()?'production':'sandbox') && r.status!=='cancelled');
    if(prior) fail(`An earlier FedEx shipment attempt for ${ref} exists (${prior.status}). Review shipment history before attempting another label.`,409);
    await allocate(id,{id,orderRef:ref,createdAt:new Date().toISOString(),status:'pending_fedex_response',mode:isProduction()?'production':'sandbox',service,origin:data.from,to:data.to,pkg:data.pkg,trackingNumber:null,labelAvailable:false,pickup:null});
    const shipmentBody={accountNumber:{value:account()},labelResponseOptions:'LABEL',requestedShipment:{shipper:data.from,recipients:[data.to],shipDatestamp:todayIndia(),serviceType:service,packagingType:'YOUR_PACKAGING',pickupType:'CONTACT_FEDEX_TO_SCHEDULE',shippingChargesPayment:{paymentType:'SENDER'},labelSpecification:{imageType:'PDF',labelStockType:'PAPER_4X6'},requestedPackageLineItems:[{weight:data.pkg.weight,dimensions:data.pkg.dimensions,customerReferences:[{customerReferenceType:'CUSTOMER_REFERENCE',value:ref}]}],customsClearanceDetail:{commodities:declared.normalized,customsValue:declared.value,commercialInvoice:{shipmentPurpose:'SOLD'},dutiesPayment:{paymentType:'RECIPIENT'}}}};
    try {
      const raw=await sendFedex('/ship/v1/shipments',shipmentBody);
      const transaction=raw.output?.transactionShipments?.[0]||{};
      const piece=transaction.pieceResponses?.[0]||{};
      const trackingNumber=String(piece.trackingNumber||transaction.masterTrackingNumber||'');
      if(!trackingNumber) fail('FedEx did not return a tracking number; inspect the project transaction logs before trying again.',502);
      const doc=piece.packageDocuments?.find(x=>x.encodedLabel) || transaction.shipmentDocuments?.find(x=>x.encodedLabel);
      let labelAvailable=false;
      if(doc?.encodedLabel){const pdf=Buffer.from(doc.encodedLabel,'base64');if(pdf.length>100 && pdf.length<MAX_LABEL_BYTES&&pdf.subarray(0,5).toString()==='%PDF-'){await writeFile(join(dir(),`${id}.pdf`),pdf,{mode:0o600});labelAvailable=true;}}
      const record=await updateRecord(id,{status:labelAvailable?'label_created':'created_label_unavailable',trackingNumber,labelAvailable,transactionId:raw.transactionId||null});
      res.json({ok:true,record:{id:record.id,orderRef:ref,trackingNumber,status:record.status,labelAvailable,mode:record.mode}});
    } catch(e){await updateRecord(id,{status:'needs_manual_review',lastError:safeStr(e.message,500)});throw e;}
  }));
  app.get('/api/fedex/shipments',withError(async(req,res)=>{res.json({ok:true,shipments:await listRecords()});}));
  app.get('/api/fedex/shipments/:id/label',withError(async(req,res)=>{
    const id=safeStr(req.params.id,36); if(!/^[a-f0-9-]{36}$/i.test(id)) fail('Invalid label ID.');
    const r=await getRecord(id); if(!r?.labelAvailable) fail('Printable label is not available for this shipment.',404);
    const bytes=await readFile(join(dir(),`${id}.pdf`));res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="FedEx-${(r.trackingNumber||id).replace(/[^0-9A-Za-z-]/g,'')}.pdf"`,'Cache-Control':'private, no-store'});res.send(bytes);
  }));
  app.post('/api/fedex/pickups',withError(async(req,res)=>{
    fxModeAssert(true);if(req.body?.confirm!==true) fail('Pickup requires explicit confirmation.');
    const shipmentId=safeStr(req.body?.shipmentId,36);const r=await getRecord(shipmentId);
    if(!r || !['label_created','created_label_unavailable','pickup_booked','pickup_review'].includes(r.status)) fail('Create a FedEx shipment label before requesting pickup.');
    if(r.mode!==(isProduction()?'production':'sandbox')) fail('Cannot book a pickup using a shipment from another environment.');
    if(r.pickup || r.pickupAttempt) fail('Pickup already requested for this shipment. Check the history before retrying.');
    const date=safeStr(req.body?.date,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z'))) fail('Select a valid pickup date.');
    const ready=safeStr(req.body.ready,5),close=safeStr(req.body.close,5);
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(ready)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(close)||ready>=close) fail('Enter valid pickup ready/close times.');
    if(date < todayIndia()) fail('Pickup date must not be in the past.');
    // Do not automatically rebook a failed/uncertain request: on-call pickups can incur fees.
    await updateRecord(shipmentId,{pickupAttempt:new Date().toISOString(),status:'pickup_review'});
    const payload={associatedAccountNumber:{value:account()},originDetail:{pickupAddressType:'OTHER',pickupLocation:r.origin,readyDateTimestamp:`${date}T${ready}:00+05:30`,customerCloseTime:`${close}:00`,pickupDateType:date===todayIndia()?'SAME_DAY':'FUTURE_DAY',packageLocation:'FRONT'},carrierCode:'FDXE',totalWeight:r.pkg?.weight||{units:'KG',value:num(req.body.weight,'weight',0.01,1000)},packageCount:1,remarks:safeStr(req.body.remarks,100),countryRelationships:'INTERNATIONAL',pickupType:'ON_CALL'};
    try {const raw=await sendFedex('/pickup/v1/pickups',payload);const result=raw.output||{};const confirmation=result.pickupConfirmationCode||result.confirmationNumber||result.pickupConfirmationNumber||'';
      if(!confirmation) fail('FedEx did not return a pickup confirmation. Verify the request in FedEx before retrying.',502);const updated=await updateRecord(shipmentId,{pickup:{confirmation,date,ready,close},status:'pickup_booked'});res.json({ok:true,pickup:updated.pickup,shipmentId});}
    catch(e){await updateRecord(shipmentId,{status:'pickup_review',pickupError:safeStr(e.message,400)});throw e;}
  }));
  app.post('/api/fedex/track',withError(async(req,res)=>{
    const number=safeStr(req.body?.trackingNumber,35);if(!/^[A-Za-z0-9]{8,35}$/.test(number)) fail('Enter a valid FedEx tracking number.');
    const raw=await sendFedex('/track/v1/trackingnumbers',{includeDetailedScans:true,trackingInfo:[{trackingNumberInfo:{trackingNumber:number}}]},'tracking');
    const item=raw.output?.completeTrackResults?.[0]?.trackResults?.[0]||{};
    res.json({ok:true,trackingNumber:number,status:item.latestStatusDetail?.statusByLocale||item.latestStatusDetail?.description||'No status returned',estimatedDelivery:item.dateAndTimes?.find(x=>x.type==='ESTIMATED_DELIVERY')?.dateTime||'',events:(item.scanEvents||[]).slice(0,60).map(e=>({date:e.date,status:e.eventDescription||e.eventType,location:e.scanLocation?.city||''}))});
  }));
}

export const __fedexTest = {shipment,commodities,packageDetails,rateNormalize,originAddress,fedexImportOrder,fedexImportAddress,isNonCommodityOrderLine};
