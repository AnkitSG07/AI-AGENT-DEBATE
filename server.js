import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import PDFDocument from "pdfkit";

dotenv.config();

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

function now() {
  return new Date().toISOString();
}

// ===================== AI CONFIG =====================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const genAI = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const GEMINI_MODEL = "gemini-2.5-flash";
const LLAMA_MODEL = process.env.OR_MODEL_LLAMA || "meta-llama/llama-3.1-8b-instruct";
const AGENT_C_MODEL = process.env.OR_MODEL_MISTRAL || "google/gemma-2-9b-it";

// ===================== ODOO CONFIG =====================
const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_PASS = process.env.ODOO_API_KEY_OR_PASSWORD;
const odooConfigured = !!(ODOO_URL && ODOO_DB && ODOO_USERNAME && ODOO_PASS);

// ===================== STORES (in-memory) =====================
const labelsStore = new Map(); // labelId -> record
const labelDraftsBySO = new Map(); // sale_order_id -> draft
let labelCounter = 1;

function makeLabelId() {
  return `LBL-${Date.now()}-${labelCounter++}`;
}

// ===== Default From Address =====
function getDefaultFromAddress() {
  return {
    name: process.env.SHIP_FROM_NAME || "Smart Handicrafts",
    company: process.env.SHIP_FROM_COMPANY || "VAIDAHI KALA Pvt. Ltd.",
    phone: process.env.SHIP_FROM_PHONE || "",
    email: process.env.SHIP_FROM_EMAIL || "",
    line1: process.env.SHIP_FROM_LINE1 || "",
    line2: process.env.SHIP_FROM_LINE2 || "",
    city: process.env.SHIP_FROM_CITY || "",
    state: process.env.SHIP_FROM_STATE || "",
    pin: process.env.SHIP_FROM_PIN || "",
    country: process.env.SHIP_FROM_COUNTRY || "India"
  };
}

// ===================== ODOO JSON-RPC HELPERS =====================
async function odooJsonRpc(service, method, args) {
  const base = ODOO_URL.replace(/\/$/, "");
  const resp = await fetch(`${base}/jsonrpc`, {
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
  if (!resp.ok || data?.error) {
    const msg =
      data?.error?.data?.message ||
      data?.error?.message ||
      `HTTP ${resp.status}: ${JSON.stringify(data)}`;
    throw new Error(`Odoo RPC error: ${msg}`);
  }
  return data.result;
}

async function odooLogin() {
  const uid = await odooJsonRpc("common", "login", [ODOO_DB, ODOO_USERNAME, ODOO_PASS]);
  if (!uid) throw new Error("Odoo login failed. Check DB/username/api key.");
  return uid;
}

async function odooExecute(uid, model, method, params = [], kw = {}) {
  return await odooJsonRpc("object", "execute_kw", [
    ODOO_DB,
    uid,
    ODOO_PASS,
    model,
    method,
    params,
    kw
  ]);
}

// Find SO by ref and normalize details
async function odooFetchPartner(uid, partnerId) {
  if (!partnerId) return {};
  const recs = await odooExecute(uid, "res.partner", "read", [[partnerId], [
    "name",
    "phone",
    "email",
    "street",
    "street2",
    "city",
    "state_id",
    "zip",
    "country_id",
    "vat",
    "company_name",
    "parent_name"
  ]]);
  return recs?.[0] || {};
}

function mapPartnerToAddress(p) {
  const stateName = p.state_id?.[1] || "";
  const countryName = p.country_id?.[1] || "";
  return {
    name: p.name || p.parent_name || "",
    company: p.company_name || "",
    phone: p.phone || "",
    email: p.email || "",
    line1: p.street || "",
    line2: p.street2 || "",
    city: p.city || "",
    state: stateName,
    pin: p.zip || "",
    country: countryName || "India",
    vat: p.vat || ""
  };
}

async function odooGetPaymentStatus(uid, invoiceIds) {
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return { payment_status: "no_invoice", invoices: [] };
  }

  const invoices = await odooExecute(
    uid,
    "account.move",
    "read",
    [invoiceIds, ["id", "name", "amount_total", "amount_residual", "payment_state", "state"]]
  );

  const paid = (invoices || []).every((i) => i.payment_state === "paid");
  const posted = (invoices || []).every((i) => i.state === "posted");

  return {
    payment_status: paid ? "paid" : (posted ? "unpaid" : "draft"),
    invoices: (invoices || []).map((i) => ({
      id: i.id,
      name: i.name,
      amount_total: i.amount_total,
      amount_residual: i.amount_residual,
      payment_state: i.payment_state,
      state: i.state
    }))
  };
}

async function odooGetSaleOrderByRef(ref) {
  const uid = await odooLogin();

  const records = await odooExecute(
    uid,
    "sale.order",
    "search_read",
    [[ ["name", "=", ref] ], [
      "id", "name", "partner_shipping_id", "partner_invoice_id", "partner_id",
      "date_order", "amount_total", "state", "note", "client_order_ref",
      "carrier_id", "invoice_status", "picking_ids", "invoice_ids"
    ]],
    { limit: 1 }
  );

  if (!records?.length) throw new Error(`Sale Order not found for ref: ${ref}`);

  const so = records[0];
  const shipPartnerId = so.partner_shipping_id?.[0] || so.partner_id?.[0];
  const billPartnerId = so.partner_invoice_id?.[0] || so.partner_id?.[0];

  const shipPartner = await odooFetchPartner(uid, shipPartnerId);
  const billPartner = await odooFetchPartner(uid, billPartnerId);

  const lines = await odooExecute(
    uid,
    "sale.order.line",
    "search_read",
    [[ ["order_id", "=", so.id] ], ["name", "product_uom_qty", "product_id"]],
    { limit: 200 }
  );

  const paymentInfo = await odooGetPaymentStatus(uid, so.invoice_ids || []);

  return {
    id: so.id,
    ref: so.name,
    date_order: so.date_order,
    state: so.state,
    amount_total: so.amount_total,
    note: so.note || "",
    client_order_ref: so.client_order_ref || "",
    shipping_method: so.carrier_id?.[1] || "",
    invoice_status: so.invoice_status || "",
    payment_status: paymentInfo.payment_status,
    invoices: paymentInfo.invoices,
    picking_ids: so.picking_ids || [],
    ship_to: mapPartnerToAddress(shipPartner),
    bill_to: mapPartnerToAddress(billPartner),
    items: (lines || []).map(l => ({
      name: l.name,
      qty: l.product_uom_qty,
      product_id: l.product_id?.[0] || null,
      product_name: l.product_id?.[1] || ""
    }))
  };
}

// ===================== LABEL DRAFTS =====================
function makeDraftFromSaleOrder(saleOrder) {
  const ship = saleOrder.ship_to || {};
  const from = getDefaultFromAddress();

  return {
    sale_order_id: saleOrder.id,
    sale_order_ref: saleOrder.ref || String(saleOrder.id),
    ship_to: {
      name: ship.name || "",
      phone: ship.phone || "",
      email: ship.email || "",
      line1: ship.line1 || "",
      line2: ship.line2 || "",
      city: ship.city || "",
      state: ship.state || "",
      pin: ship.pin || "",
      country: ship.country || ""
    },
    from: {
      name: from.name || "",
      company: from.company || "",
      phone: from.phone || "",
      email: from.email || "",
      line1: from.line1 || "",
      line2: from.line2 || "",
      city: from.city || "",
      state: from.state || "",
      pin: from.pin || "",
      country: from.country || ""
    }
  };
}

function applyOverridesToDraft(draft, overrides) {
  if (!overrides || typeof overrides !== "object") return draft;
  return {
    ...draft,
    ship_to: { ...draft.ship_to, ...(overrides.ship_to || {}) },
    from: { ...draft.from, ...(overrides.from || {}) }
  };
}

function normalizeAddressBlock(addr) {
  const safe = (v) => (v && String(v).trim() ? String(v).trim() : "");
  return {
    name: safe(addr?.name),
    phone: safe(addr?.phone),
    email: safe(addr?.email),
    line1: safe(addr?.line1),
    line2: safe(addr?.line2),
    city: safe(addr?.city),
    state: safe(addr?.state),
    pin: safe(addr?.pin),
    country: safe(addr?.country)
  };
}

function joinAddressLines(a) {
  const parts = [
    a.line1,
    a.line2,
    [a.city, a.state, a.pin].filter(Boolean).join(", "),
    a.country
  ].filter(Boolean);
  return parts.join(", ");
}

// ===================== PDF LABEL GENERATION =====================
// Layout modes:
// - "AUTO" (grid): up to 4 labels per page (2x2). If 1 order => 1 label only (top-left).
// - "FULL": each label takes full A4 page.
async function buildMultiLabelPdfBuffer({ labels, layout = "AUTO" }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 0 });
      const chunks = [];
      doc.on("data", (d) => chunks.push(d));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      const pageW = doc.page.width;
      const pageH = doc.page.height;

      const safe = (v) => (v && String(v).trim() ? String(v).trim() : "");

      function drawDivider(x, y, w) {
        doc
          .moveTo(x, y)
          .lineTo(x + w, y)
          .lineWidth(1)
          .strokeColor("#d9d9d9")
          .stroke();
      }

      function drawSingleLabel(x, y, w, h, labelData) {
        const pad = 18;
        const left = x + pad;
        const contentW = w - pad * 2;

        // Border
        doc.rect(x, y, w, h).lineWidth(1).strokeColor("#000").stroke();

        const ship = normalizeAddressBlock(labelData.ship_to);
        const from = normalizeAddressBlock(labelData.from);

        const shipName = ship.name || "Recipient Name";
        const shipPhone = ship.phone || "Recipient Phone";
        const shipAddr = joinAddressLines(ship) || "Full Address (Address, City, State, Pincode)";

        const fromName = from.name || "Smart Handicrafts";
        const fromPhone = from.phone || "+91 XXXXX XXXXX";
        const fromAddr = joinAddressLines(from) || "Your Address";

        let cursorY = y + pad;

        const H = (t) => doc.font("Helvetica-Bold").fontSize(12).fillColor("#000").text(t, left, cursorY);
        const V = (t) => doc.font("Helvetica").fontSize(10).fillColor("#444").text(t, left, cursorY, { width: contentW });

        // SHIP TO
        H("SHIP TO:");
        cursorY += 16;
        V(shipName);
        cursorY += 12;
        drawDivider(left, cursorY, contentW);
        cursorY += 14;

        // ADDRESS
        H("ADDRESS:");
        cursorY += 16;
        V(shipAddr);
        cursorY += 40;
        drawDivider(left, cursorY, contentW);
        cursorY += 14;

        // PHONE
        H("PHONE:");
        cursorY += 16;
        V(shipPhone);
        cursorY += 12;
        drawDivider(left, cursorY, contentW);
        cursorY += 20;

        // FROM
        H("FROM:");
        cursorY += 16;
        V(fromName);
        cursorY += 12;
        drawDivider(left, cursorY, contentW);
        cursorY += 14;

        // FROM ADDRESS
        H("ADDRESS:");
        cursorY += 16;
        V(fromAddr);
        cursorY += 40;
        drawDivider(left, cursorY, contentW);
        cursorY += 14;

        // FROM PHONE
        H("PHONE:");
        cursorY += 16;
        V(fromPhone);

        // Footer SO ref
        const soText = `SO: ${safe(labelData.sale_order_ref || "")}`;
        doc.font("Helvetica").fontSize(8).fillColor("#444").text(soText, left, y + h - 14);
      }

      // FULL PAGE MODE
      if (String(layout).toUpperCase() === "FULL") {
        labels.forEach((lab, idx) => {
          if (idx > 0) doc.addPage();
          const margin = 24;
          drawSingleLabel(margin, margin, pageW - margin * 2, pageH - margin * 2, lab);
        });

        doc.end();
        return;
      }

      // AUTO GRID MODE (2x2) - but only place as many labels as provided
      const outerMargin = 24;
      const gap = 14;
      const cols = 2;
      const rows = 2;
      const labelW = (pageW - outerMargin * 2 - gap) / cols;
      const labelH = (pageH - outerMargin * 2 - gap) / rows;

      const positions = [
        { x: outerMargin, y: outerMargin },                               // 1: top-left
        { x: outerMargin + labelW + gap, y: outerMargin },                // 2: top-right
        { x: outerMargin, y: outerMargin + labelH + gap },                // 3: bottom-left
        { x: outerMargin + labelW + gap, y: outerMargin + labelH + gap }  // 4: bottom-right
      ];

      let i = 0;
      while (i < labels.length) {
        // new page after every 4 labels (except first page which already exists)
        if (i > 0 && i % 4 === 0) doc.addPage();

        const pageIndexStart = i;
        const chunk = labels.slice(pageIndexStart, pageIndexStart + 4);

        for (let p = 0; p < chunk.length; p++) {
          const pos = positions[p];
          drawSingleLabel(pos.x, pos.y, labelW, labelH, chunk[p]);
        }

        i += chunk.length;
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function createBatchLabelPdfRecord({ labels, layout }) {
  const pdfBuffer = await buildMultiLabelPdfBuffer({ labels, layout });

  const labelId = makeLabelId();
  const label_url = `/api/labels/${encodeURIComponent(labelId)}/pdf`;

  const record = {
    id: labelId,
    sale_order_id: labels.length === 1 ? labels[0].sale_order_id : null,
    sale_order_ref: labels.length === 1 ? labels[0].sale_order_ref : `BATCH-${labels.length}`,
    status: "created",
    carrier: layout === "FULL" ? "PDF-fullpage" : "PDF-grid",
    created_at: now(),
    pdfBuffer,
    label_url,
    meta: { batch: true, count: labels.length, layout }
  };

  labelsStore.set(labelId, record);

  return {
    id: record.id,
    status: record.status,
    carrier: record.carrier,
    created_at: record.created_at,
    label_url: record.label_url,
    meta: record.meta
  };
}

// ===================== AI STREAM (unchanged) =====================
const BASE_RULES = `
Rules:
- Do NOT invent facts.
- If unsure, say "UNCERTAIN".
- Be concise and logical.
- Follow required format strictly.
`;

const AGENT_A_SYSTEM = `
You are Agent A (Gemini). Start strong.

Format:
CLAIMS:
- ...
ASSUMPTIONS:
- ...
QUESTIONS:
1) ...
2) ...
PROPOSED CHANGES:
- ...
${BASE_RULES}
`;

const AGENT_B_SYSTEM = `
You are Agent B (OpenRouter). Challenge reasoning.

Format:
RESPONSE:
- ...
DISAGREEMENTS:
- ...
QUESTIONS:
1) ...
2) ...
PROPOSED CHANGES:
- ...
${BASE_RULES}
`;

const AGENT_C_SYSTEM = `
You are Agent C (OpenRouter). Focus on risks.

Format:
RESPONSE:
- ...
RISKS:
- ...
QUESTIONS:
1) ...
2) ...
PROPOSED CHANGES:
- ...
${BASE_RULES}
`;

const JUDGE_SYSTEM = `
You are the Judge (Gemini). Provide one final answer.

Format:
FINAL ANSWER:
...

AGREED POINTS:
- ...

UNCERTAIN OR CONFLICTING:
- ...
${BASE_RULES}
`;

async function callGemini(system, prompt, debateText) {
  if (!genAI) throw new Error("Gemini is not configured (missing GEMINI_API_KEY).");
  const fullPrompt =
    `${system}\n\nUSER PROMPT:\n${prompt}\n\n` +
    (debateText ? `DEBATE SO FAR:\n${debateText}` : "");

  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: fullPrompt
  });

  return response.text?.trim() || "";
}

async function callOpenRouter(system, prompt, debateText, modelName) {
  if (!OPENROUTER_API_KEY) throw new Error("OpenRouter not configured (missing OPENROUTER_API_KEY).");

  const fallbacks = [
    modelName,
    "google/gemma-2-9b-it",
    "meta-llama/llama-3.1-8b-instruct",
    "meta-llama/llama-3-8b-instruct"
  ];

  let lastErr = null;

  for (const m of fallbacks) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "http://localhost",
          "X-Title": "AI Agent Debate"
        },
        body: JSON.stringify({
          model: m,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content:
                `USER PROMPT:\n${prompt}\n\n` +
                (debateText ? `DEBATE SO FAR:\n${debateText}` : "")
            }
          ],
          temperature: 0.4
        })
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(err);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content?.trim() || "";
      if (!text) throw new Error("Empty response from provider");
      return text;
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(`OpenRouter Error (all models failed): ${String(lastErr?.message || lastErr)}`);
}

function historyToText(history) {
  return history.map((m) => `${m.agent}:\n${m.content}`).join("\n\n---\n\n");
}

app.post("/api/debate-stream", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const { prompt, rounds = 1, showDebate = true } = req.body || {};
    if (!prompt) {
      send({ type: "error", message: "Missing prompt", time: now() });
      return res.end();
    }

    const agents = [
      { name: "Gemini", type: "gemini", system: AGENT_A_SYSTEM },
      { name: "Llama", type: "openrouter", system: AGENT_B_SYSTEM, model: LLAMA_MODEL },
      { name: "Gemma", type: "openrouter", system: AGENT_C_SYSTEM, model: AGENT_C_MODEL }
    ];

    send({ type: "meta", time: now(), agents: agents.map(a => a.name), rounds });

    const history = [{ agent: "User", content: prompt }];
    const totalTurns = Math.max(1, Number(rounds)) * agents.length;

    for (let i = 0; i < totalTurns; i++) {
      const agent = agents[i % agents.length];
      const debateText = historyToText(history);

      send({ type: "status", message: `Thinking... ${agent.name}`, time: now() });

      let reply = "";
      if (agent.type === "gemini") {
        reply = await callGemini(agent.system, prompt, debateText);
      } else {
        reply = await callOpenRouter(agent.system, prompt, debateText, agent.model);
      }

      history.push({ agent: agent.name, content: reply });

      if (showDebate) send({ type: "turn", agent: agent.name, content: reply, time: now() });
    }

    send({ type: "status", message: "Judge finalizing...", time: now() });
    const finalAnswer = await callGemini(JUDGE_SYSTEM, prompt, historyToText(history));

    send({ type: "final", content: finalAnswer, time: now() });
    send({ type: "done", time: now() });
    res.end();
  } catch (err) {
    res.write(JSON.stringify({ type: "error", message: err.message, time: now() }) + "\n");
    res.end();
  }
});

async function odooFetchReportPdf(reportName, docId) {
  if (!odooConfigured) throw new Error("Odoo not configured on server env.");

  const base = ODOO_URL.replace(/\/$/, "");

  // 1. Authenticate via web session to get the session_id cookie
  // (We must use HTTP authentication because Odoo blocks private methods 
  // like '_render_qweb_pdf' from being called via external JSON-RPC).
  const authResp = await fetch(`${base}/web/session/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: {
        db: ODOO_DB,
        login: ODOO_USERNAME,
        password: ODOO_PASS
      }
    })
  });

  const authData = await authResp.json();
  if (authData.error) {
    throw new Error(`Odoo session auth error: ${authData.error.message || authData.error.data?.message}`);
  }

  // 2. Extract the session_id cookie from the response headers
  const cookies = authResp.headers.get("set-cookie") || "";
  const sessionMatch = cookies.match(/session_id=([^;]+)/);
  if (!sessionMatch) {
    throw new Error("Failed to extract session_id cookie from Odoo authentication.");
  }
  const sessionId = sessionMatch[1];

  // 3. Download the PDF using the standard HTTP report endpoint
  const pdfResp = await fetch(`${base}/report/pdf/${reportName}/${docId}`, {
    method: "GET",
    headers: {
      "Cookie": `session_id=${sessionId}`,
      "User-Agent": "NodeJS/Odoo-Client"
    }
  });

  if (!pdfResp.ok) {
    throw new Error(`Failed to generate PDF (${reportName}): HTTP ${pdfResp.status} ${pdfResp.statusText}`);
  }

  // 4. Convert response to Buffer to serve to the client
  const arrayBuffer = await pdfResp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function odooGetPickingsBySaleOrderId(soId) {
  const uid = await odooLogin();
  return await odooExecute(
    uid,
    "stock.picking",
    "search_read",
    [[ ["sale_id", "=", soId] ], ["id", "name", "state", "scheduled_date", "carrier_id"]],
    { limit: 100, order: "id desc" }
  );
}

async function odooSearchOrders({ query = "", state = "", limit = 50 }) {
  const uid = await odooLogin();
  const domain = [];
  if (state) domain.push(["state", "=", state]);
  if (query) {
    domain.push("|");
    domain.push("|");
    domain.push(["name", "ilike", query]);
    domain.push(["client_order_ref", "ilike", query]);
    domain.push(["partner_id.name", "ilike", query]);
  }

  const orders = await odooExecute(
    uid,
    "sale.order",
    "search_read",
    [domain, ["id", "name", "date_order", "amount_total", "state", "partner_id", "invoice_status"]],
    { limit: Math.min(Number(limit) || 50, 100), order: "id desc" }
  );

  return orders || [];
}

// ===================== LABEL ROUTES =====================

// Fetch SO (single)
app.get("/api/odoo/sale-order", async (req, res) => {
  try {
    const ref = String(req.query.ref || "").trim();
    if (!ref) return res.status(400).json({ error: "Missing ref" });
    if (!odooConfigured) {
      return res.status(400).json({
        error: "Odoo not configured. Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY_OR_PASSWORD."
      });
    }

    const so = await odooGetSaleOrderByRef(ref);

    if (!labelDraftsBySO.has(so.id)) {
      labelDraftsBySO.set(so.id, makeDraftFromSaleOrder(so));
    }

    return res.json(so);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Get label draft for editing (single SO)
app.get("/api/labels/draft", async (req, res) => {
  try {
    const soId = Number(req.query.sale_order_id);
    if (!soId) return res.status(400).json({ error: "Missing sale_order_id" });
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured" });

    const existing = labelDraftsBySO.get(soId);
    if (existing) return res.json(existing);

    const uid = await odooLogin();
    const recs = await odooExecute(uid, "sale.order", "read", [[soId], ["id","name"]]);
    if (!recs?.length) throw new Error("Sale Order not found by id");

    const saleOrder = await odooGetSaleOrderByRef(recs[0].name);

    const draft = makeDraftFromSaleOrder(saleOrder);
    labelDraftsBySO.set(soId, draft);
    return res.json(draft);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// List labels
app.get("/api/labels", async (req, res) => {
  const sale_order_id = req.query.sale_order_id ? String(req.query.sale_order_id) : null;

  const all = Array.from(labelsStore.values())
    .filter(l => !sale_order_id || String(l.sale_order_id) === sale_order_id)
    .map(l => ({
      id: l.id,
      sale_order_id: l.sale_order_id,
      sale_order_ref: l.sale_order_ref,
      status: l.status,
      carrier: l.carrier,
      created_at: l.created_at,
      label_url: l.label_url,
      meta: l.meta
    }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  res.json(all);
});

// Generate label (single SO) => creates 1 label (NOT 4 copies)
app.post("/api/labels/generate", async (req, res) => {
  try {
    const { sale_order_id, overrides, layout } = req.body || {};
    if (!sale_order_id) return res.status(400).json({ error: "Provide sale_order_id" });
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured on server env." });

    const uid = await odooLogin();
    const recs = await odooExecute(uid, "sale.order", "read", [[Number(sale_order_id)], ["id","name"]]);
    if (!recs?.length) throw new Error("Sale Order not found by id");

    const saleOrder = await odooGetSaleOrderByRef(recs[0].name);

    let draft = labelDraftsBySO.get(Number(sale_order_id)) || makeDraftFromSaleOrder(saleOrder);
    draft = applyOverridesToDraft(draft, overrides);
    labelDraftsBySO.set(Number(sale_order_id), draft);

    const labelData = {
      sale_order_id: saleOrder.id,
      sale_order_ref: saleOrder.ref,
      ship_to: { ...(saleOrder.ship_to || {}), ...(draft.ship_to || {}) },
      from: { ...(draft.from || getDefaultFromAddress()) }
    };

    const result = await createBatchLabelPdfRecord({
      labels: [labelData],
      layout: String(layout || "AUTO").toUpperCase() === "FULL" ? "FULL" : "AUTO"
    });

    return res.json({ ok: true, ...result, draft });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ✅ NEW: Batch generate (multiple SO refs / ids)
// layout: "AUTO" (grid up to 4/page) or "FULL" (one per page)
app.post("/api/labels/generate-batch", async (req, res) => {
  try {
    const { orders, layout } = req.body || {};
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: "Provide orders: [{ref:'S0001'}...]" });
    }
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured on server env." });

    const mode = String(layout || "AUTO").toUpperCase() === "FULL" ? "FULL" : "AUTO";

    // Fetch each SO and apply saved draft edits if any
    const labels = [];
    for (const o of orders) {
      const ref = String(o?.ref || "").trim();
      const sale_order_id = o?.sale_order_id ? Number(o.sale_order_id) : null;

      let saleOrder;
      if (ref) {
        saleOrder = await odooGetSaleOrderByRef(ref);
      } else if (sale_order_id) {
        const uid = await odooLogin();
        const recs = await odooExecute(uid, "sale.order", "read", [[sale_order_id], ["id","name"]]);
        if (!recs?.length) throw new Error(`Sale Order not found by id: ${sale_order_id}`);
        saleOrder = await odooGetSaleOrderByRef(recs[0].name);
      } else {
        throw new Error("Each order must include ref or sale_order_id");
      }

      let draft = labelDraftsBySO.get(Number(saleOrder.id)) || makeDraftFromSaleOrder(saleOrder);
      // allow per-order overrides from request too:
      draft = applyOverridesToDraft(draft, o?.overrides);
      labelDraftsBySO.set(Number(saleOrder.id), draft);

      labels.push({
        sale_order_id: saleOrder.id,
        sale_order_ref: saleOrder.ref,
        ship_to: { ...(saleOrder.ship_to || {}), ...(draft.ship_to || {}) },
        from: { ...(draft.from || getDefaultFromAddress()) }
      });
    }

    const result = await createBatchLabelPdfRecord({ labels, layout: mode });
    return res.json({ ok: true, ...result, count: labels.length, layout: mode });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Serve PDF
app.get("/api/labels/:id/pdf", async (req, res) => {
  const id = req.params.id;
  const record = labelsStore.get(id);
  if (!record) return res.status(404).send("Label not found (service may have restarted).");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${id}.pdf"`);
  res.send(record.pdfBuffer);
});

const processedWebhookEvents = new Map();

async function handleSaleConfirmed(req, res) {
  try {
    const secret = process.env.ODOO_WEBHOOK_SECRET;
    if (secret) {
      const got = req.headers["x-odoo-secret"];
      if (got !== secret) return res.status(401).json({ error: "Unauthorized" });
    }

    const { sale_order_ref, sale_order_id, big_box, event_id } = req.body || {};
    const ref = sale_order_ref ? String(sale_order_ref) : null;
    const id = sale_order_id ? Number(sale_order_id) : null;
    if (!ref && !id) return res.status(400).json({ error: "Provide sale_order_ref or sale_order_id" });

    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured on server env." });

    const dedupeKey = String(event_id || `${ref || id}:sale_confirmed`);
    if (processedWebhookEvents.has(dedupeKey)) {
      return res.json({ ok: true, already_processed: true, ...processedWebhookEvents.get(dedupeKey) });
    }

    let saleOrder;
    if (ref) {
      saleOrder = await odooGetSaleOrderByRef(ref);
    } else {
      const uid = await odooLogin();
      const recs = await odooExecute(uid, "sale.order", "read", [[id], ["name"]]);
      if (!recs?.length) throw new Error("Sale Order not found");
      saleOrder = await odooGetSaleOrderByRef(recs[0].name);
    }

    if (!labelDraftsBySO.has(saleOrder.id)) {
      labelDraftsBySO.set(saleOrder.id, makeDraftFromSaleOrder(saleOrder));
    }
    const draft = labelDraftsBySO.get(saleOrder.id);

    const labelData = {
      sale_order_id: saleOrder.id,
      sale_order_ref: saleOrder.ref,
      ship_to: { ...(saleOrder.ship_to || {}), ...(draft.ship_to || {}) },
      from: { ...(draft.from || getDefaultFromAddress()) }
    };

    const result = await createBatchLabelPdfRecord({
      labels: [labelData],
      layout: big_box ? "FULL" : "AUTO"
    });

    const out = { ...result, sale_order_id: saleOrder.id, sale_order_ref: saleOrder.ref, already_processed: false };
    processedWebhookEvents.set(dedupeKey, out);

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

app.post("/api/odoo/sale-confirmed", handleSaleConfirmed);
app.post("/api/odoo/webhook/sale-confirmed", handleSaleConfirmed);

app.get("/api/odoo/sale-order/:id/pickings", async (req, res) => {
  try {
    const soId = Number(req.params.id);
    if (!soId) return res.status(400).json({ error: "Invalid sale order id" });
    const pickings = await odooGetPickingsBySaleOrderId(soId);
    return res.json({ ok: true, pickings });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/odoo/picking/:id/validate", async (req, res) => {
  try {
    const pickingId = Number(req.params.id);
    if (!pickingId) return res.status(400).json({ error: "Invalid picking id" });
    const uid = await odooLogin();
    await odooExecute(uid, "stock.picking", "button_validate", [[pickingId]]);
    return res.json({ ok: true, message: "Picking validated" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/odoo/sale-order/:id/fulfillment", async (req, res) => {
  try {
    const soId = Number(req.params.id);
    if (!soId) return res.status(400).json({ error: "Invalid sale order id" });

    const uid = await odooLogin();
    const lineItems = await odooExecute(
      uid,
      "sale.order.line",
      "search_read",
      [[ ["order_id", "=", soId] ], ["id", "name", "product_id", "product_uom_qty"]],
      { limit: 200 }
    );

    const productIds = Array.from(new Set((lineItems || []).map((l) => l.product_id?.[0]).filter(Boolean)));
    let productMap = new Map();
    if (productIds.length) {
      const products = await odooExecute(
        uid,
        "product.product",
        "read",
        [productIds, ["id", "display_name", "qty_available", "virtual_available"]]
      );
      productMap = new Map((products || []).map((p) => [p.id, p]));
    }

    const rows = (lineItems || []).map((l) => {
      const pid = l.product_id?.[0] || null;
      const p = productMap.get(pid) || {};
      const ordered = Number(l.product_uom_qty || 0);
      const onHand = Number(p.qty_available || 0);
      const forecast = Number(p.virtual_available || 0);
      return {
        line_id: l.id,
        product_id: pid,
        product_name: p.display_name || l.product_id?.[1] || l.name,
        ordered_qty: ordered,
        on_hand_qty: onHand,
        forecast_qty: forecast,
        backorder_warning: onHand < ordered
      };
    });

    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/odoo/sale-order/:id/invoice-pdf", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pdf = await odooFetchReportPdf("account.report_invoice", id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="SO-${id}-invoice.pdf"`);
    return res.send(pdf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/odoo/sale-order/:id/packing-slip-pdf", async (req, res) => {
  try {
    const soId = Number(req.params.id);

    // 1. Fetch the Delivery Orders (stock.picking) linked to this Sale Order
    const pickings = await odooGetPickingsBySaleOrderId(soId);
    
    if (!pickings || pickings.length === 0) {
      return res.status(404).json({ error: "No delivery slips (pickings) found for this Sale Order." });
    }

    // 2. Grab the ID of the latest delivery order
    // (odooGetPickingsBySaleOrderId already sorts them by 'id desc')
    const pickingId = pickings[0].id;

    // 3. Fetch the PDF using the PICKING ID and the correct Odoo 19 report name
    const pdf = await odooFetchReportPdf("stock.report_deliveryslip", pickingId);
    
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="SO-${soId}-packing-slip.pdf"`);
    return res.send(pdf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/odoo/sale-order/:id/proforma-pdf", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pdf = await odooFetchReportPdf("sale.report_saleorder", id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="SO-${id}-proforma.pdf"`);
    return res.send(pdf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/odoo/ship-from-options", async (req, res) => {
  try {
    const uid = await odooLogin();
    const warehouses = await odooExecute(
      uid,
      "stock.warehouse",
      "search_read",
      [[], ["id", "name", "partner_id"]],
      { limit: 100 }
    );

    const partnerIds = Array.from(new Set((warehouses || []).map((w) => w.partner_id?.[0]).filter(Boolean)));
    let partners = [];
    if (partnerIds.length) {
      partners = await odooExecute(uid, "res.partner", "read", [partnerIds, ["id", "name", "phone", "email", "street", "street2", "city", "state_id", "zip", "country_id"]]);
    }
    const map = new Map((partners || []).map((p) => [p.id, p]));

    const options = (warehouses || []).map((w) => {
      const p = map.get(w.partner_id?.[0]) || {};
      return {
        id: w.id,
        label: `${w.name}${p.city ? ` - ${p.city}` : ""}`,
        from: mapPartnerToAddress(p)
      };
    });

    return res.json({ ok: true, options, fallback: getDefaultFromAddress() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/odoo/orders", async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();
    const state = String(req.query.state || "").trim();
    const limit = Number(req.query.limit || 50);

    const rows = await odooSearchOrders({ query, state, limit });
    const normalized = rows.map((r) => ({
      id: r.id,
      ref: r.name,
      date_order: r.date_order,
      amount_total: r.amount_total,
      state: r.state,
      customer: r.partner_id?.[1] || "",
      invoice_status: r.invoice_status || ""
    }));

    return res.json({ ok: true, rows: normalized });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true, time: now(), odooConfigured }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
