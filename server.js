import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import PDFDocument from "pdfkit";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

function now() {
  return new Date().toISOString();
}

// ===================== AI CONFIG =====================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!GEMINI_API_KEY) console.error("❌ Missing GEMINI_API_KEY");
if (!OPENROUTER_API_KEY) console.error("❌ Missing OPENROUTER_API_KEY");

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const GEMINI_MODEL = "gemini-2.5-flash";
const LLAMA_MODEL = process.env.OR_MODEL_LLAMA || "meta-llama/llama-3.1-8b-instruct";
const MISTRAL_MODEL = process.env.OR_MODEL_MISTRAL || "google/gemma-2-9b-it";

console.log("✅ Using Gemini model:", GEMINI_MODEL);
console.log("✅ Using OpenRouter model (Llama):", LLAMA_MODEL);
console.log("✅ Using OpenRouter model (Agent C):", MISTRAL_MODEL);

// ===================== ODOO CONFIG =====================
const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_PASS = process.env.ODOO_API_KEY_OR_PASSWORD;

const odooConfigured = !!(ODOO_URL && ODOO_DB && ODOO_USERNAME && ODOO_PASS);
console.log("✅ Odoo configured:", odooConfigured);

// ===================== LABEL STORE (in-memory) =====================
// NOTE: Render free services can restart; memory resets.
// Later: store PDFs in Odoo attachments or S3.
const labelsStore = new Map(); // labelId -> record
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
// Odoo JSON-RPC endpoint: `${ODOO_URL}/jsonrpc`
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
  if (!uid) throw new Error("Odoo login failed (uid missing). Check DB/username/api key.");
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
async function odooGetSaleOrderByRef(ref) {
  const uid = await odooLogin();

  const records = await odooExecute(
    uid,
    "sale.order",
    "search_read",
    [
      [["name", "=", ref]],
      ["id", "name", "partner_shipping_id", "partner_id", "date_order", "amount_total", "state"]
    ],
    { limit: 1 }
  );

  if (!records?.length) throw new Error(`Sale Order not found for ref: ${ref}`);

  const so = records[0];
  const shipPartnerId = so.partner_shipping_id?.[0] || so.partner_id?.[0];

  const partner = shipPartnerId
    ? await odooExecute(uid, "res.partner", "read", [[shipPartnerId], [
        "name","phone","email","street","street2","city","state_id","zip","country_id"
      ]])
    : [];

  const p = partner?.[0] || {};
  const stateName = p.state_id?.[1] || "";
  const countryName = p.country_id?.[1] || "";

  const lines = await odooExecute(
    uid,
    "sale.order.line",
    "search_read",
    [
      [["order_id", "=", so.id]],
      ["name", "product_uom_qty"]
    ],
    { limit: 50 }
  );

  return {
    id: so.id,
    ref: so.name,
    date_order: so.date_order,
    state: so.state,
    amount_total: so.amount_total,
    ship_to: {
      name: p.name || "",
      phone: p.phone || "",
      email: p.email || "",
      line1: p.street || "",
      line2: p.street2 || "",
      city: p.city || "",
      state: stateName,
      pin: p.zip || "",
      country: countryName
    },
    items: (lines || []).map(l => ({ name: l.name, qty: l.product_uom_qty }))
  };
}

// ===================== PDF LABEL GENERATION =====================
function buildLabelPdfBuffer({ saleOrder, fromAddress }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A6", margin: 18 });
      const chunks = [];
      doc.on("data", (d) => chunks.push(d));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      const so = saleOrder;
      const ship = so.ship_to || {};

      doc.fontSize(12).font("Helvetica-Bold").text("SHIPPING LABEL", { align: "center" });
      doc.moveDown(0.4);

      doc.fontSize(9).font("Helvetica").text(`Order: ${so.ref || so.id}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.moveDown(0.6);

      // FROM
      doc.fontSize(10).font("Helvetica-Bold").text("FROM");
      doc.fontSize(9).font("Helvetica");
      if (fromAddress.company) doc.text(fromAddress.company);
      if (fromAddress.name) doc.text(fromAddress.name);
      if (fromAddress.line1) doc.text(fromAddress.line1);
      if (fromAddress.line2) doc.text(fromAddress.line2);
      const fromCityLine = `${fromAddress.city || ""} ${fromAddress.state || ""} ${fromAddress.pin || ""}`.trim();
      if (fromCityLine) doc.text(fromCityLine);
      if (fromAddress.country) doc.text(fromAddress.country);
      if (fromAddress.phone) doc.text(`Phone: ${fromAddress.phone}`);
      doc.moveDown(0.6);

      // TO
      doc.fontSize(10).font("Helvetica-Bold").text("TO");
      doc.fontSize(9).font("Helvetica");
      if (ship.name) doc.text(ship.name);
      if (ship.line1) doc.text(ship.line1);
      if (ship.line2) doc.text(ship.line2);
      const toCityLine = `${ship.city || ""} ${ship.state || ""} ${ship.pin || ""}`.trim();
      if (toCityLine) doc.text(toCityLine);
      if (ship.country) doc.text(ship.country);
      if (ship.phone) doc.text(`Phone: ${ship.phone}`);
      doc.moveDown(0.8);

      // INTERNAL TRACK BLOCK
      doc.fontSize(9).font("Helvetica-Bold").text("TRACK (INTERNAL)");
      doc.fontSize(10).font("Helvetica").text(`|| ${String(so.ref || so.id).padEnd(18, " ")} ||`, {
        align: "center"
      });
      doc.moveDown(0.6);

      // ITEMS
      if (so.items?.length) {
        doc.fontSize(9).font("Helvetica-Bold").text("ITEMS");
        doc.fontSize(8).font("Helvetica");
        so.items.slice(0, 8).forEach((it) => {
          doc.text(`• ${it.name}  x${it.qty}`);
        });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function generatePdfLabelForOrder(saleOrder) {
  const fromAddress = getDefaultFromAddress();
  const pdfBuffer = await buildLabelPdfBuffer({ saleOrder, fromAddress });

  const labelId = makeLabelId();
  const label_url = `/api/labels/${encodeURIComponent(labelId)}/pdf`;

  const record = {
    id: labelId,
    sale_order_id: saleOrder.id,
    sale_order_ref: saleOrder.ref || String(saleOrder.id),
    status: "created",
    carrier: "PDF-only",
    created_at: now(),
    pdfBuffer,
    label_url,
    meta: {}
  };

  labelsStore.set(labelId, record);

  return {
    id: record.id,
    sale_order_id: record.sale_order_id,
    sale_order_ref: record.sale_order_ref,
    status: record.status,
    carrier: record.carrier,
    created_at: record.created_at,
    label_url: record.label_url
  };
}

// ===================== AI PROMPTS =====================
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

// ===================== AI CALLS =====================
async function callGemini(system, prompt, debateText) {
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

// ===================== AI STREAM ENDPOINT =====================
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
      { name: "Gemma", type: "openrouter", system: AGENT_C_SYSTEM, model: MISTRAL_MODEL }
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

      if (showDebate) {
        send({ type: "turn", agent: agent.name, content: reply, time: now() });
      }
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

// ===================== LABEL ROUTES =====================

// 1) Fetch Sale Order from Odoo by reference (for Labels tab)
app.get("/api/odoo/sale-order", async (req, res) => {
  try {
    const ref = String(req.query.ref || "").trim();
    if (!ref) return res.status(400).json({ error: "Missing ref" });

    if (!odooConfigured) {
      return res.status(400).json({
        error: "Odoo is not configured. Please set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY_OR_PASSWORD."
      });
    }

    const so = await odooGetSaleOrderByRef(ref);
    return res.json(so);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// 2) List labels (optional filter by sale_order_id)
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
      label_url: l.label_url
    }))
    .sort((a,b) => (a.created_at < b.created_at ? 1 : -1));

  res.json(all);
});

// 3) Generate a PDF-only label for a Sales Order
app.post("/api/labels/generate", async (req, res) => {
  try {
    const { sale_order_id, order } = req.body || {};
    if (!sale_order_id && !order) {
      return res.status(400).json({ error: "Provide sale_order_id (preferred) or order (testing)." });
    }

    let saleOrder = null;

    if (odooConfigured && sale_order_id) {
      // fetch name by id then normalize via ref
      const uid = await odooLogin();
      const recs = await odooExecute(uid, "sale.order", "read", [[Number(sale_order_id)], ["id","name"]]);
      if (!recs?.length) throw new Error("Sale Order not found by id");
      saleOrder = await odooGetSaleOrderByRef(recs[0].name);
    } else if (order) {
      saleOrder = order;
    } else {
      return res.status(400).json({ error: "Odoo not configured and no 'order' provided." });
    }

    const result = await generatePdfLabelForOrder(saleOrder);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4) Download label PDF
app.get("/api/labels/:id/pdf", async (req, res) => {
  const id = req.params.id;
  const record = labelsStore.get(id);
  if (!record) return res.status(404).send("Label not found (service may have restarted).");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${id}.pdf"`);
  res.send(record.pdfBuffer);
});

// 5) Odoo webhook: quotation -> confirmed SO -> auto generate label
app.post("/api/odoo/sale-confirmed", async (req, res) => {
  try {
    // Optional security
    const secret = process.env.ODOO_WEBHOOK_SECRET;
    if (secret) {
      const got = req.headers["x-odoo-secret"];
      if (got !== secret) return res.status(401).json({ error: "Unauthorized" });
    }

    const { sale_order_id, sale_order_ref } = req.body || {};
    if (!sale_order_id && !sale_order_ref) {
      return res.status(400).json({ error: "Provide sale_order_id or sale_order_ref" });
    }
    if (!odooConfigured) {
      return res.status(400).json({ error: "Odoo not configured on server env." });
    }

    let saleOrder;
    if (sale_order_id) {
      const uid = await odooLogin();
      const recs = await odooExecute(uid, "sale.order", "read", [[Number(sale_order_id)], ["id","name"]]);
      if (!recs?.length) throw new Error("Sale Order not found by id");
      saleOrder = await odooGetSaleOrderByRef(recs[0].name);
    } else {
      saleOrder = await odooGetSaleOrderByRef(String(sale_order_ref));
    }

    const result = await generatePdfLabelForOrder(saleOrder);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Health
app.get("/health", (req, res) => res.json({ ok: true, time: now(), odooConfigured }));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
