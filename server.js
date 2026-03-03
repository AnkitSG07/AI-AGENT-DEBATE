import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import PDFDocument from "pdfkit";
import { readFile } from "node:fs/promises";

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
const AGENT_C_MODEL = process.env.OR_MODEL_GEMMA || process.env.OR_MODEL_MISTRAL || "google/gemma-3-4b-it";
const PRODUCT_BOT_OR_MODEL = process.env.OR_MODEL_PRODUCT_BOT || process.env.OR_MODEL_GEMMA || AGENT_C_MODEL;
const AGENT_A_OR_MODEL = process.env.OR_MODEL_AGENT_A || process.env.OR_MODEL_DEBATE_GEMINI || PRODUCT_BOT_OR_MODEL;
const JUDGE_OR_MODEL = process.env.OR_MODEL_JUDGE || process.env.OR_MODEL_DEBATE_JUDGE || PRODUCT_BOT_OR_MODEL;

const PRODUCT_KNOWLEDGE_PATH = process.env.PRODUCT_KNOWLEDGE_PATH || "./product-knowledge.md";
const PRODUCT_BOT_FALLBACK_CONTEXT = process.env.PRODUCT_BOT_CONTEXT || "";

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
Do not invent discounts or contractual terms.`
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

      const uid = await odooLogin();
      const odooResult = await handleNaturalLanguageQuery(uid, message, {
        role: req.body?.role,
        user: req.body?.user || "product-bot"
      });

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

    const resolvedSku = skuCandidates.length === 1 ? skuCandidates[0] : null;
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
      const qty = parseUserQuantity(message);
      const tiers = productKnowledgeCache.pricingCatalog.get(resolvedSku.sku) || [];
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
3) Keep recommendations practical and concise without legal boilerplate.
4) End with "Sources: [x][y]".`,
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
  "intent": one of: "list_invoices" | "list_unpaid_invoices" | "lookup_customer" | "list_orders" | "delayed_orders" | "list_products" | "kpi_summary" | "fallback",
  "customer_name": string or null,
  "invoice_ref": string or null,
  "days": number (default 30, extract from "last N days" if mentioned),
  "only_unpaid": boolean (true if user wants unpaid/pending/overdue/outstanding only),
  "limit": number (default 20)
}

Intent rules:
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
      intent: isUnpaid && hasInvoice ? "list_unpaid_invoices"
        : hasInvoice ? "list_invoices"
        : hasCustomer ? "lookup_customer"
        : isDelayed && hasOrder ? "delayed_orders"
        : hasOrder ? "list_orders"
        : "fallback",
      customer_name: null,
      invoice_ref: null,
      days,
      only_unpaid: isUnpaid,
      limit: 20
    };
  }

  const { intent, customer_name, invoice_ref, days = 30, only_unpaid, limit = 20 } = parsed;
  const safeLimit = Math.min(Number(limit) || 20, 100);

  // ── STEP 2: Execute the right Odoo query based on parsed intent ──

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

    const domain = [];
    if (customer_name) domain.push(["partner_id.name", "ilike", customer_name]);
    const rows = await odooExecute(uid, "sale.order", "search_read",
      [domain.length ? [domain] : [[]], ["id", "name", "partner_id", "state", "amount_total", "invoice_status", "date_order"]],
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

  if (intent === "kpi_summary") {
    const kpis = await computeKpis(uid);
    const summary = await generateOdooSummary(uid);
    return { intent: "kpi_summary", role, summary: summary || JSON.stringify(kpis, null, 2), kpis, requested_by: queryUser };
  }

  // Genuine fallback — LLM couldn't parse and regex couldn't either
  return {
    intent: "fallback",
    summary: "I wasn't sure what you're looking for. You can ask things like:\n• \"Show invoices for Acme Ltd\"\n• \"Unpaid bills in the last 30 days\"\n• \"Find customer Ramesh\"\n• \"Any delayed orders?\"\n• \"Sales orders this month\"",
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
