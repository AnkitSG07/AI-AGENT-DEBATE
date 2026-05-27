import express from "express";

const publicPort = Number(process.env.PORT || 3000);
const internalPort = Number(process.env.INTERNAL_SERVER_PORT || publicPort + 1);

process.env.PORT = String(internalPort);
await import("./server.js");

const app = express();

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
    session: {
      sdp_type: safeString(sdpType || "offer", 40),
      sdp: String(sdp || "")
    }
  };

  const url = `${graphBase.replace(/\/$/, "")}/${graphVersion}/${encodeURIComponent(safePhoneNumberId)}/calls`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
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
  function tsMs(c){
    const raw = c?.timestamp || c?.time || c?.date || c?.received_at || c?.created_at || 0;
    if (typeof raw === 'number') return raw < 2000000000 ? raw * 1000 : raw;
    const n = Number(raw);
    if (Number.isFinite(n) && n) return n < 2000000000 ? n * 1000 : n;
    const d = Date.parse(raw);
    return Number.isFinite(d) ? d : 0;
  }
  function eventOf(c){ try { return String(eventText(c) || c?.event || c?.status || ''); } catch { return String(c?.event || c?.status || ''); } }
  function idOf(c){ try { return String(callIdOf(c) || ''); } catch { return String(c?.call_id || c?.id || ''); } }
  function phoneOf(c){ try { return cleanPhone(callPhone(c)); } catch { return String(c?.customer_phone || c?.from || '').replace(/\D/g,''); } }
  function terminal(c){ return terminalRe.test(eventOf(c)); }
  function stale(c){ const t = tsMs(c); return !!t && (nowMs() - t > LIVE_MAX_AGE_MS); }
  function hasTerminalFor(id){ return !!id && safeArr(callsCache).some(x => idOf(x) === id && terminal(x)); }
  function liveOpenable(c){
    const id = idOf(c);
    const ev = eventOf(c);
    if (!id || terminal(c) || stale(c) || hasTerminalFor(id)) return false;
    return !!(c?.has_sdp || c?.session?.sdp || c?.raw?.call?.session?.sdp || liveRe.test(ev));
  }
  function mergeCalls(a,b){
    const map = new Map();
    [...safeArr(a), ...safeArr(b)].forEach(c => {
      const key = `${idOf(c)||phoneOf(c)||Math.random()}|${eventOf(c)}|${tsMs(c)||''}`;
      map.set(key,c);
    });
    return [...map.values()].sort((x,y)=>(tsMs(y)||0)-(tsMs(x)||0)).slice(0,150);
  }
  function readCache(){ try { return JSON.parse(localStorage.getItem(CACHE_KEY)||'[]'); } catch { return []; } }
  function writeCache(rows){ try { localStorage.setItem(CACHE_KEY, JSON.stringify(safeArr(rows).slice(0,150))); } catch {} }
  function stopCallTimer(reset=true){
    if (shTimerHandle) clearInterval(shTimerHandle);
    shTimerHandle = null;
    try { startedAt = 0; } catch {}
    if (reset) { try { $('timer').textContent='00:00'; } catch {} }
  }
  function setButtons(mode){
    const accept=$('acceptBtn'), reject=$('rejectBtn'), end=$('endBtn'), label=$('acceptLabel');
    if (!accept || !reject || !end) return;
    if (mode === 'ended') { accept.style.display='none'; reject.style.display='none'; end.style.display='none'; if(label) label.textContent='Ended'; return; }
    if (mode === 'outgoing') { accept.style.display='none'; reject.style.display='none'; end.style.display='grid'; if(label) label.textContent='Calling'; return; }
    if (mode === 'connected') { accept.style.display='none'; reject.style.display='none'; end.style.display='grid'; if(label) label.textContent='Connected'; return; }
    accept.style.display='grid'; reject.style.display='grid'; end.style.display='none'; if(label) label.textContent='Accept';
  }
  function endUi(message='Call ended', error=''){
    stopRingtone?.();
    stopCallTimer(false);
    try { pc && pc.close(); } catch {}
    try { localStream && localStream.getTracks().forEach(t=>t.stop()); } catch {}
    setButtons('ended');
    setState(message);
    if (error) showErr(error); else showErr('');
    setTimeout(()=>{ try { loadCalls(); } catch {} }, 600);
  }

  window.stopCallTimer = stopCallTimer;

  startTimer = function(){
    if (shTimerHandle) return;
    if (!startedAt) startedAt = Date.now();
    shTimerHandle = setInterval(()=>{
      const s=Math.floor((Date.now()-startedAt)/1000);
      try { $('timer').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); } catch {}
    },1000);
  };

  const oldLoadCalls = loadCalls;
  loadCalls = async function(){
    await oldLoadCalls().catch(()=>{});
    callsCache = mergeCalls(readCache(), callsCache);
    writeCache(callsCache);
    renderCalls();
  };

  cardHtml = function(c){
    const kind=callKind(c), cid=esc(callIdOf(c)), name=esc(callName(c)), ph=esc(callPhone(c)), digits=cleanPhone(ph);
    const time=esc(shortTime(c.date||c.received_at||c.created_at||c.timestamp||c.time||''));
    const ev=eventText(c);
    const open = liveOpenable(c) ? `<button class="client-open" data-call-id="${cid}" data-name="${name}" data-phone="${ph}">Open</button>` : '';
    const call = digits ? `<button class="client-call" data-out-phone="${digits}" data-out-name="${name}">${liveOpenable(c)?'Call':'Call Back'}</button>` : '<button class="client-call" disabled>No No.</button>';
    return `<div class="client-card ${kind}"><div class="client-avatar">${esc(callInitial(c))}</div><div class="client-name">${name}</div><div class="client-phone">${digits?('+'+digits):'No number'}</div><div class="client-meta">${esc(ev)}${time?' • '+time:''}</div><div class="client-badge ${kind}">${kind}</div><div class="card-actions">${call}${open}</div></div>`;
  };

  openExistingCall = function(id,name,ph){
    const rec = safeArr(callsCache).find(c => idOf(c) === String(id||''));
    if (!rec || !liveOpenable(rec)) {
      if (ph) return startOutgoingCall(ph,name);
      return;
    }
    callId=id||''; callerName=name||''; phone=(ph||'').replace(/\D/g,''); callModeActive=false;
    activateCallMode('Incoming WhatsApp Call'); fetchCall().catch(e=>{setState('Load failed');showErr(e.message||String(e));});
  };

  const oldFetchCall = fetchCall;
  fetchCall = async function(){
    await oldFetchCall();
    if (currentCall && !liveOpenable(currentCall)) endUi('Call already ended','This call is no longer active. Use Call Back to call the customer again.');
  };

  const oldAcceptCall = acceptCall;
  acceptCall = async function(){
    if (!currentCall || !liveOpenable(currentCall)) return endUi('Call already ended','This call is no longer active. Use Call Back to call the customer again.');
    await oldAcceptCall();
  };

  const oldRejectCall = rejectCall;
  rejectCall = async function(){ await oldRejectCall().catch(()=>{}); endUi('Call declined'); };

  const oldEndCall = endCall;
  endCall = async function(){ await oldEndCall().catch(()=>{}); endUi('Call ended'); };

  const oldStartOutgoingCall = startOutgoingCall;
  startOutgoingCall = async function(to,name){ stopCallTimer(); setButtons('outgoing'); await oldStartOutgoingCall(to,name); };

  const oldRenderCalls = renderCalls;
  renderCalls = function(){ oldRenderCalls(); };

  const back=$('backBtn');
  if (back) back.onclick=()=>{ endUi('Call closed'); callModeActive=false; outgoingMode=false; document.body.classList.remove('call-mode'); setButtons('incoming'); refresh(); loadCalls(); startIncomingCallWatcher(); };

  callsCache = mergeCalls(readCache(), callsCache);
  writeCache(callsCache);
  renderCalls();
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
    const upstream = await fetch(target, { method, headers, body: hasBody ? Buffer.concat(chunks) : undefined, redirect: "manual" });
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
  console.log(`Outgoing wrapper listening on ${publicPort}; original server on ${internalPort}`);
});
