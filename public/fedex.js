/* Smart Handicrafts FedEx workspace. Credentials never enter the browser. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('page-fedex')) return;
  const fields = ['Name','Company','Phone','Email','Line1','Line2','City','State','Pin','Country'];
  let mode = 'sandbox', configured = false, currentOrder = null, rates = [], ratedPayload = '', selectedService = '', shipments = [], busy = false, preflightToken = '', preflightSnapshot = '', currentInvoice = null;
  const html = v => String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const text = (id, value) => { if ($(id)) $(id).textContent = String(value ?? ''); };
  const value = id => ($(id)?.value || '').trim();
  const set = (id, val) => { if ($(id)) $(id).value = String(val ?? ''); };
  const notify = (message, type = '') => { const el=$('fxMessage'); el.textContent=message; el.className='fx-message visible '+type; el.scrollIntoView({block:'nearest',behavior:'smooth'}); };
  const invalidatePreflight = () => {
    preflightToken=''; preflightSnapshot='';
    $('fxCreateShipment').disabled=true;
    $('fxPreflightResults').replaceChildren();
    text('fxPreflightStatus','Run the check again after selecting a FedEx service.');
  };
  const clearQuote = () => {
    rates=[]; ratedPayload=''; selectedService='';
    invalidatePreflight();
    $('fxReviewConfirmed').checked=false;
    $('fxRunPreflight').disabled=true;
    $('fxRates').innerHTML='<tr><td colspan="4" class="fx-secondary">Request rates to select a service.</td></tr>';
  };
  async function api(path, opts={}) {
    const r=await fetch('/api/fedex'+path,{credentials:'same-origin',cache:'no-store',...opts,headers:{...(opts.body?{'Content-Type':'application/json'}:{}),...(opts.headers||{})}});
    const data=await r.json().catch(()=>({}));
    if (!r.ok || !data.ok) throw new Error(data.error || `FedEx request failed (HTTP ${r.status}).`);
    return data;
  }
  async function guarded(button, fn) {
    if (busy) return; busy=true;
    const old=button?.textContent; if(button){button.disabled=true;button.textContent='Please wait…';}
    try {await fn();} catch(err){notify(err.message || 'Operation failed.','error');}
    finally {busy=false;if(button){button.disabled=false;button.textContent=old;} $('fxRunPreflight').disabled=!selectedService||!ratedPayload||!configured||!currentInvoice; $('fxCreateShipment').disabled=!preflightToken||!selectedService||!ratedPayload||!configured;}
  }
  function fillAddress(prefix, address={}) {
    const a = {...address};
    if (a.country) {
      const names={'INDIA':'IN','CZECH REPUBLIC':'CZ','CZECHIA':'CZ','UNITED STATES':'US','USA':'US','UNITED KINGDOM':'GB','GREAT BRITAIN':'GB','GERMANY':'DE','FRANCE':'FR','CANADA':'CA','UAE':'AE','UNITED ARAB EMIRATES':'AE'};
      a.country=names[String(a.country).trim().toUpperCase()] || a.country;
    }
    fields.forEach(k=>set('fx'+prefix+k,a[k[0].toLowerCase()+k.slice(1)]));
  }
  function readAddress(prefix) {
    return Object.fromEntries(fields.map(k=>[k[0].toLowerCase()+k.slice(1), value('fx'+prefix+k)]));
  }
  function packageDetails(){return {weight:Number(value('fxWeight')),length:Number(value('fxLength')),width:Number(value('fxWidth')),height:Number(value('fxHeight'))};}
  function basePayload(){return {from:readAddress('From'),to:readAddress('To'),package:packageDetails(),battery:value('fxBattery')};}
  function commodityRow(item={}) {
    const tr=document.createElement('tr');
    tr.dataset.productId=String(item.productId||'');
    const data={description:item.description||'',quantity:item.quantity||1,unitPrice:item.unitPrice ?? '',currency:item.currency||'',hsCode:item.hsCode||'',countryOfManufacture:item.countryOfManufacture||'',weightKg:item.weightKg ?? ''};
    const kinds={quantity:'number',unitPrice:'number',weightKg:'number'};
    Object.entries(data).forEach(([k,v])=>{
      const td=document.createElement('td'), input=document.createElement('input');
      input.dataset.field=k;input.type=kinds[k]||'text';input.value=v;
      if(kinds[k]){input.step=k==='quantity'?'1':'0.001';input.min=k==='quantity'?'1':'0.001';}
      if(k==='hsCode')input.placeholder='6-12 digits';
      if(k==='description')input.placeholder='Exact product description';
      if(k==='countryOfManufacture')input.maxLength=2;
      if(k==='currency')input.maxLength=3;
      input.addEventListener('input', clearQuote);
      td.append(input); tr.append(td);
    });
    const td=document.createElement('td'), del=document.createElement('button');del.type='button';del.className='btn btn-sm';del.textContent='×';del.title='Remove commodity';del.addEventListener('click',()=>{tr.remove();clearQuote();});td.append(del);tr.append(td);
    $('fxCommodityRows').append(tr);
  }
  function readCommodities(){return [...$('fxCommodityRows').querySelectorAll('tr')].map(tr=>({...Object.fromEntries([...tr.querySelectorAll('input[data-field]')].map(el=>[el.dataset.field,el.type==='number'?Number(el.value):el.value.trim()])),productId:Number(tr.dataset.productId)||null}));}
  function localDateIndia(){ return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replace(/(\d{2})\/(\d{2})\/(\d{4})/,'$3-$1-$2'); }
  function renderRates(){
    $('fxRates').innerHTML=rates.length?rates.map((r,i)=>`<tr><td><input class="fx-rate-radio" type="radio" name="fxService" value="${html(r.service)}" ${r.service===selectedService?'checked':''} aria-label="Select ${html(r.name)}"></td><td>${html(r.name)}</td><td>${r.amount==null||!/^[A-Z]{3}$/.test(r.currency||'')?'Check FedEx currency/amount':html(new Intl.NumberFormat('en-US',{style:'currency',currency:r.currency}).format(r.amount))}</td><td>${html(r.transit||'Not supplied')}</td></tr>`).join(''):'<tr><td colspan="4">No eligible FedEx rates returned for this route. Check the service and sandbox test account.</td></tr>';
    $('fxRates').querySelectorAll('input[name="fxService"]').forEach(el=>el.addEventListener('change',()=>{selectedService=el.value;invalidatePreflight();$('fxRunPreflight').disabled=!configured||!currentInvoice;}));
  }
  async function loadInvoice(preferredId='') {
    if(!currentOrder) return;
    currentInvoice=null;clearQuote();
    $('fxDownloadInvoice').disabled=true;
    const response=await api('/invoice?ref='+encodeURIComponent(currentOrder.ref)+(preferredId?'&invoiceId='+encodeURIComponent(preferredId):''));
    const invoice=response.invoice||{};
    const options=invoice.options||[];
    $('fxInvoiceSelect').innerHTML='<option value="">'+(options.length?'Choose posted invoice':'No posted invoice')+'</option>'+
      options.map(i=>`<option value="${Number(i.id)}">${html(i.name)}</option>`).join('');
    if(invoice.status==='ready'){
      currentInvoice=invoice;
      set('fxInvoiceSelect',invoice.invoiceId);
      text('fxInvoiceStatus',`Posted invoice ${invoice.invoiceNumber} · ${invoice.currency} ${Number(invoice.goodsTotal).toFixed(2)} physical goods · ${invoice.lines.length} item line(s). This must match the declared customs table.`);
      $('fxDownloadInvoice').disabled=false;
    } else {
      text('fxInvoiceStatus',invoice.message||'Create and post a customer invoice in Odoo first.');
    }
  }
  async function downloadInvoice(){
    if(!currentOrder || !currentInvoice)throw new Error('Load a posted linked Odoo customer invoice first.');
    const data={...basePayload(),commodities:readCommodities(),orderRef:currentOrder.ref,invoiceId:currentInvoice.invoiceId};
    const response=await fetch('/api/fedex/commercial-invoice',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error||'Cannot generate the commercial invoice PDF.');}
    if(!(response.headers.get('content-type')||'').includes('application/pdf'))throw new Error('The invoice endpoint did not return a PDF.');
    const blob=await response.blob();const url=URL.createObjectURL(blob);
    try {const link=document.createElement('a');link.href=url;link.download='Commercial-Invoice-'+currentInvoice.invoiceNumber.replace(/[^a-zA-Z0-9-]/g,'-')+'.pdf';document.body.append(link);link.click();link.remove();}
    finally{setTimeout(()=>URL.revokeObjectURL(url),1500);}
    notify('Commercial invoice generated from the linked posted customer invoice. Inspect and sign it before supplying it to FedEx.','success');
  }
  async function loadOrder(){
    const ref=value('fxOrderRef');if(!ref)throw new Error('Enter a Sales Order reference.');
    const {order}=await api('/orders?ref='+encodeURIComponent(ref)); currentOrder=order;
    fillAddress('To',order.ship_to||{});
    $('fxCommodityRows').replaceChildren();
    (order.items||[]).filter(i=>Number(i.qty)>0).slice(0,30).forEach(item=>commodityRow({
      description:item.product_name||item.name,
      quantity:Math.max(1,Math.ceil(Number(item.qty))),
      unitPrice:item.unitPrice,
      currency:item.currency||order.currencyCode||'',
      hsCode:item.hsCode||'',
      countryOfManufacture:item.countryOfManufacture||'',
      weightKg:item.weightKg,
      productId:item.product_id
    }));
    if(!$('fxCommodityRows').children.length)commodityRow();
    const excluded = Number(order.excludedLines) || 0;
    const suggested=(order.items||[]).filter(i=>i.unitPrice != null).length;
    const missingHs=(order.items||[]).filter(i=>!i.hsCode).length;
    const missingWeight=(order.items||[]).filter(i=>!(Number(i.weightKg)>=0.001)).length;
    const missingOrigin=(order.items||[]).filter(i=>!i.countryOfManufacture).length;
    text('fxOrderInfo',`${order.ref} · ${order.state||'Unknown state'} · ${(order.items||[]).length} physical item line(s). ${excluded ? `${excluded} non-commodity line(s) excluded. ` : ''}Suggested ${suggested} sale-order unit price(s). ${missingHs} HS code(s), ${missingWeight} weight(s), ${missingOrigin} origin(s) still require review or entry. These are editable customs suggestions, not verified declarations.`);
    clearQuote();await loadInvoice();notify(`Loaded sales order ${order.ref}. ${excluded ? `Excluded ${excluded} service/delivery line(s). ` : ''}Review the destination and customs values before requesting rates.`,'success');
  }
  async function loadConfig(){
    try {
      const cfg=await api('/config');mode=cfg.mode||'sandbox';configured=Boolean(cfg.shippingConfigured);
      text('fxModePill',mode==='sandbox'?'SANDBOX · Test only':cfg.liveEnabled?'PRODUCTION · LIVE ENABLED':'PRODUCTION · Live actions locked');
      text('fxConnection',`Shipping credentials: ${configured?'configured':'missing'} · Tracking: ${cfg.trackingConfigured?'configured':'missing'} · ${mode==='sandbox'?'No real FedEx labels or pickups will be created.':'Live creation requires explicit Render enable switch and confirmation.'}`);
      $('fxConnection').classList.toggle('warn',!configured);
      fillAddress('From',cfg.origin||{});
      if(!value('fxFromCountry'))set('fxFromCountry','IN');
      if(!configured){$('fxGetRates').disabled=true;$('fxCreateShipment').disabled=true;}
    } catch(err){text('fxModePill','Not connected');text('fxConnection',err.message);$('fxGetRates').disabled=true;}
  }
  async function getRates(){
    if (!currentOrder) throw new Error('Load the Odoo sales order first.');
    // Customs detail is mandatory for our India-origin international rate
    // request, not just for generating the final AWB/label.
    const payload={...basePayload(),commodities:readCommodities(),orderCurrency:currentOrder.currencyCode||''};
    if(payload.battery!=='none')throw new Error('Battery-containing or unverified shipments are blocked in this version. Review transport compliance first.');
    clearQuote();text('fxRateStatus','Requesting FedEx prices…');
    const response=await api('/rates',{method:'POST',body:JSON.stringify(payload)});
    rates=response.rates||[];ratedPayload=JSON.stringify(payload);
    const requestedCurrency=response.requestedCurrency||currentOrder.currencyCode||'';
    const mismatched=rates.filter(r=>r.currency!==requestedCurrency);
    const returnedCurrencies=[...new Set(mismatched.map(r=>r.currency||'unknown currency'))].join(', ');
    text('fxRateStatus', rates.length
      ? `${rates.length} FedEx service(s) returned. ${mismatched.length ? `${requestedCurrency} requested; ${mismatched.length} quote(s) returned in ${returnedCurrencies}. Amounts are shown in FedEx's original currency; no automatic conversion was made. ` : `Quotes returned in ${requestedCurrency}. `}Rates may differ from actual invoice.`
      : 'No rates returned. Review route and sandbox test account.');renderRates();
    notify(rates.length?'Select the desired FedEx service. The quote uses the declared customs commodities shown above.':'FedEx returned no rates for these details.',rates.length?'success':'error');
  }
  function preflightPayload() {
    return {...basePayload(),commodities:readCommodities(),orderCurrency:currentOrder?.currencyCode||'',
      orderRef:currentOrder?.ref||'',invoiceId:currentInvoice?.invoiceId||null,service:selectedService,reviewConfirmed:$('fxReviewConfirmed').checked};
  }
  async function runPreflight() {
    if(!currentOrder||!selectedService||!ratedPayload)throw new Error('Load an order, request rates and select a FedEx service first.');
    if(!currentInvoice)throw new Error('Create and post the linked customer invoice in Odoo first, then refresh its status.');
    const payload=preflightPayload();
    const quotePayload={from:payload.from,to:payload.to,package:payload.package,battery:payload.battery,
      commodities:payload.commodities,orderCurrency:payload.orderCurrency};
    if(JSON.stringify(quotePayload)!==ratedPayload)throw new Error('Shipment data changed since the quote. Get updated rates first.');
    invalidatePreflight();
    const result=await api('/preflight',{method:'POST',body:JSON.stringify(payload)});
    const container=$('fxPreflightResults');
    (result.checks||[]).forEach(c=>{
      const element=document.createElement('div');element.className='fx-check-result '+(c.status==='pass'?'pass':'block');
      element.textContent=`${c.status==='pass'?'✓':'✕'} ${c.name}: ${c.detail}`;container.append(element);
    });
    (result.warnings||[]).forEach(w=>{
      const element=document.createElement('div');element.className='fx-check-warning';element.textContent='Review: '+w;container.append(element);
    });
    if(result.passed&&result.token){
      preflightToken=result.token;preflightSnapshot=JSON.stringify(payload);
      text('fxPreflightStatus','PASS · Approved for this exact shipment snapshot (10 minutes). Final PDF inspection still required.');
      notify('Pre-label check passed. You may confirm creation of the test label. Inspect the returned PDF before printing.','success');
    } else {
      text('fxPreflightStatus','BLOCKED · Correct the listed issues and run the check again.');
      notify('The pre-label check identified issues. Label creation is blocked.','error');
    }
  }
  async function createShipment(){
    if(!currentOrder)throw new Error('Load the order first.');
    if(!currentInvoice)throw new Error('Create and post the linked Odoo invoice before creating a FedEx label.');
    if(!selectedService)throw new Error('Select a FedEx service quote.');
    const payload={...basePayload(),commodities:readCommodities(),orderCurrency:currentOrder.currencyCode||''};if(JSON.stringify(payload)!==ratedPayload)throw new Error('Shipping or customs details changed since the quote. Request a new quote.');
    const items=payload.commodities;if(!items.length)throw new Error('Add at least one customs commodity.');
    if (!preflightToken || JSON.stringify(preflightPayload())!==preflightSnapshot) throw new Error('Run the pre-label check again. A field or selected service changed.');
    const actionText=mode==='sandbox'?'TEST label':'LIVE billable FedEx label';
    if(!window.confirm(`Create ${actionText} for order ${currentOrder.ref}?\n\nService: ${selectedService}\nShipment origin: ${payload.from.city}, ${payload.from.country}\nDestination: ${payload.to.city}, ${payload.to.country}\n\nThis does not request courier pickup.`))return;
    const operationId=crypto.randomUUID();
    const result=await api('/shipments',{method:'POST',body:JSON.stringify({...preflightPayload(),preflightToken,operationId,confirm:true})});
    clearQuote();await refreshHistory();
    if(result.record?.trackingNumber)set('fxTrackingNo',result.record.trackingNumber);
    if(result.record?.id)set('fxPickupShipment',result.record.id);
    notify(`FedEx ${mode==='sandbox'?'test ':''}shipment created. AWB: ${result.record?.trackingNumber||'see history'}${result.record?.labelAvailable?' · PDF file received; OPEN AND INSPECT the address, barcode and print layout before printing.':' · PDF missing or failed basic file integrity check; DO NOT PRINT. Check shipment history.'}`,'success');
  }
  async function refreshHistory(){
    const response=await api('/shipments');shipments=response.shipments||[];
    $('fxHistory').innerHTML=shipments.length?shipments.map(r=>`<tr><td>${html(r.orderRef)}</td><td>${html(r.trackingNumber||'—')}<div class="fx-secondary">${html(r.mode||'')}</div></td><td>${html(r.service)}</td><td>${html(r.status)}</td><td>${html(r.pickup?.confirmation||'—')}</td><td>${r.labelAvailable?`<a class="fx-link" target="_blank" rel="noopener" href="/api/fedex/shipments/${encodeURIComponent(r.id)}/label">AWB PDF ↓</a>`:'—'} ${r.invoiceAvailable?` · <a class="fx-link" target="_blank" rel="noopener" href="/api/fedex/shipments/${encodeURIComponent(r.id)}/commercial-invoice">Customs invoice PDF ↓</a>`:''}</td></tr>`).join(''):'<tr><td colspan="6">No shipments yet.</td></tr>';
    const prev=value('fxPickupShipment');
    $('fxPickupShipment').innerHTML='<option value="">Choose a created shipment</option>'+shipments.filter(r=>r.trackingNumber&&!r.pickup&&!r.pickupAttempt&&r.mode===mode).map(r=>`<option value="${html(r.id)}">${html(r.orderRef)} · ${html(r.trackingNumber)}</option>`).join('');
    if(shipments.some(r=>r.id===prev&&!r.pickup&&!r.pickupAttempt))set('fxPickupShipment',prev);
    return shipments;
  }
  async function bookPickup(){
    const id=value('fxPickupShipment');if(!id)throw new Error('Choose a shipment with an AWB.');
    const record=shipments.find(r=>r.id===id);if(!record)throw new Error('Refresh the shipment history.');
    const date=value('fxPickupDate'),ready=value('fxPickupReady'),close=value('fxPickupClose');
    if(!date||!ready||!close)throw new Error('Enter pickup date, ready time and closing time.');
    if(!window.confirm(`Request ${mode==='sandbox'?'TEST':'LIVE (potentially billable)'} FedEx pickup?\nOrder: ${record.orderRef}\nAWB: ${record.trackingNumber}\nDate: ${date}\nReady: ${ready}\nClose: ${close}\n\nPickup requests may incur a charge. This is a separate FedEx action.`))return;
    const response=await api('/pickups',{method:'POST',body:JSON.stringify({shipmentId:id,date,ready,close,weight:value('fxPickupWeight'),remarks:value('fxPickupRemarks'),confirm:true})});
    text('fxPickupStatus',`Pickup confirmation: ${response.pickup?.confirmation||'Pending FedEx response'} · ${date}`);
    await refreshHistory();notify('FedEx pickup request accepted. Check its confirmation details.','success');
  }
  async function track(){
    const no=value('fxTrackingNo');if(!no)throw new Error('Enter a tracking number.');
    const result=await api('/track',{method:'POST',body:JSON.stringify({trackingNumber:no})});
    $('fxTrackingResult').innerHTML=`<strong>${html(result.trackingNumber)}</strong> · ${html(result.status)}${result.estimatedDelivery?` · ETA ${html(result.estimatedDelivery)}`:''}${result.events?.length?`<ol class="fx-events">${result.events.map(e=>`<li>${html(e.date||'')} · ${html(e.status||'')} · ${html(e.location||'')}</li>`).join('')}</ol>`:''}`;
    notify('Tracking updated.','success');
  }
  document.querySelectorAll('#page-fedex input, #page-fedex select').forEach(el=>{
    if(['fxPickupDate','fxPickupReady','fxPickupClose','fxPickupWeight','fxPickupRemarks','fxPickupShipment','fxTrackingNo','fxOrderRef','fxReviewConfirmed','fxInvoiceSelect'].includes(el.id))return;
    el.addEventListener('input',clearQuote);el.addEventListener('change',clearQuote);
  });
  $('fxInvoiceSelect').addEventListener('change',e=>{const selected=e.currentTarget.value;loadInvoice(selected).catch(err=>notify(err.message,'error'));});
  $('fxRefreshInvoice').addEventListener('click',e=>guarded(e.currentTarget,async()=>{if(!currentOrder)throw new Error('Load a sales order first.');await loadInvoice(value('fxInvoiceSelect'));notify(currentInvoice?'Posted invoice verified.':'No posted invoice selected.','success');}));
  $('fxDownloadInvoice').addEventListener('click',e=>guarded(e.currentTarget,downloadInvoice));
  $('fxLoadOrder').addEventListener('click',e=>guarded(e.currentTarget,loadOrder));
  $('fxOrderRef').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('fxLoadOrder').click();}});
  $('fxAddCommodity').addEventListener('click',()=>{commodityRow();clearQuote();});
  $('fxReviewConfirmed').addEventListener('change',invalidatePreflight);
  $('fxRunPreflight').addEventListener('click',e=>guarded(e.currentTarget,runPreflight));
  $('fxGetRates').addEventListener('click',e=>guarded(e.currentTarget,getRates));
  $('fxCreateShipment').addEventListener('click',e=>guarded(e.currentTarget,createShipment));
  $('fxBookPickup').addEventListener('click',e=>guarded(e.currentTarget,bookPickup));
  $('fxTrack').addEventListener('click',e=>guarded(e.currentTarget,track));
  $('fxRefreshHistory').addEventListener('click',e=>guarded(e.currentTarget,refreshHistory));
  window.SHSelectFedexOrder=ref=>{
    document.querySelector('.nav-item[data-page="fedex"]')?.click();
    set('fxOrderRef',ref);
    $('fxLoadOrder').click();
  };
  commodityRow();set('fxPickupDate',localDateIndia());
  Promise.allSettled([loadConfig(),refreshHistory()]);
})();
