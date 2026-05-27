import express from "express";

const publicPort = Number(process.env.PORT || 3000);
const internalPort = Number(process.env.INTERNAL_SERVER_PORT || publicPort + 1);
const ODOO_CALL_MODEL = process.env.ODOO_CALL_LOG_MODEL || "x_call_logs";

process.env.PORT = String(internalPort);
await import("./server.js");

const app = express();
let odooUidCache = null;
const contactCache = new Map();

const cleanPhone = (v = "") => String(v || "").replace(/\D/g, "");
const safeString = (v = "", max = 500) => String(v || "").trim().slice(0, max);
const envFirst = (...names) => names.map((n) => String(process.env[n] || "").trim()).find(Boolean) || "";
const businessPhones = () => [
  envFirst("WHATSAPP_DISPLAY_PHONE_NUMBER", "META_WHATSAPP_DISPLAY_PHONE_NUMBER"),
  envFirst("WHATSAPP_BUSINESS_NUMBER", "META_WHATSAPP_BUSINESS_NUMBER")
].map(cleanPhone).filter(Boolean);

function odooConfig() {
  const url = envFirst("ODOO_URL", "ODOO_BASE_URL").replace(/\/$/, "");
  const db = envFirst("ODOO_DB", "ODOO_DATABASE");
  const username = envFirst("ODOO_USERNAME", "ODOO_USER", "ODOO_EMAIL");
  const password = envFirst("ODOO_API_KEY_OR_PASSWORD", "ODOO_API_KEY", "ODOO_PASSWORD");
  return { url, db, username, password, ready: !!(url && db && username && password) };
}

function odooDate(value = Date.now()) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19).replace("T", " ") : false;
}

async function odooJsonRpc(service, method, args) {
  const cfg = odooConfig();
  if (!cfg.ready) throw new Error("Odoo env vars missing.");
  const resp = await fetch(`${cfg.url}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Date.now()
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    throw new Error(data?.error?.data?.message || data?.error?.message || `Odoo JSON-RPC failed ${resp.status}`);
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

function timestampMs(raw) {
  if (!raw) return Date.now();
  const n = Number(raw);
  if (Number.isFinite(n) && n) return n < 2000000000 ? n * 1000 : n;
  const p = Date.parse(raw);
  return Number.isFinite(p) ? p : Date.now();
}

function selectionEvent(event) {
  const e = String(event || "").toLowerCase();
  if (["connect", "terminate", "reject", "outgoing", "failed"].includes(e)) return e;
  if (e.includes("connect")) return "connect";
  if (e.includes("terminate") || e.includes("end") || e.includes("miss") || e.includes("timeout")) return "terminate";
  if (e.includes("reject") || e.includes("decline")) return "reject";
  if (e.includes("out")) return "outgoing";
  return "failed";
}

function eventStatus(event, direction = "incoming", previous = {}) {
  const e = String(event || "").toLowerCase();
  if (e.includes("reject") || e.includes("decline")) return direction === "outgoing" ? "ended" : "declined";
  if (e.includes("failed")) return "failed";
  if (e.includes("terminate") || e.includes("end") || e.includes("timeout") || e.includes("miss")) {
    return previous.x_studio_x_status === "connected" ? "ended" : (direction === "outgoing" ? "ended" : "missed");
  }
  return "ringing";
}

function directionOfCall(call = {}, fallback = "incoming") {
  const e = String(call.event || call.status || call.direction || fallback || "").toLowerCase();
  return e.includes("out") || fallback === "outgoing" ? "outgoing" : "incoming";
}

function validName(value = "", phone = "") {
  const v = safeString(value, 160);
  if (!v) return false;
  if (v === phone || v === `+${phone}`) return false;
  if (/^\d{7,15}$/.test(cleanPhone(v))) return false;
  if (/whatsapp caller/i.test(v)) return false;
  return v;
}

async function lookupOdooContact(phone) {
  const p = cleanPhone(phone);
  if (!p || !odooConfig().ready) return null;

  const key = p.slice(-10) || p;
  if (contactCache.has(key)) return contactCache.get(key);

  try {
    const rows = await odooExecute(
      "res.partner",
      "search_read",
      [["|", "|", ["phone", "ilike", key], ["mobile", "ilike", key], ["commercial_partner_id.phone", "ilike", key]]],
      { fields: ["id", "name", "phone", "mobile", "email", "commercial_company_name", "parent_id"], limit: 8 }
    );

    const scored = (rows || []).map((r) => {
      const ph = cleanPhone(r.phone || "");
      const mob = cleanPhone(r.mobile || "");
      let score = 0;
      if (ph === p || mob === p) score += 100;
      if (ph.endsWith(key) || mob.endsWith(key)) score += 50;
      if (r.name) score += 5;
      return { ...r, score };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    const contact = best ? {
      id: best.id,
      name: best.name || "",
      phone: best.phone || "",
      mobile: best.mobile || "",
      email: best.email || "",
      company: best.commercial_company_name || "",
      parent_id: Array.isArray(best.parent_id) ? best.parent_id[0] : false,
      source: "odoo"
    } : null;

    contactCache.set(key, contact);
    return contact;
  } catch (error) {
    console.warn("Odoo contact lookup failed:", error?.message || error);
    contactCache.set(key, null);
    return null;
  }
}

function normalizeForOdoo(row = {}) {
  const event = selectionEvent(row.event || row.status || row.direction || "connect");
  const direction = row.direction || directionOfCall(row, event === "outgoing" ? "outgoing" : "incoming");
  const ms = timestampMs(row.timestamp || row.date || row.received_at || row.created_at);
  const phone = cleanPhone(row.customer_phone || row.phone || row.from || row.wa_id || "");
  const callId = safeString(row.call_id || row.callId || row.id || `call-${phone || "unknown"}-${ms}`, 240);
  const isEnd = ["terminate", "reject", "failed"].includes(event);

  return {
    callId,
    phone,
    event,
    direction,
    timestamp: Math.floor(ms / 1000),
    name: safeString(row.customer_name || row.name || row.from_name || row.wa_name || phone || "WhatsApp caller", 160),
    phoneNumberId: safeString(
      row.phone_number_id ||
      row.phoneNumberId ||
      row.raw?.metadata?.phone_number_id ||
      envFirst("WHATSAPP_PHONE_NUMBER_ID", "META_WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_CALL_PHONE_NUMBER_ID"),
      120
    ),
    startedAt: odooDate(ms),
    endedAt: isEnd ? odooDate(ms) : false,
    lastEventAt: odooDate(ms),
    rawPayload: safeString(JSON.stringify(row.raw || row).slice(0, 3500), 3500),
    operator: safeString(row.operator || row.operator_name || "", 120)
  };
}

async function saveCallToOdoo(row = {}) {
  if (!odooConfig().ready) return { ok: false, skipped: true };

  const n = normalizeForOdoo(row);
  const contact = await lookupOdooContact(n.phone);
  const finalName = validName(contact?.name, n.phone) || validName(n.name, n.phone) || n.name || n.phone || "WhatsApp caller";

  const ids = await odooExecute(ODOO_CALL_MODEL, "search", [[["x_studio_x_call_id", "=", n.callId]]], { limit: 1 });
  const id = ids?.[0];

  let old = {};
  if (id) {
    old = (await odooExecute(
      ODOO_CALL_MODEL,
      "read",
      [[id], ["x_studio_x_call_started_at", "x_studio_x_status"]]
    ))?.[0] || {};
  }

  const vals = {
    x_name: `${n.direction === "outgoing" ? "Outgoing" : "Incoming"} ${n.event} - ${finalName}`,
    x_studio_x_call_id: n.callId,
    x_studio_x_customer_phone: n.phone,
    x_studio_x_customer_name: finalName,
    x_studio_x_direction: n.direction,
    x_studio_x_event: n.event,
    x_studio_event_1: n.event,
    x_studio_x_status: eventStatus(n.event, n.direction, old),
    x_studio_x_phone_number_id: n.phoneNumberId,
    x_studio_x_last_event_at: n.lastEventAt,
    x_studio_x_operator: n.operator,
    x_studio_x_raw_payload: n.rawPayload
  };

  if (!old.x_studio_x_call_started_at) vals.x_studio_x_call_started_at = n.startedAt;
  if (n.endedAt) vals.x_studio_x_call_ended_at = n.endedAt;
  if (contact?.id) vals.x_studio_x_partner_id = contact.id;

  if (n.endedAt && old.x_studio_x_call_started_at) {
    const start = Date.parse(String(old.x_studio_x_call_started_at).replace(" ", "T") + "Z");
    const end = Date.parse(String(n.endedAt).replace(" ", "T") + "Z");
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      vals.x_studio_x_duration_seconds = Math.floor((end - start) / 1000);
    }
  }

  Object.keys(vals).forEach((k) => {
    if (vals[k] === false || vals[k] === "") delete vals[k];
  });

  if (id) {
    await odooExecute(ODOO_CALL_MODEL, "write", [[id], vals]);
    return { ok: true, action: "updated", id, call_id: n.callId, contact_source: contact ? "odoo" : "none" };
  }

  const newId = await odooExecute(ODOO_CALL_MODEL, "create", [vals]);
  return { ok: true, action: "created", id: newId, call_id: n.callId, contact_source: contact ? "odoo" : "none" };
}

async function normalizeOdooRecord(r = {}) {
  const phone = cleanPhone(r.x_studio_x_customer_phone || "");
  const ts = timestampMs(r.x_studio_x_last_event_at || r.x_studio_x_call_started_at || r.create_date);
  const partner = Array.isArray(r.x_studio_x_partner_id)
    ? { id: r.x_studio_x_partner_id[0], name: r.x_studio_x_partner_id[1] }
    : null;

  let customerName = validName(r.x_studio_x_customer_name, phone) || validName(partner?.name, phone) || "";

  if (!customerName && phone) {
    const contact = await lookupOdooContact(phone);
    customerName = validName(contact?.name, phone) || "";
  }

  return {
    id: `odoo-${r.id}`,
    odoo_id: r.id,
    call_id: r.x_studio_x_call_id || `odoo-${r.id}`,
    event: r.x_studio_x_event || "connect",
    status: r.x_studio_x_status || "ringing",
    direction: r.x_studio_x_direction || "incoming",
    customer_phone: phone,
    customer_name: customerName || phone || "WhatsApp caller",
    partner_id: partner?.id || false,
    partner_name: partner?.name || "",
    contact_source: partner?.id ? "odoo" : (customerName ? "odoo_lookup" : "none"),
    phone_number_id: r.x_studio_x_phone_number_id || "",
    timestamp: Math.floor(ts / 1000),
    date: new Date(ts).toISOString(),
    received_at: r.x_studio_x_last_event_at || r.write_date || "",
    duration_seconds: r.x_studio_x_duration_seconds || 0,
    source: "odoo"
  };
}

async function recentOdooCalls(limit = 80) {
  if (!odooConfig().ready) return [];

  const fields = [
    "id",
    "x_name",
    "x_studio_x_call_id",
    "x_studio_x_customer_phone",
    "x_studio_x_customer_name",
    "x_studio_x_partner_id",
    "x_studio_x_direction",
    "x_studio_x_event",
    "x_studio_x_status",
    "x_studio_x_phone_number_id",
    "x_studio_x_call_started_at",
    "x_studio_x_call_ended_at",
    "x_studio_x_last_event_at",
    "x_studio_x_duration_seconds",
    "write_date",
    "create_date"
  ];

  const rows = await odooExecute(
    ODOO_CALL_MODEL,
    "search_read",
    [[]],
    { fields, order: "x_studio_x_last_event_at desc, id desc", limit }
  );

  return Promise.all(rows.map(normalizeOdooRecord));
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

function analyzeCallWebhook(body = {}) {
  const values = callValuesFromBody(body);
  const biz = businessPhones();
  let hasCalls = false;
  let hasIncoming = false;
  let hasOutgoing = false;

  for (const value of values) {
    for (const call of value.calls || []) {
      hasCalls = true;

      const display = cleanPhone(value?.metadata?.display_phone_number || "");
      const localBiz = [...biz, display].filter(Boolean);
      const from = cleanPhone(call.from || "");
      const event = String(call.event || "").toLowerCase();

      const outgoing =
        (from && localBiz.includes(from)) ||
        event.includes("outgoing") ||
        event.includes("dial");

      if (outgoing) hasOutgoing = true;
      else hasIncoming = true;
    }
  }

  return {
    hasCalls,
    hasIncoming,
    hasOutgoing,
    outgoingOnly: hasCalls && hasOutgoing && !hasIncoming
  };
}

async function saveWebhookCallsToOdoo(body = {}) {
  const results = [];
  const biz = businessPhones();

  for (const value of callValuesFromBody(body)) {
    const contacts = Array.isArray(value.contacts) ? value.contacts : [];
    const display = cleanPhone(value?.metadata?.display_phone_number || "");
    const localBiz = [...biz, display].filter(Boolean);

    for (const call of value.calls || []) {
      const from = cleanPhone(call.from || "");
      const to = cleanPhone(call.to || "");
      const eventText = String(call.event || "").toLowerCase();

      const direction =
        (from && localBiz.includes(from)) ||
        eventText.includes("outgoing") ||
        eventText.includes("dial")
          ? "outgoing"
          : directionOfCall(call, "incoming");

      const customerPhone =
        direction === "outgoing"
          ? (to || cleanPhone(contacts?.[0]?.wa_id || ""))
          : (from || cleanPhone(contacts?.[0]?.wa_id || ""));

      const contact = contacts.find((c) => cleanPhone(c.wa_id) === customerPhone) || contacts[0] || {};

      const row = {
        call_id: call.id,
        event: call.event || "connect",
        direction,
        customer_phone: customerPhone,
        customer_name: contact?.profile?.name || "",
        phone_number_id: value?.metadata?.phone_number_id || "",
        timestamp: Number(call.timestamp || 0) || Math.floor(Date.now() / 1000),
        raw: { call, metadata: value.metadata || null, contacts }
      };

      results.push(await saveCallToOdoo(row).catch((error) => ({
        ok: false,
        error: error?.message || String(error),
        call_id: row.call_id
      })));
    }
  }

  return results;
}

app.get("/api/contacts/lookup", async (req, res) => {
  try {
    const phone = cleanPhone(req.query.phone || req.query.q || "");
    const contact = await lookupOdooContact(phone);
    res.json({
      ok: true,
      phone,
      contact,
      source: contact ? "odoo" : "none",
      gmail_note: "Gmail contacts require Google People API OAuth or syncing Gmail contacts into Odoo."
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error), contact: null });
  }
});

app.get("/api/odoo/call-log/recent", async (req, res) => {
  try {
    res.json({
      ok: true,
      source: "odoo",
      calls: await recentOdooCalls(Math.min(Number(req.query.limit || 80), 200))
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error), calls: [] });
  }
});

app.post("/api/odoo/call-log/save", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    res.json(await saveCallToOdoo(req.body || {}));
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.get("/api/whatsapp-calls/recent", async (req, res) => {
  try {
    const calls = await recentOdooCalls(Math.min(Number(req.query.limit || 80), 200));
    if (calls.length) return res.json({ ok: true, source: "odoo", calls });
  } catch {}

  return proxyRequest(req, res);
});

async function graphCallAction({ callId, action, sdp, sdpType, phoneNumberId }) {
  const accessToken = envFirst("WHATSAPP_CALL_ACCESS_TOKEN", "META_WHATSAPP_ACCESS_TOKEN", "WHATSAPP_ACCESS_TOKEN");
  const graphBase = envFirst("WHATSAPP_GRAPH_API_BASE", "META_GRAPH_API_BASE") || "https://graph.facebook.com";
  const graphVersion = envFirst("WHATSAPP_GRAPH_API_VERSION", "META_GRAPH_API_VERSION") || "v22.0";
  const safePhoneNumberId = safeString(
    phoneNumberId ||
    envFirst("WHATSAPP_PHONE_NUMBER_ID", "META_WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_CALL_PHONE_NUMBER_ID"),
    120
  );

  if (!accessToken) throw new Error("WhatsApp access token missing.");
  if (!safePhoneNumberId) throw new Error("WhatsApp phone_number_id missing.");
  if (!callId) throw new Error("call_id is required.");

  const payload = {
    messaging_product: "whatsapp",
    call_id: callId,
    action
  };

  if (sdp) {
    payload.session = {
      sdp_type: safeString(sdpType || "offer", 40),
      sdp: String(sdp)
    };
  }

  const resp = await fetch(
    `${graphBase.replace(/\/$/, "")}/${graphVersion}/${encodeURIComponent(safePhoneNumberId)}/calls`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data?.error) {
    throw new Error(`WhatsApp call ${action} failed: ${data?.error?.message || data?.error?.error_user_msg || `HTTP ${resp.status}`}`);
  }

  return data;
}

async function graphOutboundCall({ to, sdp, sdpType, phoneNumberId }) {
  const accessToken = envFirst("WHATSAPP_CALL_ACCESS_TOKEN", "META_WHATSAPP_ACCESS_TOKEN", "WHATSAPP_ACCESS_TOKEN");
  const graphBase = envFirst("WHATSAPP_GRAPH_API_BASE", "META_GRAPH_API_BASE") || "https://graph.facebook.com";
  const graphVersion = envFirst("WHATSAPP_GRAPH_API_VERSION", "META_GRAPH_API_VERSION") || "v22.0";
  const safePhoneNumberId = safeString(
    phoneNumberId ||
    envFirst("WHATSAPP_PHONE_NUMBER_ID", "META_WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_CALL_PHONE_NUMBER_ID"),
    120
  );
  const safeTo = cleanPhone(to);

  if (!accessToken) throw new Error("WhatsApp access token missing.");
  if (!safePhoneNumberId) throw new Error("WhatsApp phone_number_id missing.");
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

  const resp = await fetch(
    `${graphBase.replace(/\/$/, "")}/${graphVersion}/${encodeURIComponent(safePhoneNumberId)}/calls`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data?.error) {
    throw new Error(`Outgoing WhatsApp call failed: ${data?.error?.message || data?.error?.error_user_msg || `HTTP ${resp.status}`}`);
  }

  return data;
}

app.post("/api/whatsapp-calls/outgoing", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const body = req.body || {};
    const to = cleanPhone(body.to || body.phone || body.customer_phone || "");
    const contact = await lookupOdooContact(to);
    const customerName = safeString(body.customer_name || body.customerName || body.name || contact?.name || "", 160);
    const phoneNumberId = safeString(body.phone_number_id || body.phoneNumberId || "", 120);

    const graph = await graphOutboundCall({
      to,
      sdp: String(body.sdp || body.offer_sdp || body.localDescription?.sdp || ""),
      sdpType: safeString(body.sdp_type || body.sdpType || body.localDescription?.type || "offer", 40),
      phoneNumberId
    });

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

    await saveCallToOdoo(event).catch((e) => console.warn("Odoo outgoing call save failed:", e?.message || e));

    res.json(event);
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post("/api/whatsapp-calls/terminate", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const body = req.body || {};
    const callId = safeString(body.call_id || body.callId || "", 240);
    const phoneNumberId = safeString(body.phone_number_id || body.phoneNumberId || "", 120);

    const graph = await graphCallAction({
      callId,
      action: "terminate",
      phoneNumberId
    });

    await saveCallToOdoo({
      call_id: callId,
      event: "terminate",
      direction: body.direction || "outgoing",
      customer_phone: body.customer_phone || body.phone || "",
      phone_number_id: phoneNumberId,
      timestamp: Math.floor(Date.now() / 1000),
      raw: { terminate_request: body, graph }
    }).catch(() => null);

    res.json({ ok: true, call_id: callId, graph });
  } catch (error) {
    try {
      const target = `http://127.0.0.1:${internalPort}/api/whatsapp-calls/terminate`;
      const upstream = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {})
      });
      const data = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json(data);
    } catch {}

    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

function injectCallFixes(req, headers, buffer) {
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  const type = String(headers.get("content-type") || "");

  if (!path.includes("operator-notifications") || !type.includes("text/html")) return buffer;

  let html = buffer.toString("utf8");

  if (!html.includes("operator-call-fixes.js")) {
    html = html.replace("</body>", '<script src="/operator-call-fixes.js?v=7"></script></body>');
  }

  return Buffer.from(html, "utf8");
}

async function proxyRequest(req, res, providedBodyBuffer = null) {
  const target = `http://127.0.0.1:${internalPort}${req.originalUrl || req.url}`;
  const headers = { ...req.headers, host: `127.0.0.1:${internalPort}` };
  delete headers["content-length"];

  const method = req.method || "GET";
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const chunks = [];

  if (hasBody && !providedBodyBuffer) {
    for await (const chunk of req) chunks.push(chunk);
  }

  const bodyBuffer = providedBodyBuffer || (hasBody ? Buffer.concat(chunks) : undefined);

  const upstream = await fetch(target, {
    method,
    headers,
    body: bodyBuffer,
    redirect: "manual"
  });

  let buffer = Buffer.from(await upstream.arrayBuffer());
  buffer = injectCallFixes(req, upstream.headers, buffer);

  res.status(upstream.status);

  upstream.headers.forEach((value, key) => {
    if (!["content-encoding", "transfer-encoding", "connection", "content-length"].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });

  res.send(buffer);
}

app.use(async (req, res) => {
  try {
    const method = req.method || "GET";
    const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
    const chunks = [];

    if (hasBody) {
      for await (const chunk of req) chunks.push(chunk);
    }

    const bodyBuffer = hasBody ? Buffer.concat(chunks) : undefined;
    const path = String(req.originalUrl || req.url || "").split("?")[0];

    if (bodyBuffer && path === "/webhook") {
      let bodyJson = null;

      try {
        bodyJson = JSON.parse(bodyBuffer.toString("utf8"));
        saveWebhookCallsToOdoo(bodyJson)
          .then((r) => {
            if (r?.length) console.log("Odoo WhatsApp call log sync:", r);
          })
          .catch((e) => console.warn("Odoo WhatsApp call log sync failed:", e?.message || e));
      } catch {}

      const analysis = bodyJson ? analyzeCallWebhook(bodyJson) : { outgoingOnly: false };

      if (analysis.outgoingOnly) {
        return res.json({
          ok: true,
          skipped_forward_to_incoming_handler: true,
          reason: "outgoing_call_webhook_saved_to_odoo_only"
        });
      }
    }

    return proxyRequest(req, res, bodyBuffer);
  } catch (error) {
    res.status(502).json({ ok: false, error: error?.message || String(error), proxy: true });
  }
});

app.listen(publicPort, () => {
  console.log(`Outgoing wrapper listening on ${publicPort}; original server on ${internalPort}; Odoo call model ${ODOO_CALL_MODEL}`);
});
