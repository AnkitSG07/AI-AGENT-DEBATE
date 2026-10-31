/* Keep the legacy browser handoff disabled. A verified native room may expose
 * its own transfer control; it never uses the three legacy Render routes below.
 * Only this main-frame Hub page and the exact displayed call are in scope.
 */
(() => {
  "use strict";
  if (window.top !== window || location.origin !== "https://www.smarthandicrafts.com" ||
      !/^\/livechat-api-test\/?$/.test(location.pathname)) return;
  if (window.__shCallTransferGuardR9) return;
  const originalFetch = window.fetch;
  if (typeof originalFetch !== "function") return;
  const backendOrigin = "https://ai-agent-debate.onrender.com";
  const reason = "Call transfer is not set up on this calling connection. Your current call will stay on this device.";
  const code = "TRANSFER_MEDIA_NOT_CONFIGURED";
  const uiActions = '[data-whatsapp-call-action="transfer"],[data-whatsapp-call-action="send-transfer"],#shWhatsappCallTransferBtn';
  const marker = Object.freeze({ version: "2026.10.29-ui-r9", transferAvailable: false });
  window.__shCallTransferGuardR9 = marker;
  let observedButton = null, observedCurrent = null;
  const uiObserver = typeof MutationObserver === "function" ? new MutationObserver(() => installUi()) : null;

  function nativeTransferAvailable() {
    const cap = window.SHNativeCapabilities;
    const valid = value => typeof value === "string" && /^[A-Za-z0-9_:.@+=/-]{1,240}$/.test(value);
    if (cap?.nativeRoomCalls !== true || cap.protocol !== "sh-room-audio-v1" || cap.activeCall !== true ||
        cap.canTransfer !== true || !valid(cap.activeCallId) || typeof window.SHNative?.postMessage !== "function") return false;
    const button = document.getElementById("shWhatsappCallTransferBtn");
    const attempt = button?.getAttribute("data-native-attempt-id") || "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attempt) || attempt !== cap.activeAttemptId) return false;
    const explicit = button?.getAttribute("data-provider-call-id");
    const rendered = button?.getAttribute("data-call-key") || "";
    const key = explicit !== null && explicit !== undefined ? explicit : rendered.startsWith("event:") ? "" : rendered.startsWith("session:") ? rendered.slice(8) :
      rendered || document.getElementById("shWhatsappCallCurrent")?.getAttribute("data-call-id") || "";
    return key === cap.activeCallId || (valid(cap.activeProviderCallId) && key === cap.activeProviderCallId);
  }

  function attribute(node, name, value) {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function installUi() {
    const root = document.getElementById("shOperatorApp");
    if (!root) return;
    const button = document.getElementById("shWhatsappCallTransferBtn");
    const current = document.getElementById("shWhatsappCallCurrent");
    const nativeReady = nativeTransferAvailable();
    if (uiObserver && (button !== observedButton || current !== observedCurrent)) {
      uiObserver.disconnect(); observedButton = button; observedCurrent = current;
      if (button) uiObserver.observe(button, { attributes: true, attributeFilter: ["disabled", "class", "data-call-key", "data-provider-call-id", "data-native-attempt-id", "data-owner-leg-id"], childList: true });
      if (current) uiObserver.observe(current, { attributes: true, attributeFilter: ["data-call-id"] });
    }
    if (button) {
      if (button.disabled === nativeReady) button.disabled = !nativeReady;
      attribute(button, "aria-disabled", String(!nativeReady));
      if (nativeReady) {
        button.removeAttribute("aria-describedby");
        if (button.classList.contains("is-hidden")) button.classList.remove("is-hidden");
      } else attribute(button, "aria-describedby", "shNativeTransferUnavailable");
      const label = nativeReady ? "Transfer call" : "Transfer unavailable";
      if (button.textContent !== label) button.textContent = label;
    }
    // The R9 embed already includes the explanation and legacy cancel/status UI.
    const existingNote = document.getElementById("shWhatsappCallTransferUnavailable");
    if (existingNote) {
      existingNote.hidden = nativeReady;
      existingNote.classList.toggle("is-hidden", nativeReady);
      if (button && !nativeReady) attribute(button, "aria-describedby", "shWhatsappCallTransferUnavailable");
      return;
    }
    if (!document.getElementById("sh-native-transfer-guard-css")) {
      const style = document.createElement("style");
      style.id = "sh-native-transfer-guard-css";
      style.textContent = '#shOperatorApp #shWhatsappCallTransferBox{display:none!important}' +
        '#shOperatorApp #shWhatsappCallTransferBtn:disabled{opacity:.55;cursor:default}' +
        '#shOperatorApp #shNativeTransferUnavailable{order:5;flex:0 0 auto;padding:10px 16px;margin:4px 0;font-size:12px;line-height:1.45;color:inherit;opacity:.82}' +
        '#shOperatorApp #shNativeTransferUnavailable strong{display:block;font-size:12px;margin-bottom:3px}';
      (document.head || document.documentElement).appendChild(style);
    }
    const card = root.querySelector("#shWhatsappCallPanel .sh-wa-call-card");
    if (card && !document.getElementById("shNativeTransferUnavailable")) {
      const note = document.createElement("div");
      note.id = "shNativeTransferUnavailable";
      note.setAttribute("role", "note");
      const heading = document.createElement("strong");
      heading.textContent = "Call transfer unavailable";
      const detail = document.createElement("span");
      detail.textContent = reason;
      note.append(heading, detail);
      card.appendChild(note);
    }
    const note = document.getElementById("shNativeTransferUnavailable");
    if (note) { note.hidden = nativeReady; note.classList.toggle("is-hidden", nativeReady); }
  }

  function block() {
    installUi();
    return new Response(JSON.stringify({ ok: false, code, error: reason }), {
      status: 501, statusText: "Not Implemented", headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }

  function nonEmpty(value) { return value !== undefined && value !== null && String(value).trim() !== ""; }
  function hasTransfer(value) {
    return !!value && typeof value === "object" && !Array.isArray(value) &&
      (nonEmpty(value.transfer_id) || nonEmpty(value.transferId));
  }
  function formHasTransfer(form) {
    return ["transfer_id", "transferId"].some(key => form.getAll(key).some(nonEmpty));
  }
  function textIsOrdinaryAccept(text, type) {
    if (typeof text !== "string" || text.length > 262144) return false;
    try {
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && !hasTransfer(parsed);
    } catch {
      if (type.startsWith("application/x-www-form-urlencoded")) return !formHasTransfer(new URLSearchParams(text));
      // An unknown/malformed body at this call-control route cannot be proven to
      // be an ordinary accept. Fail closed only for this exact endpoint.
      return false;
    }
  }

  async function ordinaryAcceptBody(input, init) {
    try {
      const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
      const body = init?.body != null ? init.body : null;
      const headers = new Headers(init?.headers !== undefined ? init.headers : request?.headers);
      const type = String(headers.get("content-type") || "").toLowerCase();
      if (body !== null) {
        if (typeof body === "string") return textIsOrdinaryAccept(body, type);
        if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return !formHasTransfer(body);
        if (typeof FormData !== "undefined" && body instanceof FormData) return !formHasTransfer(body);
        if (typeof Blob !== "undefined" && body instanceof Blob) return body.size <= 262144 && textIsOrdinaryAccept(await body.text(), type || body.type);
        if (typeof ArrayBuffer !== "undefined" && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
          if (body.byteLength > 262144) return false;
          const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
          return textIsOrdinaryAccept(new TextDecoder("utf-8", { fatal: true }).decode(bytes), type);
        }
        // Do not consume or replay unknown streams. The normal Hub uses JSON.
        return false;
      }
      if (request?.body) {
        const copy = request.clone();
        if (type.startsWith("multipart/form-data")) return !formHasTransfer(await copy.formData());
        return textIsOrdinaryAccept(await copy.text(), type);
      }
      // Empty requests cannot contain a transfer ID; let the provider route
      // perform its ordinary method/body validation.
      return true;
    } catch { return false; }
  }

  window.fetch = function shR9TransferFetch(input, init) {
    let url;
    try {
      const request = typeof Request !== "undefined" && input instanceof Request;
      url = new URL(request ? input.url : String(input), location.href);
    } catch { return originalFetch.call(this, input, init); }
    if (url.origin !== backendOrigin) return originalFetch.call(this, input, init);
    const route = url.pathname.replace(/\/+$/, "");
    if (route === "/api/operator-call-transfer/request" || route === "/api/operator-call-transfer/accept") {
      return Promise.resolve(block());
    }
    if (route !== "/api/whatsapp-calls/accept") return originalFetch.call(this, input, init);
    if (formHasTransfer(url.searchParams)) return Promise.resolve(block());
    const context = this;
    return ordinaryAcceptBody(input, init).then(ordinary => ordinary ? originalFetch.call(context, input, init) : block());
  };

  // Capture the legacy launch/choose actions before R8's delegated handler.
  // The fetch guard also blocks direct function calls and queued invitations.
  document.addEventListener("click", event => {
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    const control = target?.closest?.(uiActions);
    if (control?.closest?.("#shOperatorApp")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      installUi();
      return;
    }
    if (target?.closest?.("#shOperatorApp")) installUi();
  }, true);
  installUi();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installUi, { once: true });
  window.addEventListener("pageshow", installUi);
  window.addEventListener("sh-native-capabilities", installUi);
})();
