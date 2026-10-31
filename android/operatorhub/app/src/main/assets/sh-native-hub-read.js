(function () {
  "use strict";
  if (window.top !== window || location.origin !== "https://www.smarthandicrafts.com" ||
      location.pathname.replace(/\/+$/, "") !== "/livechat-api-test" ||
      typeof window.SHNative?.postMessage !== "function" || window.__shNativeHistoryR12) return;
  window.__shNativeHistoryR12 = true;
  const backend = "https://ai-agent-debate.onrender.com";
  const prefix = "/api/whatsapp-calls/";
  const denied = new Set(["events", "diagnostics", "test", "accept", "reject", "terminate", "outgoing", "note", "cancel-pending-outgoing"]);
  const originalFetch = window.fetch.bind(window), pending = new Map();
  function requestId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const s = Array.from(bytes, v => v.toString(16).padStart(2, "0")).join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
  function eligible(url, method) {
    if (method !== "GET" || url.origin !== backend || !url.pathname.startsWith(prefix) || url.hash) return false;
    const tail = url.pathname.slice(prefix.length);
    return !!tail && !tail.includes("/") && !denied.has(tail);
  }
  function read(path, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException("Request aborted", "AbortError"));
    if (pending.size >= 6) return Promise.reject(new Error("Call history is busy. Retry shortly."));
    return new Promise((resolve, reject) => {
      const id = requestId();
      const abort = () => finish(new DOMException("Request aborted", "AbortError"));
      const finish = (error, response) => {
        if (!pending.has(id)) return;
        pending.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(response);
      };
      const timer = setTimeout(() => finish(new Error("Call history request timed out.")), 20000);
      pending.set(id, finish); signal?.addEventListener("abort", abort, { once: true });
      try { window.SHNative.postMessage(JSON.stringify({ type: "hub-call-read", requestId: id, path })); }
      catch (error) { finish(error); }
    });
  }
  window.addEventListener("sh-native-call-read", event => {
    const data = event.detail, finish = pending.get(data?.requestId);
    if (!finish || !Number.isInteger(data.status) || data.status < 200 || data.status > 599 ||
        !data.body || typeof data.body !== "object" || Array.isArray(data.body)) return;
    try {
      const body = JSON.stringify(data.body);
      if (body.length > 524288) throw new Error("Call history response was too large.");
      finish(null, new Response(body, { status: data.status, headers: {
        "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"
      } }));
    } catch (error) { finish(error); }
  });
  window.addEventListener("pagehide", () => {
    for (const finish of Array.from(pending.values())) finish(new DOMException("Page closed", "AbortError"));
  });
  window.fetch = function (input, options = {}) {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href); }
    catch { return originalFetch(input, options); }
    const method = String(options.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!eligible(url, method)) return originalFetch(input, options);
    return read(url.pathname + url.search, options.signal || (input instanceof Request ? input.signal : undefined));
  };
  Object.defineProperty(window, "SHNativeHistory", { value: Object.freeze({ protocol: "sh-call-history-v1" }), configurable: false });
})();
