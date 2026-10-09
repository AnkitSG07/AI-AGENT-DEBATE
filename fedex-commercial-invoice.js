/** Commercial invoice *from exporter* for FedEx customs presentation.
 * This is NOT an AWB/airway bill or an official FedEx-issued form.
 * Source of prices and invoice number: the linked POSTED Odoo account.move.
 * PDF formatting can be adapted after a genuine commercial-invoice template is supplied.
 */

const money=(amount,currency)=>`${Number(amount).toFixed(2)} ${currency}`;
const clean = v => String(v ?? '').trim().replace(/[\r\n\t]+/g,' ').slice(0,250);
const eps = 0.021;
const close=(a,b)=>Math.abs(Number(a)-Number(b))<eps;

export function checkInvoiceAgainstCustoms(invoice, declared=[]){
  if (invoice?.status !== 'ready' || !invoice.invoiceId || !invoice.invoiceNumber) {
    return {passed:false,detail:invoice?.message || 'Create and post a customer invoice in Odoo first.'};
  }
  if(!Array.isArray(invoice.lines)||!invoice.lines.length) return {passed:false,detail:'Linked invoice contains no physical goods.'};
  if(!Array.isArray(declared)||!declared.length) return {passed:false,detail:'Enter customs commodities before producing a commercial invoice.'};
  // Build totals by PRODUCT ID so manually changed descriptions cannot
  // silently attach the wrong values to the invoice.
  const totals = list => {
    const map=new Map();
    for(const item of list){
      const id=Number(item.productId);
      if(!Number.isSafeInteger(id)||id<1) return null;
      const qty=Number(item.quantity), price=Number(item.unitPrice);
      if(!Number.isFinite(qty)||qty<=0||!Number.isFinite(price)||price<=0) return null;
      const previous=map.get(id)||{quantity:0,value:0};
      map.set(id,{quantity:previous.quantity+qty,value:previous.value+qty*price});
    }
    return map;
  };
  const source=totals(invoice.lines), destination=totals(declared);
  if(!source||!destination) return {passed:false,detail:'One or more commodities are missing a valid product link, quantity or price.'};
  if(source.size!==destination.size) return {passed:false,detail:'The customs products differ from the linked posted invoice. Check physical goods and exclude service charges.'};
  for(const [id, expected] of source){
    const got=destination.get(id);
    if(!got) return {passed:false,detail:`Product ${id} is missing from the customs table.`};
    if(!close(expected.quantity,got.quantity)) return {passed:false,detail:`Product ${id}: quantity ${got.quantity} does not match posted invoice quantity ${expected.quantity}.`};
    if(!close(expected.value,got.value)) return {passed:false,detail:`Product ${id}: customs amount ${got.value.toFixed(2)} differs from posted invoice goods value ${expected.value.toFixed(2)} ${invoice.currency}. Review invoicing/customs before shipping.`};
  }
  if(declared.some(line=>String(line.currency).trim().toUpperCase() !== invoice.currency)) return {passed:false,detail:`All declared goods should use invoice currency ${invoice.currency}.`};
  return {passed:true,detail:`Posted invoice ${invoice.invoiceNumber}, ${invoice.lines.length} physical line(s), ${money(invoice.goodsTotal,invoice.currency)} goods value reconciled.`};
}

/** Draw a clean commercial invoice; PDFKit is already declared in package.json.
 * Accept a PDFDocument class as argument so invoice-data logic is unit testable.
 */
export async function renderCommercialInvoicePdf(documentClass,invoice,{from,to,commodities,pkg,orderRef,mode}){
  const verified=checkInvoiceAgainstCustoms(invoice,commodities);
  if(!verified.passed) throw new Error(verified.detail);
  const rows=invoice.lines.map(line=>{
    const customs=commodities.find(c=>Number(c.productId)===Number(line.productId));
    if(!customs)throw new Error(`Missing customs data for product ${line.productId}`);
    return {...line,hsCode:customs.hsCode,origin:customs.countryOfManufacture,weightKg:Number(customs.weightKg)};
  });
  const doc=new documentClass({size:'A4',margin:40,bufferPages:true,info:{Title:`Commercial Invoice ${invoice.invoiceNumber}`,Author:'Vaidahi Kala Private Limited',Subject:`FedEx export documentation for ${orderRef}`}});
  const chunks=[];doc.on('data',c=>chunks.push(c));
  const completed=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const left=40,right=555;
  const accent='#1F2937',ink='#182330',muted='#5A6472',rule='#CDD5DF';
  function text(t,x,y,opt={}){doc.fillColor(opt.color||ink).fontSize(opt.size||9).font(opt.bold?'Helvetica-Bold':'Helvetica').text(clean(t),x,y,{width:opt.width||235,align:opt.align||'left',lineBreak:false});}
  function line(y){doc.moveTo(left,y).lineTo(right,y).strokeColor(rule).lineWidth(0.8).stroke();}
  function addressBlock(label,a,x,y){
    text(label,x,y,{size:9,bold:true,color:accent});
    const lines=[a.company||a.name, a.name!==a.company?a.name:'', a.line1,a.line2, [a.city,a.state,a.pin].filter(Boolean).join(', '),a.country, a.phone, a.email].filter(Boolean).map(clean);
    let cy=y+17;
    for(const v of lines.slice(0,7)){doc.font('Helvetica').fontSize(9).fillColor(ink).text(v,x,cy,{width:240});cy+=Math.max(13,doc.heightOfString(v,{width:240}));}
  }
  function pageHeader(page=1){
    text('SMART HANDICRAFTS',left,35,{size:15,bold:true,color:accent,width:310});
    text('VAIDAHI KALA PVT. LTD.',left,55,{size:8,color:muted,width:310});
    text('COMMERCIAL INVOICE',300,34,{size:17,bold:true,width:260,align:'right'});
    text('For international customs clearance',300,59,{size:8,color:muted,width:260,align:'right'});
    line(81);
    if(page===1){
      text('INVOICE NO.',left,93,{size:8,bold:true,color:muted});text(invoice.invoiceNumber,left,106,{size:10,bold:true});
      text('INVOICE DATE',210,93,{size:8,bold:true,color:muted});text(invoice.invoiceDate||'—',210,106,{size:10,bold:true});
      text('SALES ORDER',390,93,{size:8,bold:true,color:muted});text(orderRef,390,106,{size:10,bold:true,width:170});
      addressBlock('EXPORTER / SHIPPER',from,left,137);addressBlock('CONSIGNEE / SHIP TO',to,305,137);
      line(283);
      text(`Reason for export: SALE OF GOODS`,left,291,{size:9,width:265});
      text(`Currency: ${invoice.currency}   Package: ${Number(pkg.weight).toFixed(3)} kg`,305,291,{size:9,width:250});
    }
  }
  pageHeader();
  let y=330;
  const cols=[{x:40,w:22,t:'#'},{x:66,w:166,t:'GOODS DESCRIPTION'},{x:235,w:47,t:'QTY'},{x:282,w:58,t:'HS CODE'},{x:343,w:43,t:'ORIGIN'},{x:390,w:77,t:'UNIT VALUE'},{x:470,w:82,t:'TOTAL'}];
  const tableHeader=()=>{doc.rect(left,y,right-left,26).fill('#EEF2F6');for(const c of cols)text(c.t,c.x,y+8,{size:7.5,bold:true,width:c.w});y+=30;};
  tableHeader();
  let number=0;
  for(const row of rows){
    if(y>690){doc.addPage();pageHeader(2);y=110;tableHeader();}
    number++;
    const h=Math.max(30,Math.min(65,Math.ceil(clean(row.description).length/34)*12+13));
    if(number%2===0)doc.rect(left,y-2,right-left,h).fill('#F8FAFC');
    const labels=[number,clean(row.description),row.quantity,row.hsCode,row.origin,Number(row.unitPrice).toFixed(2),Number(row.subtotal).toFixed(2)];
    cols.forEach((c,i)=>{
      doc.fillColor(ink).font(i===6?'Helvetica-Bold':'Helvetica').fontSize(8);
      doc.text(String(labels[i]),c.x,y+4,{width:c.w-2,align:i>4?'right':'left',height:h-5,ellipsis:true});
    });
    y+=h;
  }
  line(y+4); y+=17;
  text('TOTAL DECLARED GOODS VALUE',320,y,{size:9,bold:true,width:165});
  text(money(invoice.goodsTotal,invoice.currency),485,y,{size:10,bold:true,width:70,align:'right'});
  y+=27;
  text('Sales-order invoice total (may include freight/taxes):',left,y,{size:8,color:muted,width:365});
  text(money(invoice.amountTotal,invoice.currency),410,y,{size:8,color:muted,width:145,align:'right'});
  y+=28;
  if(y>720){doc.addPage();pageHeader(2);y=116;}
  text('DECLARATION',left,y,{size:9,bold:true});y+=16;
  doc.font('Helvetica').fontSize(8.5).fillColor(ink).text('I declare that the information provided on this commercial invoice is true and correct to the best of my knowledge. Product classifications, origin, quantities and values must be verified by the exporter before signing.',left,y,{width:515});
  y+=50;
  text('Authorized exporter signature: __________________________',left,y,{size:9,width:320});
  text('Date: __________________',375,y,{size:9,width:180});
  if(mode==='sandbox')text('SANDBOX TEST DOCUMENT — NOT FOR ACTUAL CUSTOMS CLEARANCE',left,767,{size:9,bold:true,color:'#B45309',width:530});
  doc.end();return completed;
}
