import express from "express";

const publicPort = Number(process.env.PORT || 3000);
const internalPort = Number(process.env.INTERNAL_SERVER_PORT || publicPort + 1);

// Run the existing app on an internal port. The wrapper exposes the public port
// and adds outbound WhatsApp call support without changing the large server.js file.
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

async function waitForIceComplete(pc, timeoutMs = 2500) {
  if (!pc || pc.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    };
  });
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

// Proxy every other request to the original server running on the internal port.
app.use(async (req, res) => {
  try {
    const target = `http://127.0.0.1:${internalPort}${req.originalUrl || req.url}`;
    const headers = { ...req.headers, host: `127.0.0.1:${internalPort}` };
    delete headers["content-length"];
    const method = req.method || "GET";
    const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
    const chunks = [];
    if (hasBody) {
      for await (const chunk of req) chunks.push(chunk);
    }
    const upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
      redirect: "manual"
    });
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!["content-encoding", "transfer-encoding", "connection"].includes(key.toLowerCase())) res.setHeader(key, value);
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    res.status(502).json({ ok: false, error: error?.message || String(error), proxy: true });
  }
});

app.listen(publicPort, () => {
  console.log(`Outgoing wrapper listening on ${publicPort}; original server on ${internalPort}`);
});
