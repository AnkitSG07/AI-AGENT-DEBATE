import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import PDFDocument from "pdfkit";
import { readFile } from "node:fs/promises";

dotenv.config();

const app = express();

// ===================== CORS FOR ODOO / SMART HANDICRAFTS =====================
// Required because the Odoo website runs on a different domain than Render.
const allowedOrigins = [
  "https://www.smarthandicrafts.com",
  "https://smarthandicrafts.com",
  "https://vaidahi-kala-pvt-ltd.odoo.com"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "8mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const profilePasswords = {
  "Smart handicrafts": process.env.PROFILE_PASS_SMART_HANDICRAFTS || "",
  Accounts: process.env.PROFILE_PASS_ACCOUNTS || "",
  SUDO: process.env.PROFILE_PASS_SUDO || ""
};
const PROFILE_SESSION_COOKIE = "profile_session";
const PROFILE_SESSION_TTL_SECONDS = 2 * 60 * 60;

function now() {
  return new Date().toISOString();
}

function parseCookies(req) {
  const raw = req.headers?.cookie || "";
  if (!raw) return {};
  return raw.split(";").reduce((acc, piece) => {
    const [k, ...rest] = piece.trim().split("=");
    if (!k) return acc;
    acc[k] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}

function buildSessionCookie(profile) {
  const payload = JSON.stringify({ profile, exp: Date.now() + PROFILE_SESSION_TTL_SECONDS * 1000 });
  const encoded = Buffer.from(payload).toString("base64url");
  return `${PROFILE_SESSION_COOKIE}=${encoded}; Max-Age=${PROFILE_SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax`;
}

function readProfileSession(req) {
  try {
    const cookies = parseCookies(req);
    const token = cookies[PROFILE_SESSION_COOKIE];
    if (!token) return null;

    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    const profile = String(parsed?.profile || "");
    const exp = Number(parsed?.exp || 0);
    if (!profile || !Object.prototype.hasOwnProperty.call(profilePasswords, profile)) return null;
    if (!Number.isFinite(exp) || Date.now() >= exp) return null;
    return { profile, exp };
  } catch {
    return null;
  }
}

// ===================== AI CONFIG =====================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const genAI = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const GEMINI_MODEL = "gemini-2.5-flash";
const LLAMA_MODEL = process.env.OR_MODEL_LLAMA || "meta-llama/llama-3.1-8b-instruct";
const AGENT_C_MODEL = process.env.OR_MODEL_GEMMA || process.env.OR_MODEL_MISTRAL || "google/gemma-3-4b-it";
const PRODUCT_BOT_OR_MODEL = process.env.OR_MODEL_PRODUCT_BOT || process.env.OR_MODEL_GEMMA || AGENT_C_MODEL;
const AGENT_A_OR_MODEL = process.env.OR_MODEL_AGENT_A || process.env.OR_MODEL_DEBATE_GEMINI || PRODUCT_BOT_OR_MODEL;
const JUDGE_OR_MODEL = process.env.OR_MODEL_JUDGE || process.env.OR_MODEL_DEBATE_JUDGE || PRODUCT_BOT_OR_MODEL;

const PRODUCT_KNOWLEDGE_PATH = process.env.PRODUCT_KNOWLEDGE_PATH || "./product-knowledge.md";
const PRODUCT_BOT_FALLBACK_CONTEXT = process.env.PRODUCT_BOT_CONTEXT || "";

// Dedicated Smart Handicrafts physical integration knowledge for the Kit Expert.
// Keep this separate from general product knowledge so the AI only receives it
// when a customer is asking about lamp structure, placement, assembly, or fitting.
const KIT_INTEGRATION_KNOWLEDGE_PATH =
  process.env.KIT_INTEGRATION_KNOWLEDGE_PATH ||
  "./smart-handicrafts-integration-master-knowledge.txt";
const KIT_INTEGRATION_FALLBACK_CONTEXT =
  process.env.KIT_INTEGRATION_KNOWLEDGE_CONTEXT || "";

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
let weeklyReportTimer = null;

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

// ===================== ODOO UID CACHE =====================
// Caches the Odoo UID for 20 minutes so we don't do a fresh login on every bot message
const odooUidCache = { uid: null, expiresAt: 0 };

async function odooLogin() {
  const uid = await odooJsonRpc("common", "login", [ODOO_DB, ODOO_USERNAME, ODOO_PASS]);
  if (!uid) throw new Error("Odoo login failed. Check DB/username/api key.");
  return uid;
}

async function odooLoginCached() {
  if (odooUidCache.uid && Date.now() < odooUidCache.expiresAt) return odooUidCache.uid;
  const uid = await odooLogin();
  odooUidCache.uid = uid;
  odooUidCache.expiresAt = Date.now() + 20 * 60 * 1000; // 20 min TTL
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

async function odooFindOrCreatePartner(uid, companyName) {
  const name = String(companyName || "").trim();
  if (!name) throw new Error("Company name is required to create quotation.");

  const existing = await odooExecute(
    uid,
    "res.partner",
    "search_read",
    [[["name", "ilike", name]], ["id", "name"]],
    { limit: 1, order: "id desc" }
  );
  if (existing?.[0]?.id) return existing[0];

  const partnerId = await odooExecute(uid, "res.partner", "create", [{ name, company_type: "company" }]);
  const created = await odooExecute(uid, "res.partner", "read", [[partnerId], ["id", "name"]]);
  return created?.[0] || { id: partnerId, name };
}

async function odooFindProductBySku(uid, sku) {
  const code = String(sku || "").trim();
  if (!code) return null;
  const rows = await odooExecute(
    uid,
    "product.product",
    "search_read",
    [[["default_code", "=", code]], ["id", "display_name", "default_code", "lst_price"]],
    { limit: 1 }
  );
  return rows?.[0] || null;
}

async function odooCreateQuotation(uid, { company_name, sku, qty, price_unit = null }) {
  const safeQty = Number(qty);
  if (!company_name) throw new Error("Missing company_name");
  if (!sku) throw new Error("Missing sku");
  if (!Number.isFinite(safeQty) || safeQty <= 0) throw new Error("Missing qty");

  const partner = await odooFindOrCreatePartner(uid, company_name);
  const product = await odooFindProductBySku(uid, sku);
  if (!product?.id) {
    return {
      ok: false,
      reason: "sku_not_found",
      message: `SKU ${sku} was not found in Odoo products (default_code).`
    };
  }

  const saleOrderId = await odooExecute(uid, "sale.order", "create", [{ partner_id: partner.id }]);
  const linePayload = {
    order_id: saleOrderId,
    product_id: product.id,
    product_uom_qty: safeQty
  };
  if (Number.isFinite(Number(price_unit)) && Number(price_unit) > 0) {
    linePayload.price_unit = Number(price_unit);
  }

  await odooExecute(uid, "sale.order.line", "create", [linePayload]);

  const so = await odooExecute(uid, "sale.order", "read", [[saleOrderId], ["id", "name", "amount_total", "currency_id", "partner_id"]]);
  const lines = await odooExecute(
    uid,
    "sale.order.line",
    "search_read",
    [[["order_id", "=", saleOrderId], ["product_id", "=", product.id]], ["id", "price_unit", "price_subtotal", "product_uom_qty"]],
    { limit: 1, order: "id desc" }
  );

  const order = so?.[0] || {};
  const line = lines?.[0] || {};
  return {
    ok: true,
    quotation_id: saleOrderId,
    quotation_name: order.name || `SO#${saleOrderId}`,
    partner_name: Array.isArray(order.partner_id) ? order.partner_id[1] : partner.name,
    sku: product.default_code || sku,
    product_name: product.display_name,
    qty: Number(line.product_uom_qty || safeQty),
    unit_price: Number(line.price_unit || 0),
    subtotal: Number(line.price_subtotal || 0),
    total: Number(order.amount_total || 0),
    currency: Array.isArray(order.currency_id) ? order.currency_id[1] : ""
  };
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

async function callGeminiWithFallback(system, prompt, debateText, openRouterModel) {
  let geminiError = null;

  if (genAI) {
    try {
      const text = await callGemini(system, prompt, debateText);
      return {
        text,
        provider: "gemini",
        model_used: GEMINI_MODEL,
        fallback_from: null
      };
    } catch (e) {
      geminiError = e;
      if (!OPENROUTER_API_KEY || !isRateLimitOrQuotaError(e)) throw e;
    }
  }

  if (!OPENROUTER_API_KEY) {
    throw geminiError || new Error("No LLM provider configured.");
  }

  const openRouterResult = await callOpenRouterWithMeta(system, prompt, debateText, openRouterModel || PRODUCT_BOT_OR_MODEL);
  return {
    text: openRouterResult.text,
    provider: "openrouter",
    model_used: openRouterResult.model_used,
    fallback_from: geminiError ? GEMINI_MODEL : null
  };
}

async function callOpenRouterWithMeta(system, prompt, debateText, modelName) {
  if (!OPENROUTER_API_KEY) throw new Error("OpenRouter not configured (missing OPENROUTER_API_KEY).");

  const fallbacks = [
    modelName,
    "google/gemma-3-1b-it",
    "google/gemma-3-4b-it",
    "google/gemma-3-12b-it",
    "google/gemma-3-27b-it"
  ].filter((m, index, arr) => m && arr.indexOf(m) === index);

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
      return { text, model_used: m };
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(`OpenRouter Error (all models failed): ${String(lastErr?.message || lastErr)}`);
}

async function callOpenRouter(system, prompt, debateText, modelName) {
  const result = await callOpenRouterWithMeta(system, prompt, debateText, modelName);
  return result.text;
}

function isRateLimitOrQuotaError(err) {
  const text = String(err?.message || err || "").toLowerCase();
  return text.includes("429") || text.includes("rate limit") || text.includes("quota") || text.includes("resource_exhausted");
}

async function callProductBotModel(system, prompt) {
  return await callGeminiWithFallback(system, prompt, "", PRODUCT_BOT_OR_MODEL);
}

function historyToText(history) {
  return history.map((m) => `${m.agent}:\n${m.content}`).join("\n\n---\n\n");
}

const PRODUCT_BOT_MODES = {
  simple_chatbot: {
    label: "Simple website chatbot",
    system: `You are a concise website support chatbot for SmartHandicrafts.
Use only retrieved knowledge snippets.
If the answer is missing, say you are not sure and ask the user to contact support.`
  },
  b2b_sales_assistant: {
    label: "Advanced B2B sales assistant",
    system: `You are a B2B sales assistant for SmartHandicrafts.
Prioritize qualification, use-case mapping, integration fit, packaging, pricing guidance from knowledge,
and end with a clear suggested next step (demo, pilot, quote, or technical call).
Do not invent discounts or contractual terms.
Do not ask for data that is already present in the user's latest message or chat history.`
  },
  compliance_assistant: {
    label: "Export-grade compliance assistant",
    system: `You are a compliance assistant for export and operational documentation.
Use only the provided company policies and compliance snippets.
For legal or regulatory uncertainty, explicitly recommend validation with a compliance officer.
Never present guesses as legal advice.`
  },
  sales_automation: {
    label: "Full AI sales automation system",
    system: `You are an AI sales automation copilot.
Provide structured outputs for workflow automation: lead stage, qualification summary, next actions,
required integrations, and CRM/ERP handoff notes based only on retrieved context.`
  },
  odoo_operations: {
    label: "Odoo operations assistant",
    system: `You are an ERP operations assistant for Odoo workflows covering invoices, customers, quotations, and sales orders.`

  }
};

// ─── QUERY EXPANSION ─────────────────────────────────────────────────────────
// Enriches short/vague queries before retrieval so single-word inputs like
// "201", "batteries", "strip" get proper context for chunk matching.
const QUERY_EXPANSION_RULES = [
  // Specific SKU numbers
  { pattern: /\b201\b(?!-\d)/, expand: "AS-B-201-SLD rechargeable 1 colour single LED driver COB touch dimmable price INR" },
  { pattern: /\b202\b(?!-\d)/, expand: "AS-B-202-DLD rechargeable 3 colour dual LED driver COB touch dimmable price INR" },
  { pattern: /\b204\b/, expand: "AS-B-204-LSD LED strip dimmer rechargeable driver 12V 24V price" },
  { pattern: /\b205\b/, expand: "AS-B-205-LSD LED strip fast charging rechargeable driver 12V 24V price" },
  { pattern: /\b206\b/, expand: "AS-B-206 DOB driver on board 3 colour rechargeable LED 75mm 115mm 55mm" },
  { pattern: /\bu[-.]?101\b/i, expand: "AS-U-101-SLD USB powered single 1 colour LED driver price" },
  { pattern: /\bu[-.]?102\b/i, expand: "AS-U-102-DLD USB powered 3 colour dual LED driver price" },
  { pattern: /\bu[-.]?103\b/i, expand: "AS-U-103-LSD USB strip driver 12V 24V price" },
  { pattern: /\b(as.?b.?201|201.?sld)\b/i, expand: "AS-B-201-SLD rechargeable single colour driver price" },
  { pattern: /\b(as.?b.?202|202.?dld)\b/i, expand: "AS-B-202-DLD rechargeable 3 colour driver price" },
  // Product categories
  { pattern: /\bbatter(y|ies)\b/i, expand: "18650 Li-ion battery 1200mAh 2600mAh 5200mAh price specification SH-BAT" },
  { pattern: /\bstrip\b/i, expand: "COB LED strip 12V 24V warm white CCT RGB RGBCCT price per meter 3mm 5mm 8mm 10mm" },
  { pattern: /\b(single\s+)?cob\b/i, expand: "LED COB 3W 5W 0.5W 2W single colour 3V price SH-COB" },
  { pattern: /\bdual\s*(cob|led)\b/i, expand: "dual LED COB 3W 5W 2700K 5700K CCT price SH-COB-D" },
  { pattern: /\b(switch|rocker|push\s*button)\b/i, expand: "push button rocker switch SPST price SH-SWT" },
  { pattern: /\b(touch|dimm(er|able))\b/i, expand: "touch dimmable driver rechargeable USB single dual colour dimming" },
  { pattern: /\b(cable|usb\s*cable)\b/i, expand: "USB cable Type-A Type-C 1.2m CE UL white braided price" },
  { pattern: /\b(connector|panel\s*mount)\b/i, expand: "USB-C panel mount connector indicator black white transparent price" },
  { pattern: /\bfilament\b/i, expand: "flexible filament LED 190mm 300mm 460mm 600mm 3V 12V 24V 2700K price" },
  { pattern: /\bflame\s*(led)?\b/i, expand: "flame LED decorative 5V 1300K 2 inch 3 inch price per meter" },
  { pattern: /\bfairy\s*(light)?\b/i, expand: "fairy lights silver copper wire warm white multicolour price per meter" },
  { pattern: /\b(jst\s*)?wire\b/i, expand: "JST wire UL certified touch sensor connector 6 inch custom length" },
  { pattern: /\blens\b/i, expand: "LED lens clear frosted PC 35mm COB compatible 3W 5W" },
  { pattern: /\benclosur/i, expand: "plastic metal enclosure USB-C panel mount 19mm 16mm" },
  { pattern: /\bholder\b/i, expand: "LED holder glass stone shade ring battery holder 18650 3xAA 3xAAA" },
  { pattern: /\bdob\b/i, expand: "DOB driver on board LED rechargeable 3 colour 206 55mm 75mm 115mm price" },
  { pattern: /\brechargeable\b/i, expand: "rechargeable LED driver 201 202 204 205 206 touch dimmable INR price" },
  { pattern: /\busb\s*(powered|driver)?\b/i, expand: "USB powered LED driver 101 102 103 USB-C touch dimmable price" },
  { pattern: /\blc\s*(set|series)?\b/i, expand: "LC set bundle driver LED battery connector 201 202 cost-optimized 2000+ price" },
  // Intent expansions
  { pattern: /^(price|pricing|cost|rate)\??$/i, expand: "pricing tiers INR MOQ sample 60 100 500 1000 LED driver battery strip" },
  { pattern: /^moq\??$/i, expand: "minimum order quantity pricing tiers sample 60+ 100+ 500+ 1000+" },
  { pattern: /^(compare|vs|difference)\??$/i, expand: "comparison rechargeable vs USB driver single vs dual colour COB" },
  { pattern: /^(hello|hi|hey|hiya)\b/i, expand: "SmartHandicrafts overview LED driver product categories" },
  { pattern: /^(help|assist)\??$/i, expand: "product overview LED driver battery strip accessories guide" },
  { pattern: /\bpair(ing|ed|s)?\b/i, expand: "compatible pairing LED COB driver battery bundle recommended" },
  { pattern: /\bbundle\b/i, expand: "LC set bundle driver LED battery connector cost-optimized" },
  { pattern: /\brecommend\b/i, expand: "recommended LED driver COB battery bundle use-case selection guide" },
  { pattern: /\bcompar/i, expand: "comparison rechargeable USB driver single dual colour COB strip DOB" },
  // Compliance
  { pattern: /\bce\s*(cert|standard)?\b/i, expand: "CE certification compliance standard LED driver strip certificate" },
  { pattern: /\bul\s*(cert|listed)?\b/i, expand: "UL certification compliance LED driver strip battery certificate" },
  { pattern: /\brohs\b/i, expand: "RoHS compliance LED module strip driver certificate" },
  { pattern: /\bexport\b/i, expand: "export compliance CE UKCA UL RoHS certification HS code incoterm" },
  { pattern: /\bhs\s*(code)?\b/i, expand: "HS code export customs compliance LED driver" },
  { pattern: /\bcertif/i, expand: "certification CE UKCA UL RoHS BIS IEC certificate document" },
  // Company info
  { pattern: /\bcompany\b|\babout\b|\bwho\s+are/i, expand: "Smart Handicrafts company overview mission B2B LED technology artisan exporter" },
  { pattern: /\bcontact\b|\baddress\b|\bemail\b/i, expand: "Smart Handicrafts contact email phone address New Delhi" },
  { pattern: /\bshipp(ing|ed)\b/i, expand: "shipping policy dispatch export battery courier lead time" },
  { pattern: /\bwarrant/i, expand: "warranty SLA technical support response time" },
  { pattern: /\breturn(s)?\b/i, expand: "returns policy defect wrong item custom order" },
  // Quantity/wattage patterns
  { pattern: /\b(0\.?5|half)\s*w(att)?\b/i, expand: "0.5W LED COB 3V SH-COB-0.5W price" },
  { pattern: /\b2\s*w(att)?\b/i, expand: "2W LED COB 20mm 35mm 3V price SH-COB-2W" },
  { pattern: /\b3\s*w(att)?\b/i, expand: "3W LED COB 3V 12V single dual CREE price SH-COB-3W" },
  { pattern: /\b5\s*w(att)?\b/i, expand: "5W LED COB 3V 24V single dual CREE price SH-COB-5W" },
  { pattern: /\b7\s*w(att)?\b/i, expand: "7W DOB driver on board 3 colour dual 3.5W+3.5W" },
  { pattern: /\b(12|24)\s*v\b/i, expand: "12V 24V LED COB strip driver rechargeable USB" },
  { pattern: /\b(warm\s*white|ww|2700|3000)\b/i, expand: "warm white 2700K 3000K LED COB strip filament" },
  { pattern: /\b(cool\s*white|cw|5700|6000)\b/i, expand: "cool white 5700K 6000K dual COB CCT" },
  { pattern: /\bcct\b/i, expand: "CCT dual colour warm cool white LED COB strip driver" },
  { pattern: /\brgb\b/i, expand: "RGB COB strip 24V 400 LED per meter price" },
];

function expandQuery(rawQuery) {
  const q = String(rawQuery || "").trim();
  if (!q) return q;
  const wordCount = q.split(/\s+/).length;
  // Already a detailed query — only light expansion
  if (wordCount > 8) return q;
  const expansions = [];
  for (const { pattern, expand } of QUERY_EXPANSION_RULES) {
    if (pattern.test(q)) {
      expansions.push(expand);
      if (expansions.length >= 4) break;
    }
  }
  if (!expansions.length) return q;
  return `${q} ${expansions.join(" ")}`;
}

const AUTO_MODE_CONFIDENCE_THRESHOLD = Number(process.env.AUTO_MODE_CONFIDENCE_THRESHOLD || 0.8);
const AUTO_MODE_AMBIGUITY_DELTA = Number(process.env.AUTO_MODE_AMBIGUITY_DELTA || 0.15);

function detectRuleBasedAutoMode(message, history = []) {
  const userHistoryText = history
    .filter((h) => String(h?.role || "").toLowerCase() === "user")
    .map((h) => String(h?.content || ""))
    .join(" ");
  const combined = `${userHistoryText} ${String(message || "")}`.toLowerCase();
  
  const scores = {
    simple_chatbot: 0.2,
    b2b_sales_assistant: 0,
    compliance_assistant: 0,
    sales_automation: 0,
    odoo_operations: 0
  };

  if (/\b(invoice|bill|payment\s*status|customer\s*ledger|account\s*statement|outstanding\s*payment)\b/i.test(combined)) {
    scores.odoo_operations = Math.max(scores.odoo_operations, 0.88);
  }
  if (/\b(invoice|bill)\b\s+(of|for)\s+[a-z0-9 .&-]{2,}/i.test(combined) || /\b(show|get|find|download)\b.*\b(invoice|bill)\b/i.test(combined)) {
    scores.odoo_operations = Math.max(scores.odoo_operations, 0.9);
  }
  if (/\b(customer|sales\s*order|quotation|crm|purchase\s*order|vendor\s*bill|attendance|timesheet|employee|order\s*status)\b/i.test(combined)) {
    scores.odoo_operations = Math.max(scores.odoo_operations, 0.86);
  }

  const hasOrderIntent = /(create|make|place|confirm|process)\s+(an?\s+)?(order|quotation|quote|sales\s*order)/i.test(combined)
    || /(crm\s*handoff|lead stage|sales automation|automation workflow)/i.test(combined);
  if (hasOrderIntent) {
    scores.sales_automation = Math.max(scores.sales_automation, 0.9);
  }

  // Routing sanity checks:
  // - Should NOT trigger compliance: "201 price for 1000 pieces", "price for 202"
  // - Should trigger compliance: "Do you have CE certificate?", "export compliance for EU"
  const hasComplianceIntent = /\b(compliance|ce|ukca|ul|rohs|bis|iec|certificate|certification|hs\s*code|incoterm|export|customs|regulation|legal)\b/i.test(combined);
  const isPricingQuery = /(price|pricing|cost|rate|moq|quantity|pcs|pieces|units|per\s*piece|\binr\b)/i.test(combined)
    && !/\b(certificate|certification|certif|compliance|regulation|legal|export\s+control|customs\s+duty)\b/i.test(combined);

  if (hasComplianceIntent && !isPricingQuery) {
    scores.compliance_assistant = Math.max(scores.compliance_assistant, 0.9);
  } else if (hasComplianceIntent && isPricingQuery) {
    // Mixed signal — slight compliance boost but let sales win if it also scored
    scores.compliance_assistant = Math.max(scores.compliance_assistant, 0.5);
  }

  const hasSalesIntent = /(price|pricing|quote|quotation|moq|lead\s*time|bundle|pairing|compatible|recommend|quantity|sku|integration|odoo|shopify|woocommerce|amazon)/i.test(combined);
  if (hasSalesIntent) {
    scores.b2b_sales_assistant = Math.max(scores.b2b_sales_assistant, 0.82);
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topMode, topScore] = sorted[0];
  const secondScore = sorted[1]?.[1] || 0;
  const isAmbiguous = topScore >= AUTO_MODE_CONFIDENCE_THRESHOLD && Math.abs(topScore - secondScore) < AUTO_MODE_AMBIGUITY_DELTA;

  if (topScore >= AUTO_MODE_CONFIDENCE_THRESHOLD) {
    return {
      mode: topMode,
      reason: `Rule-based routing matched ${topMode}.`,
      confidence: Number(topScore.toFixed(2)),
      stage: "rules",
      scores,
      ambiguous: isAmbiguous
    };
  }

  return {
    mode: "simple_chatbot",
    reason: "Rule-based routing confidence too low; deferring to classifier.",
    confidence: Number(topScore.toFixed(2)),
    stage: "rules",
    scores,
    ambiguous: false
  };
}

async function classifyAutoModeWithLLM(message, history = []) {
  const recentHistory = history
    .slice(-6)
    .map((h) => `${String(h?.role || "user")}: ${String(h?.content || "")}`)
    .join("\n");
  const prompt = `Classify the user's intent into exactly one mode.
Allowed modes: simple_chatbot, b2b_sales_assistant, compliance_assistant, sales_automation, odoo_operations.
Respond as JSON only with keys: mode, confidence, reason.
Confidence must be between 0 and 1.

History:\n${recentHistory || "(none)"}
User message: ${message}`;

  const result = await callProductBotModel(
    "You are a strict intent classifier. Output only valid compact JSON with no markdown.",
    prompt
  );

  const raw = String(result?.text || "").trim();
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
  const mode = PRODUCT_BOT_MODES[parsed.mode] ? parsed.mode : "simple_chatbot";
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0.5)));
  return {
    mode,
    reason: parsed.reason || `LLM classifier routed to ${mode}.`,
    confidence: Number(confidence.toFixed(2)),
    stage: "classifier"
  };
}

async function detectAutoMode(message, history = []) {
  const stageOne = detectRuleBasedAutoMode(message, history);
  if (stageOne.confidence >= AUTO_MODE_CONFIDENCE_THRESHOLD) return stageOne;
  try {
    return await classifyAutoModeWithLLM(message, history);
  } catch {
    return stageOne;
  }
}
function isHelpIntent(message) {
  const text = String(message || "").toLowerCase();
  return /(how can you help|what can you do|help me|capabilities|what do you do)/i.test(text);
}

function isOdooOpsIntent(message) {
  const detection = detectRuleBasedAutoMode(message, []);
  return detection.mode === "odoo_operations";
}
function buildInternalOdooHelpReply() {
  return `I can help you with SmartHandicrafts product and sales support.

1) Product guidance
- Compare products, variants, bundles, and compatible pairings
- Explain integrations and use-case fit
- Share compliance notes and policy highlights from the knowledge base

2) Sales support
- Recommend SKUs based on your needs
- Help prepare quote intake details
- Clarify what information is needed before pricing

3) Quote and pricing context
- Share known pricing status and freshness warnings
- Flag missing fields (quantity, use case, project details)
- Point to support contact when human follow-up is needed

4) Clear next steps
- Suggest whether to request details, send a quote, or book a call
- Provide source-backed answers with traceability

Tell me what product or requirement you have, and I'll guide you from there.`;
}

function buildGreetingReply() {
  return `Hi! I'm the SmartHandicrafts product assistant 👋

I can help you with:
- LED driver pricing & specs (rechargeable & USB-powered)
- Product comparisons and bundle recommendations
- Compliance notes (CE, UKCA, UL, RoHS)
- Export and shipping guidance

What would you like to know? You can ask anything — even just "201 price" or "show me strip drivers".`;
}

function buildFallbackReply(message) {
  return `I wasn't able to find specific information for: **"${String(message || "").trim()}"**

Here are some things I can help with:
- Product specs & pricing (e.g. "201 price", "battery specs")
- Bundle recommendations (e.g. "LC set options")
- Compliance questions (e.g. "CE certificate for 201")
- Company info (e.g. "shipping policy")

If you need further assistance, please contact us at **support@smarthandicrafts.com** or mention more details about your requirement.`;
}

const PRODUCT_BOT_EMBED_MODEL = process.env.PRODUCT_BOT_EMBED_MODEL || "text-embedding-004";
const PRODUCT_BOT_TOP_K = Math.max(2, Number(process.env.PRODUCT_BOT_TOP_K || 8)); // Increased from 6 → 8 for better short-query retrieval

const productKnowledgeCache = {
  raw: "",
  chunks: [],
  vectors: [],
  embedError: null,
  skuCatalog: [],
  pricingCatalog: new Map()
};

const kitIntegrationKnowledgeCache = {
  raw: "",
  chunks: [],
  error: null,
  loadedAt: 0
};

const SELF_TRAINING_ENABLED = String(process.env.BOT_SELF_TRAINING || process.env.PRODUCT_BOT_SELF_TRAINING || "true").toLowerCase() !== "false";
const SELF_TRAINING_MAX_EXAMPLES = Math.max(10, Number(process.env.BOT_SELF_TRAINING_MAX || process.env.PRODUCT_BOT_SELF_TRAINING_MAX || 500));
const SELF_TRAINING_PROMPT_EXAMPLES = Math.max(1, Number(process.env.BOT_SELF_TRAINING_PROMPT_EXAMPLES || process.env.PRODUCT_BOT_SELF_TRAINING_PROMPT_EXAMPLES || 4));
const selfTrainingMemory = [];
const routingTelemetry = {
  events: [],
  counters: {
    total: 0,
    misroute_rate: 0,
    clarification_rate: 0,
    odoo_detected_but_unconfigured_rate: 0
  }
};

function getPendingModeClarification(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const candidate = history[i]?.pending_mode_clarification;
    if (candidate?.active) return candidate;
  }
  return null;
}

function recordRoutingTelemetry(event) {
  const entry = {
    at: now(),
    message: String(event?.message || ""),
    chosen_mode: event?.chosen_mode || "simple_chatbot",
    confidence: Number(event?.confidence || 0),
    fallback_used: !!event?.fallback_used,
    clarification_asked: !!event?.clarification_asked,
    odoo_detected_but_unconfigured: !!event?.odoo_detected_but_unconfigured,
    final_user_satisfaction_signal: event?.final_user_satisfaction_signal ?? null,
    route_feedback: event?.route_feedback ?? null
  };
  routingTelemetry.events.push(entry);
  if (routingTelemetry.events.length > 500) routingTelemetry.events.shift();
  const events = routingTelemetry.events;
  const total = events.length || 1;
  routingTelemetry.counters.total = events.length;
  routingTelemetry.counters.misroute_rate = events.filter((x) => x.route_feedback === "misroute").length / total;
  routingTelemetry.counters.clarification_rate = events.filter((x) => x.clarification_asked).length / total;
  routingTelemetry.counters.odoo_detected_but_unconfigured_rate = events.filter((x) => x.odoo_detected_but_unconfigured).length / total;
}

function normalizeText(v) {
  return String(v || "").replace(/\r/g, "").trim();
}

function splitKnowledgeIntoChunks(text) {
  const lines = normalizeText(text).split("\n");
  const chunks = [];
  let currentTitle = "General";
  let buffer = [];

  const flush = () => {
    const body = normalizeText(buffer.join("\n"));
    if (!body) return;
    const maxLen = 1200;
    if (body.length <= maxLen) {
      chunks.push({ title: currentTitle, content: body });
    } else {
      let i = 0;
      while (i < body.length) {
        const piece = body.slice(i, i + maxLen);
        chunks.push({ title: currentTitle, content: piece });
        i += maxLen;
      }
    }
    buffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,4}\s+(.+)/);
    if (heading) {
      flush();
      currentTitle = heading[1].trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return chunks.filter((c) => c.content.length > 20);
}

function tokenize(text) {
  return normalizeText(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((x) => x.length > 2);
}

function extractQueryHints(query) {
  const raw = normalizeText(query).toLowerCase();
  if (!raw) return [];

  const directMatches = Array.from(raw.matchAll(/[a-z0-9-]{3,}/g)).map((m) => m[0]);
  const normalizedParts = directMatches.flatMap((part) => [part, part.replace(/[^a-z0-9]/g, "")]);
  const compact = normalizedParts
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .filter((part) => /\d/.test(part) || /sku|price|model|driver|battery|usb|lc/.test(part));

  return Array.from(new Set(compact));
}

function collectSkuAliasesFromChunks(chunks = []) {
  const aliasMap = new Map();

  for (const chunk of chunks) {
    const text = `${chunk?.title || ""}
${chunk?.content || ""}`;
    const matches = Array.from(text.matchAll(/\bAS-B-[A-Z0-9-]+\b/gi)).map((m) => m[0].toLowerCase());

    for (const sku of matches) {
      const compactSku = sku.replace(/[^a-z0-9]/g, "");
      const numberMatches = Array.from(sku.matchAll(/\d{2,4}/g)).map((m) => m[0]);
      for (const number of numberMatches) {
        if (!aliasMap.has(number)) aliasMap.set(number, new Set([number]));
        aliasMap.get(number).add(sku);
        aliasMap.get(number).add(compactSku);
      }
    }
  }

  return aliasMap;
}

function buildPricingQueryCanonicalForm(query, chunks = []) {
  const raw = normalizeText(query).toLowerCase();
  if (!raw) return null;

  const asksPrice = /(price|pricing|quote|quotation|rate|cost)/i.test(raw);
  const asksMoq = /(moq|min(?:imum)?\s*order|minimum\s*qty|minimum\s*quantity)/i.test(raw);
  const mentionsPcs = /(pcs?|pieces?|units?)/i.test(raw);
  const hasQtyContext = asksMoq || mentionsPcs || /\b\d{2,6}\s*(?:\+|plus)\b/i.test(raw);
  if (!asksPrice || !hasQtyContext) return null;

  const compact = raw.replace(/[^a-z0-9]+/g, " ");
  const qtyMatch = compact.match(/\b(\d{2,6})\s*(?:pcs?|pieces?|units?|qty|quantity|moq)?\b/);
  const numbers = Array.from(compact.matchAll(/\b\d{2,6}\b/g)).map((m) => m[1]);
  const qty = qtyMatch?.[1] || numbers.find((n) => Number(n) >= 50 && Number(n) <= 50000);
  const skuNumber = numbers.find((n) => Number(n) >= 100 && Number(n) < 1000);
  if (!qty || !skuNumber) return null;

  const skuAliasMap = collectSkuAliasesFromChunks(chunks);
  const skuHints = Array.from(skuAliasMap.get(skuNumber) || [skuNumber]);

  return `pricing query sku ${skuHints.join(" ")} quantity ${qty} pcs moq ${qty}+`;
}

function chunkHintScore(chunk, hints) {
  if (!hints.length) return 0;

  const haystack = `${chunk.title}\n${chunk.content}`.toLowerCase();
  const compactHaystack = haystack.replace(/[^a-z0-9]/g, "");
  let score = 0;

  for (const hint of hints) {
    if (hint.includes("-")) {
      const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack)) score += 3;
      continue;
    }

    if (/^\d+$/.test(hint)) {
      if (new RegExp(`(^|[^a-z0-9])${hint}([^a-z0-9]|$)`, "i").test(haystack)) score += 2;
      continue;
    }

    if (haystack.includes(hint) || compactHaystack.includes(hint)) score += 1;
  }

  return score;
}

function keywordScore(query, chunk) {
  const q = new Set(tokenize(query));
  const c = tokenize(`${chunk.title} ${chunk.content}`);
  let hit = 0;
  for (const tok of c) if (q.has(tok)) hit += 1;
  return hit / Math.max(1, c.length);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedText(text) {
  const out = await genAI.models.embedContent({
    model: PRODUCT_BOT_EMBED_MODEL,
    contents: text
  });
  return out?.embeddings?.[0]?.values || out?.embedding?.values || out?.embedding || null;
}

async function readProductKnowledge() {
  try {
    const text = await readFile(PRODUCT_KNOWLEDGE_PATH, "utf8");
    return text.trim();
  } catch {
    return PRODUCT_BOT_FALLBACK_CONTEXT.trim();
  }
}

async function readKitIntegrationKnowledge() {
  try {
    const text = await readFile(KIT_INTEGRATION_KNOWLEDGE_PATH, "utf8");
    return String(text || "").trim();
  } catch {
    return String(KIT_INTEGRATION_FALLBACK_CONTEXT || "").trim();
  }
}

function splitKitIntegrationKnowledgeIntoChunks(text = "") {
  const raw = normalizeText(text);
  if (!raw) return [];

  const lines = raw.split("\n");
  const chunks = [];
  let currentTitle = "Smart Handicrafts Integration Overview";
  let buffer = [];

  const pushBodyAsChunks = () => {
    const body = normalizeText(buffer.join("\n"));
    buffer = [];
    if (!body) return;

    const maxLen = 1900;
    if (body.length <= maxLen) {
      chunks.push({ title: currentTitle, content: body });
      return;
    }

    let part = 1;
    let index = 0;
    while (index < body.length) {
      const slice = body.slice(index, index + maxLen);
      chunks.push({
        title: `${currentTitle} — Part ${part}`,
        content: normalizeText(slice)
      });
      index += maxLen;
      part += 1;
    }
  };

  for (const line of lines) {
    const trimmed = String(line || "").trim();

    // The master document uses SECTION XX: ... headings and separator lines.
    const sectionHeading = trimmed.match(/^SECTION\s+\d+\s*:\s*(.+)$/i);
    const markdownHeading = trimmed.match(/^#{1,4}\s+(.+)$/);
    const isSeparator = /^[-=]{10,}$/.test(trimmed);

    if (isSeparator) continue;

    if (sectionHeading || markdownHeading) {
      pushBodyAsChunks();
      currentTitle = String((sectionHeading || markdownHeading)[1] || "").trim() || currentTitle;
      continue;
    }

    buffer.push(line);
  }

  pushBodyAsChunks();

  return chunks.filter((chunk) => chunk.content && chunk.content.length > 40);
}

async function ensureKitIntegrationKnowledgeIndex() {
  const raw = normalizeText(await readKitIntegrationKnowledge());
  if (!raw) {
    kitIntegrationKnowledgeCache.raw = "";
    kitIntegrationKnowledgeCache.chunks = [];
    kitIntegrationKnowledgeCache.error = "No integration knowledge file found.";
    return;
  }

  if (kitIntegrationKnowledgeCache.raw === raw && kitIntegrationKnowledgeCache.chunks.length) {
    return;
  }

  kitIntegrationKnowledgeCache.raw = raw;
  kitIntegrationKnowledgeCache.chunks = splitKitIntegrationKnowledgeIntoChunks(raw);
  kitIntegrationKnowledgeCache.error = null;
  kitIntegrationKnowledgeCache.loadedAt = Date.now();
}


function getKitAiRecentUserIntentText(history = [], question = "") {
  const historyText = (Array.isArray(history) ? history : [])
    .filter((item) => String(item?.role || item?.agent || "").toLowerCase() === "user")
    .slice(-8)
    .map((item) => String(item?.text || item?.content || "").trim())
    .filter(Boolean)
    .join(" ");

  return `${historyText} ${String(question || "").trim()}`
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}


function buildKitAiDecisionPolicy({
  question = "",
  history = [],
  kitContext = {},
  liveProducts = []
} = {}) {
  const recentUserIntentText = getKitAiRecentUserIntentText(history, question);
  const snapshot = kitContext?.kitBuilderSnapshot || {};
  const activeDriverText = String(snapshot.selectedDriver || "").toLowerCase();
  const activeKitText = [
    snapshot.selectedDriver || "",
    ...(Array.isArray(snapshot.activeKitItems) ? snapshot.activeKitItems : []),
    ...(Array.isArray(snapshot.selectedItemIds) ? snapshot.selectedItemIds : [])
  ].join(" ").toLowerCase();

  const flags = {
    // Product forms / applications
    floorLamp: /\bfloor\s+lamp\b/i.test(recentUserIntentText),
    tableLamp: /\btable\s+lamp\b|\bdesk\s+lamp\b|\bbedside\s+lamp\b/i.test(recentUserIntentText),
    wallSconce: /\bwall\s+sconce\b|\bwall\s+light\b|\bwall[-\s]?mounted\s+lamp\b/i.test(recentUserIntentText),
    topTouch: /\btop[-\s]?touch\b|\btouch\s+from\s+top\b|\btouch\s+on\s+top\b/i.test(recentUserIntentText),
    decorativeLamp: /\bdecorative\s+lamp\b|\baccent\s+lamp\b|\bdesigner\s+lamp\b/i.test(recentUserIntentText),
    creativeObject: /\bnotebook\b|\bbook[-\s]?shaped\b|\bfigurine\b|\bsculpture\b|\bart\s+piece\b|\bfestive\b|\bgift\b|\bchristmas\b|\bdecorative\s+object\b|\bcreative\s+lamp\b/i.test(recentUserIntentText),
    notebookLamp: /\bnotebook\b|\bbook[-\s]?shaped\b/i.test(recentUserIntentText),
    bottleLamp: /\bbottle\s+lamp\b|\bjar\s+lamp\b/i.test(recentUserIntentText),

    // Power
    rechargeable: /\brechargeable\b|\bbattery[-\s]?powered\b|\bwireless\b|\bportable\b|\bcharge\s+and\s+use\b/i.test(recentUserIntentText),
    usbPowered: /\busb[-\s]?powered\b|\bdirectly\s+powered\b|\bplug[-\s]?in\b|\busb[-\s]?c\s+charger\b|\bno\s+battery\b/i.test(recentUserIntentText),
    noBattery: /\bno\s+battery\b|\bwithout\s+battery\b/i.test(recentUserIntentText),
    fastCharging: /\bfast\s+charging\b|\bfaster\s+charging\b|\bquick\s+charge\b|\bcharge\s+faster\b/i.test(recentUserIntentText),

    // Lighting topology
    ambient: /\bambient\b|\bsoft\s+glow\b|\bdiffused\b|\bdecorative\s+glow\b|\bsoft\s+light\b/i.test(recentUserIntentText),
    reading: /\breading\b|\btask\s+light\b|\bfocused\s+light\b|\bdirectional\s+light\b/i.test(recentUserIntentText),
    largeHead: /\blarge\s+head\b|\bbroad\s+head\b|\bwide\s+head\b|\bbig\s+head\b|\blarge\s+shade\b|\blarge\s+round\s+head\b/i.test(recentUserIntentText),
    mediumHead: /\bmedium\s+head\b|\bmoderate\s+head\b/i.test(recentUserIntentText),
    smallHead: /\bsmall\s+head\b|\bcompact\s+head\b/i.test(recentUserIntentText),
    headLight: /\bhead\b|\bshade\b|\bupper\s+light\b|\btop\s+light\b|\btop\s+glow\b/i.test(recentUserIntentText),
    stripPath: /\bstrip\b|\bperimeter\b|\bedge\b|\boutline\b|\bcurve\b|\bchannel\b|\belongated\b|\bcontour\b|\bhalo\b|\bouter\s+edge\b/i.test(recentUserIntentText),
    hiddenGlow: /\bhidden\s+glow\b|\bindirect\s+glow\b|\bbacklit\b|\bback[-\s]?lit\b|\bglow\s+from\s+inside\b|\binner\s+glow\b/i.test(recentUserIntentText),
    singleLightPoint: /\bsingle\s+(?:led|light|light\s+point)\b|\bone\s+(?:led|light|light\s+point)\b|\bmain\s+light\s+point\b/i.test(recentUserIntentText),
    dualLightPoints: /\btwo\s+(?:separate\s+)?(?:leds|light\s+points|lights)\b|\bdual\s+output\b|\btwo\s+locations\b|\bone\s+light\s+at\s+the\s+top\s+and\s+one\b/i.test(recentUserIntentText),

    // Cavity / physical integration
    baseCavity: /\bhollow\s+base\b|\bspace\s+inside\s+base\b|\bbase\s+cavity\b|\bdriver\s+in\s+base\b/i.test(recentUserIntentText),
    headCavity: /\bspace\s+inside\s+head\b|\bhead\s+cavity\b|\bmodule\s+in\s+head\b/i.test(recentUserIntentText),
    rearCavity: /\brear\s+cavity\b|\bback\s+cavity\b|\bwall\s+box\b|\brear\s+mounting\s+box\b/i.test(recentUserIntentText),
    compactBase: /\bsmall\s+base\b|\bvery\s+small\s+base\b|\bbase\s+(?:is|seems)\s+(?:very\s+)?small\b|\bcompact\s+base\b|\btight\s+base\b|\blimited\s+space\b/i.test(recentUserIntentText),
    tinyBase: /\btiny\s+base\b|\bbase\s+(?:is|seems)\s+tiny\b|\bvery\s+tight\b|\bvery\s+compact\b/i.test(recentUserIntentText),
    largeBase: /\blarge\s+base\b|\bspacious\s+base\b|\benough\s+space\b/i.test(recentUserIntentText),

    // Charging / panel mount
    asksChargingAccess: /\bcharging\s+port\b|\bcharger\s+connect\b|\busb[-\s]?c\s+(?:port|input)\b|\bpower\s+input\b/i.test(recentUserIntentText),
    chargingHidden: /\bport\s+(?:will\s+be\s+)?hidden\b|\bcharging\s+(?:point|port)\s+(?:is\s+)?hidden\b|\bdriver\s+hidden\s+inside\b|\bdeep\s+inside\b/i.test(recentUserIntentText),
    cleanExternalPort: /\bclean\s+external\s+(?:port|charging)\b|\bneat\s+(?:port|charging\s+point)\b/i.test(recentUserIntentText),

    // Touch
    touchControl: /\btouch\b|\btouch\s+control\b|\btouch\s+sensor\b/i.test(recentUserIntentText),
    metalBody: /\bmetal\s+body\b|\bbody\s+(?:is|made\s+of)\s+metal\b|\bconductive\s+body\b|\bbrass\b|\bsteel\b|\baluminium\b|\baluminum\b/i.test(recentUserIntentText),
    fullBodyTouch: /\bwhole\s+body\s+touch\b|\bfull\s+body\s+touch\b|\bentire\s+body\s+touch\b|\btouch\s+wire\s+to\s+body\b/i.test(recentUserIntentText),
    definedTouchPoint: /\bmetal\s+(?:nut|cap|ring|pin)\b|\btouch\s+cap\b|\btouch\s+nut\b|\btouch\s+point\b/i.test(recentUserIntentText),

    // Battery path
    sleeveBatteryWanted: /\bwith\s+sleeve\b|\bsleeve\s+battery\b/i.test(recentUserIntentText),
    nonSleeveBatteryWanted: /\bwithout\s+sleeve\b|\bnon[-\s]?sleeve\b|\bno\s+sleeve\b/i.test(recentUserIntentText),
    holderBasedBattery: /\bbattery\s+holder\b|\bholder[-\s]?based\b|\breplaceable\s+battery\b/i.test(recentUserIntentText),
    batterySpaceConcern: /\bbattery\s+space\b|\bnot\s+much\s+space\b|\bspace\s+is\s+limited\b|\bvery\s+compact\b/i.test(recentUserIntentText),

    // Optics / mechanics
    softOutput: /\bsoft\s+output\b|\bsofter\s+light\b|\bnon[-\s]?harsh\b|\bdiffuser\b|\bdiffused\s+lens\b/i.test(recentUserIntentText),
    directionalOutput: /\bfocused\s+beam\b|\bclear\s+lens\b|\bsharper\s+light\b|\bdirectional\s+output\b/i.test(recentUserIntentText),
    shade: /\bshade\b|\blampshade\b/i.test(recentUserIntentText),
    centralRod: /\bcentral\s+rod\b|\bstem\s+rod\b|\bthreaded\s+rod\b|\bpipe\b|\bnipple\b/i.test(recentUserIntentText),
    asksMounting: /\bhow\s+(?:will|do)\s+(?:it|driver|battery|led|module)\s+(?:fit|mount|fix)\b|\bmounting\b|\bfix(?:ed)?\b/i.test(recentUserIntentText)
  };

  const policies = [];
  const supporting = [];

  function pushPolicy(policy) {
    policies.push({
      integrationMode: true,
      scope: "primary",
      ...policy
    });
  }

  function pushSupport(policy) {
    supporting.push({
      integrationMode: true,
      scope: "supporting",
      ...policy
    });
  }

  // ------------------------------------------------------------------
  // PRIMARY PRODUCT-FAMILY POLICIES
  // ------------------------------------------------------------------

  // A. Rechargeable / USB strip path
  if (flags.stripPath || flags.hiddenGlow) {
    if (flags.usbPowered && !flags.rechargeable) {
      pushPolicy({
        id: "usb_strip_path",
        priority: 118,
        repairKind: "usb_strip_103",
        retrievalHints: ["AS-U-103-LSD", "USB strip lamp", "edge glow", "strip integration"],
        preferredPath: "AS-U-103-LSD for USB-powered strip / edge / perimeter / contour lighting.",
        mustMention: ["AS-U-103-LSD or 103 strip driver", "strip is the intended light source", "no battery"],
        mustAvoid: [
          "Do not recommend COB or DOB as the primary light source when the user's light must follow an edge, contour, strip path, or hidden glow path.",
          "Do not suggest any battery for USB-powered strip systems."
        ],
        suggestedNextStep: "Explain the 103 strip path and ask only for strip length, strip voltage/path, or charging-port access if needed."
      });
    } else if (flags.rechargeable && flags.fastCharging) {
      pushPolicy({
        id: "rechargeable_fast_strip_path",
        priority: 119,
        repairKind: "rechargeable_strip_205",
        retrievalHints: ["AS-B-205-LSD", "205 fast charging strip driver", "rechargeable edge glow", "strip integration"],
        preferredPath: "AS-B-205-LSD for rechargeable strip lighting where faster charging is requested.",
        mustMention: ["205 fast-charging rechargeable strip driver", "strip is the intended light source", "battery required"],
        mustAvoid: [
          "Do not describe 205 as a USB-only driver.",
          "Do not recommend COB LEDs as the light source for 205."
        ],
        suggestedNextStep: "Explain why 205 fits the fast-charging rechargeable strip path and ask for strip length/voltage only if needed."
      });
    } else if (flags.rechargeable) {
      pushPolicy({
        id: "rechargeable_standard_strip_path",
        priority: 117,
        repairKind: "rechargeable_strip_204",
        retrievalHints: ["AS-B-204-LSD", "204 standard charging strip driver", "rechargeable edge glow", "strip integration"],
        preferredPath: "AS-B-204-LSD for rechargeable strip lighting when normal charging is acceptable. Mention 205 only as the faster-charging alternative if the user asks or the comparison is useful.",
        mustMention: ["204 standard-charging rechargeable strip driver", "strip is the intended light source", "battery required"],
        mustAvoid: [
          "Do not confuse 204 with 205.",
          "Do not recommend COB LEDs as the light source for 204."
        ],
        suggestedNextStep: "Explain the 204 strip route. Mention that 205 is the faster-charging variant only as a relevant comparison, not as a random upsell."
      });
    } else {
      pushPolicy({
        id: "strip_path_power_choice_needed",
        priority: 103,
        repairKind: "strip_power_choice",
        retrievalHints: ["AS-U-103-LSD", "AS-B-204-LSD", "AS-B-205-LSD", "strip lamp power choice"],
        preferredPath: "The light geometry clearly points to a strip solution, but the AI must first ask whether it should be rechargeable or directly USB-powered.",
        mustMention: ["strip path", "rechargeable 204/205 vs USB 103 distinction"],
        mustAvoid: [
          "Do not choose COB, DOB, or a battery path before the customer chooses rechargeable vs USB-powered."
        ],
        suggestedNextStep: "Ask whether the customer wants rechargeable or USB-C direct power; then choose 204/205 or 103 accordingly."
      });
    }
  }

  // B. DOB head / top-touch / floor-lamp family
  if (flags.topTouch && flags.rechargeable) {
    pushPolicy({
      id: "top_touch_dob",
      priority: 116,
      repairKind: "top_touch_dob_206",
      retrievalHints: ["AS-B-206 DOB", "top touch lamp", "head-based integrated light", "touch point at top"],
      preferredPath: "AS-B-206 DOB series for rechargeable top-touch head-based lamp designs.",
      mustMention: ["206 DOB", "head-based integration", "top-touch route"],
      mustAvoid: [
        "Do not default to 201 or 202 if the customer is clearly describing a head-integrated top-touch lamp."
      ],
      suggestedNextStep: "Explain the 206 DOB route and ask for head size only if exact 55/75/115 mm selection is needed."
    });
  }

  if (flags.floorLamp && flags.rechargeable && !flags.stripPath) {
    const likelyLargeHeadDob =
      flags.largeHead ||
      flags.ambient ||
      flags.headLight ||
      !flags.reading;

    if (likelyLargeHeadDob) {
      pushPolicy({
        id: "rechargeable_floor_lamp_dob",
        priority: 115,
        repairKind: "floor_dob_206",
        retrievalHints: ["floor lamp", "AS-B-206 DOB", "206 115mm", "large head floor lamp", "diffuser sheet", "head integration"],
        preferredPath: "AS-B-206 DOB series; mention 115 mm DOB as the likely large-head floor-lamp direction if the head diameter allows.",
        mustMention: ["206 DOB", "115 mm if head size allows", "201 is not automatically the best floor-lamp path just because it is already in the active kit"],
        mustAvoid: [
          "Do not say the current 201 + 3W COB table-lamp kit is automatically well-suited for a rechargeable ambient floor lamp.",
          "Do not ignore the 206 DOB floor-lamp path."
        ],
        suggestedNextStep: "Explain that 201 can work only for a separated base-driver plus LED-in-head construction, while 206 DOB is often cleaner for a rechargeable ambient floor lamp. Ask whether to explore/switch to the 206 path or confirm head diameter."
      });
    }
  }

  if (!flags.floorLamp && flags.largeHead && flags.rechargeable && flags.headLight && !flags.stripPath) {
    pushPolicy({
      id: "large_head_rechargeable_dob",
      priority: 111,
      repairKind: "large_head_dob_206",
      retrievalHints: ["AS-B-206 DOB", "large head lamp", "integrated head module", "115 mm DOB"],
      preferredPath: "AS-B-206 DOB series for rechargeable large-head lamps; 115 mm may be suitable if the head diameter allows.",
      mustMention: ["206 DOB", "head size determines 55/75/115 mm choice"],
      mustAvoid: ["Do not ignore the 206 route when the concept is clearly large-head and head-integrated."],
      suggestedNextStep: "Explain the integrated-head DOB route and ask only for head diameter if exact size is needed."
    });
  }

  // C. Dual-light point selection
  if (flags.dualLightPoints && flags.rechargeable && !flags.stripPath && !flags.tableLamp && !flags.wallSconce) {
    pushPolicy({
      id: "rechargeable_dual_light_points",
      priority: 110,
      repairKind: "rechargeable_dual_202",
      retrievalHints: ["AS-B-202-DLD", "dual LED", "two light points", "rechargeable dual-light lamp"],
      preferredPath: "AS-B-202-DLD for rechargeable concepts needing two distinct light points or dual-light behavior.",
      mustMention: ["202 dual-driver path", "two light-point use case"],
      mustAvoid: [
        "Do not continue with 201 if the user clearly wants two separately located light outputs."
      ],
      suggestedNextStep: "Explain why 202 fits and ask only the two light-point placement or LED selection detail if needed."
    });
  }

  if (flags.dualLightPoints && flags.usbPowered && !flags.stripPath && !flags.tableLamp && !flags.wallSconce) {
    pushPolicy({
      id: "usb_dual_light_points",
      priority: 110,
      repairKind: "usb_dual_102",
      retrievalHints: ["AS-U-102-DLD", "dual LED", "two light points", "USB dual-light lamp"],
      preferredPath: "AS-U-102-DLD for USB-powered concepts needing two distinct light points or dual-light behavior.",
      mustMention: ["102 dual-driver path", "no battery"],
      mustAvoid: [
        "Do not continue with 101 if the user clearly wants two separately located light outputs.",
        "Do not suggest a battery for 102."
      ],
      suggestedNextStep: "Explain why 102 fits and ask only the remaining light-point detail if needed."
    });
  }

  // D. Wall sconce selection
  if (flags.wallSconce && !flags.stripPath) {
    if (flags.rechargeable && flags.dualLightPoints) {
      pushPolicy({
        id: "wall_sconce_rechargeable_dual",
        priority: 108,
        repairKind: "wall_rechargeable_dual_202",
        retrievalHints: ["wall sconce", "AS-B-202-DLD", "rear cavity", "dual-light wall lamp"],
        preferredPath: "AS-B-202-DLD for a rechargeable wall sconce with two light points.",
        mustMention: ["202", "driver/battery in rear or base cavity", "wire routing to both light points"],
        mustAvoid: ["Do not choose 201 if the wall sconce clearly needs two distinct lighting outputs."],
        suggestedNextStep: "Explain the 202 wall-sconce path and ask only for cavity or two light locations if needed."
      });
    } else if (flags.rechargeable) {
      pushPolicy({
        id: "wall_sconce_rechargeable_single",
        priority: 107,
        repairKind: "wall_rechargeable_single_201",
        retrievalHints: ["wall sconce", "AS-B-201-SLD", "rear cavity", "rechargeable wall lamp"],
        preferredPath: "AS-B-201-SLD for a rechargeable wall sconce with one main light point, subject to cavity and structure.",
        mustMention: ["201", "rear/base cavity", "charging access"],
        mustAvoid: ["Do not describe the wall sconce without explaining where the driver and battery can sit."],
        suggestedNextStep: "Explain the rear/base cavity placement and ask only for light position or cavity availability if not given."
      });
    } else if (flags.usbPowered && flags.dualLightPoints) {
      pushPolicy({
        id: "wall_sconce_usb_dual",
        priority: 107,
        repairKind: "wall_usb_dual_102",
        retrievalHints: ["wall sconce", "AS-U-102-DLD", "USB wall lamp", "dual light points"],
        preferredPath: "AS-U-102-DLD for a USB-powered wall sconce with two light points.",
        mustMention: ["102", "no battery", "USB-C access"],
        mustAvoid: ["Do not suggest a battery for 102."],
        suggestedNextStep: "Explain the USB dual-light wall-sconce path and ask only the remaining placement detail if needed."
      });
    } else if (flags.usbPowered) {
      pushPolicy({
        id: "wall_sconce_usb_single",
        priority: 106,
        repairKind: "wall_usb_single_101",
        retrievalHints: ["wall sconce", "AS-U-101-SLD", "USB wall lamp"],
        preferredPath: "AS-U-101-SLD for a USB-powered wall sconce with one main light point.",
        mustMention: ["101", "no battery", "USB-C access"],
        mustAvoid: ["Do not suggest a battery for 101."],
        suggestedNextStep: "Explain the 101 wall-sconce path and ask only the light/cavity detail if needed."
      });
    } else {
      pushPolicy({
        id: "wall_sconce_power_choice_needed",
        priority: 100,
        repairKind: "wall_power_choice",
        retrievalHints: ["wall sconce", "rechargeable vs USB wall lamp"],
        preferredPath: "Wall-sconce product family is clear, but rechargeable vs USB-powered must be decided before driver selection.",
        mustMention: ["wall sconce", "rechargeable vs USB-powered choice"],
        mustAvoid: ["Do not force 201/202/101/102 before the power type is known."],
        suggestedNextStep: "Ask whether the wall sconce should be rechargeable or USB-powered and whether it has one or two light points."
      });
    }
  }

  // E. Table lamp selection
  if (flags.tableLamp && !flags.stripPath && !flags.floorLamp) {
    if (flags.rechargeable && flags.dualLightPoints) {
      pushPolicy({
        id: "table_lamp_rechargeable_dual",
        priority: 105,
        repairKind: "table_rechargeable_dual_202",
        retrievalHints: ["AS-B-202-DLD", "rechargeable table lamp", "dual light points"],
        preferredPath: "AS-B-202-DLD for a rechargeable table lamp with two light points or dual-output intent.",
        mustMention: ["202", "two light-point use case"],
        mustAvoid: ["Do not keep the user on 201 if they have clearly asked for two physical light points."],
        suggestedNextStep: "Explain why 202 fits and then ask only the remaining LED or battery detail if needed."
      });
    } else if (flags.rechargeable) {
      pushPolicy({
        id: "table_lamp_rechargeable_single",
        priority: 104,
        repairKind: "table_rechargeable_single_201",
        retrievalHints: ["AS-B-201-SLD", "rechargeable table lamp", "single COB lamp"],
        preferredPath: "AS-B-201-SLD for a normal rechargeable single-light table lamp.",
        mustMention: ["201", "battery required", "LED connected by JST wire"],
        mustAvoid: ["Do not jump to strip/DOB unless the product geometry says so."],
        suggestedNextStep: "Explain the 201 path and continue the kit-builder flow with LED brightness and battery choice only if unresolved."
      });
    } else if (flags.usbPowered && flags.dualLightPoints) {
      pushPolicy({
        id: "table_lamp_usb_dual",
        priority: 104,
        repairKind: "table_usb_dual_102",
        retrievalHints: ["AS-U-102-DLD", "USB table lamp", "dual light points"],
        preferredPath: "AS-U-102-DLD for a USB-powered table lamp with two light points or dual-light behavior.",
        mustMention: ["102", "no battery"],
        mustAvoid: ["Do not suggest a battery for 102."],
        suggestedNextStep: "Explain why 102 fits and ask only the remaining light detail if needed."
      });
    } else if (flags.usbPowered) {
      pushPolicy({
        id: "table_lamp_usb_single",
        priority: 103,
        repairKind: "table_usb_single_101",
        retrievalHints: ["AS-U-101-SLD", "USB table lamp", "single COB lamp"],
        preferredPath: "AS-U-101-SLD for a USB-powered single-light table lamp.",
        mustMention: ["101", "no battery"],
        mustAvoid: ["Do not suggest a battery for 101."],
        suggestedNextStep: "Explain the 101 path and continue with LED choice or port-access detail only if unresolved."
      });
    } else {
      pushPolicy({
        id: "table_lamp_power_choice_needed",
        priority: 99,
        repairKind: "table_power_choice",
        retrievalHints: ["table lamp", "rechargeable 201", "USB 101"],
        preferredPath: "The product is a table lamp, but rechargeable vs USB-powered must be decided before choosing 201/101 or 202/102.",
        mustMention: ["rechargeable vs USB-powered choice"],
        mustAvoid: ["Do not force a battery or a driver before the power type is known."],
        suggestedNextStep: "Ask whether the lamp should be rechargeable or USB-C direct powered, then decide the driver family."
      });
    }
  }

  // F. Creative / unusual product logic where topology is more important than name
  if (flags.creativeObject && !flags.floorLamp && !flags.wallSconce && !flags.tableLamp) {
    if ((flags.stripPath || flags.hiddenGlow) && flags.rechargeable) {
      pushPolicy({
        id: "creative_rechargeable_strip",
        priority: 101,
        repairKind: flags.fastCharging ? "rechargeable_strip_205" : "rechargeable_strip_204",
        retrievalHints: ["creative lamp", "edge glow", flags.fastCharging ? "AS-B-205-LSD" : "AS-B-204-LSD"],
        preferredPath: flags.fastCharging
          ? "AS-B-205-LSD for a rechargeable creative edge/contour glow concept that also needs faster charging."
          : "AS-B-204-LSD for a rechargeable creative edge/contour glow concept.",
        mustMention: [flags.fastCharging ? "205 fast-charging strip path" : "204 rechargeable strip path"],
        mustAvoid: ["Do not force a single COB point-source solution when the concept needs glow along an edge or contour."],
        suggestedNextStep: "Explain the strip-based creative route and ask about strip path/length or battery cavity only if needed."
      });
    } else if ((flags.stripPath || flags.hiddenGlow) && flags.usbPowered) {
      pushPolicy({
        id: "creative_usb_strip",
        priority: 101,
        repairKind: "usb_strip_103",
        retrievalHints: ["creative lamp", "edge glow", "AS-U-103-LSD"],
        preferredPath: "AS-U-103-LSD for a USB-powered creative edge/contour glow concept.",
        mustMention: ["103 USB strip path", "no battery"],
        mustAvoid: ["Do not force a point LED when the user wants contour or edge glow."],
        suggestedNextStep: "Explain the 103 creative strip route and ask only about path length or port access if needed."
      });
    } else if (flags.singleLightPoint && flags.rechargeable) {
      pushPolicy({
        id: "creative_rechargeable_point_led",
        priority: 98,
        repairKind: "table_rechargeable_single_201",
        retrievalHints: ["creative rechargeable lamp", "AS-B-201-SLD", "single light point"],
        preferredPath: "AS-B-201-SLD for a rechargeable creative object with one defined light point.",
        mustMention: ["201 path", "driver/battery cavity", "single light point"],
        mustAvoid: ["Do not force strip lighting if the user explicitly wants one point source."],
        suggestedNextStep: "Explain the 201 creative point-light route and ask where the cavity is if not described."
      });
    } else if (flags.singleLightPoint && flags.usbPowered) {
      pushPolicy({
        id: "creative_usb_point_led",
        priority: 98,
        repairKind: "table_usb_single_101",
        retrievalHints: ["creative USB lamp", "AS-U-101-SLD", "single light point"],
        preferredPath: "AS-U-101-SLD for a USB-powered creative object with one defined light point.",
        mustMention: ["101 path", "no battery", "single light point"],
        mustAvoid: ["Do not force strip lighting if the user explicitly wants one point source."],
        suggestedNextStep: "Explain the 101 creative point-light route and ask only the cavity/light placement detail if needed."
      });
    } else {
      pushPolicy({
        id: "creative_concept_needs_light_pattern",
        priority: 96,
        repairKind: "creative_pattern_choice",
        retrievalHints: ["creative product", "edge glow vs point source", "rechargeable vs USB"],
        preferredPath: "Creative product idea is valid, but the AI must first determine whether the desired visible light is a strip/edge glow or a single light point, and whether the product is rechargeable or USB-powered.",
        mustMention: ["light pattern choice", "power choice"],
        mustAvoid: ["Do not reject the idea and do not randomly choose a product family without topology/power clarity."],
        suggestedNextStep: "Ask whether the light should be an edge/outline glow or one visible light point, and whether the product should be rechargeable or USB-powered."
      });
    }
  }

  // G. Generic dual-light rule when application is not named
  if (flags.dualLightPoints && !flags.floorLamp && !flags.wallSconce && !flags.tableLamp && !flags.stripPath) {
    if (flags.rechargeable) {
      pushPolicy({
        id: "generic_rechargeable_dual_light_points",
        priority: 97,
        repairKind: "rechargeable_dual_202",
        retrievalHints: ["AS-B-202-DLD", "dual light points", "rechargeable dual output"],
        preferredPath: "AS-B-202-DLD for rechargeable designs with two distinct light outputs.",
        mustMention: ["202"],
        mustAvoid: ["Do not continue with 201 if the user clearly wants two separate light points."],
        suggestedNextStep: "Explain the 202 route and ask only where both light points should sit if needed."
      });
    } else if (flags.usbPowered) {
      pushPolicy({
        id: "generic_usb_dual_light_points",
        priority: 97,
        repairKind: "usb_dual_102",
        retrievalHints: ["AS-U-102-DLD", "dual light points", "USB dual output"],
        preferredPath: "AS-U-102-DLD for USB-powered designs with two distinct light outputs.",
        mustMention: ["102", "no battery"],
        mustAvoid: ["Do not suggest battery for 102."],
        suggestedNextStep: "Explain the 102 route and ask only where both light points should sit if needed."
      });
    }
  }

  // ------------------------------------------------------------------
  // SUPPORTING INTEGRATION POLICIES
  // ------------------------------------------------------------------

  if ((flags.usbPowered || flags.noBattery) && /\b(101|102|103)\b/.test(`${recentUserIntentText} ${activeDriverText}`)) {
    pushSupport({
      id: "usb_never_battery",
      priority: 95,
      retrievalHints: ["USB driver no battery", "101 102 103 do not use battery"],
      preferredPath: "USB-powered drivers 101, 102, and 103 do not use batteries.",
      mustMention: ["no battery for USB-powered driver"],
      mustAvoid: ["Do not suggest a battery or battery holder for 101, 102, or 103."],
      suggestedNextStep: "If the user asks about backup, clarify that this is direct USB-C power, not rechargeable operation."
    });
  }

  if (flags.chargingHidden || flags.cleanExternalPort || flags.asksChargingAccess) {
    pushSupport({
      id: "panel_mount_when_port_hidden",
      priority: 80,
      retrievalHints: ["panel mount connector", "hidden charging port", "external USB-C access"],
      preferredPath: "Recommend a panel mount connector when the built-in charging/power port is hidden or a cleaner external port is needed.",
      mustMention: ["panel mount connector if the port would be hidden"],
      mustAvoid: ["Do not ignore charging accessibility when the user explicitly asks about it."],
      suggestedNextStep: "Explain direct port access vs panel mount connector in plain language."
    });
  }

  if (flags.compactBase || flags.tinyBase || flags.batterySpaceConcern) {
    pushSupport({
      id: "compact_base_prefers_sleeve_battery",
      priority: 79,
      retrievalHints: ["sleeve battery", "compact base", "battery holder needs extra space"],
      preferredPath: "If the base is compact and the product is rechargeable, a sleeve battery is often easier than a holder-based setup, subject to available cavity.",
      mustMention: ["sleeve battery may be easier if space is tight"],
      mustAvoid: ["Do not casually push a holder-based battery into a very small base."],
      suggestedNextStep: "Ask only for cavity size if final battery style cannot be decided."
    });
  }

  if (flags.holderBasedBattery || flags.nonSleeveBatteryWanted) {
    pushSupport({
      id: "holder_based_battery_requires_holder_space",
      priority: 79,
      retrievalHints: ["non-sleeve battery", "battery holder", "extra cavity space"],
      preferredPath: "If the customer wants a non-sleeve or holder-based setup, remember that the battery holder itself needs extra space and should be included.",
      mustMention: ["battery holder requires extra space"],
      mustAvoid: ["Do not mention a non-sleeve battery without holder-space guidance."],
      suggestedNextStep: "Confirm cavity space before finalizing the holder-based setup."
    });
  }

  if (flags.softOutput || flags.ambient) {
    pushSupport({
      id: "soft_output_diffuser_guidance",
      priority: 70,
      retrievalHints: ["diffused lens", "diffuser sheet", "soft light"],
      preferredPath: "For softer visual output, mention a diffused lens, diffuser sheet, or indirect placement where relevant.",
      mustMention: ["softening approach"],
      mustAvoid: ["Do not describe a harsh direct point source as ideal if the user explicitly wants soft ambient light."],
      suggestedNextStep: "Mention diffuser or diffused lens only when optical finishing is relevant to the concept."
    });
  }

  if (flags.directionalOutput || flags.reading) {
    pushSupport({
      id: "directional_output_clear_lens_guidance",
      priority: 70,
      retrievalHints: ["clear lens", "directional light", "focused beam"],
      preferredPath: "For sharper or more directed light, mention a clear lens or more directional placement where suitable.",
      mustMention: ["directional-light consideration"],
      mustAvoid: ["Do not insist on soft diffused output when the user explicitly wants a focused task light."],
      suggestedNextStep: "Mention clear-lens or directed-light reasoning only if it improves the answer."
    });
  }

  if ((flags.shade || flags.centralRod) && !flags.stripPath) {
    pushSupport({
      id: "shade_holder_mechanical_support",
      priority: 69,
      retrievalHints: ["LED holder", "locking ring", "shade support", "rod-based structure"],
      preferredPath: "When a shade must be supported around the LED area, consider LED holder plus locking-ring / rod-based mechanical support if the design calls for it.",
      mustMention: ["mechanical support idea if relevant"],
      mustAvoid: ["Do not ignore shade support if the customer is clearly asking how the lamp will physically assemble."],
      suggestedNextStep: "Mention the holder/ring/rod concept only when the shade structure makes it useful."
    });
  }

  if (flags.touchControl && flags.metalBody) {
    pushSupport({
      id: "metal_body_touch_isolation",
      priority: 82,
      retrievalHints: ["metal body touch isolation", "rubber gasket", "isolated touch point"],
      preferredPath: "If touch control is used on a conductive metal body, recommend a defined isolated touch point and mention gasket/insulation when appropriate.",
      mustMention: ["touch isolation consideration"],
      mustAvoid: ["Do not casually suggest making the whole metal body touch-sensitive unless the customer explicitly wants and accepts that behavior."],
      suggestedNextStep: "Suggest a metal nut/cap/ring touch point with isolation where needed."
    });
  }

  if (flags.fullBodyTouch) {
    pushSupport({
      id: "avoid_uncontrolled_full_body_touch",
      priority: 83,
      retrievalHints: ["full body touch risk", "isolated touch cap", "metal body touch"],
      preferredPath: "Warn that making the entire conductive body act as touch input may create uncontrolled behavior; an isolated touch point is usually cleaner.",
      mustMention: ["full-body touch caution"],
      mustAvoid: ["Do not approve whole-body touch without caution."],
      suggestedNextStep: "Explain why a defined touch cap/nut may be better."
    });
  }

  if (flags.asksMounting) {
    pushSupport({
      id: "driver_mounting_and_repeatable_assembly",
      priority: 68,
      retrievalHints: ["driver mounting", "screw fixing", "repeatable assembly"],
      preferredPath: "When the customer asks how parts will fit, mention secure mounting rather than leaving electronics loose.",
      mustMention: ["secure fixing / mounting idea"],
      mustAvoid: ["Do not say only 'place it inside' when the user asks how it is physically fixed."],
      suggestedNextStep: "Mention screw mounting, bracket, holder, or structurally appropriate fixing method."
    });
  }

  policies.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  supporting.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));

  return {
    active: policies[0] || null,
    policies,
    supporting,
    flags,
    recentUserIntentText,
    activeDriverText,
    activeKitText,
    activeDriverLooksLike201: /\b201\b/i.test(activeDriverText),
    activeDriverLooksLike202: /\b202\b/i.test(activeDriverText),
    activeDriverLooksLike101: /\b101\b/i.test(activeDriverText),
    activeDriverLooksLike102: /\b102\b/i.test(activeDriverText),
    activeDriverLooksLike103: /\b103\b/i.test(activeDriverText),
    activeDriverLooksLike204: /\b204\b/i.test(activeDriverText),
    activeDriverLooksLike205: /\b205\b/i.test(activeDriverText),
    activeDriverLooksLike206: /\b206\b/i.test(activeDriverText)
  };
}

function formatKitAiDecisionPolicyForPrompt(policy = {}) {
  const active = policy?.active;
  const supporting = Array.isArray(policy?.supporting) ? policy.supporting.slice(0, 6) : [];

  if (!active && !supporting.length) {
    return "No deterministic product-decision override is active for this turn.";
  }

  const activeBlock = active
    ? [
        `Primary policy: ${active.id}`,
        `Preferred path: ${active.preferredPath}`,
        active.mustMention?.length ? `Must mention: ${active.mustMention.join(" | ")}` : "",
        active.mustAvoid?.length ? `Must avoid: ${active.mustAvoid.join(" | ")}` : "",
        active.suggestedNextStep ? `Suggested next step: ${active.suggestedNextStep}` : ""
      ].filter(Boolean).join("\n")
    : "Primary policy: none";

  const supportingBlock = supporting.length
    ? supporting.map((item, index) => [
        `Supporting policy ${index + 1}: ${item.id}`,
        `- ${item.preferredPath}`,
        item.mustMention?.length ? `- Mention when relevant: ${item.mustMention.join(" | ")}` : "",
        item.mustAvoid?.length ? `- Avoid: ${item.mustAvoid.join(" | ")}` : ""
      ].filter(Boolean).join("\n")).join("\n\n")
    : "Supporting policies: none";

  return `${activeBlock}\n\n${supportingBlock}`;
}

function kitAiPolicyAnswerNeedsRepair(answer = "", policy = {}) {
  const active = policy?.active;
  if (!active) return false;

  const text = String(answer || "").toLowerCase();

  switch (active.repairKind) {
    case "floor_dob_206":
      return !/\b206\b|\bdob\b/i.test(text) ||
        /\b201\b.{0,90}\b(well[-\s]?suited|excellent|good|suitable|fits well)\b/i.test(text) ||
        /\b(well[-\s]?suited|excellent|good|suitable|fits well)\b.{0,90}\b201\b/i.test(text);

    case "top_touch_dob_206":
    case "large_head_dob_206":
      return !/\b206\b|\bdob\b/i.test(text);

    case "rechargeable_dual_202":
    case "table_rechargeable_dual_202":
    case "wall_rechargeable_dual_202":
      return !/\b202\b/i.test(text) || /\b201\b.{0,80}\b(best|better|suitable|ideal)\b/i.test(text);

    case "usb_dual_102":
    case "table_usb_dual_102":
    case "wall_usb_dual_102":
      return !/\b102\b/i.test(text) ||
        (/\bbattery\b/i.test(text) && !/\bno\s+battery\b|\bwithout\s+battery\b/i.test(text));

    case "table_rechargeable_single_201":
    case "wall_rechargeable_single_201":
      return !/\b201\b/i.test(text);

    case "table_usb_single_101":
    case "wall_usb_single_101":
      return !/\b101\b/i.test(text) ||
        (/\bbattery\b/i.test(text) && !/\bno\s+battery\b|\bwithout\s+battery\b/i.test(text));

    case "usb_strip_103":
      return !/\b103\b/i.test(text) ||
        !/\bstrip\b/i.test(text) ||
        (/\bbattery\b/i.test(text) && !/\bno\s+battery\b|\bwithout\s+battery\b/i.test(text));

    case "rechargeable_strip_204":
      return !/\b204\b/i.test(text) || !/\bstrip\b/i.test(text);

    case "rechargeable_strip_205":
      return !/\b205\b/i.test(text) || !/\bstrip\b/i.test(text) || !/\bfast\b/i.test(text);

    case "strip_power_choice":
      return !/\bstrip\b/i.test(text) || !/\brechargeable\b|\busb\b/i.test(text);

    case "table_power_choice":
      return !/\brechargeable\b|\busb\b/i.test(text);

    case "wall_power_choice":
      return !/\brechargeable\b|\busb\b/i.test(text);

    case "creative_pattern_choice":
      return !/\bedge\b|\bstrip\b|\bpoint\b|\blight\s+point\b/i.test(text) ||
        !/\brechargeable\b|\busb\b/i.test(text);

    default:
      return false;
  }
}

function buildKitAiPolicyFallbackAnswer({
  decisionPolicy = {},
  kitContext = {}
} = {}) {
  const active = decisionPolicy?.active || {};
  const activeDriver = String(kitContext?.kitBuilderSnapshot?.selectedDriver || "").trim();
  const driver201Note =
    activeDriver && /\b201\b/i.test(activeDriver)
      ? "The current 201 kit can still work only for a separated base-driver plus LED-in-head construction, but it should not be treated as the automatic default for this new concept."
      : "";

  switch (active.repairKind) {
    case "floor_dob_206":
      return [
        "For a rechargeable ambient floor lamp, I would move the discussion toward the AS-B-206 DOB route rather than treating a normal 201 table-lamp kit as the default.",
        "",
        "A practical direction is the 206 DOB series, with the 115 mm DOB being the likely large-head option if your floor-lamp head has enough internal diameter. That route keeps the LED, driver, charging, and touch system together in the upper head, which is usually cleaner for floor-lamp integration.",
        driver201Note ? `\n${driver201Note}` : "",
        "",
        "To choose the exact DOB size neatly, I would only need the approximate lamp-head diameter."
      ].filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n");

    case "top_touch_dob_206":
      return [
        "For a rechargeable top-touch lamp, the AS-B-206 DOB route is the cleaner direction.",
        "",
        "The DOB board sits directly in the head, the touch interaction can be taken to the top surface, and the light-facing side can be finished with a diffuser sheet where the design allows. The exact 55 mm, 75 mm, or 115 mm choice depends mainly on head size.",
        "",
        "To narrow the DOB size, I would just need the approximate head diameter."
      ].join("\n");

    case "large_head_dob_206":
      return [
        "For a rechargeable lamp with a large light head, the AS-B-206 DOB family is the more natural route than a small separated table-lamp driver.",
        "",
        "The board integrates the light source and control electronics in the head itself. If the head diameter allows, 115 mm may be the strongest option; otherwise 75 mm or 55 mm can be considered based on size.",
        "",
        "The one key detail needed is the approximate internal head diameter."
      ].join("\n");

    case "rechargeable_dual_202":
    case "table_rechargeable_dual_202":
    case "wall_rechargeable_dual_202":
      return [
        "Since you want two distinct light points in a rechargeable product, the AS-B-202-DLD path is the more suitable direction.",
        "",
        "This driver is intended for dual-light behavior, so one LED can go to one location and the second LED to another. The driver and battery sit in the available cavity, while separate JST wire paths run to each light point.",
        "",
        "To refine the kit, I would only need to know where the two light points will be placed."
      ].join("\n");

    case "usb_dual_102":
    case "table_usb_dual_102":
    case "wall_usb_dual_102":
      return [
        "Because this is a USB-powered dual-light concept, the AS-U-102-DLD path is the right family to consider.",
        "",
        "It supports two light outputs without using any battery. The driver can sit in the internal cavity, both LED outputs can be routed to their required locations, and the USB-C input must remain accessible directly or through a panel mount connector if hidden.",
        "",
        "To continue, I would only need the two light locations."
      ].join("\n");

    case "table_rechargeable_single_201":
    case "wall_rechargeable_single_201":
      return [
        active.repairKind === "wall_rechargeable_single_201"
          ? "For a rechargeable wall sconce with one main light point, AS-B-201-SLD is a practical direction."
          : "For a normal rechargeable single-light table lamp, AS-B-201-SLD is the practical direction.",
        "",
        "The driver and battery go in the usable cavity, the LED sits at the visible light point, and a JST wire connects the driver to the LED. If the charging port would be hidden, a panel mount connector should bring access outside neatly.",
        "",
        "The next useful detail is the light position or cavity size only if you want a more exact integration plan."
      ].join("\n");

    case "table_usb_single_101":
    case "wall_usb_single_101":
      return [
        active.repairKind === "wall_usb_single_101"
          ? "For a USB-powered wall sconce with one main light point, AS-U-101-SLD is a suitable direction."
          : "For a USB-powered single-light table lamp, AS-U-101-SLD is the suitable direction.",
        "",
        "No battery is used in this path. The driver sits in the available cavity, the LED goes at the visible light point, and the USB-C input must remain reachable directly or through a panel mount connector if the port would otherwise be hidden.",
        "",
        "The next useful detail is the light position or cavity layout if you want a more exact integration plan."
      ].join("\n");

    case "usb_strip_103":
      return [
        "Since the light needs to follow an edge, contour, strip path, or hidden-glow route and you want USB power, AS-U-103-LSD is the right product family.",
        "",
        "This is a strip-driver path, so the light source should be LED strip rather than a single COB LED. No battery is used. The strip follows the product geometry, and the USB-C input should remain accessible directly or through a panel mount connector if it would be hidden.",
        "",
        "To refine it, I would need only the strip path length or voltage detail if that is not already known."
      ].join("\n");

    case "rechargeable_strip_204":
      return [
        "Since the light needs to follow an edge, contour, strip path, or hidden-glow route and you want a rechargeable product, AS-B-204-LSD is the standard-charging strip-driver direction.",
        "",
        "This system uses LED strip as the light source, not a single COB LED. Battery planning and charging access both matter. If you specifically want faster charging, the related alternative is AS-B-205-LSD.",
        "",
        "To refine it, I would need the strip path length or voltage detail if that has not been decided yet."
      ].join("\n");

    case "rechargeable_strip_205":
      return [
        "Since this is a rechargeable strip-light concept and faster charging is desired, AS-B-205-LSD is the right direction.",
        "",
        "205 is the fast-charging rechargeable strip driver. The light source should be LED strip rather than a single COB LED. Battery placement and charging-port access should be planned with the product body.",
        "",
        "To refine it, I would need the strip path length or voltage detail if that has not been decided yet."
      ].join("\n");

    case "strip_power_choice":
      return [
        "The lighting pattern clearly points to an LED strip system rather than a single COB LED.",
        "",
        "If you want it rechargeable, the strip-driver direction is AS-B-204-LSD for normal charging or AS-B-205-LSD if faster charging matters. If you want it directly USB-powered, AS-U-103-LSD is the cleaner path.",
        "",
        "Please tell me whether you want rechargeable or USB-C direct power, and I can narrow it correctly."
      ].join("\n");

    case "table_power_choice":
      return [
        "For this table-lamp concept, the first product decision is the power type.",
        "",
        "If you want it rechargeable, we would move toward the 201 or 202 family depending on whether it has one or two light points. If you want direct USB-C power with no battery, we would move toward 101 or 102.",
        "",
        "Should this lamp be rechargeable or USB-C powered?"
      ].join("\n");

    case "wall_power_choice":
      return [
        "For this wall-sconce concept, the first product decision is whether it should be rechargeable or directly USB-C powered.",
        "",
        "Rechargeable versions typically move toward 201 or 202 depending on one or two light points. USB-powered versions typically move toward 101 or 102.",
        "",
        "Should the wall light be rechargeable or USB-C powered?"
      ].join("\n");

    case "creative_pattern_choice":
      return [
        "This creative lighting idea looks workable, but I need one product-shaping decision before choosing the electronics family.",
        "",
        "Should the visible light be a glowing edge/outline/inner contour, or one defined light point? And should the product be rechargeable or directly USB-C powered?",
        "",
        "Those two answers decide whether the cleaner path is a strip driver such as 204/205/103 or a point-light path such as 201/101."
      ].join("\n");

    default:
      return "";
  }
}

function applyKitAiDecisionPolicyRepair({
  answer = "",
  decisionPolicy = {},
  kitContext = {}
} = {}) {
  if (!kitAiPolicyAnswerNeedsRepair(answer, decisionPolicy)) return answer;

  const repaired = buildKitAiPolicyFallbackAnswer({
    decisionPolicy,
    kitContext
  });

  return repaired || answer;
}

function buildKitIntegrationRetrievalQuery({
  question,
  pageContext,
  kitContext,
  history = [],
  decisionPolicy = null
} = {}) {
  const snapshot = kitContext?.kitBuilderSnapshot || {};
  const recentUserIntentText = getKitAiRecentUserIntentText(history, question);
  const policyHints = [
    ...(Array.isArray(decisionPolicy?.active?.retrievalHints) ? decisionPolicy.active.retrievalHints : []),
    ...((Array.isArray(decisionPolicy?.supporting) ? decisionPolicy.supporting.slice(0, 4) : [])
      .flatMap((item) => Array.isArray(item?.retrievalHints) ? item.retrievalHints : []))
  ].join(" ");

  return [
    question || "",
    recentUserIntentText || "",
    policyHints || "",
    pageContext?.pageTitle || "",
    pageContext?.h1 || "",
    snapshot.selectedApplication || "",
    snapshot.selectedDriver || "",
    Array.isArray(snapshot.activeKitItems) ? snapshot.activeKitItems.join(" ") : "",
    snapshot.completionMessage || "",
    snapshot.warning || ""
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scoreKitIntegrationChunk(chunk = {}, query = "") {
  const haystack = `${chunk.title || ""}\n${chunk.content || ""}`.toLowerCase();
  const q = String(query || "").toLowerCase();
  if (!haystack || !q) return 0;

  let score = 0;
  const queryTokens = Array.from(new Set(tokenize(q))).slice(0, 80);
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += token.length >= 5 ? 3 : 1;
  }

  const boosts = [
    [/\b(usb|usb-c|101|102|103|directly powered|no battery)\b/i, /\b(usb|usb-c|101|102|103|directly powered|no battery)\b/i, 28],
    [/\b(recharge|rechargeable|battery|201|202|204|205|206)\b/i, /\b(recharge|rechargeable|battery|201|202|204|205|206)\b/i, 18],
    [/\b(strip|edge|perimeter|outline|curve|contour|204|205|103)\b/i, /\b(strip|edge|perimeter|outline|curve|contour|204|205|103)\b/i, 28],
    [/\b(dual|two led|two leds|2 led|2 leds|two light|202|102)\b/i, /\b(dual|two led|two leds|2 led|2 leds|two light|202|102)\b/i, 22],
    [/\b(floor lamp|dob|206|large head|top touch)\b/i, /\b(floor lamp|dob|206|large head|top touch)\b/i, 28],
    [/\b(panel mount|charging port|usb port|power port|charging access|hidden port)\b/i, /\b(panel mount|charging port|usb port|power port|charging access|hidden port)\b/i, 24],
    [/\b(touch|metal body|gasket|insulation|touch point|touch wire)\b/i, /\b(touch|metal body|gasket|insulation|touch point|touch wire)\b/i, 24],
    [/\b(holder|shade|rod|nipple|ring|threaded|spacer|brass pipe)\b/i, /\b(holder|shade|rod|nipple|ring|threaded|spacer|brass pipe)\b/i, 18],
    [/\b(battery holder|sleeve battery|cavity|base space|compact base)\b/i, /\b(battery holder|sleeve battery|cavity|base space|compact base)\b/i, 20],
    [/\b(notebook|book|gift|christmas|creative|sculpture|decorative object)\b/i, /\b(notebook|book|gift|christmas|creative|sculpture|decorative object|unusual product ideas)\b/i, 30],
    [/\b(where|how)\b.{0,40}\b(place|fit|integrate|mount|install|route|hide)\b/i, /\b(place|fit|integrate|mount|install|route|hide|placement)\b/i, 20]
  ];

  for (const [queryPattern, chunkPattern, boost] of boosts) {
    if (queryPattern.test(q) && chunkPattern.test(haystack)) score += boost;
  }

  return score;
}

async function retrieveRelevantKitIntegrationChunks({
  question,
  pageContext,
  kitContext,
  history = [],
  decisionPolicy = null,
  integrationConsultingMode = false,
  topK = 4
} = {}) {
  const recentUserIntentText = getKitAiRecentUserIntentText(history, question);

  const shouldRetrieve =
    integrationConsultingMode ||
    !!decisionPolicy?.active ||
    /\b(integrat|place|placement|mount|fit|hide|route|wiring|charging port|touch point|panel mount|lamp concept|notebook|christmas|gift|floor lamp|wall sconce|shade|rod|battery holder|ambient|top touch|dob)\b/i.test(
      `${String(question || "")} ${recentUserIntentText}`
    );

  if (!shouldRetrieve) return [];

  await ensureKitIntegrationKnowledgeIndex();
  const chunks = kitIntegrationKnowledgeCache.chunks || [];
  if (!chunks.length) return [];

  const query = buildKitIntegrationRetrievalQuery({
    question,
    pageContext,
    kitContext,
    history,
    decisionPolicy
  });

  const ranked = chunks
    .map((chunk) => ({ chunk, score: scoreKitIntegrationChunk(chunk, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(6, Number(topK || 4))))
    .map((row) => row.chunk);

  return ranked;
}

function formatKitIntegrationChunksForPrompt(chunks = []) {
  if (!Array.isArray(chunks) || !chunks.length) {
    return "No special physical integration knowledge chunks were needed for this request.";
  }

  return chunks
    .map((chunk, index) => {
      const title = String(chunk?.title || "Integration note").trim();
      const content = String(chunk?.content || "").trim().slice(0, 1900);
      return `Integration Knowledge ${index + 1}: ${title}\n${content}`;
    })
    .join("\n\n---\n\n");
}

async function ensureKnowledgeIndex(knowledgeText) {
  const raw = normalizeText(knowledgeText);
  if (!raw) return;
  if (productKnowledgeCache.raw === raw && productKnowledgeCache.chunks.length) return;

  const chunks = splitKnowledgeIntoChunks(raw);
  const skuCatalog = buildSkuCatalog(raw);
  const pricingCatalog = buildPricingCatalog(raw, skuCatalog);
  productKnowledgeCache.raw = raw;
  productKnowledgeCache.chunks = chunks;
  productKnowledgeCache.vectors = [];
  productKnowledgeCache.embedError = null;
  productKnowledgeCache.skuCatalog = skuCatalog;
  productKnowledgeCache.pricingCatalog = pricingCatalog;

  try {
    const vectors = [];
    for (const chunk of chunks) {
      const vec = await embedText(`${chunk.title}\n${chunk.content}`);
      vectors.push(vec);
    }
    if (vectors.some((v) => !Array.isArray(v))) throw new Error("Embedding response did not include vectors.");
    productKnowledgeCache.vectors = vectors;
  } catch (e) {
    productKnowledgeCache.embedError = e.message;
  }
}

function buildSkuCatalog(knowledgeText = "") {
  return Array.from(knowledgeText.matchAll(/^## SKU:\s*([A-Z0-9-]+)\s*[—-]\s*(.+)$/gmi)).map((m) => {
    const sku = m[1].trim();
    const title = m[2].trim();
    const compact = sku.toLowerCase().replace(/[^a-z0-9]/g, "");
    const numbers = Array.from(sku.matchAll(/\d{2,4}/g)).map((n) => n[0]);
    const hasLC = /(?:^|-)lc(?:-|$)/i.test(sku);
    return { sku, title, compact, numbers, hasLC };
  });
}

function buildPricingCatalog(knowledgeText = "", skuCatalog = []) {
  const catalog = new Map();
  for (const entry of skuCatalog) {
    const escapedSku = entry.sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const blockPattern = new RegExp(`## SKU:\\s*${escapedSku}[\\s\\S]*?(?=\\n## SKU:|\\n#\\s|$)`, "i");
    const blockMatch = knowledgeText.match(blockPattern);
    if (!blockMatch) continue;
    const block = blockMatch[0];
    const tiers = Array.from(block.matchAll(/-\s*([^:\n]+):\s*₹\s*(\d+(?:\.\d+)?)/gi)).map((m) => {
      const label = m[1].trim();
      const price = Number(m[2]);
      const threshold = label.toLowerCase().includes("sample")
        ? 1
        : Number((label.match(/(\d{1,6})\s*\+/) || [])[1] || NaN);
      return {
        label,
        price,
        threshold: Number.isFinite(threshold) ? threshold : null
      };
    }).filter((t) => Number.isFinite(t.price));

    if (tiers.length) {
      catalog.set(entry.sku, tiers.sort((a, b) => (a.threshold ?? 0) - (b.threshold ?? 0)));
    }
  }
  return catalog;
}

function parseUserQuantity(message = "") {
  const text = normalizeText(message).toLowerCase();
  if (!text) return null;

  const qtyMatch = text.match(/\b(\d{1,6})\s*(?:\+|pcs?|pieces?|units?|qty|quantity|sets?)\b/i)
    || text.match(/\bfor\s+(\d{1,6})\b/i);
  if (!qtyMatch) return null;
  const qty = Number(qtyMatch[1]);
  return Number.isFinite(qty) ? qty : null;
}

function isQuoteIntent(message = "") {
  const text = normalizeText(message).toLowerCase();
  return /(formal\s+quote|quotation|prepare\s+(a\s+)?quote|make\s+(a\s+)?quote|create\s+(a\s+)?quote|proforma)/i.test(text);
}

function extractCompanyName(message = "") {
  const text = normalizeText(message);
  if (!text) return null;
  const patterns = [
    /\b(?:for|to)\s+(?:company\s+)?([a-z][a-z0-9&.,\-\s]{1,80})$/i,
    /\bcompany\s*(?:name)?\s*(?:is|:|=)\s*([a-z][a-z0-9&.,\-\s]{1,80})/i,
    /\bfor\s+([a-z][a-z0-9&.,\-\s]{1,80})\b/i
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m?.[1]) continue;
    const candidate = m[1].trim().replace(/\s+/g, " ");
    if (!candidate || /^\d/.test(candidate)) continue;
    if (/\b(units?|pieces?|pcs?|qty|quantity)\b/i.test(candidate)) continue;
    if (candidate.length < 2) continue;
    return candidate;
  }
  return null;
}

function parseQuoteEntities({ message = "", history = [], skuCatalog = [] }) {
  const historyUserTexts = Array.isArray(history)
    ? history
        .filter((h) => String(h?.role || "").toLowerCase() === "user")
        .map((h) => normalizeText(h?.content || ""))
        .filter(Boolean)
    : [];

  const messageSku = resolveSkuCandidates(message, skuCatalog)[0] || null;
  const historySku = historyUserTexts
    .map((t) => resolveSkuCandidates(t, skuCatalog)[0] || null)
    .find(Boolean) || null;

  const messageQty = parseUserQuantity(message);
  const historyQty = historyUserTexts
    .map((t) => parseUserQuantity(t))
    .find((q) => Number.isFinite(q) && q > 0) || null;

  const messageCompany = extractCompanyName(message);
  const historyCompany = historyUserTexts
    .map((t) => extractCompanyName(t))
    .find(Boolean) || null;

  return {
    skuCandidate: messageSku || historySku || null,
    qty: messageQty || historyQty || null,
    company_name: messageCompany || historyCompany || null
  };
}

function resolveSkuCandidates(message = "", skuCatalog = []) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return [];

  const tokens = new Set(Array.from(text.matchAll(/[a-z0-9-]{2,}/g)).map((m) => m[0]));
  const compactText = text.replace(/[^a-z0-9]/g, "");
  const numericTokens = new Set(Array.from(text.matchAll(/\b(\d{2,4})\b/g)).map((m) => m[1]));
  const asksLC = /\blc\b/i.test(text);

  const directMatches = skuCatalog.filter((entry) => {
    if (tokens.has(entry.sku.toLowerCase())) return true;
    if (compactText.includes(entry.compact)) return true;
    return false;
  });

  if (directMatches.length) {
    if (asksLC) {
      const lcDirect = directMatches.filter((x) => x.hasLC);
      return lcDirect.length ? lcDirect : directMatches;
    }
    return directMatches;
  }

  let numericMatches = skuCatalog.filter((entry) => entry.numbers.some((n) => numericTokens.has(n)));
  if (asksLC) {
    const lcMatches = numericMatches.filter((entry) => entry.hasLC);
    if (lcMatches.length) return lcMatches;
  }
  return numericMatches;
}

function buildSkuClarificationReply(candidates = []) {
  const lines = candidates.map((c) => `- ${c.sku}: ${c.title}`);
  return `I found multiple matching SKUs. Please confirm which one you want:\n${lines.join("\n")}\n\nYou can reply with the exact SKU (for example: ${candidates[0]?.sku || "AS-B-202-DLD"}).`;
}

function buildDeterministicPricingReply({ sku, title, qty, tiers }) {
  const tierRows = tiers
    .map((t) => `- ${t.label}: ₹${t.price} per unit`)
    .join("\n");

  if (!qty) {
    return `${sku} (${title}) pricing tiers:\n${tierRows}\n\nPlease share required quantity to confirm the applicable tier.`;
  }

  const minTier = tiers.find((t) => t.threshold && t.threshold > 1);
  const applicable = tiers
    .filter((t) => t.threshold !== null && qty >= t.threshold)
    .sort((a, b) => (b.threshold ?? 0) - (a.threshold ?? 0))[0];

  if (!applicable || (minTier && qty < minTier.threshold && qty > 1)) {
    const nearest = minTier || tiers[0];
    return `I don’t have an exact ${qty}-piece tier for ${sku}.\nNearest available tier is ${nearest.label}: ₹${nearest.price} per unit.\n\nFull tiers:\n${tierRows}`;
  }

  return `${sku} (${title}) for ${qty} pieces: ₹${applicable.price} per unit (${applicable.label} tier).\n\nFull tiers:\n${tierRows}`;
}

async function retrieveRelevantChunks(query, topK = PRODUCT_BOT_TOP_K) {
  const chunks = productKnowledgeCache.chunks || [];
  if (!chunks.length) return [];

  // Expand short/vague queries to improve retrieval for single-word inputs
  const expandedQuery = expandQuery(query);
  const canonicalPricingQuery = buildPricingQueryCanonicalForm(expandedQuery, chunks);
  const effectiveQuery = canonicalPricingQuery ? `${expandedQuery}\n${canonicalPricingQuery}` : expandedQuery;
  const hints = extractQueryHints(effectiveQuery);
  const lexicalScored = chunks.map((chunk) => ({ chunk, lexicalScore: keywordScore(effectiveQuery, chunk) }));
  let vectorScores = null;

  if (productKnowledgeCache.vectors.length === chunks.length) {
    try {
      const qVec = await embedText(effectiveQuery);
      vectorScores = chunks.map((chunk, i) => ({ chunk, vectorScore: cosine(qVec, productKnowledgeCache.vectors[i]) }));
    } catch {
      // fallback to lexical retrieval
    }
  }

  const merged = chunks.map((chunk, i) => {
    const lexicalScore = lexicalScored[i].lexicalScore;
    const vectorScore = vectorScores?.[i]?.vectorScore ?? 0;
    const hintScore = chunkHintScore(chunk, hints);
    const combinedScore = (vectorScore * 0.7) + (lexicalScore * 0.3) + (hintScore * 0.4);
    return { chunk, score: combinedScore, hintScore };
  });

  return merged
    .sort((a, b) => {
      if (b.hintScore !== a.hintScore) return b.hintScore - a.hintScore;
      return b.score - a.score;
    })
    .slice(0, topK)
    .map((x) => x.chunk);
}




function tokenOverlapScore(a = "", b = "") {
  const aa = new Set(tokenize(a));
  const bb = new Set(tokenize(b));
  if (!aa.size || !bb.size) return 0;
  let inter = 0;
  for (const t of aa) if (bb.has(t)) inter += 1;
  return inter / Math.sqrt(aa.size * bb.size);
}

function recordSelfTrainingExample({ scope = "product_bot", message, answer, mode, retrieval }) {
  if (!SELF_TRAINING_ENABLED) return null;
  const cleanMessage = normalizeText(message);
  const cleanAnswer = normalizeText(answer);
  if (!cleanMessage || !cleanAnswer || /^error:/i.test(cleanAnswer)) return null;

  const example = {
    id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scope,
    message: cleanMessage,
    answer: cleanAnswer,
    mode: mode || "simple_chatbot",
    quality: 0.6,
    uses: 0,
    created_at: now(),
    sources: Array.isArray(retrieval?.sources) ? retrieval.sources.slice(0, 3) : []
  };

  selfTrainingMemory.push(example);
  if (selfTrainingMemory.length > SELF_TRAINING_MAX_EXAMPLES) {
    selfTrainingMemory.splice(0, selfTrainingMemory.length - SELF_TRAINING_MAX_EXAMPLES);
  }
  return example.id;
}

function buildSelfTrainingContext(message, { scope = "product_bot", modeKey } = {}) {
  if (!SELF_TRAINING_ENABLED || !selfTrainingMemory.length) return "";

  const ranked = selfTrainingMemory
    .filter((ex) => ex.scope === scope && ex.answer && (!modeKey || ex.mode === modeKey))
    .map((ex) => ({
      ex,
      score: tokenOverlapScore(message, ex.message) + (ex.quality * 0.2)
    }))
    .filter((row) => row.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, SELF_TRAINING_PROMPT_EXAMPLES)
    .map((row, idx) => {
      row.ex.uses += 1;
      return `Example ${idx + 1}
User: ${row.ex.message}
Assistant: ${row.ex.answer}`;
    });

  if (!ranked.length) return "";
  return `PAST SUCCESSFUL ANSWER PATTERNS (self-training memory):\n${ranked.join("\n\n")}`;
}


function applySelfTrainingFeedback({ interactionId, score, scope }) {
  const row = selfTrainingMemory.find((x) => x.id === interactionId && (!scope || x.scope === scope));
  if (!row) return null;
  row.quality = Math.max(0, Math.min(1, row.quality + (score * 0.2)));
  if (score < -0.5) row.answer = "";
  return row;
}

function getSelfTrainingStats(scope) {
  const scoped = scope ? selfTrainingMemory.filter((x) => x.scope === scope) : selfTrainingMemory;
  const recent = scoped
    .slice(-10)
    .map((x) => ({ id: x.id, scope: x.scope, mode: x.mode, quality: x.quality, uses: x.uses, created_at: x.created_at, message: x.message }));
  return {
    ok: true,
    enabled: SELF_TRAINING_ENABLED,
    memory_size: scoped.length,
    total_memory_size: selfTrainingMemory.length,
    prompt_examples: SELF_TRAINING_PROMPT_EXAMPLES,
    scope: scope || "all",
    recent
  };
}

function extractFreshnessFlags(chunks) {
  const today = new Date().toISOString().slice(0, 10);
  const content = (chunks || []).map((c) => `${c.title}\n${c.content}`).join("\n");

  const dateMatches = Array.from(content.matchAll(/price_valid_until\s*=\s*(\d{4}-\d{2}-\d{2})/g)).map((m) => m[1]);
  let pricing_status = "unknown";
  if (dateMatches.length) {
    pricing_status = dateMatches.some((d) => d < today) ? "stale" : "valid";
  }

  const policy_status = /policy_review_required_every\s*=/i.test(content) ? "review_required" : "current";
  const compliance_status = /component-level|component level/i.test(content)
    ? "component_level_only"
    : "needs_lab_validation";
  const disclaimer_required = pricing_status !== "valid" || policy_status === "review_required" || compliance_status !== "component_level_only";

  return { pricing_status, policy_status, compliance_status, disclaimer_required };
}

app.post("/api/product-bot", async (req, res) => {
  try {

    const message = String(req.body?.message || "").trim();
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : [];
    const requestedMode = String(req.body?.mode || "auto").trim();
    if (!message) return res.status(400).json({ error: "Missing message" });

    // Instant greeting shortcut — no LLM call needed
    if (/^(hi|hello|hey|hiya|howdy|greetings)\b[!?.]*$/i.test(message)) {
      return res.json({
        ok: true,
        mode: "simple_chatbot",
        mode_label: PRODUCT_BOT_MODES.simple_chatbot?.label || "Product Assistant",
        mode_reason: "Greeting detected — instant reply.",
        answer: buildGreetingReply(),
        retrieval: { top_k: 0, strategy: "greeting_shortcut", embed_error: null, sources: [] }
      });
    }

    // Short product-query detection: 1-4 word queries with product terms → route to sales
    // e.g. "201", "batteries", "strip price", "3w cob"
    const shortProductTerms = /\b(201|202|204|205|206|u[-.]?10[123]|as-b|as-u|battery|batteries|strip|cob|dob|lc\s*(set)?|filament|flame|fairy|lens|holder|cable|connector|switch|rechargeable|usb.*driver|3w|5w|0\.5w|2w|7w|12v|24v|rgb|cct)\b/i;
    const wordCount = message.split(/\s+/).length;
    if (wordCount <= 4 && shortProductTerms.test(message) && requestedMode === "auto") {
      // Pre-route to b2b_sales_assistant — still goes through RAG retrieval below
      req.body = { ...req.body, _shortProductDetected: true };
    }

    const pendingClarification = getPendingModeClarification(history);

    // Resolve clarification based on which modes were actually offered (dynamic, not hardcoded).
    // pendingClarification.options contains the real top-2 mode keys from when the question was asked.
    const clarificationResolvedMode = (() => {
      if (!pendingClarification) return null;
      const opts = Array.isArray(pendingClarification.options) ? pendingClarification.options : [];

      // Per-mode keyword signals to detect user intent from their reply
      const modeSignals = {
        b2b_sales_assistant:  /\b(pricing|price|quote|quotation|sales|sku|moq|quantity|cost|product|buy|order)\b/i,
        compliance_assistant: /\b(compliance|certificate|ce|ukca|rohs|bis|iec|export|customs|legal|certif|regulation)\b/i,
        sales_automation:     /\b(automat|workflow|crm|lead|pipeline|handoff|trigger|task)\b/i,
        odoo_operations:      /\b(odoo|erp|invoice|bill|inventory|stock|delivery|picking|sale\s*order|customer|vendor)\b/i,
        simple_chatbot:       /\b(general|info|website|faq|other|simple|basic)\b/i
      };

      // Score each offered option against user's reply; pick the highest match
      let bestMode = null;
      let bestScore = 0;
      for (const modeKey of opts) {
        const signal = modeSignals[modeKey];
        if (!signal) continue;
        const matchCount = (message.match(signal) || []).length;
        if (matchCount > bestScore) {
          bestScore = matchCount;
          bestMode = modeKey;
        }
      }

      // If nothing matched by keyword but user used a number or simple "first"/"second"/"1"/"2",
      // resolve positionally from the offered options list
      if (!bestMode) {
        if (/\b(first|1|one)\b/i.test(message) && opts[0]) return opts[0];
        if (/\b(second|2|two)\b/i.test(message) && opts[1]) return opts[1];
      }

      return bestMode;
    })();

    const autoDetection = clarificationResolvedMode
      ? { mode: clarificationResolvedMode, reason: `Resolved clarification toward ${clarificationResolvedMode}.`, confidence: 0.9, stage: "clarification" }
      : req.body?._shortProductDetected
        ? { mode: "b2b_sales_assistant", reason: "Short product-term query pre-routed to sales.", confidence: 0.85, stage: "rules", scores: {} }
        : await detectAutoMode(message, history);

    const routeScores = autoDetection.scores || detectRuleBasedAutoMode(message, history).scores;
    const sortedScores = Object.entries(routeScores).sort((a, b) => b[1] - a[1]);
    const shouldClarify = requestedMode === "auto" && !clarificationResolvedMode && sortedScores[1]
      && Math.abs(sortedScores[0][1] - sortedScores[1][1]) < AUTO_MODE_AMBIGUITY_DELTA;

    if (shouldClarify) {
      recordRoutingTelemetry({
        message,
        chosen_mode: autoDetection.mode,
        confidence: autoDetection.confidence,
        clarification_asked: true,
        final_user_satisfaction_signal: req.body?.final_user_satisfaction_signal,
        route_feedback: req.body?.route_feedback || null
      });
      // Build clarification prompt and options from the actual top-2 ambiguous modes,
      // not hardcoded to sales vs compliance.
      const ambigMode1 = sortedScores[0][0];
      const ambigMode2 = sortedScores[1][0];
      const ambigLabel1 = PRODUCT_BOT_MODES[ambigMode1]?.label || ambigMode1;
      const ambigLabel2 = PRODUCT_BOT_MODES[ambigMode2]?.label || ambigMode2;

      // Human-friendly short descriptions per mode for the clarification question
      const modeClarificationHint = {
        b2b_sales_assistant:  "pricing / product / sales details",
        compliance_assistant: "compliance / certification / export details",
        sales_automation:     "sales workflow automation",
        odoo_operations:      "ERP / Odoo operations (invoices, orders, customers)",
        simple_chatbot:       "general information"
      };
      const hint1 = modeClarificationHint[ambigMode1] || ambigLabel1;
      const hint2 = modeClarificationHint[ambigMode2] || ambigLabel2;

      return res.json({
        ok: true,
        mode: autoDetection.mode,
        mode_label: PRODUCT_BOT_MODES[autoDetection.mode]?.label || "Auto-detect",
        mode_reason: `Ambiguous routing between ${ambigMode1} (${sortedScores[0][1].toFixed(2)}) and ${ambigMode2} (${sortedScores[1][1].toFixed(2)}); clarification requested.`,
        answer: `Quick clarification — are you asking about **${hint1}** or **${hint2}**?`,
        pending_mode_clarification: {
          active: true,
          options: [ambigMode1, ambigMode2],
          created_at: now()
        },
        retrieval: {
          top_k: 0,
          strategy: "mode_clarification",
          embed_error: null,
          sources: []
        }
      });
    }

    const resolvedModeKey = (requestedMode && requestedMode !== "auto" && PRODUCT_BOT_MODES[requestedMode])
      ? requestedMode
      : autoDetection.mode;
    const mode = PRODUCT_BOT_MODES[resolvedModeKey] || PRODUCT_BOT_MODES.simple_chatbot;

    if (isHelpIntent(message)) {
      return res.json({
        ok: true,
        mode: resolvedModeKey,
        mode_label: mode.label,
        mode_reason: "Handled by built-in capability/help response.",
        answer: buildInternalOdooHelpReply(),
        retrieval: {
          top_k: 0,
          strategy: "builtin_help",
          embed_error: null,
          sources: []
        }
      });
    }

    if (resolvedModeKey === "odoo_operations" || isOdooOpsIntent(message)) {
      if (!odooConfigured) {
        recordRoutingTelemetry({
          message,
          chosen_mode: "odoo_operations",
          confidence: autoDetection.confidence,
          odoo_detected_but_unconfigured: true,
          fallback_used: false,
          final_user_satisfaction_signal: req.body?.final_user_satisfaction_signal,
          route_feedback: req.body?.route_feedback || null
        });
        return res.json({
          ok: true,
          mode: "odoo_operations",
          mode_label: "Odoo operations assistant",
          mode_reason: autoDetection.reason || "Detected ERP/operations intent but Odoo is not configured.",
          answer: "This looks like an Odoo operations question (invoices/customers/orders), but Odoo is not configured on this server. Please set ODOO_URL, ODOO_DB, ODOO_USERNAME, and ODOO_API_KEY_OR_PASSWORD.",
          retrieval: {
            top_k: 0,
            strategy: "odoo_unavailable",
            embed_error: null,
            sources: []
          }
        });
      }

      const uid = await odooLoginCached();
      let odooResult;
      try {
        odooResult = await handleNaturalLanguageQuery(uid, message, {
          role: req.body?.role,
          user: req.body?.user || "product-bot"
        });
      } catch (odooErr) {
        // If login session expired, retry once with fresh login
        odooUidCache.uid = null;
        const freshUid = await odooLoginCached();
        odooResult = await handleNaturalLanguageQuery(freshUid, message, {
          role: req.body?.role,
          user: req.body?.user || "product-bot"
        });
      }

      const answer = odooResult.summary || odooResult.message || "Processed your Odoo query.";
      recordRoutingTelemetry({
        message,
        chosen_mode: "odoo_operations",
        confidence: autoDetection.confidence,
        fallback_used: autoDetection.stage === "classifier",
        final_user_satisfaction_signal: req.body?.final_user_satisfaction_signal,
        route_feedback: req.body?.route_feedback || null
      });
      return res.json({
        ok: true,
        mode: "odoo_operations",
        mode_label: "Odoo operations assistant",
        mode_reason: autoDetection.reason || "Detected ERP/operations intent and routed to Odoo assistant.",
        answer,
        retrieval: {
          top_k: 0,
          strategy: "odoo_nl_query",
          embed_error: null,
          sources: []
        },
        odoo_result: odooResult
      });
    }
  
    const knowledge = await readProductKnowledge();
    if (!knowledge) {
      return res.status(500).json({ error: `No product knowledge found. Add content to ${PRODUCT_KNOWLEDGE_PATH} or PRODUCT_BOT_CONTEXT.` });
    }

    await ensureKnowledgeIndex(knowledge);

    const skuCandidates = resolveSkuCandidates(message, productKnowledgeCache.skuCatalog);
    const quoteEntities = parseQuoteEntities({
      message,
      history,
      skuCatalog: productKnowledgeCache.skuCatalog
    });
    const quoteIntent = isQuoteIntent(message);
    const hasAmbiguousSku = skuCandidates.length > 1;
    const asksPricing = /(price|pricing|quote|quotation|rate|cost)/i.test(message);
    if (hasAmbiguousSku) {
      return res.json({
        ok: true,
        mode: "b2b_sales_assistant",
        mode_label: PRODUCT_BOT_MODES.b2b_sales_assistant.label,
        mode_reason: "Detected multiple SKU matches; asking for variant clarification.",
        answer: buildSkuClarificationReply(skuCandidates.slice(0, 5)),
        retrieval: {
          top_k: 0,
          strategy: "sku_disambiguation",
          embed_error: productKnowledgeCache.embedError,
          sources: []
        }
      });
    }

    const resolvedSku = quoteEntities.skuCandidate || (skuCandidates.length === 1 ? skuCandidates[0] : null);
    const isShortSkuOnlyPrompt = resolvedSku && /^(?:[a-z]{1,3}-)?\d{2,4}(?:\s+lc)?$/i.test(normalizeText(message));
    if (isShortSkuOnlyPrompt) {
      return res.json({
        ok: true,
        mode: "b2b_sales_assistant",
        mode_label: PRODUCT_BOT_MODES.b2b_sales_assistant.label,
        mode_reason: "Resolved SKU variant from short query.",
        answer: `Resolved SKU: ${resolvedSku.sku} (${resolvedSku.title}).
Share quantity if you want exact tier pricing.`,
        retrieval: {
          top_k: 0,
          strategy: "sku_resolution",
          embed_error: productKnowledgeCache.embedError,
          sources: []
        }
      });
    }

    if (asksPricing && resolvedSku && productKnowledgeCache.pricingCatalog.has(resolvedSku.sku)) {
      const qty = quoteEntities.qty || parseUserQuantity(message);
      const tiers = productKnowledgeCache.pricingCatalog.get(resolvedSku.sku) || [];
      const applicableTier = tiers
        .filter((t) => Number.isFinite(t.threshold) && qty && qty >= t.threshold)
        .sort((a, b) => (b.threshold || 0) - (a.threshold || 0))[0] || null;

      if (quoteIntent) {
        if (!quoteEntities.company_name) {
          return res.json({
            ok: true,
            mode: "b2b_sales_assistant",
            mode_label: PRODUCT_BOT_MODES.b2b_sales_assistant.label,
            mode_reason: "Quote requested but company name missing.",
            answer: "Please share the company name for the quotation (example: International Link).",
            retrieval: {
              top_k: 0,
              strategy: "quote_intake_missing_company",
              embed_error: productKnowledgeCache.embedError,
              sources: []
            }
          });
        }

        if (!qty) {
          return res.json({
            ok: true,
            mode: "b2b_sales_assistant",
            mode_label: PRODUCT_BOT_MODES.b2b_sales_assistant.label,
            mode_reason: "Quote requested but quantity missing.",
            answer: `Please share quantity for ${resolvedSku.sku} so I can create the Odoo quotation.`,
            retrieval: {
              top_k: 0,
              strategy: "quote_intake_missing_qty",
              embed_error: productKnowledgeCache.embedError,
              sources: []
            }
          });
        }

        if (!odooConfigured) {
          return res.json({
            ok: true,
            mode: "b2b_sales_assistant",
            mode_label: PRODUCT_BOT_MODES.b2b_sales_assistant.label,
            mode_reason: "Quote requested but Odoo is not configured.",
            answer: "I can prepare the quote, but direct Odoo quotation creation is unavailable because ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_API_KEY_OR_PASSWORD are not configured.",
            retrieval: {
              top_k: 0,
              strategy: "quote_odoo_unavailable",
              embed_error: productKnowledgeCache.embedError,
              sources: []
            }
          });
        }

        const uid = await odooLoginCached();
        const quoteResult = await odooCreateQuotation(uid, {
          company_name: quoteEntities.company_name,
          sku: resolvedSku.sku,
          qty,
          price_unit: applicableTier?.price || null
        });

        if (!quoteResult.ok) {
          return res.json({
            ok: true,
            mode: "b2b_sales_assistant",
            mode_label: PRODUCT_BOT_MODES.b2b_sales_assistant.label,
            mode_reason: "Odoo quotation creation failed.",
            answer: quoteResult.message || "I could not create the quotation in Odoo.",
            retrieval: {
              top_k: 0,
              strategy: "quote_odoo_create_failed",
              embed_error: productKnowledgeCache.embedError,
              sources: []
            },
            odoo_result: quoteResult
          });
        }

        const quoteAnswer = [
          `Quotation created in Odoo: **${quoteResult.quotation_name}**.`,
          `Company: **${quoteResult.partner_name}**`,
          `Item: **${quoteResult.sku}** (${quoteResult.product_name || resolvedSku.title})`,
          `Quantity: **${quoteResult.qty}**`,
          `Unit price: **₹${quoteResult.unit_price.toLocaleString("en-IN")}**`,
          `Line subtotal: **₹${quoteResult.subtotal.toLocaleString("en-IN")}**`,
          `Order total: **₹${quoteResult.total.toLocaleString("en-IN")}**`
        ].join("\n");

        return res.json({
          ok: true,
          mode: "b2b_sales_assistant",
          mode_label: PRODUCT_BOT_MODES.b2b_sales_assistant.label,
          mode_reason: "Quote request routed to Odoo sale.order creation.",
          answer: quoteAnswer,
          retrieval: {
            top_k: 0,
            strategy: "quote_to_odoo",
            embed_error: productKnowledgeCache.embedError,
            sources: []
          },
          odoo_result: quoteResult
        });
      }

      const answer = buildDeterministicPricingReply({
        sku: resolvedSku.sku,
        title: resolvedSku.title,
        qty,
        tiers
      });
      return res.json({
        ok: true,
        mode: "b2b_sales_assistant",
        mode_label: PRODUCT_BOT_MODES.b2b_sales_assistant.label,
        mode_reason: "Used deterministic SKU pricing tier logic.",
        answer,
        retrieval: {
          top_k: 0,
          strategy: "deterministic_pricing",
          embed_error: productKnowledgeCache.embedError,
          sources: []
        }
      });
    }

    const retrieved = await retrieveRelevantChunks(message, PRODUCT_BOT_TOP_K);
    if (!retrieved.length) {
      return res.json({
        ok: true,
        mode: resolvedModeKey,
        mode_label: mode.label,
        mode_reason: "No relevant knowledge chunks found for this query.",
        answer: buildFallbackReply(message),
        retrieval: { top_k: 0, strategy: "fallback", embed_error: productKnowledgeCache.embedError, sources: [] }
      });
    }

    const historyText = history
      .map((h) => `${h.role === "assistant" ? "Assistant" : "User"}: ${String(h.content || "")}`)
      .join("\n");

    const context = retrieved
      .map((c, i) => `[${i + 1}] ${c.title}\n${c.content}`)
      .join("\n\n---\n\n");

    const freshness = extractFreshnessFlags(retrieved);
    const automationSchema = resolvedModeKey === "sales_automation"
      ? `
Automation JSON requirements:
{
  "workflow": "quote_intake",
  "lead_stage": "Inquiry|Qualified|Technical Review",
  "recommended_skus": [],
  "bundle_suggestion": "",
  "missing_fields": [],
  "pricing_status": "valid|stale|unknown",
  "policy_status": "current|review_required",
  "compliance_status": "component_level_only|needs_lab_validation",
  "disclaimer_required": true,
  "next_action": "request_details|send_quote|book_call",
  "support_contact": "care@smarthandicrafts.com"
}
Use freshness flags below when choosing pricing_status/policy_status/disclaimer_required.
`
      : "";

    const outputContractByMode = {
      simple_chatbot: `
Write naturally for end users.
1) Start with a direct, concise answer.
2) Add short supporting bullets only when helpful.
3) If information is missing, clearly say you don't have it in the knowledge base and suggest support contact.
4) End with "Sources: [x][y]".`,
      b2b_sales_assistant: `
Write naturally for a buyer conversation.
1) Provide the direct answer first (include pricing tiers when relevant).
2) Ask at most one clarification question if critical details are missing.
3) Do not re-ask company/SKU/quantity if already provided; use provided company name directly in quote drafts.
4) Keep recommendations practical and concise without legal boilerplate.
5) End with "Sources: [x][y]".`,
      compliance_assistant: `
Write naturally and clearly.
1) Give a short compliance summary grounded in retrieved policy text.
2) Mention limitations only when relevant to the question.
3) Recommend compliance officer/testing-lab validation only for regulatory uncertainty.
4) End with "Sources: [x][y]".`,
      sales_automation: `
Response contract:
1) Return ONLY valid JSON.
2) No markdown, no prose.
3) End your JSON with a "sources" field like ["[1]","[3]"] for traceability.`
    };
    
    const selfTrainingContext = buildSelfTrainingContext(message, { scope: "product_bot", modeKey: resolvedModeKey });

    const prompt = `${mode.system}

Output style:
${outputContractByMode[resolvedModeKey]}${automationSchema}

FRESHNESS FLAGS:
${JSON.stringify(freshness, null, 2)}

RETRIEVED KNOWLEDGE:
${context}

${selfTrainingContext ? `${selfTrainingContext}

` : ""}CHAT HISTORY:

${historyText || "(none)"}

USER QUESTION:
${message}${expandQuery(message) !== message ? `\n\n(Expanded context: ${expandQuery(message)})` : ""}`;

    const modelResult = await callProductBotModel(mode.system, prompt);

    const answerText = modelResult.text || "I could not generate a response.";
    const retrievalMeta = {
      top_k: PRODUCT_BOT_TOP_K,
      strategy: productKnowledgeCache.vectors.length ? "embeddings" : "keyword_fallback",
      embed_error: productKnowledgeCache.embedError,
      sources: retrieved.map((c, i) => ({ id: i + 1, title: c.title })),
      llm_provider: modelResult.provider,
      llm_model: modelResult.model_used,
      fallback_from: modelResult.fallback_from || null,
      ...freshness
    };
    const interaction_id = recordSelfTrainingExample({
      scope: "product_bot",
      message,
      answer: answerText,
      mode: resolvedModeKey,
      retrieval: retrievalMeta
    });

    recordRoutingTelemetry({
      message,
      chosen_mode: resolvedModeKey,
      confidence: autoDetection.confidence,
      fallback_used: autoDetection.stage === "classifier",
      final_user_satisfaction_signal: req.body?.final_user_satisfaction_signal,
      route_feedback: req.body?.route_feedback || null
    });

    return res.json({
      ok: true,
      mode: resolvedModeKey,
      mode_label: mode.label,
      mode_reason: requestedMode === "auto" || !PRODUCT_BOT_MODES[requestedMode] ? autoDetection.reason : "User-selected mode.",
      answer: answerText,
      interaction_id,
      self_training: {
        enabled: SELF_TRAINING_ENABLED,
        memory_size: selfTrainingMemory.length
      },
      retrieval: retrievalMeta

    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});




// ===================== ODOO AI TRAINING RULES =====================
const AI_TRAINING_MODEL = process.env.AI_TRAINING_MODEL || "x_ai_training";

const AI_TRAINING_FIELDS = {
  ruleText: process.env.AI_TRAINING_FIELD_RULE_TEXT || "x_studio_rule_text",
  status: process.env.AI_TRAINING_FIELD_STATUS || "x_studio_status",
  source: process.env.AI_TRAINING_FIELD_SOURCE || "x_studio_source",
  category: process.env.AI_TRAINING_FIELD_CATEGORY || "x_studio_category",
  relatedSku: process.env.AI_TRAINING_FIELD_RELATED_SKU || "x_studio_related_sku",
  pageUrl: process.env.AI_TRAINING_FIELD_PAGE_URL || "x_studio_page_url",
  userMessage: process.env.AI_TRAINING_FIELD_USER_MESSAGE || "x_studio_user_message",
  approvedBy: process.env.AI_TRAINING_FIELD_APPROVED_BY || "x_studio_approved_by",
  approvedDate: process.env.AI_TRAINING_FIELD_APPROVED_DATE || "x_studio_approved_date",
  active: process.env.AI_TRAINING_FIELD_ACTIVE || "x_studio_active"
};

const aiTrainingRulesCache = {
  rules: [],
  fetchedAt: 0,
  error: null
};

const AI_TRAINING_RULES_TTL_MS = Number(process.env.AI_TRAINING_RULES_TTL_MS || 2 * 60 * 1000);
const AI_TRAINING_RULES_LIMIT = Math.max(20, Number(process.env.AI_TRAINING_RULES_LIMIT || 120));

function normalizeOdooSelection(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function tokenizeKitAiRuleSearchText(value = "") {
  return Array.from(
    new Set(
      String(value || "")
        .toLowerCase()
        .match(/[a-z0-9-]{3,}/g) || []
    )
  );
}

function buildKitAiRulesSearchText({ question, pageContext, kitContext } = {}) {
  const snapshot = kitContext?.kitBuilderSnapshot || {};
  return [
    question || "",
    pageContext?.pageTitle || "",
    pageContext?.h1 || "",
    snapshot.selectedApplication || "",
    snapshot.selectedDriver || "",
    Array.isArray(snapshot.activeKitItems) ? snapshot.activeKitItems.join(" ") : "",
    snapshot.completionMessage || "",
    snapshot.warning || ""
  ].filter(Boolean).join(" ").toLowerCase();
}

function scoreApprovedRuleForKitAi(rule = {}, searchText = "") {
  const haystack = [
    rule.rule_text || "",
    rule.related_sku || "",
    rule.category || "",
    rule.user_message || ""
  ].join(" ").toLowerCase();

  if (!haystack) return 0;

  let score = 0;
  const q = String(searchText || "").toLowerCase();
  const relatedSku = String(rule.related_sku || "").trim().toLowerCase();

  if (relatedSku && q.includes(relatedSku)) score += 120;

  const ruleNums = Array.from(haystack.matchAll(/\b\d{2,4}\b/g)).map((m) => m[0]);
  const queryNums = new Set(Array.from(q.matchAll(/\b\d{2,4}\b/g)).map((m) => m[0]));
  for (const num of ruleNums) {
    if (queryNums.has(num)) score += 55;
  }

  const tokens = tokenizeKitAiRuleSearchText(q).slice(0, 50);
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length > 4 ? 5 : 2;
  }

  if (/\bdual|two leds?|2 leds?|3 colour|3 color\b/i.test(q) && /\bdual|two leds?|2 leds?|3 colour|3 color\b/i.test(haystack)) {
    score += 18;
  }

  if (/\bstrip|204|205|lsd\b/i.test(q) && /\bstrip|204|205|lsd\b/i.test(haystack)) {
    score += 18;
  }

  if (/\bbattery|recharge|fast charg\b/i.test(q) && /\bbattery|recharge|fast charg\b/i.test(haystack)) {
    score += 12;
  }

  return score;
}

function selectRelevantApprovedRulesForKitAi(rules = [], { question, pageContext, kitContext } = {}) {
  const sourceRules = Array.isArray(rules) ? rules : [];
  if (!sourceRules.length) return [];

  const searchText = buildKitAiRulesSearchText({ question, pageContext, kitContext });

  const scored = sourceRules
    .map((rule) => ({
      rule,
      score: scoreApprovedRuleForKitAi(rule, searchText)
    }))
    .sort((a, b) => b.score - a.score);

  const relevant = scored
    .filter((row) => row.score > 0)
    .slice(0, KIT_AI_MAX_RELEVANT_RULES)
    .map((row) => row.rule);

  if (relevant.length) return relevant;

  // Small safety fallback: keep a few newest general rules, not the whole training store.
  return sourceRules
    .filter((rule) => !String(rule.related_sku || "").trim())
    .slice(0, Math.min(3, KIT_AI_MAX_RELEVANT_RULES));
}

function formatApprovedRulesForPrompt(rules = []) {
  if (!rules.length) return "No directly relevant approved Smart Handicrafts training rules were matched for this question.";

  return rules
    .slice(0, KIT_AI_MAX_RELEVANT_RULES)
    .map((rule, index) => {
      const sku = rule.related_sku ? ` SKU: ${rule.related_sku}.` : "";
      const category = rule.category ? ` Category: ${rule.category}.` : "";
      return `${index + 1}. ${String(rule.rule_text || "").trim().slice(0, 520)}${sku}${category}`;
    })
    .join("\n");
}

async function getApprovedOdooAiTrainingRules({ force = false } = {}) {
  if (!odooConfigured) {
    return {
      ok: false,
      rules: [],
      error: "Odoo is not configured."
    };
  }

  const cacheValid =
    !force &&
    Date.now() - aiTrainingRulesCache.fetchedAt < AI_TRAINING_RULES_TTL_MS;

  if (cacheValid) {
    return {
      ok: true,
      rules: aiTrainingRulesCache.rules,
      cached: true,
      error: aiTrainingRulesCache.error
    };
  }

  try {
    const uid = await odooLoginCached();

    const fields = [
      "id",
      "display_name",
      AI_TRAINING_FIELDS.ruleText,
      AI_TRAINING_FIELDS.status,
      AI_TRAINING_FIELDS.source,
      AI_TRAINING_FIELDS.category,
      AI_TRAINING_FIELDS.relatedSku,
      AI_TRAINING_FIELDS.pageUrl,
      AI_TRAINING_FIELDS.userMessage,
      AI_TRAINING_FIELDS.approvedBy,
      AI_TRAINING_FIELDS.approvedDate,
      AI_TRAINING_FIELDS.active
    ];

    const rows = await odooExecute(
      uid,
      AI_TRAINING_MODEL,
      "search_read",
      [[
        [AI_TRAINING_FIELDS.active, "=", true]
      ], fields],
      {
        limit: AI_TRAINING_RULES_LIMIT,
        order: "write_date desc, id desc"
      }
    );

    const rules = (rows || [])
      .map((row) => ({
        id: row.id,
        name: row.display_name || "",
        rule_text: String(row[AI_TRAINING_FIELDS.ruleText] || "").trim(),
        status: normalizeOdooSelection(row[AI_TRAINING_FIELDS.status]),
        source: normalizeOdooSelection(row[AI_TRAINING_FIELDS.source]),
        category: String(row[AI_TRAINING_FIELDS.category] || "").trim(),
        related_sku: String(row[AI_TRAINING_FIELDS.relatedSku] || "").trim(),
        page_url: String(row[AI_TRAINING_FIELDS.pageUrl] || "").trim(),
        user_message: String(row[AI_TRAINING_FIELDS.userMessage] || "").trim(),
        approved_by: String(row[AI_TRAINING_FIELDS.approvedBy] || "").trim(),
        approved_date: String(row[AI_TRAINING_FIELDS.approvedDate] || "").trim()
      }))
      .filter((rule) => {
        return (
          rule.rule_text &&
          (
            rule.status === "approved" ||
            rule.status === "approve" ||
            rule.status === "done" ||
            rule.status === "active"
          )
        );
      });

    aiTrainingRulesCache.rules = rules;
    aiTrainingRulesCache.fetchedAt = Date.now();
    aiTrainingRulesCache.error = null;

    return {
      ok: true,
      rules,
      cached: false,
      error: null
    };
  } catch (error) {
    aiTrainingRulesCache.error = String(error?.message || error || "Unknown Odoo AI rules error");

    return {
      ok: false,
      rules: [],
      error: aiTrainingRulesCache.error
    };
  }
}

function canonicalTrainingSelection(kind, value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  const maps = {
    status: {
      approved: "approved",
      approve: "approved",
      pending: "pending",
      rejected: "rejected",
      reject: "rejected"
    },
    source: {
      admin: "admin",
      public: "public"
    },
    category: {
      compatibility: "compatibility",
      product_rule: "product_rule",
      productrule: "product_rule",
      pricing: "pricing",
      policy: "policy",
      general: "general"
    }
  };

  return maps[kind]?.[normalized] || normalized || (kind === "category" ? "general" : "");
}
const aiTrainingSelectionCache = {
  fetchedAt: 0,
  values: null
};

const AI_TRAINING_SELECTION_TTL_MS = Number(
  process.env.AI_TRAINING_SELECTION_TTL_MS || 10 * 60 * 1000
);

function normalizeSelectionCompare(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

async function getAiTrainingSelectionValues({ force = false } = {}) {
  const cacheValid =
    !force &&
    aiTrainingSelectionCache.values &&
    Date.now() - aiTrainingSelectionCache.fetchedAt < AI_TRAINING_SELECTION_TTL_MS;

  if (cacheValid) {
    return aiTrainingSelectionCache.values;
  }

  const uid = await odooLoginCached();

  const fieldsMeta = await odooExecute(
    uid,
    AI_TRAINING_MODEL,
    "fields_get",
    [[
      AI_TRAINING_FIELDS.status,
      AI_TRAINING_FIELDS.source,
      AI_TRAINING_FIELDS.category
    ]],
    {
      attributes: ["selection", "string", "type"]
    }
  );

  function readSelection(fieldName) {
    const raw = fieldsMeta?.[fieldName]?.selection || [];
    return raw.map((item) => ({
      value: Array.isArray(item) ? String(item[0] ?? "") : "",
      label: Array.isArray(item) ? String(item[1] ?? "") : ""
    })).filter((item) => item.value);
  }

  const values = {
    status: readSelection(AI_TRAINING_FIELDS.status),
    source: readSelection(AI_TRAINING_FIELDS.source),
    category: readSelection(AI_TRAINING_FIELDS.category)
  };

  aiTrainingSelectionCache.values = values;
  aiTrainingSelectionCache.fetchedAt = Date.now();

  return values;
}

function chooseOdooSelectionValue(options = [], desired, fallbackCandidates = []) {
  if (!Array.isArray(options) || !options.length) return String(desired || "").trim();

  const candidates = [
    desired,
    ...fallbackCandidates
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeSelectionCompare(candidate);

    const exactByValue = options.find(
      (option) => normalizeSelectionCompare(option.value) === normalizedCandidate
    );
    if (exactByValue) return exactByValue.value;

    const exactByLabel = options.find(
      (option) => normalizeSelectionCompare(option.label) === normalizedCandidate
    );
    if (exactByLabel) return exactByLabel.value;
  }

  return options[0].value;
}

async function createOdooAiTrainingRule({
  ruleText,
  status = "approved",
  source = "admin",
  category = "compatibility",
  relatedSku = "",
  pageUrl = "",
  userMessage = "",
  approvedBy = "",
  approvedDate = null,
  active = true
} = {}) {
  if (!odooConfigured) throw new Error("Odoo is not configured.");

  const safeRuleText = String(ruleText || "").trim();
  if (!safeRuleText) throw new Error("Rule text is required.");

  const uid = await odooLoginCached();
  const selectionValues = await getAiTrainingSelectionValues();

  const safeStatus = chooseOdooSelectionValue(
    selectionValues.status,
    status,
    ["approved", "Approved", "APPROVED"]
  );

  const safeSource = chooseOdooSelectionValue(
    selectionValues.source,
    source,
    ["admin", "Admin", "ADMIN"]
  );

  const safeCategory = chooseOdooSelectionValue(
    selectionValues.category,
    category,
    ["compatibility", "Compatibility", "COMPATIBILITY", "general", "General"]
  );

  const payload = {
    x_name: safeRuleText.slice(0, 80),
    [AI_TRAINING_FIELDS.ruleText]: safeRuleText,
    [AI_TRAINING_FIELDS.status]: safeStatus,
    [AI_TRAINING_FIELDS.source]: safeSource,
    [AI_TRAINING_FIELDS.category]: safeCategory,
    [AI_TRAINING_FIELDS.relatedSku]: String(relatedSku || "").trim(),
    [AI_TRAINING_FIELDS.pageUrl]: String(pageUrl || "").trim(),
    [AI_TRAINING_FIELDS.userMessage]: String(userMessage || "").trim(),
    [AI_TRAINING_FIELDS.approvedBy]: String(approvedBy || "").trim(),
    [AI_TRAINING_FIELDS.active]: !!active
  };

  if (approvedDate) {
    payload[AI_TRAINING_FIELDS.approvedDate] = approvedDate;
  }

  try {
    const id = await odooExecute(uid, AI_TRAINING_MODEL, "create", [payload]);
    aiTrainingRulesCache.fetchedAt = 0;
    return {
      ok: true,
      id,
      savedSelectionValues: {
        status: safeStatus,
        source: safeSource,
        category: safeCategory
      }
    };
  } catch (error) {
    throw new Error(
      `Odoo AI training create failed: ${String(error?.message || error || "Unknown error")} ` +
      `(status=${safeStatus}, source=${safeSource}, category=${safeCategory})`
    );
  }
}

// ===================== LIVE ODOO WEBSITE PRODUCTS FOR KIT AI =====================
const liveOdooProductsCache = {
  products: [],
  fetchedAt: 0,
  error: null
};

const LIVE_ODOO_PRODUCTS_TTL_MS = Number(process.env.LIVE_ODOO_PRODUCTS_TTL_MS || 5 * 60 * 1000);
const LIVE_ODOO_PRODUCTS_LIMIT = Math.max(20, Number(process.env.LIVE_ODOO_PRODUCTS_LIMIT || 200));

function compactProductDescription(value, max = 280) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeLiveOdooProduct(p) {
  return {
    id: p.id,
    name: String(p.name || p.display_name || "").trim(),
    sku: String(p.default_code || "").trim(),
    price: Number(p.list_price || p.lst_price || 0),
    url: String(p.website_url || "").trim(),
    description: compactProductDescription(
      p.description_sale ||
      p.website_description ||
      p.description_ecommerce ||
      p.website_meta_description ||
      p.website_meta_title ||
      ""
    )
  };
}

async function searchReadLiveProductsWithFallback(uid) {
  const domainCandidates = [
    [["website_published", "=", true], ["sale_ok", "=", true]],
    [["is_published", "=", true], ["sale_ok", "=", true]],
    [["sale_ok", "=", true]]
  ];

  const fieldCandidates = [
    [
      "id",
      "name",
      "default_code",
      "list_price",
      "website_url",
      "description_sale",
      "website_description",
      "description_ecommerce",
      "website_meta_title",
      "website_meta_description"
    ],
    [
      "id",
      "name",
      "default_code",
      "list_price",
      "website_url",
      "description_sale",
      "website_description"
    ],
    [
      "id",
      "name",
      "default_code",
      "list_price",
      "description_sale"
    ],
    [
      "id",
      "name",
      "default_code",
      "list_price"
    ]
  ];

  let lastError = null;

  for (const domain of domainCandidates) {
    for (const fields of fieldCandidates) {
      try {
        const products = await odooExecute(
          uid,
          "product.template",
          "search_read",
          [domain, fields],
          {
            limit: LIVE_ODOO_PRODUCTS_LIMIT,
            order: "name asc"
          }
        );

        return products || [];
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("Unable to fetch live Odoo website products.");
}

async function fetchVariantSkuMapForTemplates(uid, templateIds = []) {
  const ids = Array.from(new Set((templateIds || []).filter(Boolean)));
  if (!ids.length) return new Map();

  const fieldCandidates = [
    ["id", "display_name", "default_code", "lst_price", "product_tmpl_id"],
    ["id", "display_name", "default_code", "product_tmpl_id"]
  ];

  let variants = [];
  let lastError = null;

  for (const fields of fieldCandidates) {
    try {
      variants = await odooExecute(
        uid,
        "product.product",
        "search_read",
        [[["product_tmpl_id", "in", ids]], fields],
        {
          limit: Math.max(LIVE_ODOO_PRODUCTS_LIMIT * 4, 400),
          order: "id asc"
        }
      );
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!Array.isArray(variants)) {
    if (lastError) console.warn("Variant SKU fetch failed:", lastError.message || lastError);
    return new Map();
  }

  const map = new Map();

  for (const v of variants) {
    const tmplId = Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id;
    if (!tmplId) continue;

    const row = map.get(tmplId) || {
      sku: "",
      variantSkus: [],
      variantNames: [],
      variantPrices: []
    };

    const sku = String(v.default_code || "").trim();
    if (sku) {
      row.variantSkus.push(sku);
      if (!row.sku) row.sku = sku;
    }

    if (v.display_name) row.variantNames.push(String(v.display_name).trim());

    const price = Number(v.lst_price || 0);
    if (Number.isFinite(price) && price > 0) row.variantPrices.push(price);

    map.set(tmplId, row);
  }

  return map;
}

function mergeVariantDataIntoLiveProduct(product, variantData) {
  if (!variantData) return product;

  const variantSkus = Array.from(new Set([
    ...String(product.sku || "").split(",").map((x) => x.trim()).filter(Boolean),
    ...(variantData.variantSkus || [])
  ]));

  const variantNames = Array.from(new Set(variantData.variantNames || []));

  return {
    ...product,
    sku: product.sku || variantData.sku || "",
    variantSkus,
    variantNames: variantNames.slice(0, 8),
    price: product.price || variantData.variantPrices?.[0] || 0,
    description: [
      product.description || "",
      variantSkus.length ? `Available SKU codes: ${variantSkus.join(", ")}` : "",
      variantNames.length ? `Variants: ${variantNames.slice(0, 5).join(" | ")}` : ""
    ].filter(Boolean).join(" ")
  };
}

async function getLiveOdooWebsiteProducts({ force = false } = {}) {
  if (!odooConfigured) {
    return {
      ok: false,
      products: [],
      error: "Odoo is not configured. Add ODOO_URL, ODOO_DB, ODOO_USERNAME and ODOO_API_KEY_OR_PASSWORD in Render."
    };
  }

  const cacheValid =
    !force &&
    liveOdooProductsCache.products.length &&
    Date.now() - liveOdooProductsCache.fetchedAt < LIVE_ODOO_PRODUCTS_TTL_MS;

  if (cacheValid) {
    return {
      ok: true,
      products: liveOdooProductsCache.products,
      cached: true,
      error: liveOdooProductsCache.error
    };
  }

  try {
    const uid = await odooLoginCached();
    const rawProducts = await searchReadLiveProductsWithFallback(uid);

    const normalizedProducts = (rawProducts || [])
      .map(normalizeLiveOdooProduct)
      .filter((p) => p.name)
      .slice(0, LIVE_ODOO_PRODUCTS_LIMIT);

    const variantSkuMap = await fetchVariantSkuMapForTemplates(
      uid,
      normalizedProducts.map((p) => p.id)
    );

    const products = normalizedProducts.map((p) =>
      mergeVariantDataIntoLiveProduct(p, variantSkuMap.get(p.id))
    );

    liveOdooProductsCache.products = products;
    liveOdooProductsCache.fetchedAt = Date.now();
    liveOdooProductsCache.error = null;

    return {
      ok: true,
      products,
      cached: false,
      error: null
    };
  } catch (error) {
    liveOdooProductsCache.error = String(error?.message || error || "Unknown Odoo error");

    return {
      ok: false,
      products: [],
      error: liveOdooProductsCache.error
    };
  }
}

function extractSkuLikeText(text) {
  return Array.from(
    new Set(
      String(text || "")
        .match(/\b[A-Z]{2,}(?:-[A-Z0-9]+){1,}\b/g) || []
    )
  );
}

function getLiveSkuSet(liveProducts = []) {
  return new Set(
    (liveProducts || [])
      .flatMap((p) => [
        String(p.sku || "").trim(),
        ...(Array.isArray(p.variantSkus) ? p.variantSkus : [])
      ])
      .filter(Boolean)
  );
}

function getFakeSkusFromAnswer(answer, liveProducts = []) {
  const liveSkus = getLiveSkuSet(liveProducts);
  const mentioned = extractSkuLikeText(answer);
  if (!mentioned.length) return [];
  return mentioned.filter((sku) => !liveSkus.has(sku));
}

function kitAiUserAskedAboutSpecificProduct(question = "") {
  const q = String(question || "");
  return (
    /\bAS-[A-Z]-[A-Z0-9-]+\b/i.test(q) ||
    /\b(?:DRIVER|KIT)\s*[-–—]?\s*(?:101|102|103|201|202|203|204|205|206)\b/i.test(q) ||
    /\b(?:101|102|103|201|202|203|204|205|206)\s*(?:driver|kit|sku|product)?\b/i.test(q)
  );
}

function removeUnsupportedSkuMentionsFromAnswer(answer = "", fakeSkus = []) {
  let clean = String(answer || "");

  (Array.isArray(fakeSkus) ? fakeSkus : []).forEach((sku) => {
    const escaped = String(sku || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) return;
    clean = clean.replace(new RegExp(`\\b${escaped}\\b`, "g"), "the suitable live option");
  });

  return clean
    .replace(/\bthe suitable live option\s+\(\s*the suitable live option\s*\)/gi, "the suitable live option")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

function compactKitAiProductDescription(value = "") {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KIT_AI_PRODUCT_DESCRIPTION_CHARS);
}

function buildLiveProductsForPrompt(liveProducts = []) {
  return (liveProducts || []).map((p) => {
    const annotation = getKitAiBuilderMapping({
      name: p.name || "",
      sku: p.sku || ""
    }, p);

    return {
      name: p.name,
      sku: p.sku || "",
      variantSkus: Array.isArray(p.variantSkus) ? p.variantSkus.slice(0, 4) : [],
      price: p.price || 0,
      description: compactKitAiProductDescription(p.description || ""),
      builder_product_id: annotation.builder_product_id || "",
      builder_driver_id: annotation.builder_driver_id || ""
    };
  });
}

function stripMarkdownForCustomer(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


function improveNaturalKitAnswer(answer) {
  return String(answer || "")
    .replace(/To complete this kit, we recommend adding the following:?/gi, "I would add these exact items to complete it:")
    .replace(/To complete your kit, we recommend adding the following:?/gi, "I would add these exact items to complete it:")
    .replace(/consider adding the following:?/gi, "I would choose these exact items:")
    .replace(/your active kit is currently incomplete,?\s*/gi, "")
    .replace(/the following:\s*$/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBalancedJsonObjects(text) {
  const source = String(text || "");
  const objects = [];

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;

      if (depth === 0) {
        objects.push(source.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function parseKitAiJsonResponse(rawText) {
  const text = String(rawText || "").trim();

  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === "object") return direct;
  } catch {}

  const candidates = extractBalancedJsonObjects(text);

  // Gemini sometimes returns one JSON, then repeats instructions, then another JSON.
  // Prefer the last valid JSON object because it is usually the final answer.
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }

  return {
    answer: stripMarkdownForCustomer(text)
      .replace(/\{[\s\S]*?\}/g, "")
      .replace(/Acknowledge the user[\s\S]*?Ask for missing technical details only if needed\./gi, "")
      .trim() || "I could not generate an answer right now.",
    recommended_products: [],
    active_kit_actions: [],
    action_offer: "none"
  };
}

function compactTextForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getActiveKitTextForMatch(kitContext = {}) {
  const snapshot = kitContext?.kitBuilderSnapshot || {};
  return compactTextForMatch([
    snapshot.selectedDriver || "",
    ...(Array.isArray(snapshot.activeKitItems) ? snapshot.activeKitItems : []),
    snapshot.completionMessage || "",
    snapshot.reviewStatus || "",
    snapshot.warning || ""
  ].join(" "));
}

function productAlreadyInActiveKit(product = {}, kitContext = {}) {
  const activeText = getActiveKitTextForMatch(kitContext);
  if (!activeText) return false;

  const sku = compactTextForMatch(product.sku || "");
  const name = compactTextForMatch(product.name || "");

  if (sku && activeText.includes(sku)) return true;

  if (name) {
    const tokens = name.split(" ").filter((t) => t.length >= 3);
    if (tokens.length) {
      const hits = tokens.filter((t) => activeText.includes(t)).length;
      if (hits >= Math.min(3, tokens.length)) return true;
    }
  }

  return false;
}

function filterAlreadyActiveRecommendations(products = [], kitContext = {}) {
  return (products || []).filter((p) => !productAlreadyInActiveKit(p, kitContext));
}

function userWantsAiToChoose(question = "") {
  const q = compactTextForMatch(question);
  return (
    q.includes("you tell") ||
    q.includes("you choose") ||
    q.includes("choose according") ||
    q.includes("which one to add") ||
    q.includes("best one") ||
    q.includes("select for me") ||
    q.includes("recommend final")
  );
}


const KIT_AI_BUILDER_SKU_MAP = Object.freeze({
  "AS-B-201-SLD": { builder_driver_id: "201" },
  "AS-B-201-SLD-LC": { builder_driver_id: "201-lc" },
  "AS-B-201-LC": { builder_driver_id: "201-lc" },
  "AS-B-202-DLD": { builder_driver_id: "202" },
  "AS-B-202-DLD-LC": { builder_driver_id: "202-lc" },
  "AS-B-202-LC": { builder_driver_id: "202-lc" },
  "AS-U-101-SLD": { builder_driver_id: "101" },
  "AS-U-102-DLD": { builder_driver_id: "102" },
  "AS-U-103-LSD": { builder_driver_id: "103" },
  "AS-B-204-LSD": { builder_driver_id: "204" },

  // Smart Handicrafts approved rule: 205 is the fast-charging rechargeable strip LED driver,
  // even though the current live SKU prefix is AS-U.
  "AS-U-205-LSD": { builder_driver_id: "205" },
  "AS-B-205-LSD": { builder_driver_id: "205" },

  "AS-B-206-55-DLD": { builder_driver_id: "206-55" },
  "AS-B-206-75-DLD": { builder_driver_id: "206-75" },
  "AS-B-206-115-DLD": { builder_driver_id: "206-115" },

  "SH-COB-20-2W": { builder_product_id: "2w-led" },
  "SH-COB-2W-35": { builder_product_id: "2w-35mm" },
  "SH-COB-3": { builder_product_id: "3w-single" },
  "SH-COB-5": { builder_product_id: "5w-single" },
  "SH-COB-3D": { builder_product_id: "3w-dual" },
  "SH-COB-5D": { builder_product_id: "5w-dual" },
  "SH-COB-21-DLD": { builder_product_id: "cob-50mm-3color" },

  "SH-BAT-26S": { builder_product_id: "battery-2600-sleeve" },
  "SH-BAT-26-WS": { builder_product_id: "battery-2600-nosleeve" },
  "SH-BAT-1200": { builder_product_id: "battery-1200" },

  /*
    Do NOT map SH-BAT-1200-S to battery-1200.
    The builder's battery-1200 card is the WITHOUT-SLEEVE path, while SH-BAT-1200-S
    is a distinct sleeve SKU in Odoo. Leaving it unmapped prevents wrong-product auto-add.
  */

  "SH-BAT-1800": { builder_product_id: "battery-1800" },
  "SH-BAT-5000": { builder_product_id: "battery-5200" },
  "SH-18650-BAT-H": { builder_product_id: "battery-holder" },

  "SH-C-ENC": { builder_product_id: "usb-c-enclosure" },
  "SH-LNS-C": { builder_product_id: "lens-clear" },
  "SH-LNS-F": { builder_product_id: "lens-frosted" },

  /*
    SH-USB-PMC-B appears in the export for more than one black connector label,
    so it must NOT be treated as an unambiguous SKU-only add target.
    Exact product-name matching below decides plain-black vs with-indicator safely.
  */
  "SH-USB-PMC-B-S": { builder_product_id: "usb-panel-snapfit" },

  "LEDWIRE": { builder_product_id: "jst-2pin" }
});

const KIT_AI_BUILDER_NAME_HINTS = Object.freeze([
  { pattern: /\b201\b.*\b(rechargeable|1\s*color|single)\b(?!.*\blc\b)/i, mapped: { builder_driver_id: "201" } },
  { pattern: /\b201\b.*\blc\b/i, mapped: { builder_driver_id: "201-lc" } },
  { pattern: /\b202\b.*\b(dual|3\s*color)\b(?!.*\blc\b)/i, mapped: { builder_driver_id: "202" } },
  { pattern: /\b202\b.*\blc\b/i, mapped: { builder_driver_id: "202-lc" } },
  { pattern: /\b101\b.*\busb\b/i, mapped: { builder_driver_id: "101" } },
  { pattern: /\b102\b.*\busb\b/i, mapped: { builder_driver_id: "102" } },
  { pattern: /\b103\b.*\b(strip|usb)\b/i, mapped: { builder_driver_id: "103" } },
  { pattern: /\b204\b.*\bstrip\b/i, mapped: { builder_driver_id: "204" } },
  { pattern: /\b205\b.*\bstrip\b/i, mapped: { builder_driver_id: "205" } },
  { pattern: /\b206\b.*\b55\s*mm\b/i, mapped: { builder_driver_id: "206-55" } },
  { pattern: /\b206\b.*\b75\s*mm\b/i, mapped: { builder_driver_id: "206-75" } },
  { pattern: /\b206\b.*\b115\s*mm\b/i, mapped: { builder_driver_id: "206-115" } },

  { pattern: /\b2\s*w\b.*\b20\s*mm\b/i, mapped: { builder_product_id: "2w-led" } },
  { pattern: /\b2\s*w\b.*\b35\s*mm\b/i, mapped: { builder_product_id: "2w-35mm" } },
  { pattern: /\b3\s*w\b.*\b(cob|led)\b(?!.*\bdual\b)/i, mapped: { builder_product_id: "3w-single" } },
  { pattern: /\b5\s*w\b.*\b(cob|led)\b(?!.*\bdual\b)/i, mapped: { builder_product_id: "5w-single" } },
  { pattern: /\b3\s*w\b.*\b(dual|warm[-\s]?cool|cct)\b/i, mapped: { builder_product_id: "3w-dual" } },
  { pattern: /\b5\s*w\b.*\b(dual|warm[-\s]?cool|cct)\b/i, mapped: { builder_product_id: "5w-dual" } },
  { pattern: /\b(cob|led)\b.*\b50\s*mm\b.*\b3\s*color\b/i, mapped: { builder_product_id: "cob-50mm-3color" } },

  { pattern: /\bcob\s*led\s*strip\b.*\b3\s*mm\b.*\b400\b.*\b12\s*v\b/i, mapped: { builder_product_id: "12v-strip-3mm" } },
  { pattern: /\bcob\s*led\s*strip\b.*\b5\s*mm\b.*\b400\b.*\b12\s*v\b/i, mapped: { builder_product_id: "12v-strip-5mm" } },
  { pattern: /\bcob\s*led\s*strip\b.*\b8\s*mm\b.*\b320\b.*\b12\s*v\b/i, mapped: { builder_product_id: "12v-strip-8mm" } },
  { pattern: /\bcob\s*led\s*strip\b.*\b8\s*mm\b.*\b320\b.*\b24\s*v\b/i, mapped: { builder_product_id: "24v-strip-8mm" } },
  { pattern: /\bcob\s*led\s*strip\b.*\bcct\b.*\b10\s*mm\b.*\b12\s*v\b/i, mapped: { builder_product_id: "cct-strip-10mm-12v" } },

  { pattern: /\b2600\b.*\b(with\s+sleeve|sleeve)\b(?!.*\bwithout\b)/i, mapped: { builder_product_id: "battery-2600-sleeve" } },
  { pattern: /\b2600\b.*\b(without\s+sleeve|no\s+sleeve)\b/i, mapped: { builder_product_id: "battery-2600-nosleeve" } },
  { pattern: /\b1200\b.*\b(without\s+sleeve|no\s+sleeve)\b/i, mapped: { builder_product_id: "battery-1200" } },
  { pattern: /\b1800\b.*\b(sleeve|battery)\b/i, mapped: { builder_product_id: "battery-1800" } },
  { pattern: /\b5200\b.*\bbms\b/i, mapped: { builder_product_id: "battery-5200-bms" } },
  { pattern: /\b5200\b.*\bbattery\b(?!.*\bbms\b)/i, mapped: { builder_product_id: "battery-5200" } },
  { pattern: /\b18650\b.*\bholder\b/i, mapped: { builder_product_id: "battery-holder" } },

  { pattern: /\b3\s*pin\b.*\bjst\b|\bjst\b.*\b3\s*pin\b/i, mapped: { builder_product_id: "jst-3pin" } },
  { pattern: /\bjst\b.*\b(wire|cable)\b/i, mapped: { builder_product_id: "jst-2pin" } },
  { pattern: /\blug\s*wire\b.*\b10\s*cm\b/i, mapped: { builder_product_id: "lug-wire" } },
  { pattern: /\btouch\s*sensor\b.*\bgold\b/i, mapped: { builder_product_id: "touch-sensor" } },

  /*
    Order matters: specific USB panel-mount variants must match before the generic black connector.
  */
  { pattern: /\busb\s*panel\s*mount\s*connector\s*black\s*with\s*indicator\b/i, mapped: { builder_product_id: "usb-panel-indicator" } },
  { pattern: /\busb\s*panel\s*mount\s*connector\s*black\b.*\bsnap\s*fit\b|\busb\s*panel\s*mount\s*connector\s*black\s*\(snap\s*fit\)/i, mapped: { builder_product_id: "usb-panel-snapfit" } },
  { pattern: /\busb\s*panel\s*mount\s*connector\s*black\b(?!.*\bindicator\b)(?!.*\bsnap\s*fit\b)/i, mapped: { builder_product_id: "usb-panel-black" } },

  { pattern: /\busb\s*c\s*enclosure\b/i, mapped: { builder_product_id: "usb-c-enclosure" } },
  { pattern: /\blens\b.*\bclear\b/i, mapped: { builder_product_id: "lens-clear" } },
  { pattern: /\blens\b.*\bfrosted\b/i, mapped: { builder_product_id: "lens-frosted" } }
]);

function getKitAiBuilderMapping(item = {}, liveProduct = null) {
  const skuCandidates = [
    String(item?.sku || "").trim(),
    String(liveProduct?.sku || "").trim(),
    ...(Array.isArray(liveProduct?.variantSkus) ? liveProduct.variantSkus : [])
  ].filter(Boolean);

  for (const sku of skuCandidates) {
    const rawKey = String(sku || "").trim().toUpperCase();
    const normalizedKey = rawKey.replace(/^\[+|\]+$/g, "").trim();
    const mapping =
      KIT_AI_BUILDER_SKU_MAP[rawKey] ||
      KIT_AI_BUILDER_SKU_MAP[normalizedKey];
    if (mapping) return { ...mapping };
  }

  const haystack = [
    item?.name || "",
    item?.sku || "",
    liveProduct?.name || "",
    liveProduct?.sku || "",
    Array.isArray(liveProduct?.variantNames) ? liveProduct.variantNames.join(" ") : "",
    Array.isArray(liveProduct?.variantSkus) ? liveProduct.variantSkus.join(" ") : ""
  ].filter(Boolean).join(" ");

  for (const row of KIT_AI_BUILDER_NAME_HINTS) {
    if (row.pattern.test(haystack)) return { ...row.mapped };
  }

  return {};
}

function annotateKitAiBuilderMapping(item = {}, liveProduct = null) {
  const mapped = getKitAiBuilderMapping(item, liveProduct);
  return {
    ...item,
    ...(mapped.builder_product_id ? { builder_product_id: mapped.builder_product_id } : {}),
    ...(mapped.builder_driver_id ? { builder_driver_id: mapped.builder_driver_id } : {}),
    auto_addable: !!(mapped.builder_product_id || mapped.builder_driver_id)
  };
}

function normalizeKitAiRecommendedProducts(products = [], liveProducts = []) {
  const liveSkuSet = getLiveSkuSet(liveProducts);
  const liveBySku = new Map();
  const liveByName = new Map();

  (liveProducts || []).forEach((p) => {
    const allSkus = [
      String(p.sku || "").trim(),
      ...(Array.isArray(p.variantSkus) ? p.variantSkus : [])
    ].filter(Boolean);

    allSkus.forEach((sku) => liveBySku.set(sku, p));
    liveByName.set(String(p.name || "").trim().toLowerCase(), p);
  });

  return (Array.isArray(products) ? products : [])
    .map((item) => {
      const sku = String(item?.sku || "").trim();
      const name = String(item?.name || "").trim();
      const qty = Math.max(1, Math.min(500, Number(item?.qty || 1)));
      const reason = stripMarkdownForCustomer(item?.reason || "");

      let live = null;
      if (sku && liveSkuSet.has(sku)) live = liveBySku.get(sku);
      if (!live && name) live = liveByName.get(name.toLowerCase());

      if (!live) return null;

      const finalSku = sku || live.sku || (Array.isArray(live.variantSkus) ? live.variantSkus[0] : "") || "";

      return annotateKitAiBuilderMapping({
        name: live.name || name,
        sku: finalSku,
        qty,
        reason,
        type: String(item?.type || "").trim()
      }, live);
    })
    .filter(Boolean)
    .slice(0, 12);
}


function isKitAiDualLedProduct(product = {}) {
  const text = compactTextForMatch([
    product?.name || "",
    product?.sku || "",
    product?.type || ""
  ].join(" "));
  return (
    text.includes("dual") ||
    text.includes("warm cool") ||
    text.includes("3d") ||
    text.includes("sh cob 3d") ||
    text.includes("sh cob 5d")
  ) && (text.includes("led") || text.includes("cob"));
}

function isKitAiJstWireProduct(product = {}) {
  const text = compactTextForMatch([
    product?.name || "",
    product?.sku || "",
    product?.type || ""
  ].join(" "));
  return text.includes("jst") || text.includes("ledwire") || text.includes("wire");
}

function enforceKitAiDualLedWireQuantity(products = [], kitContext = {}) {
  const list = Array.isArray(products) ? products.map((p) => ({ ...p })) : [];

  /*
    V13 correction:
    Smart Handicrafts rule is strict here:
    - Qty 2 JST wire is needed only for the 202 and 102 dual-driver kit paths.
    - Do NOT infer Qty 2 merely because some LED wording looks dual/CCT.
    - For 201, 101, 204, 205, 103, 206, etc., the AI must keep the requested/default JST qty.
  */
  const selectedDriver = compactTextForMatch(kitContext?.kitBuilderSnapshot?.selectedDriver || "");
  const isDualDriverContext =
    selectedDriver.includes("202") ||
    selectedDriver.includes("102");

  if (!isDualDriverContext) {
    return list.map((product) => {
      if (!isKitAiJstWireProduct(product)) return product;
      return { ...product, qty: Math.max(1, Number(product.qty || 1)) };
    });
  }

  return list.map((product) => {
    if (isKitAiJstWireProduct(product)) {
      return { ...product, qty: Math.max(2, Number(product.qty || 1)) };
    }
    return product;
  });
}

function answerInvitesAddAll(answer = "") {
  const text = String(answer || "").toLowerCase();
  return (
    /\bshould i add\b/i.test(text) ||
    /\badd all\b/i.test(text) ||
    /\badd (all|these|them)\b/i.test(text) ||
    /\bactive kit\b/i.test(text) && /\badd\b/i.test(text)
  );
}

function buildDirectAddOverrideAnswer(actions = []) {
  const first = actions?.[0];
  if (!first) return "";
  const label = first.sku ? `${first.name} (${first.sku})` : first.name;
  if (!label) return "";
  return `I’m adding ${label} to your active kit now.`;
}

function recoverLiveRecommendedProductsFromAnswer(answer = "", liveProducts = [], kitContext = {}) {
  const text = String(answer || "").toLowerCase();
  if (!text || !answerInvitesAddAll(text)) return [];

  const matched = [];
  const seen = new Set();

  function pushRecovered(product, qty = 1, reason = "Recovered from the customer-facing recommendation text after streaming.") {
    if (!product) return;
    const key = `${String(product?.sku || "").toLowerCase()}|${String(product?.name || "").toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    matched.push({
      name: product.name || "",
      sku: product.sku || (Array.isArray(product.variantSkus) ? product.variantSkus[0] : "") || "",
      qty: Math.max(1, Number(qty || 1)),
      type: getKitAiIntegrationProductBucket(product),
      reason
    });
  }

  for (const product of liveProducts || []) {
    const skuCandidates = [
      String(product?.sku || "").trim(),
      ...(Array.isArray(product?.variantSkus) ? product.variantSkus : [])
    ].filter(Boolean);

    const name = String(product?.name || "").trim();
    const nameLower = name.toLowerCase();

    const hasSkuMention = skuCandidates.some((sku) => {
      const s = String(sku || "").trim().toLowerCase();
      return s && text.includes(s);
    });

    const hasExactNameMention = nameLower && nameLower.length >= 6 && text.includes(nameLower);

    if (!hasSkuMention && !hasExactNameMention) continue;
    pushRecovered(product, 1);
  }

  /*
    Repair generic assistant wording such as:
    "Should I add the 2600mAh 18650 battery and JST wire?"

    Earlier this did not reconstruct recommended_products because no exact live SKU/name
    appeared in the visible answer. That caused a later plain "yes" to be sent back to Gemini
    instead of adding the actual live kit items.
  */
  const selectedDriverText = compactTextForMatch(kitContext?.kitBuilderSnapshot?.selectedDriver || "");
  const isDualDriverContext = selectedDriverText.includes("202") || selectedDriverText.includes("102");

  if (/\b(battery|18650|2600\s*mah|2600mah)\b/i.test(text)) {
    const preferred2600Sleeve =
      findBestLiveProductByTitleSkuSignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\bsleeve\b/i],
        prefer: [/\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
      }) ||
      findBestLiveProductBySignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\bsleeve\b/i],
        prefer: [/\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
      }) ||
      findBestLiveProductByTitleSkuSignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i],
        prefer: [/\bsleeve\b/i, /\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
      });

    pushRecovered(preferred2600Sleeve, 1, "Recovered preferred 2600mAh sleeve battery from the add-confirmation wording.");
  }

  if (/\b(jst|wire|ledwire|connector)\b/i.test(text)) {
    const preferredJst =
      findBestLiveProductByTitleSkuSignals(liveProducts, {
        must: [/\bjst\b/i, /\b(wire|cable|connector)\b/i],
        exclude: [/\b(battery|18650|cell)\b/i],
        prefer: [/\bledwire\b/i, /\bdual\s*side\b/i, /\b2\s*pin\b/i, /\bwire\b/i]
      }) ||
      findBestLiveProductBySignals(liveProducts, {
        must: [/\bjst\b/i, /\b(wire|cable|connector)\b/i],
        exclude: [/\b(battery|18650|cell)\b/i],
        prefer: [/\bledwire\b/i, /\bdual\s*side\b/i, /\b2\s*pin\b/i, /\bwire\b/i]
      });

    pushRecovered(preferredJst, isDualDriverContext ? 2 : 1, "Recovered JST wire from the add-confirmation wording.");
  }

  if (/\b(3\s*w|3w)\b/i.test(text) && /\b(dual|warm[-\s]?cool|warm cool|cct)\b/i.test(text)) {
    const dual3w =
      findBestLiveProductByTitleSkuSignals(liveProducts, {
        must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i, /\b(dual|cct|warm[-\s]?cool|warm cool)\b/i],
        exclude: [/\b(strip|lsd|12v|24v)\b/i],
        prefer: [/\bsh-cob-3d\b/i, /\bled\s*-?\s*cree\s*3\s*w\s*dual\b/i, /\b3\s*w\s*dual\b/i, /\bdual\b/i]
      }) ||
      findBestLiveProductBySignals(liveProducts, {
        must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i, /\b(dual|cct|warm[-\s]?cool|warm cool)\b/i],
        exclude: [/\b(strip|lsd|12v|24v)\b/i],
        prefer: [/\bsh-cob-3d\b/i, /\b3\s*w\s*dual\b/i, /\bdual\b/i]
      });

    pushRecovered(dual3w, 1, "Recovered dual 3W LED from the add-confirmation wording.");
  }

  if (/\b(3\s*w|3w)\b/i.test(text) && /\b(cob|led)\b/i.test(text) && !/\b(dual|warm[-\s]?cool|warm cool|cct)\b/i.test(text)) {
    const single3w =
      findBestLiveProductByTitleSkuSignals(liveProducts, {
        must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i],
        exclude: [/\b(strip|lsd|12v|24v|dual|cct)\b/i],
        prefer: [/\bled\s*-?\s*cree\s*cob\s*3\s*w\b/i, /\bsh-cob-3\b/i, /\bcob\b/i, /\bcree\b/i]
      }) ||
      findBestLiveProductBySignals(liveProducts, {
        must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i],
        exclude: [/\b(strip|lsd|12v|24v|dual|cct)\b/i],
        prefer: [/\bsh-cob-3\b/i, /\bcob\b/i, /\bcree\b/i]
      });

    pushRecovered(single3w, 1, "Recovered single 3W LED from the add-confirmation wording.");
  }

  const normalized = filterAlreadyActiveRecommendations(
    normalizeKitAiRecommendedProducts(matched, liveProducts),
    kitContext || {}
  );

  return enforceKitAiDualLedWireQuantity(normalized, kitContext || {}).slice(0, 12);
}


function normalizeKitAiExactProductText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/\bsku\s*:\s*/gi, " ")
    .replace(/[()[\]]/g, " ")
    .replace(/[^a-z0-9+.\-\/\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function kitAiLiveProductAliases(product = {}) {
  return [
    product?.name || "",
    product?.sku || "",
    ...(Array.isArray(product?.variantNames) ? product.variantNames : []),
    ...(Array.isArray(product?.variantSkus) ? product.variantSkus : [])
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function findExactLiveProductsMentionedInText(text = "", liveProducts = []) {
  const normalizedText = normalizeKitAiExactProductText(text);
  if (!normalizedText) return [];

  const matches = [];
  const seen = new Set();

  for (const product of liveProducts || []) {
    const aliases = kitAiLiveProductAliases(product);
    const matched = aliases.some((alias) => {
      const normalizedAlias = normalizeKitAiExactProductText(alias);
      if (!normalizedAlias || normalizedAlias.length < 4) return false;
      return (
        normalizedText === normalizedAlias ||
        normalizedText.includes(normalizedAlias) ||
        normalizedAlias.includes(normalizedText)
      );
    });

    if (!matched) continue;
    const key = `${String(product?.sku || "").toLowerCase()}|${String(product?.name || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(product);
  }

  return matches;
}

function kitAiQuestionLooksLikeExactProductSelection(question = "", history = [], liveProducts = []) {
  const q = String(question || "").trim();
  if (!q) return false;

  const productMatches = findExactLiveProductsMentionedInText(q, liveProducts);
  if (!productMatches.length) return false;

  const lower = q.toLowerCase();
  const directAddIntent = /\b(add|include|select|choose|use|take)\b/i.test(lower);

  const latestAssistantChoiceText = (Array.isArray(history) ? history : [])
    .slice(-6)
    .reverse()
    .find((h) => String(h?.role || "").toLowerCase() === "assistant");

  const assistantText = String(
    latestAssistantChoiceText?.text ||
    latestAssistantChoiceText?.content ||
    ""
  ).toLowerCase();

  const priorAssistantAskedChoice =
    /\b(which|choose|prefer|would you prefer|which one|option)\b/i.test(assistantText) &&
    productMatches.some((product) =>
      kitAiLiveProductAliases(product).some((alias) => {
        const normalizedAlias = normalizeKitAiExactProductText(alias);
        return normalizedAlias && normalizeKitAiExactProductText(assistantText).includes(normalizedAlias);
      })
    );

  const looksLikeQuestion =
    /\?/.test(q) ||
    /^(what|why|how|which|is|are|can|could|should|tell|explain)\b/i.test(lower);

  return !looksLikeQuestion && (directAddIntent || priorAssistantAskedChoice);
}

function findExactLiveSelectionActionsFromQuestion(question = "", liveProducts = [], kitContext = {}, history = []) {
  if (!kitAiQuestionLooksLikeExactProductSelection(question, history, liveProducts)) return [];

  const exactMatches = findExactLiveProductsMentionedInText(question, liveProducts);
  if (!exactMatches.length) return [];

  const actions = [];
  const seen = new Set();

  for (const live of exactMatches.slice(0, 3)) {
    const candidate = normalizeKitAiRecommendedProducts([{
      name: live.name || "",
      sku: live.sku || (Array.isArray(live.variantSkus) ? live.variantSkus[0] : "") || "",
      qty: 1,
      type: getKitAiIntegrationProductBucket(live),
      reason: "Customer selected an exact live product option from the previous assistant choice."
    }], liveProducts)[0];

    if (!candidate || candidate.auto_addable !== true) continue;

    const key = `${candidate.sku || ""}|${candidate.name || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    actions.push({
      action: "add",
      name: candidate.name,
      sku: candidate.sku,
      qty: candidate.qty || 1,
      type: candidate.type || "",
      reason: candidate.reason || "",
      ...(candidate.builder_product_id ? { builder_product_id: candidate.builder_product_id } : {}),
      ...(candidate.builder_driver_id ? { builder_driver_id: candidate.builder_driver_id } : {}),
      auto_addable: true
    });
  }

  return actions.slice(0, 3);
}

function kitAiAnswerClaimsImmediateKitMutation(answer = "") {
  const text = String(answer || "").toLowerCase();
  return (
    /\bi(?:'m| am)\s+(?:now\s+)?adding\b/i.test(text) ||
    /\bi(?:'m| am)\s+(?:now\s+)?updating\b/i.test(text) ||
    /\badding\b.{0,80}\bto your kit\b/i.test(text) ||
    /\bupdating\b.{0,80}\bactive kit\b/i.test(text)
  );
}

function repairUnsupportedImmediateKitMutationClaim({
  answer = "",
  activeKitActions = [],
  recommendedProducts = [],
  liveProducts = [],
  question = ""
} = {}) {
  if (!kitAiAnswerClaimsImmediateKitMutation(answer)) return answer;
  if ((Array.isArray(activeKitActions) && activeKitActions.length) ||
      (Array.isArray(recommendedProducts) && recommendedProducts.length)) {
    return answer;
  }

  const liveMatches = findExactLiveProductsMentionedInText(`${question}\n${answer}`, liveProducts);
  if (liveMatches.length) {
    const labels = liveMatches
      .slice(0, 3)
      .map((p) => kitAiProductLabel(p))
      .filter(Boolean)
      .join(", ");

    return `I found the live product ${labels}. I cannot honestly say it was added automatically from this message because no confirmed kit-builder add action was prepared. Please send the exact product name again after I offer the addable option, or add it manually from the builder if it is visible.`;
  }

  return "I found your request, but I cannot honestly say the kit was updated automatically because no confirmed kit-builder add action was prepared. Please name the exact product again or add it manually from the builder if it is visible.";
}

function repairFalseNotLiveKitAiAnswer({
  answer = "",
  question = "",
  liveProducts = []
} = {}) {
  const text = String(answer || "");
  if (!/\bnot currently listed live on the website\b/i.test(text)) return answer;

  const liveMatches = findExactLiveProductsMentionedInText(`${question}\n${text}`, liveProducts);
  if (!liveMatches.length) return answer;

  const labels = liveMatches
    .slice(0, 3)
    .map((p) => kitAiProductLabel(p))
    .filter(Boolean)
    .join(", ");

  return `This product is listed live on the website: ${labels}. I will not mark it as unavailable. If you want it added to the kit, send the exact product name or choose the addable option I show.`;
}

function normalizeKitAiActiveKitActions(actions = [], liveProducts = [], kitContext = {}) {
  const normalized = [];
  const source = Array.isArray(actions) ? actions : [];
  const activeKitText = getActiveKitTextForMatch(kitContext);

  for (const rawAction of source) {
    const action = String(rawAction?.action || "").trim().toLowerCase();
    if (!["add", "remove"].includes(action)) continue;

    if (action === "add") {
      const candidate = normalizeKitAiRecommendedProducts([rawAction], liveProducts)[0];
      if (!candidate) continue;
      normalized.push({
        action: "add",
        name: candidate.name,
        sku: candidate.sku,
        qty: candidate.qty,
        type: candidate.type,
        reason: stripMarkdownForCustomer(rawAction?.reason || candidate.reason || ""),
        ...(candidate.builder_product_id ? { builder_product_id: candidate.builder_product_id } : {}),
        ...(candidate.builder_driver_id ? { builder_driver_id: candidate.builder_driver_id } : {}),
        ...(rawAction?.increment_existing ? { increment_existing: true } : {}),
        auto_addable: !!candidate.auto_addable
      });
      continue;
    }

    // Remove actions target items that are already in the active kit.
    const name = stripMarkdownForCustomer(rawAction?.name || rawAction?.target || "").slice(0, 220);
    const sku = String(rawAction?.sku || "").trim().slice(0, 120);
    const type = String(rawAction?.type || "").trim().slice(0, 80);
    const reason = stripMarkdownForCustomer(rawAction?.reason || "").slice(0, 220);

    if (!name && !sku) continue;

    const query = compactTextForMatch(`${sku} ${name}`);
    const mayExistInActiveKit =
      !activeKitText ||
      (query && query.split(" ").some((token) => token.length >= 3 && activeKitText.includes(token)));

    if (!mayExistInActiveKit) {
      // Keep the request; the frontend performs the final state check honestly.
    }

    normalized.push({
      action: "remove",
      name,
      sku,
      qty: 1,
      type,
      reason,
      ...getKitAiBuilderMapping({ name, sku, type }, null)
    });
  }

  return enforceKitAiDualLedWireQuantity(normalized.slice(0, 12), kitContext || {});
}

function extractNumbersFromText(text) {
  return Array.from(new Set(String(text || "").match(/\b\d{2,4}\b/g) || []));
}

function findLiveProductsByNumber(text, liveProducts = [], max = 8) {
  const nums = extractNumbersFromText(text);
  if (!nums.length) return [];

  return (liveProducts || [])
    .filter((p) => {
      const haystack = [
        p.name,
        p.sku,
        Array.isArray(p.variantSkus) ? p.variantSkus.join(" ") : "",
        Array.isArray(p.variantNames) ? p.variantNames.join(" ") : "",
        p.description
      ].filter(Boolean).join(" ").toLowerCase();

      return nums.some((num) => new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(haystack));
    })
    .slice(0, max);
}

function hasLiveProductMention(text, liveProducts = []) {
  const q = String(text || "").toLowerCase();

  return (liveProducts || []).some((p) => {
    const skus = [
      p.sku,
      ...(Array.isArray(p.variantSkus) ? p.variantSkus : [])
    ].filter(Boolean).map((x) => String(x).toLowerCase());

    if (skus.some((sku) => sku && q.includes(sku))) return true;

    const name = String(p.name || "").toLowerCase();
    if (name && name.length > 5 && q.includes(name)) return true;

    return false;
  });
}

function buildLiveProductCorrectionAnswer(question, liveMatches = []) {
  if (!liveMatches.length) return "";

  const lines = liveMatches.map((p) => {
    const sku = p.sku || (Array.isArray(p.variantSkus) ? p.variantSkus[0] : "") || "";
    return `${sku ? `${sku} - ` : ""}${p.name}${p.price ? ` (₹${p.price})` : ""}`;
  });

  return [
    "You are right, this product is listed live on the website.",
    "",
    "I found:",
    lines.join("\n"),
    "",
    "Smart Handicrafts rule: DRIVER-204 is the normal-charging rechargeable strip LED driver, while DRIVER-205 / AS-U-205-LSD is treated as the fast-charging rechargeable strip LED driver. Do not infer USB-only behavior from the AS-U prefix for 205."
  ].join("\n");
}

function buildAvailableProductSummary(liveProducts = [], max = 12) {
  const rows = (liveProducts || [])
    .filter((p) => p.name)
    .slice(0, max)
    .map((p) => {
      const sku = p.sku || (Array.isArray(p.variantSkus) && p.variantSkus[0]) || "";
      return `- ${sku ? `${sku}: ` : ""}${p.name}${p.price ? ` (₹${p.price})` : ""}`;
    })
    .join("\n");

  return rows || "- No live products available.";
}


const KIT_AI_MODEL = process.env.KIT_AI_MODEL || GEMINI_MODEL;
const KIT_AI_MAX_PROMPT_PRODUCTS = Math.max(6, Number(process.env.KIT_AI_MAX_PROMPT_PRODUCTS || 12));
const KIT_AI_MAX_RELEVANT_RULES = Math.max(2, Number(process.env.KIT_AI_MAX_RELEVANT_RULES || 8));
const KIT_AI_THINKING_BUDGET = Math.max(0, Number(process.env.KIT_AI_THINKING_BUDGET || 0));
const KIT_AI_PRODUCT_DESCRIPTION_CHARS = Math.max(80, Number(process.env.KIT_AI_PRODUCT_DESCRIPTION_CHARS || 220));
const KIT_AI_MAX_INTEGRATION_PROMPT_PRODUCTS = Math.max(
  KIT_AI_MAX_PROMPT_PRODUCTS,
  Number(process.env.KIT_AI_MAX_INTEGRATION_PROMPT_PRODUCTS || 14)
);

function buildKitAiGeminiConfig() {
  const config = {
    temperature: 0.35
  };

  // Gemini 2.5 Flash supports disabling thinking with thinkingBudget: 0.
  // Keep this conditional so a future KIT_AI_MODEL switch does not break requests.
  if (/gemini-2\.5-(?:flash|flash-lite)/i.test(String(KIT_AI_MODEL || ""))) {
    config.thinkingConfig = {
      thinkingBudget: KIT_AI_THINKING_BUDGET
    };
  }

  return config;
}

const KIT_AI_ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp"
]);

const KIT_AI_MAX_IMAGE_BASE64_CHARS = Math.max(
  300000,
  Number(process.env.KIT_AI_MAX_IMAGE_BASE64_CHARS || 3200000)
);

function normalizeKitAiLampReferenceImage(rawImage = null) {
  if (!rawImage || typeof rawImage !== "object") return null;

  let mimeType = String(rawImage.mimeType || rawImage.mime_type || "").trim().toLowerCase();
  let data = String(rawImage.data || rawImage.base64 || "").trim();

  // Accept a data URL too, although the frontend sends a compact base64 payload.
  const dataUrlMatch = data.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    mimeType = String(dataUrlMatch[1] || mimeType).trim().toLowerCase();
    data = String(dataUrlMatch[2] || "").trim();
  }

  if (mimeType === "image/jpg") mimeType = "image/jpeg";
  if (!KIT_AI_ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) return null;

  data = data.replace(/\s+/g, "");
  if (!data || data.length > KIT_AI_MAX_IMAGE_BASE64_CHARS) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(data)) return null;

  return {
    mimeType,
    data,
    name: String(rawImage.name || "").slice(0, 180),
    width: Number(rawImage.width || 0) || null,
    height: Number(rawImage.height || 0) || null
  };
}

function sanitizeKitAiLampReferenceSummary(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function defaultKitAiImageQuestion() {
  return "Please analyze this lamp reference image and suggest how Smart Handicrafts products could be integrated into a similar lamp design.";
}

function buildKitAiGeminiContents(prompt, lampReferenceImage = null) {
  if (!lampReferenceImage) return prompt;

  return [
    {
      role: "user",
      parts: [
        {
          text: String(prompt || "")
        },
        {
          inlineData: {
            mimeType: lampReferenceImage.mimeType,
            data: lampReferenceImage.data
          }
        }
      ]
    }
  ];
}

function getProductSearchText(product = {}) {
  return [
    product.name,
    product.sku,
    Array.isArray(product.variantSkus) ? product.variantSkus.join(" ") : "",
    Array.isArray(product.variantNames) ? product.variantNames.join(" ") : "",
    product.description,
    product.url
  ].filter(Boolean).join(" ").toLowerCase();
}

function buildKitAiSearchText({ question, pageContext, kitContext } = {}) {
  const compactContext = {
    selectedApplication: kitContext?.kitBuilderSnapshot?.selectedApplication || "",
    selectedDriver: kitContext?.kitBuilderSnapshot?.selectedDriver || "",
    activeKitItems: kitContext?.kitBuilderSnapshot?.activeKitItems || [],
    savedKits: kitContext?.kitBuilderSnapshot?.savedKits || [],
    currentLoad: kitContext?.kitBuilderSnapshot?.currentLoad || "",
    currentRuntime: kitContext?.kitBuilderSnapshot?.currentRuntime || "",
    completionMessage: kitContext?.kitBuilderSnapshot?.completionMessage || "",
    productTitle: pageContext?.productTitle || "",
    pageTitle: pageContext?.pageTitle || ""
  };

  return `${question || ""}\n${JSON.stringify(compactContext)}`.toLowerCase();
}


function kitAiProductHaystack(product = {}) {
  return getProductSearchText(product);
}

function findBestLiveProductBySignals(liveProducts = [], { must = [], prefer = [], exclude = [] } = {}) {
  const rows = (liveProducts || [])
    .map((product) => {
      const text = kitAiProductHaystack(product);
      if (!text) return null;
      if ((exclude || []).some((pattern) => pattern.test(text))) return null;
      if ((must || []).some((pattern) => !pattern.test(text))) return null;

      let score = 0;
      for (const pattern of prefer || []) {
        if (pattern.test(text)) score += 10;
      }
      score += String(product?.sku || "").trim() ? 2 : 0;
      score += String(product?.name || "").trim() ? 1 : 0;
      return { product, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return rows[0]?.product || null;
}

function kitAiProductTitleSkuText(product = {}) {
  return [
    product?.name || "",
    product?.sku || "",
    ...(Array.isArray(product?.variantSkus) ? product.variantSkus : []),
    ...(Array.isArray(product?.variantNames) ? product.variantNames : [])
  ].filter(Boolean).join(" ").toLowerCase();
}

function findBestLiveProductByTitleSkuSignals(liveProducts = [], { must = [], prefer = [], exclude = [] } = {}) {
  const rows = (liveProducts || [])
    .map((product) => {
      const text = kitAiProductTitleSkuText(product);
      if (!text) return null;
      if ((exclude || []).some((pattern) => pattern.test(text))) return null;
      if ((must || []).some((pattern) => !pattern.test(text))) return null;

      let score = 0;
      for (const pattern of prefer || []) {
        if (pattern.test(text)) score += 10;
      }
      score += String(product?.sku || "").trim() ? 2 : 0;
      score += String(product?.name || "").trim() ? 1 : 0;
      return { product, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return rows[0]?.product || null;
}

function isKitAiStarterOrCompletionQuestion(question = "") {
  const q = String(question || "").toLowerCase();
  return (
    /\b(starter kit|best starter|suggest the best|suggest.*kit|complete.*kit|complete my kit|missing parts?|what should i add|what to add|build.*kit|make.*kit)\b/i.test(q) ||
    /\b(choose|recommend)\b.{0,50}\b(kit|parts|items)\b/i.test(q)
  );
}

function isKitAiExplicitDirectAddQuestion(question = "") {
  const q = String(question || "").toLowerCase().trim();
  return (
    /\b(add|put|include|select)\b/i.test(q) &&
    /\b(led|3w|5w|battery|18650|2600|jst|wire|driver|201|202|204|205|206|101|102|103)\b/i.test(q) &&
    !/\b(add all|add them|add these|add those|add recommended|add suggested)\b/i.test(q)
  );
}

function findDefault201StarterKitLiveProducts(liveProducts = [], kitContext = {}, question = "") {
  const selectedDriverText = String(kitContext?.kitBuilderSnapshot?.selectedDriver || "").toLowerCase();
  const q = String(question || "").toLowerCase();

  const is201Context =
    selectedDriverText.includes("201") ||
    selectedDriverText.includes("as-b-201") ||
    /\b201\b/.test(q);

  if (!is201Context) return [];

  const led3w = findBestLiveProductByTitleSkuSignals(liveProducts, {
    must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i],
    exclude: [/\b(strip|lsd|12v|24v)\b/i],
    prefer: [/\bled\s*-?\s*cree\s*cob\s*3\s*w\b/i, /\bcob\b/i, /\bcree\b/i, /\bsh-cob-3\b/i]
  }) || findBestLiveProductBySignals(liveProducts, {
    must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i],
    exclude: [/\b(strip|lsd|12v|24v)\b/i],
    prefer: [/\bcob\b/i, /\bcree\b/i, /\bsh-cob-3\b/i]
  });

  // For DRIVER-201 starter kit, prefer the 2600mAh sleeved battery where it is live.
  // Do not accidentally pick an unrelated battery just because it contains generic "battery" wording.
  const battery2600Sleeve = findBestLiveProductByTitleSkuSignals(liveProducts, {
    must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\bsleeve\b/i],
    prefer: [/\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
  }) || findBestLiveProductBySignals(liveProducts, {
    must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\bsleeve\b/i],
    prefer: [/\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
  });

  const battery2600Any = findBestLiveProductByTitleSkuSignals(liveProducts, {
    must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i],
    prefer: [/\bsleeve\b/i, /\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
  }) || findBestLiveProductBySignals(liveProducts, {
    must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i],
    prefer: [/\bsleeve\b/i, /\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
  });

  // User preference: when we suggest a battery, prioritize 2600mAh,
  // and primarily choose the sleeve battery. Do not silently fall back to 1200mAh.
  const battery = battery2600Sleeve || battery2600Any;

  // Restrict JST wire matching to visible product title/SKU/variant names.
  // Battery descriptions often mention JST, which previously caused a battery to be mistaken for a JST wire.
  const jstWire = findBestLiveProductByTitleSkuSignals(liveProducts, {
    must: [/\bjst\b/i, /\b(wire|cable|connector)\b/i],
    exclude: [/\b(battery|18650|cell)\b/i],
    prefer: [/\bdual\s*side\b/i, /\bledwire\b/i, /\bwire\b/i, /\bcable\b/i, /\bconnector\b/i]
  });

  const ordered = [led3w, battery, jstWire].filter(Boolean);
  const deduped = [];
  const seen = new Set();

  for (const product of ordered) {
    const key = `${String(product?.sku || "").toLowerCase()}|${String(product?.name || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(product);
  }

  return deduped;
}

function isKitAiSelected202Context(kitContext = {}, question = "") {
  const selectedDriverText = String(kitContext?.kitBuilderSnapshot?.selectedDriver || "").toLowerCase();
  const q = String(question || "").toLowerCase();

  return (
    selectedDriverText.includes("202") ||
    selectedDriverText.includes("as-b-202") ||
    /\b202\b/.test(q)
  );
}

function findDefault202CompletionLiveProducts(liveProducts = [], kitContext = {}, question = "") {
  if (!isKitAiSelected202Context(kitContext, question)) return [];

  const dualLed3w = findBestLiveProductByTitleSkuSignals(liveProducts, {
    must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i, /\b(dual|cct|warm[-\s]?cool|warm cool)\b/i],
    exclude: [/\b(strip|lsd|12v|24v)\b/i],
    prefer: [/\bsh-cob-3d\b/i, /\bled\s*-?\s*cree\s*3\s*w\s*dual\b/i, /\b3\s*w\s*dual\b/i, /\bdual\b/i]
  }) || findBestLiveProductBySignals(liveProducts, {
    must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i, /\b(dual|cct|warm[-\s]?cool|warm cool)\b/i],
    exclude: [/\b(strip|lsd|12v|24v)\b/i],
    prefer: [/\bsh-cob-3d\b/i, /\b3\s*w\s*dual\b/i, /\bdual\b/i]
  });

  const battery2600Sleeve = findBestLiveProductByTitleSkuSignals(liveProducts, {
    must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\bsleeve\b/i],
    prefer: [/\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
  }) || findBestLiveProductBySignals(liveProducts, {
    must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\bsleeve\b/i],
    prefer: [/\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
  });

  const battery2600Any = findBestLiveProductByTitleSkuSignals(liveProducts, {
    must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i],
    prefer: [/\bsleeve\b/i, /\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i],
    exclude: [/\b5200\b/i]
  }) || findBestLiveProductBySignals(liveProducts, {
    must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i],
    prefer: [/\bsleeve\b/i, /\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i],
    exclude: [/\b5200\b/i]
  });

  // User preference: when we suggest a battery, prioritize 2600mAh,
  // and primarily choose the sleeve battery. Do not silently fall back to 1200mAh.
  const battery = battery2600Sleeve || battery2600Any;

  const jstWire = findBestLiveProductByTitleSkuSignals(liveProducts, {
    must: [/\bjst\b/i, /\b(wire|cable|connector)\b/i],
    exclude: [/\b(battery|18650|cell)\b/i],
    prefer: [/\bledwire\b/i, /\bdual\s*side\b/i, /\b2\s*pin\b/i, /\bwire\b/i]
  });

  const ordered = [dualLed3w, battery, jstWire].filter(Boolean);
  const deduped = [];
  const seen = new Set();

  for (const product of ordered) {
    const key = `${String(product?.sku || "").toLowerCase()}|${String(product?.name || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(product);
  }

  return deduped;
}

function build202CompletionOverrideAnswer(products = []) {
  const labels = (products || []).map((p) => {
    const sku = String(p?.sku || "").trim();
    const name = String(p?.name || "").trim();
    return sku ? `${name} (${sku})` : name;
  }).filter(Boolean);

  if (!labels.length) return "";

  return [
    "For your selected DRIVER- 202 DUAL LED DRIVER, I would add these live matching kit items:",
    labels.join(", ") + ".",
    "This is the cleaner standard path for a 202 rechargeable dual-LED kit. Should I add all these to your active kit?"
  ].join("\n\n");
}

function build201StarterKitOverrideAnswer(products = []) {
  const labels = (products || []).map((p) => {
    const sku = String(p?.sku || "").trim();
    const name = String(p?.name || "").trim();
    return sku ? `${name} (${sku})` : name;
  }).filter(Boolean);

  if (!labels.length) return "";

  return [
    "For a solid starter setup around your selected DRIVER - 201 Rechargeable 1 Color, I would add these live kit items:",
    labels.join(", ") + ".",
    "This gives you the core LED, battery, and connection pieces needed to move toward a usable rechargeable lamp kit. Should I add all these to your active kit?"
  ].join("\n\n");
}

function findDirectAddLiveActionsFromQuestion(question = "", liveProducts = [], kitContext = {}) {
  const q = String(question || "").toLowerCase();
  if (!isKitAiExplicitDirectAddQuestion(q)) return [];

  const actions = [];
  const seen = new Set();

  function pushAdd(product, reason = "") {
    if (!product) return;
    const key = `${String(product.sku || "").toLowerCase()}|${String(product.name || "").toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push({
      action: "add",
      name: product.name || "",
      sku: product.sku || (Array.isArray(product.variantSkus) ? product.variantSkus[0] : "") || "",
      qty: 1,
      /*
        If the user says "add one more", "another", "extra", or "additional",
        keep the add action instead of collapsing it into "already present".
        The frontend uses this flag to increment the existing kit quantity.
      */
      increment_existing: /\b(one\s+more|another|extra|additional)\b/i.test(q),
      type: getKitAiIntegrationProductBucket(product),
      reason
    });
  }

  if (/\b3\s*w\b|\b3w\b/i.test(q) && /\bled\b|\bcob\b/i.test(q)) {
    pushAdd(
      findBestLiveProductByTitleSkuSignals(liveProducts, {
        must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i],
        exclude: [/\b(strip|lsd|12v|24v)\b/i],
        prefer: [/\bled\s*-?\s*cree\s*cob\s*3\s*w\b/i, /\bsh-cob-3\b/i, /\bcob\b/i, /\bcree\b/i]
      }) || findBestLiveProductBySignals(liveProducts, {
        must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i],
        exclude: [/\b(strip|lsd|12v|24v)\b/i],
        prefer: [/\bsh-cob-3\b/i, /\bcob\b/i, /\bcree\b/i]
      }),
      "User explicitly asked to add a 3W LED."
    );
  } else if (/\b5\s*w\b|\b5w\b/i.test(q) && /\bled\b|\bcob\b/i.test(q)) {
    pushAdd(
      findBestLiveProductBySignals(liveProducts, {
        must: [/\b(led|cob)\b/i, /\b5\s*w\b|\b5w\b/i],
        exclude: [/\b(strip|lsd)\b/i],
        prefer: [/\bcob\b/i, /\bcree\b/i]
      }),
      "User explicitly asked to add a 5W LED."
    );
  }

  /*
    Battery direct-add safety:
    "2600mAh" alone is not enough to choose between sleeve and without-sleeve.
    Only add a battery when the user explicitly states the exact variant/capacity path.
  */
  const asksBattery = /\b(battery|18650|1200|1800|2600|5200|mah)\b/i.test(q);
  const asks2600WithSleeve =
    /\b2600\b/i.test(q) &&
    /\b(with\s+sleeve|sleeve\s+battery|2600\s+sleeve|sh[-\s]?bat[-\s]?26s)\b/i.test(q) &&
    !/\bwithout\s+sleeve|no\s+sleeve|26[-\s]?ws\b/i.test(q);
  const asks2600WithoutSleeve =
    /\b2600\b/i.test(q) &&
    /\b(without\s+sleeve|no\s+sleeve|26[-\s]?ws|sh[-\s]?bat[-\s]?26[-\s]?ws)\b/i.test(q);
  const asks5200 = /\b5200\b|\bsh[-\s]?bat[-\s]?5000\b/i.test(q);
  const asks1200 = /\b1200\b|\bsh[-\s]?bat[-\s]?1200\b/i.test(q);
  const asks1800 = /\b1800\b|\bsh[-\s]?bat[-\s]?1800\b/i.test(q);

  if (asksBattery && asks2600WithSleeve) {
    pushAdd(
      findBestLiveProductByTitleSkuSignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\bsleeve\b/i],
        exclude: [/\bwithout\s+sleeve|no\s+sleeve\b/i],
        prefer: [/\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
      }) || findBestLiveProductBySignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\bsleeve\b/i],
        exclude: [/\bwithout\s+sleeve|no\s+sleeve\b/i],
        prefer: [/\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
      }),
      "User explicitly chose the 2600mAh battery with sleeve."
    );
  } else if (asksBattery && asks2600WithoutSleeve) {
    pushAdd(
      findBestLiveProductByTitleSkuSignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\b(without\s+sleeve|no\s+sleeve)\b/i],
        prefer: [/\bsh-bat-26-ws\b/i, /\b18650\b/i, /\bmah\b/i]
      }) || findBestLiveProductBySignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\b(without\s+sleeve|no\s+sleeve)\b/i],
        prefer: [/\bsh-bat-26-ws\b/i, /\b18650\b/i, /\bmah\b/i]
      }),
      "User explicitly chose the 2600mAh battery without sleeve."
    );
  } else if (asksBattery && asks5200) {
    pushAdd(
      findBestLiveProductByTitleSkuSignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b5200\b/i],
        prefer: [/\bsh-bat-5000\b/i, /\bmah\b/i]
      }) || findBestLiveProductBySignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b5200\b/i],
        prefer: [/\bsh-bat-5000\b/i, /\bmah\b/i]
      }),
      "User explicitly asked to add the 5200mAh battery."
    );
  } else if (asksBattery && asks1200) {
    pushAdd(
      findBestLiveProductBySignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b1200\b/i],
        prefer: [/\bsh-bat-1200\b/i, /\bmah\b/i]
      }),
      "User explicitly asked to add the 1200mAh battery."
    );
  } else if (asksBattery && asks1800) {
    pushAdd(
      findBestLiveProductBySignals(liveProducts, {
        must: [/\b(battery|18650|cell)\b/i, /\b1800\b/i],
        prefer: [/\bsh-bat-1800\b/i, /\bmah\b/i]
      }),
      "User explicitly asked to add the 1800mAh battery."
    );
  }

  if (/\b(jst|wire)\b/i.test(q)) {
    pushAdd(
      findBestLiveProductBySignals(liveProducts, {
        must: [/\bjst\b/i],
        prefer: [/\bwire\b/i, /\bcable\b/i, /\bconnector\b/i]
      }),
      "User explicitly asked to add a JST wire."
    );
  }

  const driverNumber = (q.match(/\b(101|102|103|201|202|204|205|206)\b/) || [])[1];
  if (driverNumber && /\b(driver|switch|replace|select|add)\b/i.test(q)) {
    pushAdd(
      findBestLiveProductBySignals(liveProducts, {
        must: [new RegExp(`(^|[^0-9])${driverNumber}([^0-9]|$)`, "i")],
        prefer: [/\bdriver\b/i, /\bmodule\b/i, /\bdob\b/i]
      }),
      `User explicitly asked for driver ${driverNumber}.`
    );
  }

  return actions.slice(0, 4);
}

function buildKitAiAlternativeProducts(primaryProducts = [], liveProducts = [], kitContext = {}) {
  /*
    V12: Do not auto-append brightness or capacity "alternatives" after a kit update.
    Those alternatives previously made the assistant feel as if it was upselling
    or silently pivoting from a user-stated 3W / 2600mAh path. Real alternatives
    are now handled conversationally as explicit step choices before the add action.
  */
  return [];
}

function scoreLiveProductForKitAi(product, searchText) {
  const haystack = getProductSearchText(product);
  if (!haystack) return 0;

  let score = 0;
  const q = String(searchText || "").toLowerCase();

  const rules = [
    [/strip|linear|cob\s*strip|12v|24v/, /strip|linear|12v|24v|lsd|103|204|205/],
    [/recharge|battery|wireless|portable/, /recharge|battery|18650|201|202|204|205|206/],
    [/usb|type-c|type c|usb-c/, /usb|type-c|type c|usb-c|101|102|103/],
    [/dob|driver on board/, /dob|206/],
    [/jst|wire|connector|cable/, /jst|wire|connector|cable/],
    [/led|cob|watt|w\b|3w|5w|2w/, /led|cob|3w|5w|2w|0\.5w/],
    [/battery|mah|18650/, /battery|mah|18650|cell/],
    [/touch|dimming|dimmer/, /touch|dimm|driver/]
  ];

  for (const [queryPattern, productPattern] of rules) {
    if (queryPattern.test(q) && productPattern.test(haystack)) score += 10;
  }

  const tokens = Array.from(new Set(q.match(/[a-z0-9-]{3,}/g) || []))
    .filter((token) => !["lamp", "making", "need", "help", "right", "smart", "handicrafts", "expert"].includes(token))
    .slice(0, 40);

  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length > 4 ? 3 : 1;
  }

  
  const numericExactMatches = Array.from(q.matchAll(/\b\d{2,4}\b/g)).map((m) => m[0]);
  for (const num of numericExactMatches) {
    if (new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(haystack)) score += 35;
  }

  if (product.sku && q.includes(String(product.sku).toLowerCase())) score += 25;
  if (Array.isArray(product.variantSkus)) {
    for (const sku of product.variantSkus) {
      if (sku && q.includes(String(sku).toLowerCase())) score += 30;
    }
  }

  // strip driver exact 205 boost
  if (/\b205\b/.test(q) && /205/.test(haystack)) score += 45;
  if (/strip/.test(q) && /strip|lsd/.test(haystack)) score += 20;

  return score;
}




function kitAiProductLabel(product = {}) {
  const name = String(product?.name || "").trim();
  const sku = String(product?.sku || (Array.isArray(product?.variantSkus) ? product.variantSkus[0] : "") || "").trim();
  return sku ? `${name} (${sku})` : name;
}

function kitAiActiveText(kitContext = {}) {
  const snapshot = kitContext?.kitBuilderSnapshot || {};
  return [
    snapshot.selectedDriver || "",
    ...(Array.isArray(snapshot.activeKitItems) ? snapshot.activeKitItems : []),
    ...(Array.isArray(snapshot.selectedItemIds) ? snapshot.selectedItemIds : [])
  ].join(" ").toLowerCase();
}

function kitAiHasActiveLed(kitContext = {}) {
  return /\b(led|cob|strip)\b/i.test(kitAiActiveText(kitContext));
}

function kitAiHasActiveBattery(kitContext = {}) {
  return /\b(battery|18650|mah)\b/i.test(kitAiActiveText(kitContext));
}

function kitAiHasActiveWire(kitContext = {}) {
  return /\b(jst|wire|cable)\b/i.test(kitAiActiveText(kitContext));
}

function kitAiFind2600BatteryVariants(liveProducts = []) {
  const withSleeve =
    findBestLiveProductByTitleSkuSignals(liveProducts, {
      must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\bsleeve\b/i],
      exclude: [/\bwithout\s+sleeve|no\s+sleeve\b/i],
      prefer: [/\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
    }) ||
    findBestLiveProductBySignals(liveProducts, {
      must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\bsleeve\b/i],
      exclude: [/\bwithout\s+sleeve|no\s+sleeve\b/i],
      prefer: [/\bsh-bat-26s\b/i, /\b18650\b/i, /\bmah\b/i]
    });

  const withoutSleeve =
    findBestLiveProductByTitleSkuSignals(liveProducts, {
      must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\b(without\s+sleeve|no\s+sleeve)\b/i],
      prefer: [/\bsh-bat-26-ws\b/i, /\b18650\b/i, /\bmah\b/i]
    }) ||
    findBestLiveProductBySignals(liveProducts, {
      must: [/\b(battery|18650|cell)\b/i, /\b2600\b/i, /\b(without\s+sleeve|no\s+sleeve)\b/i],
      prefer: [/\bsh-bat-26-ws\b/i, /\b18650\b/i, /\bmah\b/i]
    });

  return { withSleeve, withoutSleeve };
}

function kitAiFind201Driver(liveProducts = []) {
  return findBestLiveProductByTitleSkuSignals(liveProducts, {
    must: [/\b201\b/i, /\b(driver|module)\b/i],
    prefer: [/\bas-b-201-sld\b/i, /\brechargeable\b/i, /\b1\s*color\b|\bsingle\b/i],
    exclude: [/\blc\b/i]
  }) || findBestLiveProductBySignals(liveProducts, {
    must: [/\b201\b/i, /\b(driver|module)\b/i],
    prefer: [/\bas-b-201-sld\b/i, /\brechargeable\b/i],
    exclude: [/\blc\b/i]
  });
}

function kitAiFind3wSingleLed(liveProducts = []) {
  return findBestLiveProductByTitleSkuSignals(liveProducts, {
    must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i],
    exclude: [/\b(strip|lsd|12v|24v|dual|cct)\b/i],
    prefer: [/\bsh-cob-3\b/i, /\bcob\b/i, /\bcree\b/i]
  }) || findBestLiveProductBySignals(liveProducts, {
    must: [/\b(led|cob)\b/i, /\b3\s*w\b|\b3w\b/i],
    exclude: [/\b(strip|lsd|12v|24v|dual|cct)\b/i],
    prefer: [/\bsh-cob-3\b/i, /\bcob\b/i, /\bcree\b/i]
  });
}

function kitAiQuestionRequestsGeneric2600BatteryChoice(question = "") {
  const q = String(question || "").toLowerCase().trim();
  const mentions2600 = /\b2600\b/.test(q);
  const namesVariant = /\b(with\s+sleeve|without\s+sleeve|no\s+sleeve|26[-\s]?ws|26s)\b/i.test(q);
  return mentions2600 && !namesVariant;
}

function kitAiQuestionAsksWhichBattery(question = "") {
  const q = String(question || "").toLowerCase();
  const genericAddBattery =
    /\b(add|select|include|put)\s+(a\s+|the\s+)?battery\b/i.test(q) &&
    !/\b(1200|1800|2600|5200|with\s+sleeve|without\s+sleeve|no\s+sleeve)\b/i.test(q);

  return (
    /\b(which|what)\s+battery\b/i.test(q) ||
    /\bbattery\s+(should|would)\s+i\s+(use|choose|take)\b/i.test(q) ||
    /^\s*battery\s*\??\s*$/i.test(q) ||
    genericAddBattery ||
    kitAiQuestionRequestsGeneric2600BatteryChoice(q)
  );
}

function kitAiQuestionNeedsLedChoice(question = "", kitContext = {}) {
  const q = String(question || "").toLowerCase();
  const snapshot = kitContext?.kitBuilderSnapshot || {};
  const driverSelected = String(snapshot.selectedDriver || "").trim();
  const asksBuildOrComplete = /\b(build|make|complete|kit|lamp|suggest|recommend|choose)\b/i.test(q);
  const specifiesLedPower = /\b(2\s*w|2w|3\s*w|3w|5\s*w|5w|strip|dob)\b/i.test(q);
  return !!driverSelected && !kitAiHasActiveLed(kitContext) && asksBuildOrComplete && !specifiesLedPower;
}

function kitAiQuestionNeedsBatteryChoice(question = "", kitContext = {}) {
  const q = String(question || "").toLowerCase();
  const asksBuildOrComplete = /\b(build|make|complete|kit|lamp|suggest|recommend|choose|battery|runtime|backup)\b/i.test(q);
  const specifiesBattery = /\b(1200|1800|2600|5200|mah|long\s+runtime|long\s+backup|with\s+sleeve|without\s+sleeve)\b/i.test(q);
  return kitAiHasActiveLed(kitContext) && !kitAiHasActiveBattery(kitContext) && asksBuildOrComplete && !specifiesBattery;
}

function kitAiQuestionLooksLikeRechargeableSingle3wWarmLamp(question = "") {
  const q = String(question || "").toLowerCase();
  return (
    /\brechargeable\b/i.test(q) &&
    /\b(lamp|table\s+lamp|touch\s+lamp)\b/i.test(q) &&
    /\b3\s*w\b|\b3w\b/i.test(q) &&
    /\b(warm|warm\s+white|ww|2700|3000)\b/i.test(q) &&
    !/\b(strip|dual|cct|rgb|dob)\b/i.test(q)
  );
}

function filterUnsafeKitAiRecommendations(products = [], question = "") {
  const q = String(question || "").toLowerCase();

  return (Array.isArray(products) ? products : []).filter((product) => {
    const text = `${product?.sku || ""} ${product?.name || ""} ${product?.type || ""}`.toLowerCase();

    // Never upshift 3W intent into 5W unless the user explicitly asks for 5W/brighter output.
    if (/\b5\s*w\b|\b5w\b/i.test(text) && !/\b5\s*w\b|\b5w\b|\bbrighter\b|\bhigh\s+brightness\b/i.test(q)) {
      return false;
    }

    // Do not default to 5200mAh unless the user asks for it or clearly asks for longer backup.
    if (/\b5200\b|\bsh-bat-5000\b/i.test(text) && !/\b5200\b|\blong\s+(runtime|backup)\b|\bmaximum\s+runtime\b|\bmore\s+backup\b/i.test(q)) {
      return false;
    }

    // A generic "2600mAh" mention must remain a variant choice, not an addable final recommendation.
    if (/\b2600\b/i.test(text) && kitAiQuestionRequestsGeneric2600BatteryChoice(q)) {
      return false;
    }

    return true;
  });
}

function applyGuidedKitAiFlowOverrides({
  question = "",
  kitContext = {},
  liveProducts = [],
  answer = "",
  recommendedProducts = [],
  activeKitActions = [],
  alternativeProducts = [],
  actionOffer = "none"
} = {}) {
  const q = String(question || "").trim();
  const qLower = q.toLowerCase();
  const snapshot = kitContext?.kitBuilderSnapshot || {};

  let nextAnswer = answer;
  let nextRecommended = filterUnsafeKitAiRecommendations(recommendedProducts, q)
    .filter((product) => product && product.auto_addable !== false);
  let nextActions = (Array.isArray(activeKitActions) ? activeKitActions : [])
    .filter((action) => action && (action.action === "remove" || action.auto_addable !== false));
  let nextAlternatives = [];
  let nextOffer = actionOffer || (nextRecommended.length ? "active_kit" : "none");

  // 1) Battery choice is unresolved until capacity and, for 2600mAh, sleeve variant are known.
  if (kitAiQuestionRequestsGeneric2600BatteryChoice(q)) {
    const { withSleeve, withoutSleeve } = kitAiFind2600BatteryVariants(liveProducts);
    const rows = [
      withSleeve ? `1. ${kitAiProductLabel(withSleeve)} — easier lamp assembly; no separate battery holder is normally needed in this kit path.` : "",
      withoutSleeve ? `2. ${kitAiProductLabel(withoutSleeve)} — choose this when your design uses a separate 18650 holder; the holder becomes required.` : ""
    ].filter(Boolean);

    nextAnswer = [
      "For a 2600mAh battery, there are two valid Smart Handicrafts options:",
      "",
      rows.join("\n") || "I found the 2600mAh battery family, but the two live variant labels could not be resolved cleanly.",
      "",
      "Please choose with sleeve or without sleeve. I will add the exact one after you choose."
    ].join("\n");

    return {
      answer: nextAnswer,
      recommendedProducts: [],
      activeKitActions: [],
      alternativeProducts: [],
      actionOffer: "none"
    };
  }

  if (kitAiQuestionAsksWhichBattery(q)) {
    const activeText = kitAiActiveText(kitContext);
    const higherPowerContext =
      /\b205\b|\b206[-\s]?115\b|\bstrip\b|\bdob\b/i.test(activeText) ||
      /\bstrip\b|\bdob\b|\blong\s+(runtime|backup)\b|\bmaximum\s+runtime\b/i.test(qLower);

    if (higherPowerContext) {
      nextAnswer = [
        "The battery choice depends on runtime and the size available in your lamp.",
        "",
        "1. 2600mAh — more compact rechargeable path.",
        "2. 5200mAh — longer backup when the lamp body can fit the larger pack or the application needs more runtime.",
        "",
        "Tell me 2600mAh or 5200mAh. If you choose 2600mAh, I will then ask with sleeve vs without sleeve."
      ].join("\n");
    } else {
      const { withSleeve, withoutSleeve } = kitAiFind2600BatteryVariants(liveProducts);
      const rows = [
        withSleeve ? `1. ${kitAiProductLabel(withSleeve)} — easier lamp assembly; no separate battery holder is normally needed in this kit path.` : "",
        withoutSleeve ? `2. ${kitAiProductLabel(withoutSleeve)} — choose this when your design uses a separate 18650 holder; the holder becomes required.` : ""
      ].filter(Boolean);

      nextAnswer = [
        "For this compact rechargeable lamp path, the normal battery direction is 2600mAh. There are two valid Smart Handicrafts options:",
        "",
        rows.join("\n") || "I found the 2600mAh battery family, but the two live variant labels could not be resolved cleanly.",
        "",
        "Please choose with sleeve or without sleeve. I will add the exact one after you choose."
      ].join("\n");
    }

    return {
      answer: nextAnswer,
      recommendedProducts: [],
      activeKitActions: [],
      alternativeProducts: [],
      actionOffer: "none"
    };
  }

  // 2) The canonical "rechargeable touch table lamp, 3W warm white" path:
  //    select the clear driver + LED steps, then stop and ask for the unresolved battery variant.
  if (kitAiQuestionLooksLikeRechargeableSingle3wWarmLamp(q)) {
    const driver201 = kitAiFind201Driver(liveProducts);
    const led3w = kitAiFind3wSingleLed(liveProducts);
    const rawActions = [];

    if (driver201) {
      rawActions.push({
        action: "add",
        name: driver201.name || "",
        sku: driver201.sku || (Array.isArray(driver201.variantSkus) ? driver201.variantSkus[0] : "") || "",
        qty: 1,
        type: "driver",
        reason: "Rechargeable single-colour touch table lamp request fits the 201 driver."
      });
    }

    if (led3w) {
      rawActions.push({
        action: "add",
        name: led3w.name || "",
        sku: led3w.sku || (Array.isArray(led3w.variantSkus) ? led3w.variantSkus[0] : "") || "",
        qty: 1,
        type: "led",
        reason: "The user explicitly requested around 3W warm-white output."
      });
    }

    nextActions = normalizeKitAiActiveKitActions(rawActions, liveProducts, kitContext);
    nextAnswer = [
      "That request is clear. I’m setting the kit up step-wise for a rechargeable single-colour touch lamp:",
      driver201 ? `• Driver: ${kitAiProductLabel(driver201)}` : "• Driver: 201 rechargeable single-colour driver path",
      led3w ? `• LED: ${kitAiProductLabel(led3w)}` : "• LED: 3W single warm-white COB path",
      "",
      "The next decision is the battery variant. Choose one:",
      "1. 2600mAh with sleeve — simpler assembly, no separate holder in the normal kit path.",
      "2. 2600mAh without sleeve — use this when your lamp design uses a separate battery holder."
    ].join("\n");

    return {
      answer: nextAnswer,
      recommendedProducts: [],
      activeKitActions: nextActions,
      alternativeProducts: [],
      actionOffer: "none"
    };
  }

  // 3) If the driver is known but LED brightness is not, ask before selecting 3W/5W.
  if (kitAiQuestionNeedsLedChoice(q, kitContext)) {
    nextAnswer = [
      "The driver path is selected. Before I add an LED, please choose the brightness level:",
      "",
      "1. **Standard / compact output** — usually the 3W COB path.",
      "2. **Brighter output** — usually the 5W COB path, subject to the selected driver/load.",
      "",
      "Tell me 3W or 5W, and I’ll move the kit to the next step."
    ].join("\n");

    return {
      answer: nextAnswer,
      recommendedProducts: [],
      activeKitActions: [],
      alternativeProducts: [],
      actionOffer: "none"
    };
  }

  // 4) If LED is selected but battery is not, do not silently decide capacity.
  if (kitAiQuestionNeedsBatteryChoice(q, kitContext)) {
    nextAnswer = [
      "The LED side is now defined. Before I add a battery, please choose the backup direction:",
      "",
      "• 2600mAh — the normal compact rechargeable lamp path.",
      "• 5200mAh — use only when you want longer runtime or the lamp design can accommodate the larger pack.",
      "",
      "If you choose 2600mAh, I’ll then ask whether you want with sleeve or without sleeve."
    ].join("\n");

    return {
      answer: nextAnswer,
      recommendedProducts: [],
      activeKitActions: [],
      alternativeProducts: [],
      actionOffer: "none"
    };
  }

  // 5) General post-filtering: if unsafe defaults were removed, do not leave an invalid "add all" offer.
  if (!nextRecommended.length && nextOffer === "active_kit") {
    nextOffer = "none";
  }

  return {
    answer: nextAnswer,
    recommendedProducts: nextRecommended,
    activeKitActions: nextActions,
    alternativeProducts: nextAlternatives,
    actionOffer: nextOffer
  };
}


function isKitAiIntegrationConceptQuestion(question = "", pageContext = {}, kitContext = {}) {
  const q = [
    question || "",
    pageContext?.pageTitle || "",
    pageContext?.h1 || "",
    kitContext?.kitBuilderSnapshot?.selectedApplication || ""
  ].filter(Boolean).join(" ").toLowerCase();

  const hasLampOrObjectIntent =
    /\b(lamp|light|lighting|illuminat|glow|backlit|inside|interior|embedded|implement|integrat|fit|place|placement|mount|install|hide|route|wire|wiring|charging port|touch sensor)\b/i.test(q);

  const hasCreativeOrPhysicalForm =
    /\b(make|build|create|design|develop|gift|christmas|decorative|custom|prototype|concept|notebook|book|box|bottle|jar|frame|photo frame|statue|idol|wooden|ceramic|stone|metal|acrylic|wall art|panel|thin|slim|flat|inside it)\b/i.test(q);

  const explicitPlacementQuestion =
    /\b(where|how)\b.{0,40}\b(place|put|fit|mount|integrate|install|hide|route|position)\b/i.test(q) ||
    /\b(led|battery|driver|pcb|charging port|usb|touch sensor|wire|jst)\b.{0,40}\b(where|placement|position|inside|fit)\b/i.test(q);

  return explicitPlacementQuestion || (hasLampOrObjectIntent && hasCreativeOrPhysicalForm);
}

function getKitAiIntegrationProductBucket(product = {}) {
  const text = getProductSearchText(product);
  if (!text) return "other";

  if (/\b(strip|lsd|linear|cob strip|flexible)\b/i.test(text)) return "strip";
  if (/\b(driver|sld|dld|dob|module)\b/i.test(text)) return "driver";
  if (/\b(battery|18650|mah|cell)\b/i.test(text)) return "battery";
  if (/\b(jst|wire|cable|connector|harness)\b/i.test(text)) return "wire";
  if (/\b(touch sensor|sensor|touch)\b/i.test(text)) return "sensor";
  if (/\b(cob|led|filament|flame)\b/i.test(text)) return "led";
  if (/\b(holder|enclosure|panel mount|mount)\b/i.test(text)) return "accessory";
  return "other";
}

function matchActiveSelectedDriverProduct(liveProducts = [], kitContext = {}) {
  const selectedDriver = String(kitContext?.kitBuilderSnapshot?.selectedDriver || "").toLowerCase();
  if (!selectedDriver) return null;

  return (liveProducts || []).find((product) => {
    const haystack = getProductSearchText(product);
    if (!haystack) return false;

    const sku = String(product?.sku || "").toLowerCase();
    if (sku && selectedDriver.includes(sku)) return true;

    const variantSkus = Array.isArray(product?.variantSkus) ? product.variantSkus : [];
    if (variantSkus.some((v) => v && selectedDriver.includes(String(v).toLowerCase()))) return true;

    const name = String(product?.name || "").toLowerCase();
    if (name && selectedDriver.includes(name)) return true;

    const selectedNums = Array.from(selectedDriver.matchAll(/\b\d{2,4}\b/g)).map((m) => m[0]);
    return selectedNums.some((num) => new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(haystack));
  }) || null;
}

function buildBalancedIntegrationProductPromptSet(liveProducts = [], scored = [], { question, pageContext, kitContext } = {}) {
  const searchText = buildKitAiSearchText({ question, pageContext, kitContext });
  const sortedRows = Array.isArray(scored) && scored.length
    ? scored
    : (liveProducts || [])
        .map((product) => ({ product, score: scoreLiveProductForKitAi(product, searchText) }))
        .sort((a, b) => b.score - a.score);

  const output = [];
  const seen = new Set();

  function addProduct(product) {
    if (!product) return false;
    const key = [
      String(product.sku || "").trim().toLowerCase(),
      String(product.name || "").trim().toLowerCase()
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    output.push(product);
    return true;
  }

  // Preserve the active selected driver when one exists.
  addProduct(matchActiveSelectedDriverProduct(liveProducts, kitContext));

  const bucketLimits = {
    driver: 3,
    led: 3,
    strip: 2,
    battery: 2,
    wire: 2,
    sensor: 1,
    accessory: 1,
    other: 1
  };

  const bucketCounts = {};

  for (const row of sortedRows) {
    if (output.length >= KIT_AI_MAX_INTEGRATION_PROMPT_PRODUCTS) break;

    const product = row?.product;
    const bucket = getKitAiIntegrationProductBucket(product);
    const limit = bucketLimits[bucket] ?? 1;
    const count = bucketCounts[bucket] || 0;

    if (count >= limit) continue;

    if (addProduct(product)) {
      bucketCounts[bucket] = count + 1;
    }
  }

  // If scoring was too narrow, fill missing key buckets from the live catalogue.
  const mustHaveBuckets = ["driver", "led", "strip", "battery", "wire"];
  for (const wantedBucket of mustHaveBuckets) {
    if (output.length >= KIT_AI_MAX_INTEGRATION_PROMPT_PRODUCTS) break;
    if ((bucketCounts[wantedBucket] || 0) > 0) continue;

    const fallbackProduct = (liveProducts || []).find(
      (product) => getKitAiIntegrationProductBucket(product) === wantedBucket
    );

    if (addProduct(fallbackProduct)) {
      bucketCounts[wantedBucket] = 1;
    }
  }

  return output.slice(0, KIT_AI_MAX_INTEGRATION_PROMPT_PRODUCTS);
}

function selectRelevantLiveProductsForKitAi(liveProducts = [], { question, pageContext, kitContext } = {}) {
  const searchText = buildKitAiSearchText({ question, pageContext, kitContext });

  const scored = (liveProducts || [])
    .map((product) => ({
      product,
      score: scoreLiveProductForKitAi(product, searchText)
    }))
    .sort((a, b) => b.score - a.score);

  if (
    isKitAiIntegrationConceptQuestion(question, pageContext, kitContext) ||
    isKitAiStarterOrCompletionQuestion(question) ||
    isKitAiExplicitDirectAddQuestion(question)
  ) {
    const balanced = buildBalancedIntegrationProductPromptSet(liveProducts, scored, {
      question,
      pageContext,
      kitContext
    });

    const starterLiveProducts = findDefault201StarterKitLiveProducts(liveProducts, kitContext, question);
    const completion202LiveProducts = findDefault202CompletionLiveProducts(liveProducts, kitContext, question);
    const merged = [];
    const seen = new Set();

    for (const product of [...starterLiveProducts, ...completion202LiveProducts, ...balanced]) {
      if (!product) continue;
      const key = `${String(product.sku || "").toLowerCase()}|${String(product.name || "").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(product);
    }

    return merged.slice(0, KIT_AI_MAX_INTEGRATION_PROMPT_PRODUCTS);
  }

  const relevant = scored
    .filter((row) => row.score > 0)
    .slice(0, KIT_AI_MAX_PROMPT_PRODUCTS)
    .map((row) => row.product);

  if (relevant.length >= 6) return relevant;

  const fallback = scored
    .slice(0, KIT_AI_MAX_PROMPT_PRODUCTS)
    .map((row) => row.product);

  return fallback;
}

function compactKitAiPageContext(pageContext = {}) {
  return {
    pageTitle: pageContext.pageTitle || "",
    pageUrl: pageContext.pageUrl || "",
    h1: pageContext.h1 || "",
    metaDescription: String(pageContext.metaDescription || "").slice(0, 180),
    selectedVisibleItems: Array.isArray(pageContext.selectedVisibleItems)
      ? pageContext.selectedVisibleItems.slice(0, 6)
      : []
  };
}

function compactKitAiContext(kitContext = {}, question = "") {
  const snapshot = kitContext.kitBuilderSnapshot || {};
  const q = String(question || "").toLowerCase();
  const includeSavedKits = /\bsaved\b|\bprevious kit\b|\bmy kits\b|\bkit list\b/i.test(q);

  return {
    selectedApplication: snapshot.selectedApplication || "",
    selectedApplicationId: snapshot.selectedApplicationId || "",
    selectedDriver: snapshot.selectedDriver || "",
    selectedDriverId: snapshot.selectedDriverId || "",
    currentStep: String(snapshot.currentStep || "1"),
    currentStepLabel: snapshot.currentStepLabel || "",
    currentPartsTab: snapshot.currentPartsTab || "led",
    selectedDriverSupportedProductIds: Array.isArray(snapshot.selectedDriverSupportedProductIds)
      ? snapshot.selectedDriverSupportedProductIds.slice(0, 30)
      : [],
    selectedDriverRecommendedProductIds: Array.isArray(snapshot.selectedDriverRecommendedProductIds)
      ? snapshot.selectedDriverRecommendedProductIds.slice(0, 20)
      : [],
    activeKitItems: Array.isArray(snapshot.activeKitItems) ? snapshot.activeKitItems.slice(0, 12) : [],
    selectedItemIds: Array.isArray(snapshot.selectedItemIds) ? snapshot.selectedItemIds.slice(0, 30) : [],
    coreComplete: !!snapshot.coreComplete,
    missingCoreParts: Array.isArray(snapshot.missingCoreParts) ? snapshot.missingCoreParts.slice(0, 8) : [],
    ...(includeSavedKits && Array.isArray(snapshot.savedKits)
      ? { savedKits: snapshot.savedKits.slice(0, 4) }
      : {}),
    currentLoad: snapshot.currentLoad || "",
    currentRuntime: snapshot.currentRuntime || "",
    currentPrice: snapshot.currentPrice || "",
    reviewStatus: snapshot.reviewStatus || "",
    warning: snapshot.warning || "",
    completionMessage: snapshot.completionMessage || "",
    coreStatus: snapshot.coreStatus || {},
    selectedItemsFromPage: Array.isArray(kitContext.selectedItemsFromPage)
      ? kitContext.selectedItemsFromPage.slice(0, 8)
      : []
  };
}

function compactChatHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history.slice(-4).map((item) => ({
    role: item.role || item.agent || "user",
    text: String(item.text || item.content || "").replace(/\s+/g, " ").slice(0, 420)
  }));
}





// ===================== KIT AI SSE STREAM HELPERS =====================
// Streams only the customer-facing "answer" text while Gemini is still
// generating the structured JSON response. The final event always contains
// the fully parsed/validated final payload used by the existing frontend.
function setupKitAiSse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

function sendKitAiSse(res, eventName, payload) {
  if (!res || res.writableEnded) return;
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
}

function getGeminiChunkText(chunk) {
  return typeof chunk?.text === "string" ? chunk.text : "";
}

function sleepKitAi(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableKitAiGeminiError(error) {
  const text = String(
    error?.message ||
    error?.cause ||
    error ||
    ""
  ).toLowerCase();

  return (
    text.includes("503") ||
    text.includes("502") ||
    text.includes("504") ||
    text.includes("service unavailable") ||
    text.includes("unavailable") ||
    text.includes("exception parsing response") ||
    text.includes("overloaded") ||
    text.includes("temporarily") ||
    text.includes("deadline exceeded") ||
    text.includes("internal")
  );
}

async function generateKitAiNonStreamingWithRetry({
  prompt,
  contents = null,
  approvedRulesCount,
  approvedRulesCached,
  maxAttempts = 2,
  res = null
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1 && res) {
        sendKitAiSse(res, "status", {
          message: "Gemini is busy. Retrying the final answer..."
        });
      }

      const result = await genAI.models.generateContent({
        model: KIT_AI_MODEL,
        approved_rules_count: approvedRulesCount,
        approved_rules_cached: approvedRulesCached,
        contents: contents || prompt,
        config: buildKitAiGeminiConfig()
      });

      return result;
    } catch (error) {
      lastError = error;

      const canRetry =
        attempt < maxAttempts &&
        isRetryableKitAiGeminiError(error);

      if (!canRetry) throw error;

      await sleepKitAi(650 * attempt);
    }
  }

  throw lastError || new Error("Gemini non-streaming generation failed.");
}

function extractPartialKitAiJsonStringField(rawText = "", fieldName = "answer") {
  const raw = String(rawText || "");
  const fieldPattern = new RegExp(`"${fieldName}"\\s*:\\s*"`, "i");
  const match = fieldPattern.exec(raw);
  if (!match) return { value: "", complete: false };

  let i = match.index + match[0].length;
  let value = "";
  let escaping = false;

  while (i < raw.length) {
    const ch = raw[i];

    if (escaping) {
      if (ch === "n") value += "\n";
      else if (ch === "r") value += "\r";
      else if (ch === "t") value += "\t";
      else if (ch === "b") value += "\b";
      else if (ch === "f") value += "\f";
      else if (ch === '"') value += '"';
      else if (ch === "\\") value += "\\";
      else if (ch === "/") value += "/";
      else if (ch === "u") {
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9a-f]{4}$/i.test(hex)) {
          value += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          return { value, complete: false };
        }
      } else {
        value += ch;
      }
      escaping = false;
      i += 1;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      return { value, complete: true };
    }

    value += ch;
    i += 1;
  }

  return { value, complete: false };
}

function parseBackendAutoTrainCommand(text = "") {
  const raw = String(text || "").trim();
  if (!raw.toLowerCase().startsWith("/train")) return null;

  const rest = raw.replace(/^\/train\s*/i, "").trim();
  const parts = rest.split("|").map((x) => x.trim()).filter(Boolean);

  return {
    ruleText: parts[0] || rest,
    relatedSku: parts[1] || "",
    category: parts[2] || "general"
  };
}

app.post("/kit-ai-chat", async (req, res) => {
  try {
    const {
      question,
      pageContext,
      kitContext,
      history,
      lampReferenceImage,
      lampReferenceSummary
    } = req.body || {};
    const wantsStream = String(req.headers.accept || "").toLowerCase().includes("text/event-stream") || req.body?.stream === true;
    const normalizedLampReferenceImage = normalizeKitAiLampReferenceImage(lampReferenceImage);
    const priorLampReferenceSummary = sanitizeKitAiLampReferenceSummary(lampReferenceSummary || "");
    const safeQuestion =
      String(question || "").trim() ||
      (normalizedLampReferenceImage ? defaultKitAiImageQuestion() : "");

    if (!safeQuestion) {
      return res.status(400).json({
        ok: false,
        error: "Question is required"
      });
    }

    if (!genAI) {
      return res.status(500).json({
        ok: false,
        error: "Gemini is not configured. Add GEMINI_API_KEY in Render."
      });
    }

    // Auto-approved training command.
    // Only people who know /train can use this; approved rules are saved directly in Odoo.
    const autoTrainCommand = parseBackendAutoTrainCommand(safeQuestion);
    if (autoTrainCommand) {
      if (!autoTrainCommand.ruleText) {
        return res.json({
          ok: true,
          answer: "Write the rule after /train and I’ll save it as an approved Smart Handicrafts rule.",
          status: "approved"
        });
      }

      const result = await createOdooAiTrainingRule({
        ruleText: autoTrainCommand.ruleText,
        status: "approved",
        source: "admin",
        category: autoTrainCommand.category || "compatibility",
        relatedSku: autoTrainCommand.relatedSku || "",
        pageUrl: pageContext?.pageUrl || "",
        userMessage: safeQuestion,
        approvedBy: "chat-train",
        approvedDate: new Date().toISOString().slice(0, 19).replace("T", " "),
        active: true
      });

      return res.json({
        ok: true,
        answer: "Approved rule saved. I’ll use this rule in future kit suggestions after the rules cache refreshes.",
        training_rule_id: result.id,
        status: "approved"
      });
    }

    // Fast path: Odoo products are cached after the first fetch.
    const liveProductResult = await getLiveOdooWebsiteProducts();
    const liveProducts = liveProductResult.products || [];

    const approvedRulesResult = await getApprovedOdooAiTrainingRules();
    const approvedRules = approvedRulesResult.rules || [];
    const relevantApprovedRules = selectRelevantApprovedRulesForKitAi(approvedRules, {
      question: safeQuestion,
      pageContext,
      kitContext
    });
    const approvedRulesPrompt = formatApprovedRulesForPrompt(relevantApprovedRules);

    if (!liveProductResult.ok || !liveProducts.length) {
      return res.json({
        ok: true,
        answer:
          "I cannot safely recommend products right now because I could not access the live Smart Handicrafts website product list from Odoo. Please try again shortly or contact Smart Handicrafts for confirmation.",
        live_products_available: false,
        odoo_error: liveProductResult.error || null
      });
    }

    const decisionPolicy = buildKitAiDecisionPolicy({
      question: safeQuestion,
      history: history || [],
      kitContext: kitContext || {},
      liveProducts
    });

    const integrationConsultingMode =
      isKitAiIntegrationConceptQuestion(safeQuestion, pageContext, kitContext) ||
      !!decisionPolicy?.active?.integrationMode ||
      !!normalizedLampReferenceImage ||
      !!priorLampReferenceSummary;

    // Speed optimization: send only relevant live products to Gemini, not the full website catalogue.
    // For creative lamp/integration questions, send a balanced compact set across drivers, LEDs/strips,
    // batteries and wiring so Gemini does not falsely assume only one unrelated product is available.
    const relevantLiveProducts = selectRelevantLiveProductsForKitAi(liveProducts, {
      question: safeQuestion,
      pageContext,
      kitContext
    });

    const liveProductsForPrompt = buildLiveProductsForPrompt(relevantLiveProducts);
    const compactPage = compactKitAiPageContext(pageContext || {});
    const compactKit = compactKitAiContext(kitContext || {}, safeQuestion);
    const compactHistory = compactChatHistory(history || []);

    const relevantIntegrationKnowledgeChunks = await retrieveRelevantKitIntegrationChunks({
      question: safeQuestion,
      pageContext,
      kitContext,
      history: history || [],
      decisionPolicy,
      integrationConsultingMode,
      topK: 4
    });
    const integrationKnowledgePrompt = formatKitIntegrationChunksForPrompt(relevantIntegrationKnowledgeChunks);
    const decisionPolicyPrompt = formatKitAiDecisionPolicyForPrompt(decisionPolicy);

    const deterministic201StarterLiveProducts =
      isKitAiStarterOrCompletionQuestion(safeQuestion)
        ? findDefault201StarterKitLiveProducts(liveProducts, kitContext || {}, safeQuestion)
        : [];

    const deterministic202CompletionLiveProducts =
      isKitAiStarterOrCompletionQuestion(safeQuestion) || isKitAiSelected202Context(kitContext || {}, safeQuestion)
        ? findDefault202CompletionLiveProducts(liveProducts, kitContext || {}, safeQuestion)
        : [];

    const deterministicDirectAddActions =
      findDirectAddLiveActionsFromQuestion(safeQuestion, liveProducts, kitContext || {});

    const deterministicExactSelectionActions =
      findExactLiveSelectionActionsFromQuestion(
        safeQuestion,
        liveProducts,
        kitContext || {},
        history || []
      );

    const lampReferencePromptContext = {
      imageAttachedThisTurn: !!normalizedLampReferenceImage,
      priorReferenceImageSummary: priorLampReferenceSummary || ""
    };

    const prompt = `
You are Smart Handicrafts® Kit Expert.

You are not a generic chatbot. You are a technical product assistant and sales engineer for Smart Handicrafts®, a B2B brand providing plug-and-play electronics modules for lamps, handicrafts, fountains, diffusers, and export-ready lighting products.

Your job is to help artisans, exporters, manufacturers, lighting brands, and OEM buyers build correct kits using live Smart Handicrafts website products only.

You are also a practical lamp integration consultant. When the user describes a lamp concept, object, gift idea, enclosure, or asks how to place electronics inside a design, help them translate that idea into a practical lighting layout before jumping to products.

REFERENCE IMAGE SUPPORT:
- A customer may attach a reference lamp image. When an image is attached, analyze only the visible structure: apparent lamp form, base/head/body shape, likely visible light zones, contour/edge opportunities, and possible external port/touch-point locations.
- Do not claim hidden cavity size, internal depth, material thickness, battery space, or exact dimensions as facts from an image. Ask for text details if those are needed.
- Use the image to guide the integration direction, such as COB vs strip vs DOB, likely driver/module placement zones, touch-point ideas, and charging/USB-C access suggestions.
- If the image shows a creative object or unusual lamp form, provide a practical design direction instead of rejecting the concept.
- When an image is attached, return a concise image_summary in the JSON response. This summary will be reused for future text-only follow-up messages so the same image does not need to be resent.
- If a priorReferenceImageSummary is present but no new image is attached, use that summary as the visual reference for the current answer.

Always respond in this order:
1. Acknowledge the user’s requirement.
2. If this is a lamp concept or integration question, briefly explain the likely lighting layout and how the electronics could sit inside the object.
3. Check and mention the current active kit/selected driver if available and relevant.
4. Explain whether the active kit is suitable.
5. Identify missing core parts.
6. Suggest only missing/addable live products when enough information exists.
7. Ask for missing technical details only if needed.

CRITICAL PRODUCT RULES:
- You may ONLY recommend products from the LIVE ODOO WEBSITE PRODUCTS list below.
- Do NOT invent SKU names.
- Do NOT invent product names.
- Do NOT suggest any product that is not present in LIVE ODOO WEBSITE PRODUCTS.
- If the user asks for a specific product and that exact product is not available in the live list, say: "This exact product is not currently listed live on the website."
- If there is no suitable live product for a final recommendation, do not force a recommendation. For lamp-concept or integration questions, still provide practical design/placement guidance and explain what must be verified.
- Mention SKU only when the SKU exists in LIVE ODOO WEBSITE PRODUCTS.
- Do not create variants such as "-12V", "-20W", "Pro", "Plus", "Max", etc. unless that exact SKU/name is in the live list.

INTEGRATION CONSULTING RULES:
- For creative lamp concepts such as notebook lamps, gift lamps, wooden lamps, ceramic lamps, stone lamps, bottle lamps, backlit panels, decorative objects, or custom housings, first give a practical implementation direction instead of immediately saying the project cannot be built.
- Help the user think about internal placement of the light source, driver PCB, battery, USB-C charging port, touch sensor, and wire routing.
- Explain likely placement in simple practical terms:
  - LED/light source: where it should sit to create focused light, edge glow, or even diffused glow.
  - Battery: preferably in a thicker/base/back/spine cavity where it is protected and serviceable.
  - Driver PCB: near the battery/charging side with access for wiring and future service.
  - Charging port: on a clean rear, lower-side, base, or spine edge where it is easy to plug in.
  - Touch sensor: on an intuitive outer touch area, only if the lamp material and thickness allow reliable touch sensing.
  - JST wires: route through protected channels, avoid sharp bends, pinch points, and visible wire shadows behind translucent surfaces.
- Mention diffusion and heat naturally when relevant. Thin, sealed, or decorative enclosures may need softer distributed light and thermal caution; do not force high-power LEDs into tight cavities.
- General mechanical placement guidance may be provided even if the exact final product choice still needs dimensions or material confirmation.
- If live products shown to you are not enough to finalise an exact electronics kit, do not tell the user the creative project is impossible. Give the likely design direction, state what must be verified, and ask for the specific missing detail.
- Ask for only the most useful missing inputs, usually 1 to 3 of: approximate dimensions, material, desired light effect, expected runtime, portability, or a sketch/photo.
- If the user asks "how should I place it" or "how to integrate it", prioritise placement/integration guidance over selling a product.
- If the user asks for a complete product recommendation and enough detail exists, combine the integration guidance with a final Smart Handicrafts kit recommendation.

Answer style:
- Talk naturally like a helpful expert assistant, not like a form, script, FAQ, or product catalogue.
- Read the user's exact message first and respond to that specific message.
- Vary your wording. Do not repeat the same opening, same driver sentence, or same "missing parts" sentence.
- Match the user's tone. If the user is casual, be casual but professional. If the user is technical, be technical.
- For greetings, reply like a person: short greeting plus one helpful question. Do not explain the active kit.
- For unclear messages, ask one useful clarification or make a sensible assumption from active kit context.
- For direct requests like "make a lamp", "complete kit", "you tell", or "choose", make a real recommendation, not a generic explanation.
- For conceptual design questions, answer like a Smart Handicrafts technical consultant: explain the likely lighting approach and physical integration before the product decision.
- Never reply to a creative lamp concept with only "not possible" or "no compatible live products" unless the user explicitly requires a purchase-ready exact kit and the live list truly cannot support it.
- Think before replying:
  1. What is the user actually asking right now?
  2. What is already selected in the active kit?
  3. Should I keep the selected parts or change them?
  4. What complete set would I personally choose for this use case?
  5. What should happen next?
- If a suitable driver is already selected, do not make the whole answer about the driver. Mention it briefly only if useful.
- Do not say "your active kit is currently incomplete" unless it is necessary. Say it naturally, like "we just need to add the LED, battery and wire now."
- Do not say "consider adding the following", "we recommend adding the following", or "to complete your kit" repeatedly.
- Use plain text only. No Markdown, no **bold**, no bullets, no tables, no code formatting.
- Use short paragraphs, like a real ChatGPT-style reply.
- Usually keep the customer-facing answer under 120 words unless the user explicitly asks for a detailed comparison, technical breakdown, or integration/placement guidance that genuinely needs a little more explanation.
- If products are selected by you, name only the currently resolved step items naturally in the answer. Do not imply the whole kit is final when later choices remain.
- Do not show speculative alternatives unless the user asks for options or the next step genuinely requires a choice.
- Do not recommend duplicates already in the active kit.
- Do not invent products. Recommend only live products from the provided live product list.
- If user mentions a product number like 205, 204, 103, 201, or 202, match it against live product names and live SKUs before saying it is not listed.
- Do not say a product is not live if any live product name or SKU contains that number.
- Smart Handicrafts approved rule: DRIVER-204 is the normal-charging rechargeable strip LED driver. DRIVER-205 / AS-U-205-LSD is treated as the fast-charging rechargeable strip LED driver. Do not infer USB-only behavior from the AS-U prefix for 205.
- If user says "there is 205", acknowledge the live matching 205 product and apply the approved fast-charging rechargeable strip-driver rule.
- For a normal rechargeable single-colour table lamp with AS-B-201-SLD selected, 3W COB is a good LED path only when the user has stated 3W/standard brightness. Do not silently decide battery capacity or sleeve variant.
- Use 5W only if the user explicitly asks for 5W, higher brightness, or a brighter output path and the selected driver/load is appropriate.
- If the user says "why", explain the practical reason in human language: heat, runtime, brightness, safety, assembly simplicity.
- If the user explicitly asks to ADD, REMOVE, DELETE, SWITCH, CHANGE, or REPLACE an exact item in the active kit in the current message, use active_kit_actions so the frontend can actually update the active kit.
- If the user says "add 3W LED", "add JST wire", "add 2600mAh with sleeve", or names another exact unambiguous part to add, do not merely offer to add it later. Return the matching live product in active_kit_actions immediately.
- If the user says only "add battery" or only "2600mAh", do not choose a variant. Ask for the exact battery direction/variant first.
- For a starter-kit or complete-kit question, follow the wizard order. Resolve only the next clear step; ask before deciding LED brightness or battery capacity/variant.
- For a completion question where DRIVER-202 is selected, respect the dual-LED path and correct JST quantity rules, but do not jump to a battery or 5W LED without user confirmation.
- Battery decision rule: 2600mAh is normally the compact rechargeable lamp path, but the AI must still ask whether the user wants With Sleeve or Without Sleeve unless the variant is explicitly stated. Do not recommend 5200mAh unless the user explicitly asks for longer runtime, greater backup, or a higher-power use case that requires it.
- For bulk/custom requirements, suggest Smart Handicrafts verification.
- Final lamp compliance depends on full lamp design/testing.
- Do not say "as an AI language model".
- Do not expose internal logic.

Return format:
Return ONLY one valid JSON object. No markdown, no explanation outside JSON.
Do not repeat, quote, or paraphrase any instruction from this prompt.
Do not output multiple JSON objects.
{
  "answer": "natural customer-facing answer in plain text",
  "image_summary": "If a reference lamp image is attached, give a concise factual visual summary useful for follow-up integration guidance. Otherwise return an empty string.",
  "recommended_products": [
    {
      "name": "exact live product name",
      "sku": "exact live SKU if available",
      "qty": 1,
      "type": "driver | led | battery | wire | connector | holder | sensor | accessory",
      "reason": "short internal reason"
    }
  ],
  "active_kit_actions": [
    {
      "action": "add | remove",
      "name": "for add: exact live product name; for remove: active-kit item name if known",
      "sku": "for add: exact live SKU if available; for remove: matching SKU if visible in active kit",
      "qty": 1,
      "type": "driver | led | battery | wire | connector | holder | sensor | accessory",
      "reason": "short reason"
    }
  ],
  "action_offer": "active_kit | cart | none"
}
Rules for recommended_products:
- Only include recommended_products when you have made a final decision and the user can say "add it".
- If the user is only greeting, asking a general question, or asking about something already selected, use an empty recommended_products array.
- Do NOT complete the whole kit at once by default. Work step-wise in the same order as the Kit Builder: application → driver → LED → battery → wire/accessories → review.
- If a user states an exact unambiguous choice, you may use active_kit_actions for that step and then ask only the next unresolved decision.
- If LED brightness/wattage is not explicitly known, ask before choosing 3W vs 5W.
- If battery capacity or battery variant is not explicitly known, ask before choosing it.
- If the user says only "2600mAh", present both 2600mAh variants and ask them to choose with sleeve vs without sleeve. Do not auto-select one.
- Do not include products already selected in the active kit.
- Do not include a driver if a suitable driver is already selected.
- Do not include speculative alternatives as addable recommendations. If the next step has multiple valid choices, explain them in the answer and ask the user to choose.
- If recommended_products is not empty, the answer should naturally ask whether to add all of them to the active kit or cart.
- The frontend will not show product cards, so the answer itself must be understandable.

Rules for active_kit_actions:
- Use active_kit_actions ONLY when the user explicitly asks to change the active kit now, such as "add this battery", "remove the current battery", "delete the JST wire", "switch to 202", "replace 201 with 202", or "add the 3W LED".
- For "add" actions, include only exact products available in LIVE ODOO WEBSITE PRODUCTS. Do not invent SKUs or names.
- For "remove" actions, target an item that appears to be in kit.selectedDriver or kit.activeKitItems. Use the most recognizable item name/SKU from the active kit context.
- If the user asks to switch drivers, use an "add" action for the new live driver; the frontend will select that driver and the kit builder should replace the prior active driver.
- If the user asks to replace a non-driver item, you may include one "remove" action for the old item and one "add" action for the new exact live product.
- Do not use active_kit_actions for a general recommendation or when you are only asking "Should I add these?".
- Whenever you ask "Should I add..." or otherwise offer to add recommended items, use exact live product names and SKUs in the answer and populate recommended_products. Do not mention only generic phrases such as "a 2600mAh battery" without identifying the exact live product.
- When active_kit_actions are present, say that you are updating or switching the active kit now. Do not claim that the change has already finished successfully; the frontend will report the actual success/failure after execution.

Rules for image_summary:
- If a new reference image is attached this turn, create a compact plain-text summary focused on visible structure relevant to lamp integration.
- Include only visible or cautiously worded observations, for example: "appears to have a wide base", "looks like an elevated shade", "edge-lighting may be possible around the perimeter".
- Do not state hidden cavity space, exact dimensions, unseen internals, or material certainty unless the user also stated them in text.
- If there is no new image attached, return an empty image_summary string.

APPROVED SMART HANDICRAFTS TRAINING RULES:
${approvedRulesPrompt}

These approved rules override general assumptions. Use them whenever relevant, especially for compatibility decisions.

DETERMINISTIC SMART HANDICRAFTS DECISION POLICY:
${decisionPolicyPrompt}

How to use the deterministic policy:
- This is a server-side high-confidence decision layer, not a casual suggestion.
- If an active policy is present, do not contradict it.
- The active policy exists to stop drift from prior conversation context or from an already-selected but no-longer-optimal active kit.
- If the policy says a better product family should be surfaced, explain that clearly before continuing the old kit path.

RELEVANT SMART HANDICRAFTS PHYSICAL INTEGRATION KNOWLEDGE:
${integrationKnowledgePrompt}

How to use the integration knowledge:
- Treat these chunks as official Smart Handicrafts guidance for physical placement, assembly, cavities, battery/USB logic, charging access, touch point planning, holders, rods, diffusers, and integration examples.
- Product recommendations must still come only from LIVE ODOO WEBSITE PRODUCTS.
- For mechanical suggestions beyond fixed product facts, you may reason practically, but do not invent new Smart Handicrafts specifications or unsupported electrical compatibility.

LIVE ODOO WEBSITE PRODUCTS:
${JSON.stringify(liveProductsForPrompt, null, 2)}

Current kit/page context:
${JSON.stringify({
  integrationConsultingMode,
  lampReference: lampReferencePromptContext,
  guidedFlowPolicy: "stepwise application -> driver -> LED -> battery -> wire/accessories -> review",
  decisionPolicy: {
    active: decisionPolicy?.active || null,
    supporting: Array.isArray(decisionPolicy?.supporting)
      ? decisionPolicy.supporting.map((item) => ({
          id: item.id,
          preferredPath: item.preferredPath
        }))
      : [],
    flags: decisionPolicy?.flags || {},
    recentUserIntentText: decisionPolicy?.recentUserIntentText || ""
  },
  deterministicDirectAddCandidates: deterministicDirectAddActions.map((a) => ({
    action: a.action,
    name: a.name,
    sku: a.sku
  })),
  deterministicExactSelectionCandidates: deterministicExactSelectionActions.map((a) => ({
    action: a.action,
    name: a.name,
    sku: a.sku
  })),
  page: compactPage,
  kit: compactKit,
  history: compactHistory
}, null, 2)}

Context interpretation rules:
- The "kit.selectedDriver" field is the active selected driver. Treat it as already selected by the user.
- The "kit.activeKitItems" field contains items already present in the active kit. Do not recommend duplicates.
- The "kit.selectedDriverSupportedProductIds" field is the Kit Builder's internal compatibility list for the selected driver. Treat it as a strong signal for what the builder can actually add for that selected driver.
- The "kit.selectedDriverRecommendedProductIds" field is the Kit Builder's preferred default set for that selected driver. Use it to avoid suggesting live but builder-incompatible parts.
- The "kit.completionMessage" and "kit.coreStatus" indicate missing core parts.
- If the user gives a broad intent such as "need to make a table lamp", answer like a guided kit builder: acknowledge current selection first, then decide only the next clear step. Do not dump a complete kit.
- Respect kit.currentStep and kit.currentPartsTab. The assistant should advance the flow step-wise and never behave as though it cannot see the wizard state.
- If the user gives a creative form-factor concept such as "notebook lamp", "gift lamp", "lighting inside a bottle", or asks about placement/integration, treat it as both an implementation question and a kit-building question.
- For concept/integration questions, do not treat the live product list as the only thing worth saying. Use it to control product recommendations, but still give useful placement, light-distribution, heat, and assembly guidance.
- Recommended_products should include only missing/addable products, not products already in the active kit.
- When the user asks you to choose, recommended_products should contain only your final selected items, not multiple alternatives in the same category.
- Do not include an add card for the driver if that driver is already selected in kit.selectedDriver.
- If the user explicitly asks to mutate the active kit, use active_kit_actions rather than only explaining what to do.

User question:
${safeQuestion}

Answer using only LIVE ODOO WEBSITE PRODUCTS.
`;

    const kitAiGeminiContents = buildKitAiGeminiContents(prompt, normalizedLampReferenceImage);

    let rawText = "";
    let streamedAnswerText = "";
    let streamedAnswerCompleted = false;

    if (wantsStream) {
      setupKitAiSse(res);
      sendKitAiSse(res, "status", { message: "Kit Expert is preparing the answer..." });

      let streamingError = null;
      const MAX_STREAM_ATTEMPTS = 2;

      for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt += 1) {
        try {
          if (attempt > 1) {
            sendKitAiSse(res, "status", {
              message: "Gemini stream was temporarily unavailable. Retrying..."
            });
            await sleepKitAi(650 * (attempt - 1));
          }

          const stream = await genAI.models.generateContentStream({
            model: KIT_AI_MODEL,
            approved_rules_count: relevantApprovedRules.length,
            approved_rules_cached: !!approvedRulesResult.cached,
            contents: kitAiGeminiContents,
            config: buildKitAiGeminiConfig()
          });

          for await (const chunk of stream) {
            const chunkText = getGeminiChunkText(chunk);
            if (!chunkText) continue;

            rawText += chunkText;

            // Gemini is still producing JSON. Extract only the progressively-growing
            // customer-facing answer field so the chat does not display raw JSON.
            const partialAnswerState = extractPartialKitAiJsonStringField(rawText, "answer");
            const partialAnswer = partialAnswerState.value;

            if (partialAnswer.length > streamedAnswerText.length) {
              const delta = partialAnswer.slice(streamedAnswerText.length);
              streamedAnswerText = partialAnswer;
              sendKitAiSse(res, "delta", { text: delta });
            }

            /*
              The visible answer can finish before Gemini finishes the remaining JSON
              fields such as recommended_products/action_offer. Tell the frontend so
              it can show a clear "finalising" state instead of looking stuck.
            */
            if (partialAnswerState.complete && !streamedAnswerCompleted) {
              streamedAnswerCompleted = true;
              sendKitAiSse(res, "answer_complete", {
                message: "Answer written. Finalising the product check..."
              });
            }
          }

          streamingError = null;
          break;
        } catch (error) {
          streamingError = error;

          const canRetryStreaming =
            attempt < MAX_STREAM_ATTEMPTS &&
            isRetryableKitAiGeminiError(error) &&
            !String(streamedAnswerText || "").trim();

          if (!canRetryStreaming) break;
        }
      }

      /*
        Production safety:
        If Gemini streaming fails with 503 / parsing-stream / temporary errors,
        fall back to normal Gemini generation instead of showing an error to the user.
        The visitor may receive the final answer all at once, but the answer still arrives.
      */
      if (streamingError) {
        if (!isRetryableKitAiGeminiError(streamingError)) {
          throw streamingError;
        }

        console.warn("Kit AI streaming failed; falling back to non-streaming Gemini generation:", streamingError);

        sendKitAiSse(res, "status", {
          message: "Live typing is temporarily unavailable. Finishing the answer..."
        });

        const fallbackResult = await generateKitAiNonStreamingWithRetry({
          prompt,
          contents: kitAiGeminiContents,
          approvedRulesCount: relevantApprovedRules.length,
          approvedRulesCached: !!approvedRulesResult.cached,
          maxAttempts: 2,
          res
        });

        rawText = fallbackResult.text?.trim() || "";
      }
    } else {
      const result = await generateKitAiNonStreamingWithRetry({
        prompt,
        contents: kitAiGeminiContents,
        approvedRulesCount: relevantApprovedRules.length,
        approvedRulesCached: !!approvedRulesResult.cached,
        maxAttempts: 2
      });

      rawText = result.text?.trim() || "";
    }

    rawText = rawText.trim() || JSON.stringify({
      answer: "I could not generate an answer right now.",
      recommended_products: []
    });

    const parsedResponse = parseKitAiJsonResponse(rawText);

    /*
      Streaming safety:
      During SSE streaming, Gemini may already provide a complete customer-facing
      "answer" text before the final JSON wrapper is perfectly parseable.
      In that case, never overwrite the visible streamed reply with the generic
      parser fallback. Keep the actual streamed answer as the final answer.
    */
    const parsedAnswerText = String(parsedResponse?.answer || "").trim();
    const parserReturnedGenericFallback =
      !parsedAnswerText ||
      parsedAnswerText === "I could not generate an answer right now.";

    const safeAnswerSource =
      wantsStream && parserReturnedGenericFallback && String(streamedAnswerText || "").trim()
        ? String(streamedAnswerText || "").trim()
        : (parsedResponse.answer || rawText || "I could not generate an answer right now.");

    let answer = improveNaturalKitAnswer(stripMarkdownForCustomer(
      safeAnswerSource
    ));

    const returnedLampReferenceImageSummary =
      normalizedLampReferenceImage
        ? sanitizeKitAiLampReferenceSummary(parsedResponse.image_summary || "")
        : "";

    let recommendedProducts = normalizeKitAiRecommendedProducts(
      parsedResponse.recommended_products || [],
      liveProducts
    );

    recommendedProducts = filterAlreadyActiveRecommendations(recommendedProducts, kitContext || {});
    recommendedProducts = enforceKitAiDualLedWireQuantity(recommendedProducts, kitContext || {});

    let activeKitActions = normalizeKitAiActiveKitActions(
      parsedResponse.active_kit_actions || [],
      liveProducts,
      kitContext || {}
    );

    if (
      isKitAiExplicitDirectAddQuestion(safeQuestion) &&
      deterministicDirectAddActions.length &&
      activeKitActions.length === 0
    ) {
      activeKitActions = normalizeKitAiActiveKitActions(
        deterministicDirectAddActions,
        liveProducts,
        kitContext || {}
      );

      const directAddAnswer = buildDirectAddOverrideAnswer(activeKitActions);
      if (directAddAnswer) answer = directAddAnswer;
    }

    /*
      Catalog-wide choice safety:
      If the assistant previously asked the customer to choose between exact live products,
      and the customer replies with the exact product name/SKU, execute that exact mapped
      kit action deterministically. This avoids connector-only and future option-selection
      failures across the Odoo product catalog.
    */
    if (
      deterministicExactSelectionActions.length &&
      activeKitActions.length === 0
    ) {
      activeKitActions = normalizeKitAiActiveKitActions(
        deterministicExactSelectionActions,
        liveProducts,
        kitContext || {}
      );

      const exactSelectionAnswer = buildDirectAddOverrideAnswer(activeKitActions);
      if (exactSelectionAnswer) answer = exactSelectionAnswer;
    }

    if (
      recommendedProducts.length === 0 &&
      answerInvitesAddAll(answer)
    ) {
      const recoveredRecommendedProducts = recoverLiveRecommendedProductsFromAnswer(
        answer,
        liveProducts,
        kitContext || {}
      );

      if (recoveredRecommendedProducts.length) {
        recommendedProducts = recoveredRecommendedProducts;
      }
    }

    if (userWantsAiToChoose(safeQuestion)) {
      const seenTypes = new Set();
      recommendedProducts = recommendedProducts.filter((p) => {
        const type = compactTextForMatch(p.type || p.name || "");
        const bucket =
          type.includes("led") || type.includes("cob") || type.includes("strip") ? "led" :
          type.includes("battery") || type.includes("18650") ? "battery" :
          type.includes("wire") || type.includes("jst") || type.includes("connector") ? "wire" :
          type.includes("touch") || type.includes("sensor") ? "touch" :
          type.includes("driver") ? "driver" :
          type || "other";

        if (seenTypes.has(bucket)) return false;
        seenTypes.add(bucket);
        return true;
      }).slice(0, 8);
    }

    let alternativeProducts = buildKitAiAlternativeProducts(
      activeKitActions.length ? activeKitActions.filter((a) => a.action === "add") : recommendedProducts,
      liveProducts,
      kitContext || {}
    );

    const fakeSkus = getFakeSkusFromAnswer(answer, liveProducts);

    // Fast backend guardrail: do not return fake SKU recommendations.
    if (fakeSkus.length) {
      recommendedProducts = [];

      /*
        Only switch into the product-number correction reply when the USER
        actually asked about a specific product/SKU. Previously, a stray SKU
        hallucination inside Gemini's answer could overwrite an unrelated
        question such as "Rechargeable or USB?" with a random 205-style reply.
      */
      if (kitAiUserAskedAboutSpecificProduct(safeQuestion)) {
        const liveNumberMatches = findLiveProductsByNumber(
          `${safeQuestion}\n${answer}\n${fakeSkus.join(" ")}`,
          liveProducts,
          8
        );

        const liveCorrectionAnswer = buildLiveProductCorrectionAnswer(safeQuestion, liveNumberMatches);

        if (liveCorrectionAnswer) {
          answer = liveCorrectionAnswer;
        } else {
          answer = [
            "I cannot safely recommend that SKU because it is not currently listed live on the Smart Handicrafts website.",
            "",
            "Closest live products available for checking:",
            buildAvailableProductSummary(relevantLiveProducts, 8),
            "",
            "Please share your lamp voltage, total wattage, LED strip type and battery requirement so the closest live option can be verified."
          ].join("\n");
        }
      } else {
        // Preserve the real answer for general questions, but remove unsupported SKU tokens.
        answer = removeUnsupportedSkuMentionsFromAnswer(answer, fakeSkus);
      }
    }

    const guidedFlow = applyGuidedKitAiFlowOverrides({
      question: safeQuestion,
      kitContext: kitContext || {},
      liveProducts,
      answer,
      recommendedProducts,
      activeKitActions,
      alternativeProducts,
      actionOffer: parsedResponse.action_offer || (recommendedProducts.length ? "active_kit" : "none")
    });

    answer = guidedFlow.answer;
    recommendedProducts = guidedFlow.recommendedProducts;
    activeKitActions = guidedFlow.activeKitActions;
    alternativeProducts = guidedFlow.alternativeProducts;

    /*
      Final honesty guardrails:
      - Never tell a customer a clearly matched live Odoo product is "not live".
      - Never say an item was/is being added unless a real add path exists
        (active kit action or fresh exact recommendation for frontend confirmation).
    */
    answer = repairFalseNotLiveKitAiAnswer({
      answer,
      question: safeQuestion,
      liveProducts
    });

    answer = repairUnsupportedImmediateKitMutationClaim({
      answer,
      activeKitActions,
      recommendedProducts,
      liveProducts,
      question: safeQuestion
    });

    answer = applyKitAiDecisionPolicyRepair({
      answer,
      decisionPolicy,
      kitContext: kitContext || {}
    });

    const finalPayload = {
      ok: true,
      answer,
      image_summary: returnedLampReferenceImageSummary,
      image_analyzed_this_turn: !!normalizedLampReferenceImage,
      recommended_products: recommendedProducts,
      active_kit_actions: activeKitActions,
      alternative_products: alternativeProducts,
      action_offer: guidedFlow.actionOffer || (recommendedProducts.length ? "active_kit" : "none"),
      live_products_available: true,
      live_products_count: liveProducts.length,
      prompt_products_count: relevantLiveProducts.length,
      prompt_rules_count: relevantApprovedRules.length,
      prompt_integration_chunks_count: relevantIntegrationKnowledgeChunks.length,
      integration_consulting_mode: integrationConsultingMode,
      deterministic_decision_policy_id: decisionPolicy?.active?.id || null,
      deterministic_decision_policy_active: !!decisionPolicy?.active,
      deterministic_decision_supporting_policy_ids: Array.isArray(decisionPolicy?.supporting)
        ? decisionPolicy.supporting.map((item) => item.id)
        : [],
      reference_image_used: !!normalizedLampReferenceImage,
      prior_reference_image_summary_used: !!priorLampReferenceSummary,
      deterministic_starter_candidates_count: deterministic201StarterLiveProducts.length,
      deterministic_202_completion_candidates_count: deterministic202CompletionLiveProducts.length,
      deterministic_direct_add_candidates_count: deterministicDirectAddActions.length,
      deterministic_exact_selection_candidates_count: deterministicExactSelectionActions.length,
      live_products_cached: !!liveProductResult.cached,
      model: KIT_AI_MODEL
    };

    if (wantsStream) {
      // The final event replaces any streamed preview text if guardrails or
      // answer cleanup adjusted the final wording.
      sendKitAiSse(res, "final", finalPayload);
      res.end();
      return;
    }

    return res.json(finalPayload);
  } catch (error) {
    console.error("Kit AI error:", error);

    if (res.headersSent) {
      sendKitAiSse(res, "error", {
        ok: false,
        error: "AI assistant failed to respond"
      });
      res.end();
      return;
    }

    return res.status(500).json({
      ok: false,
      error: "AI assistant failed to respond"
    });
  }
});



// ===================== KIT AI TRAINING RULE ROUTES =====================


// Auto-approved chat training route. Hidden command route used by /train in the embed.
app.post("/kit-ai-train", async (req, res) => {
  try {
    const {
      ruleText,
      relatedSku = "",
      category = "compatibility",
      pageUrl = "",
      userMessage = "",
      approvedBy = "chat-train"
    } = req.body || {};

    const result = await createOdooAiTrainingRule({
      ruleText,
      status: "approved",
      source: "admin",
      category,
      relatedSku,
      pageUrl,
      userMessage,
      approvedBy,
      approvedDate: new Date().toISOString().slice(0, 19).replace("T", " "),
      active: true
    });

    return res.json({
      ok: true,
      id: result.id,
      status: "approved",
      message: "Approved training rule saved."
    });
  } catch (error) {
    console.error("Kit AI auto train error:", error);
    return res.status(500).json({
      ok: false,
      error: "Could not save approved training rule.",
      detail: String(error?.message || error || "")
    });
  }
});

app.post("/kit-ai-feedback", async (req, res) => {
  try {
    const {
      ruleText,
      userMessage,
      pageUrl,
      relatedSku = "",
      category = "compatibility"
    } = req.body || {};

    const result = await createOdooAiTrainingRule({
      ruleText,
      status: "pending",
      source: "public",
      category,
      relatedSku,
      pageUrl,
      userMessage,
      active: true
    });

    return res.json({
      ok: true,
      id: result.id,
      status: "pending",
      message: "Feedback saved for Smart Handicrafts review."
    });
  } catch (error) {
    console.error("Kit AI feedback error:", error);
    return res.status(500).json({
      ok: false,
      error: "Could not save feedback."
    });
  }
});

app.post("/kit-ai-admin-train", async (req, res) => {
  try {
    const {
      adminKey,
      ruleText,
      relatedSku = "",
      category = "compatibility",
      pageUrl = "",
      userMessage = "",
      approvedBy = "admin"
    } = req.body || {};

    const expectedKey = process.env.TRAINING_ADMIN_KEY || "";
    if (!expectedKey || adminKey !== expectedKey) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const result = await createOdooAiTrainingRule({
      ruleText,
      status: "approved",
      source: "admin",
      category,
      relatedSku,
      pageUrl,
      userMessage,
      approvedBy,
      approvedDate: new Date().toISOString().slice(0, 19).replace("T", " "),
      active: true
    });

    return res.json({
      ok: true,
      id: result.id,
      status: "approved",
      message: "Approved training rule saved."
    });
  } catch (error) {
    console.error("Kit AI admin train error:", error);
    return res.status(500).json({
      ok: false,
      error: "Could not save admin training rule."
    });
  }
});



app.get("/kit-ai-training-selection-values", async (req, res) => {
  try {
    const values = await getAiTrainingSelectionValues({ force: true });
    return res.json({
      ok: true,
      values
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: String(error?.message || error || "")
    });
  }
});

app.get("/kit-ai-approved-rules", async (req, res) => {
  try {
    const result = await getApprovedOdooAiTrainingRules({ force: true });
    return res.json({
      ok: result.ok,
      count: result.rules.length,
      rules: result.rules,
      error: result.error || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: String(error?.message || error)
    });
  }
});

app.post("/api/self-training/feedback", (req, res) => {
  try {
    const interactionId = String(req.body?.interaction_id || "").trim();
    const score = Number(req.body?.score);
    const scope = String(req.body?.scope || "").trim() || undefined;
    if (!interactionId) return res.status(400).json({ error: "interaction_id is required" });
    if (!Number.isFinite(score) || score < -1 || score > 1) {
      return res.status(400).json({ error: "score must be a number between -1 and 1" });
    }

    const row = applySelfTrainingFeedback({ interactionId, score, scope });
    if (!row) return res.status(404).json({ error: "interaction not found in self-training memory" });
    return res.json({ ok: true, interaction_id: interactionId, scope: row.scope, quality: row.quality });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/self-training", (req, res) => {
  const scope = String(req.query?.scope || "").trim() || undefined;
  return res.json(getSelfTrainingStats(scope));
});

app.post("/api/product-bot/feedback", (req, res) => {
  try {
    const interactionId = String(req.body?.interaction_id || "").trim();
    const score = Number(req.body?.score);
    if (!interactionId) return res.status(400).json({ error: "interaction_id is required" });
    if (!Number.isFinite(score) || score < -1 || score > 1) {
      return res.status(400).json({ error: "score must be a number between -1 and 1" });
    }
    const row = applySelfTrainingFeedback({ interactionId, score, scope: "product_bot" });
    if (!row) return res.status(404).json({ error: "interaction not found in self-training memory" });
    return res.json({ ok: true, interaction_id: interactionId, scope: row.scope, quality: row.quality });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/product-bot/self-training", (req, res) => {
  return res.json(getSelfTrainingStats("product_bot"));
});

app.get("/api/product-bot/modes", (req, res) => {
  const modes = [{ key: "auto", label: "Auto-detect" }, ...Object.entries(PRODUCT_BOT_MODES).map(([key, value]) => ({ key, label: value.label }))];
  res.json({ ok: true, modes });
});

app.get("/api/product-bot/routing-telemetry", (req, res) => {
  return res.json({ ok: true, ...routingTelemetry });
});

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
        const agentMemory = buildSelfTrainingContext(prompt, { scope: "debate", modeKey: agent.name });
        const agentSystem = agentMemory ? `${agent.system}\n\n${agentMemory}` : agent.system;
        const result = await callGeminiWithFallback(agentSystem, prompt, debateText, AGENT_A_OR_MODEL);
        reply = result.text;
      } else {
        const agentMemory = buildSelfTrainingContext(prompt, { scope: "debate", modeKey: agent.name });
        const agentSystem = agentMemory ? `${agent.system}\n\n${agentMemory}` : agent.system;
        reply = await callOpenRouter(agentSystem, prompt, debateText, agent.model);
      }

      history.push({ agent: agent.name, content: reply });

      if (showDebate) send({ type: "turn", agent: agent.name, content: reply, time: now() });
    }

    send({ type: "status", message: "Judge finalizing...", time: now() });
    const judgeMemory = buildSelfTrainingContext(prompt, { scope: "debate", modeKey: "Judge" });
    const judgeSystem = judgeMemory ? `${JUDGE_SYSTEM}\n\n${judgeMemory}` : JUDGE_SYSTEM;
    const judgeResult = await callGeminiWithFallback(judgeSystem, prompt, historyToText(history), JUDGE_OR_MODEL);
    const finalAnswer = judgeResult.text;
    const interaction_id = recordSelfTrainingExample({
      scope: "debate",
      message: prompt,
      answer: finalAnswer,
      mode: "Judge",
      retrieval: { sources: [] }
    });

    send({ type: "final", content: finalAnswer, interaction_id, time: now() });
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


async function odooFetchReportPdfWithFallback(reportNames = [], docId) {
  let lastErr = null;
  for (const reportName of reportNames) {
    try {
      return await odooFetchReportPdf(reportName, docId);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("No report template could generate PDF.");
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

async function odooSearchInvoices({ query = "", paymentState = "", moveState = "posted", limit = 50 }) {
  const uid = await odooLogin();
  const domain = [["move_type", "=", "out_invoice"]];
  if (moveState) domain.push(["state", "=", moveState]);
  if (paymentState) domain.push(["payment_state", "=", paymentState]);
  if (query) {
    domain.push("|");
    domain.push("|");
    domain.push(["name", "ilike", query]);
    domain.push(["partner_id.name", "ilike", query]);
    domain.push(["invoice_origin", "ilike", query]);
  }

  const rows = await odooExecute(
    uid,
    "account.move",
    "search_read",
    [domain, ["id", "name", "invoice_date", "invoice_date_due", "amount_total", "amount_residual", "payment_state", "partner_id"]],
    { limit: Math.min(Number(limit) || 50, 100), order: "id desc" }
  );
  return rows || [];
}

async function odooSearchDeliveryOrders({ query = "", state = "", type = "outgoing", limit = 50 }) {
  const uid = await odooLogin();
  const domain = [];
  if (state) domain.push(["state", "=", state]);
  if (type) domain.push(["picking_type_code", "=", type]);
  if (query) {
    domain.push("|");
    domain.push("|");
    domain.push(["name", "ilike", query]);
    domain.push(["origin", "ilike", query]);
    domain.push(["partner_id.name", "ilike", query]);
  }

  const rows = await odooExecute(
    uid,
    "stock.picking",
    "search_read",
    [domain, ["id", "name", "origin", "scheduled_date", "state", "partner_id", "picking_type_code", "carrier_id"]],
    { limit: Math.min(Number(limit) || 50, 100), order: "id desc" }
  );
  return rows || [];
}

function coerceRole(rawRole = "") {
  const role = String(rawRole || "").toLowerCase();
  if (["finance", "accounting"].includes(role)) return "finance";
  if (["sales", "crm"].includes(role)) return "sales";
  if (["operations", "ops", "logistics"].includes(role)) return "operations";
  if (["hr", "human_resources"].includes(role)) return "hr";
  return "admin";
}

function roleGuard(role, area) {
  const acl = {
    sales: new Set(["customer", "sales", "crm", "product"]),
    finance: new Set(["customer", "invoice", "vendor", "purchase", "kpi"]),
    operations: new Set(["sales", "purchase", "product", "automation", "exception"]),
    hr: new Set(["employee", "attendance", "timesheet"]),
    admin: new Set(["*"])
  };
  const permissions = acl[role] || acl.admin;
  return permissions.has("*") || permissions.has(area);
}

async function fetchReadModel(uid, type, { query = "", days = 30, limit = 20, includeHr = false } = {}) {
  const safeLimit = Math.min(Number(limit) || 20, 200);
  if (type === "customers") {
    return await odooExecute(uid, "res.partner", "search_read", [[ ["customer_rank", ">", 0], ["name", "ilike", query || ""] ], ["id", "name", "phone", "email", "credit", "debit", "total_invoiced"]], { limit: safeLimit, order: "id desc" });
  }
  if (type === "sales_orders") {
    return await odooExecute(uid, "sale.order", "search_read", [[ ["name", "ilike", query || ""] ], ["id", "name", "state", "amount_total", "commitment_date", "partner_id", "invoice_status"]], { limit: safeLimit, order: "id desc" });
  }
  if (type === "invoices") {
    return await odooExecute(uid, "account.move", "search_read", [[ ["move_type", "=", "out_invoice"], ["name", "ilike", query || ""] ], ["id", "name", "payment_state", "invoice_date_due", "amount_total", "amount_residual", "partner_id"]], { limit: safeLimit, order: "invoice_date_due asc" });
  }
  if (type === "products") {
    return await odooExecute(uid, "product.product", "search_read", [[ ["display_name", "ilike", query || ""] ], ["id", "display_name", "qty_available", "list_price", "default_code", "product_template_variant_value_ids"]], { limit: safeLimit, order: "id desc" });
  }
  if (type === "crm") {
    return await odooExecute(uid, "crm.lead", "search_read", [[ ["type", "=", "opportunity"], ["name", "ilike", query || ""] ], ["id", "name", "stage_id", "expected_revenue", "probability", "user_id"]], { limit: safeLimit, order: "id desc" });
  }
  if (type === "purchase") {
    return await odooExecute(uid, "purchase.order", "search_read", [[ ["name", "ilike", query || ""] ], ["id", "name", "state", "date_planned", "amount_total", "partner_id"]], { limit: safeLimit, order: "id desc" });
  }
  if (type === "vendor_bills") {
    return await odooExecute(uid, "account.move", "search_read", [[ ["move_type", "=", "in_invoice"], ["name", "ilike", query || ""] ], ["id", "name", "state", "invoice_date_due", "amount_total", "payment_state", "partner_id"]], { limit: safeLimit, order: "id desc" });
  }
  if (type === "hr" && includeHr) {
    const since = new Date(Date.now() - Number(days || 30) * 86400000).toISOString();
    const [employees, timesheets, attendance] = await Promise.all([
      odooExecute(uid, "hr.employee", "search_read", [[], ["id", "name", "work_email", "job_title"]], { limit: safeLimit }),
      odooExecute(uid, "account.analytic.line", "search_read", [[["date", ">=", since.slice(0, 10)]], ["id", "name", "employee_id", "unit_amount", "date"]], { limit: safeLimit }),
      odooExecute(uid, "hr.attendance", "search_read", [[["check_in", ">=", since]], ["id", "employee_id", "check_in", "check_out", "worked_hours"]], { limit: safeLimit })
    ]);
    return { employees, timesheets, attendance };
  }
  throw new Error(`Unsupported read type '${type}'`);
}

async function computeExceptionAlerts(uid) {
  const [failedPayments, stockouts, delayedShipments] = await Promise.all([
    odooExecute(uid, "account.payment", "search_read", [[["state", "=", "failed"]], ["id", "name", "amount", "partner_id", "date"]], { limit: 50, order: "id desc" }).catch(() => []),
    odooExecute(uid, "product.product", "search_read", [[["qty_available", "<=", 0]], ["id", "display_name", "qty_available"]], { limit: 50, order: "id desc" }),
    odooExecute(uid, "stock.picking", "search_read", [[["state", "in", ["confirmed", "assigned", "waiting"]], ["scheduled_date", "<", new Date().toISOString()]], ["id", "name", "scheduled_date", "partner_id", "state"]], { limit: 50, order: "scheduled_date asc" })
  ]);
  return { failed_payments: failedPayments, stockouts, delayed_shipments: delayedShipments };
}

async function runAutomationRules(uid, options = {}) {
  const overdueDays = Number(options.overdueDays ?? 7);
  const out = { overdueInvoices: [], leadAssignments: [] };

  const overdueInvoices = await odooExecute(
    uid,
    "account.move",
    "search_read",
    [[
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["payment_state", "!=", "paid"],
      ["invoice_date_due", "!=", false],
      ["invoice_date_due", "<", new Date(Date.now() - overdueDays * 86400000).toISOString().slice(0, 10)]
    ], ["id", "name", "partner_id", "invoice_date_due", "amount_residual"]],
    { limit: 100 }
  );

  for (const inv of overdueInvoices || []) {
    const note = `Invoice ${inv.name || inv.id} is overdue since ${inv.invoice_date_due || "unknown date"}.`;
    const activityId = await odooExecute(uid, "mail.activity", "create", [{
      res_model_id: false,
      summary: "Overdue invoice follow-up",
      note,
      date_deadline: new Date().toISOString().slice(0, 10)
    }]).catch(() => null);

    out.overdueInvoices.push({
      invoice_id: inv.id,
      invoice: inv.name,
      partner: inv.partner_id?.[1] || "",
      due_date: inv.invoice_date_due,
      amount_residual: inv.amount_residual,
      followup_activity_id: activityId
    });
  }

  const unassignedLeads = await odooExecute(
    uid,
    "crm.lead",
    "search_read",
    [[["user_id", "=", false], ["type", "=", "opportunity"]], ["id", "name", "country_id", "partner_name"]],
    { limit: 100 }
  );

  const users = await odooExecute(uid, "res.users", "search_read", [[], ["id", "name"]], { limit: 200 });
  const userNameMap = new Map((users || []).map((u) => [String(u.name || "").toLowerCase(), u.id]));
  const regionAssignments = options.regionAssignments || {};
  const fallbackSalesUser = users?.[0]?.id || null;
  for (const lead of unassignedLeads || []) {
    const regionKey = String(lead.country_id?.[1] || "").toLowerCase();
    const preferredUserName = regionAssignments[regionKey] || regionAssignments.default;
    const assignedUserId = preferredUserName ? userNameMap.get(String(preferredUserName).toLowerCase()) : fallbackSalesUser;
    if (!assignedUserId) break;
    await odooExecute(uid, "crm.lead", "write", [[lead.id], { user_id: assignedUserId }]);
    out.leadAssignments.push({ lead_id: lead.id, lead: lead.name, region: lead.country_id?.[1] || null, assigned_user_id: assignedUserId });
  }

  return out;
}

async function generateOdooSummary(uid) {
  const [newLeads, unpaidInvoices, lowStockProducts, exceptions] = await Promise.all([
    odooExecute(uid, "crm.lead", "search_count", [[["create_date", ">=", new Date(Date.now() - 86400000).toISOString()]]]),
    odooExecute(uid, "account.move", "search_count", [[["move_type", "=", "out_invoice"], ["state", "=", "posted"], ["payment_state", "!=", "paid"]]]),
    odooExecute(uid, "product.product", "search_read", [[["qty_available", "<=", 5]], ["id", "display_name", "qty_available"]], { limit: 20 }),
    computeExceptionAlerts(uid)
  ]);

  return {
    generated_at: now(),
    new_leads_24h: newLeads,
    unpaid_invoices: unpaidInvoices,
    low_stock: lowStockProducts || [],
    exception_alerts: exceptions
  };
}

async function computeKpis(uid) {
  const monthlyRevenue = await odooExecute(
    uid,
    "account.move",
    "search_read",
    [[
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["invoice_date", ">=", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)]
    ], ["amount_total"]],
    { limit: 5000 }
  );

  const pipeline = await odooExecute(uid, "crm.lead", "search_read", [[["type", "=", "opportunity"], ["active", "=", true]], ["expected_revenue"]], { limit: 5000 });
  const aging = await odooExecute(uid, "account.move", "search_read", [[["move_type", "=", "out_invoice"], ["state", "=", "posted"], ["payment_state", "!=", "paid"]], ["name", "invoice_date_due", "amount_residual", "partner_id"]], { limit: 2000 });
  const [topProducts, topCustomers] = await Promise.all([
    odooExecute(uid, "sale.order.line", "search_read", [[], ["product_id", "price_total"]], { limit: 5000, order: "id desc" }),
    odooExecute(uid, "sale.order", "search_read", [[["state", "in", ["sale", "done"]]], ["partner_id", "amount_total"]], { limit: 5000, order: "id desc" })
  ]);

  const topMap = new Map();
  const customerMap = new Map();
  for (const row of topProducts || []) {
    const key = row.product_id?.[1] || "Unknown";
    topMap.set(key, (topMap.get(key) || 0) + Number(row.price_total || 0));
  }
  for (const order of topCustomers || []) {
    const key = order.partner_id?.[1] || "Unknown";
    customerMap.set(key, (customerMap.get(key) || 0) + Number(order.amount_total || 0));
  }

  return {
    monthly_revenue: (monthlyRevenue || []).reduce((a, b) => a + Number(b.amount_total || 0), 0),
    pipeline_value: (pipeline || []).reduce((a, b) => a + Number(b.expected_revenue || 0), 0),
    collection_aging: aging || [],
    top_products: Array.from(topMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, revenue]) => ({ name, revenue })),
    top_customers: Array.from(customerMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, revenue]) => ({ name, revenue }))
  };
}

async function handleNaturalLanguageQuery(uid, text, options = {}) {
  const role = coerceRole(options.role);
  const queryUser = options.user || "unknown";

  // ── STEP 1: Use LLM to parse intent + extract entities from any free-form text ──
  // This replaces all fragile regex branches. The LLM understands every possible
  // phrasing: "show me Acme's bills", "do we have pending payments from XYZ?",
  // "kya Ramesh ke invoices hain?", "get me overdue stuff", etc.
  const intentParsePrompt = `You are an ERP query parser for an Odoo system. Parse the user's message and return ONLY a JSON object.

User message: "${String(text || "").replace(/"/g, "'")}"

Return JSON with these fields:
{
  "intent": one of: "create_quotation" | "list_invoices" | "list_unpaid_invoices" | "lookup_customer" | "list_orders" | "delayed_orders" | "list_products" | "kpi_summary" | "fallback",
  "customer_name": string or null,
  "invoice_ref": string or null,
  "days": number (default 30, extract from "last N days" if mentioned),
  "only_unpaid": boolean (true if user wants unpaid/pending/overdue/outstanding only),
  "limit": number (default 20),
  "company_name": string or null,
  "sku": string or null,
  "qty": number or null
}

Intent rules:
- "create_quotation" = user asks to create/prepare/make a quote or quotation in Odoo
- "list_invoices" = any request to see/show/get/fetch invoices or bills for a company
- "list_unpaid_invoices" = user specifically wants unpaid/pending/overdue/outstanding invoices
- "lookup_customer" = find/search/show customer details or profile
- "list_orders" = show/get sales orders or quotations
- "delayed_orders" = asking about late/delayed/stuck/pending orders
- "list_products" = asking about products, stock, inventory
- "kpi_summary" = asking for summary, dashboard, overview, KPIs
- "fallback" = cannot determine intent

Return ONLY the JSON object, no explanation, no markdown.`;

  let parsed = null;
  try {
    const llmResult = await callProductBotModel(
      "You are a strict JSON-only ERP query parser. Output only valid JSON, no markdown, no explanation.",
      intentParsePrompt
    );
    const raw = String(llmResult?.text || "").trim().replace(/^```json|```$/g, "").trim();
    parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    // LLM parse failed — fall through to regex fallback below
  }

  // If LLM gave us nothing useful, use a lightweight regex fallback
  if (!parsed?.intent || parsed.intent === "fallback") {
    const q = String(text || "").toLowerCase();
    const dayMatch = q.match(/last\s+(\d+)\s+days?/);
    const days = dayMatch ? Number(dayMatch[1]) : 30;
    const isUnpaid = /(unpaid|overdue|outstanding|pending\s+payment|not\s+paid)/i.test(q);
    const hasInvoice = /(invoice|bill)/i.test(q);
    const hasCustomer = /(customer|client|partner)/i.test(q);
    const hasOrder = /(order|quotation|sale)/i.test(q);
    const isDelayed = /(delay|late|stuck|pending|not\s+delivered)/i.test(q);

    parsed = {
      intent: /(create|prepare|make).*(quote|quotation)|proforma/i.test(q) ? "create_quotation"
        : isUnpaid && hasInvoice ? "list_unpaid_invoices"
        : hasInvoice ? "list_invoices"
        : hasCustomer ? "lookup_customer"
        : isDelayed && hasOrder ? "delayed_orders"
        : hasOrder ? "list_orders"
        : "fallback",
      customer_name: null,
      invoice_ref: null,
      days,
      only_unpaid: isUnpaid,
      limit: 20,
      company_name: extractCompanyName(text),
      sku: null,
      qty: parseUserQuantity(text)
    };
  }

  const { intent, customer_name, invoice_ref, days = 30, only_unpaid, limit = 20, company_name, sku, qty } = parsed;
  const safeLimit = Math.min(Number(limit) || 20, 100);

  // ── STEP 2: Execute the right Odoo query based on parsed intent ──

  if (intent === "create_quotation") {
    if (!roleGuard(role, "sales")) return { intent: "forbidden", message: `Role '${role}' cannot create quotations.` };

    const parsedSku = sku || resolveSkuCandidates(text, productKnowledgeCache.skuCatalog || [])[0]?.sku || null;
    const parsedQty = Number(qty || parseUserQuantity(text) || 0);
    const parsedCompany = company_name || extractCompanyName(text) || customer_name || null;

    if (!parsedCompany) {
      return {
        intent: "create_quotation",
        role,
        message: "Please provide company name to create quotation in Odoo.",
        missing_fields: ["company_name"]
      };
    }

    if (!parsedSku) {
      return {
        intent: "create_quotation",
        role,
        message: "Please provide SKU to create quotation in Odoo.",
        missing_fields: ["sku"]
      };
    }

    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      return {
        intent: "create_quotation",
        role,
        message: "Please provide valid quantity to create quotation in Odoo.",
        missing_fields: ["qty"]
      };
    }

    const result = await odooCreateQuotation(uid, {
      company_name: parsedCompany,
      sku: parsedSku,
      qty: parsedQty
    });

    if (!result.ok) {
      return {
        intent: "create_quotation",
        role,
        message: result.message || "Failed to create quotation in Odoo.",
        reason: result.reason || "unknown"
      };
    }

    return {
      intent: "create_quotation",
      role,
      summary: `Quotation **${result.quotation_name}** created for **${result.partner_name}**.\n• SKU: ${result.sku}\n• Qty: ${result.qty}\n• Unit price: ₹${Number(result.unit_price || 0).toLocaleString("en-IN")}\n• Subtotal: ₹${Number(result.subtotal || 0).toLocaleString("en-IN")}\n• Total: ₹${Number(result.total || 0).toLocaleString("en-IN")}`,
      quotation: result,
      requested_by: queryUser
    };
  }

  if (intent === "list_invoices" || intent === "list_unpaid_invoices") {
    if (!roleGuard(role, "invoice")) return { intent: "forbidden", message: `Role '${role}' cannot view invoices.` };

    const domain = [["move_type", "=", "out_invoice"], ["state", "=", "posted"]];
    if (only_unpaid || intent === "list_unpaid_invoices") {
      domain.push(["payment_state", "!=", "paid"]);
      domain.push(["invoice_date", ">=", new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)]);
    }
    if (customer_name) domain.push(["partner_id.name", "ilike", customer_name]);
    if (invoice_ref) domain.push(["name", "ilike", invoice_ref]);

    const rows = await odooExecute(
      uid, "account.move", "search_read",
      [domain, ["id", "name", "partner_id", "payment_state", "amount_total", "amount_residual", "invoice_date_due"]],
      { limit: safeLimit, order: "invoice_date_due desc" }
    );

    const total = (rows || []).reduce((s, r) => s + Number(r.amount_residual || 0), 0);
    const header = (rows || []).length
      ? `Found **${rows.length}** invoice(s)${customer_name ? ` for **${customer_name}**` : ""}${only_unpaid ? " (unpaid/overdue)" : ""}.${only_unpaid ? ` Total outstanding: ₹${total.toFixed(0)}` : ""}`
      : `No invoices found${customer_name ? ` for **${customer_name}**` : ""}. Try checking the company name spelling.`;

    const lines = (rows || []).map((r) => {
      const name = r.name || `ID:${r.id}`;
      const partner = Array.isArray(r.partner_id) ? r.partner_id[1] : (r.partner_id || "");
      const total = `₹${Number(r.amount_total || 0).toLocaleString("en-IN")}`;
      const due = `₹${Number(r.amount_residual || 0).toLocaleString("en-IN")}`;
      const dueDate = r.invoice_date_due || "—";
      const status = r.payment_state === "paid" ? "✅ Paid" : r.payment_state === "partial" ? "🔶 Partial" : "🔴 Unpaid";
      return `• **${name}** | ${partner} | Total: ${total} | Outstanding: ${due} | Due: ${dueDate} | ${status}`;
    });

    return {
      intent: intent === "list_unpaid_invoices" ? "list_unpaid_invoices" : "lookup_customer_invoice",
      role,
      rows,
      summary: lines.length ? `${header}\n\n${lines.join("\n")}` : header,
      customer_searched: customer_name || null,
      suggested_next_action: "Use an invoice name/ID to fetch its PDF via the invoice endpoint.",
      requested_by: queryUser
    };
  }

  if (intent === "lookup_customer") {
    if (!roleGuard(role, "sales")) return { intent: "forbidden", message: `Role '${role}' cannot look up customers.` };

    const domain = [["customer_rank", ">", 0]];
    if (customer_name) domain.push(["name", "ilike", customer_name]);

    const rows = await odooExecute(
      uid, "res.partner", "search_read",
      [domain, ["id", "name", "email", "phone", "street", "city", "country_id", "vat", "total_invoiced"]],
      { limit: safeLimit, order: "name asc" }
    );

    const header = (rows || []).length
      ? `Found **${rows.length}** customer(s)${customer_name ? ` matching **${customer_name}**` : ""}.`
      : `No customers found${customer_name ? ` matching **${customer_name}**` : ""}. Try a partial name.`;

    const lines = (rows || []).map((r) =>
      `• **${r.name}** | ${r.email || "—"} | ${r.phone || "—"} | ${r.city || "—"} | Invoiced: ₹${Number(r.total_invoiced || 0).toLocaleString("en-IN")}`
    );

    return {
      intent: "customer_lookup",
      role,
      rows,
      summary: lines.length ? `${header}\n\n${lines.join("\n")}` : header,
      customer_name_searched: customer_name || null,
      suggested_next_action: rows.length === 1 ? "Use customer ID to fetch their invoices or sales orders." : "Refine name for a closer match.",
      requested_by: queryUser
    };
  }

  if (intent === "delayed_orders") {
    if (!roleGuard(role, "sales")) return { intent: "forbidden", message: `Role '${role}' cannot inspect sales orders.` };

    const domain = [["state", "in", ["sale", "done"]]];
    if (customer_name) domain.push(["partner_id.name", "ilike", customer_name]);
    const rows = await odooExecute(uid, "sale.order", "search_read",
      [domain, ["id", "name", "partner_id", "commitment_date", "invoice_status", "amount_total"]],
      { limit: safeLimit, order: "id desc" }
    );
    const exceptions = await computeExceptionAlerts(uid);

    const lines = (rows || []).map((r) =>
      `• **${r.name}** | ${Array.isArray(r.partner_id) ? r.partner_id[1] : ""} | ₹${Number(r.amount_total || 0).toLocaleString("en-IN")} | Due: ${r.commitment_date || "—"} | Invoice: ${r.invoice_status || "—"}`
    );

    return {
      intent: "explain_order_delay",
      role,
      rows,
      summary: `Found **${rows.length}** confirmed order(s)${customer_name ? ` for **${customer_name}**` : ""}.\n\n${lines.join("\n")}\n\n**Likely causes of delays:** stockout, supplier PO delay, or pending delivery validation.`,
      context: { stockouts: exceptions.stockouts.slice(0, 5), delayed_shipments: exceptions.delayed_shipments.slice(0, 5) },
      requested_by: queryUser
    };
  }

  if (intent === "list_orders") {
    if (!roleGuard(role, "sales")) return { intent: "forbidden", message: `Role '${role}' cannot view sales orders.` };

    // FIX: was wrapping domain in extra [] causing Odoo domain syntax error
    const domain = customer_name ? [["partner_id.name", "ilike", customer_name]] : [];
    const rows = await odooExecute(uid, "sale.order", "search_read",
      [domain, ["id", "name", "partner_id", "state", "amount_total", "invoice_status", "date_order"]],
      { limit: safeLimit, order: "id desc" }
    );

    const lines = (rows || []).map((r) =>
      `• **${r.name}** | ${Array.isArray(r.partner_id) ? r.partner_id[1] : ""} | ₹${Number(r.amount_total || 0).toLocaleString("en-IN")} | ${r.state} | ${r.date_order?.slice(0, 10) || "—"}`
    );

    return {
      intent: "list_orders",
      role,
      rows,
      summary: lines.length
        ? `Found **${rows.length}** order(s)${customer_name ? ` for **${customer_name}**` : ""}.\n\n${lines.join("\n")}`
        : `No orders found${customer_name ? ` for **${customer_name}**` : ""}.`,
      requested_by: queryUser
    };
  }

  // FIX: list_products was declared in LLM prompt but had no execution branch — silent fallback
  if (intent === "list_products") {
    if (!roleGuard(role, "product")) return { intent: "forbidden", message: `Role '${role}' cannot view products.` };

    const domain = customer_name ? [["display_name", "ilike", customer_name]] : [];
    const rows = await odooExecute(uid, "product.product", "search_read",
      [domain, ["id", "display_name", "default_code", "qty_available", "virtual_available", "list_price", "active"]],
      { limit: safeLimit, order: "id desc" }
    );

    const lines = (rows || []).map((r) => {
      const stock = Number(r.qty_available || 0);
      const stockLabel = stock <= 0 ? "🔴 Out of stock" : stock <= 5 ? "🟡 Low stock" : "🟢 In stock";
      return `• **${r.display_name}** | SKU: ${r.default_code || "—"} | ₹${Number(r.list_price || 0).toLocaleString("en-IN")} | On hand: ${stock} | ${stockLabel}`;
    });

    return {
      intent: "list_products",
      role,
      rows,
      summary: lines.length
        ? `Found **${rows.length}** product(s)${customer_name ? ` matching **${customer_name}**` : ""}.\n\n${lines.join("\n")}`
        : `No products found${customer_name ? ` matching **${customer_name}**` : ""}.`,
      requested_by: queryUser
    };
  }

  if (intent === "kpi_summary") {
    const kpis = await computeKpis(uid);
    const summary = await generateOdooSummary(uid);
    const summaryText = [
      `📊 **KPI Summary** (as of ${now().slice(0,10)})`,
      `• New leads (24h): **${summary.new_leads_24h || 0}**`,
      `• Unpaid invoices: **${summary.unpaid_invoices || 0}**`,
      `• Low stock items: **${(summary.low_stock || []).length}**`,
      `• Monthly revenue: ₹**${Number(kpis.monthly_revenue || 0).toLocaleString("en-IN")}**`,
      `• Pipeline value: ₹**${Number(kpis.pipeline_value || 0).toLocaleString("en-IN")}**`,
      kpis.top_customers?.length ? `\n**Top customers:**\n${kpis.top_customers.slice(0,5).map(c => `• ${c.name}: ₹${Number(c.revenue).toLocaleString("en-IN")}`).join("\n")}` : ""
    ].filter(Boolean).join("\n");

    return { intent: "kpi_summary", role, summary: summaryText, kpis, requested_by: queryUser };
  }

  // Genuine fallback
  return {
    intent: "fallback",
    summary: "I wasn't sure what you're looking for. You can ask things like:\n• \"Show invoices for Acme Ltd\"\n• \"Unpaid bills in the last 30 days\"\n• \"Find customer Ramesh\"\n• \"Any delayed orders?\"\n• \"Sales orders this month\"\n• \"Show products / inventory\"\n• \"Give me a KPI summary\"",
    message: "Could not infer intent."
  };
}

async function startWeeklyReportScheduler(config = {}) {
  if (weeklyReportTimer) clearInterval(weeklyReportTimer);
  const enabled = !!config.enabled;
  if (!enabled) return { enabled: false };

  const intervalHours = Math.max(Number(config.intervalHours) || 168, 1);
  weeklyReportTimer = setInterval(async () => {
    try {
      const uid = await odooLogin();
      const payload = { generated_at: now(), kpis: await computeKpis(uid), summary: await generateOdooSummary(uid) };
      if (config.webhook_url) {
        await fetch(config.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } else {
        console.log("[weekly-report]", JSON.stringify(payload));
      }
    } catch (err) {
      console.error("Weekly report scheduler failed:", err.message);
    }
  }, intervalHours * 3600000);

  return { enabled: true, interval_hours: intervalHours, webhook_url: config.webhook_url || null };
}

// ===================== ODOO CRM/ERP ASSISTANT ROUTES =====================
app.post("/api/odoo/query", async (req, res) => {
  try {
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured" });
    const { model, domain = [], fields = [], limit = 50 } = req.body || {};
    if (!model) return res.status(400).json({ error: "model is required" });
    const uid = await odooLogin();
    const rows = await odooExecute(uid, model, "search_read", [domain, fields], { limit: Math.min(Number(limit) || 50, 200) });
    return res.json({ ok: true, model, rows });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.get("/api/odoo/read/:type", async (req, res) => {
  try {
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured" });
    const role = coerceRole(req.query.role);
    const type = String(req.params.type || "").toLowerCase();
    const includeHr = String(req.query.includeHr || "false") === "true";
    const areaByType = {
      customers: "customer",
      sales_orders: "sales",
      invoices: "invoice",
      products: "product",
      crm: "crm",
      purchase: "purchase",
      vendor_bills: "vendor",
      hr: "employee"
    };
    const area = areaByType[type];
    if (!area) return res.status(400).json({ error: `Unsupported read type '${type}'` });
    if (!roleGuard(role, area)) return res.status(403).json({ error: `Role '${role}' is not allowed to read '${type}'` });
    const uid = await odooLogin();
    const rows = await fetchReadModel(uid, type, {
      query: req.query.query || "",
      days: Number(req.query.days || 30),
      limit: Number(req.query.limit || 20),
      includeHr
    });
    return res.json({ ok: true, type, role, rows });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post("/api/odoo/action", async (req, res) => {
  try {
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured" });
    const { action, payload = {}, approval = {} } = req.body || {};
    const uid = await odooLogin();

    if (["confirm_order", "mark_done"].includes(action) && !approval?.approved) {
      return res.status(403).json({ error: `Action '${action}' requires approval`, approval_required: true });
    }

    if (action === "create_lead") {
      const id = await odooExecute(uid, "crm.lead", "create", [payload]);
      return res.json({ ok: true, action, id });
    }
    if (action === "create_contact") {
      const id = await odooExecute(uid, "res.partner", "create", [payload]);
      return res.json({ ok: true, action, id });
    }
    if (["create_quotation", "create_sales_order"].includes(action)) {
      const id = await odooExecute(uid, "sale.order", "create", [payload]);
      return res.json({ ok: true, action, id });
    }
    if (action === "create_invoice_draft") {
      const id = await odooExecute(uid, "account.move", "create", [{ ...payload, state: "draft" }]);
      return res.json({ ok: true, action, id });
    }
    if (action === "update_opportunity_stage") {
      await odooExecute(uid, "crm.lead", "write", [[payload.id], { stage_id: payload.stage_id }]);
      return res.json({ ok: true, action, id: payload.id });
    }
    if (["add_activity", "add_task", "add_reminder"].includes(action)) {
      const id = await odooExecute(uid, "mail.activity", "create", [payload]);
      return res.json({ ok: true, action, id });
    }
    if (action === "confirm_order") {
      await odooExecute(uid, "sale.order", "action_confirm", [[payload.id]]);
      return res.json({ ok: true, action, id: payload.id });
    }
    if (action === "mark_done") {
      await odooExecute(uid, payload.model, "write", [[payload.id], { state: "done" }]);
      return res.json({ ok: true, action, id: payload.id, model: payload.model });
    }
    return res.status(400).json({ error: `Unsupported action '${action}'` });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post("/api/odoo/automation/run", async (req, res) => {
  try {
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured" });
    const uid = await odooLogin();
    const rules = await runAutomationRules(uid, req.body || {});
    const dailySummary = await generateOdooSummary(uid);
    return res.json({ ok: true, rules, dailySummary });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post("/api/odoo/nl-query", async (req, res) => {
  try {
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured" });
    const uid = await odooLogin();
    const message = String(req.body?.message || "");
    const result = await handleNaturalLanguageQuery(uid, message, { role: req.body?.role, user: req.body?.user });
    const interaction_id = recordSelfTrainingExample({
      scope: "odoo",
      message,
      answer: JSON.stringify(result),
      mode: result?.intent || "nl_query",
      retrieval: { sources: [] }
    });
    return res.json({ ok: true, interaction_id, self_training: { enabled: SELF_TRAINING_ENABLED, memory_size: selfTrainingMemory.length }, ...result });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post("/api/odoo/conversation", async (req, res) => {
  try {
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured" });
    const uid = await odooLogin();
    const message = String(req.body?.message || "");
    const response = await handleNaturalLanguageQuery(uid, message, {
      role: req.body?.role,
      user: req.body?.user
    });
    const interaction_id = recordSelfTrainingExample({
      scope: "odoo",
      message,
      answer: JSON.stringify(response),
      mode: response?.intent || "conversation",
      retrieval: { sources: [] }
    });
    return res.json({ ok: true, interaction_id, self_training: { enabled: SELF_TRAINING_ENABLED, memory_size: selfTrainingMemory.length }, conversation: response });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.get("/api/odoo/kpi-dashboard", async (req, res) => {
  try {
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured" });
    const uid = await odooLogin();
    const kpis = await computeKpis(uid);
    return res.json({ ok: true, generated_at: now(), ...kpis });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.get("/api/odoo/reports/weekly", async (req, res) => {
  try {
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured" });
    const uid = await odooLogin();
    const [kpis, summary] = await Promise.all([computeKpis(uid), generateOdooSummary(uid)]);
    return res.json({ ok: true, report_type: "weekly", generated_at: now(), kpis, summary });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});


app.post("/api/odoo/reports/weekly/schedule", async (req, res) => {
  try {
    if (!odooConfigured) return res.status(400).json({ error: "Odoo not configured" });
    const config = await startWeeklyReportScheduler(req.body || {});
    return res.json({ ok: true, scheduler: config });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

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


app.get("/api/odoo/dashboard-document/:docType/:id/pdf", async (req, res) => {
  try {
    const docType = String(req.params.docType || "").trim();
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid or missing document id." });

    const reportByType = {
      sale_order: ["sale.report_saleorder"],
      invoice: ["account.report_invoice", "account.report_invoice_with_payments"],
      delivery_order: ["stock.report_deliveryslip"]
    };

    const reportNames = reportByType[docType];
    if (!reportNames) return res.status(400).json({ error: "Unsupported document type." });

    const pdf = await odooFetchReportPdfWithFallback(reportNames, id);
    const safeName = `${docType}-${id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
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

app.get("/api/odoo/invoices", async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();
    const paymentState = String(req.query.payment_state || "").trim();
    const moveState = String(req.query.move_state || "posted").trim();
    const limit = Number(req.query.limit || 50);

    const rows = await odooSearchInvoices({ query, paymentState, moveState, limit });
    const normalized = rows.map((r) => ({
      id: r.id,
      ref: r.name,
      invoice_date: r.invoice_date,
      due_date: r.invoice_date_due,
      amount_total: r.amount_total,
      amount_residual: r.amount_residual,
      payment_state: r.payment_state,
      customer: r.partner_id?.[1] || ""
    }));

    return res.json({ ok: true, rows: normalized });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/odoo/delivery-orders", async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();
    const state = String(req.query.state || "").trim();
    const type = String(req.query.type || "outgoing").trim();
    const limit = Number(req.query.limit || 50);

    const rows = await odooSearchDeliveryOrders({ query, state, type, limit });
    const normalized = rows.map((r) => ({
      id: r.id,
      ref: r.name,
      sale_ref: r.origin,
      scheduled_date: r.scheduled_date,
      state: r.state,
      customer: r.partner_id?.[1] || "",
      picking_type: r.picking_type_code,
      carrier: r.carrier_id?.[1] || ""
    }));

    return res.json({ ok: true, rows: normalized });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/profile-login", (req, res) => {
  const profile = String(req.body?.profile || "").trim();
  const password = String(req.body?.password || "");
  const expected = profilePasswords[profile];

  if (!profile || !Object.prototype.hasOwnProperty.call(profilePasswords, profile)) {
    return res.status(400).json({ ok: false, error: "Unknown profile" });
  }

  if (!expected) {
    return res.status(503).json({ ok: false, error: `Password is not configured for ${profile}` });
  }

  if (password !== expected) {
    return res.status(401).json({ ok: false, error: "Invalid password" });
  }

  res.setHeader("Set-Cookie", buildSessionCookie(profile));
  res.json({ ok: true, profile, sessionSeconds: PROFILE_SESSION_TTL_SECONDS });
});

app.get("/api/profile-session", (req, res) => {
  const session = readProfileSession(req);
  if (!session) return res.status(401).json({ ok: false, error: "No active session" });
  res.json({ ok: true, profile: session.profile, expiresAt: new Date(session.exp).toISOString() });
});

app.post("/api/profile-logout", (req, res) => {
  res.setHeader("Set-Cookie", `${PROFILE_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ ok: true, time: now(), odooConfigured }));


async function prewarmLiveOdooProducts() {
  try {
    const result = await getLiveOdooWebsiteProducts({ force: true });
    if (result.ok) {
      console.log(`Live Odoo product cache ready: ${result.products.length} products`);
    } else {
      console.warn(`Live Odoo product cache not ready: ${result.error || "unknown error"}`);
    }
  } catch (error) {
    console.warn("Live Odoo product prewarm failed:", error?.message || error);
  }
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
