import express from "express";

const publicPort = Number(process.env.PORT || 3000);
const internalPort = Number(process.env.INTERNAL_SERVER_PORT || publicPort + 1);
const ODOO_CALL_MODEL = process.env.ODOO_CALL_LOG_MODEL || "x_call_logs";

process.env.PORT = String(internalPort);
await import("./server.js");

const app = express();
let odooUidCache = null;

function cleanPhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function safeString(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function envFirst(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function odooConfig() {
  const url = envFirst("ODOO_URL", "ODOO_BASE_URL").replace(/\/$/, "");
  const db = envFirst("ODOO_DB", "ODOO_DATABASE");
  const username = envFirst("ODOO_USERNAME", "ODOO_USER", "ODOO_EMAIL");
  const password = envFirst("ODOO_API_KEY_OR_PASSWORD", "ODOO_API_KEY", "ODOO_PASSWORD");
  return { url, db, username, password, ready: !!(url && db && username && password) };
}

function odooDate(value = Date.now()) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return false;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function odooJsonRpc(service, method, args) {
  const cfg = odooConfig();
  if (!cfg.ready) throw new Error("Odoo env vars missing. Add ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY_OR_PASSWORD.");
  const resp = await fetch(`${cfg.url}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    throw new Error(data?.error?.data?.message || data?.error?.message || `Odoo JSON-RPC failed: ${resp.status}`);
  }
  return data.result;
}

async function odooUid() {
  if (odooUidCache) return odooUidCache;
  const cfg = odooConfig();
  odooUidCache = await odooJsonRpc("common", "login", [cfg.db, cfg.username, cfg.password]);
  if (!odooUidCache) throw new Error("Odoo login failed");
  return odooUidCache;
}

async function odooExecute(model, method, args = [], kwargs = {}) {
  const cfg = odooConfig();
  const uid = await odooUid();
  return odooJsonRpc("object", "execute_kw", [cfg.db, uid, cfg.password, model, method, args, kwargs]);
}

function eventStatus(event, direction = "incoming", previous = {}) {
  const e = String(event || "").toLowerCase();
  if (e.includes("reject")) return "declined";
  if (e.includes("failed")) return "failed";
  if (e.includes("terminate") || e.includes("ended") || e.includes("timeout") || e.includes("miss")) {
    if (previous.x_studio_x_status === "connected") return "ended";
    return direction === "outgoing" ? "ended" : "missed";
  }
  if (e.includes("connect")) return "ringing";
  if (e.includes("outgoing")) return "ringing";
  return "ringing";
}

function selectionEvent(event) {
  const e = String(event || "").toLowerCase();
  if (["connect", "terminate", "reject", "outgoing", "failed"].includes(e)) return e;
  if (e.includes("connect")) return "connect";
  if (e.includes("terminate") || e.includes("ended")) return "terminate";
  if (e.includes("reject") || e.includes("decline")) return "reject";
  if (e.includes("out")) return "outgoing";
  if (e.includes("fail")) return "failed";
  return "failed";
}

function directionOfCall(call = {}, fallback = "incoming") {
  const e = String(call.event || call.status || call.direction || fallback || "").toLowerCase();
  if (e.includes("out")) return "outgoing";
  return fallback === "outgoing" ? "outgoing" : "incoming";
}

function timestampMs(raw) {
  if (!raw) return Date.now();
  const n = Number(raw);
  if (Number.isFinite(n) && n) return n < 2000000000 ? n * 1000 : n;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function findOdooPartner(phone) {
  const p = cleanPhone(phone);
  if (!p) return false;
  const last = p.slice(-10);
  try {
    const rows = await odooExecute("res.partner", "search_read", [["|", ["phone", "ilike", last], ["mobile", "ilike", last]]], { fields: ["id", "name"], limit: 1 });
    return rows?.[0]?.id || false;
  } catch {
    return false;
  }
}

function normalizeForOdoo(row = {}) {
  const event = selectionEvent(row.event || row.status || row.direction || "connect");
  const direction = row.direction || directionOfCall(row, event === "outgoing" ? "outgoing" : "incoming");
  const startedMs = timestampMs(row.timestamp || row.date || row.received_at || row.created_at);
  const isEnd = ["terminate", "reject", "failed"].includes(event);
  const phone = cleanPhone(row.customer_phone || row.phone || row.from || row.wa_id || "");
  const callId = safeString(row.call_id || row.callId || row.id || `call-${phone || "unknown"}-${startedMs}`, 240);
  return {
    callId,
    phone,
    name: safeString(row.customer_name || row.name || row.from_name || row.wa_name || phone || "WhatsApp caller", 160),
    event,
    direction,
    status: eventStatus(event, direction, row.previous || {}),
    phoneNumberId: safeString(row.phone_number_id || row.phoneNumberId || row.raw?.metadata?.phone_number_id || envFirst("WHATSAPP_PHONE_NUMBER_ID", "META_WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_CALL_PHONE_NUMBER_ID"), 120),
    startedAt: odooDate(startedMs),
    endedAt: isEnd ? odooDate(startedMs) : false,
    lastEventAt: odooDate(startedMs),
    timestamp: Math.floor(startedMs / 1000),
    rawPayload: safeString(JSON.stringify(row.raw || row).slice(0, 3500), 3500),
    operator: safeString(row.operator || row.operator_name || "", 120)
  };
}

async function saveCallToOdoo(row = {}) {
  const cfg = odooConfig();
  if (!cfg.ready) return { ok: false, skipped: true, reason: "odoo_not_configured" };
  const n = normalizeForOdoo(row);
  const existingIds = await odooExecute(ODOO_CALL_MODEL, "search", [[["x_studio_x_call_id", "=", n.callId]]], { limit: 1 });
  const existingId = existingIds?.[0];
  let existing = {};
  if (existingId) {
    const oldRows = await odooExecute(ODOO_CALL_MODEL, "read", [[existingId], ["x_studio_x_call_started_at", "x_studio_x_status"]]);
    existing = oldRows?.[0] || {};
  }
  const partnerId = await findOdooPartner(n.phone);
  const values = {
    x_name: `${n.direction === "outgoing" ? "Outgoing" : "Incoming"} ${n.event} - ${n.name || n.phone}`,
    x_studio_x_call_id: n.callId,
    x_studio_x_customer_phone: n.phone,
    x_studio_x_customer_name: n.name,
    x_studio_x_direction: n.direction,
    x_studio_x_event: n.event,
    x_studio_event_1: n.event,
    x_studio_x_status: eventStatus(n.event, n.direction, existing),
    x_studio_x_phone_number_id: n.phoneNumberId,
    x_studio_x_last_event_at: n.lastEventAt,
    x_studio_x_operator: n.operator,
    x_studio_x_raw_payload: n.rawPayload
  };
  if (!existing?.x_studio_x_call_started_at) values.x_studio_x_call_started_at = n.startedAt;
  if (n.endedAt) values.x_studio_x_call_ended_at = n.endedAt;
  if (partnerId) values.x_studio_x_partner_id = partnerId;
  if (n.endedAt && existing?.x_studio_x_call_started_at) {
    const start = Date.parse(String(existing.x_studio_x_call_started_at).replace(" ", "T") + "Z");
    const end = Date.parse(String(n.endedAt).replace(" ", "T") + "Z");
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) values.x_studio_x_duration_seconds = Math.floor((end - start) / 1000);
  }
  Object.keys(values).forEach((k) => { if (values[k] === false || values[k] === "") delete values[k]; });
  if (existingId) {
    await odooExecute(ODOO_CALL_MODEL, "write", [[existingId], values]);
    return { ok: true, action: "updated", id: existingId, call_id: n.callId };
  }
  const id = await odooExecute(ODOO_CALL_MODEL, "create", [values]);
  return { ok: true, action: "created", id, call_id: n.callId };
}

function normalizeOdooRecord(r = {}) {
  const phone = cleanPhone(r.x_studio_x_customer_phone || "");
  const ts = timestampMs(r.x_studio_x_last_event_at || r.x_studio_x_call_started_at || r.create_date);
  return {
    id: `odoo-${r.id}`,
    odoo_id: r.id,
    call_id: r.x_studio_x_call_id || `odoo-${r.id}`,
    event: r.x_studio_x_event || "connect",
    status: r.x_studio_x_status || "ringing",
    direction: r.x_studio_x_direction || "incoming",
    customer_phone: phone,
    customer_name: r.x_studio_x_customer_name || phone || "WhatsApp caller",
    phone_number_id: r.x_studio_x_phone_number_id || "",
    timestamp: Math.floor(ts / 1000),
    date: new Date(ts).toISOString(),
    received_at: r.x_studio_x_last_event_at || r.write_date || "",
    duration_seconds: r.x_studio_x_duration_seconds || 0,
    source: "odoo"
  };
}

async function recentOdooCalls(limit = 80) {
  const cfg = odooConfig();
  if (!cfg.ready) return [];
  const fields = [
    "id", "x_name", "x_studio_x_call_id", "x_studio_x_customer_phone", "x_studio_x_customer_name",
    "x_studio_x_direction", "x_studio_x_event", "x_studio_x_status", "x_studio_x_phone_number_id",
    "x_studio_x_call_started_at", "x_studio_x_call_ended_at", "x_studio_x_last_event_at", "x_studio_x_duration_seconds", "write_date", "create_date"
  ];
  const rows = await odooExecute(ODOO_CALL_MODEL, "search_read", [[]], { fields, order: "x_studio_x_last_event_at desc, id desc", limit });
  return rows.map(normalizeOdooRecord);
}

function callValuesFromBody(body = {}) {
  const values = [];
  if (body?.field === "calls" && body.value) values.push(body.value);
  if (body?.sample?.field === "calls" && body.sample.value) values.push(body.sample.value);
  if (body?.calls) values.push(body);
  if (body?.value?.calls) values.push(body.value);
  if (Array.isArray(body?.entry)) {
    for (const entry of body.entry) {
      for (const change of entry?.changes || []) {
        if (change?.field === "calls" && change?.value) values.push(change.value);
        else if (change?.value?.calls) values.push(change.value);
      }
    }
  }
  return values;
}

async function saveWebhookCallsToOdoo(body = {}) {
  const results = [];
  for (const value of callValuesFromBody(body)) {
    const contacts = Array.isArray(value.contacts) ? value.contacts : [];
    for (const call of value.calls || []) {
      const from = cleanPhone(call.from || contacts?.[0]?.wa_id || "");
      const contact = contacts.find((c) => cleanPhone(c.wa_id) === from) || contacts[0] || {};
      const timestamp = Number(call.timestamp || 0) || Math.floor(Date.now() / 1000);
      const row = {
        call_id: call.id,
        event: call.event || "connect",
        direction: directionOfCall(call, "incoming"),
        customer_phone: from,
        customer_name: contact?.profile?.name || "",
        phone_number_id: value?.metadata?.phone_number_id || "",
        timestamp,
        raw: { call, metadata: value.metadata || null, contacts }
      };
      results.push(await saveCallToOdoo(row).catch((error) => ({ ok: false, error: error?.message || String(error), call_id: row.call_id })));
    }
  }
  return results;
}

async function forwardSyntheticCallLog(row = {}) {
  try {
    const payload = {
      field: "calls",
      value: {
        messaging_product: "whatsapp",
        metadata: {
          phone_number_id: row.phone_number_id || envFirst("WHATSAPP_PHONE_NUMBER_ID", "META_WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_CALL_PHONE_NUMBER_ID"),
          display_phone_number: envFirst("WHATSAPP_DISPLAY_PHONE_NUMBER", "META_WHATSAPP_DISPLAY_PHONE_NUMBER")
        },
        contacts: [{ wa_id: row.customer_phone, profile: { name: row.customer_name || "" } }],
        calls: [{
          id: row.call_id,
          from: row.customer_phone,
          to: envFirst("WHATSAPP_DISPLAY_PHONE_NUMBER", "META_WHATSAPP_DISPLAY_PHONE_NUMBER"),
          event: row.event,
          timestamp: String(row.timestamp || Math.floor(Date.now() / 1000))
        }]
      }
    };
    await fetch(`http://127.0.0.1:${internalPort}/api/whatsapp-calls/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => null);
  } catch {}
}

app.get("/api/odoo/call-log/recent", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 80), 200);
    const calls = await recentOdooCalls(limit);
    res.json({ ok: true, source: "odoo", calls });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error), calls: [] });
  }
});

app.post("/api/odoo/call-log/save", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const result = await saveCallToOdoo(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

async function graphOutboundCall({ to, sdp, sdpType, phoneNumberId }) {
  const accessToken = envFirst("WHATSAPP_CALL_ACCESS_TOKEN", "META_WHATSAPP_ACCESS_TOKEN", "WHATSAPP_ACCESS_TOKEN");
  const graphBase = envFirst("WHATSAPP_GRAPH_API_BASE", "META_GRAPH_API_BASE") || "https://graph.facebook.com";
  const graphVersion = envFirst("WHATSAPP_GRAPH_API_VERSION", "META_GRAPH_API_VERSION") || "v22.0";
  const safePhoneNumberId = safeString(phoneNumberId || envFirst("WHATSAPP_PHONE_NUMBER_ID", "META_WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_CALL_PHONE_NUMBER_ID"), 120);
  const safeTo = cleanPhone(to);
  if (!accessToken) throw new Error("WhatsApp access token missing. Add WHATSAPP_CALL_ACCESS_TOKEN or META_WHATSAPP_ACCESS_TOKEN in Render.");
  if (!safePhoneNumberId) throw new Error("WhatsApp phone_number_id missing. Add WHATSAPP_PHONE_NUMBER_ID in Render.");
  if (!safeTo) throw new Error("Customer phone number is required.");
  if (!sdp) throw new Error("Browser WebRTC offer SDP is required for outgoing call.");

  const payload = {
    messaging_product: "whatsapp",
    to: safeTo,
    action: "connect",
    session: { sdp_type: safeString(sdpType || "offer", 40), sdp: String(sdp || "") }
  };

  const url = `${graphBase.replace(/\/$/, "")}/${graphVersion}/${encodeURIComponent(safePhoneNumberId)}/calls`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.error) {
    const message = data?.error?.message || data?.error?.error_user_msg || `HTTP ${resp.status}`;
    throw new Error(`Outgoing WhatsApp call failed: ${message}`);
  }
  return data;
}

app.post("/api/whatsapp-calls/outgoing", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const body = req.body || {};
    const to = cleanPhone(body.to || body.phone || body.customer_phone || "");
    const customerName = safeString(body.customer_name || body.customerName || body.name || "", 160);
    const phoneNumberId = safeString(body.phone_number_id || body.phoneNumberId || "", 120);
    const sdp = String(body.sdp || body.offer_sdp || body.localDescription?.sdp || "");
    const sdpType = safeString(body.sdp_type || body.sdpType || body.localDescription?.type || "offer", 40);

    const graph = await graphOutboundCall({ to, sdp, sdpType, phoneNumberId });
    const callId = safeString(graph.call_id || graph.id || graph.calls?.[0]?.id || `outgoing-${to}-${Date.now()}`, 220);
    const event = {
      ok: true,
      call_id: callId,
      event: "outgoing",
      direction: "outgoing",
      customer_phone: to,
      customer_name: customerName,
      phone_number_id: phoneNumberId || envFirst("WHATSAPP_PHONE_NUMBER_ID", "META_WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_CALL_PHONE_NUMBER_ID"),
      timestamp: Math.floor(Date.now() / 1000),
      date: new Date().toISOString(),
      graph
    };
    await saveCallToOdoo(event).catch((error) => console.warn("Odoo outgoing call save failed:", error?.message || error));
    await forwardSyntheticCallLog(event);
    return res.json(event);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

function operatorLifecyclePatchScript() {
  return String.raw`
<script>
(() => {
  const CACHE_KEY = 'sh_operator_call_history_v2';
  const LIVE_MAX_AGE_MS = 120000;
  let shTimerHandle = null;
  const terminalRe = /miss|declin|reject|failed|ended|terminate|timeout|no.answer|no_answer|unanswered/i;
  const liveRe = /connect|ring|offer|incoming/i;
  function safeArr(v){ return Array.isArray(v) ? v : []; }
  function nowMs(){ return Date.now(); }
  function tsMs(c){ const raw=c?.timestamp||c?.time||c?.date||c?.received_at||c?.created_at||0; if(typeof raw==='number')return raw<2000000000?raw*1000:raw; const n=Number(raw); if(Number.isFinite(n)&&n)return n<2000000000?n*1000:n; const d=Date.parse(raw); return Number.isFinite(d)?d:0; }
  function eventOf(c){ try { return String(eventText(c)||c?.event||c?.status||''); } catch { return String(c?.event||c?.status||''); } }
  function idOf(c){ try { return String(callIdOf(c)||''); } catch { return String(c?.call_id||c?.id||''); } }
  function phoneOf(c){ try { return cleanPhone(callPhone(c)); } catch { return String(c?.customer_phone||c?.from||'').replace(/\D/g,''); } }
  function terminal(c){ return terminalRe.test(eventOf(c)) || ['missed','declined','ended','failed'].includes(String(c?.status||'').toLowerCase()); }
  function stale(c){ const t=tsMs(c); return !!t && (nowMs()-t>LIVE_MAX_AGE_MS); }
  function hasTerminalFor(id){ return !!id && safeArr(callsCache).some(x=>idOf(x)===id&&terminal(x)); }
  function liveOpenable(c){ const id=idOf(c), ev=eventOf(c); if(!id||terminal(c)||stale(c)||hasTerminalFor(id))return false; return !!(c?.has_sdp||c?.session?.sdp||c?.raw?.call?.session?.sdp||liveRe.test(ev)); }
  function mergeCalls(a,b){ const map=new Map(); [...safeArr(a),...safeArr(b)].forEach(c=>{ const key=`${idOf(c)||phoneOf(c)||Math.random()}|${eventOf(c)}|${tsMs(c)||''}`; map.set(key,c); }); return [...map.values()].sort((x,y)=>(tsMs(y)||0)-(tsMs(x)||0)).slice(0,150); }
  function readCache(){ try { return JSON.parse(localStorage.getItem(CACHE_KEY)||'[]'); } catch { return []; } }
  function writeCache(rows){ try { localStorage.setItem(CACHE_KEY, JSON.stringify(safeArr(rows).slice(0,150))); } catch {} }
  function stopCallTimer(reset=true){ if(shTimerHandle)clearInterval(shTimerHandle); shTimerHandle=null; try{startedAt=0;}catch{} if(reset){try{$('timer').textContent='00:00';}catch{}} }
  function setButtons(mode){ const accept=$('acceptBtn'), reject=$('rejectBtn'), end=$('endBtn'), label=$('acceptLabel'); if(!accept||!reject||!end)return; if(mode==='ended'){accept.style.display='none';reject.style.display='none';end.style.display='none';if(label)label.textContent='Ended';return;} if(mode==='outgoing'){accept.style.display='none';reject.style.display='none';end.style.display='grid';if(label)label.textContent='Calling';return;} if(mode==='connected'){accept.style.display='none';reject.style.display='none';end.style.display='grid';if(label)label.textContent='Connected';return;} accept.style.display='grid';reject.style.display='grid';end.style.display='none';if(label)label.textContent='Accept'; }
  function endUi(message='Call ended', error=''){ stopRingtone?.(); stopCallTimer(false); try{pc&&pc.close();}catch{} try{localStream&&localStream.getTracks().forEach(t=>t.stop());}catch{} setButtons('ended'); setState(message); if(error)showErr(error);else showErr(''); setTimeout(()=>{try{loadCalls();}catch{}},600); }
  window.stopCallTimer=stopCallTimer;
  startTimer=function(){ if(shTimerHandle)return; if(!startedAt)startedAt=Date.now(); shTimerHandle=setInterval(()=>{ const s=Math.floor((Date.now()-startedAt)/1000); try{$('timer').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}catch{} },1000); };
  const oldLoadCalls=loadCalls;
  loadCalls=async function(){ let odooRows=[]; try{ const r=await fetch('/api/odoo/call-log/recent?limit=100',{cache:'no-store'}); const j=await r.json(); if(j.ok && Array.isArray(j.calls)) odooRows=j.calls; }catch{} if(odooRows.length){ callsCache=mergeCalls(readCache(),odooRows); writeCache(callsCache); renderCalls(); return; } await oldLoadCalls().catch(()=>{}); callsCache=mergeCalls(readCache(),callsCache); writeCache(callsCache); renderCalls(); };
  cardHtml=function(c){ const kind=callKind(c), cid=esc(callIdOf(c)), name=esc(callName(c)), ph=esc(callPhone(c)), digits=cleanPhone(ph); const time=esc(shortTime(c.date||c.received_at||c.created_at||c.timestamp||c.time||'')); const ev=eventText(c); const open=liveOpenable(c)?`<button class="client-open" data-call-id="${cid}" data-name="${name}" data-phone="${ph}">Open</button>`:''; const call=digits?`<button class="client-call" data-out-phone="${digits}" data-out-name="${name}">${liveOpenable(c)?'Call':'Call Back'}</button>`:'<button class="client-call" disabled>No No.</button>'; return `<div class="client-card ${kind}"><div class="client-avatar">${esc(callInitial(c))}</div><div class="client-name">${name}</div><div class="client-phone">${digits?('+'+digits):'No number'}</div><div class="client-meta">${esc(ev)}${time?' • '+time:''}</div><div class="client-badge ${kind}">${kind}</div><div class="card-actions">${call}${open}</div></div>`; };
  openExistingCall=function(id,name,ph){ const rec=safeArr(callsCache).find(c=>idOf(c)===String(id||'')); if(!rec||!liveOpenable(rec)){ if(ph)return startOutgoingCall(ph,name); return; } callId=id||'';callerName=name||'';phone=(ph||'').replace(/\D/g,'');callModeActive=false;activateCallMode('Incoming WhatsApp Call');fetchCall().catch(e=>{setState('Load failed');showErr(e.message||String(e));}); };
  const oldFetchCall=fetchCall; fetchCall=async function(){ await oldFetchCall(); if(currentCall&&!liveOpenable(currentCall))endUi('Call already ended','This call is no longer active. Use Call Back to call the customer again.'); };
  const oldAcceptCall=acceptCall; acceptCall=async function(){ if(!currentCall||!liveOpenable(currentCall))return endUi('Call already ended','This call is no longer active. Use Call Back to call the customer again.'); await oldAcceptCall(); };
  const oldRejectCall=rejectCall; rejectCall=async function(){ await oldRejectCall().catch(()=>{}); endUi('Call declined'); };
  const oldEndCall=endCall; endCall=async function(){ await oldEndCall().catch(()=>{}); endUi('Call ended'); };
  const oldStartOutgoingCall=startOutgoingCall; startOutgoingCall=async function(to,name){ stopCallTimer(); setButtons('outgoing'); await oldStartOutgoingCall(to,name); };
  const back=$('backBtn'); if(back)back.onclick=()=>{endUi('Call closed');callModeActive=false;outgoingMode=false;document.body.classList.remove('call-mode');setButtons('incoming');refresh();loadCalls();startIncomingCallWatcher();};
  callsCache=mergeCalls(readCache(),callsCache);writeCache(callsCache);renderCalls();loadCalls();
})();
</script>`;
}

function maybeInjectOperatorPatch(req, headers, buffer) {
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  const type = String(headers.get("content-type") || "");
  if (!path.includes("operator-notifications") || !type.includes("text/html")) return buffer;
  let html = buffer.toString("utf8");
  if (html.includes("sh_operator_call_history_v2")) return buffer;
  html = html.replace("</body>", `${operatorLifecyclePatchScript()}\n</body>`);
  return Buffer.from(html, "utf8");
}

app.use(async (req, res) => {
  try {
    const target = `http://127.0.0.1:${internalPort}${req.originalUrl || req.url}`;
    const headers = { ...req.headers, host: `127.0.0.1:${internalPort}` };
    delete headers["content-length"];
    const method = req.method || "GET";
    const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
    const chunks = [];
    if (hasBody) for await (const chunk of req) chunks.push(chunk);
    const bodyBuffer = hasBody ? Buffer.concat(chunks) : undefined;
    if (bodyBuffer && String(req.originalUrl || req.url || "").split("?")[0] === "/webhook") {
      try {
        const bodyJson = JSON.parse(bodyBuffer.toString("utf8"));
        saveWebhookCallsToOdoo(bodyJson).then((r) => {
          if (r?.length) console.log("Odoo WhatsApp call log sync:", r);
        }).catch((e) => console.warn("Odoo WhatsApp call log sync failed:", e?.message || e));
      } catch {}
    }
    const upstream = await fetch(target, { method, headers, body: bodyBuffer, redirect: "manual" });
    let buffer = Buffer.from(await upstream.arrayBuffer());
    buffer = maybeInjectOperatorPatch(req, upstream.headers, buffer);
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!["content-encoding", "transfer-encoding", "connection", "content-length"].includes(key.toLowerCase())) res.setHeader(key, value);
    });
    res.send(buffer);
  } catch (error) {
    res.status(502).json({ ok: false, error: error?.message || String(error), proxy: true });
  }
});

app.listen(publicPort, () => {
  console.log(`Outgoing wrapper listening on ${publicPort}; original server on ${internalPort}; Odoo call model ${ODOO_CALL_MODEL}`);
});
